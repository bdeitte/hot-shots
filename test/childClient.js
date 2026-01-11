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
        assert.deepEqual(child.globalTags, ['gtag', 'awesomeness:over9000', 'tag1:xxx', 'bar', ':baz']);
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
  });
});
