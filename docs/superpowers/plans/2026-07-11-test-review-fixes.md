# Test Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the review-testing review of the `dogstatsd-parity` branch test suite: two required fixes (a nondeterministic test and failure-unsafe cleanup), removal of an implementation-coupled test, seven coverage-gap tests, and conversion of hand-rolled `console.error` patching to sinon stubs with assertions.

**Architecture:** All changes are test-only — no production code in `lib/` changes. Each task edits one test file, runs that file to green, and commits. The final task runs the full suite with lint.

**Tech Stack:** Node.js >= 18, Mocha (5s timeout), Sinon (already a dev dependency and already imported in the files being edited), ESLint 8.

## Global Constraints

- Run a single test file with: `npx mocha test/<file>.js --timeout 5000`
- Lint before finishing: `npm run lint` (single quotes, always curly braces, no trailing spaces, operators at end of line)
- Never use compound bash calls — run `git add` and `git commit` as separate commands (user's global CLAUDE.md rule)
- Commit at the end of every task
- These tests verify **existing, already-correct production behavior**, so the TDD "watch it fail" step does not apply; each new test must pass on first run. If a new test fails, the test is wrong — do not change `lib/` code.
- Locate insertion points by **test title strings**, not line numbers — earlier tasks shift line numbers.
- Production behavior these tests pin down (for reference, do not modify):
  - `lib/statsd.js` `sendStat`: aggregation applies only to types `c`/`g`/`s` with no timestamp and no explicit per-call sample rate < 1 (`callSampleRate >= 1` still aggregates); bypassing gauges trigger `aggregator.flushContext` before direct send.
  - `lib/statsd.js` `sendMessage`: a transport-send error reaches the caller's callback wrapped as `Error sending hot-shots message: <err>`.
  - `lib/statsd.js` constructor line 100: `this.host = options.host || (process.env.DD_AGENT_HOST || undefined)` — host is `undefined` when neither is set.
  - `lib/aggregator.js`: `signalOverflow`, `flush`, and `flushContext` route errors through the recording client's `errorHandler` when set, else `console.error`. `trackActive`'s recheck follows a later `drainPromise` when `messagesInFlight > 0` at resolution time.
  - `lib/helpers.js` `parseDogstatsdUrl`: rejects port `< 1`; bracketed IPv6 without a port defaults to 8125.

---

### Task 1: Make the sampled-metrics aggregation test deterministic

**Files:**
- Modify: `test/aggregation.js` (test titled `should not aggregate sampled metrics`)

**Interfaces:**
- Consumes: existing `createHotShotsClient` helper, mock client `mockBuffer`.
- Produces: nothing later tasks rely on.

The current test uses real `Math.random` with rate 0.9999; if the metric is sampled out (0.01% of runs) the `forEach` body never executes and the test passes vacuously. Replace it with the deterministic `Math.random` patching pattern already used later in this file.

- [ ] **Step 1: Replace the test body**

Find the test `should not aggregate sampled metrics` and replace the entire `it(...)` block with:

```js
  it('should not aggregate a metric with an explicit per-call sample rate < 1', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const originalRandom = Math.random;
    Math.random = () => 0;  // deterministically sample the metric in
    try {
      statsd.increment('agg.sampled', 1, 0.9999);
    } finally {
      Math.random = originalRandom;
    }
    // Sent immediately with the sample-rate marker rather than held for flush.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.sampled:1|c|@0.9999']);
    statsd.flush();
    // Nothing was aggregated: flushing adds no unsampled duplicate.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.sampled:1|c|@0.9999']);
  });
```

Note: the old test's client options included `sampleRate: 1`; drop that — it was irrelevant to what the test verifies.

- [ ] **Step 2: Run the file**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: all tests pass, including `should not aggregate a metric with an explicit per-call sample rate < 1`.

- [ ] **Step 3: Commit**

```bash
git add test/aggregation.js
```

```bash
git commit -m "Make sampled-metric aggregation test deterministic via Math.random stub"
```

---

### Task 2: Make the partial-set tracking test's cleanup failure-safe

**Files:**
- Modify: `test/aggregation.js` (test titled `should track a child client whose set send starts before a later value throws`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing later tasks rely on.

The test resets `child.messagesInFlight` / `child.drainPromise` **after** its `assert.ok`; if the assertion fails, the reset is skipped and `afterEach`'s `closeAll` waits on the never-resolving drain until the ~550ms force-close fires. Capture the observation first, reset, then assert.

- [ ] **Step 1: Restructure the end of the test**

In the test `should track a child client whose set send starts before a later value throws`, replace this tail:

```js
    // Even though the second value threw, the child had a send in flight from the
    // first value, so it must be tracked for close()/flush() to wait on it.
    assert.ok(statsd.aggregator.activeClients.has(child),
      'partially-sent context did not track its in-flight child client');
    // Reset the simulated in-flight state so afterEach's close() does not wait for
    // a never-resolving drain and emit a force-close warning.
    child.messagesInFlight = 0;
    child.drainPromise = null;
    statsd.aggregator.activeClients.delete(child);
```

with:

```js
    // Capture the observation, then reset the simulated in-flight state BEFORE
    // asserting: on assertion failure the reset must still have run, or
    // afterEach's close() waits on a never-resolving drain and force-closes.
    const trackedChild = statsd.aggregator.activeClients.has(child);
    child.messagesInFlight = 0;
    child.drainPromise = null;
    statsd.aggregator.activeClients.delete(child);
    // Even though the second value threw, the child had a send in flight from the
    // first value, so it must be tracked for close()/flush() to wait on it.
    assert.ok(trackedChild,
      'partially-sent context did not track its in-flight child client');
```

- [ ] **Step 2: Run the file**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/aggregation.js
```

```bash
git commit -m "Reset simulated in-flight state before asserting in partial-set tracking test"
```

---

### Task 3: Remove the implementation-coupled memoization test

**Files:**
- Modify: `test/aggregation.js` (test titled `should memoize the per-client context suffix`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

The test asserts on the private `_aggContextSuffix` field and plants a `'SENTINEL'` string, pinning the exact caching strategy. Any cache refactor breaks it with zero behavior change, and the behavior the cache serves (correct context keying) is already covered by the child-client and telegraf tests. The memoization invariant is already documented in `lib/aggregator.js`'s `clientContextSuffix` JSDoc, so no production comment needs adding.

- [ ] **Step 1: Delete the test**

Delete the entire `it('should memoize the per-client context suffix', () => { ... });` block from `test/aggregation.js`.

- [ ] **Step 2: Run the file**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: all tests pass; count is one lower than before.

- [ ] **Step 3: Commit**

```bash
git add test/aggregation.js
```

```bash
git commit -m "Remove memoization test coupled to private aggregator cache field"
```

---

### Task 4: Convert hand-rolled console.error patching to sinon stubs and assert the warnings fire

**Files:**
- Modify: `test/aggregation.js` (four tests, listed below)
- Modify: `test/flush.js` (two tests, listed below)

**Interfaces:**
- Consumes: `sinon` (already imported at the top of both files).
- Produces: the `sinon.stub(console, 'error')` + `sinon.restore()` pattern that Task 5's new tests follow.

Both files repeat a save/patch/restore dance around `console.error`, and most spots swallow the warning without asserting it fired. Convert to `sinon.stub(console, 'error')`, restore via `sinon.restore()` in `afterEach` (self-cleaning on failure), and assert the expected warning.

- [ ] **Step 1: Add sinon.restore() to test/aggregation.js afterEach**

In `test/aggregation.js`, change the `afterEach` to:

```js
  afterEach(done => {
    if (clock) {
      clock.restore();
      clock = null;
    }
    sinon.restore();
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });
```

(Keep the manual `clock.restore()` — `sinon.restore()` does not restore fake timers created with `sinon.useFakeTimers()`.)

- [ ] **Step 2: Convert the invalid-flushInterval test**

Replace the body of `should reject an invalid aggregation flushInterval and use the default` with:

```js
  it('should reject an invalid aggregation flushInterval and use the default', () => {
    const consoleError = sinon.stub(console, 'error');
    statsd = createHotShotsClient({ mock: true, aggregation: { flushInterval: -5 } }, 'client');
    assert.strictEqual(statsd.aggregator.flushInterval, 2000);
    assert.ok(consoleError.calledOnce, 'expected exactly one validation warning');
    assert.ok(consoleError.firstCall.args[0].indexOf('aggregation.flushInterval') !== -1,
      'warning should name the rejected option');
  });
```

- [ ] **Step 3: Convert the context-cap overflow test**

In `should fall through to direct send once the context cap is reached`, replace the manual counter and try/finally:

```js
  it('should fall through to direct send once the context cap is reached', () => {
    const consoleError = sinon.stub(console, 'error');
    statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 2 } }, 'client');
    statsd.gauge('agg.cap', 1, ['k:a']); // context 1 (aggregated)
    statsd.gauge('agg.cap', 2, ['k:b']); // context 2 (aggregated)
    statsd.gauge('agg.cap', 3, ['k:c']); // new -> over cap -> direct send now
    statsd.gauge('agg.cap', 4, ['k:c']); // still over cap -> direct send now
    // The two over-cap gauges were sent immediately (not held for flush).
    assert.deepStrictEqual(statsd.mockBuffer, [
      'agg.cap:3|g|#k:c',
      'agg.cap:4|g|#k:c',
    ]);
    assert.strictEqual(consoleError.callCount, 1, 'overflow should signal exactly once');
    // The two under-cap contexts still flush normally.
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.slice(2).sort(), [
      'agg.cap:1|g|#k:a',
      'agg.cap:2|g|#k:b',
    ].sort());
  });
```

- [ ] **Step 4: Convert the at-cap-existing-context test**

Replace the body of `should still update an existing context when at the cap` with:

```js
  it('should still update an existing context when at the cap', () => {
    const consoleError = sinon.stub(console, 'error');
    statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 1 } }, 'client');
    statsd.increment('agg.capexisting', 1, ['k:a']);
    statsd.increment('agg.capexisting', 2, ['k:a']); // same context: still aggregates
    statsd.increment('agg.capexisting', 9, ['k:b']); // new over cap: direct send
    assert.strictEqual(consoleError.callCount, 1, 'overflow should signal exactly once');
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b']);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b', 'agg.capexisting:3|c|#k:a']);
  });
```

- [ ] **Step 5: Convert the flush-throw isolation test**

In `should not drop remaining contexts when one context send throws`, replace the manual `console.error` save/patch/finally-restore with a stub at the top and an assertion at the end. The resulting test:

```js
  it('should not drop remaining contexts when one context send throws', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const consoleError = sinon.stub(console, 'error');
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
    statsd.flush();
    assert.ok(statsd.mockBuffer.some(m => m.indexOf('agg.ok:2|g') === 0),
      'a throwing context aborted the flush and dropped the remaining context');
    assert.ok(consoleError.calledOnce, 'the throwing context should be logged exactly once');
    assert.ok(consoleError.firstCall.args[0].indexOf('aggregator flush send threw') !== -1,
      'warning should identify the aggregator flush send');
  });
```

- [ ] **Step 6: Convert the partial-set tracking test's console patching**

In `should track a child client whose set send starts before a later value throws` (as restructured in Task 2), replace the `originalConsoleError` save / assignment / `try { ... } finally { console.error = originalConsoleError; }` around `statsd.aggregator.flush()` with:

```js
    const consoleError = sinon.stub(console, 'error');
    // Simulate the first value going in flight (drainPromise + messagesInFlight)
    // and the second value's send throwing synchronously.
    let calls = 0;
    child.send = () => {
      calls += 1;
      if (calls === 1) {
        child.messagesInFlight = 1;
        child.drainPromise = new Promise(() => { /* stays pending */ });
        return;
      }
      throw new Error('boom on second set value');
    };
    statsd.aggregator.flush();
    assert.ok(consoleError.calledOnce, 'the throwing set value should be logged exactly once');
```

(The capture/reset/assert tail from Task 2 stays unchanged after this.)

- [ ] **Step 7: Run the aggregation file**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: all tests pass.

- [ ] **Step 8: Add sinon.restore() to test/flush.js afterEach**

In `test/flush.js`, change the `afterEach` to:

```js
  afterEach(done => {
    if (clock) {
      clock.restore();
      clock = null;
    }
    sinon.restore();
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });
```

- [ ] **Step 9: Convert the aggregator-throw flush test**

Replace the body of `should invoke the flush callback even when the aggregator flush throws` with:

```js
  it('should invoke the flush callback even when the aggregator flush throws', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const consoleError = sinon.stub(console, 'error');
    statsd.aggregator.flush = () => { throw new Error('boom'); };
    statsd.flush(err => {
      try {
        // A synchronous aggregator throw must not escape flush() or orphan the callback.
        assert.ok(!err);
        assert.ok(consoleError.calledOnce, 'the aggregator throw should be logged exactly once');
        done();
      } catch (assertErr) {
        done(assertErr);
      }
    });
  });
```

- [ ] **Step 10: Convert the force-close orphan test**

Replace the body of `should not orphan a concurrent flush callback when close force-closes` with:

```js
  it('should not orphan a concurrent flush callback when close force-closes', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 0,
        closingFlushInterval: 5,
      }), 'client');
      const consoleError = sinon.stub(console, 'error');
      // Never invoke the send callback: the send stays in flight, so close() must
      // hit its force-close path.
      statsd.socket.send = () => { /* leave the send permanently in flight */ };
      statsd.increment('stuck.metric');
      let flushCalledBack = false;
      statsd.flush(() => {
        flushCalledBack = true;
      });
      statsd.close(() => {
        try {
          assert.ok(flushCalledBack, 'concurrent flush callback was orphaned by force-close');
          assert.ok(consoleError.called, 'force-close should log the messages-in-flight warning');
          statsd = null;
          done();
        } catch (assertErr) {
          statsd = null;
          done(assertErr);
        }
      });
    });
  });
```

- [ ] **Step 11: Run the flush file**

Run: `npx mocha test/flush.js --timeout 5000`
Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add test/aggregation.js test/flush.js
```

```bash
git commit -m "Use sinon stubs for console.error in tests and assert the warnings fire"
```

---

### Task 5: Add aggregation coverage-gap tests

**Files:**
- Modify: `test/aggregation.js` (append five new tests inside the `#aggregation` describe, before its closing `});`)

**Interfaces:**
- Consumes: the `sinon.stub(console, 'error')` + `afterEach sinon.restore()` pattern from Task 4.
- Produces: nothing later tasks rely on.

Covers the untested branches: the `callSampleRate >= 1` boundary in `lib/statsd.js` `sendStat`, `flushContext`'s catch block, the `errorHandler` branches of `signalOverflow` and `flush` in `lib/aggregator.js`, and `trackActive`'s re-hook branch.

- [ ] **Step 1: Add the per-call sample rate of exactly 1 test**

```js
  it('should aggregate a metric with an explicit per-call sample rate of 1', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.rateone', 1, 1);
    statsd.increment('agg.rateone', 2, 1);
    // A per-call rate of exactly 1 means "unsampled" and must still aggregate;
    // only an explicit rate < 1 bypasses aggregation.
    assert.deepStrictEqual(statsd.mockBuffer, []);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.rateone:3|c']);
  });
```

- [ ] **Step 2: Add the flushContext error-isolation test**

```js
  it('should surface a flushContext send error without dropping the bypassing gauge', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.fcerr', 10);        // aggregated, held
    const consoleError = sinon.stub(console, 'error');
    const realSend = statsd.send.bind(statsd);
    let threwOnce = false;
    statsd.send = (message, tags, cardinality, cb) => {
      if (!threwOnce && message.indexOf('agg.fcerr:10') === 0) {
        threwOnce = true;
        throw new Error('boom');
      }
      return realSend(message, tags, cardinality, cb);
    };
    // The delta gauge bypasses aggregation and triggers flushContext of the
    // pending 10, whose send throws; the error must be logged and the delta
    // must still reach the wire.
    statsd.gaugeDelta('agg.fcerr', 2);
    assert.ok(consoleError.calledOnce, 'the flushContext throw should be logged exactly once');
    assert.ok(consoleError.firstCall.args[0].indexOf('flushContext send threw') !== -1,
      'warning should identify the flushContext send');
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.fcerr:+2|g']);
  });
```

- [ ] **Step 3: Add the errorHandler overflow-signal test**

```js
  it('should route the overflow signal through errorHandler when set', () => {
    const errors = [];
    statsd = createHotShotsClient({
      mock: true,
      aggregation: { maxContexts: 1 },
      errorHandler: err => { errors.push(err); },
    }, 'client');
    statsd.increment('agg.ehcap', 1, ['k:a']);
    statsd.increment('agg.ehcap', 1, ['k:b']); // new context over cap
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.indexOf('aggregation context limit (1) reached') !== -1,
      'errorHandler should receive the overflow message');
  });
```

- [ ] **Step 4: Add the errorHandler flush-error test**

```js
  it('should route a flush send error through errorHandler when set', () => {
    const errors = [];
    statsd = createHotShotsClient({
      mock: true,
      aggregation: true,
      errorHandler: err => { errors.push(err); },
    }, 'client');
    statsd.gauge('agg.eh', 1);
    statsd.send = () => { throw new Error('boom'); };
    statsd.flush();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].message, 'boom');
  });
```

- [ ] **Step 5: Add the trackActive re-hook test**

```js
  it('should keep tracking a client across consecutive in-flight sends until fully drained', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: { flushInterval: 60000 } }, 'client');
    // Simulate a send in flight whose drain resolves while a second send is
    // already in flight: trackActive's recheck must follow the new drain promise
    // rather than pruning early, and prune only once the client fully drains.
    let resolveFirst;
    let resolveSecond;
    statsd.messagesInFlight = 1;
    statsd.drainPromise = new Promise(resolve => { resolveFirst = resolve; });
    statsd.aggregator.trackActive(statsd);
    const trackedInitially = statsd.aggregator.activeClients.has(statsd);
    // First drain resolves, but a second send is already in flight.
    statsd.drainPromise = new Promise(resolve => { resolveSecond = resolve; });
    resolveFirst();
    setImmediate(() => {
      const stillTracked = statsd.aggregator.activeClients.has(statsd);
      // Fully drain, resetting the simulated state before the assertions so a
      // failure cannot leave afterEach's close() waiting on a pending drain.
      statsd.messagesInFlight = 0;
      statsd.drainPromise = null;
      resolveSecond();
      setImmediate(() => {
        const prunedAfterDrain = !statsd.aggregator.activeClients.has(statsd);
        try {
          assert.ok(trackedInitially, 'client with an in-flight send was not tracked');
          assert.ok(stillTracked, 'client was pruned while a later send was still in flight');
          assert.ok(prunedAfterDrain, 'client was not pruned after fully draining');
          done();
        } catch (err) {
          done(err);
        }
      });
    });
  });
```

- [ ] **Step 6: Run the file**

Run: `npx mocha test/aggregation.js --timeout 5000`
Expected: all tests pass, including the five new ones.

- [ ] **Step 7: Commit**

```bash
git add test/aggregation.js
```

```bash
git commit -m "Cover sample-rate boundary, flushContext catch, errorHandler and trackActive re-hook branches"
```

---

### Task 6: Add flush() transport-error propagation test

**Files:**
- Modify: `test/flush.js` (append inside the `#flush` describe, before its closing `});`)

**Interfaces:**
- Consumes: `createServer` / `createHotShotsClient` helpers; `sendMessage`'s error wrapping (`Error sending hot-shots message: <err>` — see Global Constraints).
- Produces: nothing.

Covers `Client.flush()`'s `if (err) { return callback(err); }` branch (`lib/statsd.js:693-695`), which no test exercises.

- [ ] **Step 1: Add the test**

```js
  it('should propagate a transport send error to the flush callback', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 8192,
        bufferFlushInterval: 60000,
      }), 'client');
      statsd.increment('err.metric');
      // Make the buffered payload's transport send fail.
      statsd.socket.send = (buf, cb) => {
        cb(new Error('send failed'));
      };
      statsd.flush(err => {
        try {
          assert.ok(err, 'flush callback did not receive the transport error');
          // sendMessage wraps transport errors; the original message must survive.
          assert.ok(err.message.indexOf('send failed') !== -1);
          done();
        } catch (assertErr) {
          done(assertErr);
        }
      });
    });
  });
```

- [ ] **Step 2: Run the file**

Run: `npx mocha test/flush.js --timeout 5000`
Expected: all tests pass, including the new one.

- [ ] **Step 3: Commit**

```bash
git add test/flush.js
```

```bash
git commit -m "Cover flush() transport-error propagation to the callback"
```

---

### Task 7: Add DD_TAGS-over-DATADOG_TAGS precedence test

**Files:**
- Modify: `test/globalTags.js` (append inside the `#DD_TAGS env var` describe, before its closing `});`)

**Interfaces:**
- Consumes: the describe's existing `afterEach`, which already deletes both `DD_TAGS` and `DATADOG_TAGS`.
- Produces: nothing.

Covers the `process.env.DD_TAGS || process.env.DATADOG_TAGS` expression in `lib/statsd.js` `setupDatadogGlobalTags` when **both** are set — only the fallback direction is currently tested.

- [ ] **Step 1: Add the test**

```js
  it('should prefer DD_TAGS over DATADOG_TAGS when both are set', () => {
    process.env.DD_TAGS = 'source:ddtags';
    process.env.DATADOG_TAGS = 'source:legacy';
    statsd = createHotShotsClient({ mock: true }, 'client');
    assert.deepStrictEqual(statsd.globalTags, ['source:ddtags']);
  });
```

- [ ] **Step 2: Run the file**

Run: `npx mocha test/globalTags.js --timeout 5000`
Expected: all tests pass, including the new one.

- [ ] **Step 3: Commit**

```bash
git add test/globalTags.js
```

```bash
git commit -m "Cover DD_TAGS precedence over DATADOG_TAGS when both are set"
```

---

### Task 8: Add parseDogstatsdUrl boundary tests

**Files:**
- Modify: `test/helpers.js` (append inside the `#parseDogstatsdUrl` describe, before its closing `});`)

**Interfaces:**
- Consumes: `helpers.parseDogstatsdUrl` (already imported in the file).
- Produces: nothing.

Covers the `port < 1` boundary (only `> 65535` is tested, via 99999) and bracketed IPv6 with no port (the `(?::(\d+))?` optional group falling through to the 8125 default). Note: the `#parseDogstatsdUrl` describe intentionally does not suppress `console.error` (matching its existing tests), so the port-0 test will print one expected warning.

- [ ] **Step 1: Add the tests**

```js
    it('should return null for port 0', () => {
      assert.strictEqual(helpers.parseDogstatsdUrl('udp://host:0'), null);
    });

    it('should parse bracketed IPv6 udp url without port using the default port', () => {
      assert.deepStrictEqual(helpers.parseDogstatsdUrl('udp://[::1]'), {
        protocol: 'udp', host: '::1', port: 8125,
      });
    });
```

- [ ] **Step 2: Run the file**

Run: `npx mocha test/helpers.js --timeout 5000`
Expected: all tests pass, including the two new ones.

- [ ] **Step 3: Commit**

```bash
git add test/helpers.js
```

```bash
git commit -m "Cover parseDogstatsdUrl port-0 rejection and portless bracketed IPv6 default"
```

---

### Task 9: Add explicit-port-wins-over-env-URL test

**Files:**
- Modify: `test/init.js` (append after the existing test `should prefer explicit transport options over DD_DOGSTATSD_URL`)

**Interfaces:**
- Consumes: the file's existing `clientType` variable and `afterEach` (which already deletes `DD_DOGSTATSD_URL` and `DD_AGENT_HOST`).
- Produces: nothing.

The constructor's env-transport guard checks six explicit options but only `host` is tested as winning. A port-only constructor is real usage; with the env URL skipped and no `DD_AGENT_HOST`, `this.host` stays `undefined` (`lib/statsd.js:100`).

- [ ] **Step 1: Add the test**

```js
  it('should prefer an explicit port option over DD_DOGSTATSD_URL', () => {
    process.env.DD_DOGSTATSD_URL = 'udp://urlhost:4321';
    statsd = createHotShotsClient({ mock: true, port: 1234 }, clientType);
    // Any explicit transport option disables the env transport entirely: the
    // URL's host must not leak in alongside the explicit port.
    assert.strictEqual(statsd.port, 1234);
    assert.strictEqual(statsd.host, undefined);
    assert.strictEqual(statsd.protocol, 'udp');
  });
```

- [ ] **Step 2: Run the file**

Run: `npx mocha test/init.js --timeout 5000`
Expected: all tests pass, including the new one.

- [ ] **Step 3: Commit**

```bash
git add test/init.js
```

```bash
git commit -m "Cover explicit port option disabling DD_DOGSTATSD_URL env transport"
```

---

### Task 10: Full-suite verification and docs check

**Files:**
- No source changes expected. Verify only.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch.

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: zero failures. Relative to the branch baseline the count moves by +9 (−1 test deleted in Task 3, +5 in Task 5, +1 in Task 6, +1 in Task 7, +2 in Task 8, +1 in Task 9).

- [ ] **Step 3: Docs check (per project CLAUDE.md "Follow for all code changes")**

- `README.md`: no update — no API or behavior change.
- `types.d.ts`: no update — no API change.
- `CHANGES.md`: no entry — test-only changes with no user-facing effect; the branch's existing entries already cover the features these tests exercise.

- [ ] **Step 4: Commit any stragglers**

If `git status` shows uncommitted changes from fixes made during verification:

```bash
git add -A
```

```bash
git commit -m "Test review fixes: verification cleanup"
```

If the working tree is clean, skip the commit.
