const os = require('os');
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
 * has failed in a way that can be retried. OS-specific.
 *
 * Includes both:
 * - string Node.js-style codes (e.g. 'ENOTCONN'), and
 * - negative numeric errnos from unix-dgram (e.g. -107 on Linux for ENOTCONN),
 *   which sets `err.code = errorno` rather than a string name.
 *
 * The numeric errnos are derived from `os.constants.errno` rather than
 * hardcoded, so they stay correct on architectures whose errno values differ
 * from the common x86/arm ones (e.g. mips/sparc Linux).
 *
 * @returns {Array<string|number>} An array of the error codes.
 */
function udsErrors() {
  const errno = os.constants.errno;

  if (process.platform === 'linux') {
    // unix-dgram reports negative numeric errnos, not string codes
    return ['ENOTCONN', 'ECONNREFUSED', -errno.ENOTCONN, -errno.ECONNREFUSED];
  }

  if (process.platform === 'darwin') {
    // unix-dgram reports negative numeric errnos, not string codes
    return ['EDESTADDRREQ', 'ECONNRESET', -errno.EDESTADDRREQ, -errno.ECONNRESET];
  }

  // Unknown / not yet implemented
  return [];
}

// StatsD/DogStatsD metric type codes as they appear on the wire.
exports.METRIC_TYPES = {
  TIMING: 'ms',
  COUNT: 'c',
  HISTOGRAM: 'h',
  DISTRIBUTION: 'd',
  GAUGE: 'g',
  SET: 's',
};

// Valid Datadog tag cardinality values (DogStatsD `|card:` field).
exports.CARDINALITY_VALUES = ['none', 'low', 'orchestrator', 'high'];

// Env var values that mean "disabled" for DD_ORIGIN_DETECTION_ENABLED.
exports.FALSEY_ENV_VALUES = ['no', 'false', '0', 'n', 'off'];

// Env vars whose presence signals the client is talking to a Datadog Agent.
exports.DATADOG_SIGNAL_ENV_VARS = [
  'DD_AGENT_HOST',
  'DD_DOGSTATSD_PORT',
  'DD_ENTITY_ID',
  'DD_ENV',
  'DD_SERVICE',
  'DD_VERSION',
  'DD_EXTERNAL_ENV',
  'DD_CARDINALITY',
  'DD_TAGS',
  'DD_DOGSTATSD_URL',
  'DD_DOGSTATSD_SOCKET',
];

// Origin detection (container ID) constants. Linux-only paths.
exports.ORIGIN_DETECTION = {
  // Inode of /proc/self/ns/cgroup when in the host cgroup namespace.
  HOST_CGROUP_NAMESPACE_INODE: 0xEFFFFFFB,
  CGROUP_PATH: '/proc/self/cgroup',
  CGROUP_NS_PATH: '/proc/self/ns/cgroup',
  MOUNTINFO_PATH: '/proc/self/mountinfo',
  CGROUP_MOUNT_PATH: '/sys/fs/cgroup',
  CGROUPV1_BASE_CONTROLLER: 'memory',
  // Matches Docker (64 hex), ECS (32 hex + task id), and UUID/Garden container ids.
  // The UUID branch is a full 8-4-4-4-12 UUID; using {4} for the final group would
  // truncate real UUIDs to 28 chars and emit an invalid |c: value.
  CONTAINER_ID_RE: /([0-9a-f]{64})|([0-9a-f]{32}-\d+)|([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/,
};

exports.tcpErrors = tcpErrors;
exports.udsErrors = udsErrors;
