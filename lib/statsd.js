const process = require('process'),
  util = require('util'),
  helpers = require('./helpers'),
  applyStatsFns = require('./statsFunctions');

const constants = require('./constants');
const createTransport = require('./transport');
const originDetection = require('./originDetection');
const debug = util.debuglog('hot-shots');
const Telemetry = require('./telemetry');

const PROTOCOL = constants.PROTOCOL;
const TCP_ERROR_CODES = constants.tcpErrors();
const UDS_ERROR_CODES = constants.udsErrors();
const TCP_DEFAULT_GRACEFUL_RESTART_LIMIT = 1000;
const UDS_DEFAULT_GRACEFUL_RESTART_LIMIT = 1000;
const CACHE_DNS_TTL_DEFAULT = 60000;
// DD_ENV_GLOBAL_TAGS_MAPPING is a mapping of each "DD_" prefixed environment variable to a specific tag name.
const DD_ENV_GLOBAL_TAGS_MAPPING = {
  DD_ENTITY_ID: 'dd.internal.entity_id', // Client-side entity ID injection for container tagging.
  DD_ENV: 'env', // The name of the env in which the service runs.
  DD_SERVICE: 'service', // The name of the running service.
  DD_VERSION: 'version', // The current version of the running service.
};

/**
 * The Client for StatsD.  The main entry-point for hot-shots.  Note adding new parameters
 * to the constructor is deprecated- please use the constructor as one options object.
 * @constructor
 */
const Client = function (host, port, prefix, suffix, globalize, cacheDns, mock,
    globalTags, maxBufferSize, bufferFlushInterval, telegraf, sampleRate, protocol) {
  let options = host || {};

  // Adding options below is DEPRECATED.  Use the options object instead.
  if (arguments.length > 1 || typeof(host) === 'string') {
    options = {
      host        : host,
      port        : port,
      prefix      : prefix,
      suffix      : suffix,
      globalize   : globalize,
      cacheDns    : cacheDns,
      mock        : mock === true,
      globalTags  : globalTags,
      maxBufferSize : maxBufferSize,
      bufferFlushInterval: bufferFlushInterval,
      telegraf    : telegraf,
      sampleRate  : sampleRate,
      protocol    : protocol
    };
  }

  // Warn on clearly-invalid options. Invalid values are then cleared to undefined so
  // the existing `|| <default>` chains downstream pick up the safe fallback
  if (options.port !== undefined && options.port !== null) {
    const p = options.port;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(`hot-shots: 'port' should be an integer in [1, 65535], got ${p} — using default`);
      options.port = undefined;
    }
  }
  if (options.sampleRate !== undefined && options.sampleRate !== null) {
    const s = options.sampleRate;
    // sampleRate <= 0 (dropping every metric — just don't call the method) and > 1
    // are nonsense. Warn and reset to default.
    if (typeof s !== 'number' || Number.isNaN(s) || s <= 0 || s > 1) {
      console.error(`hot-shots: 'sampleRate' should be a number in (0, 1], got ${s} — using default`);
      options.sampleRate = undefined;
    }
  }
  if (options.bufferFlushInterval !== undefined && options.bufferFlushInterval !== null) {
    const b = options.bufferFlushInterval;
    // Reject non-finite (NaN/Infinity) and values above setTimeout's signed-32-bit
    // max — Node clamps oversized delays to 1ms, which would create a hot flush loop.
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 2147483647) {
      console.error('hot-shots: \'bufferFlushInterval\' should be a finite positive number ' +
        `<= 2147483647, got ${b} — using default`);
      options.bufferFlushInterval = undefined;
    }
  }

  // hidden global_tags option for backwards compatibility
  options.globalTags = options.globalTags || options.global_tags;

  this.protocol = (options.protocol && options.protocol.toLowerCase());
  if (! this.protocol) {
    this.protocol = PROTOCOL.UDP;
  }
  this.cacheDns = options.cacheDns === true;
  this.cacheDnsTtl = options.cacheDnsTtl || CACHE_DNS_TTL_DEFAULT;
  this.host = options.host || (process.env.DD_AGENT_HOST  || undefined);
  this.port = options.port || parseInt(process.env.DD_DOGSTATSD_PORT, 10) || 8125;
  this.path = options.path;
  // Retry-only options for UDS
  this.udsRetryOptions = options.udsRetryOptions;
  this.stream = options.stream;
  this.prefix = helpers.normalizePrefix(options.prefix);
  this.suffix = helpers.normalizeSuffix(options.suffix);
  this.tagPrefix = options.tagPrefix || '#';
  this.tagSeparator = options.tagSeparator || ',';
  this.mock        = options.mock;
  this.globalTags  = typeof options.globalTags === 'object' ?
      helpers.formatTags(options.globalTags, options.telegraf) : [];
  this.includeDataDogTags = options.includeDataDogTags !== false;
  if (this.includeDataDogTags) {
    const availableDDEnvs = Object.keys(DD_ENV_GLOBAL_TAGS_MAPPING).filter(key => process.env[key]);
    if (availableDDEnvs.length > 0) {
      this.globalTags = this.globalTags.
        filter((item) => !availableDDEnvs.some(env => item.startsWith(`${DD_ENV_GLOBAL_TAGS_MAPPING[env]}:`))).
        concat(availableDDEnvs.map(env => `${DD_ENV_GLOBAL_TAGS_MAPPING[env]}:${helpers.sanitizeTags(process.env[env])}`));
    }
  }
  this.telegraf = options.telegraf || false;
  // Datadog mode: explicit true/false wins; otherwise auto-detect from signals.
  // Telegraf and datadog are mutually exclusive (telegraf wins).
  if (options.isChild) {
    this.datadog = options.datadog === true;
    this.originDetection = options.originDetection === true;
    this.containerID = options.containerID;
    this.externalData = options.externalData;
    this.cardinality = options.cardinality;
  } else {
    if (options.datadog === true && this.telegraf) {
      console.error('hot-shots: datadog and telegraf options are mutually exclusive; ' +
        'telegraf takes precedence and datadog features are disabled');
      this.datadog = false;
    } else if (typeof options.datadog === 'boolean') {
      this.datadog = options.datadog;
    } else {
      this.datadog = helpers.detectDatadogMode(this.telegraf, this.protocol);
    }

    this.originDetection = false;
    this.containerID = undefined;
    this.externalData = undefined;
    this.cardinality = undefined;

    if (this.datadog) {
      this.originDetection = options.originDetection !== false &&
        !helpers.isFalseyEnvValue(process.env.DD_ORIGIN_DETECTION_ENABLED);
      if (options.containerID) {
        this.containerID = options.containerID;
      } else if (this.originDetection) {
        this.containerID = originDetection.getContainerID();
      }
      this.externalData = helpers.sanitizeExternalData(process.env.DD_EXTERNAL_ENV);
      this.cardinality = helpers.validateCardinality(
        options.cardinality || process.env.DD_CARDINALITY || process.env.DATADOG_CARDINALITY);
    }
  }
  if (options.maxBufferSize !== undefined) {
    this.maxBufferSize = options.maxBufferSize;
    // For UDS protocol, enforce 8k limit
    if (this.protocol === PROTOCOL.UDS && this.maxBufferSize > 8192) {
      console.warn(`hot-shots: maxBufferSize (${this.maxBufferSize}) exceeds the 8192 byte limit for UDS protocol. ` +
        'Setting maxBufferSize to 8192.');
      this.maxBufferSize = 8192;
    }
  } else if (this.protocol === PROTOCOL.UDS) {
    this.maxBufferSize = 8192; // 8KiB as recommended by Datadog for UDS
  } else {
    this.maxBufferSize = 0;
  }
  this.sampleRate = options.sampleRate || 1;
  this.bufferFlushInterval = options.bufferFlushInterval || 1000;
  this.bufferHolder = options.isChild ? options.bufferHolder : { buffer: '' };
  this.bufferLength = Buffer.byteLength(this.bufferHolder.buffer);
  this.errorHandler = options.errorHandler;
  // Construction-time only: true iff this.errorHandler was the same function
  // attached as the shared socket's 'error' listener at construction time. This
  // flag does NOT track runtime changes — _close() removes the listener from the
  // socket while close runs, after which this flag is stale. Code in _close that
  // needs the live state must use the local errorHandlerOnSocketDuringClose
  // variable, not this flag.
  this._errorHandlerInitiallyOnSocket = options._errorHandlerInitiallyOnSocket !== undefined ?
    options._errorHandlerInitiallyOnSocket :
    (!options.isChild && Boolean(options.errorHandler));
  this.tcpGracefulErrorHandling = 'tcpGracefulErrorHandling' in options ? options.tcpGracefulErrorHandling : true;
  this.tcpGracefulRestartRateLimit = options.tcpGracefulRestartRateLimit || TCP_DEFAULT_GRACEFUL_RESTART_LIMIT; // only recreate once per second
  this.udsGracefulErrorHandling = 'udsGracefulErrorHandling' in options ? options.udsGracefulErrorHandling : true;
  this.udsGracefulRestartRateLimit = options.udsGracefulRestartRateLimit || UDS_DEFAULT_GRACEFUL_RESTART_LIMIT; // only recreate once per second
  this.isChild = options.isChild;
  this.closingFlushInterval = options.closingFlushInterval || 50;
  // Don't set a default type here - let transport.js auto-detect based on host IP version
  this.udpSocketOptions = options.udpSocketOptions || {};

  // Telemetry options (Datadog-specific, disabled by default)
  // Only enable for non-telegraf, non-mock, non-child clients
  // Under datadog mode telemetry defaults on (matching the official clients);
  // otherwise it stays opt-in. Always disabled for telegraf/mock/child clients.
  const telemetryRequested = options.includeDatadogTelemetry === undefined ?
    this.datadog === true :
    options.includeDatadogTelemetry === true;
  this.includeDatadogTelemetry = telemetryRequested &&
    !options.telegraf &&
    !options.mock &&
    !options.isChild;

  // Initialize telemetry if enabled
  if (this.includeDatadogTelemetry) {
    this.telemetryFlushInterval = options.telemetryFlushInterval || Telemetry.DEFAULT_TELEMETRY_FLUSH_INTERVAL;
    this.telemetry = new Telemetry({
      protocol: this.protocol,
      flushInterval: this.telemetryFlushInterval,
      tagPrefix: this.tagPrefix,
      tagSeparator: this.tagSeparator,
      errorHandler: this.errorHandler
    });
  } else if (options.isChild && options.telemetry) {
    // Child clients share parent's telemetry instance
    this.telemetry = options.telemetry;
  } else {
    this.telemetry = null;
  }

  // If we're mocking the client, create a buffer to record the outgoing calls.
  if (this.mock) {
    this.mockBuffer = [];
  }

  // We only want a single flush event per parent and all its child clients
  if (!options.isChild && this.maxBufferSize > 0) {
    this.intervalHandle = setInterval(() => {
      try {
        this.onBufferFlushInterval();
      } catch (err) {
        if (this.errorHandler) {
          try {
            this.errorHandler(err);
          } catch (handlerErr) {
            // Preserve the original flush error so the root cause is not masked by a buggy handler.
            console.error('hot-shots: errorHandler threw inside buffer flush interval; ' +
              `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
          }
        } else {
          console.error(`hot-shots: buffer flush interval threw: ${err && err.message}`);
        }
      }
    }, this.bufferFlushInterval);
    // do not block node from shutting down
    this.intervalHandle.unref();
  }

  if (options.isChild) {
    if (options.dnsError) {
      this.dnsError = options.dnsError;
    }
    this.socket = options.socket;
  } else if (options.useDefaultRoute) {
    const defaultRoute = helpers.getDefaultRoute();
    if (defaultRoute) {
      console.log(`Got ${defaultRoute} for the system's default route`);
      this.host = defaultRoute;
    }
  }

  if (!this.socket) {
    trySetNewSocket(this);
  }

  if (this.socket && !options.isChild && options.errorHandler) {
    this.socket.on('error', options.errorHandler);
  }

  if (options.globalize) {
    global.statsd = this;
  }

  // Start telemetry if enabled (only for parent clients)
  if (this.includeDatadogTelemetry && this.telemetry) {
    // Set the send function for telemetry to use
    // We use sendMessage directly to bypass metric tracking (avoid infinite loop)
    this.telemetry.setSendFunction((message, callback) => {
      this.sendMessage(message, callback, true); // true = isTelemetry
    });
    this.telemetry.start();
  }

  debug('hot-shots client initialized: protocol=%s, host=%s, port=%s, prefix=%s, maxBufferSize=%s, mock=%s',
    this.protocol, this.host, this.port, this.prefix, this.maxBufferSize, this.mock);

  // only for TCP/UDS (options.protocol tcp/uds)
  // enabled with the extra flag options.tcpGracefulErrorHandling/options.udsGracefulErrorHandling
  // will gracefully (attempt) to re-open the socket with a small delay
  // options.tcpGracefulRestartRateLimit/options.udsGracefulRestartRateLimit is the minimum time (ms) between creating sockets
  // does not support options.isChild (how to re-create a socket you didn't create?)
  if (this.socket) {
    maybeAddProtocolErrorHandler(this, options.protocol);
  }

  this.messagesInFlight = 0;
  // Drain signaling for graceful close: when messagesInFlight transitions 0 -> 1,
  // we lazily allocate a Promise; the 1 -> 0 transition resolves it.
  this.drainResolve = null;
  this.drainPromise = null;
  this.CHECKS = {
    OK: 0,
    WARNING: 1,
    CRITICAL: 2,
    UNKNOWN: 3,
  };
};

applyStatsFns(Client);

/**
 * Checks if stats is an array and sends all stats calling back once all have sent
 * @param stat {String|Array} The stat(s) to send
 * @param value The value to send
 * @param type The type of the metric
 * @param sampleRate {Number|Object=} The Number of times to sample (0 to 1), or an options object. Optional.
 *   @option sampleRate {Number=} The Number of times to sample (0 to 1). Optional.
 *   @option tags {Array=} The Array of tags to add to metrics. Optional.
 *   @option timestamp {Date|Number=} Timestamp to send with the metric (DogStatsD only). Optional.
 * @param tags {Array=} The Array of tags to add to metrics. Optional.
 * @param callback {Function=} Callback when message is done being delivered. Optional.
 */
Client.prototype.sendAll = function (stat, value, type, sampleRate, tags, callback) {
  let completed = 0;
  let calledback = false;
  let sentBytes = 0;
  let timestamp;
  const self = this;

  // Handle options object: sendAll(stat, value, type, { sampleRate, tags, timestamp }, callback)
  // Check for known option keys to distinguish from a tags object
  if (sampleRate && typeof sampleRate === 'object' && !Array.isArray(sampleRate) &&
      ('sampleRate' in sampleRate || 'tags' in sampleRate || 'timestamp' in sampleRate)) {
    callback = tags;
    timestamp = sampleRate.timestamp;
    tags = sampleRate.tags;
    sampleRate = sampleRate.sampleRate;
  }

  if (sampleRate && typeof sampleRate !== 'number') {
    // Only shift parameters if tags wasn't provided as a separate argument.
    // If tags is present and is an object (array or object), keep it as tags.
    // This fixes the case where an empty object {} is passed for sampleRate.
    if (tags !== undefined && tags !== null && typeof tags === 'object') {
      // sampleRate is invalid (not a number), but tags looks valid - don't shift
      debug('hot-shots sendAll: sampleRate is not a number but tags parameter present, ignoring invalid sampleRate');
      sampleRate = undefined;
    } else {
      callback = tags;
      tags = sampleRate;
      sampleRate = undefined;
    }
  }

  if (tags && typeof tags !== 'object') {
    callback = tags;
    tags = undefined;
  }

  /**
   * Gets called once for each callback, when all callbacks return we will
   * call back from the function
   * @private
   */
  function onSend(error, bytes) {
    completed += 1;
    if (calledback) {
      return;
    }

    if (error) {
      if (typeof callback === 'function') {
        calledback = true;
        callback(error);
      } else if (self.errorHandler) {
        calledback = true;
        self.errorHandler(error);
      }
      return;
    }

    if (bytes) {
      sentBytes += bytes;
    }

    if (completed === stat.length && typeof callback === 'function') {
      callback(null, sentBytes);
    }
  }

  if (Array.isArray(stat)) {
    stat.forEach(item => {
      self.sendStat(item, value, type, sampleRate, tags, timestamp, onSend);
    });
  } else {
    this.sendStat(stat, value, type, sampleRate, tags, timestamp, callback);
  }
};

/**
 * Sends a stat across the wire
 * @param stat {String|Array} The stat(s) to send
 * @param value The value to send
 * @param type {String} The type of message to send to statsd
 * @param sampleRate {Number} The Number of times to sample (0 to 1)
 * @param tags {Array} The Array of tags to add to metrics
 * @param timestamp {Date|Number} The timestamp to send with the metric (DogStatsD only). Optional.
 * @param callback {Function=} Callback when message is done being delivered. Optional.
 */
Client.prototype.sendStat = function (stat, value, type, sampleRate, tags, timestamp, callback) {
  // Track metric in telemetry (even if sampled out, matching official Datadog behavior)
  if (this.telemetry) {
    this.telemetry.recordMetric(type);
  }

  // Sanitize metric name to prevent protocol-breaking characters
  const sanitizedStat = helpers.sanitizeMetricName(stat);
  let message = `${this.prefix + sanitizedStat + this.suffix}:${value}|${type}`;
  sampleRate = sampleRate || this.sampleRate;
  if (sampleRate && sampleRate < 1) {
    if (Math.random() < sampleRate) {
      message += `|@${sampleRate}`;
      debug('hot-shots sendStat: sampled in - stat=%s, type=%s, sampleRate=%s', stat, type, sampleRate);
    } else {
      // don't want to send if we don't meet the sample ratio
      debug('hot-shots sendStat: sampled out - stat=%s, type=%s, sampleRate=%s', stat, type, sampleRate);
      return callback ? callback() : undefined;
    }
  }
  // Timestamp support for DogStatsD (not supported by Telegraf)
  if (timestamp !== undefined) {
    if (this.telegraf) {
      debug('hot-shots sendStat: timestamp provided but not supported for Telegraf, ignoring');
    } else {
      const ts = helpers.formatDate(timestamp);
      if (ts) {
        message += `|T${ts}`;
      }
    }
  }
  debug('hot-shots sendStat: sending message=%s, tags=%j', message, tags);
  this.send(message, tags, callback);
};

/**
 * Send a stat or event across the wire
 * @param message {String} The constructed message without tags
 * @param tags {Array} The tags to include (along with global tags). Optional.
 * @param callback {Function=} Callback when message is done being delivered (only if maxBufferSize == 0). Optional.
 */
Client.prototype.send = function (message, tags, callback) {
  // mergedTags must stay read-only after assignment. When tags are empty we alias
  // this.globalTags directly (skipping overrideTags' fresh-copy allocation); any
  // mutation here would corrupt the shared globalTags array.
  let mergedTags = this.globalTags;
  if (tags && typeof tags === 'object' &&
      (Array.isArray(tags) ? tags.length > 0 : Object.keys(tags).length > 0)) {
    mergedTags = helpers.overrideTags(mergedTags, tags, this.telegraf);
  }
  if (mergedTags.length > 0) {
    if (this.telegraf) {
      message = message.split(':');
      const tagStr = mergedTags.map(tag => {
        const idx = tag.indexOf(':');
        if (idx < 1) {
          return tag;
        }
        return tag.substring(0, idx) + '=' + tag.substring(idx + 1);
      }).join(',');
      message = `${message[0]},${tagStr}:${message.slice(1).join(':')}`;
    } else {
      message += `|${this.tagPrefix}${mergedTags.join(this.tagSeparator)}`;
    }
  }

  this._send(message, callback);
};

/**
 * Send a stat or event across the wire
 * @param message {String} The constructed message without tags
 * @param callback {Function=} Callback when message is done being delivered (only if maxBufferSize == 0). Optional.
 */
Client.prototype._send = function (message, callback) {
  // we may have a cached error rather than a cached lookup, so
  // throw it on
  if (this.dnsError) {
    debug('hot-shots send: DNS error - %s', this.dnsError);
    if (callback) {
      return callback(this.dnsError);
    } else if (this.errorHandler) {
      return this.errorHandler(this.dnsError);
    }
    throw this.dnsError;
  }

  // Only send this stat if we're not a mock Client.
  if (!this.mock) {
    if (this.maxBufferSize === 0) {
      debug('hot-shots sending immediately (no buffering) - message=%s', message);
      this.sendMessage(message, callback);
    } else {
      debug('hot-shots _send: enqueueing for buffer - message=%s', message);
      this.enqueue(message, callback);
    }
  } else {
    debug('hot-shots send: mock mode - buffering message=%s', message);
    this.mockBuffer.push(message);
    if (typeof callback === 'function') {
      callback(null, 0);
    }
  }
};

/**
 * Add the message to the buffer and flush the buffer if needed.
 *
 * @param message {String} The constructed message without tags
 * @param callback {Function=} Invoked synchronously with no arguments once the
 *   message is queued. This is a "queued" signal, not a "delivered" signal — it
 *   does not report errors from any prior buffer's overflow-triggered flush, which
 *   are surfaced via errorHandler / the socket error path like any other buffered
 *   send failure. Optional.
 */
Client.prototype.enqueue = function (message, callback) {
  const messageToAdd = (this.bufferHolder.buffer === '' ? '' : '\n') + message;
  const messageBytes = Buffer.byteLength(messageToAdd);

  if (this.bufferLength + messageBytes > this.maxBufferSize) {
    debug('hot-shots enqueue: buffer full (%d + %d > %d), flushing',
      this.bufferLength, messageBytes, this.maxBufferSize);
    // Flush the *prior* buffer with no callback — the callback belongs to the new
    // message we are about to enqueue, not to the bytes already buffered.
    this.flushQueue();

    // Do not re-use messageToAdd, it ends with '\n' which we don't want.
    this.bufferHolder.buffer = message;
    this.bufferLength = Buffer.byteLength(this.bufferHolder.buffer);
    if (callback) {
      callback();
    }
  }
  else {
    this.bufferHolder.buffer += messageToAdd;
    this.bufferLength = Buffer.byteLength(this.bufferHolder.buffer);
    debug('hot-shots enqueue: added to buffer, new size=%d', this.bufferLength);
    if (callback) {
      callback();
    }
  }
};

/**
 * Flush the buffer, sending on the messages
 */
Client.prototype.flushQueue = function (callback) {
  if (this.bufferLength > 0) {
    debug('hot-shots flushQueue: flushing %d bytes', this.bufferLength);
  }
  this.sendMessage(this.bufferHolder.buffer, callback);
  this.bufferHolder.buffer = '';
  this.bufferLength = 0;
};

/**
 * Send on the message through the socket
 *
 * @param message {String} The constructed message without tags
 * @param callback {Function=} Callback when message is done being delivered. Optional.
 * @param isTelemetry {Boolean=} Whether this is a telemetry message (to avoid tracking telemetry). Optional.
 */
Client.prototype.sendMessage = function (message, callback, isTelemetry) {
  // don't waste the time if we aren't sending anything
  if (message === '' || this.mock) {
    if (callback) {
      callback();
    }
    return;
  }

  const messageBytes = Buffer.byteLength(message);
  debug('hot-shots sendMessage: message size in bytes is %d', messageBytes);

  const socketWasMissing = !this.socket;
  if (socketWasMissing && (this.protocol === PROTOCOL.TCP || this.protocol === PROTOCOL.UDS)) {
    debug('hot-shots sendMessage: socket missing, attempting to recreate for protocol=%s', this.protocol);
    trySetNewSocket(this);
    if (this.socket) {
      // On success, add custom TCP/UDS error handling.
      maybeAddProtocolErrorHandler(this, this.protocol, Date.now());
      debug('hot-shots sendMessage: socket recreated successfully');
    }
  }

  if (socketWasMissing) {
    const error = new Error('Socket not created properly. Check previous errors for details.');
    debug('hot-shots sendMessage: socket creation failed - %s', error.message);
    // Track bytes dropped due to socket error (only for non-telemetry messages)
    if (this.telemetry && !isTelemetry) {
      this.telemetry.recordBytesDroppedWriter(messageBytes);
    }
    if (callback) {
      return callback(error);
    } else if (this.errorHandler) {
      return this.errorHandler(error);
    } else {
      return console.error(String(error));
    }
  }

  const handleCallback = (err, bytes) => {
    this.messagesInFlight--;
    if (this.messagesInFlight === 0 && this.drainResolve) {
      const resolve = this.drainResolve;
      this.drainResolve = null;
      this.drainPromise = null;
      resolve();
    }
    const errFormatted = err ? new Error(`Error sending hot-shots message: ${err}`) : null;
    if (errFormatted) {
      errFormatted.code = err.code;
      debug('hot-shots sendMessage: error sending - %s (code: %s)', err.message, err.code);
      // Track bytes dropped due to writer error (only for non-telemetry messages)
      if (this.telemetry && !isTelemetry) {
        this.telemetry.recordBytesDroppedWriter(messageBytes);
      }
      // handle TCP/UDS error that requires socket replacement when we are not
      // emitting the `error` event on `this.socket`
      if ((this.protocol === PROTOCOL.TCP || this.protocol === PROTOCOL.UDS) && (callback || this.errorHandler)) {
        protocolErrorHandler(this, this.protocol, err);
      }
    } else {
      debug('hot-shots sendMessage: successfully sent %d bytes', messageBytes);
      // Track bytes sent successfully (only for non-telemetry messages)
      if (this.telemetry && !isTelemetry) {
        this.telemetry.recordBytesSent(messageBytes);
      }
    }
    if (callback) {
      callback(errFormatted, bytes);
    } else if (errFormatted) {
      if (this.errorHandler) {
        this.errorHandler(errFormatted);
      } else {
        console.error(String(errFormatted));
        // emit error ourselves on the socket for backwards compatibility
        this.socket.emit('error', errFormatted);
      }
    }
  };

  try {
    if (this.messagesInFlight === 0) {
      this.drainPromise = new Promise(resolve => { this.drainResolve = resolve; });
    }
    this.messagesInFlight++;
    debug('hot-shots sendMessage: sending %d bytes via %s transport (messagesInFlight=%d)',
      messageBytes, this.protocol, this.messagesInFlight);
    this.socket.send(Buffer.from(message), handleCallback);
  } catch (err) {
    debug('hot-shots sendMessage: exception during send - %s', err.message);
    handleCallback(err);
  }
};

/**
 * Called every bufferFlushInterval to flush any buffer that is around
 */
Client.prototype.onBufferFlushInterval = function () {
  this.flushQueue();
};

/**
 * Close the underlying socket and stop listening for data on it.
 */
Client.prototype.close = function (callback) {
  // stop trying to flush the queue on an interval
  if (this.intervalHandle) {
    clearInterval(this.intervalHandle);
  }

  // Stop telemetry and flush one last time. Guard the final flush so a synchronous
  // failure during shutdown can't abort close() and skip the caller's callback.
  if (this.includeDatadogTelemetry && this.telemetry) {
    this.telemetry.stop();
    try {
      this.telemetry.flush();
    } catch (err) {
      if (this.errorHandler) {
        try {
          this.errorHandler(err);
        } catch (handlerErr) {
          // Preserve the original flush error so the root cause is not masked by a buggy handler.
          console.error('hot-shots: errorHandler threw inside final telemetry flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: final telemetry flush threw: ${err && err.message}`);
      }
    }
  }

  // flush the queue one last time, if needed
  this.flushQueue((err) => {
    if (err) {
      if (callback) {
        return callback(err);
      }
      else if (this.errorHandler) {
        try {
          this.errorHandler(err);
        } catch (handlerErr) {
          // Preserve the original flush error so the root cause is not masked by a buggy handler.
          console.error('hot-shots: errorHandler threw inside final buffer flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
        return;
      }
      else {
        return console.error(err);
      }
    }

    // Wait for in-flight messages to drain. Match the existing polling implementation's
    // budget exactly: it increments intervalAttempts before checking `> 10`, so the
    // force-close fires on the 11th tick — i.e. closingFlushInterval * 11 ms after close().
    // Using * 10 would shorten the grace period by one tick and could force-close a
    // message that would have drained under the prior implementation.
    const drainTimeoutMs = this.closingFlushInterval * 11;
    const closeStart = Date.now();

    const finish = () => {
      if (this.messagesInFlight > 0) {
        // Match the prior force-close behavior: zero out and proceed.
        console.error('hot-shots could not clear out messages in flight but closing anyways');
        this.messagesInFlight = 0;
        this.drainResolve = null;
        this.drainPromise = null;
      }
      // Use setImmediate to ensure _close is never called synchronously from within
      // a native socket send callback (e.g. unix-dgram crashes if close() is called
      // from inside a send completion callback on the same tick).
      setImmediate(() => { this._close(callback); });
    };

    // Wait for drain with re-check after each cycle. If a send completes and its
    // user callback synchronously issues a new send, messagesInFlight goes 0→1 again
    // and a fresh drainPromise is allocated. Without the re-check loop we'd snapshot
    // the original drain promise, see it resolve, then force-close the new in-flight
    // message. This matches the prior polling implementation's "wait until messagesInFlight
    // actually stays at zero" semantics, capped by the same overall timeout budget.
    const waitForDrain = () => {
      const remaining = drainTimeoutMs - (Date.now() - closeStart);
      if (remaining <= 0) {
        finish();
        return;
      }

      if (this.messagesInFlight === 0) {
        // Provisional drain. Reaching zero synchronously is not enough — a user callback
        // might have queued a follow-up send via process.nextTick / Promise.then /
        // setImmediate / setTimeout that has not run yet. Wait one closingFlushInterval
        // tick to match the prior polling implementation's tolerance for delayed
        // follow-ups (which observed the counter every closingFlushInterval ms). Using
        // a real setTimeout — not setImmediate — covers the timer phase too. Cap the
        // wait at the remaining budget so we never exceed the overall close timeout.
        // If a queued send fires during this window, messagesInFlight will be > 0 and
        // we loop.
        const provisionalWait = Math.min(this.closingFlushInterval, remaining);
        setTimeout(() => {
          if (this.messagesInFlight === 0) {
            finish();
          } else {
            waitForDrain();
          }
        }, provisionalWait);
        return;
      }

      // Note: deliberately do NOT unref the timer. close() may be the last referenced
      // work in the process (UDP/TCP transports unref their own sockets), and an unref'd
      // timer would let Node exit before the timeout fires — the force-close path and
      // the caller's close callback would never run.
      let timer = null;
      const timeoutPromise = new Promise(resolve => {
        timer = setTimeout(resolve, remaining);
      });

      // Defensive: if drainPromise is null while messagesInFlight > 0
      // (possible if a caller mutates messagesInFlight directly without going through
      // sendMessage — see close.js: the existing 'force close after 10 attempts' test
      // does exactly this), fall back to waiting on the timeout alone. We must NOT pass
      // `null` to Promise.race — non-thenables are treated as already-resolved and would
      // skip the wait entirely.
      const racers = this.drainPromise ?
        [this.drainPromise, timeoutPromise] :
        [timeoutPromise];

      Promise.race(racers).then(() => {
        if (timer) {
          clearTimeout(timer);
        }
        // Re-check: a new send may have started during this wait cycle.
        waitForDrain();
      });
    };

    waitForDrain();
  });
};

/**
 * Really close the socket and handle any errors related to it
 */
Client.prototype._close = function (callback) {
  // If there was an error creating it, nothing to do here
  if (! this.socket) {
    if (callback) {
      callback();
    }
    return;
  }

  // error function to use in callback and catch below
  let handledError = false;

  // Called explicitly from the synchronous catch path. The catch path is NOT a socket
  // 'error' emit, so existing socket listeners (e.g. parent's errorHandler on a shared
  // socket) do NOT fire. Always try every fallback here.
  const handleErr = (err) => {
    const errMessage = `Error closing hot-shots socket: ${err}`;
    if (handledError) {
      console.error(errMessage);
      return;
    }
    // The combination of catch and error can lead to some errors showing up twice.
    // So we just show one of the errors that occur on close.
    handledError = true;
    if (callback) {
      callback(new Error(errMessage));
    } else if (this.errorHandler) {
      try {
        this.errorHandler(new Error(errMessage));
      } catch (handlerErr) {
        // Preserve the original close error so the root cause is not masked by a buggy handler.
        console.error('hot-shots: errorHandler threw inside close handleErr; ' +
          `original error: ${errMessage}; handler error: ${handlerErr && handlerErr.message}`);
      }
    } else {
      console.error(errMessage);
    }
  };

  // Attached as a socket 'error' listener. Differs from handleErr in one place: when
  // this.errorHandler is the SAME function CURRENTLY attached as a socket listener
  // (typical for child clients that inherit the parent's handler), the socket emit
  // will already invoke it, so we must NOT call it again here. We track this with a
  // local flag — NOT the construction-time this._errorHandlerInitiallyOnSocket —
  // because non-child clients remove their errorHandler from the socket below,
  // which makes the construction-time flag stale during close.
  let errorHandlerOnSocketDuringClose = this._errorHandlerInitiallyOnSocket;
  const handleSocketErr = (err) => {
    const errMessage = `Error closing hot-shots socket: ${err}`;
    if (handledError) {
      console.error(errMessage);
      return;
    }
    handledError = true;
    if (callback) {
      callback(new Error(errMessage));
    } else if (this.errorHandler && !errorHandlerOnSocketDuringClose) {
      try {
        this.errorHandler(new Error(errMessage));
      } catch (handlerErr) {
        // Preserve the original close error so the root cause is not masked by a buggy handler.
        console.error('hot-shots: errorHandler threw inside close handleSocketErr; ' +
          `original error: ${errMessage}; handler error: ${handlerErr && handlerErr.message}`);
      }
    } else if (!this.errorHandler) {
      console.error(errMessage);
    }
    // else: errorHandler is on the socket; the emit already routed to it.
  };

  // Capability-checked listener helpers. Incomplete socket mocks in tests may not
  // implement on/removeListener — guard every call so an attempted cleanup never
  // becomes a separate TypeError that masks the real close failure.
  const safeOn = (event, fn) => {
    if (typeof this.socket.on === 'function') {
      this.socket.on(event, fn);
    }
  };
  const safeRemoveListener = (event, fn) => {
    if (typeof this.socket.removeListener === 'function') {
      this.socket.removeListener(event, fn);
    }
  };

  // For non-child clients we removed the user's errorHandler from the socket while
  // close runs (handleErr replaces it for the close-related events). Children share
  // the parent's socket and never attached their own errorHandler to it, so they
  // must NOT touch the parent's listeners — otherwise a child's close() can strip
  // the parent's error routing permanently.
  if (this.errorHandler && this.socket && !this.isChild) {
    // Only flip the flag if removeListener actually existed and ran. If the socket
    // is an incomplete mock without removeListener, safeRemoveListener is a no-op
    // and the original handler is still attached — leaving the flag at its initial
    // value preserves the double-delivery suppression in handleSocketErr.
    if (typeof this.socket.removeListener === 'function') {
      this.socket.removeListener('error', this.errorHandler);
      errorHandlerOnSocketDuringClose = false;
    }
  }

  // handle error and close events. Always attach a self-removing 'close' listener —
  // even when no caller callback was supplied — so we can remove handleSocketErr after
  // close completes. Without this cleanup, caller-owned streams (which outlive our
  // client) would accumulate handleSocketErr listeners every time a client is created
  // and closed against the same stream. (The transport interface does not expose
  // `once`, so we emulate one-shot semantics by removing the listener inside its own
  // handler.)
  //
  // handleSocketErr (not handleErr) is the listener: it knows when this.errorHandler
  // is the same function already on the socket (inherited child case) and skips the
  // redundant call. The async-emit path is critical for delivering errors to a
  // close callback, so we always attach this listener — regardless of whether the
  // errorHandler is inherited.
  safeOn('error', handleSocketErr);
  const onClose = (err) => {
    safeRemoveListener('close', onClose);
    safeRemoveListener('error', handleSocketErr);
    if (callback && ! handledError) {
      callback(err);
    }
  };
  safeOn('close', onClose);

  try {
    this.socket.close();
  } catch (err) {
    // Synchronous failure — the 'close' event will not fire, so onClose will not run.
    // Remove the temporary listeners we just attached so caller-owned streams don't
    // accumulate them across repeated client lifecycles or close retries.
    safeRemoveListener('close', onClose);
    safeRemoveListener('error', handleSocketErr);
    // The socket survived a failed close. Restore the user's errorHandler so future
    // 'error' events on it still reach their original handler — without this, a stream
    // that survives a synchronous close failure would lose its error routing entirely.
    // Skip for child clients (we never removed the parent's handler above).
    if (this.errorHandler && !this.isChild) {
      safeOn('error', this.errorHandler);
    }
    handleErr(err);
  }
};

const ChildClient = function (parent, options) {
  options = options || {};
  Client.call(this, {
    isChild     : true,
    socket      : parent.socket, // Child inherits socket from parent. Parent itself can be a child.
    // All children and parent share the same buffer via sharing an object (cannot mutate strings)
    bufferHolder: parent.bufferHolder,
    dnsError    : parent.dnsError, // Child inherits an error from parent (if it is there)
    errorHandler: options.errorHandler || parent.errorHandler, // Handler for callback errors
    // Carry forward whether THIS client's errorHandler is the same function attached
    // as the shared socket's 'error' listener. If we inherit (no options.errorHandler),
    // we share the parent's value: same fn → same socket-listener status. If we
    // override, the override is never on the socket → false. This propagates through
    // grandchildren correctly: a grandchild inheriting from a child that overrode
    // gets false (its handler is the child's override, not on the socket); a
    // grandchild inheriting from an inheriting child gets the root's value.
    _errorHandlerInitiallyOnSocket: options.errorHandler ?
      false :
      Boolean(parent._errorHandlerInitiallyOnSocket),
    host        : parent.host,
    port        : parent.port,
    tagPrefix   : parent.tagPrefix,
    tagSeparator : parent.tagSeparator,
    prefix      : helpers.normalizePrefix(options.prefix) + parent.prefix, // Child has its prefix prepended to parent's prefix
    suffix      : parent.suffix + helpers.normalizeSuffix(options.suffix), // Child has its suffix appended to parent's suffix
    globalize   : false, // Only 'root' client can be global
    mock        : parent.mock,
    // Append child's tags to parent's tags
    globalTags  : typeof options.globalTags === 'object' ?
        helpers.overrideTags(parent.globalTags, options.globalTags, parent.telegraf) : parent.globalTags,
    includeDataDogTags: parent.includeDataDogTags,
    maxBufferSize : parent.maxBufferSize,
    bufferFlushInterval: parent.bufferFlushInterval,
    telegraf    : parent.telegraf,
    protocol    : parent.protocol,
    closingFlushInterval : parent.closingFlushInterval,
    // Child inherits telemetry from parent (for metric tracking)
    telemetry   : parent.telemetry
  });
};
util.inherits(ChildClient, Client);

/**
 * Creates a child client that adds prefix, suffix and/or tags to this client. Child client can itself have children.
 * @param options
 *   @option prefix      {String}  An optional prefix to assign to each stat name sent
 *   @option suffix      {String}  An optional suffix to assign to each stat name sent
 *   @option globalTags {Array=} Optional tags that will be added to every metric
 */
Client.prototype.childClient = function (options) {
  return new ChildClient(this, options);
};

exports = module.exports = Client;
exports.StatsD = Client;

/**
 * Detect and handle an error connecting to a TCP/UDS socket. This will
 * attempt to create a new socket and replace and close the client's current
 * socket, registering a **new** `protocolErrorHandler()` on the newly created socket.
 * If a new socket can't be created (e.g. if no TCP/UDS currently exists at
 * `client.path`) then this will leave the existing socket intact.
 *
 * Note that this will no-op with an early exit if the last socket create time
 * was too recent (within the TCP/UDS graceful restart rate limit).
 * @param client Client The statsd Client that may be getting a TCP/UDS error handler.
 * @param protocol Client configured protocol
 * @param err The error that we will handle if a TCP/UDS connection error is detected.
 */
function protocolErrorHandler(client, protocol, err) {
  if (!err || !client.socket || !client.socket.createdAt) {
    return;
  }

  // recreate the socket, but only once within `tcpGracefulRestartRateLimit`/`udsGracefulRestartRateLimit`.

  if (protocol === PROTOCOL.TCP && (!TCP_ERROR_CODES.includes(err.code) || Date.now() - client.socket.createdAt < client.tcpGracefulRestartRateLimit)) {
    return;
  } else if (protocol === PROTOCOL.UDS && (!UDS_ERROR_CODES.includes(err.code) || Date.now() - client.socket.createdAt < client.udsGracefulRestartRateLimit)) {
    return;
  }

  if (client.errorHandler && client.socket) {
    client.socket.removeListener('error', client.errorHandler);
  }

  const newSocket = createTransport(client, {
    host: client.host,
    path: client.path,
    udsRetryOptions: client.udsRetryOptions,
    port: client.port,
    protocol: client.protocol,
  });
  if (newSocket) {
    client.socket.close();
    client.socket = newSocket;
    maybeAddProtocolErrorHandler(client, protocol);
  } else {
    const errorMessage = `Could not replace ${protocol} connection with new socket`;
    if (client.errorHandler) {
      client.errorHandler(new Error(errorMessage));
    } else {
      console.error(errorMessage);
    }
    return;
  }

  if (client.errorHandler) {
    client.socket.on('error', client.errorHandler);
  } else {
    client.socket.on('error', (error) => console.error(`hot-shots ${protocol} error: ${error}`));
  }
}

/**
 * Add a TCP/UDS socket error handler to the client's socket, if the
 * client is not a "child" client and has graceful error handling enabled for
 * TCP/UDS.
 * @param client Client The statsd Client that may be getting a TCP/UDS error handler.
 * @param protocol Client configured protocol
 */
 function maybeAddProtocolErrorHandler(client, protocol) {
  if (client.isChild) {
    return;
  }

  if ((protocol === PROTOCOL.TCP && !client.tcpGracefulErrorHandling) || (protocol === PROTOCOL.UDS && !client.udsGracefulErrorHandling)) {
    return;
  }

  if (protocol === PROTOCOL.TCP || protocol === PROTOCOL.UDS) {
    client.socket.on('error', (err) => {
      protocolErrorHandler(client, protocol, err);
    });
  }
}

/**
 * Try to replace a client's socket with a new transport. If `createTransport()`
 * returns `null` this will still set the client's socket to `null`. This also
 * updates the socket creation time for UDS error handling.
 * @param client Client The statsd Client that will be getting a new socket
 */
function trySetNewSocket(client) {
  client.socket = createTransport(client, {
    host: client.host,
    cacheDns: client.cacheDns,
    cacheDnsTtl: client.cacheDnsTtl,
    path: client.path,
    udsRetryOptions: client.udsRetryOptions,
    port: client.port,
    protocol: client.protocol,
    stream: client.stream,
    udpSocketOptions: client.udpSocketOptions,
    mock: client.mock,
  });
}
