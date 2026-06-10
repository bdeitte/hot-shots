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
});
