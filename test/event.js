const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#event', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
  });

  testTypes().forEach(([description, serverType, clientType, metricEnd]) => {
    describe(description, () => {
      it('should send proper event format for title and text', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.event('test', 'description');
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{4,11}:test|description${metricEnd}`);
          done();
        });
      });

      it('should reuse the title when when text is missing', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.event('test');
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{4,4}:test|test${metricEnd}`);
          done();
        });
      });

      it('should send proper event format for title with global prefix and suffix', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            prefix: 'prefix.',
            suffix: '.suffix',
          }), clientType);
          statsd.event('event.title');
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{25,11}:prefix.event.title.suffix|event.title${metricEnd}`);
          done();
        });
      });

      it('should send proper event format for title, text, and options', done => {
        const date = new Date();
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const options = {
            date_happened: date,
            hostname: 'host',
            aggregation_key: 'ag_key',
            priority: 'low',
            source_type_name: 'source_type',
            alert_type: 'warning'
          };
          statsd.event('test title', 'another\nmultiline\ndescription', options);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{10,31}:test title|another\\nmultiline\\ndescription|d:${Math.round(date.getTime() / 1000)}|h:host|k:ag_key|p:low|s:source_type|t:warning${metricEnd}`
          );
          done();
        });
      });

      it('should send proper event format for title, text, and options for primitive dates', done => {
        const date = Math.round(Date.now() / 1000);
        const dateAsDate = new Date(date);
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const options = {
            date_happened: date,
            hostname: 'host',
            aggregation_key: 'ag_key',
            priority: 'low',
            source_type_name: 'source_type',
            alert_type: 'warning'
          };
          statsd.event('test title', 'another\nmultiline\ndescription', options);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{10,31}:test title|another\\nmultiline\\ndescription|d:${dateAsDate.getTime()}|h:host|k:ag_key|p:low|s:source_type|t:warning${metricEnd}`
          );
          done();
        });
      });

      it('should send proper event format for title, text, some options, and tags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const options = {
            hostname: 'host'
          };
          statsd.event('test title', 'another desc', options, ['foo', 'bar']);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{10,12}:test title|another desc|h:host|#foo,bar${metricEnd}`);
          done();
        });
      });

      it('should send proper event format for title, text, tags, and a callback', done => {
        let called = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.event('test title', 'another desc', null, ['foo', 'bar'], () => {
            called = true;
          });
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_e{10,12}:test title|another desc|#foo,bar${metricEnd}`);
          assert.strictEqual(called, true);
          done();
        });
      });

      it('should send no event stat when a mock Client is used', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            prefix: 'prefix',
            suffix: 'suffix',
            mock: true,
          }), clientType);

          // Regression test for "undefined is not a function" with missing
          // callback on mock instance
          statsd.event('test', 1);

          statsd.event('test', 1, null, () => {
            done();
          });
        });
        server.on('metrics', () => {
          assert.ok(false, 'No metrics should be seen');
        });
      });

      it('should use errorHandler', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
            errorHandler() {
              done();
            }
          }), clientType);
          statsd.event('test title', 'another desc');
        });
      });
    });
  });
});
