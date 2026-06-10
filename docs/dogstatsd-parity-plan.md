# DogStatsD parity plan

Comparison of hot-shots against the official Datadog DogStatsD clients
([datadog-go](https://github.com/DataDog/datadog-go) v5.x,
[datadogpy](https://github.com/DataDog/datadogpy) v0.52+,
[dogstatsd-csharp-client](https://github.com/DataDog/dogstatsd-csharp-client) v9.x),
with recommendations for which gaps are worth closing. Researched June 2026.

## Where hot-shots already has parity

hot-shots is closer to the official clients than its age suggests. It already covers:

- All metric types (count, gauge, histogram, distribution, set, timing), plus
  `gaugeDelta` and timer wrappers (`timer`, `asyncTimer`, `asyncDistTimer`) that the
  official clients mostly lack.
- Events and service checks, including per-call cardinality.
- Origin detection with the same cgroup → mountinfo → cgroup-inode fallback chain,
  `containerID` override, and `DD_ORIGIN_DETECTION_ENABLED`.
- Tag cardinality (`|card:`), global and per-metric, with `DD_CARDINALITY` /
  `DATADOG_CARDINALITY`.
- External data (`DD_EXTERNAL_ENV` → `|e:`).
- Client telemetry matching the official `datadog.dogstatsd.client.*` metric set.
- Per-metric timestamps (`|T`, the equivalent of `CountWithTimestamp` /
  `GaugeWithTimestamp`).
- `DD_AGENT_HOST`, `DD_DOGSTATSD_PORT`, `DD_ENTITY_ID`, `DD_ENV`, `DD_SERVICE`,
  `DD_VERSION` env handling.
- Sample rates, mock mode, errorHandler, DNS caching, `useDefaultRoute`, graceful
  TCP/UDS reconnection.

hot-shots also has features the official clients don't: TCP transport, raw stream
transport, Telegraf mode, and child clients.

## Gaps

### 1. Client-side aggregation

The largest functional gap. datadog-go and the C# client aggregate counts, gauges,
and sets client-side **by default** (datadog-go: 2s flush interval; C#: 2s, max 1M
unique contexts); datadogpy offers it opt-in. datadog-go and datadogpy also offer
"extended" aggregation that batches histogram/distribution/timing samples per
context with reservoir sampling (`WithMaxSamplesPerContext` /
`max_metric_samples_per_context`) and an adjusted sample rate. hot-shots only does
string-level buffering — every `increment()` call produces a line on the wire.
Aggregation materially reduces network traffic and Agent load for hot counters.

### 2. `DD_DOGSTATSD_URL` transport configuration

All three official clients accept a single URL-style env var / config
(`udp://host:port`, `unix:///path/to/socket`, plus `unixstream://` where supported)
that overrides host/port/socket settings. datadog-go and datadogpy also honor the
legacy `DD_DOGSTATSD_SOCKET`. hot-shots only reads `DD_AGENT_HOST` and
`DD_DOGSTATSD_PORT`, so UDS configuration can't come from the environment at all.

### 3. UDS stream mode (`unixstream`)

datadog-go and datadogpy support SOCK_STREAM Unix sockets (payloads prefixed with a
32-bit little-endian length header), which give reliable delivery and backpressure.
Notably for Node: stream sockets work with the built-in `net` module, so this would
provide a UDS path **without the optional native `unix-dgram` dependency** — a
long-standing pain point for hot-shots users.

### 4. Public `flush()` method

All three official clients expose an explicit flush (`Flush()`, `flush()`,
`Flush(flushTelemetry)`), which is the supported pattern for serverless/short-lived
processes (the C# client added a whole `SynchronousMode` for this). hot-shots
buffers can only be drained by the interval timer or `close()`.

### 5. `DD_TAGS` global tags

datadogpy reads `DD_TAGS` / `DATADOG_TAGS` (comma-delimited) into constant tags.
hot-shots does not.

### 6. Separate telemetry endpoint

datadog-go (`WithTelemetryAddr`) and datadogpy (`telemetry_host`/`telemetry_port`/
`telemetry_socket_path`) can send client telemetry to a different destination than
metrics. hot-shots always sends telemetry over the main transport.

### 7. Programmatic telemetry access

datadog-go exposes `GetTelemetry()` (and `IsClosed()`); hot-shots tracks the same
counters internally but doesn't expose them to callers.

### 8. Windows named pipes

datadog-go and the C# client support `\\.\pipe\...` transports
(`DD_DOGSTATSD_PIPE_NAME`). Node can open named pipes via `net`, so this is
feasible, but demand is niche.

### 9. Oversize-payload policy

The official clients enforce a max payload size (1432 bytes UDP / 8192 UDS) and
have an explicit policy for oversized single metrics (Go: `MessageTooLongError`;
C#: `StatsdTruncateIfTooLong`; Python: drop + log). hot-shots sends whatever the
metric serializes to and relies on the OS to reject it. Related: official clients
buffer by default with short flush intervals (100–300ms), where hot-shots defaults
to unbuffered with a 1000ms interval when enabled.

### 10. Manual timer handle

The C# client has `StartTimer()` (disposable) and datadogpy has `timed` as a
context manager. hot-shots' `timer`/`asyncTimer` only wrap functions; there's no
`const stop = statsd.startTimer('stat'); ...; stop();` ergonomics.

### Not applicable to Node

Fork-safety hooks (Python), channel/mutex input modes and worker counts (Go),
background sender threads (Go/C#/Python), and `ClientDirect`/`DistributionSamples`
(Go, experimental) all exist to manage thread contention or process forking and
have no real equivalent in Node's single-threaded, async-socket model. C#'s
`SynchronousMode` is covered by hot-shots' existing immediate-send default plus a
future `flush()`.

## Recommendations

### Tier 1 — worth doing

| # | Feature | Effort | Why |
|---|---------|--------|-----|
| 1 | `DD_DOGSTATSD_URL` (+ legacy `DD_DOGSTATSD_SOCKET`) | Small | Standard config surface across all official clients; today UDS can't be configured by env at all. |
| 2 | Public `flush(callback)` | Small | Serverless/Lambda story; prerequisite for recommending buffering. |
| 3 | `DD_TAGS` support | Trivial | Rounds out env-tag parity alongside DD_ENV/DD_SERVICE/DD_VERSION. |
| 4 | UDS stream protocol (`uds-stream` via `node:net`, length-prefixed framing) | Medium | Parity with Go/Python *and* removes the `unix-dgram` native-module pain point. |
| 5 | Client-side aggregation (counts/gauges/sets, opt-in initially) | Large | The flagship gap; on-by-default in Go and C#. Ship opt-in (`aggregation: { flushInterval }`), consider default-on in a later major. |

Suggested order: 1–3 are quick wins shippable individually; 4 next; 5 is its own
project (new aggregation layer keyed by metric+tags+cardinality context, flush
timer, telemetry `aggregated_context` gauge).

### Tier 2 — consider after Tier 1

- Extended aggregation for histogram/distribution/timing with
  `maxSamplesPerContext` reservoir sampling (follows naturally from #5).
- `getTelemetry()` accessor returning the counters hot-shots already tracks.
- Separate telemetry endpoint option.
- Oversize-payload policy + adopting 1432/8192 optimal payload defaults when
  buffering is enabled.
- `startTimer()` manual timer handle.

### Tier 3 — probably skip

- Windows named pipes (niche; revisit on user demand).
- Fork-safety, channel modes, sender threads — not applicable to Node.
