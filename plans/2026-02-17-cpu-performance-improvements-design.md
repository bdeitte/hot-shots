# CPU Performance Improvements Design

**Date**: 2026-02-17
**Scope**: `lib/` only — behavior-preserving CPU efficiency improvements
**Approach**: Code-review-based, no benchmarks required
**Goal**: Reduce CPU overhead per metric send

## Background

hot-shots is a high-frequency metrics client. Every call to `increment`, `gauge`, `timing`, etc. flows through `send()` → `_send()` → `enqueue/sendMessage`. CPU savings on that path multiply across the entire workload. This design identifies seven changes across four files.

## Changes

### 1. Pre-join global tag string (statsd.js)

**Problem**: `send()` calls `mergedTags.join(this.tagSeparator)` on every metric even when global tags never change (the common case). Array traversal on every send is unnecessary when the result is constant.

**Fix**: Compute `this._globalTagStr` once in the constructor (and ChildClient constructor) after globalTags is finalized:

```js
this._globalTagStr = this.globalTags.length > 0
  ? `|${this.tagPrefix}${this.globalTags.join(this.tagSeparator)}`
  : '';
```

In `send()`, when there are no per-metric tags, use `message += this._globalTagStr` directly. Only compute a fresh join when per-metric tags require a merge via `overrideTags`.

### 2. Eliminate Buffer round-trip for TCP/stream (statsd.js + transport.js)

**Problem**: `sendMessage` does `this.socket.send(Buffer.from(message), callback)`. For TCP and stream transports, `send` immediately calls `addEol(buf)` which does `buf.toString()` — an unnecessary string→Buffer→string round-trip on every message.

**Fix**: In `sendMessage`, pass a `string` for TCP/stream, and a `Buffer` for UDP:

```js
const payload = (this.protocol === PROTOCOL.TCP || this.protocol === PROTOCOL.STREAM)
  ? message
  : Buffer.from(message);
this.socket.send(payload, handleCallback);
```

Update `addEol` and the TCP/stream transport `send` functions to accept strings. UDP transport keeps its Buffer-based path unchanged.

### 3. Cache Buffer.byteLength in sendMessage (statsd.js)

**Problem**: `Buffer.byteLength(message)` is called twice in `sendMessage` — once at line 462 for telemetry and again inside the `handleCallback` closure at line 508. `Buffer.byteLength` on a string is O(n) (it must encode the string to count bytes).

**Fix**: Compute once at the top of `sendMessage` and reuse in both locations:

```js
const messageBytes = Buffer.byteLength(message);
```

### 4. Use process.hrtime.bigint() in timer functions (statsFunctions.js)

**Problem**: `process.hrtime()` allocates a two-element `[seconds, nanoseconds]` array per call. `timer`, `asyncTimer`, and `asyncDistTimer` each call this twice per metric (start + delta), plus destructuring and two-step arithmetic.

**Fix**: Use `process.hrtime.bigint()` (available since Node.js 10, required ≥16 by hot-shots):

```js
function hrtimer() {
  const start = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - start) / 1e6;
}
```

And in `Client.prototype.timer`:
```js
const start = process.hrtime.bigint();
// in finally:
const duration = Number(process.hrtime.bigint() - start) / 1e6;
```

Eliminates one array allocation and two-step arithmetic per timer measurement.

### 5. Fast-path for disjoint tag sets in overrideTags (helpers.js)

**Problem**: `overrideTags` (called from `send()` for every metric with per-metric tags) always builds `childCopy`, runs `filter` (new array), and `concat` — even when child tags have no key overlap with parent tags (the most common case for per-metric tags).

**Fix**: Add a fast path that detects no overlap and returns `parent.concat(formattedChild)` directly, skipping the filter entirely.

### 6. Use Map for childCopy in overrideTags (helpers.js)

**Problem**: `childCopy` is a plain `{}`. `childCopy.hasOwnProperty(key)` (called inside the `filter` loop) traverses the prototype chain on every parent tag.

**Fix**: Use `new Map()` for `childCopy`. Replace `childCopy.hasOwnProperty(key)` with `childCopy.has(key)`. Iterate with `for (const [key, values] of childCopy)` instead of `Object.keys().forEach`.

### 7. push instead of concat for toAppend in overrideTags (helpers.js)

**Problem**: `return result.concat(toAppend)` creates a third array. `result` was already allocated by `filter`; we can mutate it.

**Fix**: `result.push(...toAppend); return result;` — in-place modification, one fewer allocation.

## Files Affected

| File | Changes |
|------|---------|
| `lib/statsd.js` | Items 1, 2, 3: `_globalTagStr` in constructor + ChildClient, use in `send()`, cache `messageBytes`, pass string vs Buffer by protocol |
| `lib/transport.js` | Item 2: Update TCP and stream `send` to accept string; update `addEol` |
| `lib/statsFunctions.js` | Item 4: `process.hrtime.bigint()` in `hrtimer()` and `timer` |
| `lib/helpers.js` | Items 5, 6, 7: fast-path, Map, push in `overrideTags` |

## Testing

All changes are behavior-preserving. Existing Mocha tests cover these code paths and should pass without modification. No new public API, no new options.

## Non-goals

- No benchmarks added (code-review-based approach agreed)
- No Telegraf message formatting optimization (Approach C) — lower priority
- No changes to buffering, TCP/UDS error handling, or telemetry logic
