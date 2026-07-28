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
      statsd = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

      const big = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 40; i++) {
        statsd.increment(`${big}.${i}`);
      }

      statsd.increment('one.past.the.cap', 1, err => {
        assert.ok(err, 'the send past the cap should fail');
        assert.strictEqual(err.code, constants.WRITE_QUEUE_FULL_CODE);
        assert.ok(constants.REFUSED_CODES.includes(constants.WRITE_QUEUE_FULL_CODE),
          'a refused write must count as a queue drop rather than a writer error');
        done();
      });
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
          // Deliberately not close()d: breakClient destroys the socket directly,
          // and _close() waits on a 'close' event an already-destroyed socket
          // does not re-emit. Nothing is left running - the socket is gone.
          statsd = null;
          done();
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
