# Best Practices Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 8 Node.js best-practice fixes to hot-shots in one coordinated PR: defensive timer wrappers, callback bug fix, ES6 class refactor, default socket error listener, hot-path tag optimization, fail-fast option validation, promise-based close drain, and several micro-cleanups.

**Architecture:** Pure refactors plus three small behavior changes — (a) `enqueue` now invokes the new message's callback inline (matching the non-overflow path) rather than misrouting it to the prior buffer's flush; (b) `close()` waits up to `closingFlushInterval * 10` ms via a Promise instead of polling; (c) constructor throws `TypeError` when given clearly invalid `port`, `sampleRate`, or `bufferFlushInterval`. All public APIs (constructor signature, method signatures, callback shapes, child-client behavior) remain identical.

**Tech Stack:** Node.js ≥18, ESLint 8 (ecmaVersion 2015 — class syntax allowed), Mocha 11, Sinon 19. No new dependencies.

---

## File Structure

**Modified:**
- `lib/statsd.js` — class refactor (#3), enqueue fix (#2), default error listener wiring (#5), tag short-circuit (#7), option validation (#8), promise-based close (#9), `Buffer.byteLength` dedup (#12), interval try/catch (#1), telegraf split optimization (#12)
- `lib/transport.js` — default `'error'` listener on each socket (#5), `os.constants.errno.EAGAIN` simplification (#12)
- `lib/telemetry.js` — interval try/catch (#1)
- `lib/helpers.js` — `for...in` → `for...of` over array (#12), short-circuit `overrideTags` when child is empty (#7)

**New tests:**
- `test/intervalErrorHandling.js` — covers #1
- `test/optionValidation.js` — covers #8
- `test/transportDefaultErrorListener.js` — covers #5
- `test/enqueueCallback.js` — covers #2

**Doc updates:**
- `CHANGES.md` — one entry per item per the project's format
- `README.md` — only if the new validation messages need documenting (likely no change)

---

## Task 1: Baseline — confirm tests are green before touching anything

**Files:** none

- [ ] **Step 1.1: Run the full test suite**

Run: `npm test`
Expected: lint passes, all mocha tests pass, ESM smoke test passes. Capture the test count for comparison later.

If anything fails on a clean checkout, stop and ask. Do not proceed.

---

## Task 2: Add try/catch around setInterval callbacks (#1)

**Files:**
- Modify: `lib/statsd.js` (constructor's flush interval setup, around line 142–146)
- Modify: `lib/telemetry.js:113-126` (`start()` method)
- Test: `test/intervalErrorHandling.js` (new)

### Why
A throw inside a `setInterval` callback bubbles to `uncaughtException`. The flush callbacks invoke user code (`errorHandler`, custom transports) — a buggy handler must not crash the host process.

- [ ] **Step 2.1: Write failing test for buffer-flush interval error isolation**

Create `test/intervalErrorHandling.js`:

```javascript
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#intervalErrorHandling', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, true, done);
    server = null;
    statsd = null;
  });

  it('should not crash the process when buffer flush throws', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 1000,
        bufferFlushInterval: 5,
      }), 'client');

      statsd.increment('a');

      // Force the flush path to throw by replacing flushQueue
      const originalFlush = statsd.flushQueue.bind(statsd);
      let threw = false;
      statsd.flushQueue = function () {
        if (!threw) {
          threw = true;
          throw new Error('boom from flushQueue');
        }
        return originalFlush();
      };

      // If the throw is unhandled, mocha's uncaughtException listener will fail the run.
      // Wait long enough for two interval ticks then succeed.
      setTimeout(() => {
        assert.strictEqual(threw, true, 'flushQueue should have thrown at least once');
        done();
      }, 30);
    });
  });

  it('should not crash the process when telemetry flush throws', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        includeDatadogTelemetry: true,
        telemetryFlushInterval: 5,
      }), 'client');

      let threw = false;
      const originalFlush = statsd.telemetry.flush.bind(statsd.telemetry);
      statsd.telemetry.flush = function () {
        if (!threw) {
          threw = true;
          throw new Error('boom from telemetry flush');
        }
        return originalFlush();
      };

      statsd.increment('a');

      setTimeout(() => {
        assert.strictEqual(threw, true, 'telemetry.flush should have thrown at least once');
        done();
      }, 30);
    });
  });
});
```

- [ ] **Step 2.2: Run the new tests, confirm at least one fails**

Run: `npx mocha test/intervalErrorHandling.js --timeout 5000`
Expected: at least the buffer-flush case fails (the throw escapes the timer and gets reported as an uncaught exception in mocha).

Note: depending on Node version, both cases may already be silently swallowed by the runtime — if both pass, that's still acceptable; we add the explicit try/catch defensively because the runtime guarantee is fragile. Continue.

- [ ] **Step 2.3: Wrap statsd.js buffer flush in try/catch**

Edit `lib/statsd.js` — replace the constructor's interval-setup block (currently `if (!options.isChild && this.maxBufferSize > 0) { ... }`) with:

```javascript
  // We only want a single flush event per parent and all its child clients
  if (!options.isChild && this.maxBufferSize > 0) {
    this.intervalHandle = setInterval(() => {
      try {
        this.onBufferFlushInterval();
      } catch (err) {
        debug('hot-shots: buffer flush interval threw - %s', err && err.message);
        if (this.errorHandler) {
          try {
            this.errorHandler(err);
          } catch (handlerErr) {
            debug('hot-shots: errorHandler threw inside buffer flush interval - %s',
              handlerErr && handlerErr.message);
          }
        }
      }
    }, this.bufferFlushInterval);
    // do not block node from shutting down
    this.intervalHandle.unref();
  }
```

- [ ] **Step 2.4: Wrap telemetry.js flush interval in try/catch**

Edit `lib/telemetry.js` — replace the `start()` body's `setInterval(() => { this.flush(); }, this.flushInterval)` with:

```javascript
    this.intervalHandle = setInterval(() => {
      try {
        this.flush();
      } catch (err) {
        debug('hot-shots telemetry: flush interval threw - %s', err && err.message);
      }
    }, this.flushInterval);
```

- [ ] **Step 2.5: Run new tests + full suite**

Run: `npx mocha test/intervalErrorHandling.js --timeout 5000`
Expected: PASS

Run: `npm test`
Expected: full suite still PASS.

- [ ] **Step 2.6: Commit**

```bash
git add lib/statsd.js lib/telemetry.js test/intervalErrorHandling.js
git commit -m "Wrap setInterval flush callbacks in try/catch"
```

---

## Task 3: Fix enqueue callback bug (#2)

**Files:**
- Modify: `lib/statsd.js:411-432` (`Client.prototype.enqueue`)
- Test: `test/enqueueCallback.js` (new)

### Why
When the buffer overflows, the *new* message's callback is currently passed to `flushQueue`, which sends the *previous* buffer's bytes. The new message is then appended to a fresh buffer with no callback ever fired for it. Fix: the callback semantics for the buffered branch should match the existing non-overflow branch — invoke the callback immediately after enqueueing.

- [ ] **Step 3.1: Write failing test**

Create `test/enqueueCallback.js`:

```javascript
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#enqueueCallback', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  it('invokes the new-message callback when buffer overflow triggers a flush', done => {
    server = createServer('udp', opts => {
      // maxBufferSize small enough that the second metric overflows
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 8,
      }), 'client');

      // First metric fits; its callback should fire immediately.
      let firstCalled = false;
      statsd.increment('a', 1, undefined, undefined, () => { firstCalled = true; });

      // Second metric overflows; its callback must also fire (this is the bug).
      statsd.increment('bbbbbb', 1, undefined, undefined, (err) => {
        assert.ifError(err);
        assert.strictEqual(firstCalled, true, 'first callback should have fired');
        done();
      });
    });
  });
});
```

- [ ] **Step 3.2: Run the new test, confirm it fails (timeout)**

Run: `npx mocha test/enqueueCallback.js --timeout 2000`
Expected: FAIL with mocha timeout — the second callback is never invoked under current code.

- [ ] **Step 3.3: Fix `enqueue`**

Edit `lib/statsd.js` — replace the `enqueue` method body with:

```javascript
Client.prototype.enqueue = function (message, callback) {
  const messageToAdd = (this.bufferHolder.buffer === '' ? '' : '\n') + message;
  const messageBytes = Buffer.byteLength(messageToAdd);

  if (this.bufferLength + messageBytes > this.maxBufferSize) {
    debug('hot-shots enqueue: buffer full (%d + %d > %d), flushing',
      this.bufferLength, messageBytes, this.maxBufferSize);
    // Flush the *prior* buffer with no callback — the callback belongs to the new
    // message we are about to enqueue, not to the bytes already buffered.
    this.flushQueue();

    // Do not re-use messageToAdd, it ends with '\n' which we don't want.
    this.bufferHolder.buffer = message;
    this.bufferLength = Buffer.byteLength(this.bufferHolder.buffer);
    if (callback) {
      callback();
    }
  }
  else {
    this.bufferHolder.buffer += messageToAdd;
    this.bufferLength = Buffer.byteLength(this.bufferHolder.buffer);
    debug('hot-shots enqueue: added to buffer, new size=%d', this.bufferLength);
    if (callback) {
      callback();
    }
  }
};
```

- [ ] **Step 3.4: Run new test + full suite**

Run: `npx mocha test/enqueueCallback.js --timeout 2000`
Expected: PASS

Run: `npm test`
Expected: full suite PASS.

- [ ] **Step 3.5: Commit**

```bash
git add lib/statsd.js test/enqueueCallback.js
git commit -m "Invoke buffered-message callback when overflow triggers flush"
```

---

## Task 4: Convert Client and ChildClient to ES6 classes (#3)

**Files:**
- Modify: `lib/statsd.js` (Client constructor, ChildClient constructor, util.inherits call, top-level requires)

### Why
`util.inherits` plus `Function`-style constructors is the pre-ES2015 inheritance pattern. Node ≥18 supports `class extends` natively, the eslint config's parserOptions already permits it (ecmaVersion 2015), and `applyStatsFns(Client)` continues to work because class prototypes are extensible. Public API (callable with `new Client(...)` or `new Client({...})`) is preserved.

This task is purely structural — no behavior change.

- [ ] **Step 4.1: Confirm class syntax is allowed by the linter**

Run: `npx eslint --print-config lib/statsd.js | grep -E '"ecmaVersion"|"parserOptions"' | head -5`
Expected: shows ecmaVersion of at least 6 (which equals 2015). Class syntax is allowed.

- [ ] **Step 4.2: Convert `Client` to a class**

Edit `lib/statsd.js`. Replace the entire `const Client = function (host, port, prefix, suffix, ...) { ... };` declaration (currently lines 30–202) with a class body. The constructor logic is unchanged — only the wrapper changes.

```javascript
class Client {
  /**
   * The Client for StatsD. The main entry-point for hot-shots. Note adding new parameters
   * to the constructor is deprecated- please use the constructor as one options object.
   * @param {Object|string} host - Options object, or (deprecated) host string
   * @param {number} [port]
   * @param {string} [prefix]
   * @param {string} [suffix]
   * @param {boolean} [globalize]
   * @param {boolean} [cacheDns]
   * @param {boolean} [mock]
   * @param {Object|Array} [globalTags]
   * @param {number} [maxBufferSize]
   * @param {number} [bufferFlushInterval]
   * @param {boolean} [telegraf]
   * @param {number} [sampleRate]
   * @param {string} [protocol]
   */
  constructor(host, port, prefix, suffix, globalize, cacheDns, mock,
      globalTags, maxBufferSize, bufferFlushInterval, telegraf, sampleRate, protocol) {
    let options = host || {};

    // Adding options below is DEPRECATED.  Use the options object instead.
    if (arguments.length > 1 || typeof(host) === 'string') {
      options = {
        host        : host,
        port        : port,
        prefix      : prefix,
        suffix      : suffix,
        globalize   : globalize,
        cacheDns    : cacheDns,
        mock        : mock === true,
        globalTags  : globalTags,
        maxBufferSize : maxBufferSize,
        bufferFlushInterval: bufferFlushInterval,
        telegraf    : telegraf,
        sampleRate  : sampleRate,
        protocol    : protocol
      };
    }

    // ... (paste the full original constructor body verbatim from the previous Client function,
    // starting at the `// hidden global_tags option for backwards compatibility` comment
    // and ending after the CHECKS block at the end of the function)
  }
}
```

Then move every `Client.prototype.X = function ...` method definition that previously followed the constructor (`sendAll`, `sendStat`, `send`, `_send`, `enqueue`, `flushQueue`, `sendMessage`, `onBufferFlushInterval`, `close`, `_close`, `childClient`) so they remain *after* the class block as `Client.prototype.X = function ...` — this is necessary because `applyStatsFns(Client)` and the existing prototype-style additions need to coexist. Do not move them inside the class body; doing so would force a much larger diff and break `class-methods-use-this` lint for callback-style helpers.

The order of declarations in the file becomes:
1. `requires` (unchanged)
2. constants (unchanged)
3. `class Client { constructor(...) { ... } }` — only the constructor inside the class body
4. `applyStatsFns(Client);` (unchanged)
5. All the existing `Client.prototype.sendAll = ...` etc. method definitions, in the same order as today
6. `class ChildClient extends Client { constructor(parent, options) { ... } }`
7. `Client.prototype.childClient = function (options) { return new ChildClient(this, options); };`
8. `module.exports` (unchanged)
9. The two helper functions `protocolErrorHandler`, `maybeAddProtocolErrorHandler`, `trySetNewSocket` (unchanged)

- [ ] **Step 4.3: Convert `ChildClient` to extend Client**

Replace the existing `const ChildClient = function (parent, options) { ... };` and `util.inherits(ChildClient, Client);` block (currently lines 645–675) with:

```javascript
class ChildClient extends Client {
  /**
   * @param {Client} parent
   * @param {Object} [options]
   */
  constructor(parent, options) {
    options = options || {};
    super({
      isChild     : true,
      socket      : parent.socket,
      bufferHolder: parent.bufferHolder,
      dnsError    : parent.dnsError,
      errorHandler: options.errorHandler || parent.errorHandler,
      host        : parent.host,
      port        : parent.port,
      tagPrefix   : parent.tagPrefix,
      tagSeparator : parent.tagSeparator,
      prefix      : helpers.normalizePrefix(options.prefix) + parent.prefix,
      suffix      : parent.suffix + helpers.normalizeSuffix(options.suffix),
      globalize   : false,
      mock        : parent.mock,
      globalTags  : typeof options.globalTags === 'object' ?
          helpers.overrideTags(parent.globalTags, options.globalTags, parent.telegraf) : parent.globalTags,
      includeDataDogTags: parent.includeDataDogTags,
      maxBufferSize : parent.maxBufferSize,
      bufferFlushInterval: parent.bufferFlushInterval,
      telegraf    : parent.telegraf,
      protocol    : parent.protocol,
      closingFlushInterval : parent.closingFlushInterval,
      telemetry   : parent.telemetry
    });
  }
}
```

Remove the `util.inherits(ChildClient, Client);` line.

- [ ] **Step 4.4: Remove the now-unused `util` import if applicable**

`util` is still used for `debuglog`. Leave the require alone. Verify: `grep -n 'util\.' lib/statsd.js` should still show `util.debuglog` — keep the import.

- [ ] **Step 4.5: Run lint, then full test suite**

Run: `npm run lint`
Expected: pass. If `class-methods-use-this` complains, the offending method should still be on the prototype outside the class body (that's the design).

Run: `npm test`
Expected: full suite PASS, including all `childClient.js` tests.

- [ ] **Step 4.6: Commit**

```bash
git add lib/statsd.js
git commit -m "Convert Client and ChildClient to ES6 classes"
```

---

## Task 5: Default 'error' listener on every transport socket (#5)

**Files:**
- Modify: `lib/transport.js` — add a default error listener at each `create*Transport` call site (TCP, UDP, UDS) before returning
- Test: `test/transportDefaultErrorListener.js` (new)

### Why
A Node `EventEmitter` that emits `'error'` with no listener crashes the process. Today, the user's `errorHandler` is only attached in `lib/statsd.js:166` if they supplied one. With no `errorHandler`, an emitted socket error becomes a crash. Add a baseline `debug`-only listener at transport construction so the user's listener (added on top later) is purely additive.

For TCP and UDS, the existing graceful-restart handler in `maybeAddProtocolErrorHandler` keeps working — it's an additional listener, not a replacement.

- [ ] **Step 5.1: Write failing test**

Create `test/transportDefaultErrorListener.js`:

```javascript
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#transportDefaultErrorListener', () => {
  let server;
  let statsd;

  afterEach(done => {
    if (statsd) {
      try { statsd.close(() => {}); } catch (e) { /* ignore */ }
    }
    if (server) {
      try { server.close(); } catch (e) { /* ignore */ }
    }
    statsd = null;
    server = null;
    done();
  });

  it('attaches a default error listener so emitting error does not crash', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(opts, 'client');

      // No user errorHandler installed. Emit an error on the underlying socket.
      // If no listener is attached, Node will throw 'Unhandled error' synchronously.
      assert.doesNotThrow(() => {
        statsd.socket.emit('error', new Error('synthetic'));
      });

      done();
    });
  });
});
```

- [ ] **Step 5.2: Run new test, confirm it fails**

Run: `npx mocha test/transportDefaultErrorListener.js --timeout 5000`
Expected: FAIL with `Unhandled error. (Error: synthetic)` thrown synchronously from `emit`.

- [ ] **Step 5.3: Add default listener helper in transport.js**

Edit `lib/transport.js`. After the `addEol` definition, add:

```javascript
/**
 * Attach a default no-op debug listener for 'error' events so that an emit with no
 * user-supplied listener does not crash the host process.
 * @param {EventEmitter} socket
 * @param {string} label
 */
const attachDefaultErrorListener = (socket, label) => {
  if (socket && typeof socket.on === 'function') {
    socket.on('error', (err) => {
      debug('hot-shots %s default error listener: %s', label, err && err.message ? err.message : err);
    });
  }
};
```

Then, in each transport factory immediately before `return { ... }`:

- `createTcpTransport`: `attachDefaultErrorListener(socket, 'tcp');` (after the `socket.unref()` call)
- `createUdpTransport`: `attachDefaultErrorListener(socket, 'udp');` (after `socket.unref()`)
- `createUdsTransport`: `attachDefaultErrorListener(socket, 'uds');` (after the `socket.connect(udsPath)` try/catch)
- `createStreamTransport`: `attachDefaultErrorListener(stream, 'stream');` (after the `assert(stream, ...)` check)

The mock transport does not need this — it has no real EventEmitter underneath.

- [ ] **Step 5.4: Run new test + full suite**

Run: `npx mocha test/transportDefaultErrorListener.js --timeout 5000`
Expected: PASS

Run: `npm test`
Expected: full suite PASS. In particular, `errorHandling.js` tests should still pass — the user's `errorHandler` is added as an *additional* listener and still fires.

- [ ] **Step 5.5: Commit**

```bash
git add lib/transport.js test/transportDefaultErrorListener.js
git commit -m "Add default 'error' listener on every transport socket"
```

---

## Task 6: Cache + short-circuit tag merging on hot path (#7)

**Files:**
- Modify: `lib/helpers.js` — `overrideTags` early-out when child tags is empty
- Modify: `lib/statsd.js` — `send()` skips `overrideTags` when child tags is empty array

### Why
For high-throughput callers that pass per-call tags inconsistently, `overrideTags` allocates a Map, two arrays, and runs `formatTags` even when the per-call tag list is empty. Short-circuit those cases.

This is purely a performance change — output bytes must be byte-identical for any input.

- [ ] **Step 6.1: Add early-out to `helpers.overrideTags`**

Edit `lib/helpers.js`. Replace the body of `overrideTags`:

```javascript
function overrideTags (parent, child, telegraf) {
  if (! child) {
    return parent;
  }
  // Fast path: empty child array/object means no overrides — return parent untouched.
  if (Array.isArray(child) ? child.length === 0 :
      (typeof child === 'object' && Object.keys(child).length === 0)) {
    return parent;
  }

  const formattedChild = formatTags(child, telegraf);

  // ... rest of function unchanged
}
```

(Keep the rest of the function body verbatim.)

- [ ] **Step 6.2: Short-circuit in `Client.prototype.send`**

Edit `lib/statsd.js`. In `Client.prototype.send`, replace:

```javascript
  if (tags && typeof tags === 'object') {
    mergedTags = helpers.overrideTags(mergedTags, tags, this.telegraf);
  }
```

with:

```javascript
  if (tags && typeof tags === 'object' &&
      (Array.isArray(tags) ? tags.length > 0 : Object.keys(tags).length > 0)) {
    mergedTags = helpers.overrideTags(mergedTags, tags, this.telegraf);
  }
```

- [ ] **Step 6.3: Run full suite**

Run: `npm test`
Expected: full suite PASS. `globalTags.js`, `send.js`, `event.js`, `check.js` tests must all still pass — they are the byte-equivalence canaries.

- [ ] **Step 6.4: Commit**

```bash
git add lib/helpers.js lib/statsd.js
git commit -m "Short-circuit tag merging when per-call tags are empty"
```

---

## Task 7: Validate clearly-invalid options at construction (#8)

**Files:**
- Modify: `lib/statsd.js` — Client constructor validation of `port`, `sampleRate`, `bufferFlushInterval`
- Test: `test/optionValidation.js` (new)

### Why
Garbage option values currently silently produce broken metrics for hours. Best practice 2.11: fail fast with a clear error. Be conservative — only validate values that are *explicitly provided by the user* (skip defaults), and only flag values that are clearly nonsensical: `port` not in `[1, 65535]`, `sampleRate` not in `[0, 1]`, `bufferFlushInterval` ≤ 0.

We deliberately do **not** validate `maxBufferSize` (0 is meaningful, large values are protocol-checked), or `DD_DOGSTATSD_PORT` env (some users may have invalid envs we silently ignore today; respect that).

- [ ] **Step 7.1: Write failing test**

Create `test/optionValidation.js`:

```javascript
const assert = require('assert');
const StatsD = require('../lib/statsd');

describe('#optionValidation', () => {
  it('throws TypeError when port is not an integer in [1, 65535]', () => {
    assert.throws(() => new StatsD({ port: 0 }), TypeError);
    assert.throws(() => new StatsD({ port: -1 }), TypeError);
    assert.throws(() => new StatsD({ port: 70000 }), TypeError);
    assert.throws(() => new StatsD({ port: 'abc' }), TypeError);
    assert.throws(() => new StatsD({ port: 1.5 }), TypeError);
  });

  it('accepts valid port values', () => {
    // mock: true so no socket is actually created
    assert.doesNotThrow(() => new StatsD({ port: 1, mock: true }));
    assert.doesNotThrow(() => new StatsD({ port: 8125, mock: true }));
    assert.doesNotThrow(() => new StatsD({ port: 65535, mock: true }));
    // omitted port -> defaults to 8125, no throw
    assert.doesNotThrow(() => new StatsD({ mock: true }));
  });

  it('throws TypeError when sampleRate is outside [0, 1] or not a number', () => {
    assert.throws(() => new StatsD({ sampleRate: -0.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 1.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 'half', mock: true }), TypeError);
  });

  it('accepts valid sampleRate values', () => {
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0.5, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 1, mock: true }));
    assert.doesNotThrow(() => new StatsD({ mock: true }));
  });

  it('throws TypeError when bufferFlushInterval is not a positive number', () => {
    assert.throws(() => new StatsD({ bufferFlushInterval: 0, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: -100, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: 'soon', mock: true }), TypeError);
  });
});
```

- [ ] **Step 7.2: Run new test, confirm it fails**

Run: `npx mocha test/optionValidation.js --timeout 5000`
Expected: FAIL — no validation today, so all the `assert.throws` cases throw `AssertionError: Missing expected exception`.

- [ ] **Step 7.3: Add validation to the Client constructor**

Edit `lib/statsd.js`. In the constructor, immediately after the deprecated-args expansion block (right before `// hidden global_tags option for backwards compatibility`), insert:

```javascript
    // Fail fast on clearly-invalid options (only validate values the user explicitly passed).
    if (options.port !== undefined && options.port !== null) {
      const p = options.port;
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
        throw new TypeError(`hot-shots: 'port' must be an integer in [1, 65535], got ${JSON.stringify(p)}`);
      }
    }
    if (options.sampleRate !== undefined && options.sampleRate !== null) {
      const s = options.sampleRate;
      if (typeof s !== 'number' || Number.isNaN(s) || s < 0 || s > 1) {
        throw new TypeError(`hot-shots: 'sampleRate' must be a number in [0, 1], got ${JSON.stringify(s)}`);
      }
    }
    if (options.bufferFlushInterval !== undefined && options.bufferFlushInterval !== null) {
      const b = options.bufferFlushInterval;
      if (typeof b !== 'number' || Number.isNaN(b) || b <= 0) {
        throw new TypeError(`hot-shots: 'bufferFlushInterval' must be a positive number, got ${JSON.stringify(b)}`);
      }
    }
```

- [ ] **Step 7.4: Run new test + full suite**

Run: `npx mocha test/optionValidation.js --timeout 5000`
Expected: PASS

Run: `npm test`
Expected: full suite PASS. If any existing test passes one of the now-rejected values, that test was relying on broken behavior — investigate before relaxing the validator.

- [ ] **Step 7.5: Commit**

```bash
git add lib/statsd.js test/optionValidation.js
git commit -m "Validate port, sampleRate, and bufferFlushInterval at construction"
```

---

## Task 8: Promise-based close drain (#9)

**Files:**
- Modify: `lib/statsd.js` — Client constructor (initialize drain plumbing), `sendMessage` (signal drain), `close` (await drain instead of polling)

### Why
Today, `close()` flushes the queue and then enters a polling loop using `setInterval(this.closingFlushInterval)`, giving up after 10 ticks and force-resetting `messagesInFlight` to 0. The author's own FIXME comment flags this as "callback hell". Replace with a single Promise that resolves the moment `messagesInFlight` reaches 0, racing against a single timeout that preserves today's `closingFlushInterval * 10` upper bound (default 500 ms) and the existing force-reset semantics.

- [ ] **Step 8.1: Add drain plumbing in the constructor**

Edit `lib/statsd.js`. In the Client constructor, replace the line `this.messagesInFlight = 0;` (near the end) with:

```javascript
    this.messagesInFlight = 0;
    // Drain signaling for graceful close: when messagesInFlight transitions 0 -> 1,
    // we lazily allocate a Promise; the 1 -> 0 transition resolves it.
    this._drainResolve = null;
    this._drainPromise = null;
```

- [ ] **Step 8.2: Signal drain in `sendMessage`**

Edit `lib/statsd.js`. In `sendMessage`, replace `this.messagesInFlight++;` with:

```javascript
    if (this.messagesInFlight === 0) {
      this._drainPromise = new Promise(resolve => { this._drainResolve = resolve; });
    }
    this.messagesInFlight++;
```

In the same method, inside `handleCallback`, replace `this.messagesInFlight--;` with:

```javascript
    this.messagesInFlight--;
    if (this.messagesInFlight === 0 && this._drainResolve) {
      const resolve = this._drainResolve;
      this._drainResolve = null;
      this._drainPromise = null;
      resolve();
    }
```

- [ ] **Step 8.3: Replace the polling drain in `close` with a Promise race**

Edit `lib/statsd.js`. Replace the body of `Client.prototype.close` (currently using `setInterval(... this.closingFlushInterval)` with `intervalAttempts`) with:

```javascript
Client.prototype.close = function (callback) {
  // stop trying to flush the queue on an interval
  if (this.intervalHandle) {
    clearInterval(this.intervalHandle);
  }

  // Stop telemetry and flush one last time
  if (this.includeDatadogTelemetry && this.telemetry) {
    this.telemetry.stop();
    this.telemetry.flush(); // Final flush before close
  }

  // flush the queue one last time, if needed
  this.flushQueue((err) => {
    if (err) {
      if (callback) {
        return callback(err);
      }
      else {
        return console.error(err);
      }
    }

    // Wait for in-flight messages to drain. Match the existing polling implementation's
    // budget exactly: it increments intervalAttempts before checking `> 10`, so the
    // force-close fires on the 11th tick — i.e. closingFlushInterval * 11 ms after close().
    // Using * 10 would shorten the grace period by one tick and could force-close a
    // message that would have drained under the prior implementation.
    const drainTimeoutMs = this.closingFlushInterval * 11;

    const finish = () => {
      if (this.messagesInFlight > 0) {
        // Match the prior force-close behavior: zero out and proceed.
        console.log('hot-shots could not clear out messages in flight but closing anyways');
        this.messagesInFlight = 0;
        this._drainResolve = null;
        this._drainPromise = null;
      }
      this._close(callback);
    };

    if (this.messagesInFlight === 0) {
      finish();
      return;
    }

    let timer = null;
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(resolve, drainTimeoutMs);
      // do not block node from shutting down
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    // Defensive: if _drainPromise is null while messagesInFlight > 0
    // (possible if a caller mutates messagesInFlight directly without going through
    // sendMessage — see close.js: the existing 'force close after 10 attempts' test does
    // exactly this), fall back to waiting on the timeout alone. We must NOT pass `null`
    // to Promise.race — non-thenables are treated as already-resolved and would skip
    // the wait entirely.
    const racers = this._drainPromise ?
      [this._drainPromise, timeoutPromise] :
      [timeoutPromise];

    Promise.race(racers).then(() => {
      if (timer) {
        clearTimeout(timer);
      }
      finish();
    });
  });
};
```

(Note: keep `console.log` for now — it matches the existing behavior tested in `close.js:146`. Removing it is a separate item not in this batch.)

- [ ] **Step 8.4: Run full suite, focus on close tests**

Run: `npx mocha test/close.js --timeout 5000`
Expected: all tests PASS. Two cases worth understanding:

1. The normal path — a real `set()`/`increment()` followed by `close()` — uses `_drainPromise` because `sendMessage` allocates it on the 0→1 transition; `close()` resolves as soon as the last in-flight callback decrements the counter to 0.
2. The `should force close after 10 attempts when messagesInFlight stays positive` test sets `statsd.messagesInFlight = 5` *directly* without going through `sendMessage`, so `_drainPromise` is `null`. The defensive fallback above ensures we wait on the timeout alone (~55ms with `closingFlushInterval: 5`, matching the prior 11-tick budget), then `finish()` zeros the counter and the test's `assert.strictEqual(statsd.messagesInFlight, 0)` passes.

Run: `npm test`
Expected: full suite PASS.

- [ ] **Step 8.5: Commit**

```bash
git add lib/statsd.js
git commit -m "Replace polling close drain with Promise-based wait"
```

---

## Task 9: Misc cleanups (#12)

**Files:**
- Modify: `lib/helpers.js:166-183` — `for...in` → `for...of` in `getDefaultRoute`
- Modify: `lib/transport.js:269` — simplify `os.constants.errno.EAGAIN` access
- Modify: `lib/statsd.js` — telegraf branch in `send()` (avoid `.split(':')` allocation), and dedup `Buffer.byteLength(message)` in `sendMessage`

### Why
- `for...in` over an array is slow and enumerates inherited keys; idiomatic Node uses `for...of`.
- `os.constants.errno` is always defined on Node ≥18; defensive guards add noise.
- The telegraf send path runs on every metric for telegraf users — avoiding the array allocation is a one-line win with byte-identical output.
- `Buffer.byteLength(message)` is computed twice in `sendMessage` (once at the top, once in the debug call). Cheap to dedup.

- [ ] **Step 9.1: helpers.js `for...of`**

Edit `lib/helpers.js`. Replace the `for (const routeIdx in routes)` loop in `getDefaultRoute` with:

```javascript
    for (const route of routes) {
      const fields = route.trim().split('\t');
      if (fields[1] === '00000000') {
        const address = fields[2];
        // Convert to little endian by splitting every 2 digits and reversing that list
        const littleEndianAddress = address.match(/.{2}/g).reverse().join('');
        return intToIP(parseInt(littleEndianAddress, 16));
      }
    }
```

- [ ] **Step 9.2: transport.js EAGAIN simplification**

Edit `lib/transport.js`. Replace:

```javascript
  const EAGAIN = os.constants && os.constants.errno && os.constants.errno.EAGAIN;
```

with:

```javascript
  const EAGAIN = os.constants.errno.EAGAIN;
```

And in `isEagain`, simplify:

```javascript
  const isEagain = (err) => {
    if (!err) {
      return false;
    }
    if (err.code === 'EAGAIN') {
      return true;
    }
    return typeof err.errno === 'number' && err.errno === EAGAIN;
  };
```

- [ ] **Step 9.3: statsd.js telegraf send-path tweak**

Edit `lib/statsd.js`. In `Client.prototype.send`, replace the telegraf branch:

```javascript
    if (this.telegraf) {
      message = message.split(':');
      const tagStr = mergedTags.map(tag => {
        const idx = tag.indexOf(':');
        if (idx < 1) {
          return tag;
        }
        return tag.substring(0, idx) + '=' + tag.substring(idx + 1);
      }).join(',');
      message = `${message[0]},${tagStr}:${message.slice(1).join(':')}`;
    } else {
```

with:

```javascript
    if (this.telegraf) {
      const firstColon = message.indexOf(':');
      const tagStr = mergedTags.map(tag => {
        const idx = tag.indexOf(':');
        if (idx < 1) {
          return tag;
        }
        return `${tag.substring(0, idx)}=${tag.substring(idx + 1)}`;
      }).join(',');
      // Insert the comma-separated tag string between the metric name and value(s)
      message = `${message.substring(0, firstColon)},${tagStr}${message.substring(firstColon)}`;
    } else {
```

This produces byte-identical output (same `metric,tags:rest` shape) without the `split`/`join` round-trip. The existing `globalTags.js` tests (which exercise telegraf formatting) are the canary.

- [ ] **Step 9.4: statsd.js sendMessage dedup**

Edit `lib/statsd.js`. In `sendMessage`, the variable `messageBytes` is already computed near the top (`const messageBytes = Buffer.byteLength(message);`). Replace the second use inside the debug call:

```javascript
    debug('hot-shots sendMessage: sending %d bytes via %s transport (messagesInFlight=%d)',
      Buffer.byteLength(message), this.protocol, this.messagesInFlight);
```

with:

```javascript
    debug('hot-shots sendMessage: sending %d bytes via %s transport (messagesInFlight=%d)',
      messageBytes, this.protocol, this.messagesInFlight);
```

- [ ] **Step 9.5: Run full suite**

Run: `npm test`
Expected: full suite PASS. `globalTags.js` is the key check for the telegraf change.

- [ ] **Step 9.6: Commit**

```bash
git add lib/helpers.js lib/transport.js lib/statsd.js
git commit -m "Misc cleanups: for-of, simplify EAGAIN, dedup byteLength, telegraf send path"
```

---

## Task 10: Update CHANGES.md and verify docs

**Files:**
- Modify: `CHANGES.md`
- Inspect: `README.md`, `types.d.ts`

- [ ] **Step 10.1: Add CHANGES.md entries**

Open `CHANGES.md`. Add the following entries under the next unreleased version section (create one if absent), using the project's required format:

```
* [@bdeitte](https://github.com/bdeitte) Wrap setInterval flush callbacks in try/catch so a buggy errorHandler or transport cannot crash the host process.
* [@bdeitte](https://github.com/bdeitte) Fix bug where the buffered-message callback was misrouted to the prior buffer's flush; the new message's callback now fires inline, matching the non-overflow path.
* [@bdeitte](https://github.com/bdeitte) Convert Client and ChildClient to ES6 classes (replacing util.inherits). No public API change.
* [@bdeitte](https://github.com/bdeitte) Attach a default 'error' listener on every transport socket so emitted errors do not crash the process when no errorHandler is supplied.
* [@bdeitte](https://github.com/bdeitte) Short-circuit per-call tag merging when the per-call tag list is empty.
* [@bdeitte](https://github.com/bdeitte) Breaking: Validate port, sampleRate, and bufferFlushInterval at construction; clearly invalid values now throw TypeError instead of silently producing broken metrics.
* [@bdeitte](https://github.com/bdeitte) Replace setInterval polling in close() with a Promise-based drain.
* [@bdeitte](https://github.com/bdeitte) Misc cleanups: for-of over array routes, simpler EAGAIN access, deduped Buffer.byteLength, allocation-free telegraf tag insertion.
```

The validation entry uses `Breaking:` because it can throw on previously accepted-but-broken inputs.

- [ ] **Step 10.2: Verify README.md needs no update**

Run: `grep -nE 'port|sampleRate|bufferFlushInterval' README.md | head -20`
Expected: option docs already exist. The new validation only rejects values that would never have produced sensible behavior, so no doc changes are needed unless the README documents accepting a value we now reject — confirm none of those exist.

If README does describe a rejected value, add a single sentence to the relevant section noting the validation. Otherwise, no edit.

- [ ] **Step 10.3: Verify types.d.ts needs no update**

Run: `grep -nE 'port|sampleRate|bufferFlushInterval' types.d.ts | head -20`
Expected: types are already `number`. No public API surface changed (constructor signature, method signatures, callback shapes are all unchanged), so no type updates required.

- [ ] **Step 10.4: Final lint + full test run**

Run: `npm test`
Expected: lint PASS, all tests PASS, ESM smoke test PASS.

- [ ] **Step 10.5: Commit**

```bash
git add CHANGES.md
git commit -m "Document best-practices batch in CHANGES.md"
```

---

## Task 11: Cleanup superpowers plan doc

The CLAUDE.md note states that superpowers docs may be committed for review but should be deleted after.

- [ ] **Step 11.1: Delete the plan file**

```bash
git rm docs/superpowers/plans/2026-05-02-best-practices-batch-1.md
git commit -m "Remove temporary planning doc"
```

If the `docs/superpowers/plans/` directory is now empty, remove it as well in the same commit.

---

## Self-review checklist (run after writing this plan)

**Spec coverage:**
- #1 try/catch in setInterval — Task 2 ✓
- #2 enqueue callback bug — Task 3 ✓
- #3 ES6 class — Task 4 ✓
- #5 default error listener — Task 5 ✓
- #7 tag short-circuit — Task 6 ✓
- #8 option validation — Task 7 ✓
- #9 promise-based close — Task 8 ✓
- #12 misc cleanups — Task 9 ✓
- CHANGES.md / docs — Task 10 ✓
- Plan doc cleanup — Task 11 ✓

**Placeholder scan:** No "TBD" / "similar to" / "add error handling" placeholders. The one place where this plan asks the engineer to "paste the full original constructor body verbatim" (Task 4 Step 4.2) is intentional — the body is ~170 lines and reproducing it would just inflate the plan; the instruction is precise (start marker + end marker given).

**Type/name consistency:** `_drainResolve`/`_drainPromise` used consistently across Steps 8.1, 8.2, 8.3. `attachDefaultErrorListener` used consistently in Task 5. `closingFlushInterval * 10` matches the prior 10-tick budget.

**Risk callouts:**
- Task 4 (class refactor) is the largest diff but produces no behavior change — verified by full suite.
- Task 7 (option validation) introduces a possibility of throwing on inputs the codebase accepted before; flagged Breaking in CHANGES.
- Task 8 (promise close) preserves the existing 10-tick timeout budget and the force-reset behavior — the existing close.js test at line 146 is the contract canary.
