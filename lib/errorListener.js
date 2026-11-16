// Bookkeeping for a client's errorListener, the function a client attaches to
// its socket's 'error' event to deliver socket errors to errorHandler, or to
// console.error without one. The client records which socket holds the
// listener in _errorListenerSocket, and whether it stays there with no
// errorHandler in _errorListenerPinned.

/**
 * Attaches the client's errorListener to its current socket and records where,
 * so it can be found and detached later. Idempotent for the same socket.
 * @param {Client} client - the client whose listener is attached
 * @returns {void}
 */
function attachErrorListener(client) {
  const socket = client.socket;
  if (!socket || typeof socket.on !== 'function' || client._errorListenerSocket === socket) {
    return;
  }
  socket.on('error', client.errorListener);
  client._errorListenerSocket = socket;
}

/**
 * Detaches the client's errorListener from whichever socket it was attached
 * to, if any. A socket with no removeListener keeps the listener, and stays
 * recorded as holding it, so a later attach does not add a second copy that
 * would deliver every error twice.
 * @param {Client} client - the client whose listener is detached
 * @returns {void}
 */
function detachErrorListener(client) {
  const socket = client._errorListenerSocket;
  if (!socket || typeof socket.removeListener !== 'function') {
    return;
  }
  socket.removeListener('error', client.errorListener);
  client._errorListenerSocket = null;
  client._errorListenerPinned = false;
}

/**
 * Attaches the client's errorListener to a socket the client has just created
 * for itself, in the constructor or for a send that found the socket missing.
 * A root gets it only with an errorHandler. A child gets it whatever the
 * handler and keeps it, as it would on a replacement socket, since the handler
 * it reads can be its parent's and change on the parent later. Does nothing
 * for a child on its parent's shared socket.
 * @param {Client} client - the client whose socket was created
 * @returns {void}
 */
function attachErrorListenerToCreatedSocket(client) {
  if (client.socket && client._ownsSocket && (client.errorHandler || client.isChild)) {
    attachErrorListener(client);
    client._errorListenerPinned = Boolean(client.isChild);
  }
}

/**
 * Whether this client, or the ancestor whose socket it shares, has its
 * errorListener attached to the given socket. With no errorHandler anywhere on
 * that chain, the listener logs a socket 'error' emit with console.error, so
 * the caller must not log the same error again.
 * @param {Client} client - the client reporting an error
 * @param {Object} socket - the socket the error is emitted on
 * @returns {boolean} true if an errorListener on the socket sees the emit
 */
function hasErrorListenerOnSocket(client, socket) {
  for (let owner = client; owner; owner = owner._parentClient) {
    if (owner._errorListenerSocket === socket) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a socket 'error' emit on the given socket already reaches this
 * client's errorHandler, so close must not call it a second time. That is
 * true when this client, or an ancestor with the same handler, has its
 * errorListener attached to that socket: a root on the shared socket, or a
 * child on a socket it created itself. Worked out at close time, since any of
 * those handlers can be reassigned after the child is created. The socket is
 * passed in rather than read from the client: an error during close can have
 * the socket replaced, and a listener on the replacement never saw the closing
 * socket's error.
 * @param {Client} client - the client being closed
 * @param {Object} socket - the socket that emitted the error
 * @returns {boolean} true if a socket 'error' emit already reaches the handler
 */
function isErrorHandlerOnSocket(client, socket) {
  if (!client.errorHandler || !socket) {
    return false;
  }
  for (let owner = client; owner; owner = owner._parentClient) {
    if (owner._errorListenerSocket === socket && owner.errorHandler === client.errorHandler) {
      return true;
    }
  }
  return false;
}

module.exports = {
  attachErrorListener: attachErrorListener,
  detachErrorListener: detachErrorListener,
  attachErrorListenerToCreatedSocket: attachErrorListenerToCreatedSocket,
  hasErrorListenerOnSocket: hasErrorListenerOnSocket,
  isErrorHandlerOnSocket: isErrorHandlerOnSocket
};
