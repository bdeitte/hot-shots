# DogStatsD Parity Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four parity gaps with official Datadog DogStatsD clients: `DD_DOGSTATSD_URL`/`DD_DOGSTATSD_SOCKET` env transport config, a public `flush()` method, `DD_TAGS` env global tags, and opt-in client-side aggregation of counts/gauges/sets.

**Architecture:** Env-config features extend the existing `helpers.js` + constructor option-resolution flow in `lib/statsd.js`. `flush()` is a thin public wrapper over the existing `flushQueue()` plus the new aggregator. Aggregation is a new `lib/aggregator.js` keyed by metric context (type + full name + per-call tags + cardinality + client global tags), hooked into `sendStat()` before message serialization, flushed on its own unref'd interval, on `flush()`, and on `close()`. Child clients share the parent's aggregator instance.

**Tech Stack:** Node.js (no runtime deps), Mocha + test/helpers/helpers.js (`createServer`, `createHotShotsClient`, `closeAll`, `testTypes`), ESLint 8 (single quotes, curly braces always, JSDoc required, operators at end of line).

**Reference:** Gap analysis in `docs/dogstatsd-parity-plan.md`.

---

### Task 1: DD_TAGS / DATADOG_TAGS global tags

**Files:**
- Modify: `lib/statsd.js` (`setupDatadogGlobalTags`, ~line 1070)
- Modify: `lib/constants.js` (`DATADOG_SIGNAL_ENV_VARS`)
- Test: `test/globalTags.js` (new describe block)
- Docs: `README.md`, `CHANGES.md`

- [ ] **Step 1: Write failing tests** — add to `test/globalTags.js` a top-level `describe('#DD_TAGS env var', ...)` block (mock clients, no server needed):

```javascript
describe('#DD_TAGS env var', () => {
  let statsd;

  afterEach(() => {
    delete process.env.DD_TAGS;
    delete process.env.DATADOG_TAGS;
    delete process.env.DD_ENV;
    statsd = null;
  });

  it('should add DD_TAGS as global tags', () => {
    process.env.DD_TAGS = 'rack:1,team:core';
    statsd = createHotShotsClient({ mock: true }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['rack:1', 'team:core']);
  });

  it('should trim whitespace and skip empty entries in DD_TAGS', () => {
    process.env.DD_TAGS = ' rack:1 , ,team:core, ';
    statsd = createHotShotsClient({ mock: true }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['rack:1', 'team:core']);
  });

  it('should override user globalTags with matching keys from DD_TAGS', () => {
    process.env.DD_TAGS = 'team:env';
    statsd = createHotShotsClient({ mock: true, globalTags: ['team:user', 'other:tag'] }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['other:tag', 'team:env']);
  });

  it('should fall back to DATADOG_TAGS when DD_TAGS is not set', () => {
    process.env.DATADOG_TAGS = 'legacy:tag';
    statsd = createHotShotsClient({ mock: true }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['legacy:tag']);
  });

  it('should let DD_ENV win over an env tag in DD_TAGS', () => {
    process.env.DD_TAGS = 'env:fromtags';
    process.env.DD_ENV = 'fromenv';
    statsd = createHotShotsClient({ mock: true }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['env:fromenv']);
  });

  it('should ignore DD_TAGS when includeDataDogTags is false', () => {
    process.env.DD_TAGS = 'rack:1';
    statsd = createHotShotsClient({ mock: true, includeDataDogTags: false }, 'client');
    assert.deepStrictEqual(statsd.globalTags, []);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx mocha test/globalTags.js --timeout 5000` — expect new tests FAIL.

- [ ] **Step 3: Implement** — in `lib/statsd.js` `setupDatadogGlobalTags`, after the `includeDataDogTags` early return, before the `availableDDEnvs` block:

```javascript
  // DD_TAGS / DATADOG_TAGS: comma-delimited tags applied as global tags. Processed
  // before the DD_* mapping below so DD_ENV/DD_SERVICE/DD_VERSION win on conflict.
  const envTagsRaw = process.env.DD_TAGS || process.env.DATADOG_TAGS;
  if (envTagsRaw) {
    const envTags = String(envTagsRaw).split(',').map(tag => tag.trim()).filter(tag => tag !== '');
    if (envTags.length > 0) {
      client.globalTags = helpers.overrideTags(client.globalTags, envTags, options.telegraf);
    }
  }
```

Add `'DD_TAGS',` to `DATADOG_SIGNAL_ENV_VARS` in `lib/constants.js` (after `DD_CARDINALITY`).

- [ ] **Step 4: Run tests** — `npx mocha test/globalTags.js --timeout 5000` then `npm test` — expect PASS. Note: adding DD_TAGS to the signal list means tests elsewhere that leave DD_TAGS set could flip datadog mode — the afterEach cleanup above prevents this.

- [ ] **Step 5: Docs + commit** — README env-var section: document `DD_TAGS`/`DATADOG_TAGS`. CHANGES.md (new `## Unreleased`-style section at top following existing format): `* [@bdeitte](https://github.com/bdeitte) Support DD_TAGS / DATADOG_TAGS env vars for global tags, for better parity with official DogStatsD clients`. Commit: `git add -A` / `git commit -m "Support DD_TAGS / DATADOG_TAGS env vars for global tags"`.

---

### Task 2: DD_DOGSTATSD_URL / DD_DOGSTATSD_SOCKET transport config

**Files:**
- Modify: `lib/helpers.js` (new `parseDogstatsdUrl`, `getDogstatsdEnvTransport`)
- Modify: `lib/statsd.js` (constructor, before option validation ~line 54)
- Modify: `lib/constants.js` (`DATADOG_SIGNAL_ENV_VARS`)
- Test: `test/init.js` (new tests + afterEach cleanup), `test/helpers.js` (URL parser unit tests)
- Docs: `README.md`, `CHANGES.md`

- [ ] **Step 1: Write failing tests** — in `test/init.js`, add to afterEach: `delete process.env.DD_DOGSTATSD_URL;` and `delete process.env.DD_DOGSTATSD_SOCKET;`. Add tests:

```javascript
  it('should use DD_DOGSTATSD_URL udp config when no transport options given', () => {
    process.env.DD_DOGSTATSD_URL = 'udp://urlhost:4321';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.protocol, 'udp');
    assert.strictEqual(statsd.host, 'urlhost');
    assert.strictEqual(statsd.port, 4321);
  });

  it('should default port to 8125 for DD_DOGSTATSD_URL without port', () => {
    process.env.DD_DOGSTATSD_URL = 'udp://urlhost';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.host, 'urlhost');
    assert.strictEqual(statsd.port, 8125);
  });

  it('should use uds config from DD_DOGSTATSD_URL unix scheme', () => {
    process.env.DD_DOGSTATSD_URL = 'unix:///var/run/test/dsd.socket';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.protocol, 'uds');
    assert.strictEqual(statsd.path, '/var/run/test/dsd.socket');
  });

  it('should use uds config from DD_DOGSTATSD_SOCKET', () => {
    process.env.DD_DOGSTATSD_SOCKET = '/var/run/test/dsd.socket';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.protocol, 'uds');
    assert.strictEqual(statsd.path, '/var/run/test/dsd.socket');
  });

  it('should prefer DD_DOGSTATSD_URL over DD_DOGSTATSD_SOCKET and DD_AGENT_HOST', () => {
    process.env.DD_DOGSTATSD_URL = 'udp://urlhost:4321';
    process.env.DD_DOGSTATSD_SOCKET = '/var/run/test/dsd.socket';
    process.env.DD_AGENT_HOST = 'envhost';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.protocol, 'udp');
    assert.strictEqual(statsd.host, 'urlhost');
    assert.strictEqual(statsd.port, 4321);
  });

  it('should prefer explicit transport options over DD_DOGSTATSD_URL', () => {
    process.env.DD_DOGSTATSD_URL = 'udp://urlhost:4321';
    statsd = createHotShotsClient({ mock: true, host: 'optionhost' }, clientType);
    assert.strictEqual(statsd.host, 'optionhost');
    assert.strictEqual(statsd.port, 8125);
  });

  it('should ignore DD_DOGSTATSD_URL with unsupported scheme', () => {
    process.env.DD_DOGSTATSD_URL = 'unixstream:///var/run/test/dsd.socket';
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.strictEqual(statsd.protocol, 'udp');
    assert.strictEqual(statsd.path, undefined);
  });
```

In `test/helpers.js` add a describe for `helpers.parseDogstatsdUrl`: udp with port, udp without port, bracketed IPv6 `udp://[::1]:9125` → host `::1` port 9125, `unixgram://` path, empty host → null, bad port → null, unknown scheme → null.

- [ ] **Step 2: Run to verify failure** — `npx mocha test/init.js test/helpers.js --timeout 5000` — new tests FAIL.

- [ ] **Step 3: Implement helpers** — in `lib/helpers.js`:

```javascript
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
      const port = parseInt(portStr, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`hot-shots: invalid port in DD_DOGSTATSD_URL '${value}'; ignoring`);
        return null;
      }
      config.port = port;
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
    return parseDogstatsdUrl(process.env.DD_DOGSTATSD_URL);
  }
  if (process.env.DD_DOGSTATSD_SOCKET) {
    return { protocol: constants.PROTOCOL.UDS, path: process.env.DD_DOGSTATSD_SOCKET };
  }
  return null;
}
```

Note `helpers.js` does not currently import `process` — add `const process = require('process');` at top (matching statsd.js style) or use the global; follow existing file style (it uses globals — check; if no `process` usage exists, require it). Export both functions in module.exports.

- [ ] **Step 4: Implement constructor wiring** — in `lib/statsd.js`, immediately after the deprecated-arguments block (after line 52), before the port validation block:

```javascript
  // Transport configuration from DD_DOGSTATSD_URL / DD_DOGSTATSD_SOCKET. Explicit
  // transport options always win — env config applies only when none are given.
  if (!options.protocol && !options.host && !options.port && !options.path && !options.stream) {
    const envTransport = helpers.getDogstatsdEnvTransport();
    if (envTransport) {
      options.protocol = envTransport.protocol;
      options.host = envTransport.host;
      options.port = envTransport.port;
      options.path = envTransport.path;
    }
  }
```

Add `'DD_DOGSTATSD_URL',` and `'DD_DOGSTATSD_SOCKET',` to `DATADOG_SIGNAL_ENV_VARS` in `lib/constants.js`.

- [ ] **Step 5: Run tests** — `npx mocha test/init.js test/helpers.js --timeout 5000`, then `npm test` — PASS.

- [ ] **Step 6: Docs + commit** — README: document both env vars in the env/config section (note precedence: explicit options > DD_DOGSTATSD_URL > DD_DOGSTATSD_SOCKET > DD_AGENT_HOST/DD_DOGSTATSD_PORT; unixstream:// unsupported). CHANGES.md entry. Commit `"Support DD_DOGSTATSD_URL and DD_DOGSTATSD_SOCKET for transport configuration"`.

---

### Task 3: Public flush() method

**Files:**
- Modify: `lib/statsd.js` (new method after `onBufferFlushInterval`)
- Modify: `types.d.ts` (StatsD class)
- Test: `test/flush.js` (new file)
- Docs: `README.md`, `CHANGES.md`

- [ ] **Step 1: Write failing tests** — create `test/flush.js`:

```javascript
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;
const testTypes = helpers.testTypes;

describe('#flush', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType, metricsEnd]) => {
    describe(description, () => {
      it('should flush buffered metrics immediately', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 8192,
            bufferFlushInterval: 60000,
          }), clientType);
          statsd.increment('buffered.metric');
          statsd.flush();
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `buffered.metric:1|c${metricsEnd}`);
          done();
        });
      });

      it('should invoke the callback after flushing', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 8192,
            bufferFlushInterval: 60000,
          }), clientType);
          statsd.increment('buffered.metric');
          statsd.flush(err => {
            assert.strictEqual(err, null);
            done();
          });
        });
      });
    });
  });

  it('should invoke the callback with nothing to flush', done => {
    statsd = createHotShotsClient({ mock: true }, 'client');
    statsd.flush(() => {
      done();
    });
  });
});
```

Note: verify the callback-arg expectation against `sendMessage` behavior during implementation — for an empty buffer the callback is invoked with no arguments, for a sent buffer with `(null, bytes)` or `(errFormatted)`. Adjust the `assert.strictEqual(err, null)` to `assert.ok(!err)` if needed.

- [ ] **Step 2: Run to verify failure** — `npx mocha test/flush.js --timeout 5000` — FAIL (`statsd.flush is not a function`).

- [ ] **Step 3: Implement** — in `lib/statsd.js` after `onBufferFlushInterval`:

```javascript
/**
 * Flushes any buffered metrics to the transport immediately, without waiting for
 * the buffer flush interval. With client-side aggregation enabled, pending
 * aggregated metrics are flushed first. Useful for serverless and other
 * short-lived environments.
 * @param callback {Function=} Called when the buffered payload has been handed
 *   to the transport. Optional.
 */
Client.prototype.flush = function (callback) {
  if (this.aggregator) {
    this.aggregator.flush();
  }
  this.flushQueue(callback);
};
```

(`this.aggregator` is undefined until Task 4 — the guard makes this forward-compatible.)

In `types.d.ts`, after `close(...)`: `flush(callback?: StatsCb): void;`

- [ ] **Step 4: Run tests** — `npx mocha test/flush.js --timeout 5000`, then `npm test` — PASS.

- [ ] **Step 5: Docs + commit** — README: document `flush()` near the buffering/close docs. CHANGES.md entry. Commit `"Add public flush() method"`.

---

### Task 4: Opt-in client-side aggregation

**Files:**
- Create: `lib/aggregator.js`
- Modify: `lib/statsd.js` (constructor wiring, `sendStat` hook, `close`, `ChildClient`)
- Modify: `types.d.ts` (ClientOptions)
- Test: `test/aggregation.js` (new file)
- Docs: `README.md`, `CHANGES.md`, `CLAUDE.md` (if architecture summary needs the new file)

- [ ] **Step 1: Write failing tests** — create `test/aggregation.js` (mock-mode for most; one interval test, one close test):

```javascript
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#aggregation', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  it('should sum counts for the same context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.count');
    statsd.increment('agg.count', 2);
    statsd.decrement('agg.count');
    assert.deepStrictEqual(statsd.mockBuffer, []);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.count:2|c']);
  });

  it('should keep the last gauge value', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.gauge', 1);
    statsd.gauge('agg.gauge', 5);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.gauge:5|g']);
  });

  it('should send each unique set value once', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.set('agg.set', 'a');
    statsd.set('agg.set', 'a');
    statsd.set('agg.set', 'b');
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.sort(), ['agg.set:a|s', 'agg.set:b|s']);
  });

  it('should keep different tags in different contexts', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.count', 1, ['route:a']);
    statsd.increment('agg.count', 1, ['route:b']);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.sort(), [
      'agg.count:1|c|#route:a',
      'agg.count:1|c|#route:b',
    ]);
  });

  it('should not aggregate sampled metrics', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, sampleRate: 1 }, 'client');
    statsd.increment('agg.sampled', 1, 0.9999);
    // sampled metrics bypass aggregation entirely: either sent (in mockBuffer
    // with |@) or sampled out (not recorded anywhere)
    statsd.flush();
    statsd.mockBuffer.forEach(entry => {
      assert.ok(entry.includes('|@0.9999'));
    });
  });

  it('should not aggregate delta gauges', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gaugeDelta('agg.gauge', 5);
    statsd.gaugeDelta('agg.gauge', -2);
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.gauge:+5|g', 'agg.gauge:-2|g']);
  });

  it('should not aggregate timestamped metrics', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.ts', 1, { timestamp: 1700000000 });
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.ts:1|c|T1700000000']);
  });

  it('should not aggregate histograms or timings', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.histogram('agg.h', 5);
    statsd.timing('agg.t', 10);
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.h:5|h', 'agg.t:10|ms']);
  });

  it('should invoke the metric callback synchronously when aggregated', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.cb', 1, err => {
      assert.ok(!err);
      done();
    });
  });

  it('should aggregate separately for child clients with different global tags', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, globalTags: ['parent:tag'] }, 'client');
    const child = statsd.childClient({ globalTags: ['child:tag'] });
    statsd.increment('agg.count');
    child.increment('agg.count');
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.sort(), [
      'agg.count:1|c|#parent:tag',
      'agg.count:1|c|#parent:tag,child:tag',
    ].sort());
  });

  it('should flush on the aggregation interval', done => {
    statsd = createHotShotsClient({
      mock: true,
      aggregation: { flushInterval: 25 },
    }, 'client');
    statsd.increment('agg.interval');
    setTimeout(() => {
      assert.deepStrictEqual(statsd.mockBuffer, ['agg.interval:1|c']);
      done();
    }, 100);
  });

  it('should flush aggregated metrics on close', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        aggregation: { flushInterval: 60000 },
      }), 'client');
      statsd.increment('agg.close', 3);
      statsd.close();
      statsd = null;
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'agg.close:3|c');
      done();
    });
  });
});
```

(Adjust the child-client tag-order assertion to the actual merged order from `overrideTags` during implementation — parent tags first, then child overrides appended.)

- [ ] **Step 2: Run to verify failure** — `npx mocha test/aggregation.js --timeout 5000` — FAIL.

- [ ] **Step 3: Create `lib/aggregator.js`**:

```javascript
const util = require('util');
const debug = util.debuglog('hot-shots');

const DEFAULT_AGGREGATION_FLUSH_INTERVAL = 2000;

/**
 * Client-side metric aggregator for counts, gauges and sets. Samples recorded
 * here are combined per context (type + full metric name + per-call tags +
 * cardinality + recording client's global tags) and flushed on an interval,
 * reducing packet volume for hot metrics. Matches the basic client-side
 * aggregation in the official DogStatsD clients.
 * @constructor
 * @param options
 *   @option flushInterval {Number=} Interval in ms between flushes. Default 2000.
 */
const Aggregator = function (options) {
  options = options || {};
  this.flushInterval = options.flushInterval || DEFAULT_AGGREGATION_FLUSH_INTERVAL;
  this.contexts = new Map();
};

/**
 * Builds the aggregation context key for a metric. Includes the recording
 * client's global tags so parent and child clients with different global tags
 * never merge into one context.
 * @param client The client the metric was recorded through.
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param type {String} Metric type code: 'c', 'g' or 's'.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @param cardinality {String=} Per-call cardinality.
 * @returns {String} The context key.
 */
function contextKey(client, name, type, tags, cardinality) {
  const tagsKey = tags === undefined || tags === null ? '' : JSON.stringify(tags);
  return `${type}|${name}|${tagsKey}|${cardinality || ''}|${client.globalTags.join(',')}`;
}

/**
 * Records a metric sample into the aggregator. Counts are summed, gauges keep
 * the most recent value, and sets accumulate unique values.
 * @param client The client the metric was recorded through (used at flush time).
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param value The metric value.
 * @param type {String} Metric type code: 'c', 'g' or 's'.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @param cardinality {String=} Per-call cardinality.
 */
Aggregator.prototype.record = function (client, name, value, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  let context = this.contexts.get(key);
  if (!context) {
    context = {
      client: client,
      name: name,
      type: type,
      tags: tags,
      cardinality: cardinality,
      value: type === 's' ? new Set() : 0,
    };
    this.contexts.set(key, context);
  }
  if (type === 'c') {
    context.value += value;
  } else if (type === 'g') {
    context.value = value;
  } else {
    context.value.add(value);
  }
};

/**
 * Flushes all aggregated contexts through each context's client send path,
 * which applies tags, datadog extension fields and buffering as usual.
 */
Aggregator.prototype.flush = function () {
  if (this.contexts.size === 0) {
    return;
  }
  debug('hot-shots aggregator: flushing %d contexts', this.contexts.size);
  const contexts = this.contexts;
  this.contexts = new Map();
  for (const context of contexts.values()) {
    if (context.type === 's') {
      for (const value of context.value) {
        context.client.send(`${context.name}:${value}|s`, context.tags, context.cardinality);
      }
    } else {
      context.client.send(`${context.name}:${context.value}|${context.type}`, context.tags, context.cardinality);
    }
  }
};

module.exports = Aggregator;
module.exports.DEFAULT_AGGREGATION_FLUSH_INTERVAL = DEFAULT_AGGREGATION_FLUSH_INTERVAL;
```

- [ ] **Step 4: Wire into `lib/statsd.js`**:

(a) Top of file: `const Aggregator = require('./aggregator');` (keep require order tidy).

(b) In the constructor, right after `setupDatadogTelemetry(this, options);`: `setupAggregation(this, options);`

(c) New function near `setupDatadogTelemetry`:

```javascript
/**
 * Set up optional client-side aggregation of counts, gauges and sets. Opt-in
 * via the `aggregation` option (`true` or `{ flushInterval }`). Child clients
 * share the parent's aggregator instance; only the parent runs the flush
 * interval.
 * @param client Client The statsd Client being configured.
 * @param options The resolved constructor options.
 */
function setupAggregation(client, options) {
  if (options.isChild) {
    client.aggregator = options.aggregator || null;
    return;
  }
  if (!options.aggregation) {
    client.aggregator = null;
    return;
  }
  const aggregationOptions = typeof options.aggregation === 'object' ? options.aggregation : {};
  client.aggregator = new Aggregator({ flushInterval: aggregationOptions.flushInterval });
  client.aggregationIntervalHandle = setInterval(() => {
    try {
      client.aggregator.flush();
    } catch (err) {
      if (client.errorHandler) {
        try {
          client.errorHandler(err);
        } catch (handlerErr) {
          // Preserve the original flush error so the root cause is not masked by a buggy handler.
          console.error('hot-shots: errorHandler threw inside aggregation flush interval; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: aggregation flush interval threw: ${err && err.message}`);
      }
    }
  }, client.aggregator.flushInterval);
  // do not block node from shutting down
  client.aggregationIntervalHandle.unref();
}
```

(d) `sendStat` hook — restructure the top of `Client.prototype.sendStat`:

```javascript
Client.prototype.sendStat = function (stat, value, type, sampleRate, tags, timestamp, cardinality, callback) {
  // Track metric in telemetry (even if sampled out, matching official Datadog behavior)
  if (this.telemetry) {
    this.telemetry.recordMetric(type);
  }

  // Sanitize metric name to prevent protocol-breaking characters
  const sanitizedStat = helpers.sanitizeMetricName(stat);
  sampleRate = sampleRate || this.sampleRate;

  // Client-side aggregation: counts, gauges and sets with no timestamp and no
  // sampling are combined per context and sent on the aggregation flush
  // interval. Delta gauges (string values like '+5') and non-numeric counts
  // pass through unaggregated. The callback fires synchronously as a "queued"
  // signal, like buffered mode.
  if (this.aggregator && (type === 'c' || type === 'g' || type === 's') &&
      timestamp === undefined &&
      (!sampleRate || sampleRate >= 1) &&
      (type === 's' || typeof value === 'number')) {
    debug('hot-shots sendStat: aggregating - stat=%s, type=%s', stat, type);
    this.aggregator.record(this, this.prefix + sanitizedStat + this.suffix, value, type, tags, cardinality);
    return callback ? callback() : undefined;
  }

  let message = `${this.prefix + sanitizedStat + this.suffix}:${value}|${type}`;
  if (sampleRate && sampleRate < 1) {
    // ... existing body unchanged (the `sampleRate = sampleRate || this.sampleRate;` line moves up) ...
```

(e) `close()` — at the top, next to the buffer interval clear:

```javascript
  // stop the aggregation flush interval and flush any aggregated metrics into
  // the send path before the final buffer flush below
  if (this.aggregationIntervalHandle) {
    clearInterval(this.aggregationIntervalHandle);
  }
  if (this.aggregator && !this.isChild) {
    try {
      this.aggregator.flush();
    } catch (err) {
      if (this.errorHandler) {
        try {
          this.errorHandler(err);
        } catch (handlerErr) {
          // Preserve the original flush error so the root cause is not masked by a buggy handler.
          console.error('hot-shots: errorHandler threw inside close aggregation flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: close aggregation flush threw: ${err && err.message}`);
      }
    }
  }
```

(f) `ChildClient` — add to the `Client.call(this, {...})` options object: `aggregator : parent.aggregator,`

(g) `types.d.ts`:

```typescript
export interface AggregationOptions {
  /** Interval in milliseconds between aggregation flushes. Default: 2000. */
  flushInterval?: number;
}
```

and in `ClientOptions`: `aggregation?: boolean | AggregationOptions;`

- [ ] **Step 5: Run tests** — `npx mocha test/aggregation.js --timeout 5000`, fix assertion details (tag merge order, callback args), then `npm test` — full suite PASS.

- [ ] **Step 6: Docs + commit** — README: new "Client-side aggregation" subsection (what aggregates, what bypasses, defaults, interaction with flush()/close()). CHANGES.md entry. CLAUDE.md core components list: add `lib/aggregator.js`. Commit `"Add opt-in client-side aggregation of counts, gauges and sets"`.

---

### Task 5: Final verification

- [ ] **Step 1:** `npm test` (full suite + lint) — PASS.
- [ ] **Step 2:** `npx mocha test/typescript-compilation.js --timeout 30000` — types compile (also covered by npm test).
- [ ] **Step 3:** Re-read README diff for accuracy; confirm CHANGES.md has all four entries in one new version section.
- [ ] **Step 4:** Final commit of any doc straggler.
