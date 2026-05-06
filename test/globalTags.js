const assert = require('assert');
const StatsD = require('../lib/statsd');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#globalTags', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    delete process.env.DD_ENTITY_ID;
    delete process.env.DD_ENV;
    delete process.env.DD_SERVICE;
    delete process.env.DD_VERSION;
  });

  testTypes().forEach(([description, serverType, clientType, metricEnd]) => {
    describe(description, () => {
      it('should not add global tags if they are not specified', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.increment('test');
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1|c${metricEnd}`);
          done();
        });
      });

      it('should add global tags if they are specified', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            global_tags: ['gtag'],
          }), clientType);
          statsd.increment('test');
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1|c|#gtag${metricEnd}`);
          done();
        });
      });

      it('should add global tags from DD_ prefixed env vars', done => {
        // set DD_ prefixed env vars
        process.env.DD_ENTITY_ID = '04652bb7-19b7-11e9-9cc6-42010a9c016d';
        process.env.DD_ENV = 'test';
        process.env.DD_SERVICE = 'test-service';
        process.env.DD_VERSION = '1.0.0';

        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            global_tags: ['gtag'],
          }), clientType);
          statsd.increment('test');
        });
        server.on('metrics', metrics => {
          assert.strictEqual(
            metrics,
            `test:1|c|#gtag,dd.internal.entity_id:04652bb7-19b7-11e9-9cc6-42010a9c016d,env:test,service:test-service,version:1.0.0${metricEnd}`
          );
          done();
        });
      });

      it('should not add global tags from DD_ prefixed env vars if opted out', done => {
        // set DD_ prefixed env vars
        process.env.DD_ENTITY_ID = '04652bb7-19b7-11e9-9cc6-42010a9c016d';
        process.env.DD_ENV = 'test';
        process.env.DD_SERVICE = 'test-service';
        process.env.DD_VERSION = '1.0.0';

        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            global_tags: ['gtag-dd-optout'],
            includeDataDogTags: false,
          }), clientType);
          statsd.increment('test-gtag-dd-optout');
        });
        server.on('metrics', metrics => {
          assert.strictEqual(
            metrics,
            `test-gtag-dd-optout:1|c|#gtag-dd-optout${metricEnd}`
          );
          done();
        });
      });

      it('should combine global tags and metric tags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            global_tags: ['gtag:1', 'gtag:2', 'bar'],
          }), clientType);
          statsd.increment('test', 1337, ['foo']);
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|#gtag:1,gtag:2,bar,foo${metricEnd}`);
          done();
        });
      });

      it('should override global tags with metric tags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            global_tags: ['foo', 'gtag:1', 'gtag:2'],
          }), clientType);
          statsd.increment('test', 1337, ['gtag:234', 'bar']);
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|#foo,gtag:234,bar${metricEnd}`);
          done();
        });
      });

      it('should format global tags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { gtag: '123', foo: 'bar' },
          }), clientType);
          statsd.increment('test', 1337, { gtag: '234' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|#foo:bar,gtag:234${metricEnd}`);
          done();
        });
      });

      it('should format tags using prefix', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { gtag: '123', foo: 'bar' },
            tagPrefix: '~',
          }), clientType);
          statsd.increment('test', 1337, { gtag: '234' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|~foo:bar,gtag:234${metricEnd}`);
          done();
        });
      });

      it('should format tags using separator', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { gtag: '123', foo: 'bar' },
            tagSeparator: '~',
          }), clientType);
          statsd.increment('test', 1337, { gtag: '234' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|#foo:bar~gtag:234${metricEnd}`);
          done();
        });
      });

      it('should format tags using prefix & separator', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { gtag: '123', foo: 'bar' },
            tagPrefix: '~',
            tagSeparator: '~',
          }), clientType);
          statsd.increment('test', 1337, { gtag: '234' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|~foo:bar~gtag:234${metricEnd}`);
          done();
        });
      });

      it('should replace reserved characters with underscores in tags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { foo: 'b,a,r' },
          }), clientType);
          statsd.increment('test', 1337, { 'reserved:character': 'is@replaced@' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1337|c|#foo:b_a_r,reserved_character:is_replaced_${metricEnd}`);
          done();
        });
      });

      it('should add global tags using telegraf format when enabled', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: ['gtag:gvalue', 'gtag:gvalue2', 'gtag2:gvalue2'],
            telegraf: true,
          }), clientType);
          statsd.increment('test');
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,gtag=gvalue,gtag=gvalue2,gtag2=gvalue2:1|c${metricEnd}`);
          done();
        });
      });

      it('should combine global tags and metric tags using telegraf format when enabled', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: ['gtag=gvalue'],
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1337, ['foo:bar']);
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,gtag=gvalue,foo=bar:1337|c${metricEnd}`);
          done();
        });
      });

      it('should format global key-value tags using telegraf format when enabled', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { gtag: 'gvalue' },
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1337, { foo: 'bar' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,gtag=gvalue,foo=bar:1337|c${metricEnd}`);
          done();
        });
      });

      it('handles a no-colon message in telegraf mode (preserves trailing colon for byte-identical output)', () => {
        // Tests Client.prototype.send directly for the no-colon edge case. Internal
        // metric construction always includes a colon (`name:value|type`), but `send`
        // is on the documented prototype and external callers may pass a message
        // without one. Pre-fix `split(':')` produced `${msg},${tags}:` (trailing
        // colon); the post-fix `indexOf` path must produce the same output.
        // Assign to outer-scope `statsd` so afterEach's closeAll handles teardown.
        server = null;
        statsd = new StatsD({ telegraf: true, mock: true });
        statsd.send('nocolon', ['env:prod']);
        assert.strictEqual(statsd.mockBuffer.length, 1);
        assert.strictEqual(statsd.mockBuffer[0], 'nocolon,env=prod:',
          `expected 'nocolon,env=prod:' (with trailing colon to match pre-fix split-based behavior), got: ${statsd.mockBuffer[0]}`);
      });

      it('should preserve colons in tag values using telegraf format', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1, { path: '/:sample' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,path=/:sample:1|c${metricEnd}`);
          done();
        });
      });

      it('should preserve multiple colons in tag values using telegraf format', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1, { url: 'http://example.com:8080/path' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,url=http://example.com:8080/path:1|c${metricEnd}`);
          done();
        });
      });

      it('should preserve colons in array tag values using telegraf format', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1, ['url:http://host:8080']);
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,url=http://host:8080:1|c${metricEnd}`);
          done();
        });
      });

      it('should preserve colons in global and metric tag values using telegraf format', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: { endpoint: '/api:v2' },
            telegraf: true,
          }), clientType);
          statsd.increment('test', 1, { path: '/:sample' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test,endpoint=/api:v2,path=/:sample:1|c${metricEnd}`);
          done();
        });
      });

      it('should preserve colons in tag values for DogStatsD format', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.increment('test', 1, { url: 'http://example.com:8080' });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:1|c|#url:http://example.com:8080${metricEnd}`);
          done();
        });
      });
    });
  });
});
