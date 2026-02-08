const process = require('process');

exports.PROTOCOL = {
  TCP: 'tcp',
  UDS: 'uds',
  UDP: 'udp',
  STREAM: 'stream'
};

/**
 * Determines error codes that signify a connection to a TCP socket
 * has failed in a way that can be retried. These are string error codes
 * matching Node.js socket error.code values (e.g., 'EPIPE', 'ECONNRESET').
 * @returns {string[]} An array of the error codes.
 */
function tcpErrors() {
  return [
    'WSAENOTCONN',
    'WSAECONNREFUSED',
    'WSAECONNRESET',
    'EDESTADDRREQ',
    'ECONNRESET',
    'EPIPE',
    'ENOTCONN',
    'ECONNREFUSED',
  ];
}

/**
 * Determines error codes that signify a connection to a Unix Domain Socket (UDS)
 * has failed in a way that can be retried. These are string error codes
 * matching Node.js socket error.code values. OS-specific.
 * @returns {string[]} An array of the error codes.
 */
function udsErrors() {
  if (process.platform === 'linux') {
    return ['ENOTCONN', 'ECONNREFUSED'];
  }

  if (process.platform === 'darwin') {
    return ['EDESTADDRREQ', 'ECONNRESET'];
  }

  // Unknown / not yet implemented
  return [];
}

exports.tcpErrors = tcpErrors;
exports.udsErrors = udsErrors;
