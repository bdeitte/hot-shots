const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#transportDefaultErrorListener', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, true, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType]) => {
    describe(description, () => {
      it('attaches a default error listener so emitting error does not crash', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);

          // No user errorHandler installed. Emit an error on the underlying socket.
          // If no listener is attached, Node will throw 'Unhandled error' synchronously.
          assert.doesNotThrow(() => {
            statsd.socket.emit('error', new Error('synthetic'));
          });

          done();
        });
      });
    });
  });

  it('returns stream listener counts (error AND close) to baseline after close(callback)', done => {
    server = createServer('stream', opts => {
      const callerStream = opts.stream;
      const baselineErrorCount = callerStream.listenerCount('error');
      const baselineCloseCount = callerStream.listenerCount('close');

      statsd = createHotShotsClient(opts, 'client');

      // While the client is alive, exactly one of OUR listeners is attached.
      assert.strictEqual(callerStream.listenerCount('error'), baselineErrorCount + 1,
        'stream transport should add exactly one error listener while alive');

      const wrapped = statsd;
      statsd = null; // prevent afterEach from re-closing
      wrapped.close(() => {
        const errorAfter = callerStream.listenerCount('error');
        const closeAfter = callerStream.listenerCount('close');
        assert.strictEqual(errorAfter, baselineErrorCount,
          'error listener count should return to baseline after close; ' +
          `baseline=${baselineErrorCount}, after=${errorAfter}`);
        assert.strictEqual(closeAfter, baselineCloseCount,
          'close listener count should return to baseline after close; ' +
          `baseline=${baselineCloseCount}, after=${closeAfter}`);
        server.close();
        server = null;
        done();
      });
    });
  });

  it('returns stream listener counts to baseline after close() with no callback', done => {
    server = createServer('stream', opts => {
      const callerStream = opts.stream;
      const baselineErrorCount = callerStream.listenerCount('error');
      const baselineCloseCount = callerStream.listenerCount('close');

      statsd = createHotShotsClient(opts, 'client');

      const wrapped = statsd;
      statsd = null;

      // No callback — the cleanup path must still run (motivation for unconditional
      // on('close') in _close). Wait one tick for stream.destroy() to emit 'close'.
      wrapped.close();
      setTimeout(() => {
        const errorAfter = callerStream.listenerCount('error');
        const closeAfter = callerStream.listenerCount('close');
        assert.strictEqual(errorAfter, baselineErrorCount,
          'error listeners must clean up even without a callback; ' +
          `baseline=${baselineErrorCount}, after=${errorAfter}`);
        assert.strictEqual(closeAfter, baselineCloseCount,
          'close listeners must clean up even without a callback; ' +
          `baseline=${baselineCloseCount}, after=${closeAfter}`);
        server.close();
        server = null;
        done();
      }, 50);
    });
  });

  it('cleans up _close listeners even when socket.close() throws synchronously', done => {
    server = createServer('stream', opts => {
      const callerStream = opts.stream;
      const baselineErrorCount = callerStream.listenerCount('error');
      const baselineCloseCount = callerStream.listenerCount('close');

      statsd = createHotShotsClient(opts, 'client');

      // Force the underlying stream.destroy() to throw. The transport's close() runs
      // first (and removes its own default listener), then the throw propagates up
      // through transport.close() into Client._close's try/catch — exercising the
      // catch-path cleanup of handleErr and onClose.
      callerStream.destroy = () => { throw new Error('synthetic destroy failure'); };

      const wrapped = statsd;
      statsd = null;
      wrapped.close((err) => {
        assert.ok(err, 'close callback should receive the synthetic error');
        const errorAfter = callerStream.listenerCount('error');
        const closeAfter = callerStream.listenerCount('close');
        assert.strictEqual(errorAfter, baselineErrorCount,
          'error listeners must clean up on synchronous close failure; ' +
          `baseline=${baselineErrorCount}, after=${errorAfter}`);
        assert.strictEqual(closeAfter, baselineCloseCount,
          'close listeners must clean up on synchronous close failure; ' +
          `baseline=${baselineCloseCount}, after=${closeAfter}`);
        server.close();
        server = null;
        done();
      });
    });
  });
});
