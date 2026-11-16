const constants = require('./constants');
const createTransport = require('./transport');
const helpers = require('./helpers');
const { attachErrorListener, detachErrorListener } = require('./errorListener');

const PROTOCOL = constants.PROTOCOL;
const TCP_ERROR_CODES = constants.tcpErrors();
const UDS_ERROR_CODES = constants.udsErrors();

// Creating a client's socket, and replacing a TCP/UDS socket after a
// connection error.

/**
 * Try to replace a client's socket with a new transport. If `createTransport()`
 * returns `null` this will still set the client's socket to `null`. This also
 * updates the socket creation time for UDS error handling.
 * @param client Client The statsd Client that will be getting a new socket
 */
function trySetNewSocket(client) {
  client._ownsSocket = true;
  client.socket = createTransport(client, {
    host: client.host,
    cacheDns: client.cacheDns,
    cacheDnsTtl: client.cacheDnsTtl,
    path: client.path,
    maxPendingWriteBytes: client.maxPendingWriteBytes,
    udsRetryOptions: client.udsRetryOptions,
    port: client.port,
    protocol: client.protocol,
    stream: client.stream,
    udpSocketOptions: client.udpSocketOptions,
    mock: client.mock,
  });
}

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

  // Checked here rather than only in maybeAddProtocolErrorHandler, because
  // sendMessage's send callback also calls this, and turning graceful handling
  // off must stop replacement on both paths.
  if ((protocol === PROTOCOL.TCP && !client.tcpGracefulErrorHandling) ||
    (protocol === PROTOCOL.UDS && !client.udsGracefulErrorHandling)) {
    return;
  }

  // recreate the socket, but only once within `tcpGracefulRestartRateLimit`/`udsGracefulRestartRateLimit`.

  if (protocol === PROTOCOL.TCP && (!TCP_ERROR_CODES.includes(err.code) || Date.now() - client.socket.createdAt < client.tcpGracefulRestartRateLimit)) {
    return;
  } else if (protocol === PROTOCOL.UDS && (!UDS_ERROR_CODES.includes(err.code) || Date.now() - client.socket.createdAt < client.udsGracefulRestartRateLimit)) {
    return;
  }

  const newSocket = createTransport(client, {
    host: client.host,
    path: client.path,
    maxPendingWriteBytes: client.maxPendingWriteBytes,
    udsRetryOptions: client.udsRetryOptions,
    port: client.port,
    protocol: client.protocol,
  });
  if (!newSocket) {
    // The old socket stays in use, so it keeps its errorHandler listener.
    const errorMessage = `Could not replace ${protocol} connection with new socket`;
    helpers.reportError(client, new Error(errorMessage), 'a failed socket replacement', errorMessage);
    return;
  }

  // Detached only once a replacement exists, so errors from closing the old
  // socket do not reach errorHandler.
  detachErrorListener(client);
  // A child still on its parent's shared socket only moves itself off it. The
  // parent and any siblings keep sending on that socket, and its owner replaces
  // it when its own sends fail.
  if (client._ownsSocket) {
    client.socket.close();
  }
  client.socket = newSocket;
  client._ownsSocket = true;
  maybeAddProtocolErrorHandler(client, protocol);

  // Attached even with no errorHandler, since errorListener falls back to
  // console.error. Using the managed listener rather than a separate fallback
  // means a handler assigned later is not delivered to alongside a log line.
  // Pinned so that clearing the handler later leaves the fallback in place.
  attachErrorListener(client);
  client._errorListenerPinned = true;
}

/**
 * Add a TCP/UDS socket error handler to the client's socket, if the client
 * owns that socket and has graceful error handling enabled for TCP/UDS. A
 * child on its parent's shared socket does not own it, and the parent replaces
 * that socket. A child that replaced its own socket does own it, and gets the
 * handler for it like a root.
 * @param client Client The statsd Client that may be getting a TCP/UDS error handler.
 * @param protocol Client configured protocol
 */
function maybeAddProtocolErrorHandler(client, protocol) {
  if (!client._ownsSocket) {
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

module.exports = {
  trySetNewSocket: trySetNewSocket,
  protocolErrorHandler: protocolErrorHandler,
  maybeAddProtocolErrorHandler: maybeAddProtocolErrorHandler
};
