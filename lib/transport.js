const assert = require('assert');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const os = require('os');
const util = require('util');
const { DNS_CANCELLED_CODE, DNS_CLOSED_CODE, DNS_COOLDOWN_CODE, DNS_MAX_PENDING, DNS_QUEUE_FULL_CODE,
  MAX_PENDING_WRITE_BYTES, PROTOCOL, WRITE_QUEUE_FULL_CODE, dnsQueueClosedMessage } = require('./constants');

const debug = util.debuglog('hot-shots');

/**
 * Invokes a send callback with a failure on a later tick.
 *
 * Every transport has at least one path that fails a send without attempting any
 * I/O: a destroyed socket, a refused write, a synchronous throw. Calling back
 * from those paths directly would run the callback on the same stack frame as
 * the send. That matters because the documented errorHandler pattern is to emit
 * a metric on failure, and a resend down an always-fails path re-enters the same
 * code with no terminating condition - the stack grows by a constant per resend
 * until the process throws RangeError or simply wedges.
 *
 * The invariant this maintains: a send failure never calls back on the same
 * stack frame as the send. Real I/O errors already satisfy it by arriving from
 * the event loop, so only the synchronous paths need this helper.
 *
 * Batched into a single immediate per tick, and the Error is built from a factory
 * only when the callback runs. A burst against a stalled transport can refuse
 * hundreds of thousands of sends in one tick; one immediate plus one
 * stack-capturing Error apiece would cost far more memory than the socket
 * backlog this exists to bound.
 *
 * Draining swaps the queue out first, so a callback that resends and fails again
 * lands in a fresh queue scheduled for the next tick rather than extending this
 * drain - each generation stays on its own tick, which is what keeps the whole
 * thing from becoming the recursion it is meant to prevent.
 * @param {Function} [callback] - the send callback, if any
 * @param {Function} createError - builds the Error, called on the later tick
 * @returns {void}
 */
const pendingFailures = [];

/**
 * Calls back every failure queued since the last drain.
 * @returns {void}
 */
const drainPendingFailures = () => {
  const batch = pendingFailures.splice(0, pendingFailures.length);
  for (let i = 0; i < batch.length; i++) {
    batch[i].callback(batch[i].createError());
  }
};

const failLater = (callback, createError) => {
  if (!callback) {
    return;
  }
  if (pendingFailures.length === 0) {
    setImmediate(drainPendingFailures);
  }
  pendingFailures.push({ callback: callback, createError: createError });
};

/**
 * Builds a factory for the error reporting a send refused because the transport
 * already has MAX_PENDING_WRITE_BYTES sitting unflushed in its socket.
 * @param {string} label - transport name, for the message
 * @param {number} buffered - unflushed byte count at the time of the refusal
 * @returns {Function} a factory returning the coded backpressure error
 */
const writeQueueFullError = (label, buffered) => () => {
  const error = new Error(`hot-shots: dropped metric, the ${label} socket already has ${buffered} bytes ` +
    `waiting to flush (limit ${MAX_PENDING_WRITE_BYTES})`);
  error.code = WRITE_QUEUE_FULL_CODE;
  return error;
};

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

/**
 * Attach a default no-op debug listener for 'error' events so that an emit with no
 * user-supplied listener does not crash the host process.
 * @param {EventEmitter} socket
 * @param {string} label
 * @returns {Function|null} the attached listener, or null if none was attached
 */
const attachDefaultErrorListener = (socket, label) => {
  if (socket && typeof socket.on === 'function') {
    const listener = (err) => {
      debug('hot-shots %s default error listener: %s', label, err && err.message ? err.message : err);
    };
    socket.on('error', listener);
    return listener;
  }
  return null;
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
  attachDefaultErrorListener(socket, 'tcp');
  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: (buf, callback) => {
      debug('hot-shots createTcpTransport: sending %d bytes to %s:%s', Buffer.byteLength(buf), args.host, args.port);
      // Check if socket is destroyed before attempting to write
      // This prevents ERR_STREAM_DESTROYED and "socket ended" errors (issue #247)
      if (socket.destroyed) {
        debug('hot-shots createTcpTransport: socket destroyed, skipping send');
        // Deferred: this path always fails, so a resending errorHandler would
        // otherwise recurse on this stack frame. See failLater.
        failLater(callback, () => {
          const err = new Error('Socket is destroyed');
          err.code = 'ERR_SOCKET_DESTROYED';
          return err;
        });
        return;
      }
      // Node queues writes without bound while the socket is still connecting or
      // its peer has stopped reading, so an unreachable host turns every metric
      // into retained memory. Refuse once too much is already waiting.
      if (socket.writableLength > MAX_PENDING_WRITE_BYTES) {
        debug('hot-shots createTcpTransport: %d bytes already unflushed, dropping metric', socket.writableLength);
        failLater(callback, writeQueueFullError('tcp', socket.writableLength));
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
      if (socket.destroyed) {
        // destroy() is a no-op on an already-destroyed socket and will not emit
        // 'close' a second time, so Client._close would wait on an event that
        // never arrives. Emulate it, matching what the uds and mock transports
        // already do. Deferred rather than synchronous so the close callback
        // never fires on this stack frame, the same rule sends follow.
        debug('hot-shots createTcpTransport: socket already destroyed, emulating close');
        setImmediate(() => socket.emit('close'));
        return;
      }
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

  // Bypass dns.lookup for IP literals. Node calls the socket's lookup before
  // every packet, and although dns.lookup short-circuits an IP without hitting
  // a resolver, it still creates an instrumented async operation that APM tools
  // report as a span. This is installed even when args.host is a hostname,
  // because Node also routes the default address and any address resolved by
  // the cacheDns path through here.
  if (!socketOptions.lookup) {
    debug('hot-shots createUdpTransport: installing IP-bypass lookup');
    socketOptions.lookup = (hostname, options, callback) => {
      // Handle both lookup(hostname, callback) and lookup(hostname, options, callback)
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const version = net.isIP(hostname);
      if (version) {
        callback(null, hostname, version);
        return;
      }
      dns.lookup(hostname, options, callback);
    };
  }

  const socket = dgram.createSocket(socketOptions);
  // do not block node from shutting down
  socket.unref();
  const defaultErrorListener = attachDefaultErrorListener(socket, 'udp');

  const dnsResolutionData = {
    // When the address was last resolved successfully; drives staleness.
    timestamp: 0,
    resolvedAddress: undefined,
    refreshInFlight: false,
    consecutiveFailures: 0,
    // When the last lookup failed, or null if the last one succeeded. A failure
    // earns a full cacheDnsTtl of cooldown before the next attempt: without it a
    // fast-failing resolver (cached NXDOMAIN, SERVFAIL) degrades to one lookup
    // per send, the per-packet behavior this work exists to eliminate. The trade
    // is that recovery is noticed up to one TTL late.
    failureTimestamp: null,
    pending: [],
    // Latched true once cancelPendingSends runs, for the rest of this
    // transport's life. A cancelled callback can call send() again (e.g. an
    // errorHandler that emits a metric); without the latch that entry lands back
    // in `pending`, which nothing will ever cancel or flush again. Latching
    // makes every later send fail instead of re-queueing, so each callback stays
    // at exactly one invocation.
    cancelled: false
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
      // dgram throws synchronously once the socket is closed. Deferred so a
      // resending errorHandler cannot recurse on this stack frame; see failLater.
      debug('hot-shots UDP transport: send exception - %s', socketError.message);
      failLater(callback, () => socketError);
    }
  };

  /**
   * Reports whether a user-supplied 'error' listener is attached, as opposed to
   * only the default debug listener installed by this transport.
   * @returns {boolean} true if a user listener is present
   */
  const hasUserErrorListener = () => {
    if (typeof socket.listeners !== 'function') {
      return false;
    }
    return socket.listeners('error').some(listener => listener !== defaultErrorListener);
  };

  /**
   * Reports a failed background DNS refresh. Sends keep working on the stale
   * address, so there is no send callback to carry this error. Reported once per
   * contiguous failure streak so a flapping resolver does not emit every TTL.
   * @param {Error} error - the lookup error
   */
  const reportRefreshFailure = (error) => {
    if (dnsResolutionData.consecutiveFailures === 0) {
      socket.emit('error', error);
      if (!hasUserErrorListener()) {
        console.error(`hot-shots: DNS refresh for ${args.host} failed, ` +
          `continuing with cached address ${dnsResolutionData.resolvedAddress}: ` +
          `${error && error.message}`);
      }
    }
    dnsResolutionData.consecutiveFailures++;
  };

  /**
   * Flushes queued sends. On success each queued buffer is sent to the resolved
   * address; on failure each queued callback receives the error. Every entry is
   * always called back exactly once, which the client's drain logic depends on.
   * @param {Error|null} error - lookup error, or null on success
   * @param {string} [address] - the resolved address when error is null
   */
  const flushPending = (error, address) => {
    const pending = dnsResolutionData.pending;
    dnsResolutionData.pending = [];
    pending.forEach(entry => {
      if (error) {
        if (entry.callback) {
          entry.callback(error);
        }
        return;
      }
      sendToSocket(entry.buf, address, entry.callback);
    });
  };

  /**
   * Reports whether the last lookup failed recently enough that another attempt
   * should wait. Callers must check this (and refreshInFlight) before starting a
   * lookup. See failureTimestamp for why the cooldown exists.
   * @returns {boolean} true while the cooldown is in effect
   */
  const isCoolingDown = () => dnsResolutionData.failureTimestamp !== null &&
    Date.now() - dnsResolutionData.failureTimestamp <= args.cacheDnsTtl;

  /**
   * Starts a single DNS lookup for args.host. Only one runs at a time; callers
   * must check refreshInFlight and isCoolingDown before calling.
   */
  const startLookup = () => {
    dnsResolutionData.refreshInFlight = true;
    const isRefresh = dnsResolutionData.resolvedAddress !== undefined;
    debug('hot-shots UDP transport: performing DNS lookup for %s (refresh=%s)', args.host, isRefresh);

    try {
      dns.lookup(args.host, (error, address) => {
        dnsResolutionData.refreshInFlight = false;

        // A result that arrives after cancellation has nothing left to do:
        // cancelPendingSends already flushed the queue and sendUsingDnsCache now
        // rejects every send. Setting resolvedAddress anyway would reopen the
        // warm send path against a socket _close() may have already closed,
        // whose synchronous throw is the recursion hazard the latch prevents.
        if (dnsResolutionData.cancelled) {
          debug('hot-shots UDP transport: DNS result arrived after cancellation, ignoring');
          return;
        }

        if (error) {
          debug('hot-shots UDP transport: DNS lookup error - %s', error.message);
          dnsResolutionData.failureTimestamp = Date.now();
          if (isRefresh) {
            reportRefreshFailure(error);
          } else {
            flushPending(error);
          }
          return;
        }

        debug('hot-shots UDP transport: DNS resolved %s to %s', args.host, address);
        dnsResolutionData.resolvedAddress = address;
        dnsResolutionData.timestamp = Date.now();
        dnsResolutionData.failureTimestamp = null;
        dnsResolutionData.consecutiveFailures = 0;
        flushPending(null, address);
      });
    } catch (lookupError) {
      // dns.lookup throws synchronously for some invalid inputs (e.g. a
      // non-string host) instead of calling back. Without this, refreshInFlight
      // would stay true forever and a queued entry would never be flushed.
      debug('hot-shots UDP transport: DNS lookup threw - %s', lookupError && lookupError.message);
      dnsResolutionData.refreshInFlight = false;
      dnsResolutionData.failureTimestamp = Date.now();
      if (isRefresh) {
        // Safe to report synchronously: the warm path queues nothing, so there
        // are no send callbacks here, and a resending errorHandler is turned
        // away by the cooldown rather than starting another throwing lookup.
        reportRefreshFailure(lookupError);
      } else {
        // Deferred, unlike the asynchronous failure branch above, which already
        // runs on a fresh tick. Flushing here would invoke send callbacks on
        // this stack frame, and a callback that resends (the documented "emit a
        // metric on send failure" errorHandler) would re-enter startLookup,
        // throw again, and recurse without bound until the process wedges.
        setImmediate(() => flushPending(lookupError));
      }
    }
  };

  /**
   * Sends data using cached DNS resolution. Concurrent cold-start sends share a
   * single lookup, and a send past the TTL goes out immediately on the stale
   * address while one refresh runs in the background.
   * @param {Function} callback - Callback function to invoke after send completes
   * @param {Buffer} buf - The data buffer to send
   */
  const sendUsingDnsCache = (callback, buf) => {
    // Nothing to resolve: an IP literal, or no host at all (Node picks the
    // loopback default, which the socket's bypass lookup then short-circuits).
    if (!args.host || net.isIP(args.host)) {
      debug('hot-shots UDP transport: host needs no resolution, sending directly');
      sendToSocket(buf, args.host, callback);
      return;
    }

    // Checked BEFORE the resolvedAddress branch below, not just before the cold
    // path: a lookup still in flight when close() cancelled can resolve
    // afterwards, and routing a later send down the warm branch would reach a
    // socket _close() may have already closed, whose synchronous throw feeds a
    // resending errorHandler on this stack frame. Once latched, no send reaches
    // sendToSocket again.
    if (dnsResolutionData.cancelled) {
      // Deferred for the same reason every other always-fails path here is: a
      // callback that resends would otherwise re-enter this function on the same
      // stack frame and recurse without bound.
      debug('hot-shots UDP transport: send arrived after DNS cancellation, failing on a later tick');
      if (callback) {
        setImmediate(() => {
          const error = new Error(dnsQueueClosedMessage(args.host));
          // Arrived after the queue was latched shut, as opposed to the entries
          // cancelled mid-lookup by cancelPendingSends, which keep
          // DNS_CANCELLED_CODE.
          error.code = DNS_CLOSED_CODE;
          callback(error);
        });
      }
      return;
    }

    if (dnsResolutionData.resolvedAddress !== undefined) {
      sendToSocket(buf, dnsResolutionData.resolvedAddress, callback);
      const isStale = Date.now() - dnsResolutionData.timestamp > args.cacheDnsTtl;
      if (isStale && !dnsResolutionData.refreshInFlight && !isCoolingDown()) {
        startLookup();
      }
      return;
    }

    // Cold start with no lookup to wait behind and a recent failure: there is no
    // address to send to and starting another lookup is what the cooldown exists
    // to prevent, so fail the send rather than queueing it for a flush that
    // nothing would trigger. Deferred, as above, so a resending callback cannot
    // recurse on this stack frame.
    if (!dnsResolutionData.refreshInFlight && isCoolingDown()) {
      debug('hot-shots UDP transport: dropping send, DNS lookup for %s is in cooldown', args.host);
      if (callback) {
        setImmediate(() => {
          const error = new Error(`hot-shots: dropped metric, the DNS lookup for ${args.host} ` +
            'recently failed and the next attempt is not due yet');
          error.code = DNS_COOLDOWN_CODE;
          callback(error);
        });
      }
      return;
    }

    // Push first, then trim to the cap, and only invoke the dropped entries'
    // callbacks once the queue is back at or below it. A drop callback can
    // resend synchronously; had a callback fired while the queue was still under
    // the cap (shift-then-push), that resend would see room and not drop, and
    // the outer push would land on top of it, growing the queue by one per send.
    dnsResolutionData.pending.push({ buf: buf, callback: callback });
    const overflow = [];
    while (dnsResolutionData.pending.length > DNS_MAX_PENDING) {
      overflow.push(dnsResolutionData.pending.shift());
    }

    if (!dnsResolutionData.refreshInFlight) {
      startLookup();
    }

    if (overflow.length > 0) {
      debug('hot-shots UDP transport: pending DNS queue full, dropping %d oldest send(s)', overflow.length);
      // Defer the drop callbacks to a fresh tick instead of invoking them
      // synchronously here. The entries are already spliced out of `pending`
      // above, so the queue is already back at the cap regardless of when
      // these callbacks run - deferring only breaks the call stack, it does
      // not change what gets dropped. Without this, a drop callback that
      // synchronously calls send() again (e.g. an errorHandler that emits a
      // metric) would re-enter this function while still on this stack frame,
      // immediately overflow again, and invoke another drop callback in the
      // same call stack - recursing without bound against a hung resolver
      // until a RangeError (stack overflow) or a wedged process.
      setImmediate(() => {
        overflow.forEach(entry => {
          if (entry.callback) {
            const dropError = new Error(
              `hot-shots: dropped metric while resolving ${args.host}, ` +
              `${DNS_MAX_PENDING} sends already queued`);
            dropError.code = DNS_QUEUE_FULL_CODE;
            entry.callback(dropError);
          }
        });
      });
    }
  };

  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    // Test hook: current length of the queue of sends waiting on an in-flight
    // cacheDns lookup. UDP-only and not part of the Transport interface, so
    // check for it before calling on a client of unknown protocol.
    getDnsPendingCount: () => dnsResolutionData.pending.length,
    // Lets Client.prototype.sendMessage reject a send BEFORE it increments
    // messagesInFlight. Deliberately does not also require
    // `resolvedAddress === undefined`: if it did, sendMessage would increment
    // the counter for exactly the sends sendUsingDnsCache is about to reject on
    // a later tick, leaving it elevated when close()'s finish() reads it. IP
    // literals and non-cacheDns sends are unaffected, matching what
    // socket.close() already leaves alone. UDP-only; check before calling.
    isDnsSendBlocked: () => dnsResolutionData.cancelled &&
      args.cacheDns && Boolean(args.host) && net.isIP(args.host) === 0,
    // Fails any sends still queued behind an in-flight lookup. Used by
    // Client.close() and by tests. UDP-only; check before calling.
    cancelPendingSends: (error) => {
      // Latch BEFORE invoking any callback below, so a callback that resends
      // fails instead of queueing entries nothing would ever cancel again.
      dnsResolutionData.cancelled = true;

      if (dnsResolutionData.pending.length === 0) {
        return;
      }
      debug('hot-shots UDP transport: cancelling %d sends queued behind a DNS lookup',
        dnsResolutionData.pending.length);
      flushPending(error);

      // Re-check once, not a loop: the latch means a resend already fails
      // rather than re-queueing, so this normally finds nothing. It only covers
      // an entry that raced in on this same tick, and is bounded because the
      // latch guarantees no further generation can follow.
      if (dnsResolutionData.pending.length > 0) {
        flushPending(error);
      }
    },
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
          // Deferred for the same reason as sendToSocket's catch above.
          debug('hot-shots UDP transport: send exception - %s', socketError.message);
          failLater(callback, () => socketError);
        }
      }
    },
    close: () => {
      debug('hot-shots UDP transport: closing socket');
      // Nothing queues when cacheDns is off, so a non-cacheDns transport's
      // post-close behavior stays untouched by this mechanism.
      if (args.cacheDns) {
        // Normally already empty, since Client.close() cancels pending sends
        // first; this only catches a transport closed directly. Latch here too
        // so such a transport still refuses to re-queue sends from the
        // callbacks flushPending fires below.
        dnsResolutionData.cancelled = true;
        if (dnsResolutionData.pending.length > 0) {
          // Coded like every other cancellation so Client.close()'s flush-error
          // branch treats a directly-closed transport the same way.
          const error = new Error('hot-shots: transport closed while resolving DNS');
          error.code = DNS_CANCELLED_CODE;
          flushPending(error);
        }
      }
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

  attachDefaultErrorListener(socket, 'uds');

  // Retry configuration with defaults (milliseconds)
  const maxRetries = (udsOpts.retries === undefined || udsOpts.retries === null) ? 3 : udsOpts.retries;
  const initialDelayMs = (udsOpts.retryDelayMs === undefined || udsOpts.retryDelayMs === null) ? 100 : udsOpts.retryDelayMs;
  const maxDelayMs = (udsOpts.maxRetryDelayMs === undefined || udsOpts.maxRetryDelayMs === null) ? 1000 : udsOpts.maxRetryDelayMs;
  const backoffFactor = (udsOpts.backoffFactor === undefined || udsOpts.backoffFactor === null) ? 2 : udsOpts.backoffFactor;
  const EAGAIN = os.constants.errno.EAGAIN;

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
    return typeof err.errno === 'number' && err.errno === EAGAIN;
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
    try {
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
    } catch (socketError) {
      // unix-dgram can throw synchronously rather than calling back. Deferred so
      // a resending errorHandler cannot recurse on this stack frame, and caught
      // here rather than left to Client.sendMessage's outer catch so the same
      // rule holds at every transport. See failLater.
      debug('hot-shots UDS transport: send exception - %s', socketError && socketError.message);
      failLater(callback, () => socketError);
    }
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

  // Attach a named error listener so it can be removed on close. Without this,
  // `Client.sendMessage`'s legacy `socket.emit('error', ...)` re-emit path on a
  // user-supplied stream with no listener crashes the process.
  const defaultErrorListener = (err) => {
    debug('hot-shots stream default error listener: %s',
      err && err.message ? err.message : err);
  };
  stream.on('error', defaultErrorListener);

  return {
    emit: stream.emit.bind(stream),
    on: stream.on.bind(stream),
    removeListener: stream.removeListener.bind(stream),
    send: (buf, callback) => {
      debug('hot-shots stream transport: sending %d bytes', buf.length);
      // Check if stream is destroyed before attempting to write
      // This prevents ERR_STREAM_DESTROYED errors (issue #247)
      if (stream.destroyed) {
        debug('hot-shots stream transport: stream destroyed, skipping send');
        // Deferred: this path always fails, so a resending errorHandler would
        // otherwise recurse on this stack frame. See failLater.
        failLater(callback, () => {
          const err = new Error('Stream is destroyed');
          err.code = 'ERR_STREAM_DESTROYED';
          return err;
        });
        return;
      }
      // Same unbounded-buffering guard as the tcp transport: a stream whose
      // consumer has stalled queues writes in memory without limit.
      if (stream.writableLength > MAX_PENDING_WRITE_BYTES) {
        debug('hot-shots stream transport: %d bytes already unflushed, dropping metric', stream.writableLength);
        failLater(callback, writeQueueFullError('stream', stream.writableLength));
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
      stream.removeListener('error', defaultErrorListener);
      if (stream.destroyed) {
        // Already destroyed - by the owning application, or by an earlier close.
        // destroy() will not emit 'close' again, so Client._close would wait
        // forever. Emulate it on a later tick, the same as the tcp, uds and mock
        // transports. The stream already emitted its own 'close' when it was
        // destroyed, so this is a duplicate on a stream we are done with.
        debug('hot-shots stream transport: stream already destroyed, emulating close');
        setImmediate(() => stream.emit('close'));
        return;
      }
      try {
        stream.destroy();
      } catch (err) {
        // If destroy throws synchronously the stream survives. Re-attach the
        // default error listener so future 'error' emits don't crash the host
        // process when no other listener is installed.
        stream.on('error', defaultErrorListener);
        throw err;
      }

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
