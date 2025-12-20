const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

const Telemetry = require('../lib/telemetry');

describe('#telemetry', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  describe('initialization', () => {
    it('should be disabled by default', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        assert.strictEqual(statsd.includeDatadogTelemetry, false);
        assert.strictEqual(statsd.telemetry, null);
        done();
      });
    });

    it('should be enabled when includeDatadogTelemetry is true', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');
        assert.strictEqual(statsd.includeDatadogTelemetry, true);
        assert.ok(statsd.telemetry instanceof Telemetry);
        done();
      });
    });

    it('should use default flush interval of 10 seconds', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');
        assert.strictEqual(statsd.telemetryFlushInterval, 10000);
        done();
      });
    });

    it('should allow custom flush interval', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true,
          telemetryFlushInterval: 5000
        }), 'client');
        assert.strictEqual(statsd.telemetryFlushInterval, 5000);
        done();
      });
    });

    it('should be disabled for telegraf mode', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true,
          telegraf: true
        }), 'client');
        assert.strictEqual(statsd.includeDatadogTelemetry, false);
        assert.strictEqual(statsd.telemetry, null);
        done();
      });
    });

    it('should be disabled for mock mode', () => {
      statsd = createHotShotsClient({
        includeDatadogTelemetry: true,
        mock: true
      }, 'client');
      assert.strictEqual(statsd.includeDatadogTelemetry, false);
      assert.strictEqual(statsd.telemetry, null);
    });
  });

  describe('child clients', () => {
    it('should inherit telemetry from parent', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');
        const child = statsd.childClient({ prefix: 'child.' });
        assert.strictEqual(child.telemetry, statsd.telemetry);
        child.close();
        done();
      });
    });

    it('child metrics should be tracked in parent telemetry', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');
        const child = statsd.childClient({ prefix: 'child.' });

        // Send a metric from child
        child.increment('test');

        // Check that parent's telemetry tracked it
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.count, 1);
        child.close();
        done();
      });
    });
  });

  describe('metric tracking', () => {
    it('should track increment metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.increment('test.counter');
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.count, 1);
        done();
      });
    });

    it('should track gauge metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.gauge('test.gauge', 42);
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.gauge, 1);
        done();
      });
    });

    it('should track timing metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.timing('test.timing', 100);
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.timing, 1);
        done();
      });
    });

    it('should track histogram metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.histogram('test.histogram', 50);
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.histogram, 1);
        done();
      });
    });

    it('should track distribution metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.distribution('test.distribution', 25);
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.distribution, 1);
        done();
      });
    });

    it('should track set metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.set('test.set', 'value');
        assert.strictEqual(statsd.telemetry.metrics, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.set, 1);
        done();
      });
    });

    it('should track multiple metrics of different types', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.increment('test.counter');
        statsd.gauge('test.gauge', 42);
        statsd.timing('test.timing', 100);

        assert.strictEqual(statsd.telemetry.metrics, 3);
        assert.strictEqual(statsd.telemetry.metricsByType.count, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.gauge, 1);
        assert.strictEqual(statsd.telemetry.metricsByType.timing, 1);
        done();
      });
    });

    it('should track events', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.event('Test Event', 'This is a test event');
        assert.strictEqual(statsd.telemetry.events, 1);
        done();
      });
    });

    it('should track service checks', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.check('test.check', statsd.CHECKS.OK);
        assert.strictEqual(statsd.telemetry.serviceChecks, 1);
        done();
      });
    });
  });

  describe('Telemetry class', () => {
    it('should format metrics correctly', () => {
      const telemetry = new Telemetry({
        protocol: 'udp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      const message = telemetry.formatMetric('metrics', 10);
      assert.ok(message.includes('datadog.dogstatsd.client.metrics:10|c'));
      assert.ok(message.includes('client:nodejs'));
      assert.ok(message.includes('client_transport:udp'));
    });

    it('should include extra tags when provided', () => {
      const telemetry = new Telemetry({
        protocol: 'tcp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      const message = telemetry.formatMetric('metrics_by_type', 5, ['metrics_type:count']);
      assert.ok(message.includes('datadog.dogstatsd.client.metrics_by_type:5|c'));
      assert.ok(message.includes('metrics_type:count'));
    });

    it('should reset counters after flush', () => {
      const telemetry = new Telemetry({
        protocol: 'udp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      // Set a mock send function
      const sentMessages = [];
      telemetry.setSendFunction((message, callback) => {
        sentMessages.push(message);
        if (callback) {
          callback();
        }
      });

      // Record some metrics
      telemetry.recordMetric('c');
      telemetry.recordMetric('g');
      telemetry.recordEvent();
      telemetry.recordServiceCheck();
      telemetry.recordBytesSent(100);

      assert.strictEqual(telemetry.metrics, 2);
      assert.strictEqual(telemetry.events, 1);
      assert.strictEqual(telemetry.serviceChecks, 1);
      assert.strictEqual(telemetry.bytesSent, 100);

      // Flush
      telemetry.flush();

      // Counters should be reset
      assert.strictEqual(telemetry.metrics, 0);
      assert.strictEqual(telemetry.events, 0);
      assert.strictEqual(telemetry.serviceChecks, 0);
      assert.strictEqual(telemetry.bytesSent, 0);

      // Should have sent telemetry
      assert.strictEqual(sentMessages.length, 1);
    });

    it('should not send telemetry when no metrics recorded', () => {
      const telemetry = new Telemetry({
        protocol: 'udp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      const sentMessages = [];
      telemetry.setSendFunction((message, callback) => {
        sentMessages.push(message);
        if (callback) {
          callback();
        }
      });

      telemetry.flush();
      assert.strictEqual(sentMessages.length, 0);
    });

    it('should track bytes dropped by writer', () => {
      const telemetry = new Telemetry({
        protocol: 'udp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      telemetry.recordBytesDroppedWriter(50);
      assert.strictEqual(telemetry.bytesDropped, 50);
      assert.strictEqual(telemetry.bytesDroppedWriter, 50);
      assert.strictEqual(telemetry.packetsDropped, 1);
      assert.strictEqual(telemetry.packetsDroppedWriter, 1);
    });

    it('should track bytes dropped by queue', () => {
      const telemetry = new Telemetry({
        protocol: 'udp',
        tagPrefix: '#',
        tagSeparator: ','
      });

      telemetry.recordBytesDroppedQueue(75);
      assert.strictEqual(telemetry.bytesDropped, 75);
      assert.strictEqual(telemetry.bytesDroppedQueue, 75);
      assert.strictEqual(telemetry.packetsDropped, 1);
      assert.strictEqual(telemetry.packetsDroppedQueue, 1);
    });
  });

  describe('telemetry flush', () => {
    it('should send telemetry metrics to server', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true,
          telemetryFlushInterval: 100 // Short interval for testing
        }), 'client');

        // Send some metrics
        statsd.increment('test.counter');
        statsd.gauge('test.gauge', 42);

        // Wait for telemetry flush
        server.on('metrics', metrics => {
          if (metrics.includes('datadog.dogstatsd.client.metrics')) {
            assert.ok(metrics.includes('datadog.dogstatsd.client.metrics'));
            assert.ok(metrics.includes('client:nodejs'));
            assert.ok(metrics.includes('client_transport:udp'));
            done();
          }
        });
      });
    });

    it('should flush telemetry on close', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true,
          telemetryFlushInterval: 60000 // Long interval
        }), 'client');

        // Send some metrics
        statsd.increment('test.counter');

        // Verify telemetry has data
        assert.strictEqual(statsd.telemetry.metrics, 1);

        // Close should flush telemetry
        statsd.close(() => {
          // After close, telemetry should have been flushed (counters reset)
          // Note: We can't easily verify the final flush was sent since the socket closes
          // Set statsd to null to prevent afterEach from trying to close again
          statsd = null;
          done();
        });
      });
    });
  });

  describe('bytes tracking', () => {
    it('should track bytes sent on successful send', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          includeDatadogTelemetry: true
        }), 'client');

        statsd.increment('test.counter', 1, () => {
          // Give a moment for the callback to complete
          setTimeout(() => {
            assert.ok(statsd.telemetry.bytesSent > 0);
            assert.strictEqual(statsd.telemetry.packetsSent, 1);
            done();
          }, 50);
        });
      });
    });
  });
});
