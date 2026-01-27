const assert = require('assert');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const os = require('os');
const util = require('util');
const { PROTOCOL } = require('./constants');

const debug = util.debuglog('hot-shots');

// Imported below, only if needed
let unixDgram;

const UDS_PATH_DEFAULT = '/var/run/datadog/dsd.socket';

/**
 * Ensures a buffer ends with a newline character for line-based protocols.
 * @param {Buffer} buf - The buffer to check and modify
 * @returns {string} The buffer content as a string with newline appended if needed
 */
const addEol = (buf) => {
  let msg = buf.toString();
  if (msg.length > 0 && msg[msg.length - 1] !== '\n') {
    msg += '\n';
  }
  return msg;
};

// interface Transport {
//   emit(name: string, payload: any):void;
//   on(name: string, listener: Function):void;
//   removeListener(name: string, listener: Function):void;
//   send(buf: Buffer, callback: Function):void;
//   close():void;
//   unref(): void;
// }
/**
 * Creates a TCP transport for persistent connection-based metric delivery.
 * Automatically adds newlines to messages and maintains keep-alive connection.
 * @param {Object} args - Configuration options including host and port
 * @returns {Transport} A transport object implementing the Transport interface
 */
const createTcpTransport = args => {
  debug('hot-shots createTcpTransport: connecting to %s:%s', args.host, args.port);
  const socket = net.connect(args.port, args.host);
  socket.setKeepAlive(true);
  // do not block node from shutting down
  socket.unref();
  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: (buf, callback) => {
      debug('hot-shots createTcpTransport: sending %d bytes to %s:%s', Buffer.byteLength(buf), args.host, args.port);
      // Check if socket is destroyed before attempting to write
      // This prevents ERR_STREAM_DESTROYED and "socket ended" errors (issue #247)
      if (socket.destroyed) {
        const err = new Error('Socket is destroyed');
        err.code = 'ERR_SOCKET_DESTROYED';
        debug('hot-shots createTcpTransport: socket destroyed, skipping send');
        if (callback) {
          callback(err);
        }
        return;
      }
      socket.write(addEol(buf), 'ascii', (err) => {
        if (err) {
          debug('hot-shots createTcpTransport: send error - %s', err.message);
        } else {
          debug('hot-shots createTcpTransport: send successful');
        }
        if (callback) {
          callback(err);
        }
      });
    },
    close: () => {
      debug('hot-shots createTcpTransport: closing connection');
      socket.destroy();
    },
    unref: socket.unref.bind(socket)

  };
};

/**
 * Creates a UDP transport for connectionless metric delivery with optional DNS caching.
 * Optimizes for IP addresses to avoid unnecessary DNS lookups and APM instrumentation overhead.
 * Auto-detects IPv6 addresses and uses the appropriate socket type (udp4 or udp6).
 * @param {Object} args - Configuration options including host, port, cacheDns, cacheDnsTtl, and udpSocketOptions
 * @returns {Transport} A transport object implementing the Transport interface
 */
const createUdpTransport = args => {
  debug('hot-shots createUdpTransport: creating socket for %s:%s (cacheDns=%s)', args.host, args.port, args.cacheDns);

  // Optimize for IP addresses to avoid unnecessary dns.lookup calls
  // This prevents APM tools from instrumenting dns.lookup for IP addresses
  const socketOptions = Object.assign({}, args.udpSocketOptions);

  // Auto-detect socket type based on host IP version if not explicitly set
  // This fixes issues on Node.js 17+ where localhost may resolve to ::1 (IPv6)
  const ipVersion = args.host ? net.isIP(args.host) : 0;
  if (ipVersion && !socketOptions.type) {
    socketOptions.type = ipVersion === 6 ? 'udp6' : 'udp4';
    debug('hot-shots createUdpTransport: auto-detected socket type %s for IP version %d', socketOptions.type, ipVersion);
  } else if (!socketOptions.type) {
    // Default to udp4 for hostnames when no type is specified
    socketOptions.type = 'udp4';
  }

  if (!socketOptions.lookup && ipVersion) {
    debug('hot-shots createUdpTransport: detected IP address (v%d), using optimized lookup', ipVersion);
    socketOptions.lookup = (hostname, options, callback) => {
      // Handle both lookup(hostname, callback) and lookup(hostname, options, callback) signatures
      if (typeof options === 'function') {
        callback = options;
      }
      // Bypass dns.lookup for IP addresses to avoid APM instrumentation overhead
      callback(null, hostname, ipVersion);
    };
  }

  const socket = dgram.createSocket(socketOptions);
  // do not block node from shutting down
  socket.unref();

  const dnsResolutionData = {
    timestamp: new Date(0),
    resolvedAddress: undefined
  };

  /**
   * Sends a buffer to the UDP socket at the specified address with error handling.
   * @param {Buffer} buf - The data buffer to send
   * @param {string} address - The resolved IP address to send to
   * @param {Function} callback - Callback function to invoke after send completes
   */
  const sendToSocket = (buf, address, callback) => {
    try {
      debug('hot-shots UDP transport: sending %d bytes to %s:%s', Buffer.byteLength(buf), address, args.port);
      socket.send(buf, 0, buf.length, args.port, address, (err) => {
        if (err) {
          debug('hot-shots UDP transport: send error - %s', err.message);
        } else {
          debug('hot-shots UDP transport: send successful (note: UDP does not guarantee delivery)');
        }
        if (callback) {
          callback(err);
        }
      });
    } catch (socketError) {
      debug('hot-shots UDP transport: send exception - %s', socketError.message);
      if (callback) {
        callback(socketError);
      }
    }
  };

  /**
   * Sends data using cached DNS resolution to avoid repeated lookups.
   * Caches resolved addresses for the configured TTL duration.
   * @param {Function} callback - Callback function to invoke after send completes
   * @param {Buffer} buf - The data buffer to send
   */
  const sendUsingDnsCache = (callback, buf) => {
    const now = Date.now();
    if (dnsResolutionData.resolvedAddress === undefined || (now - dnsResolutionData.timestamp > args.cacheDnsTtl)) {
      debug('hot-shots UDP transport: performing DNS lookup for %s', args.host);

      // Optimize: if host is already an IP, skip dns.lookup
      const hostIpVersion = net.isIP(args.host);
      if (hostIpVersion) {
        debug('hot-shots UDP transport: host is already an IP address (v%d), skipping DNS lookup', hostIpVersion);
        dnsResolutionData.resolvedAddress = args.host;
        dnsResolutionData.timestamp = now;
        sendToSocket(buf, dnsResolutionData.resolvedAddress, callback);
        return;
      }

      dns.lookup(args.host, (error, address) => {
        if (error) {
          debug('hot-shots UDP transport: DNS lookup error - %s', error.message);
          callback(error);
          return;
        }
        debug('hot-shots UDP transport: DNS resolved %s to %s', args.host, address);
        dnsResolutionData.resolvedAddress = address;
        dnsResolutionData.timestamp = now;
        sendToSocket(buf, dnsResolutionData.resolvedAddress, callback);
      });
    } else {
      debug('hot-shots UDP transport: using cached DNS address %s', dnsResolutionData.resolvedAddress);
      sendToSocket(buf, dnsResolutionData.resolvedAddress, callback);
    }
  };

  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: function (buf, callback) {
      if (args.cacheDns) {
        sendUsingDnsCache(callback, buf);
      } else {
        try {
          debug('hot-shots UDP transport: sending %d bytes to %s:%s (no DNS cache)', Buffer.byteLength(buf), args.host, args.port);
          socket.send(buf, 0, buf.length, args.port, args.host, (err) => {
            if (err) {
              debug('hot-shots UDP transport: send error - %s', err.message);
            } else {
              debug('hot-shots UDP transport: send successful (note: UDP does not guarantee delivery)');
            }
            if (callback) {
              callback(err);
            }
          });
        } catch (socketError) {
          debug('hot-shots UDP transport: send exception - %s', socketError.message);
          callback(socketError);
        }
      }
    },
    close: () => {
      debug('hot-shots UDP transport: closing socket');
      socket.close();
    },
    unref: socket.unref.bind(socket)
  };
};

/**
 * Creates a Unix Domain Socket (UDS) transport for local IPC metric delivery.
 * Implements automatic retry logic with exponential backoff for EAGAIN and congestion errors.
 * Requires the optional unix-dgram dependency to be installed.
 * @param {Object} args - Configuration options including path and udsRetryOptions
 * @returns {Transport} A transport object implementing the Transport interface
 */
const createUdsTransport = args => {
  try {
    // This will not always be available, as noted in the error message below
    unixDgram = require('unix-dgram'); // eslint-disable-line global-require
  } catch (err) {
    throw new Error(
      'The library `unix_dgram`, needed for the uds protocol to work, is not installed. ' +
      'You need to pick another protocol to use hot-shots. ' +
      'See the hot-shots README for additional details.'
    );
  }
  // Only retry-related options live here now
  const udsOpts = args.udsRetryOptions || {};
  const udsPath = args.path ? args.path : UDS_PATH_DEFAULT;
  debug('hot-shots createUdsTransport: connecting to %s', udsPath);
  const socket = unixDgram.createSocket('unix_dgram');

  try {
    socket.connect(udsPath);
    debug('hot-shots createUdsTransport: connected successfully');
  } catch (err) {
    debug('hot-shots createUdsTransport: connection failed - %s', err.message);
    socket.close();
    throw err;
  }

  // Retry configuration with defaults (milliseconds)
  const maxRetries = (udsOpts.retries === undefined || udsOpts.retries === null) ? 3 : udsOpts.retries;
  const initialDelayMs = (udsOpts.retryDelayMs === undefined || udsOpts.retryDelayMs === null) ? 100 : udsOpts.retryDelayMs;
  const maxDelayMs = (udsOpts.maxRetryDelayMs === undefined || udsOpts.maxRetryDelayMs === null) ? 1000 : udsOpts.maxRetryDelayMs;
  const backoffFactor = (udsOpts.backoffFactor === undefined || udsOpts.backoffFactor === null) ? 2 : udsOpts.backoffFactor;
  const EAGAIN = os.constants && os.constants.errno && os.constants.errno.EAGAIN;

  /**
   * Checks if an error is an EAGAIN error (resource temporarily unavailable).
   * @param {Error} err - The error to check
   * @returns {boolean} True if the error is EAGAIN
   */
  const isEagain = (err) => {
    if (!err) {
      return false;
    }
    if (err.code === 'EAGAIN') {
      return true;
    }
    return typeof err.errno === 'number' && typeof EAGAIN === 'number' && err.errno === EAGAIN;
  };

  /**
   * Checks if an error is a congestion error from unix-dgram.
   * unix-dgram returns an internal 'congestion' error (err === 1) via callback.
   * @param {Error} err - The error to check
   * @returns {boolean} True if the error is a congestion error
   */
  const isCongestion = (err) => {
    if (!err) {
      return false;
    }
    if (err.code === 'congestion' || err.message === 'congestion') {
      return true;
    }
    // Some builds may expose the sentinel as errno===1
    return err.errno === 1;
  };

  /**
   * Checks if an error is retryable for UDS transport (EAGAIN or congestion).
   * @param {Error} err - The error to check
   * @returns {boolean} True if the error should be retried
   */
  const isRetryableUdsError = (err) => isEagain(err) || isCongestion(err);

  /**
   * Sends data to UDS socket with automatic retry logic using exponential backoff.
   * Retries on EAGAIN and congestion errors up to the configured maximum retry count.
   * @param {Buffer} buf - The data buffer to send
   * @param {Function} callback - Callback function to invoke after send completes or fails
   * @param {number} attempt - Current retry attempt number (default: 0)
   */
  const sendWithRetry = (buf, callback, attempt = 0) => {
    if (attempt === 0) {
      debug('hot-shots UDS transport: sending %d bytes', buf.length);
    } else {
      debug('hot-shots UDS transport: retry attempt %d/%d', attempt, maxRetries);
    }
    socket.send(buf, (err) => {
      if (err && isRetryableUdsError(err) && attempt < maxRetries) {
        const delay = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt), maxDelayMs);
        debug('hot-shots UDS transport: retryable error (%s), retrying after %dms', err.message || err.code || err, delay);
        setTimeout(() => sendWithRetry(buf, callback, attempt + 1), delay);
      } else if (err) {
        debug('hot-shots UDS transport: send error - %s (attempts: %d)', err.message || err.code || err, attempt + 1);
        if (typeof callback === 'function') {
          callback(err);
        }
      } else {
        debug('hot-shots UDS transport: send successful (attempts: %d)', attempt + 1);
        if (typeof callback === 'function') {
          callback(err);
        }
      }
    });
  };

  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: sendWithRetry,
    close: () => {
      socket.close();
      // close is synchronous, and the socket will not emit a
      // close event, hence emulating standard behaviour by doing this:
      socket.emit('close');
    },
    unref: () => {
      throw new Error('unix-dgram does not implement unref for sockets');
    }
  };
};

/**
 * Creates a stream transport using a provided raw stream for metric delivery.
 * Automatically adds newlines to messages. Useful for custom transport implementations.
 * @param {Object} args - Configuration options, must include a stream property
 * @returns {Transport} A transport object implementing the Transport interface
 */
const createStreamTransport = (args) => {
  const stream = args.stream;
  assert(stream, '`stream` option required');
  debug('hot-shots createStreamTransport: using provided stream');

  return {
    emit: stream.emit.bind(stream),
    on: stream.on.bind(stream),
    removeListener: stream.removeListener.bind(stream),
    send: (buf, callback) => {
      debug('hot-shots stream transport: sending %d bytes', buf.length);
      // Check if stream is destroyed before attempting to write
      // This prevents ERR_STREAM_DESTROYED errors (issue #247)
      if (stream.destroyed) {
        const err = new Error('Stream is destroyed');
        err.code = 'ERR_STREAM_DESTROYED';
        debug('hot-shots stream transport: stream destroyed, skipping send');
        if (callback) {
          callback(err);
        }
        return;
      }
      stream.write(addEol(buf), (err) => {
        if (err) {
          debug('hot-shots stream transport: send error - %s', err.message);
        } else {
          debug('hot-shots stream transport: send successful');
        }
        if (callback) {
          callback(err);
        }
      });
    },
    close: () => {
      debug('hot-shots stream transport: closing stream');
      stream.destroy();

      // Node v8 doesn't fire `close` event on stream destroy.
      if (process.version.split('.').shift() === 'v8') {
        stream.emit('close');
      }
    },
    unref: () => {
      throw new Error('stream transport does not support unref');
    }
  };
};

/**
 * Creates a mock transport that doesn't create actual sockets.
 * Used when mock mode is enabled to avoid unnecessary socket creation and connection attempts.
 * @returns {Transport} A mock transport object implementing the Transport interface
 */
const createMockTransport = () => {
  debug('hot-shots createMockTransport: creating mock transport (no actual socket)');
  const listeners = {};
  const mockSocket = {
    emit: (event, ...args) => {
      debug('hot-shots mock transport: emit called for event=%s', event);
      if (listeners[event]) {
        listeners[event].forEach(listener => listener(...args));
      }
    },
    on: (event, listener) => {
      debug('hot-shots mock transport: on called for event=%s', event);
      if (!listeners[event]) {
        listeners[event] = [];
      }
      listeners[event].push(listener);
    },
    removeListener: (event, listener) => {
      debug('hot-shots mock transport: removeListener called for event=%s', event);
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(l => l !== listener);
      }
    },
    send: (buf, callback) => {
      debug('hot-shots mock transport: send called with %d bytes', buf.length);
      if (typeof callback === 'function') {
        callback(null, buf.length);
      }
    },
    close: () => {
      debug('hot-shots mock transport: close called');
      // Emit close event asynchronously to match real socket behavior
      setImmediate(() => {
        mockSocket.emit('close');
      });
    },
    unref: () => {
      debug('hot-shots mock transport: unref called');
    }
  };
  return mockSocket;
};

/**
 * Factory function that creates the appropriate transport based on the protocol specified in args.
 * Handles errors by invoking the instance's errorHandler or logging to console.
 * @param {Object} instance - The StatsD client instance
 * @param {Object} args - Configuration options including protocol, host, port, and protocol-specific options
 * @returns {Transport|null} A transport object with a type property, or null if creation failed
 */
module.exports = (instance, args) => {
  let transport = null;
  const protocol = args.protocol || PROTOCOL.UDP;

  try {
    if (args.mock) {
      // In mock mode, create a mock transport that doesn't create actual sockets
      transport = createMockTransport(args);
      transport.type = 'mock';
    } else if (protocol === PROTOCOL.TCP) {
      transport = createTcpTransport(args);
      transport.type = protocol;
    } else if (protocol === PROTOCOL.UDS) {
      transport = createUdsTransport(args);
      transport.type = protocol;
    } else if (protocol === PROTOCOL.UDP) {
      transport = createUdpTransport(args);
      transport.type = protocol;
    } else if (protocol === PROTOCOL.STREAM) {
      transport = createStreamTransport(args);
      transport.type = protocol;
    } else {
      throw new Error(`Unsupported protocol '${protocol}'`);
    }
    transport.createdAt = Date.now();
  } catch (e) {
    if (instance.errorHandler) {
      instance.errorHandler(e);
    } else {
      console.error(e);
    }
  }

  return transport;
};
