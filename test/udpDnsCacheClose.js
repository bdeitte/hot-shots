const assert = require('assert');
const constants = require('../lib/constants');
const dns = require('dns');
const helpers = require('./helpers/helpers.js');

const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheClose', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  let server;

  afterEach(done => {
    dns.lookup = originalDnsLookup;
    if (server) {
      server.close(() => done());
      server = null;
      return;
    }
    done();
  });

  it('does not force-close or corrupt the counter when a lookup is stuck', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      const logged = [];
      const originalConsoleError = console.error;
      console.error = msg => logged.push(String(msg));

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      let sendErrored = false;
      statsd.send('stuck', {}, error => {
        assert.ok(error, 'the queued send should be failed during close');
        sendErrored = true;
      });

      statsd.close(() => {
        console.error = originalConsoleError;
        assert.ok(sendErrored, 'close must fail the queued send');
        assert.strictEqual(statsd.messagesInFlight, 0,
          `messagesInFlight must not go negative, saw ${statsd.messagesInFlight}`);
        const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
        assert.strictEqual(forced.length, 0, 'cancelling pending sends should avoid the force-close path');
        done();
      });
    });
  });

  it('completes close in buffered mode when the final flush lookup is stuck', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      const errors = [];
      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        maxBufferSize: 1024,
        bufferFlushInterval: 100000,
        errorHandler: err => errors.push(err)
      }), 'client');

      // Buffered, so nothing is sent until close()'s final flushQueue.
      statsd.increment('buffered.metric');
      assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

      statsd.close(closeError => {
        assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
        assert.strictEqual(statsd.messagesInFlight, 0,
          `messagesInFlight must not go negative, saw ${statsd.messagesInFlight}`);
        assert.strictEqual(errors.length, 1, 'the dropped final flush should be reported');
        assert.strictEqual(errors[0].code, constants.DNS_CANCELLED_CODE);
        done();
      });
    });
  });

  it('delivers the buffered final flush when the lookup resolves in time', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(null, '127.0.0.1');
      };

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        maxBufferSize: 1024,
        bufferFlushInterval: 100000
      }), 'client');

      let received = null;
      server.on('metrics', metrics => {
        received = metrics;
      });

      statsd.increment('buffered.metric');
      setTimeout(() => release(), 10);

      statsd.close(closeError => {
        assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
        setTimeout(() => {
          assert.ok(received && received.includes('buffered.metric'),
            `buffered metric should still be delivered, saw ${received}`);
          done();
        }, 20);
      });
    });
  });

  it('still delivers a queued send when the lookup resolves before the timeout', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(null, '127.0.0.1');
      };

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      let sendError = 'not called';
      statsd.send('inflight', {}, error => {
        sendError = error;
      });

      // Resolve shortly after close() begins, well inside the drain budget.
      setTimeout(() => release(), 10);

      statsd.close(() => {
        assert.strictEqual(sendError, null, 'a send that resolves in time must not be cancelled');
        done();
      });
    });
  });

  it('does not go negative or force-close when a resending errorHandler races the cancel pass (regression, Critical 1)', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      const logged = [];
      const originalConsoleError = console.error;
      console.error = msg => logged.push(String(msg));

      // A bounded stand-in for the documented "emit a metric on send failure"
      // errorHandler pattern: an errorHandler that resends unconditionally,
      // forever, on every single failure (including failures caused by its
      // own resend) cannot be driven to completion by any library-side fix -
      // it is a caller-side retry storm, not a defect this task can cure.
      // This caps the resends the same way test/udpDnsCacheDrops.js's
      // existing resendBudget tests do, while still exercising exactly the
      // reported shape: no per-send callbacks anywhere, only errorHandler,
      // against a lookup that never resolves.
      const resendBudget = 20;
      const state = { errorHandlerCalls: 0 };

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        errorHandler: () => {
          state.errorHandlerCalls++;
          if (state.errorHandlerCalls <= resendBudget) {
            statsd.increment('send.failure');
          }
        }
      }), 'client');

      statsd.increment('a');
      statsd.increment('b');
      statsd.increment('c');

      statsd.close(() => {
        // Let any still-settling deferred rejections land before asserting.
        setImmediate(() => {
          console.error = originalConsoleError;
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must not go negative or stay stuck, saw ${statsd.messagesInFlight}`);
          const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
          assert.strictEqual(forced.length, 0,
            'a resending errorHandler must not spuriously trip the force-close path');
          assert.ok(state.errorHandlerCalls > 3,
            'the resend chain should have run beyond the 3 original sends');
          done();
        });
      });
    });
  });

  it('calls every entry back exactly once across a close with a resending callback (regression, Critical 2)', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const seen = {};
      const initialIds = ['entry0', 'entry1', 'entry2'];
      const maxGeneration = 2;
      // Every entry's callback resends exactly once more, through two bounded
      // generations of retry (generation 0 -> 1 -> 2, which does not resend
      // again). A single-pass cancellation with no latch only ever gets two
      // chances to flush `pending` (cancelPendingSends' one pass, then
      // transport.close()'s one pass) - enough to catch generation 1, but
      // generation 2 (created by generation 1's callback, during
      // transport.close()'s flush) has no third flush to catch it and is
      // orphaned forever. The latch fix must instead reject generation 2
      // immediately (no more `pending` involved at all), so nothing is ever
      // missing - and nothing is ever double-invoked either.
      const track = (id, generation) => error => {
        seen[id] = (seen[id] || 0) + 1;
        if (error && generation < maxGeneration) {
          const nextId = `${id}-gen${generation + 1}`;
          statsd.send(`retry.${nextId}`, {}, track(nextId, generation + 1));
        }
      };

      initialIds.forEach(id => {
        statsd.send(`test.${id}`, {}, track(id, 0));
      });

      statsd.close(() => {
        // Let the deferred later-generation rejections land before asserting.
        setImmediate(() => {
          const expectedIds = initialIds.
            concat(initialIds.map(id => `${id}-gen1`)).
            concat(initialIds.map(id => `${id}-gen1-gen2`));
          const missing = expectedIds.filter(id => !seen[id]);
          const duplicates = Object.keys(seen).filter(id => seen[id] > 1);
          assert.deepStrictEqual(missing, [], `entries never called back: ${missing}`);
          assert.deepStrictEqual(duplicates, [], `entries called back more than once: ${duplicates}`);
          done();
        });
      });
    });
  });

  it('ignores a DNS lookup that resolves after cancellation but before deferred rejections run (regression, late-resolve latch bypass)', done => {
    server = createServer(udpServerType, opts => {
      // Release-style stub: we control exactly when the lookup completes,
      // instead of it never resolving at all.
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(null, '127.0.0.1');
      };

      const logged = [];
      const originalConsoleError = console.error;
      console.error = msg => logged.push(String(msg));

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const seen = {};
      const initialIds = ['entry0', 'entry1', 'entry2'];
      // Each initial entry's cancellation callback resolves the still-in-flight
      // lookup (once, on the first callback to run) and then resends once,
      // under a distinct id. This is the exact race the finding describes:
      // the cancellation callback only runs from cancelPendingSends' flush,
      // which sets the `cancelled` latch before invoking any callback, so the
      // lookup resolves strictly AFTER cancellation - but strictly BEFORE any
      // deferred (setImmediate) rejection for the resend has had a chance to
      // run. If the late address were allowed to set resolvedAddress and
      // matter (the bug), the resend would take the warm sendToSocket branch
      // instead of being rejected.
      let released = false;
      const track = id => error => {
        seen[id] = (seen[id] || 0) + 1;
        if (!released) {
          released = true;
          release();
        }
        if (error && !id.endsWith('-retry')) {
          statsd.send(`retry.${id}`, {}, track(`${id}-retry`));
        }
      };

      initialIds.forEach(id => {
        statsd.send(`test.${id}`, {}, track(id));
      });

      statsd.close(() => {
        // Let any still-settling deferred rejections land before asserting.
        setImmediate(() => {
          console.error = originalConsoleError;
          const expectedIds = initialIds.concat(initialIds.map(id => `${id}-retry`));
          const missing = expectedIds.filter(id => !seen[id]);
          const duplicates = Object.keys(seen).filter(id => seen[id] > 1);
          assert.deepStrictEqual(missing, [], `entries never called back: ${missing}`);
          assert.deepStrictEqual(duplicates, [], `entries called back more than once: ${duplicates}`);
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must settle to 0, saw ${statsd.messagesInFlight}`);
          const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
          assert.strictEqual(forced.length, 0,
            'a lookup resolving after cancellation must not trip the force-close path');
          done();
        });
      });
    });
  });
});
