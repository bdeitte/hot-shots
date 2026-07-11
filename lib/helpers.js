const constants = require('./constants');
const fs = require('fs');

/**
 * Replace any characters that can't be sent on with an underscore.
 * Used for tag keys where colons are not allowed (colon separates key from value).
 */
function sanitizeTags(value, telegraf) {
  // Characters that break the protocol in tag keys:
  // : - separates tag key from value (not allowed in keys)
  // | - separates metric components
  // , - separates tags
  // @ - used for sample rate (StatsD only)
  // # - tag prefix character (DogStatsD only)
  // \n, \r - break the line protocol (some receivers split on \r as well as \n)
  const blocklist = telegraf ? /:|\||,|\n|\r/g : /:|\||@|,|#|\n|\r/g;
  // Replace reserved chars with underscores.
  let sanitized = String(value).replace(blocklist, '_');

  // For telegraf, replace trailing backslashes as they break the line protocol
  // by escaping the delimiter that comes after the tag value
  if (telegraf && sanitized.endsWith('\\')) {
    sanitized = sanitized.slice(0, -1) + '_';
  }

  return sanitized;
}

/**
 * Replace any characters that can't be sent on with an underscore.
 * Used for tag values where colons ARE allowed (e.g., URLs).
 */
function sanitizeTagValue(value, telegraf) {
  // Characters that break the protocol in tag values:
  // | - separates metric components
  // , - separates tags
  // @ - used for sample rate (StatsD only)
  // # - tag prefix character (DogStatsD only)
  // \n, \r - break the line protocol (some receivers split on \r as well as \n)
  // Note: colons ARE allowed in tag values
  const blocklist = telegraf ? /\||,|\n|\r/g : /\||@|,|#|\n|\r/g;
  // Replace reserved chars with underscores.
  let sanitized = String(value).replace(blocklist, '_');

  // For telegraf, replace trailing backslashes as they break the line protocol
  // by escaping the delimiter that comes after the tag value
  if (telegraf && sanitized.endsWith('\\')) {
    sanitized = sanitized.slice(0, -1) + '_';
  }

  return sanitized;
}

/**
 * Replace any characters in metric names that can't be sent on with an underscore
 */
function sanitizeMetricName(value) {
  // Characters that break the protocol in metric names:
  // : - separates metric name from value
  // | - separates metric components
  // \n, \r - break the line protocol (some receivers split on \r as well as \n)
  const blocklist = /:|\||\n|\r/g;
  return String(value).replace(blocklist, '_');
}

/**
 * Format tags properly before sending on
 */
function formatTags(tags, telegraf) {
  if (Array.isArray(tags)) {
    // Sanitize each tag in the array
    return tags.map(tag => {
      // If tag contains a colon (not at position 0), sanitize key and value separately
      const colonIndex = typeof tag === 'string' ? tag.indexOf(':') : -1;
      if (colonIndex > 0) {
        const key = tag.substring(0, colonIndex);
        const value = tag.substring(colonIndex + 1);
        return `${sanitizeTags(key, telegraf)}:${sanitizeTagValue(value, telegraf)}`;
      }
      // For tags without colons (or colon at start), sanitize as a key (most restrictive)
      return sanitizeTags(tag, telegraf);
    });

  } else {
    return Object.keys(tags).map(key => {
      return `${sanitizeTags(key, telegraf)}:${sanitizeTagValue(tags[key], telegraf)}`;
    });
  }
}

/**
 * Overrides tags in parent with tags from child with the same name (case sensitive) and return the result as new
 * array. parent and child are not mutated.
 */
function overrideTags (parent, child, telegraf) {
  if (! child) {
    return parent;
  }

  const formattedChild = formatTags(child, telegraf);
  const childCopy = new Map();
  const toAppend = [];

  formattedChild.forEach(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) {
      toAppend.push(tag);
    } else {
      const key = tag.substring(0, idx);
      const value = tag.substring(idx + 1);
      if (!childCopy.has(key)) {
        childCopy.set(key, []);
      }
      childCopy.get(key).push(value);
    }
  });

  const result = parent.filter(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) {
      return true;
    }
    const key = tag.substring(0, idx);
    return !childCopy.has(key);
  });

  for (const [key, values] of childCopy) {
    for (const value of values) {
      result.push(`${key}:${value}`);
    }
  }
  result.push(...toAppend);
  return result;
}

/**
 * Formats a date for use with DataDog
 */
function formatDate(date) {
  let timestamp;
  if (date instanceof Date) {
    // Datadog expects seconds.
    timestamp = Math.round(date.getTime() / 1000);
  } else if (date instanceof Number || typeof date === 'number') {
    // Make sure it is an integer, not a float.
    timestamp = Math.round(date);
  }
  return timestamp;
}

/**
 * Converts int to a string IP
 */
function intToIP(int) {
  const part1 = int & 255;
  const part2 = ((int >> 8) & 255);
  const part3 = ((int >> 16) & 255);
  const part4 = ((int >> 24) & 255);

  return `${part4}.${part3}.${part2}.${part1}`;
}

/**
 * Returns the system default interface on Linux
 */
function getDefaultRoute() {
  try {
    const fileContents = fs.readFileSync('/proc/net/route', 'utf8'); // eslint-disable-line no-sync
    const routes = fileContents.split('\n');
    for (const route of routes) {
      const fields = route.trim().split('\t');
      if (fields[1] === '00000000') {
        const address = fields[2];
        // Convert to little endian by splitting every 2 digits and reversing that list
        const littleEndianAddress = address.match(/.{2}/g).reverse().join('');
        return intToIP(parseInt(littleEndianAddress, 16));
      }
    }
  } catch (e) {
    console.error('Could not get default route from /proc/net/route');
  }
  return null;
}

/**
 * Normalize prefix to ensure it ends with a period separator if non-empty
 */
function normalizePrefix(prefix) {
  if (prefix && !prefix.endsWith('.')) {
    return prefix + '.';
  }
  return prefix || '';
}

/**
 * Normalize suffix to ensure it starts with a period separator if non-empty
 */
function normalizeSuffix(suffix) {
  if (suffix && !suffix.startsWith('.')) {
    return '.' + suffix;
  }
  return suffix || '';
}

/**
 * Validates a cardinality value against the allowed set, returning the
 * normalized lowercase value or undefined (with a console.error on invalid).
 */
function validateCardinality(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).toLowerCase();
  if (constants.CARDINALITY_VALUES.indexOf(normalized) === -1) {
    console.error(`hot-shots: invalid cardinality '${value}' — expected one of ` +
      `${constants.CARDINALITY_VALUES.join(', ')}; ignoring`);
    return undefined;
  }
  return normalized;
}

/**
 * Sanitizes External Data (DD_EXTERNAL_ENV) by trimming and stripping control
 * characters and pipe characters. Returns undefined for empty input.
 */
function sanitizeExternalData(value) {
  if (!value) {
    return undefined;
  }
  // Strip control characters and the pipe delimiter, matching the C# client.
  const sanitized = String(value).trim().replace(/[\x00-\x1f|]+/g, ''); // eslint-disable-line no-control-regex
  return sanitized === '' ? undefined : sanitized;
}

/**
 * Returns true if an env var value represents a disabled/false setting.
 */
function isFalseyEnvValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  return constants.FALSEY_ENV_VALUES.indexOf(String(value).toLowerCase()) !== -1;
}

/**
 * Determines whether Datadog mode should auto-enable. True when not telegraf and
 * a Datadog signal env var is set. The `uds` protocol alone does NOT enable it.
 */
function detectDatadogMode(telegraf) {
  if (telegraf) {
    return false;
  }
  return constants.DATADOG_SIGNAL_ENV_VARS.some(name => process.env[name]);
}

/**
 * Parses a DD_DOGSTATSD_URL-style transport URL into hot-shots transport options.
 * Supports udp://host[:port], unix:///path/to/socket and unixgram:///path/to/socket.
 * Returns null (with a console.error) for unsupported or malformed URLs.
 */
function parseDogstatsdUrl(url) {
  const value = String(url);
  if (value.startsWith('unixstream://')) {
    console.error(`hot-shots: unsupported DD_DOGSTATSD_URL '${value}' — stream Unix sockets are not supported; ignoring`);
    return null;
  }
  const udsPrefix = ['unixgram://', 'unix://'].find(prefix => value.startsWith(prefix));
  if (udsPrefix) {
    const path = value.substring(udsPrefix.length);
    if (path === '') {
      console.error(`hot-shots: invalid DD_DOGSTATSD_URL '${value}' — missing socket path; ignoring`);
      return null;
    }
    return { protocol: constants.PROTOCOL.UDS, path: path };
  }
  if (value.startsWith('udp://')) {
    const rest = value.substring('udp://'.length);
    let host = rest;
    let portStr;
    const bracketMatch = rest.match(/^\[(.+)\](?::(\d+))?$/);
    if (bracketMatch) {
      host = bracketMatch[1];
      portStr = bracketMatch[2];
    } else {
      const firstColon = rest.indexOf(':');
      // A single colon separates host from port. Multiple colons without
      // brackets means a bare IPv6 address with no port.
      if (firstColon !== -1 && firstColon === rest.lastIndexOf(':')) {
        host = rest.substring(0, firstColon);
        portStr = rest.substring(firstColon + 1);
      }
    }
    if (host === '') {
      console.error(`hot-shots: invalid DD_DOGSTATSD_URL '${value}' — missing host; ignoring`);
      return null;
    }
    const config = { protocol: constants.PROTOCOL.UDP, host: host };
    if (portStr !== undefined) {
      if (!(/^\d+$/).test(portStr)) {
        console.error(`hot-shots: invalid port in DD_DOGSTATSD_URL '${value}'; ignoring`);
        return null;
      }
      const port = parseInt(portStr, 10);
      if (port < 1 || port > 65535) {
        console.error(`hot-shots: invalid port in DD_DOGSTATSD_URL '${value}'; ignoring`);
        return null;
      }
      config.port = port;
    } else {
      // Default to the standard DogStatsD port so the URL stays authoritative and
      // DD_DOGSTATSD_PORT is not consulted when a URL without a port is given.
      config.port = 8125;
    }
    return config;
  }
  console.error(`hot-shots: unsupported scheme in DD_DOGSTATSD_URL '${value}' — expected udp://, unix:// or unixgram://; ignoring`);
  return null;
}

/**
 * Resolves transport configuration from the DD_DOGSTATSD_URL env var or the
 * legacy DD_DOGSTATSD_SOCKET env var. Returns null when neither yields a config.
 */
function getDogstatsdEnvTransport() {
  if (process.env.DD_DOGSTATSD_URL) {
    const parsed = parseDogstatsdUrl(process.env.DD_DOGSTATSD_URL);
    if (parsed) {
      return parsed;
    }
    // The URL was set but invalid/unsupported (parseDogstatsdUrl already logged
    // why). Fall through to DD_DOGSTATSD_SOCKET rather than silently defaulting to
    // UDP localhost — e.g. a unixstream:// URL we reject paired with a usable
    // DD_DOGSTATSD_SOCKET should still reach the agent over UDS.
  }
  if (process.env.DD_DOGSTATSD_SOCKET) {
    // Trim and reject empty/whitespace-only paths so a stray blank value does not
    // silently route the client to an invalid socket (mirrors the URL parser's
    // missing-path validation).
    const socketPath = process.env.DD_DOGSTATSD_SOCKET.trim();
    if (socketPath === '') {
      console.error('hot-shots: invalid DD_DOGSTATSD_SOCKET — empty or whitespace-only socket path; ignoring');
      return null;
    }
    return { protocol: constants.PROTOCOL.UDS, path: socketPath };
  }
  return null;
}

/**
 * Clones caller-provided tags so later mutation of the original array/object
 * does not change what gets emitted at flush time.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @returns {Array|Object=} A shallow copy of the tags, or the value unchanged
 *   when there is nothing to copy.
 */
function cloneTags(tags) {
  if (Array.isArray(tags)) {
    return tags.slice();
  }
  if (tags && typeof tags === 'object') {
    return Object.assign({}, tags);
  }
  return tags;
}

module.exports = {
  formatTags: formatTags,
  cloneTags: cloneTags,
  overrideTags: overrideTags,
  formatDate: formatDate,
  getDefaultRoute: getDefaultRoute,
  sanitizeTags: sanitizeTags,
  sanitizeTagValue: sanitizeTagValue,
  sanitizeMetricName: sanitizeMetricName,
  normalizePrefix: normalizePrefix,
  normalizeSuffix: normalizeSuffix,
  validateCardinality: validateCardinality,
  sanitizeExternalData: sanitizeExternalData,
  isFalseyEnvValue: isFalseyEnvValue,
  detectDatadogMode: detectDatadogMode,
  parseDogstatsdUrl: parseDogstatsdUrl,
  getDogstatsdEnvTransport: getDogstatsdEnvTransport,
  // Expose intToIP for testing purposes
  intToIP: intToIP
};
