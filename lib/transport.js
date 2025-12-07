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
      debug('hot-shots createTcpTransport: sending %d bytes to %s:%s', buf.length, args.host, args.port);
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

const createUdpTransport = args => {
  debug('hot-shots createUdpTransport: creating socket for %s:%s (cacheDns=%s)', args.host, args.port, args.cacheDns);
  const socket = dgram.createSocket(args.udpSocketOptions);
  // do not block node from shutting down
  socket.unref();

  const dnsResolutionData = {
    timestamp: new Date(0),
    resolvedAddress: undefined
  };

  const sendUsingDnsCache = (callback, buf) => {
    const now = Date.now();
    if (dnsResolutionData.resolvedAddress === undefined || (now - dnsResolutionData.timestamp > args.cacheDnsTtl)) {
      debug('hot-shots UDP transport: performing DNS lookup for %s', args.host);
      dns.lookup(args.host, (error, address) => {
        if (error) {
          debug('hot-shots UDP transport: DNS lookup error - %s', error.message);
          callback(error);
          return;
        }
        debug('hot-shots UDP transport: DNS resolved %s to %s', args.host, address);
        dnsResolutionData.resolvedAddress = address;
        dnsResolutionData.timestamp = now;
        try {
          debug('hot-shots UDP transport: sending %d bytes to %s:%s', buf.length, dnsResolutionData.resolvedAddress, args.port);
          socket.send(buf, 0, buf.length, args.port, dnsResolutionData.resolvedAddress, (err) => {
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
      });
    } else {
      debug('hot-shots UDP transport: using cached DNS address %s', dnsResolutionData.resolvedAddress);
      try {
        debug('hot-shots UDP transport: sending %d bytes to %s:%s', buf.length, dnsResolutionData.resolvedAddress, args.port);
        socket.send(buf, 0, buf.length, args.port, dnsResolutionData.resolvedAddress, (err) => {
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
          debug('hot-shots UDP transport: sending %d bytes to %s:%s (no DNS cache)', buf.length, args.host, args.port);
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

  const isEagain = (err) => {
    if (!err) {
      return false;
    }
    if (err.code === 'EAGAIN') {
      return true;
    }
    return typeof err.errno === 'number' && typeof EAGAIN === 'number' && err.errno === EAGAIN;
  };

  // unix-dgram returns an internal 'congestion' error (err === 1) via callback
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

  const isRetryableUdsError = (err) => isEagain(err) || isCongestion(err);

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

module.exports = (instance, args) => {
  let transport = null;
  const protocol = args.protocol || PROTOCOL.UDP;

  try {
    if (protocol === PROTOCOL.TCP) {
      transport = createTcpTransport(args);
    } else if (protocol === PROTOCOL.UDS) {
      transport = createUdsTransport(args);
    } else if (protocol === PROTOCOL.UDP) {
      transport = createUdpTransport(args);
    } else if (protocol === PROTOCOL.STREAM) {
      transport = createStreamTransport(args);
    } else {
      throw new Error(`Unsupported protocol '${protocol}'`);
    }
    transport.type = protocol;
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
