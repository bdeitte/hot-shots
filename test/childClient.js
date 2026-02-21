const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const StatsD = require('../lib/statsd');

const closeAll = helpers.closeAll;
const testProtocolTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#childClient', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testProtocolTypes().forEach(([description, serverType, clientType, metricsEnd]) => {

    describe(description, () => {
      it('init should set the proper values when specified', () => {
        // if we don't null out the server first, and try to close it again, we get an uncatchable error when using uds
        server = null;

        statsd = new StatsD(
          'host', 1234, 'prefix', 'suffix', true, null, true, ['gtag', 'tag1:234234']
        );

        const child = statsd.childClient({
          prefix: 'preff.',
          suffix: '.suff',
          globalTags: ['awesomeness:over9000', 'tag1:xxx', 'bar', ':baz']
        });

        assert.strictEqual(child.prefix, 'preff.prefix.');
        assert.strictEqual(child.suffix, '.suffix.suff');
        assert.strictEqual(statsd, global.statsd);
        // Note: ':baz' is sanitized to '_baz' because tags starting with colon are malformed
        assert.deepEqual(child.globalTags, ['gtag', 'awesomeness:over9000', 'tag1:xxx', 'bar', '_baz']);
      });
    });

    it('childClient should add tags, prefix and suffix without parent values', done => {
      server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 500,
          }), clientType).childClient({
            prefix: 'preff.',
            suffix: '.suff',
            globalTags: ['awesomeness:over9000']
          });
          statsd.increment('a', 1);
          statsd.increment('b', 2);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, `preff.a.suff:1|c|#awesomeness:over9000\npreff.b.suff:2|c|#awesomeness:over9000${metricsEnd}`);
        done();
      });
    });

    it('should add tags, prefix and suffix with parent values', done => {
      server = createServer(serverType, opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          prefix: 'p.',
          suffix: '.s',
          globalTags: ['xyz'],
          maxBufferSize: 500,
        }), clientType).childClient({
          prefix: 'preff.',
          suffix: '.suff',
          globalTags: ['awesomeness:over9000']
        });
        statsd.increment('a', 1);
        statsd.increment('b', 2);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'preff.p.a.s.suff:1|c|#xyz,awesomeness:' +
          `over9000\npreff.p.b.s.suff:2|c|#xyz,awesomeness:over9000${metricsEnd}`
        );
        done();
      });
    });

    it('should share the parent socket', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(opts, clientType);
        statsd = parent;
        const child = parent.childClient({ prefix: 'child.' });
        assert.strictEqual(child.socket, parent.socket);
        done();
      });
    });

    it('should share the parent bufferHolder', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 500,
        }), clientType);
        statsd = parent;
        const child = parent.childClient({ prefix: 'child.' });
        assert.strictEqual(child.bufferHolder, parent.bufferHolder);
        done();
      });
    });

    it('should support nested child clients (3 levels deep)', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          prefix: 'l1.',
          globalTags: ['level:1'],
        }), clientType);
        statsd = parent;
        const child = parent.childClient({
          prefix: 'l2.',
          globalTags: ['level:2'],
        });
        const grandchild = child.childClient({
          prefix: 'l3.',
          globalTags: ['level:3'],
        });
        grandchild.increment('metric', 1);
      });
      server.on('metrics', metrics => {
        // Prefix should be l3.l2.l1.metric
        assert.ok(metrics.includes('l3.l2.l1.metric:1|c'));
        // Tag should override: level:3 should win over level:2 and level:1
        assert.ok(metrics.includes('level:3'));
        assert.ok(!metrics.includes('level:1'));
        assert.ok(!metrics.includes('level:2'));
        done();
      });
    });

    it('should support nested child clients with suffixes', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          suffix: '.s1',
        }), clientType);
        statsd = parent;
        const child = parent.childClient({ suffix: '.s2' });
        const grandchild = child.childClient({ suffix: '.s3' });
        grandchild.increment('metric', 1);
      });
      server.on('metrics', metrics => {
        // Suffix should be .s1.s2.s3
        assert.ok(metrics.includes('metric.s1.s2.s3:1|c'));
        done();
      });
    });

    it('should override duplicate tag keys from parent', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          globalTags: ['env:prod', 'service:api', 'version:1'],
        }), clientType);
        statsd = parent;
        const child = parent.childClient({
          globalTags: ['env:staging', 'version:2'],
        });
        child.increment('metric', 1);
      });
      server.on('metrics', metrics => {
        // env and version should be overridden by child
        assert.ok(metrics.includes('env:staging'));
        assert.ok(metrics.includes('version:2'));
        assert.ok(metrics.includes('service:api'));
        assert.ok(!metrics.includes('env:prod'));
        assert.ok(!metrics.includes('version:1'));
        done();
      });
    });

    it('should support globalTags as object format', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          globalTags: { env: 'prod', service: 'api' },
        }), clientType);
        statsd = parent;
        const child = parent.childClient({
          globalTags: { env: 'staging', region: 'us-east' },
        });
        child.increment('metric', 1);
      });
      server.on('metrics', metrics => {
        assert.ok(metrics.includes('env:staging'));
        assert.ok(metrics.includes('service:api'));
        assert.ok(metrics.includes('region:us-east'));
        assert.ok(!metrics.includes('env:prod'));
        done();
      });
    });

    it('should create child with no options and inherit parent config', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          prefix: 'parent.',
          globalTags: ['from:parent'],
        }), clientType);
        statsd = parent;
        const child = parent.childClient();
        child.increment('metric', 1);
      });
      server.on('metrics', metrics => {
        assert.ok(metrics.includes('parent.metric:1|c'));
        assert.ok(metrics.includes('from:parent'));
        done();
      });
    });

    it('should inherit mock mode from parent', () => {
      server = null;

      statsd = new StatsD({ mock: true });
      const child = statsd.childClient({ prefix: 'child.' });

      assert.strictEqual(child.mock, true);
      child.increment('metric', 1);
      assert.ok(child.mockBuffer.length > 0);
      assert.ok(child.mockBuffer[0].includes('child.metric:1|c'));
    });

    it('should inherit telegraf mode from parent', () => {
      server = null;

      statsd = new StatsD({ mock: true, telegraf: true });
      const child = statsd.childClient({ prefix: 'child.' });

      assert.strictEqual(child.telegraf, true);
    });

    it('should allow child to override errorHandler', done => {
      server = createServer(serverType, opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          errorHandler() {
            // parent handler - should not be called
            assert.fail('parent errorHandler should not be called');
          }
        }), clientType);
        statsd = parent;
        const err = new Error('test error');
        const child = parent.childClient({
          errorHandler(e) {
            assert.strictEqual(e, err);
            done();
          }
        });
        child.dnsError = err;
        child.send('test');
      });
    });
  });
});
