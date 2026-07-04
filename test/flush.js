const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;
const testTypes = helpers.testTypes;

describe('#flush', () => {
  let server;
  let statsd;
  let clock;

  afterEach(done => {
    if (clock) {
      clock.restore();
      clock = null;
    }
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType, metricsEnd]) => {
    describe(description, () => {
      it('should flush buffered metrics immediately', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 8192,
            bufferFlushInterval: 60000,
          }), clientType);
          statsd.increment('buffered.metric');
          statsd.flush();
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `buffered.metric:1|c${metricsEnd}`);
          done();
        });
      });

      it('should invoke the callback after flushing', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 8192,
            bufferFlushInterval: 60000,
          }), clientType);
          statsd.increment('buffered.metric');
          statsd.flush(err => {
            assert.ok(!err);
            done();
          });
        });
      });
    });
  });

  it('should invoke the callback with nothing to flush', done => {
    statsd = createHotShotsClient({ mock: true }, 'client');
    statsd.flush(() => {
      done();
    });
  });

  it('should wait for an in-flight unbuffered send before invoking the callback', done => {
    server = createServer('udp', opts => {
      clock = sinon.useFakeTimers();
      statsd = createHotShotsClient(Object.assign(opts, { maxBufferSize: 0 }), 'client');
      // Defer the send completion callback so the send is genuinely in flight when
      // flush() is called. The flush callback must not fire until it completes.
      let sendDrained = false;
      statsd.socket.send = (buf, cb) => {
        setTimeout(() => {
          sendDrained = true;
          cb();
        }, 30);
      };
      statsd.increment('drain.metric');
      statsd.flush(() => {
        assert.ok(sendDrained, 'flush callback fired before the unbuffered send drained');
        done();
      });
      clock.tickAsync(30);
    });
  });

  it('should wait for an aggregated send routed through a child before invoking the callback', done => {
    server = createServer('udp', opts => {
      clock = sinon.useFakeTimers();
      statsd = createHotShotsClient(Object.assign(opts, { maxBufferSize: 0, aggregation: true }), 'client');
      const child = statsd.childClient({ globalTags: ['child:tag'] });
      // Child shares the parent's socket; stub it to defer the routed send so we can
      // assert flush() waits for the child's in-flight send to drain.
      let sendDrained = false;
      statsd.socket.send = (buf, cb) => {
        setTimeout(() => {
          sendDrained = true;
          cb();
        }, 30);
      };
      child.increment('drain.child');
      statsd.flush(() => {
        assert.ok(sendDrained, 'flush callback fired before the child-routed send drained');
        done();
      });
      clock.tickAsync(30);
    });
  });

  it('should wait for an interval-routed child send when flush(callback) is called', done => {
    server = createServer('udp', opts => {
      clock = sinon.useFakeTimers();
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 0,
        aggregation: { flushInterval: 60000 },
      }), 'client');
      const child = statsd.childClient({ globalTags: ['child:tag'] });
      // Defer the routed send so it is still in flight after the interval flush.
      let sendDrained = false;
      statsd.socket.send = (buf, cb) => {
        setTimeout(() => {
          sendDrained = true;
          cb();
        }, 30);
      };
      child.increment('drain.intervalchild');
      // Simulate the aggregation interval firing: it routes the child's send and
      // empties the contexts, so the later flush(cb) sees nothing of its own to do.
      statsd.aggregator.flush();
      statsd.flush(() => {
        assert.ok(sendDrained, 'flush callback fired before the interval-routed child send drained');
        done();
      });
      clock.tickAsync(30);
    });
  });

  it('should invoke the flush callback even when the aggregator flush throws', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected aggregator-throw warning */ };
    statsd.aggregator.flush = () => { throw new Error('boom'); };
    statsd.flush(err => {
      console.error = originalConsoleError;
      // A synchronous aggregator throw must not escape flush() or orphan the callback.
      assert.ok(!err);
      done();
    });
  });

  it('should not orphan a concurrent flush callback when close force-closes', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 0,
        closingFlushInterval: 5,
      }), 'client');
      const originalConsoleError = console.error;
      console.error = () => { /* suppress the expected "messages in flight" warning */ };
      // Never invoke the send callback: the send stays in flight, so close() must
      // hit its force-close path.
      statsd.socket.send = () => { /* leave the send permanently in flight */ };
      statsd.increment('stuck.metric');
      let flushCalledBack = false;
      statsd.flush(() => {
        flushCalledBack = true;
      });
      statsd.close(() => {
        console.error = originalConsoleError;
        assert.ok(flushCalledBack, 'concurrent flush callback was orphaned by force-close');
        statsd = null;
        done();
      });
    });
  });
});
