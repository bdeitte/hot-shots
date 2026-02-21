const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#buffer', () => {
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
      it('should aggregate packets when maxBufferSize is set to non-zero', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 12,
          }), clientType);
          statsd.increment('a', 1);
          statsd.increment('b', 2);
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `a:1|c\nb:2|c${metricsEnd}`);
          done();
        });
      });

      it('should behave correctly when maxBufferSize is set to zero', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 0,
          }), clientType);
          statsd.increment('a', 1);
          statsd.increment('b', 2);
        });

        let noOfMessages = 0;
        const expected = ['a:1|c', 'b:2|c'];
        server.on('metrics', metrics => {
          // one of the few places we have an actual test difference based on server type
          if (serverType === 'udp' || serverType === 'uds' || serverType === 'stream') {
            const index = expected.indexOf(metrics.trim());
            assert.strictEqual(index >= 0, true);
            expected.splice(index, 1);
            noOfMessages++;
            if (noOfMessages === 2) {
              assert.strictEqual(expected.length, 0);
              done();
            }
          }
          else {
            assert.strictEqual(metrics, `a:1|c\nb:2|c${metricsEnd}`);
            done();
          }
        });
      });

      it('should not send batches larger then maxBufferSize', done => {
        let calledMetrics = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 2,
          }), clientType);
          statsd.increment('a', 1);
          setTimeout(() => {
            if (! calledMetrics) {
              // give a small delay to ensure the buffer is flushed
              statsd.increment('b', 2);
            }
          }, 50);
        });
        server.once('metrics', metrics => {
          calledMetrics = true;
          assert.strictEqual(metrics, `a:1|c${metricsEnd}`);
          done();
        });
      });

      it('should flush the buffer when timeout value elapsed', done => {
        let start;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 1220,
            bufferFlushInterval: 1100,
          }), clientType);
          start = new Date();
          statsd.increment('a', 1);
        });
        server.on('metrics', metric => {
          const elapsed = Date.now() - start;
          assert.strictEqual(metric, `a:1|c${metricsEnd}`);
          assert.strictEqual(elapsed > 1000, true);
          done();
        });
      });

      it('should never allow buffer to exceed maxBufferSize', done => {
        const maxSize = 100;
        const receivedBatches = [];
        let allMessagesSent = false;
        let doneCalledOnce = false;

        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: maxSize,
            bufferFlushInterval: 10000, // long interval so we control flushing
          }), clientType);

          // Send multiple messages that would exceed maxBufferSize if not flushed properly
          // Each message varies in size, and each takes up more bytes than string length due to é
          for (let i = 0; i < 10; i++) {
            statsd.increment(`test.metric.${i}`, 1, { v: Array.from({ length: i }).fill('é').join('') });
            // Check buffer size after each enqueue - this is the key test
            const bufferSize = Buffer.byteLength(statsd.bufferHolder.buffer);
            assert.strictEqual(
              bufferSize <= maxSize,
              true,
              `Buffer size ${bufferSize} exceeded maxBufferSize ${maxSize} after message ${i}`
            );
          }

          // Force a final flush to ensure all messages are sent
          allMessagesSent = true;
          statsd.flushQueue();
        });

        server.on('metrics', metrics => {
          receivedBatches.push(metrics);
          // Note: For TCP, multiple client flushes can arrive in a single server 'data' event
          // because TCP is a stream protocol. The important thing is that the CLIENT buffer
          // never exceeds maxBufferSize (verified above), which prevents fragmentation issues
          // with the Datadog agent.

          // Once we've sent all messages and received at least one batch, verify results
          if (allMessagesSent && !doneCalledOnce) {
            doneCalledOnce = true;
            // Give a small delay to ensure all batches have arrived
            setTimeout(() => {
              // Verify all 10 metrics were sent
              const allMetrics = receivedBatches.join('\n');
              for (let i = 0; i < 10; i++) {
                assert.strictEqual(
                  allMetrics.includes(`test.metric.${i}:1|c`),
                  true,
                  `Missing metric test.metric.${i}`
                );
              }
              done();
            }, 50);
          }
        });
      });
    });
  });

  describe('buffer edge cases', () => {
    it('should handle a single metric larger than maxBufferSize', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 5,
          bufferFlushInterval: 50,
        }), 'client');
        // This metric is larger than maxBufferSize but should still be sent
        statsd.increment('a.very.long.metric.name', 1);
      });
      server.on('metrics', metrics => {
        assert.ok(metrics.includes('a.very.long.metric.name:1|c'));
        done();
      });
    });

    it('should reset buffer state after flush', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 500,
          bufferFlushInterval: 10000,
        }), 'client');

        statsd.increment('a', 1);
        assert.ok(statsd.bufferHolder.buffer.length > 0);
        assert.ok(statsd.bufferLength > 0);

        statsd.flushQueue();
        assert.strictEqual(statsd.bufferHolder.buffer, '');
        assert.strictEqual(statsd.bufferLength, 0);
        done();
      });
    });

    it('should share buffer between parent and child clients', done => {
      server = createServer('udp', opts => {
        const parent = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 500,
        }), 'client');
        statsd = parent;
        const child = parent.childClient({ prefix: 'child.' });

        parent.increment('parent.metric', 1);
        child.increment('child.metric', 2);

        // Both metrics should be in the same buffer
        assert.ok(parent.bufferHolder.buffer.includes('parent.metric:1|c'));
        assert.ok(parent.bufferHolder.buffer.includes('child.child.metric:2|c'));
        assert.strictEqual(parent.bufferHolder, child.bufferHolder);
        done();
      });
    });

    it('should handle buffer with emoji and CJK characters correctly', done => {
      server = createServer('udp', opts => {
        const maxSize = 100;
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: maxSize,
          bufferFlushInterval: 10000,
        }), 'client');

        // Send metrics with multi-byte characters in tags
        statsd.increment('metric', 1, { tag: '🎉🎉🎉' });
        const bufferSize = Buffer.byteLength(statsd.bufferHolder.buffer);
        assert.strictEqual(
          bufferSize <= maxSize,
          true,
          `Buffer size ${bufferSize} exceeded maxBufferSize ${maxSize} with emoji tags`
        );
        done();
      });
    });

    it('should flush buffer on interval timer', done => {
      server = createServer('udp', opts => {
        clock = sinon.useFakeTimers();
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 5000,
          bufferFlushInterval: 500,
        }), 'client');

        statsd.increment('test', 1);
        assert.ok(statsd.bufferHolder.buffer.length > 0);

        // Advance time past bufferFlushInterval
        clock.tick(600);

        // Buffer should have been flushed by the interval
        assert.strictEqual(statsd.bufferHolder.buffer, '');
        assert.strictEqual(statsd.bufferLength, 0);

        done();
      });
    });
  });
});
