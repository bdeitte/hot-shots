const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#timestamp', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
  });

  testTypes().forEach(([description, serverType, clientType, metricsEnd]) => {
    describe(description, () => {
      describe('with options object', () => {
        it('should send gauge with timestamp as Unix seconds', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.gauge('test', 42, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send gauge with timestamp as Date object', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            // Date.UTC(2022, 5, 30, 10, 30, 0) = 1656585000000 ms = 1656585000 seconds
            statsd.gauge('test', 42, { timestamp: new Date(1656585000000) });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|T1656585000${metricsEnd}`);
            done();
          });
        });

        it('should send increment with timestamp', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test', 1, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:1|c|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send timing with timestamp', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.timing('test', 100, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:100|ms|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send histogram with timestamp', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.histogram('test', 100, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:100|h|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send distribution with timestamp', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.distribution('test', 100, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:100|d|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send set with timestamp', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.set('test', 'unique', { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:unique|s|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send with timestamp and sampleRate', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.gauge('test', 42, { sampleRate: 0.5, timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|@0.5|T1656581400${metricsEnd}`);
            done();
          });
        });

        it('should send with timestamp and tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.gauge('test', 42, { tags: ['foo:bar'], timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|T1656581400|#foo:bar${metricsEnd}`);
            done();
          });
        });

        it('should send with timestamp, sampleRate, and tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.gauge('test', 42, { sampleRate: 0.5, tags: ['foo:bar'], timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|@0.5|T1656581400|#foo:bar${metricsEnd}`);
            done();
          });
        });

        it('should send with callback', done => {
          let callbackCalled = false;
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.gauge('test', 42, { timestamp: 1656581400 }, () => {
              callbackCalled = true;
            });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|g|T1656581400${metricsEnd}`);
            assert.strictEqual(callbackCalled, true);
            done();
          });
        });

        it('should work with array of stats', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              maxBufferSize: 1000,
              bufferFlushInterval: 5
            }), clientType);
            statsd.gauge(['a', 'b'], 42, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `a:42|g|T1656581400\nb:42|g|T1656581400${metricsEnd}`);
            done();
          });
        });
      });

      describe('telegraf mode', () => {
        it('should ignore timestamp when using telegraf format', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              telegraf: true,
            }), clientType);
            statsd.gauge('test', 42, { timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            // Telegraf format should not include timestamp
            assert.strictEqual(metrics, `test:42|g${metricsEnd}`);
            done();
          });
        });

        it('should ignore timestamp but include tags when using telegraf format', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              telegraf: true,
            }), clientType);
            statsd.gauge('test', 42, { tags: { foo: 'bar' }, timestamp: 1656581400 });
          });
          server.on('metrics', metrics => {
            // Telegraf format puts tags differently
            assert.strictEqual(metrics, `test,foo=bar:42|g${metricsEnd}`);
            done();
          });
        });
      });

      describe('mock mode', () => {
        it('should record timestamp in mock buffer', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              mock: true
            }), clientType);
            statsd.gauge('test', 42, { timestamp: 1656581400 }, () => {
              assert.deepStrictEqual(statsd.mockBuffer, ['test:42|g|T1656581400']);
              done();
            });
          });
        });
      });
    });
  });
});
