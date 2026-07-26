const assert = require('assert');
const constants = require('../lib/constants');
const dns = require('dns');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheDrops', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  let server;
  let statsd;

  afterEach(done => {
    dns.lookup = originalDnsLookup;
    closeAll(server, statsd, false, done);
  });

  it('drops the oldest pending send past the cap and errors its callback', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(null, '127.0.0.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const cap = constants.DNS_MAX_PENDING;
      const state = { dropped: [], delivered: 0 };

      const onSent = i => error => {
        if (error) {
          state.dropped.push(i);
        } else {
          state.delivered++;
        }
        if (state.dropped.length + state.delivered === cap + 1) {
          assert.deepStrictEqual(state.dropped, [0], 'the oldest queued send should be dropped');
          assert.strictEqual(state.delivered, cap);
          done();
        }
      };

      // One more than the cap, so exactly one send is dropped.
      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, onSent(i));
      }

      release();
    });
  });

  it('counts a dropped send in datadog telemetry', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(null, '127.0.0.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        includeDatadogTelemetry: true
      }), 'client');

      const cap = constants.DNS_MAX_PENDING;
      const state = { completed: 0 };

      const onSent = () => {
        state.completed++;
        if (state.completed === cap + 1) {
          assert.strictEqual(statsd.telemetry.packetsDroppedQueue, 1);
          assert.strictEqual(statsd.telemetry.packetsDroppedWriter, 0);
          done();
        }
      };

      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, onSent);
      }

      release();
    });
  });

  it('never lets the pending queue exceed the cap, even when a drop callback sends again', done => {
    server = createServer(udpServerType, opts => {
      // dns.lookup never calls back, so every send stays queued (or dropped)
      // instead of being delivered - this isolates the queue-length invariant
      // from delivery timing.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const cap = constants.DNS_MAX_PENDING;
      const resendBudget = 20;
      const state = { maxPending: 0, reentrantSent: 0 };

      const recordMax = () => {
        const len = statsd.socket.getDnsPendingCount();
        if (len > state.maxPending) {
          state.maxPending = len;
        }
      };

      // A drop callback that synchronously sends again, e.g. an errorHandler
      // that emits a metric on drop. On the old shift-then-callback-then-push
      // ordering, this reentrant send observes the queue one entry under the
      // cap and does not drop, so the queue creeps upward by one per send.
      // The drop callback now fires on a deferred tick (see the recursion
      // regression test below), so this chain runs to completion - and this
      // test waits for that - before asserting and calling done().
      const onDropped = error => {
        recordMax();
        if (!error) {
          return;
        }
        if (state.reentrantSent < resendBudget) {
          state.reentrantSent++;
          statsd.send(`reentrant.${state.reentrantSent}`, {}, onDropped);
          return;
        }
        // The whole chain has run; assert on what it actually exercised, not
        // just that nothing blew up. A test that passes because the queue
        // never filled, or the drop path never fired, would be vacuous.
        assert.strictEqual(state.maxPending, cap,
          'the queue should have filled to exactly the cap');
        assert.ok(state.reentrantSent > 0, 'the reentrant drop path should have run');
        done();
      };

      // One over the cap, so exactly one send is dropped, kicking off the
      // reentrant chain above.
      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, onDropped);
        recordMax();
      }
    });
  });

  it('breaks the synchronous recursion when a drop callback resends, avoiding a stack overflow (regression)', done => {
    server = createServer(udpServerType, opts => {
      // dns.lookup never calls back, so the cache never resolves and every
      // send past the cap keeps dropping and resending, exactly the
      // errorHandler-emits-a-metric shape that recurses under the bug.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const cap = constants.DNS_MAX_PENDING;
      // Deep enough that the old synchronous drop-callback ordering recurses
      // (genuine call-stack depth, not just a large loop) past Node's
      // default stack limit before this test could ever complete. Bounded so
      // the chain terminates deterministically instead of resending forever
      // against the never-resolving lookup.
      const resendBudget = 5000;
      const state = { maxPending: 0, reentrantSent: 0 };

      const recordMax = () => {
        const len = statsd.socket.getDnsPendingCount();
        if (len > state.maxPending) {
          state.maxPending = len;
        }
      };

      const onDropped = error => {
        recordMax();
        if (!error) {
          return;
        }
        if (state.reentrantSent < resendBudget) {
          state.reentrantSent++;
          statsd.send(`reentrant.${state.reentrantSent}`, {}, onDropped);
          return;
        }
        // Reaching here at all (without a RangeError further up the stack,
        // and within the test's timeout) is the regression check: the
        // deferred scheduling must have kept this from recursing.
        assert.strictEqual(state.maxPending, cap,
          'the queue should have filled to exactly the cap');
        assert.ok(state.reentrantSent > 0, 'the reentrant drop path should have run');
        done();
      };

      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, onDropped);
        recordMax();
      }
    });
  }).timeout(9000);
});
