# CPU Performance Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce CPU overhead per metric send by eliminating redundant allocations and recomputations in the hot-path send loop.

**Architecture:** Seven behavior-preserving changes across four files: pre-compute the global tag string at construction so `send()` avoids an array join on every metric; skip a Buffer round-trip for TCP/stream; cache `Buffer.byteLength`; use `process.hrtime.bigint()` for timers; and optimize `overrideTags` with a fast-path, `Map`, and in-place push.

**Tech Stack:** Node.js ≥16, Mocha (tests), ESLint 8 (linting). Run tests with `npm test`. Run a single test file with `npx mocha test/<file>.js --timeout 5000`.

---

## Task 1: Pre-join global tag string to avoid join on every send

This is the highest-impact change. `send()` currently calls `mergedTags.join(this.tagSeparator)` on every metric, even when there are no per-metric tags (the common case). We pre-compute the result once at construction and reuse it.

**Files:**
- Modify: `lib/statsd.js` (constructor near line 75, ChildClient near line 663, `send()` near line 346)

**Step 1: Read the relevant sections**

Read `lib/statsd.js` lines 74–84 (globalTags assignment), lines 346–368 (`send()` method), and lines 645–675 (ChildClient constructor). Understand the current flow before touching anything.

**Step 2: Add `_globalTagStr` to the main Client constructor**

After the block that finalizes `this.globalTags` (after line 84 in `statsd.js`, which is the end of the `includeDataDogTags` block), add:

```js
this._globalTagStr = this.globalTags.length > 0
  ? `|${this.tagPrefix}${this.globalTags.join(this.tagSeparator)}`
  : '';
```

**Step 3: Add `_globalTagStr` to ChildClient**

In `ChildClient`, after `Client.call(this, { ... })` (line 647), the constructor calls the parent constructor which sets `this.globalTags`. Add the same line immediately after the `Client.call`:

```js
this._globalTagStr = this.globalTags.length > 0
  ? `|${this.tagPrefix}${this.globalTags.join(this.tagSeparator)}`
  : '';
```

Note: `tagPrefix` and `tagSeparator` are inherited from parent via the options object passed to `Client.call`, so `this.tagPrefix` and `this.tagSeparator` are already set correctly after `Client.call` returns.

**Step 4: Update `send()` to use `_globalTagStr` when there are no per-metric tags**

Current `send()` (lines 346–368):
```js
Client.prototype.send = function (message, tags, callback) {
  let mergedTags = this.globalTags;
  if (tags && typeof tags === 'object') {
    mergedTags = helpers.overrideTags(mergedTags, tags, this.telegraf);
  }
  if (mergedTags.length > 0) {
    if (this.telegraf) {
      // ... telegraf path (unchanged)
    } else {
      message += `|${this.tagPrefix}${mergedTags.join(this.tagSeparator)}`;
    }
  }
  this._send(message, callback);
};
```

Replace the non-Telegraf tag-appending line with a conditional:

```js
Client.prototype.send = function (message, tags, callback) {
  let mergedTags = this.globalTags;
  if (tags && typeof tags === 'object') {
    mergedTags = helpers.overrideTags(mergedTags, tags, this.telegraf);
  }
  if (mergedTags.length > 0) {
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
    } else if (mergedTags === this.globalTags) {
      // Fast path: no per-metric tags, use pre-joined string
      message += this._globalTagStr;
    } else {
      // Slow path: per-metric tags were merged, must rejoin
      message += `|${this.tagPrefix}${mergedTags.join(this.tagSeparator)}`;
    }
  }
  this._send(message, callback);
};
```

**Step 5: Run the full test suite**

```bash
npm test
```

Expected: All tests pass. The output from ESLint must also be clean (no new lint errors).

**Step 6: Commit**

```bash
git add lib/statsd.js
git commit -m "perf: pre-join global tag string to avoid array join on every send"
```

---

## Task 2: Cache Buffer.byteLength in sendMessage

`Buffer.byteLength(message)` is O(n) (it must scan the string to count UTF-8 bytes). It's currently called twice in `sendMessage` — once at the top for telemetry tracking and once inside the callback. We compute it once.

**Files:**
- Modify: `lib/statsd.js` (`sendMessage` near line 453)

**Step 1: Read `sendMessage`**

Read `lib/statsd.js` lines 453–536. Note the two calls to `Buffer.byteLength(message)`:
- Line 462: `const messageBytes = Buffer.byteLength(message);`
- Line 508: `debug('hot-shots sendMessage: successfully sent %d bytes', Buffer.byteLength(message));`

**Step 2: Replace the second call with the cached value**

Line 508 is inside `handleCallback`. The variable `messageBytes` is already declared in the outer scope of `sendMessage` and is accessible inside the closure. Simply replace `Buffer.byteLength(message)` on line 508 with `messageBytes`.

The line becomes:
```js
debug('hot-shots sendMessage: successfully sent %d bytes', messageBytes);
```

**Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass, no lint errors.

**Step 4: Commit**

```bash
git add lib/statsd.js
git commit -m "perf: cache Buffer.byteLength result in sendMessage"
```

---

## Task 3: Eliminate Buffer round-trip for TCP/stream transports

**Problem**: `sendMessage` does `this.socket.send(Buffer.from(message), callback)`. For TCP, the transport's `send` function immediately calls `addEol(buf)` which does `buf.toString()` — a string→Buffer→string round-trip on every message. Stream transport has the same pattern.

**Fix**: Pass the string directly to TCP/stream transports and remove the unnecessary conversion. UDP transport keeps its Buffer path since `dgram.socket.send` requires a Buffer.

**Files:**
- Modify: `lib/statsd.js` (`sendMessage` near line 531)
- Modify: `lib/transport.js` (`addEol` near line 21, `createTcpTransport.send` near line 53, `createStreamTransport.send` near line 374)

**Step 1: Read the relevant transport code**

Read `lib/transport.js` lines 1–30 (`addEol`), lines 43–84 (`createTcpTransport`), lines 365–411 (`createStreamTransport`).

**Step 2: Update `addEol` to accept a string directly**

Current `addEol`:
```js
const addEol = (buf) => {
  let msg = buf.toString();
  if (msg.length > 0 && msg[msg.length - 1] !== '\n') {
    msg += '\n';
  }
  return msg;
};
```

Change it to accept either a Buffer or a string (for backwards compatibility with any external callers, although there are none outside transport.js):
```js
const addEol = (buf) => {
  const msg = typeof buf === 'string' ? buf : buf.toString();
  if (msg.length > 0 && msg[msg.length - 1] !== '\n') {
    return msg + '\n';
  }
  return msg;
};
```

**Step 3: Update `sendMessage` in statsd.js to pass string for TCP/stream**

Current line 531:
```js
this.socket.send(Buffer.from(message), handleCallback);
```

Replace with:
```js
const payload = (this.protocol === PROTOCOL.TCP || this.protocol === PROTOCOL.STREAM)
  ? message
  : Buffer.from(message);
this.socket.send(payload, handleCallback);
```

`PROTOCOL` is already imported at the top of `statsd.js` via `const PROTOCOL = constants.PROTOCOL;`.

**Step 4: Run the full test suite**

```bash
npm test
```

Expected: All tests pass. TCP, UDS, UDP, and stream protocol tests must all still pass.

**Step 5: Commit**

```bash
git add lib/statsd.js lib/transport.js
git commit -m "perf: eliminate Buffer round-trip for TCP and stream transports"
```

---

## Task 4: Use process.hrtime.bigint() in timer functions

`process.hrtime()` allocates a `[seconds, nanoseconds]` array per call. Each timer measurement calls it twice (start + delta), plus destructuring and arithmetic. `process.hrtime.bigint()` returns a single BigInt with no array allocation (Node.js ≥10, well within the ≥16 requirement).

**Files:**
- Modify: `lib/statsFunctions.js` (`hrtimer` near line 120, `Client.prototype.timer` near line 34)

**Step 1: Read the relevant code**

Read `lib/statsFunctions.js` lines 34–60 (`timer`) and lines 120–130 (`hrtimer`).

**Step 2: Update `hrtimer()`**

Current:
```js
function hrtimer() {
  const start = process.hrtime();

  return () => {
    const durationComponents = process.hrtime(start);
    const seconds = durationComponents[0];
    const nanoseconds = durationComponents[1];
    const duration = (seconds * 1000) + (nanoseconds / 1E6);
    return duration;
  };
}
```

Replace with:
```js
function hrtimer() {
  const start = process.hrtime.bigint();

  return () => {
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
}
```

**Step 3: Update `Client.prototype.timer`**

Current (inside `timer`, lines ~39–47):
```js
const start = process.hrtime();
try {
  return func(...args, ctx);
} finally {
  // get duration in milliseconds
  const durationComponents = process.hrtime(start);
  const seconds = durationComponents[0];
  const nanoseconds = durationComponents[1];
  const duration = (seconds * 1000) + (nanoseconds / 1E6);
  // ...
}
```

Replace with:
```js
const start = process.hrtime.bigint();
try {
  return func(...args, ctx);
} finally {
  const duration = Number(process.hrtime.bigint() - start) / 1e6;
  // ...
}
```

Remove the now-unused `durationComponents`, `seconds`, and `nanoseconds` variables. Keep `duration` and the lines that follow (`finalTags`, `_this.timing(...)`) unchanged.

**Step 4: Run the full test suite**

```bash
npm test
```

Expected: All tests pass. The timing/timer/asyncTimer tests in `test/statsFunctions.js` (or similar) must still pass.

**Step 5: Commit**

```bash
git add lib/statsFunctions.js
git commit -m "perf: use process.hrtime.bigint() to avoid array allocation in timers"
```

---

## Task 5: Optimize overrideTags — fast-path for disjoint tag sets

`overrideTags` is called from `send()` for every metric that has per-metric tags. It always builds a `childCopy` object, runs `filter` (creates a new array), iterates `Object.keys`, then `concat` — even when the child tags have no key overlap with the parent (the common case for per-metric tags that are unrelated to global tags). We add a fast-path that detects no overlap and concatenates directly.

**Files:**
- Modify: `lib/helpers.js` (`overrideTags` near line 94)

**Step 1: Read `overrideTags`**

Read `lib/helpers.js` lines 94–131.

**Step 2: Add a fast-path before the existing logic**

Insert the following fast-path at the start of `overrideTags`, after the `if (!child) { return parent; }` guard:

```js
function overrideTags (parent, child, telegraf) {
  if (!child) {
    return parent;
  }

  const formattedChild = formatTags(child, telegraf);

  // Fast path: if no child tag key appears in the parent, just concatenate.
  // This is the common case when per-metric tags don't overlap with global tags.
  const parentKeys = new Set();
  for (const tag of parent) {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx > 0) {
      parentKeys.add(tag.substring(0, idx));
    }
  }

  let hasOverlap = false;
  for (const tag of formattedChild) {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx > 0 && parentKeys.has(tag.substring(0, idx))) {
      hasOverlap = true;
      break;
    }
  }

  if (!hasOverlap) {
    return parent.concat(formattedChild);
  }

  // Slow path: rebuild parent, replacing tags whose keys appear in child.
  const childCopy = {};
  const toAppend = [];

  formattedChild.forEach(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) {
      toAppend.push(tag);
    } else {
      const key = tag.substring(0, idx);
      const value = tag.substring(idx + 1);
      childCopy[key] = childCopy[key] || [];
      childCopy[key].push(value);
    }
  });

  const result = parent.filter(tag => {
    const idx = typeof tag === 'string' ? tag.indexOf(':') : -1;
    if (idx < 1) {
      return true;
    }
    const key = tag.substring(0, idx);
    return !childCopy.hasOwnProperty(key);
  });

  Object.keys(childCopy).forEach(key => {
    for (const value of childCopy[key]) {
      result.push(`${key}:${value}`);
    }
  });
  return result.concat(toAppend);
}
```

Note: The slow path still uses the old `childCopy = {}` approach. Tasks 6 and 7 will convert it to `Map` and `push`. Keep the slow path as-is for now to keep this task's diff minimal.

**Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass. The `overrideTags` tests (in `test/helpers.js` or similar) must still pass, especially tests that verify tag key overriding behavior.

**Step 4: Commit**

```bash
git add lib/helpers.js
git commit -m "perf: add fast-path to overrideTags for disjoint tag sets"
```

---

## Task 6: Convert childCopy to Map in the overrideTags slow path

In the slow path of `overrideTags`, `childCopy` is a plain object. `childCopy.hasOwnProperty(key)` traverses the prototype chain on every parent tag. A `Map` has O(1) `has()` with no prototype lookup.

**Files:**
- Modify: `lib/helpers.js` (slow path of `overrideTags`)

**Step 1: Read the current slow path**

After Task 5, the slow path in `overrideTags` uses `childCopy = {}`. Read it again to confirm the current state.

**Step 2: Convert childCopy to a Map**

In the slow path, replace:

```js
const childCopy = {};
```
with:
```js
const childCopy = new Map();
```

Replace:
```js
childCopy[key] = childCopy[key] || [];
childCopy[key].push(value);
```
with:
```js
if (!childCopy.has(key)) {
  childCopy.set(key, []);
}
childCopy.get(key).push(value);
```

Replace in the `filter` callback:
```js
return !childCopy.hasOwnProperty(key);
```
with:
```js
return !childCopy.has(key);
```

Replace the `Object.keys().forEach` iteration:
```js
Object.keys(childCopy).forEach(key => {
  for (const value of childCopy[key]) {
    result.push(`${key}:${value}`);
  }
});
```
with:
```js
for (const [key, values] of childCopy) {
  for (const value of values) {
    result.push(`${key}:${value}`);
  }
}
```

**Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add lib/helpers.js
git commit -m "perf: use Map for childCopy in overrideTags slow path"
```

---

## Task 7: Use push instead of concat for toAppend in overrideTags

`result.concat(toAppend)` creates a fourth array (first: `formatTags`, second: `formattedChild` via fast-path or `filter`, third: `result` from filter, fourth: `concat`). Since `result` was just created by `filter`, we can mutate it with `push`.

**Files:**
- Modify: `lib/helpers.js` (end of `overrideTags` slow path)

**Step 1: Read the end of the overrideTags slow path**

After Task 6, the last two lines of the slow path should be:
```js
}
return result.concat(toAppend);
```

**Step 2: Replace concat with push**

```js
result.push(...toAppend);
return result;
```

Note: `toAppend` contains value-only tags (tags without a `:` or with `:` at index 0). In practice this is rare. The spread `...toAppend` is fine since `toAppend` is small.

**Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass. Pay special attention to tests that cover value-only tags (tags without key:value format).

**Step 4: Commit**

```bash
git add lib/helpers.js
git commit -m "perf: use push instead of concat in overrideTags to avoid extra allocation"
```

---

## Final verification

**Step 1: Run the full test suite one more time**

```bash
npm test
```

Expected: All tests pass, ESLint is clean.

**Step 2: Spot-check the changes**

```bash
git log --oneline -7
```

Should show 7 commits (one per task, Tasks 1–7), all on the current branch.

**Step 3: Check CHANGES.md**

Per project convention, add a single entry to `CHANGES.md` in the format:
```
* @<your-github-username> CPU performance improvements: pre-join global tags, eliminate Buffer round-trip for TCP/stream, cache byteLength, use hrtime.bigint, optimize overrideTags
```

```bash
git add CHANGES.md
git commit -m "docs: note CPU performance improvements in CHANGES.md"
```
