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
      const onDropped = error => {
        recordMax();
        if (error && state.reentrantSent < 200) {
          state.reentrantSent++;
          statsd.send('reentrant', {}, onDropped);
        }
      };

      // Send well past the cap so any creep is unambiguous, not a one-off
      // overshoot.
      const extra = 50;
      for (let i = 0; i < cap + extra; i++) {
        statsd.send(`test.${i}`, {}, onDropped);
        recordMax();
      }

      assert.ok(state.maxPending <= cap,
        `pending queue must never exceed the cap of ${cap}; observed ${state.maxPending}`);
      done();
    });
  });
});
