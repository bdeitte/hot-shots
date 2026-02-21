const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const StatsD = require('../lib/statsd');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#send', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType]) => {
    describe(description, () => {
      it('should use errorHandler', done => {
        server = createServer(serverType, opts => {
          const err = new Error('Boom!');
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler(e) {
              assert.strictEqual(e, err);
              done();
            }
          }), clientType);
          statsd.dnsError = err;
          statsd.send('test title');
        });
      });

      it('should record buffers when mocked', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            mock: true
          }), clientType);
          statsd.send('test', {}, () => {
            assert.deepEqual(statsd.mockBuffer, ['test']);
            done();
          });
        });
      });

      it('should invoke callback with null on success in mock mode', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            mock: true
          }), clientType);
          statsd._send('test message', (err, bytes) => {
            assert.strictEqual(err, null);
            assert.strictEqual(bytes, 0);
            done();
          });
        });
      });

      it('should call errorHandler when dnsError is set and no callback', done => {
        server = createServer(serverType, opts => {
          const err = new Error('DNS failed');
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler(e) {
              assert.strictEqual(e, err);
              done();
            }
          }), clientType);
          statsd.dnsError = err;
          statsd._send('test message');
        });
      });

      it('should call callback with dnsError when set', done => {
        server = createServer(serverType, opts => {
          const err = new Error('DNS failed');
          statsd = createHotShotsClient(opts, clientType);
          statsd.dnsError = err;
          statsd._send('test message', (e) => {
            assert.strictEqual(e, err);
            done();
          });
        });
      });

      it('should merge tags from send with globalTags', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: ['env:prod'],
            mock: true,
          }), clientType);
          statsd.send('metric:1|c', ['region:us'], () => {
            const msg = statsd.mockBuffer[0];
            assert.ok(msg.includes('env:prod'));
            assert.ok(msg.includes('region:us'));
            done();
          });
        });
      });

      it('should send immediately when maxBufferSize is 0', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 0,
          }), clientType);
          statsd.increment('test.metric', 1);
        });
        server.on('metrics', metrics => {
          assert.ok(metrics.includes('test.metric:1|c'));
          done();
        });
      });

      it('should buffer when maxBufferSize is set', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 500,
          }), clientType);
          statsd.increment('a', 1);
          statsd.increment('b', 2);
        });
        server.on('metrics', metrics => {
          // Both should arrive in one batch
          assert.ok(metrics.includes('a:1|c'));
          assert.ok(metrics.includes('b:2|c'));
          done();
        });
      });

      it('should handle send with tags override of globalTags with same key', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            globalTags: ['env:prod', 'service:api'],
            mock: true,
          }), clientType);
          statsd.send('metric:1|c', ['env:dev'], () => {
            const msg = statsd.mockBuffer[0];
            assert.ok(msg.includes('env:dev'));
            assert.ok(!msg.includes('env:prod'));
            assert.ok(msg.includes('service:api'));
            done();
          });
        });
      });
    });
  });

  // Tests that don't need to be parameterized across all types
  describe('mock mode specifics', () => {
    it('should accumulate multiple messages in mockBuffer', () => {
      server = null;
      statsd = new StatsD({ mock: true });
      statsd.increment('a', 1);
      statsd.increment('b', 2);
      statsd.gauge('c', 42);
      assert.strictEqual(statsd.mockBuffer.length, 3);
      assert.ok(statsd.mockBuffer[0].includes('a:1|c'));
      assert.ok(statsd.mockBuffer[1].includes('b:2|c'));
      assert.ok(statsd.mockBuffer[2].includes('c:42|g'));
    });

    it('should not send to socket when in mock mode', () => {
      server = null;
      statsd = new StatsD({ mock: true });
      statsd.increment('test', 1);
      // Mock mode should record in buffer, not actually send
      assert.strictEqual(statsd.mockBuffer.length, 1);
    });
  });

  describe('sendMessage edge cases', () => {
    it('should skip sending empty messages', done => {
      server = null;
      statsd = new StatsD({ mock: true });
      statsd.sendMessage('', (err) => {
        assert.strictEqual(err, undefined);
        done();
      });
    });

    it('should track messagesInFlight', done => {
      server = createServer('udp', opts => {
        statsd = new StatsD(opts);
        assert.strictEqual(statsd.messagesInFlight, 0);
        statsd.sendMessage('test:1|c', () => {
          // After callback, messagesInFlight should be decremented
          assert.strictEqual(statsd.messagesInFlight, 0);
          done();
        });
      });
    });
  });
});
