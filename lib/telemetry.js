const util = require('util');
const debug = util.debuglog('hot-shots');

// Version is read from package.json (with fallback if unavailable or malformed)
let version = 'unknown';
try {
  const pkg = require('../package.json'); // eslint-disable-line global-require
  if (pkg && typeof pkg.version === 'string') {
    version = pkg.version;
  }
} catch (err) {
  debug('hot-shots telemetry: failed to load package.json version: %s', err && err.message ? err.message : err);
}

// Default flush interval matches official Datadog clients (10 seconds)
const DEFAULT_TELEMETRY_FLUSH_INTERVAL = 10000;

// Metric type code to telemetry type name mapping
const TYPE_MAP = {
  'c': 'count',
  'g': 'gauge',
  'ms': 'timing',
  'h': 'histogram',
  'd': 'distribution',
  's': 'set'
};

/**
 * Telemetry class for tracking client-side metrics about the StatsD client itself.
 * This helps diagnose high-throughput metric delivery issues by tracking:
 * - Number of metrics/events/service checks sent
 * - Bytes and packets sent successfully
 * - Bytes and packets dropped (due to queue overflow or writer errors)
 *
 * Telemetry metrics are prefixed with 'datadog.dogstatsd.client.' and are not billed
 * as custom metrics by Datadog.
 */
class Telemetry {
  /**
   * @param {Object} options
   * @param {string} options.protocol - Transport protocol (udp, tcp, uds, stream)
   * @param {number} options.flushInterval - Interval in ms between telemetry flushes (default: 10000)
   * @param {Object} options.globalTags - Global tags from the client (not used for telemetry)
   * @param {string} options.tagPrefix - Tag prefix from the client
   * @param {string} options.tagSeparator - Tag separator from the client
   */
  constructor(options) {
    this.protocol = options.protocol || 'udp';
    this.flushInterval = options.flushInterval || DEFAULT_TELEMETRY_FLUSH_INTERVAL;
    this.tagPrefix = options.tagPrefix || '#';
    this.tagSeparator = options.tagSeparator || ',';

    // Build telemetry-specific tags (not user's globalTags)
    this.telemetryTags = [
      'client:nodejs',
      `client_version:${version}`,
      `client_transport:${this.protocol}`
    ];

    // Initialize counters
    this.resetCounters();

    // Reference to the client's send function (set via setSendFunction)
    this.sendFn = null;

    // Interval handle for periodic flushing
    this.intervalHandle = null;

    debug('hot-shots telemetry: initialized with protocol=%s, flushInterval=%d', this.protocol, this.flushInterval);
  }

  /**
   * Reset all telemetry counters to zero.
   * Called after each flush to report differential values.
   */
  resetCounters() {
    // Metric counters
    this.metrics = 0;
    this.metricsByType = {
      count: 0,
      gauge: 0,
      timing: 0,
      histogram: 0,
      distribution: 0,
      set: 0
    };
    this.events = 0;
    this.serviceChecks = 0;

    // Transmission counters
    this.bytesSent = 0;
    this.bytesDropped = 0;
    this.bytesDroppedWriter = 0;
    this.packetsSent = 0;
    this.packetsDropped = 0;
    this.packetsDroppedQueue = 0;
    this.packetsDroppedWriter = 0;
  }

  /**
   * Set the send function to use for flushing telemetry.
   * This is called by the client after initialization.
   * @param {Function} sendFn - Function that sends a message (message, callback)
   */
  setSendFunction(sendFn) {
    this.sendFn = sendFn;
  }

  /**
   * Start the telemetry flush interval.
   * Should be called after the client is fully initialized.
   */
  start() {
    if (this.intervalHandle) {
      return; // Already started
    }

    this.intervalHandle = setInterval(() => {
      this.flush();
    }, this.flushInterval);

    // Do not block node from shutting down
    this.intervalHandle.unref();

    debug('hot-shots telemetry: started flush interval (every %dms)', this.flushInterval);
  }

  /**
   * Stop the telemetry flush interval.
   */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      debug('hot-shots telemetry: stopped flush interval');
    }
  }

  /**
   * Record a metric being sent.
   * @param {string} type - The metric type code (c, g, ms, h, d, s)
   */
  recordMetric(type) {
    this.metrics++;
    const typeName = TYPE_MAP[type];
    if (typeName && this.metricsByType[typeName] !== undefined) {
      this.metricsByType[typeName]++;
    }
    debug('hot-shots telemetry: recordMetric type=%s, total=%d', type, this.metrics);
  }

  /**
   * Record an event being sent.
   */
  recordEvent() {
    this.events++;
    debug('hot-shots telemetry: recordEvent total=%d', this.events);
  }

  /**
   * Record a service check being sent.
   */
  recordServiceCheck() {
    this.serviceChecks++;
    debug('hot-shots telemetry: recordServiceCheck total=%d', this.serviceChecks);
  }

  /**
   * Record bytes successfully sent.
   * @param {number} bytes - Number of bytes sent
   */
  recordBytesSent(bytes) {
    this.bytesSent += bytes;
    this.packetsSent++;
    debug('hot-shots telemetry: recordBytesSent bytes=%d, totalBytes=%d, totalPackets=%d',
      bytes, this.bytesSent, this.packetsSent);
  }

  /**
   * Record bytes dropped due to writer/transport errors.
   * @param {number} bytes - Number of bytes dropped
   */
  recordBytesDroppedWriter(bytes) {
    this.bytesDropped += bytes;
    this.bytesDroppedWriter += bytes;
    this.packetsDropped++;
    this.packetsDroppedWriter++;
    debug('hot-shots telemetry: recordBytesDroppedWriter bytes=%d, totalDropped=%d', bytes, this.bytesDropped);
  }

  /**
   * Format a telemetry metric message.
   * @param {string} name - Metric name (without prefix)
   * @param {number} value - Metric value
   * @param {Array} extraTags - Additional tags to include
   * @returns {string} Formatted metric message
   */
  formatMetric(name, value, extraTags = []) {
    const fullName = `datadog.dogstatsd.client.${name}`;
    const allTags = extraTags.length > 0 ?
      [...this.telemetryTags, ...extraTags] :
      this.telemetryTags;
    return `${fullName}:${value}|c|${this.tagPrefix}${allTags.join(this.tagSeparator)}`;
  }

  /**
   * Flush all telemetry metrics.
   * Sends accumulated counters and resets them.
   * @param {Function} callback - Optional callback when flush is complete
   */
  flush(callback) {
    if (!this.sendFn) {
      debug('hot-shots telemetry: flush skipped - no send function set');
      if (callback) {
        callback();
      }
      return;
    }

    const messages = [];

    // Metrics count
    if (this.metrics > 0) {
      messages.push(this.formatMetric('metrics', this.metrics));
    }

    // Metrics by type
    for (const [typeName, count] of Object.entries(this.metricsByType)) {
      if (count > 0) {
        messages.push(this.formatMetric('metrics_by_type', count, [`metrics_type:${typeName}`]));
      }
    }

    // Events count
    if (this.events > 0) {
      messages.push(this.formatMetric('events', this.events));
    }

    // Service checks count
    if (this.serviceChecks > 0) {
      messages.push(this.formatMetric('service_checks', this.serviceChecks));
    }

    // Bytes sent
    if (this.bytesSent > 0) {
      messages.push(this.formatMetric('bytes_sent', this.bytesSent));
    }

    // Bytes dropped
    if (this.bytesDropped > 0) {
      messages.push(this.formatMetric('bytes_dropped', this.bytesDropped));
    }

    // Bytes dropped by writer
    if (this.bytesDroppedWriter > 0) {
      messages.push(this.formatMetric('bytes_dropped_writer', this.bytesDroppedWriter));
    }

    // Packets sent
    if (this.packetsSent > 0) {
      messages.push(this.formatMetric('packets_sent', this.packetsSent));
    }

    // Packets dropped
    if (this.packetsDropped > 0) {
      messages.push(this.formatMetric('packets_dropped', this.packetsDropped));
    }

    // Packets dropped by queue
    if (this.packetsDroppedQueue > 0) {
      messages.push(this.formatMetric('packets_dropped_queue', this.packetsDroppedQueue));
    }

    // Packets dropped by writer
    if (this.packetsDroppedWriter > 0) {
      messages.push(this.formatMetric('packets_dropped_writer', this.packetsDroppedWriter));
    }

    // Reset counters before sending (to capture new activity during send)
    this.resetCounters();

    if (messages.length === 0) {
      debug('hot-shots telemetry: flush - no metrics to send');
      if (callback) {
        callback();
      }
      return;
    }

    debug('hot-shots telemetry: flushing %d telemetry metrics', messages.length);

    // Send all telemetry messages
    const message = messages.join('\n');
    this.sendFn(message, callback);
  }
}

module.exports = Telemetry;
module.exports.DEFAULT_TELEMETRY_FLUSH_INTERVAL = DEFAULT_TELEMETRY_FLUSH_INTERVAL;
