# Eliminating per-packet DNS lookups in the UDP transport

Date: 2026-07-25

## Background

[DataDog/dd-trace-js#2984](https://github.com/DataDog/dd-trace-js/issues/2984) reported that a
Node app's APM traces were dominated by `dns.lookup` spans, and
[a comment on that issue](https://github.com/DataDog/dd-trace-js/issues/2984#issuecomment-1523831047)
attributed a large share of them to hot-shots.

The root cause is in Node itself: `dgram.Socket#send` routes the destination address through the
socket's `lookup` function before every packet. `dns.lookup` short-circuits an IP literal without
contacting a resolver, but it still creates an instrumented async operation, which is what APM
tools surface as a span. [nodejs/node#64131](https://github.com/nodejs/node/pull/64131) proposes
fixing this upstream but is unmerged, so hot-shots must mitigate it.

Measured on Node v24.13.1, raw `dgram` sending 50 packets to `127.0.0.1` performs 51 `dns.lookup`
calls.

## Current state

`lib/transport.js:126-136` installs a bypass `lookup` on the socket, but only when `args.host` is
an IP literal. That was added in `4cae759` and shipped in v12.0.0, and it does fix the case named
in the issue.

Measured against current `main`, sequential sends (steady state):

| config | dns.lookup calls per send |
| --- | --- |
| no host (default) | 1 |
| `host: 127.0.0.1` | 0 |
| `host: ::1` | 0 |
| `host: localhost` | 1 |
| `host: localhost` + `cacheDns` | 1 |

Two gaps remain.

**Gap 1 — the default configuration is unprotected.** `lib/statsd.js:101` leaves `this.host`
undefined when neither `host` nor `DD_AGENT_HOST` is set, so `ipVersion` at `transport.js:117` is
0 and no bypass is installed. Every packet pays a lookup. This is the most common configuration in
the wild. Node passes `0.0.0.0` to the socket's lookup in this case, so it is trivially bypassable.

**Gap 2 — `cacheDns` saves nothing with a hostname.** `sendUsingDnsCache` caches the resolved
address, then hands that address to `socket.send`, which performs a second lookup on it because no
bypass was installed for a hostname host. The cache resolves the hostname once and immediately
gives the saving back. Under concurrency it is worse: 50 parallel sends produced 101 lookups,
because the cache is only populated in the async callback, so every in-flight send launches its own
resolution.

## Target behavior

| config | after this work |
| --- | --- |
| no host (default) | 0 |
| IP host (v4 or v6) | 0 |
| hostname, no `cacheDns` | 1 per send (inherent — it must resolve) |
| hostname + `cacheDns` | 1 per TTL |

## Design

### 1. Always-on bypass lookup

Replace the `ipVersion`-gated block at `lib/transport.js:126-136` with a bypass that decides per
call:

```js
if (!socketOptions.lookup) {
  socketOptions.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const version = net.isIP(hostname);
    if (version) {
      callback(null, hostname, version);
      return;
    }
    dns.lookup(hostname, options, callback);
  };
}
```

Three changes from the current code:

- Installed regardless of whether `args.host` is an IP literal, which closes Gap 1.
- Family is derived from `net.isIP(hostname)` per call rather than the fixed outer `ipVersion`.
  The old code returned `ipVersion` for whatever address it was handed, which is wrong for any
  address other than `args.host`.
- Hostnames delegate to real `dns.lookup`, with `options` preserved.

A user-supplied `udpSocketOptions.lookup` still takes precedence. The socket-type auto-detection at
`transport.js:117-124` is unchanged.

This change alone also closes Gap 2's redundant second lookup, because the resolved IP that
`sendUsingDnsCache` hands to `socket.send` now short-circuits.

### 2. DNS cache state machine

Extend the cache state:

```js
const dnsResolutionData = {
  timestamp: 0,
  resolvedAddress: undefined,
  refreshInFlight: false,
  consecutiveFailures: 0,
  pending: []          // [{ buf, callback }]
};
```

`timestamp` changes from `new Date(0)` to the number `0`; the existing arithmetic already relied on
coercion.

`sendUsingDnsCache(callback, buf)` dispatches on four cases:

1. **`args.host` is an IP literal** — cache it, send. (Existing short-circuit, retained.)
2. **Address known and fresh** — send on it.
3. **Address known and stale** — send on the stale address immediately, then start a background
   refresh if `refreshInFlight` is false. This is stale-while-revalidate: no send blocks at a TTL
   boundary.
4. **No address yet** — push `{ buf, callback }` onto `pending`, then start a lookup if
   `refreshInFlight` is false. This is the single-flight cold start.

On lookup success: store address and timestamp, clear `refreshInFlight`, reset
`consecutiveFailures` to 0, and drain `pending` through `sendToSocket`.

On lookup failure: clear `refreshInFlight`. If an address is already cached, keep serving it and
report per the streak rule below. If not (cold start), invoke every queued callback with the error,
matching today's behavior.

The result is at most one lookup in flight at any time.

### 3. Refresh failure reporting

A background refresh failure has no send callback to report through, since the send already went
out on the stale address. Report it on the first failure of a contiguous streak only, so a flapping
resolver does not emit on every TTL:

```
refresh fails:
  keep stale address, keep serving
  if consecutiveFailures === 0:
    socket.emit('error', err)
    if no user 'error' listener:
      console.error('hot-shots: DNS refresh for <host> failed: ...')
  consecutiveFailures++

refresh succeeds:
  consecutiveFailures = 0
```

`socket.emit('error', err)` reaches a user's `errorHandler` through the existing wiring at
`lib/statsd.js:201-202`. The `console.error` fallback satisfies the CLAUDE.md rule that a real
error must be visible without `NODE_DEBUG=hot-shots`; `attachDefaultErrorListener`
(`transport.js:35-41`) only calls `debug()`, so emitting alone is not sufficient. Presence of a
user listener is determined by checking whether any `'error'` listener other than the default one
is attached.

### 4. Pending queue bound and drop accounting

Add `DNS_MAX_PENDING = 1000` to `lib/constants.js`. When `pending` is at the cap, shift the oldest
entry and invoke its callback with a drop error before pushing the new one. Dropping oldest suits a
metrics client: the newest samples are the ones worth keeping.

Telemetry drop accounting needs no new plumbing. `lib/statsd.js:666` passes `handleCallback` as the
transport's send callback, and `handleCallback` already routes an error into
`recordBytesDroppedWriter` (`lib/statsd.js:631-633`). Invoking a dropped entry's callback with an
error therefore produces correct DogStatsD drop telemetry, and the transport stays
telemetry-agnostic. No new option is exposed; the cap is a constant.

### 5. Drain safety

This constraint governs the whole queue design. `handleCallback` decrements `messagesInFlight` and
resolves `drainPromise` when it reaches zero (`lib/statsd.js:618-625`). Every queued entry must
invoke its callback exactly once, on every path — flush, drop, or cold-start error — or `close()`
never resolves.

Accordingly, the UDP transport's `close()` must first fail any still-pending entries, then close
the socket.

## Testing

A shared helper `test/helpers/dnsCounter.js` patches `dns.lookup`, counts invocations, and exposes
a restore for `afterEach`. TTL-dependent tests use the Sinon fake-timer pattern already established
in `test/udpDnsCacheTransport.js`, installing the clock inside the `createServer` callback.

**Count matrix** — assert exact lookup counts over N sends for: no host, IPv4 host, IPv6 host,
hostname, hostname + `cacheDns`, a user-supplied `udpSocketOptions.lookup` (asserting the built-in
bypass is not installed), and an explicit socket `type` with a mismatched host family.

**Cache behavior** — N concurrent cold-start sends produce exactly 1 lookup and all N messages
reach the server; sends within TTL produce 0; a send past TTL is delivered on the stale address and
triggers exactly 1 refresh; concurrent stale sends trigger 1 refresh rather than N.

**Failure paths** — a cold-start failure propagates to every queued callback; a refresh failure
keeps serving the stale address; the streak rule reports once across repeated failures and re-arms
after an intervening success; the `console.error` fallback fires only when no user error listener
is attached.

**Drops** — exceeding `DNS_MAX_PENDING` drops the oldest entry with an error callback, and the
corresponding telemetry drop counter increments.

**Drain** — `close()` called during an in-flight lookup still invokes its callback.

## Documentation

- `CHANGES.md` entries for the fix and the cache rework.
- `README.md:89-91` — describe what `cacheDns` now does, and note that IP hosts skip lookups
  entirely regardless of `cacheDns`.
- `types.d.ts` — no change. No public API moves, since the queue cap is a constant.

## Commits

1. Always-on bypass lookup plus its tests.
2. Cache state machine, drop policy, drain safety, plus their tests.
3. Documentation.
