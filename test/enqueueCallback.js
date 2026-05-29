const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#enqueueCallback', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  it('invokes the new-message callback synchronously when buffer overflow triggers a flush', done => {
    server = createServer('udp', opts => {
      // maxBufferSize small enough that the second metric overflows
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 8,
      }), 'client');

      // First metric fits; its callback should fire synchronously.
      let firstCalled = false;
      statsd.increment('a', 1, undefined, undefined, () => { firstCalled = true; });
      assert.strictEqual(firstCalled, true, 'first callback should fire synchronously');

      // Second metric overflows; its callback must also fire synchronously (this is the bug:
      // pre-fix, the callback was routed to flushQueue and only fired after the prior buffer's
      // async UDP send completed — making firing async and tied to an unrelated send's result).
      let secondCalled = false;
      statsd.increment('bbbbbb', 1, undefined, undefined, () => { secondCalled = true; });
      assert.strictEqual(secondCalled, true, 'second callback should fire synchronously');

      done();
    });
  });

  it('routes overflow-flush errors to errorHandler via the real send path, not to the per-metric callback', done => {
    const received = [];
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 8,
        errorHandler: err => received.push(err),
      }), 'client');

      let firstCalled = false;
      statsd.increment('a', 1, undefined, undefined, () => { firstCalled = true; });
      assert.strictEqual(firstCalled, true);

      // Stub at the socket level so the real flushQueue → sendMessage → handleCallback
      // routing runs. Pre-fix, enqueue passed the per-metric callback into flushQueue, so
      // sendMessage's handleCallback would invoke it with the formatted err. Post-fix,
      // enqueue passes no callback to flushQueue, so handleCallback falls through to the
      // errorHandler branch and the per-metric callback fires synchronously with no args.
      const originalSocketSend = statsd.socket.send.bind(statsd.socket);
      let socketSendCalls = 0;
      statsd.socket.send = function (buf, cb) {
        socketSendCalls++;
        if (socketSendCalls === 1) {
          // First send is the overflow-triggered flush — fail it via the real callback path.
          process.nextTick(() => cb(new Error('synthetic socket failure')));
        } else {
          originalSocketSend(buf, cb);
        }
      };

      const callArgs = [];
      statsd.increment('bbbbbb', 1, undefined, undefined, (...args) => { callArgs.push(args); });

      // Per-metric callback must have fired exactly once, synchronously, with no args.
      assert.strictEqual(callArgs.length, 1, 'second callback should fire exactly once synchronously');
      assert.deepStrictEqual(callArgs[0], [], 'second callback fires synchronously with no args');

      // The socket failure is async (process.nextTick) — wait for sendMessage's handleCallback
      // to route it to errorHandler. Crucially, the per-metric callback must NOT be re-invoked
      // with the async send error.
      setImmediate(() => {
        try {
          assert.strictEqual(socketSendCalls, 1, 'overflow flush should have called socket.send once');
          assert.strictEqual(received.length, 1, 'errorHandler should receive the formatted send error');
          assert.ok(received[0].message.includes('synthetic socket failure'),
            `errorHandler message should include socket failure, got: ${received[0].message}`);
          assert.strictEqual(callArgs.length, 1,
            'per-metric callback must not be re-invoked async with the send error');
          assert.deepStrictEqual(callArgs[0], [], 'per-metric callback args must remain []');
        } finally {
          // Restore so closeAll's teardown flush works normally even if an assertion above failed.
          statsd.socket.send = originalSocketSend;
        }
        done();
      });
    });
  });
});
