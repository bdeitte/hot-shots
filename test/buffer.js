const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#buffer', () => {
  let server;
  let statsd;

  afterEach(done => {
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
          // Each message is roughly 20-25 bytes
          for (let i = 0; i < 10; i++) {
            statsd.increment(`test.metric.${i}`, 1);
            // Check buffer size after each enqueue - this is the key test
            const bufferSize = statsd.bufferHolder.buffer.length;
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
});
