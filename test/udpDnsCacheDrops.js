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
      const state = { maxPending: 0, reentrantSent: 0, finished: false };

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
      //
      // The cap entries left in the queue forever (dns.lookup never resolves)
      // share this same callback, and close() now cancels them in afterEach
      // (see task 4: Client.close() drains sends still queued behind a stuck
      // lookup instead of orphaning them) - so this fires again after done()
      // has already run. Guard so the extra cancellation callbacks are a
      // no-op instead of a double done() call.
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
        if (state.finished) {
          return;
        }
        state.finished = true;
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
      const state = { maxPending: 0, reentrantSent: 0, finished: false };

      const recordMax = () => {
        const len = statsd.socket.getDnsPendingCount();
        if (len > state.maxPending) {
          state.maxPending = len;
        }
      };

      // See the equivalent guard in the test above: the cap entries left in
      // the queue forever share this callback, and close() (afterEach) now
      // cancels them instead of orphaning them, so this can fire again after
      // done() has already run.
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
        if (state.finished) {
          return;
        }
        state.finished = true;
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

  it('never lets messagesInFlight go negative when an overflow batch races finish()\'s force-zero (regression, Important 3)', done => {
    server = createServer(udpServerType, opts => {
      // Never resolves: every send stays queued (or overflows and drops)
      // rather than being delivered, so the flood below keeps racing the
      // DNS_MAX_PENDING cap for the whole close/drain window.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
        // Default closingFlushInterval (50ms) -> ~550ms drain budget, matching
        // the reported repro's default-config case (cfi=50, final=-100).
      }), 'client');

      const cap = constants.DNS_MAX_PENDING;
      let sending = true;
      let created = 0;
      let seenNegative = false;

      const checkNegative = () => {
        if (statsd.messagesInFlight < 0) {
          seenNegative = true;
        }
      };

      const floodOnce = () => {
        if (!sending) {
          return;
        }
        created++;
        statsd.send(`flood.${created}`, {}, checkNegative);
        checkNegative();
      };

      // Prime the queue past the cap so overflow drops start immediately...
      for (let i = 0; i < cap + 1; i++) {
        floodOnce();
      }
      // ...then keep sending continuously (one per event-loop turn, not a
      // tight synchronous loop) so a fresh overflow batch - with its
      // callbacks deferred via setImmediate - is reliably still scheduled
      // when close()'s drain timeout elapses and finish() force-zeroes
      // messagesInFlight below.
      const pump = () => {
        if (!sending) {
          return;
        }
        floodOnce();
        setImmediate(pump);
      };
      pump();

      statsd.close(() => {
        sending = false;
        // Let any overflow-drop callbacks still scheduled from before close()
        // finished land before asserting on the final settled state.
        setTimeout(() => {
          assert.strictEqual(seenNegative, false,
            'messagesInFlight must never be observed negative');
          assert.ok(statsd.messagesInFlight >= 0,
            `messagesInFlight must settle to >= 0, saw ${statsd.messagesInFlight}`);
          assert.ok(created > cap,
            'the flood should have produced more sends than the queue cap to actually exercise overflow');
          // Already closed above; let afterEach's closeAll skip re-closing.
          statsd = null;
          done();
        }, 100);
      });
    });
  }).timeout(9000);
});
