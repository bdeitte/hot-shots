const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#intervalErrorHandling', () => {
  let server;
  let statsd;
  let consoleErrorStub;

  afterEach(done => {
    if (consoleErrorStub) {
      consoleErrorStub.restore();
      consoleErrorStub = null;
    }
    // allowErrors=true: tests intentionally cause flush throws, so teardown may surface them.
    closeAll(server, statsd, true, done);
    server = null;
    statsd = null;
  });

  it('should not crash the process when buffer flush throws and routes to errorHandler', done => {
    const received = [];
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 1000,
        bufferFlushInterval: 5,
        errorHandler: err => received.push(err),
      }), 'client');

      statsd.increment('a');

      // Force the flush path to throw by replacing flushQueue
      const originalFlush = statsd.flushQueue.bind(statsd);
      let threw = false;
      statsd.flushQueue = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from flushQueue');
        }
        return originalFlush(callback);
      };

      // If the throw is unhandled, mocha's uncaughtException listener will fail the run.
      // Wait long enough for two interval ticks then succeed.
      setTimeout(() => {
        assert.strictEqual(threw, true, 'flushQueue should have thrown at least once');
        assert.ok(received.length >= 1, 'errorHandler should have been called at least once');
        assert.strictEqual(received[0].message, 'boom from flushQueue');
        done();
      }, 30);
    });
  });

  it('should not crash the process when telemetry flush throws and routes to errorHandler', done => {
    const received = [];
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 5,
        errorHandler: err => received.push(err),
      }), 'client');

      let threw = false;
      const originalFlush = statsd.telemetry.flush.bind(statsd.telemetry);
      statsd.telemetry.flush = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from telemetry flush');
        }
        return originalFlush(callback);
      };

      statsd.increment('a');

      setTimeout(() => {
        assert.strictEqual(threw, true, 'telemetry.flush should have thrown at least once');
        assert.ok(received.length >= 1, 'errorHandler should have been called at least once');
        assert.strictEqual(received[0].message, 'boom from telemetry flush');
        done();
      }, 30);
    });
  });

  it('should invoke close callback when final telemetry flush throws', done => {
    const received = [];
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 60000,
        errorHandler: err => received.push(err),
      }), 'client');

      // Force only the close-time flush to throw (the periodic interval is 60s away).
      statsd.telemetry.flush = function () {
        throw new Error('boom from final telemetry flush');
      };

      statsd.close(() => {
        // The synchronous throw inside close() must not skip this callback.
        assert.ok(received.length >= 1, 'errorHandler should have been called');
        assert.strictEqual(received[0].message, 'boom from final telemetry flush');
        server.close();
        // null out so afterEach's closeAll doesn't re-close
        server = null;
        statsd = null;
        done();
      });
    });
  });

  it('falls back to console.error when buffer flush throws and no errorHandler is set', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 1000,
        bufferFlushInterval: 5,
      }), 'client');

      statsd.increment('a');

      const originalFlush = statsd.flushQueue.bind(statsd);
      let threw = false;
      statsd.flushQueue = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from flushQueue');
        }
        return originalFlush(callback);
      };

      setTimeout(() => {
        assert.strictEqual(threw, true, 'flushQueue should have thrown');
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('buffer flush interval threw');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called for the bare flush throw');
        assert.ok(calls[0].args[0].includes('boom from flushQueue'),
          `console.error should include original error message, got: ${calls[0].args[0]}`);
        done();
      }, 30);
    });
  });

  it('falls back to console.error preserving original error when errorHandler itself throws', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 1000,
        bufferFlushInterval: 5,
        errorHandler: () => { throw new Error('handler exploded'); },
      }), 'client');

      statsd.increment('a');

      const originalFlush = statsd.flushQueue.bind(statsd);
      let threw = false;
      statsd.flushQueue = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from flushQueue');
        }
        return originalFlush(callback);
      };

      setTimeout(() => {
        assert.strictEqual(threw, true, 'flushQueue should have thrown');
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('errorHandler threw inside buffer flush interval');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called when handler throws');
        const msg = calls[0].args[0];
        assert.ok(msg.includes('boom from flushQueue'),
          `console.error must preserve original flush error, got: ${msg}`);
        assert.ok(msg.includes('handler exploded'),
          `console.error must include handler error, got: ${msg}`);
        done();
      }, 30);
    });
  });

  it('telemetry interval falls back to console.error when no errorHandler is set', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 5,
      }), 'client');

      let threw = false;
      const originalFlush = statsd.telemetry.flush.bind(statsd.telemetry);
      statsd.telemetry.flush = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from telemetry flush');
        }
        return originalFlush(callback);
      };

      statsd.increment('a');

      setTimeout(() => {
        assert.strictEqual(threw, true, 'telemetry.flush should have thrown');
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('telemetry: flush interval threw');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called for telemetry flush');
        assert.ok(calls[0].args[0].includes('boom from telemetry flush'),
          `console.error should include original error, got: ${calls[0].args[0]}`);
        done();
      }, 30);
    });
  });

  it('telemetry interval falls back to console.error preserving original when errorHandler throws', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 5,
        errorHandler: () => { throw new Error('telemetry handler exploded'); },
      }), 'client');

      let threw = false;
      const originalFlush = statsd.telemetry.flush.bind(statsd.telemetry);
      statsd.telemetry.flush = function (callback) {
        if (!threw) {
          threw = true;
          throw new Error('boom from telemetry flush');
        }
        return originalFlush(callback);
      };

      statsd.increment('a');

      setTimeout(() => {
        assert.strictEqual(threw, true, 'telemetry.flush should have thrown');
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('telemetry: errorHandler threw inside flush interval');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called when handler throws');
        const msg = calls[0].args[0];
        assert.ok(msg.includes('boom from telemetry flush'),
          `console.error must preserve original telemetry error, got: ${msg}`);
        assert.ok(msg.includes('telemetry handler exploded'),
          `console.error must include handler error, got: ${msg}`);
        done();
      }, 30);
    });
  });

  it('close-time telemetry flush falls back to console.error when no errorHandler is set', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 60000,
      }), 'client');

      // Force only the close-time flush to throw (the periodic interval is 60s away).
      statsd.telemetry.flush = function () {
        throw new Error('boom from final telemetry flush');
      };

      statsd.close(() => {
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('final telemetry flush threw');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called for final telemetry flush');
        assert.ok(calls[0].args[0].includes('boom from final telemetry flush'),
          `console.error should include original error, got: ${calls[0].args[0]}`);
        server.close();
        server = null;
        statsd = null;
        done();
      });
    });
  });

  it('close-time telemetry flush falls back to console.error preserving original when errorHandler throws', done => {
    server = createServer('udp', opts => {
      consoleErrorStub = sinon.stub(console, 'error');

      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 60000,
        errorHandler: () => { throw new Error('close handler exploded'); },
      }), 'client');

      statsd.telemetry.flush = function () {
        throw new Error('boom from final telemetry flush');
      };

      statsd.close(() => {
        const calls = consoleErrorStub.getCalls().filter(c => {
          return typeof c.args[0] === 'string' && c.args[0].includes('errorHandler threw inside final telemetry flush');
        });
        assert.ok(calls.length >= 1, 'console.error should have been called when close-time handler throws');
        const msg = calls[0].args[0];
        assert.ok(msg.includes('boom from final telemetry flush'),
          `console.error must preserve original final-flush error, got: ${msg}`);
        assert.ok(msg.includes('close handler exploded'),
          `console.error must include handler error, got: ${msg}`);
        server.close();
        server = null;
        statsd = null;
        done();
      });
    });
  });
});
