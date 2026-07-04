# DogStatsD-Parity Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 12 findings from the `dogstatsd-parity` branch code review (correctness bugs in client-side aggregation, a transport-config bug, dead code, duplicated plumbing, docs, and test-timer hygiene).

**Architecture:** Most findings live in the aggregation path (`lib/aggregator.js` context keying and flush) and its callers in `lib/statsd.js`. Fixes are made incrementally with a failing test first, keeping each task independently reviewable. Two decisions were confirmed with the maintainer: finding #5 is *fixed* (the pending same-context gauge is flushed before a bypassing gauge), and finding #6 adds a *configurable, default-on* context cap.

**Tech Stack:** Node.js (>= 18), Mocha, Sinon, ESLint 8, nyc.

## Global Constraints

- Node.js >= 18.0.0.
- No new runtime dependencies (unix-dgram stays optional).
- Lint rules (enforced by `npm test` pretest): single quotes; curly braces on all if/else; ternary `?`/`:` at end of line; operator-linebreak "after"; no trailing spaces; JSDoc (`require-jsdoc`) on every function; sorted imports (`sort-imports`).
- Every new/changed function needs a JSDoc block.
- Real errors must reach `errorHandler` if set, else `console.error` — never `debug()`-only. Use the project convention:
  ```js
  } catch (err) {
    if (client.errorHandler) {
      try { client.errorHandler(err); }
      catch (handlerErr) { console.error(`hot-shots: errorHandler threw inside <context>: ${handlerErr && handlerErr.message}`); }
    } else {
      console.error(`hot-shots: <context> threw: ${err && err.message}`);
    }
  }
  ```
- Run the full suite with `npm test` (runs lint + Mocha). Run a single file with `npx mocha test/<file>.js --timeout 5000`.
- Note user-facing changes in `CHANGES.md` using: `* [@bdeitte](https://github.com/bdeitte/bdeitte) Description` — actual format: `* [@bdeitte](https://github.com/bdeitte) Description`. Link `#NNN` refs to `https://github.com/bdeitte/hot-shots/issues/NNN`.
- Update `README.md` and `types.d.ts` only where an API/option actually changes (tasks 9 flag this explicitly).

---

### Task 1: Remove dead code (finding #12)

**Files:**
- Modify: `lib/aggregator.js:178` (remove unused export)
- Modify: `lib/helpers.js:304` (remove unreachable `Number.isNaN(port)` check)

**Interfaces:**
- Consumes: nothing.
- Produces: no API change. `DEFAULT_AGGREGATION_FLUSH_INTERVAL` remains a module-internal const; only the `module.exports.` re-export is deleted.

- [ ] **Step 1: Confirm the export is unreferenced**

Run: `grep -rn "DEFAULT_AGGREGATION_FLUSH_INTERVAL" lib test index.js index.mjs`
Expected: matches only in `lib/aggregator.js` (the `const` on line 4, its use on line 18, and the export on line 178). No references in `test/` or entry points.

- [ ] **Step 2: Remove the unused export**

In `lib/aggregator.js`, delete the final export line so the file ends with:

```js
module.exports = Aggregator;
```

(Delete `module.exports.DEFAULT_AGGREGATION_FLUSH_INTERVAL = DEFAULT_AGGREGATION_FLUSH_INTERVAL;`)

- [ ] **Step 3: Remove the dead NaN guard in the URL port parser**

In `lib/helpers.js`, the `/^\d+$/` test on `portStr` already guarantees a non-empty digit string, so `parseInt` can never return `NaN`. Change:

```js
      const port = parseInt(portStr, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
```

to:

```js
      const port = parseInt(portStr, 10);
      if (port < 1 || port > 65535) {
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (no behavior change; existing DD_DOGSTATSD_URL tests still cover the port bounds).

- [ ] **Step 5: Commit**

```bash
git add lib/aggregator.js lib/helpers.js
git commit -m "Remove dead aggregator export and unreachable NaN port guard"
```

---

### Task 2: Env transport must respect useDefaultRoute (finding #2)

**Files:**
- Modify: `lib/statsd.js:60-61` (constructor env-transport guard)
- Test: `test/transport.js` (or the existing DD env-transport test file — see Step 1)

**Interfaces:**
- Consumes: `helpers.getDogstatsdEnvTransport()` (unchanged).
- Produces: no API change. `useDefaultRoute: true` now suppresses DD_DOGSTATSD_URL/DD_DOGSTATSD_SOCKET env-transport selection, keeping the client on UDP so the later `this.host = defaultRoute` assignment applies.

- [ ] **Step 1: Locate the env-transport test file**

Run: `grep -rln "DD_DOGSTATSD_SOCKET\|getDogstatsdEnvTransport\|DD_DOGSTATSD_URL" test`
Add the new test to the file that already exercises env-transport selection. If none exists, create `test/envTransport.js` with the standard header:

```js
const assert = require('assert');
const createHotShotsClient = require('./helpers/helpers.js').createHotShotsClient;
```

- [ ] **Step 2: Write the failing test**

```js
describe('#useDefaultRoute with DD env transport', () => {
  const origSocket = process.env.DD_DOGSTATSD_SOCKET;
  afterEach(() => {
    if (origSocket === undefined) {
      delete process.env.DD_DOGSTATSD_SOCKET;
    } else {
      process.env.DD_DOGSTATSD_SOCKET = origSocket;
    }
  });

  it('should stay a UDP client when useDefaultRoute is set even if DD_DOGSTATSD_SOCKET is present', () => {
    process.env.DD_DOGSTATSD_SOCKET = '/tmp/dsd.sock';
    const statsd = createHotShotsClient({ useDefaultRoute: true, mock: true }, 'client');
    assert.strictEqual(statsd.protocol, 'udp');
    assert.strictEqual(statsd.path, undefined);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx mocha test/envTransport.js --timeout 5000`
Expected: FAIL — `statsd.protocol` is `'uds'` and `statsd.path` is `/tmp/dsd.sock` because the guard ignores `useDefaultRoute`.

- [ ] **Step 4: Add useDefaultRoute to the guard**

In `lib/statsd.js`, change:

```js
  if (!options.telegraf &&
      !options.protocol && !options.host && !options.port && !options.path && !options.stream) {
```

to:

```js
  if (!options.telegraf && !options.useDefaultRoute &&
      !options.protocol && !options.host && !options.port && !options.path && !options.stream) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx mocha test/envTransport.js --timeout 5000`
Expected: PASS.

- [ ] **Step 6: Run the full suite and note the change**

Run: `npm test`
Expected: PASS. Add to `CHANGES.md`:

```
* [@bdeitte](https://github.com/bdeitte) Fix: useDefaultRoute now takes precedence over DD_DOGSTATSD_URL/DD_DOGSTATSD_SOCKET env transport instead of being silently overridden
```

- [ ] **Step 7: Commit**

```bash
git add lib/statsd.js test/envTransport.js CHANGES.md
git commit -m "Respect useDefaultRoute over DD env transport"
```

---

### Task 3: Fix garbled README "sets aside" (finding #8)

**Files:**
- Modify: `README.md:570`

**Interfaces:** Docs only.

- [ ] **Step 1: Fix the sentence**

In `README.md`, change:

```
The following always bypass aggregation and are sent immediately: histograms, distributions, timings, sets aside, events and service checks, plus any count/gauge/set that uses a *per-call* sample rate, a timestamp, a delta gauge (`+`/`-` value), or a `NaN` value.
```

to:

```
The following always bypass aggregation and are sent immediately: histograms, distributions, timings, events and service checks, plus any count/gauge/set that uses a *per-call* sample rate, a timestamp, a delta gauge (`+`/`-` value), or a `NaN` value.
```

(Removes the stray "sets aside," which contradicted "Sets emit each unique value once" a few lines above.)

- [ ] **Step 2: Verify no other stray phrasing**

Run: `grep -n "sets aside" README.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Fix garbled 'sets aside' phrasing in aggregation README"
```

---

### Task 4: Isolate per-context send errors in aggregator.flush (finding #1)

**Files:**
- Modify: `lib/aggregator.js` (`Aggregator.prototype.flush`, add `sendContext` helper)
- Test: `test/aggregation.js`

**Interfaces:**
- Produces: `Aggregator.prototype.sendContext(context)` — sends one context through `context.client.send` and calls `trackActive`; may throw if the client's send throws. `flush()` now wraps each context's send in try/catch, routing a throw through `context.client.errorHandler` else `console.error`, and continues the loop.

- [ ] **Step 1: Write the failing test**

Add to `test/aggregation.js`:

```js
  it('should not drop remaining contexts when one context send throws', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected per-context send error */ };
    statsd.gauge('agg.throws', 1, ['k:a']);
    statsd.gauge('agg.ok', 2, ['k:b']);
    // Make the first context's send throw; the second must still be sent.
    const realSend = statsd.send.bind(statsd);
    let threwOnce = false;
    statsd.send = (message, tags, cardinality, cb) => {
      if (!threwOnce && message.indexOf('agg.throws') === 0) {
        threwOnce = true;
        throw new Error('boom');
      }
      return realSend(message, tags, cardinality, cb);
    };
    try {
      statsd.flush();
    } finally {
      console.error = originalConsoleError;
    }
    assert.ok(statsd.mockBuffer.some(m => m.indexOf('agg.ok:2|g') === 0),
      'a throwing context aborted the flush and dropped the remaining context');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — the throw aborts the loop, so `agg.ok` never reaches `mockBuffer`.

- [ ] **Step 3: Extract `sendContext` and wrap the flush loop**

In `lib/aggregator.js`, add this method (place it directly above `flush`):

```js
/**
 * Sends a single aggregated context through its recording client's send path,
 * then records that client if its send is left in flight. May throw if the
 * client's send throws synchronously; callers isolate that.
 * @param context The aggregated context to send.
 */
Aggregator.prototype.sendContext = function (context) {
  if (context.type === 's') {
    for (const value of context.value) {
      context.client.send(`${context.name}:${value}|s`, context.tags, context.cardinality);
    }
  } else {
    context.client.send(`${context.name}:${context.value}|${context.type}`, context.tags, context.cardinality);
  }
  // Record the client only while its send is genuinely in flight; trackActive
  // self-prunes so this never grows without bound.
  this.trackActive(context.client);
};
```

Then replace the body of the `for` loop in `flush` with an isolated call:

```js
  for (const context of contexts.values()) {
    // Isolate each context: a synchronous throw from one client's send must not
    // abort the loop and silently drop every remaining context (their per-metric
    // callbacks already reported success at record time).
    try {
      this.sendContext(context);
    } catch (err) {
      if (context.client.errorHandler) {
        try {
          context.client.errorHandler(err);
        } catch (handlerErr) {
          console.error('hot-shots: errorHandler threw inside aggregator flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: aggregator flush send threw: ${err && err.message}`);
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS.

- [ ] **Step 5: Run the full suite and note the change**

Run: `npm test`
Expected: PASS. Add to `CHANGES.md`:

```
* [@bdeitte](https://github.com/bdeitte) Fix: a throwing send during an aggregation flush no longer drops the remaining aggregated contexts; each context's send is isolated and errors routed through errorHandler/console.error
```

- [ ] **Step 6: Commit**

```bash
git add lib/aggregator.js test/aggregation.js CHANGES.md
git commit -m "Isolate per-context send errors in aggregator flush"
```

---

### Task 5: Drop `typeof` from the object-tag context key (finding #7)

**Files:**
- Modify: `lib/aggregator.js` (`contextKey`, object-tags branch)
- Test: `test/aggregation.js`

**Interfaces:**
- Produces: object-tag key entries become `[k, String(tags[k])]` (was `[k, typeof tags[k], String(tags[k])]`). Emission already goes through `String(value)`, so `typeof` could only over-split, never protect.

- [ ] **Step 1: Write the failing test**

Add to `test/aggregation.js`:

```js
  it('should treat object tags with equal String() forms as one context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.strform', 1, { a: 1 });
    statsd.gauge('agg.strform', 5, { a: '1' });
    statsd.flush();
    // 1 and '1' both emit as a:1, so they must aggregate into one gauge (last wins).
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.strform:5|g|#a:1']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — `typeof 1` (`'number'`) vs `typeof '1'` (`'string'`) split into two contexts, so `mockBuffer` has two byte-identical `a:1` entries.

- [ ] **Step 3: Remove `typeof` from the key entries**

In `lib/aggregator.js`, change:

```js
    tagsKey = JSON.stringify(Object.keys(tags).sort().map(k => {
      return [k, typeof tags[k], String(tags[k])];
    }));
```

to:

```js
    tagsKey = JSON.stringify(Object.keys(tags).sort().map(k => {
      return [k, String(tags[k])];
    }));
```

Update the branch comment to drop the "type" wording, e.g. replace the "Encode each value via String() (its emitted form) alongside its type so values that format as different tags do not collide." sentence with:

```js
    // Encode each value via String() — its emitted form — so values that format
    // as identical tags map to one context and values that format as distinct
    // tags stay separate. Passing values straight to JSON.stringify would collapse
    // an array-position `undefined`, `NaN`, `Infinity` and `-Infinity` all to
    // `null`, merging contexts that emit as distinct tags (`a:undefined` vs
    // `a:null`, `a:NaN` vs `a:Infinity` vs `a:-Infinity`).
```

- [ ] **Step 4: Run the aggregation tests**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS — the new test passes and the existing `undefined vs null` / non-finite tests still pass (their `String()` forms differ).

- [ ] **Step 5: Commit**

```bash
git add lib/aggregator.js test/aggregation.js
git commit -m "Key object tags on String() form only, dropping over-splitting typeof"
```

---

### Task 6: Order-normalize array tags in the context key (finding #3)

**Files:**
- Modify: `lib/aggregator.js` (`contextKey`, array-tags branch)
- Test: `test/aggregation.js`

**Interfaces:**
- Produces: array tags are keyed on a sorted copy (`tags.slice().sort()`); emission still uses caller order (`cloneTags` is unchanged), matching how the server treats tag sets as unordered.

- [ ] **Step 1: Write the failing test**

Add to `test/aggregation.js`:

```js
  it('should treat array tags differing only in order as one context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.arrorder', 1, ['a:1', 'b:2']);
    statsd.gauge('agg.arrorder', 5, ['b:2', 'a:1']);
    statsd.gauge('agg.arrorder', 2, ['a:1', 'b:2']);
    statsd.flush();
    // One Datadog series: the final recorded value (2) must win, not a stale 5.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.arrorder:2|g|#a:1,b:2']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — two contexts are created; `mockBuffer` has both `agg.arrorder:2|...` and `agg.arrorder:5|...`.

- [ ] **Step 3: Sort a copy of the array when keying**

In `lib/aggregator.js`, change the array branch:

```js
  } else if (Array.isArray(tags)) {
    tagsKey = JSON.stringify(tags);
```

to:

```js
  } else if (Array.isArray(tags)) {
    // Sort a copy so array tags that differ only in order map to one context (the
    // server treats tag sets as unordered). Emission keeps caller order via
    // cloneTags — only the key is normalized.
    tagsKey = JSON.stringify(tags.slice().sort());
```

- [ ] **Step 4: Run the aggregation tests**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS — new test passes and `should keep different tags in different contexts` still passes.

- [ ] **Step 5: Commit**

```bash
git add lib/aggregator.js test/aggregation.js
git commit -m "Order-normalize array tags in aggregation context key"
```

---

### Task 7: Key on the effective emitted cardinality (finding #4)

**Files:**
- Modify: `lib/aggregator.js` (add `helpers` require; `contextKey` cardinality handling)
- Test: `test/aggregation.js`

**Interfaces:**
- Consumes: `helpers.validateCardinality(cardinality)` (lowercases/validates), `client.datadog`, `client.cardinality`.
- Produces: the key encodes a single **effective** cardinality — `client.datadog ? (helpers.validateCardinality(cardinality) || client.cardinality || '') : ''` — replacing both the raw per-call `cardinality` segment and the separate raw `client.cardinality` segment. This matches emission (`getDatadogExtensionFields`, `lib/statsd.js:265`) exactly.

- [ ] **Step 1: Write the failing tests**

Add to `test/aggregation.js`:

```js
  it('should merge per-call cardinality that equals the client default', () => {
    statsd = createHotShotsClient({ mock: true, datadog: true, cardinality: 'high', aggregation: true }, 'client');
    statsd.gauge('agg.effcard', 1, { cardinality: 'high' });
    statsd.gauge('agg.effcard', 5);
    statsd.flush();
    // Per-call 'high' and the default 'high' emit identically, so one context (last wins).
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.effcard:5|g|card:high']);
  });

  it('should merge per-call cardinality that differs only in case', () => {
    statsd = createHotShotsClient({ mock: true, datadog: true, aggregation: true }, 'client');
    statsd.gauge('agg.cardcase', 1, { cardinality: 'HIGH' });
    statsd.gauge('agg.cardcase', 5, { cardinality: 'high' });
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.cardcase:5|g|card:high']);
  });

  it('should ignore per-call cardinality for context keying in non-datadog mode', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.nocard', 1, { cardinality: 'high' });
    statsd.gauge('agg.nocard', 5, { cardinality: 'low' });
    statsd.flush();
    // Cardinality is never emitted outside datadog mode, so these are one context.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.nocard:5|g']);
  });
```

Note: `gauge('name', value, { cardinality })` passes the options object as `sampleRate`, which `sendAll` unpacks (it checks for `'cardinality' in ...`), so `cardinality` reaches `sendStat`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — raw per-call cardinality splits `high`/`HIGH` and splits non-datadog contexts.

- [ ] **Step 3: Require helpers in the aggregator**

At the top of `lib/aggregator.js`, add the require (keep `sort-imports` order — `helpers` sorts before `util`):

```js
const helpers = require('./helpers');
const util = require('util');
```

- [ ] **Step 4: Compute and key on the effective cardinality**

In `contextKey`, just before the `return`, add:

```js
  // Key on the cardinality that will actually be emitted (validated/lowercased,
  // falling back to the client default), and only in datadog mode where it is
  // emitted at all. Mirrors getDatadogExtensionFields so contexts that emit
  // byte-identical cardinality never split.
  const effectiveCardinality = client.datadog ?
    (helpers.validateCardinality(cardinality) || client.cardinality || '') :
    '';
```

Then change the `return` from:

```js
  return `${type}|${name}|${tagsKey}|${cardinality || ''}|${client.globalTags.join(',')}|` +
    `${client.cardinality || ''}|${client.containerID || ''}|${client.externalData || ''}`;
```

to:

```js
  return `${type}|${name}|${tagsKey}|${effectiveCardinality}|${client.globalTags.join(',')}|` +
    `${client.containerID || ''}|${client.externalData || ''}`;
```

Update the block comment above the return to say it includes the *effective* cardinality rather than raw per-call and default values.

- [ ] **Step 5: Run the aggregation tests**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS — the three new tests pass and `should not merge parent and child contexts that differ in default cardinality` still passes (parent effective `''`, child effective `high`).

- [ ] **Step 6: Run the full suite and note the change**

Run: `npm test`
Expected: PASS. Add to `CHANGES.md`:

```
* [@bdeitte](https://github.com/bdeitte) Fix: aggregation now keys on the effective emitted cardinality, so per-call cardinality equal to (or differing only in case from) the client default no longer splits into duplicate contexts, and per-call cardinality is ignored for keying in non-datadog mode
```

- [ ] **Step 7: Commit**

```bash
git add lib/aggregator.js test/aggregation.js CHANGES.md
git commit -m "Key aggregation contexts on effective emitted cardinality"
```

---

### Task 8: Cache the per-client context-key suffix (finding #11)

**Files:**
- Modify: `lib/aggregator.js` (`contextKey` — memoize the per-client segment)
- Test: `test/aggregation.js`

**Interfaces:**
- Produces: `contextKey` reads a memoized `client._aggContextSuffix` (the `globalTags.join(',')|containerID|externalData` segment) instead of rebuilding it every record. `globalTags`/`containerID`/`externalData` are set only during construction, so the cache is safe. The per-call `effectiveCardinality` stays out of the cache (it varies per call).

- [ ] **Step 1: Write the failing (caching) test**

Add to `test/aggregation.js` — this asserts the memo is populated and reused:

```js
  it('should memoize the per-client context suffix', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, globalTags: ['g:1'] }, 'client');
    assert.strictEqual(statsd._aggContextSuffix, undefined);
    statsd.increment('agg.cache');
    const cached = statsd._aggContextSuffix;
    assert.ok(typeof cached === 'string' && cached.indexOf('g:1') !== -1);
    statsd.increment('agg.cache');
    // Same string instance reused (not rebuilt) on the second record.
    assert.strictEqual(statsd._aggContextSuffix, cached);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — `statsd._aggContextSuffix` is `undefined` after recording (no memo exists yet).

- [ ] **Step 3: Add the memoized suffix helper and use it**

In `lib/aggregator.js`, add above `contextKey`:

```js
/**
 * Returns the client-specific portion of the context key (global tags plus
 * datadog origin fields), memoized on the client. These are fixed at
 * construction time, so the serialized form is computed once per client.
 * @param client The client the metric was recorded through.
 * @returns {String} The cached per-client key suffix.
 */
function clientContextSuffix(client) {
  if (client._aggContextSuffix === undefined) {
    client._aggContextSuffix =
      `${client.globalTags.join(',')}|${client.containerID || ''}|${client.externalData || ''}`;
  }
  return client._aggContextSuffix;
}
```

Then change the `contextKey` return to use it:

```js
  return `${type}|${name}|${tagsKey}|${effectiveCardinality}|${clientContextSuffix(client)}`;
```

- [ ] **Step 4: Run the aggregation tests**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS — new memo test passes; child-vs-parent global-tag and cardinality tests still pass (each client memoizes its own suffix).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/aggregator.js test/aggregation.js
git commit -m "Memoize per-client aggregation context-key suffix"
```

---

### Task 9: Bound the aggregation contexts map (finding #6)

**Files:**
- Modify: `lib/aggregator.js` (`Aggregator` constructor, `record` returns boolean, add `signalOverflow`)
- Modify: `lib/statsd.js` (`sendStat` aggregate branch; `setupAggregation` parses/validates `maxContexts`)
- Modify: `types.d.ts` (`AggregationOptions.maxContexts`)
- Modify: `README.md` (aggregation section)
- Test: `test/aggregation.js`

**Interfaces:**
- Consumes: new option `aggregation: { maxContexts }` (positive integer; default `DEFAULT_MAX_CONTEXTS = 5000`).
- Produces: `Aggregator.prototype.record(...)` now returns `true` when the sample was aggregated, `false` when a **new** context is rejected because `contexts.size >= maxContexts`. `sendStat` falls through to its normal direct-send path on `false`. First rejection (lifetime) signals once via the recording client's `errorHandler` else `console.error`.

- [ ] **Step 1: Write the failing test**

Add to `test/aggregation.js`:

```js
  it('should fall through to direct send once the context cap is reached', () => {
    const originalConsoleError = console.error;
    let overflowLogged = 0;
    console.error = () => { overflowLogged += 1; };
    try {
      statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 2 } }, 'client');
      statsd.gauge('agg.cap', 1, ['k:a']); // context 1 (aggregated)
      statsd.gauge('agg.cap', 2, ['k:b']); // context 2 (aggregated)
      statsd.gauge('agg.cap', 3, ['k:c']); // new -> over cap -> direct send now
      statsd.gauge('agg.cap', 4, ['k:c']); // still over cap -> direct send now
    } finally {
      console.error = originalConsoleError;
    }
    // The two over-cap gauges were sent immediately (not held for flush).
    assert.deepStrictEqual(statsd.mockBuffer, [
      'agg.cap:3|g|#k:c',
      'agg.cap:4|g|#k:c',
    ]);
    assert.strictEqual(overflowLogged, 1, 'overflow should signal exactly once');
    // The two under-cap contexts still flush normally.
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.slice(2).sort(), [
      'agg.cap:1|g|#k:a',
      'agg.cap:2|g|#k:b',
    ].sort());
  });

  it('should still update an existing context when at the cap', () => {
    const originalConsoleError = console.error;
    console.error = () => { /* suppress overflow signal */ };
    try {
      statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 1 } }, 'client');
      statsd.increment('agg.capexisting', 1, ['k:a']);
      statsd.increment('agg.capexisting', 2, ['k:a']); // same context: still aggregates
      statsd.increment('agg.capexisting', 9, ['k:b']); // new over cap: direct send
    } finally {
      console.error = originalConsoleError;
    }
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b']);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b', 'agg.capexisting:3|c|#k:a']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — `maxContexts` is ignored; all four contexts aggregate and nothing sends until `flush()`.

- [ ] **Step 3: Add the cap and overflow signal to the Aggregator**

In `lib/aggregator.js`, add a default constant near the top:

```js
const DEFAULT_AGGREGATION_FLUSH_INTERVAL = 2000;
const DEFAULT_MAX_CONTEXTS = 5000;
```

In the constructor, store the cap and the one-time flag:

```js
  this.flushInterval = options.flushInterval || DEFAULT_AGGREGATION_FLUSH_INTERVAL;
  this.maxContexts = options.maxContexts || DEFAULT_MAX_CONTEXTS;
  this.overflowSignaled = false;
  this.contexts = new Map();
```

Add the signal method (place above `record`):

```js
/**
 * Signals — at most once for the aggregator's lifetime — that the context cap
 * was reached and further new contexts are being sent directly. Routed through
 * the recording client's errorHandler if set, else console.error.
 * @param client The client whose record triggered the overflow.
 */
Aggregator.prototype.signalOverflow = function (client) {
  if (this.overflowSignaled) {
    return;
  }
  this.overflowSignaled = true;
  const message = `hot-shots: aggregation context limit (${this.maxContexts}) reached; ` +
    'further new contexts are sent directly without aggregation';
  if (client.errorHandler) {
    try {
      client.errorHandler(new Error(message));
    } catch (handlerErr) {
      console.error(`hot-shots: errorHandler threw inside aggregation overflow signal: ${handlerErr && handlerErr.message}`);
    }
  } else {
    console.error(message);
  }
};
```

Change `record` to enforce the cap and return a boolean:

```js
Aggregator.prototype.record = function (client, name, value, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  let context = this.contexts.get(key);
  if (!context) {
    // Cap the number of live contexts: a high-cardinality tag would otherwise
    // grow memory for the whole flush window while aggregation saves nothing.
    // A rejected sample falls through to the caller's direct-send path.
    if (this.contexts.size >= this.maxContexts) {
      this.signalOverflow(client);
      return false;
    }
    context = {
      client: client,
      name: name,
      type: type,
      tags: cloneTags(tags),
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
  return true;
};
```

- [ ] **Step 4: Fall through in sendStat when record returns false**

In `lib/statsd.js`, change the aggregate branch:

```js
    debug('hot-shots sendStat: aggregating - stat=%s, type=%s', stat, type);
    this.aggregator.record(this, this.prefix + sanitizedStat + this.suffix, value, type, tags, cardinality);
    return callback ? callback() : undefined;
```

to:

```js
    debug('hot-shots sendStat: aggregating - stat=%s, type=%s', stat, type);
    if (this.aggregator.record(this, this.prefix + sanitizedStat + this.suffix, value, type, tags, cardinality)) {
      return callback ? callback() : undefined;
    }
    // Context cap reached for a new context: fall through to the direct-send path below.
```

- [ ] **Step 5: Parse and validate the maxContexts option**

In `setupAggregation` (`lib/statsd.js`), after the `flushInterval` validation and before `new Aggregator(...)`, add:

```js
  let maxContexts = aggregationOptions.maxContexts;
  if (maxContexts !== undefined && maxContexts !== null) {
    if (typeof maxContexts !== 'number' || !Number.isInteger(maxContexts) || maxContexts < 1) {
      console.error('hot-shots: aggregation maxContexts should be a positive integer, ' +
        `got ${maxContexts} — using default`);
      maxContexts = undefined;
    }
  }
  client.aggregator = new Aggregator({ flushInterval: flushInterval, maxContexts: maxContexts });
```

(Replace the existing `client.aggregator = new Aggregator({ flushInterval: flushInterval });` line.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS.

- [ ] **Step 7: Update types and README**

In `types.d.ts`, extend `AggregationOptions`:

```ts
export interface AggregationOptions {
  /** Interval in milliseconds between aggregation flushes. Default: 2000. */
  flushInterval?: number;
  /** Maximum number of distinct aggregation contexts held per flush window; new contexts beyond this are sent directly. Default: 5000. */
  maxContexts?: number;
}
```

In `README.md`, extend the aggregation config example and add a sentence to the aggregation section:

```javascript
// or configure the flush interval (default 2000ms) and/or context cap (default 5000):
const client = new StatsD({ aggregation: { flushInterval: 1000, maxContexts: 5000 } });
```

Add after the bypass paragraph: "To bound memory, at most `maxContexts` (default 5000) distinct contexts are held per flush window; once the cap is reached, additional new contexts are sent directly without aggregation and a one-time warning is emitted."

- [ ] **Step 8: Run the full suite and note the change**

Run: `npm test`
Expected: PASS. Add to `CHANGES.md`:

```
* [@bdeitte](https://github.com/bdeitte) Add aggregation `maxContexts` option (default 5000) bounding the number of live aggregation contexts; new contexts beyond the cap are sent directly with a one-time warning
```

- [ ] **Step 9: Commit**

```bash
git add lib/aggregator.js lib/statsd.js types.d.ts README.md CHANGES.md test/aggregation.js
git commit -m "Bound aggregation contexts with configurable maxContexts cap"
```

---

### Task 10: Flush a pending gauge before a bypassing gauge (finding #5)

**Files:**
- Modify: `lib/aggregator.js` (add `flushContext`)
- Modify: `lib/statsd.js` (`sendStat` — flush pending same-context gauge before the direct send)
- Test: `test/aggregation.js`

**Interfaces:**
- Consumes: `Aggregator.prototype.sendContext` (Task 4).
- Produces: `Aggregator.prototype.flushContext(client, name, type, tags, cardinality)` — if a matching context is pending, delete and send it (isolating a throw); otherwise no-op. `sendStat` calls it for type `'g'` on the bypass path so an earlier aggregated gauge reaches the wire before the bypassing one, preserving call order.

- [ ] **Step 1: Write the failing test**

Add to `test/aggregation.js`:

```js
  it('should flush a pending aggregated gauge before a bypassing delta gauge', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('q.depth', 10);        // aggregated, held
    statsd.gaugeDelta('q.depth', 2);    // bypasses; must not land before the 10
    // The absolute gauge must be emitted before the delta so the server ends at 12.
    assert.deepStrictEqual(statsd.mockBuffer, ['q.depth:10|g', 'q.depth:+2|g']);
  });

  it('should flush a pending aggregated gauge before a bypassing NaN gauge on the same context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('q.depth', 10, ['k:a']);
    statsd.gauge('q.depth', NaN, ['k:a']);
    assert.deepStrictEqual(statsd.mockBuffer, ['q.depth:10|g|#k:a', 'q.depth:NaN|g|#k:a']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: FAIL — the bypassing gauge is sent immediately while the `10` stays in the aggregator, so `mockBuffer` is `['q.depth:+2|g']` (the `10` only appears after a later flush, i.e. out of order).

- [ ] **Step 3: Add `flushContext` to the aggregator**

In `lib/aggregator.js`, add (below `sendContext`):

```js
/**
 * If a context matching the given key components is currently pending, remove it
 * and send it immediately. Used to preserve call order when a same-context
 * metric bypasses aggregation (e.g. a delta/NaN/timestamped gauge) and would
 * otherwise reach the wire before the earlier aggregated value.
 * @param client The client the metric was recorded through.
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param type {String} Metric type code.
 * @param tags {Array|Object=} Per-call tags.
 * @param cardinality {String=} Per-call cardinality.
 */
Aggregator.prototype.flushContext = function (client, name, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  const context = this.contexts.get(key);
  if (!context) {
    return;
  }
  this.contexts.delete(key);
  try {
    this.sendContext(context);
  } catch (err) {
    if (context.client.errorHandler) {
      try {
        context.client.errorHandler(err);
      } catch (handlerErr) {
        console.error('hot-shots: errorHandler threw inside aggregator flushContext; ' +
          `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
      }
    } else {
      console.error(`hot-shots: aggregator flushContext send threw: ${err && err.message}`);
    }
  }
};
```

- [ ] **Step 4: Flush the pending gauge before the direct send in sendStat**

In `lib/statsd.js`, in `sendStat`, immediately after the aggregate `if (...) { ... }` block and before `let message = ...`, add:

```js
  // A gauge that bypasses aggregation (delta, NaN, timestamped, or per-call
  // sampled) must not reach the wire before an earlier same-context aggregated
  // gauge still pending in the aggregator — the server would apply them out of
  // order and settle on the stale aggregated value. Flush the pending one first.
  if (type === 'g' && this.aggregator && !this.aggregator.closed) {
    this.aggregator.flushContext(this, this.prefix + sanitizedStat + this.suffix, 'g', tags, cardinality);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS.

- [ ] **Step 6: Run the full suite and note the change**

Run: `npm test`
Expected: PASS. Add to `CHANGES.md`:

```
* [@bdeitte](https://github.com/bdeitte) Fix: a gauge that bypasses aggregation (delta, NaN, timestamped, or per-call sampled) now flushes any pending same-context aggregated gauge first, so the server no longer settles on a stale aggregated value
```

- [ ] **Step 7: Commit**

```bash
git add lib/aggregator.js lib/statsd.js test/aggregation.js CHANGES.md
git commit -m "Flush pending aggregated gauge before a bypassing same-context gauge"
```

---

### Task 11: Extract duplicated aggregator/close plumbing (finding #9)

**Files:**
- Modify: `lib/statsd.js` (add `safeAggregatorFlush`, `validateInterval`, `collectDrainClients`; replace the three duplicated sites each)

**Interfaces:**
- Produces (module-scope helpers in `lib/statsd.js`):
  - `safeAggregatorFlush(client, context)` — no-op if `!client.aggregator`; else runs `client.aggregator.flush()` inside try/catch routing to `client.errorHandler` else `console.error`, with `context` naming the call site.
  - `validateInterval(value, name)` — returns `undefined` for null/undefined or an invalid value (non-number, non-finite, `<= 0`, `> 2147483647`), logging a warning naming `name`; otherwise returns `value`.
  - `collectDrainClients(client)` — returns an array `[client, ...aggregator.activeClients]` de-duplicated.

- [ ] **Step 1: Add the three helpers**

In `lib/statsd.js`, add near the other module-scope functions (e.g. above `protocolErrorHandler`):

```js
/**
 * Flushes a client's aggregator (if any), isolating a synchronous throw so it
 * cannot escape close()/flush()/the interval and orphan a callback or drop the
 * remaining aggregated metrics. Errors route through errorHandler else console.error.
 * @param client The client whose aggregator should be flushed.
 * @param context {String} A label for the call site, used in error messages.
 */
function safeAggregatorFlush(client, context) {
  if (!client.aggregator) {
    return;
  }
  try {
    client.aggregator.flush();
  } catch (err) {
    if (client.errorHandler) {
      try {
        client.errorHandler(err);
      } catch (handlerErr) {
        console.error(`hot-shots: errorHandler threw inside ${context}; ` +
          `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
      }
    } else {
      console.error(`hot-shots: ${context} threw: ${err && err.message}`);
    }
  }
}

/**
 * Validates an interval option: rejects non-finite, non-positive, or values above
 * setTimeout's signed-32-bit max (Node clamps oversized delays to 1ms, creating a
 * hot loop). Returns the value when valid, otherwise undefined (so a downstream
 * `|| <default>` applies).
 * @param value The option value to validate.
 * @param name {String} The option name, used in the warning.
 * @returns {Number|undefined} The valid value, or undefined.
 */
function validateInterval(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 2147483647) {
    console.error(`hot-shots: '${name}' should be a finite positive number <= 2147483647, ` +
      `got ${value} — using default`);
    return undefined;
  }
  return value;
}

/**
 * Collects the clients whose in-flight sends a drain must wait for: this client
 * plus any client with an in-flight aggregator-routed send. De-duplicated.
 * @param client The closing/flushing client.
 * @returns {Array} The clients to drain.
 */
function collectDrainClients(client) {
  const clients = [client];
  if (client.aggregator) {
    client.aggregator.activeClients.forEach(active => {
      if (clients.indexOf(active) === -1) {
        clients.push(active);
      }
    });
  }
  return clients;
}
```

- [ ] **Step 2: Replace the two interval-validation sites**

In the constructor, replace the `bufferFlushInterval` validation block (`lib/statsd.js:89-98`) with:

```js
  options.bufferFlushInterval = validateInterval(options.bufferFlushInterval, 'bufferFlushInterval');
```

In `setupAggregation`, replace the `flushInterval` validation block with:

```js
  let flushInterval = validateInterval(aggregationOptions.flushInterval, 'aggregation flushInterval');
```

- [ ] **Step 3: Replace the three aggregator-flush try/catch sites**

- In `Client.prototype.flush`, replace the `if (this.aggregator) { try { this.aggregator.flush() } catch ... }` block with:

```js
  safeAggregatorFlush(this, 'flush aggregation flush');
```

- In `Client.prototype.close`, replace the `if (this.aggregator) { try { this.aggregator.flush() } catch ... this.aggregator.closed = true; }` block with:

```js
  if (this.aggregator) {
    safeAggregatorFlush(this, 'close aggregation flush');
    this.aggregator.closed = true;
  }
```

- In `setupAggregation`, replace the `setInterval(() => { try { client.aggregator.flush() } catch ... })` body with:

```js
  client.aggregationIntervalHandle = setInterval(() => {
    safeAggregatorFlush(client, 'aggregation flush interval');
  }, client.aggregator.flushInterval);
```

- [ ] **Step 4: Replace the two drain-client collection sites**

- In `Client.prototype.flush`'s `flushQueue` callback, replace the `const drainClients = new Set([this]); ...forEach(...)` block with:

```js
    const drainClients = collectDrainClients(this);
    const pending = [];
    drainClients.forEach(client => {
      if (client.drainPromise) {
        pending.push(client.drainPromise);
      }
    });
```

- In `Client.prototype.close`'s `flushQueue` callback, replace the `const drainClients = [this]; const addDrainClient = ...; if (this.aggregator) {...}` block with:

```js
    const drainClients = collectDrainClients(this);
```

(Leave `totalInFlight`, `finish`, and `waitForDrain` unchanged — they already consume the `drainClients` array.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — behavior is unchanged. In particular `test/flush.js` (`should invoke the flush callback even when the aggregator flush throws`, drain tests) and `test/aggregation.js` invalid-flushInterval and telegraf-disable tests still pass. If any test asserts an exact `bufferFlushInterval` warning string, update that assertion to the new shared wording.

- [ ] **Step 6: Commit**

```bash
git add lib/statsd.js
git commit -m "Extract safeAggregatorFlush, validateInterval and collectDrainClients helpers"
```

---

### Task 12: Convert real-timer tests to Sinon fake timers (finding #10)

**Files:**
- Modify: `test/aggregation.js` (the `should flush on the aggregation interval` test + afterEach clock cleanup, sinon require)
- Modify: `test/flush.js` (the three drain tests at the deferred-send `setTimeout(..., 30)` sites + afterEach clock cleanup, sinon require)

**Interfaces:** Test-only. Uses `sinon.useFakeTimers()` and `clock.tick`/`clock.tickAsync` per the CLAUDE.md pattern (install the clock *after* `createServer` for server-backed tests).

- [ ] **Step 1: Convert the aggregation interval test**

In `test/aggregation.js`, add `const sinon = require('sinon');` to the requires and a `let clock;`. Extend `afterEach` to restore the clock first:

```js
  afterEach(done => {
    if (clock) {
      clock.restore();
      clock = null;
    }
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });
```

Replace the real-timer test:

```js
  it('should flush on the aggregation interval', () => {
    clock = sinon.useFakeTimers();
    statsd = createHotShotsClient({
      mock: true,
      aggregation: { flushInterval: 25 },
    }, 'client');
    statsd.increment('agg.interval');
    clock.tick(25);
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.interval:1|c']);
  });
```

- [ ] **Step 2: Run the aggregation tests**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: PASS — the interval flush fires on `clock.tick(25)` with no real wait.

- [ ] **Step 3: Convert the flush.js drain tests**

In `test/flush.js`, add `const sinon = require('sinon');` and `let clock;`, and restore the clock in `afterEach` (same shape as Step 1). For each of the three drain tests (`should wait for an in-flight unbuffered send...`, `should wait for an aggregated send routed through a child...`, `should wait for an interval-routed child send...`), install the clock *after* `createServer` and drive it with `clock.tickAsync(30)` so the deferred send's `setTimeout` fires and the drain promises resolve. Example for the first:

```js
  it('should wait for an in-flight unbuffered send before invoking the callback', done => {
    server = createServer('udp', opts => {
      clock = sinon.useFakeTimers();
      statsd = createHotShotsClient(Object.assign(opts, { maxBufferSize: 0 }), 'client');
      let sendDrained = false;
      statsd.socket.send = (buf, cb) => {
        setTimeout(() => {
          sendDrained = true;
          cb();
        }, 30);
      };
      statsd.increment('drain.metric');
      statsd.flush(() => {
        assert.ok(sendDrained, 'flush callback fired before the unbuffered send drained');
        done();
      });
      clock.tickAsync(30);
    });
  });
```

Apply the same two edits to the other two tests: install `clock = sinon.useFakeTimers();` right after entering the `createServer` callback, and add `clock.tickAsync(30);` after the `statsd.flush(...)` call (for the interval-routed test, keep the existing `statsd.aggregator.flush();` before `statsd.flush(...)`, then `clock.tickAsync(30);`).

- [ ] **Step 4: Run the flush tests**

Run: `npx mocha test/flush.js --timeout 5000`
Expected: PASS — all three drain tests complete without real 30ms waits. If `tickAsync` proves flaky for a given test (the drain path mixes timers and microtasks), it is acceptable to leave that single test on real timers rather than weaken the assertion; note it in the commit message.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/aggregation.js test/flush.js
git commit -m "Convert aggregation/flush real-timer tests to Sinon fake timers"
```

---

## Self-Review Notes

- **Spec coverage:** #1→T4, #2→T2, #3→T6, #4→T7, #5→T10, #6→T9, #7→T5, #8→T3, #9→T11, #10→T12, #11→T8, #12→T1. All 12 findings mapped.
- **Ordering rationale:** context-key changes run correctness-first (T5 drop typeof, T6 sort array, T7 effective cardinality) then the caching optimization (T8), so the memoized suffix reflects the final key shape. T9/T10 depend on T4's `sendContext`. T11 (refactor) runs after behavior settles; T12 (tests) last.
- **Type consistency:** `sendContext(context)` (T4) is reused by `flushContext` (T10); `record(...)` returns boolean (T9) consumed by `sendStat`; `clientContextSuffix`/`effectiveCardinality` composed in T7/T8; `safeAggregatorFlush`/`validateInterval`/`collectDrainClients` signatures fixed in T11.
- **Decisions applied:** #5 fixed (not just documented) per maintainer; #6 configurable cap default-on (`DEFAULT_MAX_CONTEXTS = 5000`).
