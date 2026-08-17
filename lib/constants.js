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

// Maximum sends queued behind an in-flight DNS lookup when cacheDns is enabled.
// Past this, the oldest queued send is dropped so a hung resolver under load
// cannot grow memory without bound.
exports.DNS_MAX_PENDING = 1000;

// Drop caused by DNS_MAX_PENDING queue overflow. Routed to the queue-drop
// telemetry counter rather than the writer-error one.
exports.DNS_QUEUE_FULL_CODE = 'HOTSHOTS_DNS_QUEUE_FULL';

// Drop caused by a send arriving while a recently failed lookup is still in its
// cooldown. There is then no address to send to, and no lookup to wait behind.
exports.DNS_COOLDOWN_CODE = 'HOTSHOTS_DNS_COOLDOWN';

// How long (ms) the first failed cacheDns lookup waits before another attempt.
// Each further consecutive failure doubles the wait, capped at cacheDnsTtl. The
// ramp exists because the cold path has no cached address to fall back on. A
// flat full-TTL cooldown would turn a one-second resolver failure at startup
// into a full TTL of dropped metrics. It would also be no better at preventing
// thrash than a short first wait that doubles.
exports.DNS_COOLDOWN_BASE_MS = 1000;

// A send that was already queued behind an in-flight lookup and got cancelled
// because close() stopped waiting on it. Kept distinct from DNS_CLOSED_CODE for
// consumers, though close()'s own flush-error branch treats the two alike.
exports.DNS_CANCELLED_CODE = 'HOTSHOTS_DNS_CANCELLED';

// A send that arrived after close() had already latched the cacheDns queue shut,
// as opposed to one cancelled mid-lookup. Paired with dnsQueueClosedMessage().
exports.DNS_CLOSED_CODE = 'HOTSHOTS_DNS_CLOSED';

// A uds send waiting out its retry backoff when close() ran. The retry is
// abandoned rather than fired against a closing socket. This is the analogue of
// DNS_CANCELLED_CODE for the retry queue.
exports.UDS_RETRY_CANCELLED_CODE = 'HOTSHOTS_UDS_RETRY_CANCELLED';

// Maximum uds sends that can sit waiting out a retry backoff at once. Each one
// holds its buffer and a timer for up to retries * maxRetryDelayMs, so a
// receiver stalled on EAGAIN would otherwise retain every flush that arrived
// during the stall. udsRetryOptions.retries caps attempts per send, not the
// number of sends retrying concurrently, so it does not bound this. Past the
// cap the oldest pending retry is dropped, matching DNS_MAX_PENDING.
exports.UDS_MAX_PENDING_RETRIES = 1000;

// Drop caused by UDS_MAX_PENDING_RETRIES overflow, the uds analogue of
// DNS_QUEUE_FULL_CODE. Also routed to the queue-drop telemetry counter.
exports.UDS_RETRY_QUEUE_FULL_CODE = 'HOTSHOTS_UDS_RETRY_QUEUE_FULL';

// Maximum bytes a connection-oriented transport (tcp, stream) can leave sitting
// unflushed in its socket before further sends are refused. Node buffers writes
// without bound while a socket is still connecting or its peer is not reading.
// Without this, a stalled connect turns every metric into retained memory.
// Normal operation never approaches this. Writes to a healthy peer drain
// immediately, and writableLength stays near zero.
exports.MAX_PENDING_WRITE_BYTES = 1024 * 1024;

// Drop caused by MAX_PENDING_WRITE_BYTES backpressure, the tcp/stream analogue
// of DNS_QUEUE_FULL_CODE. Also routed to the queue-drop telemetry counter.
exports.WRITE_QUEUE_FULL_CODE = 'HOTSHOTS_WRITE_QUEUE_FULL';

// Codes meaning "the client refused this send outright, and nothing reached the
// socket". Counted as queue drops rather than writer errors, since no write was
// attempted or failed. Anything that genuinely tried to resolve or write does
// not belong here.
exports.REFUSED_CODES = [
  exports.DNS_CANCELLED_CODE,
  exports.DNS_CLOSED_CODE,
  exports.DNS_COOLDOWN_CODE,
  exports.DNS_QUEUE_FULL_CODE,
  exports.UDS_RETRY_CANCELLED_CODE,
  exports.UDS_RETRY_QUEUE_FULL_CODE,
  exports.WRITE_QUEUE_FULL_CODE
];

// The final flush timed out and close() stopped waiting on it. Not a refusal -
// the send can still complete - but close() must proceed rather than hang forever.
exports.CLOSE_FLUSH_TIMEOUT_CODE = 'HOTSHOTS_CLOSE_FLUSH_TIMEOUT';

// Codes on a final-flush error that must not abort Client.close(). Either the
// send was refused outright, or close() stopped waiting on it. In both cases the
// socket still needs closing and the caller's callback still needs to fire.
exports.CLOSE_CONTINUE_CODES = exports.REFUSED_CODES.concat([exports.CLOSE_FLUSH_TIMEOUT_CODE]);

// How long (ms) close() waits for the final buffered flush before it stops
// waiting and proceeds to drain and close anyway. Much larger than the drain
// budget at the default closingFlushInterval (50 * 11, ~550ms) on purpose. A
// first-ever DNS lookup or a TCP connect taking a few hundred ms is ordinary and
// must not lose the flush. This therefore only bounds a genuinely stuck
// transport. A caller who raises closingFlushInterval past ~455 inverts that
// ordering. The two budgets still bound their own phases, and close() just
// reaches this one first.
exports.CLOSE_FLUSH_TIMEOUT = 5000;

/**
 * Message for a send rejected because close() shut the cacheDns queue. Shared by
 * the two rejection sites so the wording cannot drift. It says "the client is
 * closed" rather than "a lookup was cancelled" because close() latches the queue
 * on every close, including one where nothing was ever queued.
 * @param {string} host - the hostname the transport resolves for
 * @returns {string} the error message
 */
exports.dnsQueueClosedMessage = (host) => `hot-shots: send rejected, DNS-cached sends for ${host} ` +
  'are no longer accepted (the client is closed)';

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
