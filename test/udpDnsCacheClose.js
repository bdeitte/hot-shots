const assert = require('assert');
const constants = require('../lib/constants');
const dgram = require('dgram');
const dns = require('dns');
const EventEmitter = require('events');
const helpers = require('./helpers/helpers.js');
const sinon = require('sinon');

const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheClose', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  const originalDgramCreateSocket = dgram.createSocket;
  let server;
  let clock;

  afterEach(done => {
    dns.lookup = originalDnsLookup;
    dgram.createSocket = originalDgramCreateSocket;
    if (clock) {
      clock.restore();
      clock = null;
    }
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

  it('completes close in buffered mode when the final flush lookup is stuck (regression, Important 2)', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever. The
      // close-time flush guard now waits DNS_CLOSE_FLUSH_TIMEOUT (5s) instead of
      // the old closingFlushInterval * 11 (~550ms) budget, so drive it with fake
      // timers rather than actually waiting 5 real seconds.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};
      clock = sinon.useFakeTimers();

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

      // Advance past DNS_CLOSE_FLUSH_TIMEOUT (5000ms) to fire the flush guard,
      // plus a little more to cover the subsequent drain-wait tick.
      clock.tick(constants.DNS_CLOSE_FLUSH_TIMEOUT + 1000);
    });
  });

  it('delivers the buffered final flush when a slow first lookup resolves within the close budget (regression, Important 2)', done => {
    server = createServer(udpServerType, opts => {
      // Resolves at ~800ms - well under the new 5s DNS_CLOSE_FLUSH_TIMEOUT budget,
      // but well past the old ~550ms drain-only budget that used to silently drop
      // this flush. Real timers here (not faked): this exercises the real send
      // path end-to-end, and 800ms real wait is short enough to stay well inside
      // mocha's 5000ms per-test timeout.
      dns.lookup = (host, callback) => {
        setTimeout(() => callback(null, '127.0.0.1'), 800);
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

      statsd.increment('slow.lookup.metric');
      assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

      statsd.close(closeError => {
        assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
        setTimeout(() => {
          assert.ok(received && received.includes('slow.lookup.metric'),
            `buffered metric should still be delivered, saw ${received}`);
          done();
        }, 50);
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

  it('does not report DNS cancellation for a closed client that never enabled cacheDns', done => {
    server = createServer(udpServerType, opts => {
      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost'
        // cacheDns intentionally left off - this is exactly the case
        // isDnsSendBlocked's `args.cacheDns` guard exists to leave untouched.
        // Without that guard, close() latching `cancelled` unconditionally
        // would make a post-close send here look DNS-cancelled even though
        // this client never queued anything behind a lookup at all.
      }), 'client');

      statsd.close(() => {
        const calls = [];
        statsd.send('after-close', {}, error => {
          calls.push(error);
        });

        // Let any deferred callback land before asserting exactly-once.
        setImmediate(() => {
          assert.strictEqual(calls.length, 1, `callback must fire exactly once, saw ${calls.length}`);
          assert.ok(calls[0], 'a send after close should still fail');
          assert.notStrictEqual(calls[0].code, constants.DNS_CANCELLED_CODE,
            'a client that never enabled cacheDns must not report DNS cancellation on close');
          assert.notStrictEqual(calls[0].code, constants.DNS_CLOSED_CODE,
            'a client that never enabled cacheDns must not report a DNS-closed-queue code either');
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must settle to 0, saw ${statsd.messagesInFlight}`);
          done();
        });
      });
    });
  });

  it('does not claim DNS was cancelled for an ordinary post-close send on a warmed cacheDns client (regression, Important 1)', done => {
    server = createServer(udpServerType, opts => {
      // Resolves successfully right away - the lookup completes long before
      // close() ever runs, so nothing is stalled or queued behind DNS at close
      // time. Only the transport's cacheDns queue gets latched closed by
      // close() itself (finish() cancels it unconditionally on every close).
      dns.lookup = (host, callback) => callback(null, '127.0.0.1');

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
        // Deliberately no errorHandler here: the post-close send below has no
        // per-call callback either, so the only way to observe the error is a
        // socket 'error' listener - which is exactly what part (c) of the fix
        // must still deliver.
      }), 'client');

      // Warm the cache with a real resolved address before closing.
      statsd.send('warmup', {}, warmupError => {
        assert.strictEqual(warmupError, null, 'the warmup send should succeed');

        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);

          const socketErrors = [];
          statsd.socket.on('error', err => socketErrors.push(err));

          // No callback and no errorHandler: the only path left to observe the
          // failure is the socket 'error' listener above.
          statsd.send('after-close', {});

          setImmediate(() => {
            assert.strictEqual(socketErrors.length, 1,
              `expected exactly one socket error, saw ${socketErrors.length}`);
            const message = socketErrors[0] && socketErrors[0].message;
            assert.ok(message && !(/DNS resolution.*cancelled/).test(message),
              `error message must not claim DNS resolution was cancelled, got: ${message}`);
            assert.ok(message && message.includes('closed'),
              `error message should describe a closed client, got: ${message}`);
            assert.strictEqual(socketErrors[0].code, constants.DNS_CLOSED_CODE,
              'a send arriving after close on a warm client should carry DNS_CLOSED_CODE, not DNS_CANCELLED_CODE');
            done();
          });
        });
      });
    });
  });

  it('uses distinct codes for a cancelled in-flight lookup versus a send arriving after close (regression, DNS_CANCELLED_CODE vs DNS_CLOSED_CODE)', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup for the first send stays in
      // flight forever, so close() must cancel it mid-lookup - the genuine
      // DNS_CANCELLED_CODE case.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      // Queued behind the never-resolving lookup - close() below will cancel
      // this one mid-flight.
      let cancelledError = null;
      statsd.send('queued-before-close', {}, err => {
        cancelledError = err;
      });

      statsd.close(() => {
        // Arrives after close() already latched the queue shut - a
        // different case from the one above, even though both fail.
        statsd.send('after-close', {}, closedError => {
          assert.ok(cancelledError, 'the queued send should fail when close() cancels its lookup');
          assert.ok(closedError, 'the post-close send should also fail');
          assert.strictEqual(cancelledError.code, constants.DNS_CANCELLED_CODE,
            `a send queued and cancelled mid-lookup should carry DNS_CANCELLED_CODE, got ${cancelledError.code}`);
          assert.strictEqual(closedError.code, constants.DNS_CLOSED_CODE,
            `a send arriving after close should carry DNS_CLOSED_CODE, got ${closedError.code}`);
          assert.notStrictEqual(cancelledError.code, closedError.code,
            'the two cases must be distinguishable by error code');
          done();
        });
      });
    });
  });

  it('completes a second close() on an already-closed cacheDns client (regression, close() must accept DNS_CLOSED_CODE too)', done => {
    server = createServer(udpServerType, opts => {
      // Resolves successfully right away, so the first close() latches the
      // queue shut without ever cancelling an in-flight lookup - the second
      // close()'s own final flush is what then gets rejected with
      // DNS_CLOSED_CODE (not DNS_CANCELLED_CODE), since the queue was already
      // closed by the first close() by the time it runs.
      dns.lookup = (host, callback) => callback(null, '127.0.0.1');

      // A real dgram socket throws ERR_SOCKET_DGRAM_NOT_RUNNING on a second
      // close() regardless of any DNS-code handling - that's pre-existing,
      // general repeat-close behavior (reproduced independently, outside this
      // suite, against an unmocked client), orthogonal to what this test
      // targets. Mock the socket with an idempotent close() - emitting
      // 'close' the way the real socket eventually does, so Client._close()'s
      // listener-based callback still fires - so the assertions below isolate
      // exactly the regression under test: whether close()'s flush-error
      // branch lets a second close reach finish() at all for a DNS_CLOSED_CODE
      // flush error, the way it already does for DNS_CANCELLED_CODE.
      const socketMock = new EventEmitter();
      socketMock.send = (buf, offset, length, port, host, callback) => callback();
      socketMock.close = () => setImmediate(() => socketMock.emit('close'));
      // eslint-disable-next-line no-empty-function
      socketMock.unref = () => {};
      dgram.createSocket = () => socketMock;

      const statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        maxBufferSize: 1024,
        bufferFlushInterval: 100000
      }), 'client');

      // Buffered mode: this just queues - the actual dns.lookup (warming the
      // cache) happens when the buffer is flushed, which the first close()
      // below triggers.
      statsd.increment('warmup');
      assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

      statsd.close(firstCloseError => {
        assert.ok(!firstCloseError, `first close should not fail, got ${firstCloseError && firstCloseError.message}`);

        // Buffer another metric between the two closes so the second
        // close()'s own final flushQueue() has something to reject.
        statsd.increment('buffered.after.first.close');
        assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

        statsd.close(secondCloseError => {
          assert.ok(!secondCloseError,
            `second close should not fail, got ${secondCloseError && secondCloseError.message}`);
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must settle to 0 after the second close, saw ${statsd.messagesInFlight}`);
          done();
        });
      });
    });
  });
});
