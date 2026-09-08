const assert = require('assert');
const constants = require('../lib/constants');
const helpers = require('./helpers/helpers.js');
const net = require('net');
const { PassThrough } = require('stream');

const createHotShotsClient = helpers.createHotShotsClient;

// TEST-NET-1 (RFC 5737). Routable nowhere, so connect() stays pending and every
// write piles up inside the socket - the condition MAX_PENDING_WRITE_BYTES bounds.
const UNROUTABLE_HOST = '192.0.2.1';

describe('#transportBackpressure', () => {
  let statsd;

  afterEach(done => {
    if (statsd) {
      const client = statsd;
      statsd = null;
      client.close(() => done());
      return;
    }
    done();
  });

  describe('unbounded write buffering', () => {
    it('stops buffering past MAX_PENDING_WRITE_BYTES when a tcp connect never completes', done => {
      const realConnect = net.connect;
      let socket = null;
      net.connect = (...args) => {
        socket = realConnect(...args);
        return socket;
      };

      const state = { dropped: 0 };
      statsd = createHotShotsClient({
        protocol: 'tcp',
        host: UNROUTABLE_HOST,
        port: 8125,
        tcpGracefulErrorHandling: false,
        errorHandler: err => {
          if (err.code === constants.WRITE_QUEUE_FULL_CODE) {
            state.dropped++;
          }
        }
      }, 'client');
      net.connect = realConnect;

      // Far more than the cap, all in one tick, so nothing can drain in between.
      for (let i = 0; i < 40000; i++) {
        statsd.increment(`metric.with.a.reasonably.long.name.${i}`);
      }

      setTimeout(() => {
        assert.ok(socket.connecting, 'the connect should still be pending for this test to mean anything');
        // One write is allowed through while at or under the cap, so the socket
        // can sit at most one message past it.
        assert.ok(socket.writableLength <= constants.MAX_PENDING_WRITE_BYTES + 1024,
          `socket buffered ${socket.writableLength} bytes, expected it capped near ` +
          `${constants.MAX_PENDING_WRITE_BYTES}`);
        assert.ok(state.dropped > 0, 'refused sends should be reported');
        done();
      }, 200);
    });

    it('reports a refused write as a queue drop, not a writer error', done => {
      const stream = new PassThrough();
      // Nothing reads from the stream, so writes accumulate in it.
      statsd = createHotShotsClient({
        protocol: 'stream',
        stream: stream,
        includeDatadogTelemetry: true
      }, 'client');

      const big = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 40; i++) {
        statsd.increment(`${big}.${i}`);
      }

      statsd.increment('one.past.the.cap', 1, err => {
        assert.ok(err, 'the send past the cap should fail');
        assert.strictEqual(err.code, constants.WRITE_QUEUE_FULL_CODE);
        // Observe the routing itself, not just that the code is listed in
        // REFUSED_CODES: handleCallback picks the counter, so asserting on the
        // constants alone would still pass if it picked the writer one.
        assert.ok(statsd.telemetry.packetsDroppedQueue > 0,
          'a refused write should count as a queue drop');
        assert.strictEqual(statsd.telemetry.packetsDroppedWriter, 0,
          'a refused write should not count as a writer error');
        assert.ok(statsd.telemetry.bytesDroppedQueue > 0,
          'the refused bytes should land in the queue-drop byte counter');
        done();
      });
    });

    it('drains messagesInFlight back to zero after a burst of refused writes', done => {
      const stream = new PassThrough();
      statsd = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

      const big = 'x'.repeat(64 * 1024);
      const state = { refused: 0, sent: 200 };
      // Well past the cap, so most of these are refused rather than written. The
      // refusal path increments the counter in sendMessage and decrements it only
      // when failLater's deferred batch runs, which is where a drift would live.
      for (let i = 0; i < state.sent; i++) {
        statsd.increment(`${big}.${i}`, 1, err => {
          if (err && err.code === constants.WRITE_QUEUE_FULL_CODE) {
            state.refused++;
          }
        });
      }

      // Start reading so the writes that did fit under the cap can flush and call
      // back too. Without this the counter stays pinned at however many the stream
      // is holding, and the assertion below could not tell that from a real leak.
      stream.resume();

      setTimeout(() => {
        assert.ok(state.refused > 0, 'the burst should have been refused past the cap');
        assert.strictEqual(statsd.messagesInFlight, 0,
          `every send should have called back exactly once, but ${statsd.messagesInFlight} are still counted in flight`);
        done();
      }, 200);
    });
  });

  describe('close is bounded when a transport never completes the final flush', () => {
    it('completes a tcp close whose connect never finishes, instead of hanging forever', function (done) {
      // The guard waits CLOSE_FLUSH_TIMEOUT before giving up, so allow for it.
      this.timeout(constants.CLOSE_FLUSH_TIMEOUT + 5000);

      const state = { reported: null };
      statsd = createHotShotsClient({
        protocol: 'tcp',
        host: UNROUTABLE_HOST,
        port: 8125,
        maxBufferSize: 1024,
        bufferFlushInterval: 100000,
        tcpGracefulErrorHandling: false,
        errorHandler: err => {
          state.reported = err;
        }
      }, 'client');

      // Buffered, so it is only handed to the never-connecting socket by
      // close()'s final flushQueue - whose write callback never fires.
      statsd.increment('buffered.metric');
      assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

      const startedAt = Date.now();
      const client = statsd;
      statsd = null;
      client.close(closeError => {
        const elapsed = Date.now() - startedAt;
        assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
        assert.ok(elapsed >= constants.CLOSE_FLUSH_TIMEOUT,
          `close should wait out the flush budget, returned after ${elapsed}ms`);
        assert.ok(state.reported, 'giving up on the final flush should be reported');
        assert.strictEqual(state.reported.code, constants.CLOSE_FLUSH_TIMEOUT_CODE);
        done();
      });
    });
  });

  describe('close completes when the socket was already destroyed', () => {
    it('tcp: destroyed out of band before close()', function (done) {
      this.timeout(4000);
      const server = net.createServer(() => {}); // eslint-disable-line no-empty-function
      server.listen(0, '127.0.0.1', () => {
        const client = createHotShotsClient({
          protocol: 'tcp',
          host: '127.0.0.1',
          port: server.address().port,
          tcpGracefulErrorHandling: false,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }, 'client');

        setTimeout(() => {
          // Destroy the socket behind the client's back, then close normally.
          client.socket.close();
          server.close();

          const state = { calls: 0 };
          client.close(() => {
            state.calls++;
            // Give any real 'close' event a chance to arrive after the emulated
            // one, so a double-invocation would be caught.
            setTimeout(() => {
              assert.strictEqual(state.calls, 1,
                `close callback must fire exactly once, fired ${state.calls} times`);
              done();
            }, 100);
          });
        }, 100);
      });
    });

    it('stream: the application destroyed its own stream first', function (done) {
      this.timeout(4000);
      const stream = new PassThrough();
      const state = { calls: 0, appCloseEvents: 0 };
      // The application's own listener on the stream it owns.
      stream.on('close', () => {
        state.appCloseEvents++;
      });

      const client = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

      // The owning application destroys the stream it handed us.
      stream.destroy();

      setTimeout(() => {
        assert.strictEqual(state.appCloseEvents, 1,
          'the stream should have emitted its own close exactly once by now');

        client.close(() => {
          state.calls++;
          setTimeout(() => {
            assert.strictEqual(state.calls, 1,
              `close callback must fire exactly once, fired ${state.calls} times`);
            // The client must not synthesize a second 'close' on a stream it
            // does not own: the application's listeners would run again.
            assert.strictEqual(state.appCloseEvents, 1,
              `close() must not re-emit 'close' on the caller's stream, saw ${state.appCloseEvents} events`);
            done();
          }, 100);
        });
      }, 50);
    });
  });

  describe('synchronous failure paths do not recurse', () => {
    /**
     * Drives a client whose sends always fail with an errorHandler that resends,
     * and asserts the stack stays flat instead of growing per resend.
     * @param {Object} opts - createHotShotsClient options, minus errorHandler
     * @param {Function} breakClient - puts the client into its always-fails state
     * @param {Function} done - mocha callback
     * @returns {void}
     */
    const assertNoRecursion = (opts, breakClient, done) => {
      const originalStackLimit = Error.stackTraceLimit;
      // Raised so the depth measurement is not truncated at the default 10.
      Error.stackTraceLimit = Infinity;

      const state = { calls: 0, maxDepth: 0 };
      const client = createHotShotsClient(Object.assign({}, opts, {
        // The documented "emit a metric on send failure" pattern. Against an
        // always-fails path this has no terminating condition, so each failure
        // must land on a fresh tick.
        errorHandler: () => {
          state.calls++;
          state.maxDepth = Math.max(state.maxDepth, new Error().stack.split('\n').length);
          if (state.calls < 2000) {
            client.increment('resend');
            return;
          }
          Error.stackTraceLimit = originalStackLimit;
          assert.ok(state.maxDepth < 100,
            `failures must not stack: reached ${state.maxDepth} frames after ${state.calls} resends`);
          // close() works here even though breakClient destroyed the socket
          // directly: the transport emulates the 'close' event its already-
          // destroyed socket will not re-emit.
          statsd = null;
          client.close(() => done());
        }
      }), 'client');
      statsd = client;

      breakClient(client, () => client.increment('first'));
    };

    it('tcp: a destroyed socket', done => {
      // eslint-disable-next-line no-empty-function
      const server = net.createServer(() => {});
      server.listen(0, '127.0.0.1', () => {
        assertNoRecursion(
          { protocol: 'tcp', host: '127.0.0.1', port: server.address().port, tcpGracefulErrorHandling: false },
          (client, go) => {
            client.socket.close();
            server.close();
            go();
          },
          done);
      });
    });

    it('stream: a destroyed stream', done => {
      const stream = new PassThrough();
      assertNoRecursion(
        { protocol: 'stream', stream: stream },
        (client, go) => {
          stream.destroy();
          go();
        },
        done);
    });

    it('udp without cacheDns: a closed socket throwing synchronously', done => {
      assertNoRecursion(
        { host: '127.0.0.1', port: 8125 },
        (client, go) => {
          client.socket.close();
          go();
        },
        done);
    });
  });
});
