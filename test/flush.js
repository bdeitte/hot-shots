const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;
const testTypes = helpers.testTypes;

describe('#flush', () => {
  let server;
  let statsd;

  afterEach(done => {
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
    });
  });

  it('should wait for an aggregated send routed through a child before invoking the callback', done => {
    server = createServer('udp', opts => {
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
    });
  });
});
