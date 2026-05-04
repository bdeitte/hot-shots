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
      // on('close') in _close). Wait long enough for: (a) the provisional drain check
      // (one closingFlushInterval tick, default 50ms), (b) stream.destroy() to emit
      // 'close', (c) onClose to remove the listeners.
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
      }, 200);
    });
  });

  it('cleans up _close listeners and restores the default error listener when destroy throws synchronously', done => {
    server = createServer('stream', opts => {
      const callerStream = opts.stream;
      const baselineErrorCount = callerStream.listenerCount('error');
      const baselineCloseCount = callerStream.listenerCount('close');

      statsd = createHotShotsClient(opts, 'client');

      // Force the underlying stream.destroy() to throw. The transport's close() runs
      // first (removes default listener, then destroy() throws → catch re-attaches it),
      // then the throw propagates up to Client._close's try/catch which cleans up
      // handleErr and onClose.
      callerStream.destroy = () => { throw new Error('synthetic destroy failure'); };

      const wrapped = statsd;
      statsd = null;
      wrapped.close((err) => {
        assert.ok(err, 'close callback should receive the synthetic error');
        // After: handleErr + onClose are gone, but the transport's default listener
        // was re-attached so the surviving stream still has crash protection.
        const errorAfter = callerStream.listenerCount('error');
        const closeAfter = callerStream.listenerCount('close');
        assert.strictEqual(errorAfter, baselineErrorCount + 1,
          'default error listener must be re-attached when destroy throws; ' +
          `baseline=${baselineErrorCount}, after=${errorAfter}`);
        assert.strictEqual(closeAfter, baselineCloseCount,
          'close listeners must clean up on synchronous close failure; ' +
          `baseline=${baselineCloseCount}, after=${closeAfter}`);
        // Verify the surviving stream actually does NOT crash on a future error emit.
        assert.doesNotThrow(() => {
          callerStream.emit('error', new Error('post-close emit'));
        }, 'surviving stream must not crash on later error emits');
        server.close();
        server = null;
        done();
      });
    });
  });

  it('restores user errorHandler on the surviving stream when destroy throws synchronously', done => {
    server = createServer('stream', opts => {
      const callerStream = opts.stream;
      const received = [];
      const userHandler = err => received.push(err);

      statsd = createHotShotsClient(Object.assign(opts, {
        errorHandler: userHandler,
      }), 'client');

      callerStream.destroy = () => { throw new Error('synthetic destroy failure'); };

      const wrapped = statsd;
      statsd = null;
      wrapped.close(() => {
        // Note: the close-time error goes only to the close callback (callback takes
        // precedence over errorHandler in handleErr). What we want to verify here is
        // that the user's errorHandler was re-attached to the surviving stream — so
        // emitting a NEW error after close completes must reach it.
        const beforeEmit = received.length;
        callerStream.emit('error', new Error('post-close stream error'));
        assert.strictEqual(received.length, beforeEmit + 1,
          'post-close emit should land in user errorHandler exactly once');
        assert.strictEqual(received[received.length - 1].message, 'post-close stream error',
          'restored user errorHandler must receive post-close stream errors');
        server.close();
        server = null;
        done();
      });
    });
  });
});
