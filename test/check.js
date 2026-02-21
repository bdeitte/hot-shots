const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#check', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType, metricEnd]) => {
    describe(description, () => {
      it('should send proper check format for name and status', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.check('check.name', statsd.CHECKS.OK);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_sc|check.name|0${metricEnd}`);
          done();
        });
      });

      it('should send proper check format for name and status with global prefix and suffix', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            prefix: 'prefix.',
            suffix: '.suffix',
          }), clientType);
          statsd.check('check.name', statsd.CHECKS.OK);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_sc|prefix.check.name.suffix|0${metricEnd}`);
          done();
        });
      });

      it('should send proper check format for name, status, and options', done => {
        const date = new Date();
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const options = {
            date_happened: date,
            hostname: 'host',
            message: 'message'
          };
          statsd.check('check.name', statsd.CHECKS.WARNING, options);
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_sc|check.name|1|d:${Math.round(date.getTime() / 1000)}|h:host|m:message${metricEnd}`
          );
          done();
        });
      });

      it('should send proper check format for title, text, some options, and tags', done => {
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

      it('should send proper check format for title, text, tags, and a callback', done => {
        let called = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.check('check.name', statsd.CHECKS.OK, null, ['foo', 'bar'], () => {
            called = true;
          });
        });
        server.on('metrics', event => {
          assert.strictEqual(event, `_sc|check.name|0|#foo,bar${metricEnd}`);
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
          statsd.check('test', 1);

          statsd.check('test', 1, null, () => {
            done();
          });
        });
        server.on('metrics', () => {
          assert.ok(false, 'No metrics should be seen');
        });
      });

      it('should throw an exception when using telegraf format', done => {
        // if we don't null out the server first, and try to close it again, we get an uncatchable error when using uds
        server = null;

        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
          }), clientType);

          assert.throws(() => {
            statsd.check('check.name', statsd.CHECKS.OK, null, ['foo', 'bar']);
          }, {
            name: 'Error',
            message: 'Not supported by Telegraf / InfluxDB'
          });
          done();
        });
      });

      it('should use errorHandler', done => {
        let calledDone = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            telegraf: true,
            errorHandler() {
              if (! calledDone) {
                calledDone = true;
                done();
              }
            }
          }), clientType);
          statsd.check('check.name', statsd.CHECKS.OK);
        });
      });

      it('should send all CHECKS status values correctly', done => {
        const expectedStatuses = [0, 1, 2, 3]; // OK, WARNING, CRITICAL, UNKNOWN
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.check('test.ok', statsd.CHECKS.OK);
          statsd.check('test.warning', statsd.CHECKS.WARNING);
          statsd.check('test.critical', statsd.CHECKS.CRITICAL);
          statsd.check('test.unknown', statsd.CHECKS.UNKNOWN);
        });
        const onMetrics = event => {
          // TCP may concatenate messages, so check all status matches in the event
          const statusMatches = event.match(/_sc\|[^|]+\|(\d)/g);
          if (statusMatches) {
            statusMatches.forEach(match => {
              const status = parseInt(match.charAt(match.length - 1), 10);
              const index = expectedStatuses.indexOf(status);
              if (index >= 0) {
                expectedStatuses.splice(index, 1);
              }
            });
          }
          if (expectedStatuses.length === 0) {
            server.removeListener('metrics', onMetrics);
            done();
          }
        };
        server.on('metrics', onMetrics);
      });
    });
  });
});
