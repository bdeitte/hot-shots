# Code review findings — `dogstatsd-parity` branch

Review of `git diff main...HEAD` (commits 3e29db7..bb39deb: DD_TAGS env tags,
DD_DOGSTATSD_URL/SOCKET transport config, public `flush()`, client-side
aggregation). 7 finder angles, each deduped candidate independently verified.
14 correctness findings confirmed; ranked most-severe first.

## Confirmed findings

### 1. close() force-close orphans a concurrent flush(callback) forever
**File:** `lib/statsd.js:806`

close()'s force-close path nulls `drainResolve`/`drainPromise` on every drain
client without resolving them, so a concurrent `flush(callback)` awaiting those
same promises hangs forever.

**Failure scenario:** A UDS/TCP send is stuck in flight; user calls `flush(cb)`
(which captures `client.drainPromise` into `Promise.all` at lib/statsd.js:691-699)
then `close()`. After the drain timeout, `finish()` sets `drainResolve = null`
without calling it; even if the transport callback later fires, `handleCallback`
(lib/statsd.js:602-608) decrements `messagesInFlight` to -1 and the resolve guard
fails — `cb` is never invoked. `flush()` is new in this diff, making the hang
newly reachable in the documented serverless "flush then exit" path.

### 2. flush() calls aggregator.flush() unguarded — sync throw drops contexts and orphans the callback
**File:** `lib/statsd.js:674`

`Client.prototype.flush()` calls `this.aggregator.flush()` with no try/catch
(unlike `close()` and the interval, which both guard it), so a synchronous send
throw drops all remaining aggregated contexts and the flush callback never fires.

**Failure scenario:** Client with `cacheDns` whose DNS lookup failed (or an
errorHandler that throws): `aggregator.flush` → `client.send` with no callback →
`_send` throws `this.dnsError` (lib/statsd.js:484). `Aggregator.flush` already
swapped `this.contexts` to a new Map (lib/aggregator.js:101-102), so every
context after the first is permanently lost, the exception escapes `flush()`,
and the user's callback is orphaned.

### 3. Post-close aggregated sends report success but are silently lost
**File:** `lib/statsd.js:390`

Metrics recorded through the shared aggregator after `parent.close()` report
success via callback but are silently lost forever — the unaggregated path
surfaces an error for the same post-close send.

**Failure scenario:** `parent = new StatsD({aggregation: true}); child =
parent.childClient({}); parent.close(); child.increment('m', cb)` — close()
cleared the interval but never nulled aggregator references, so sendStat's
aggregation branch records the metric and invokes `cb()` with no error. Nothing
remains to flush it. Without aggregation, sendMessage's missing-socket path
(lib/statsd.js:585-598) would surface an Error, per the project's
error-visibility convention.

### 4. Client-default sampleRate < 1 silently disables aggregation entirely
**File:** `lib/statsd.js:380`

`sampleRate = sampleRate || this.sampleRate` is hoisted above the aggregation
guard, so a client constructed with a default sampleRate < 1 never aggregates
anything — `aggregation: true` becomes a total no-op.

**Failure scenario:** `new StatsD({aggregation: true, sampleRate: 0.5})`: every
increment/gauge/set fails the `(!sampleRate || sampleRate >= 1)` check
(lib/statsd.js:387-390) and falls to 50% random sampling. The user opted into
aggregation expecting reduced packet volume and gets zero aggregation plus
random metric loss; README only documents per-call sample rates as bypassing,
and official DogStatsD clients aggregate sampled counts by scaling 1/rate instead.

### 5. Interval-driven aggregator flush is invisible to close()'s drain logic
**File:** `lib/statsd.js:1314`

The interval flush passes no `involvedClients` set, so in-flight child-routed
sends from a just-fired interval flush escape close()'s drain coordination and
the shared socket can be destroyed under them.

**Failure scenario:** Interval fires, routes a child-recorded count through
`child.send` → `child.messagesInFlight = 1` on a slow UDS/TCP socket;
`parent.close()` runs 10ms later: close-time flush finds zero contexts,
`drainClients = [this]`, `totalInFlight() === 0`, and `_close` destroys the
shared socket (children share `parent.socket`, lib/statsd.js:1036) while the
child's send is in flight — the metric is dropped, defeating the new
drainClients machinery.

### 6. aggregation.flushInterval is unvalidated — bad values create a 1ms hot flush loop
**File:** `lib/statsd.js:1311`

`aggregation.flushInterval` is never validated before `setInterval`, unlike
`bufferFlushInterval` which the constructor rejects when non-finite, <= 0, or
> 2147483647.

**Failure scenario:** `new StatsD({aggregation: {flushInterval: -5}})` (or 1e12
from a misparsed config) passes straight through Aggregator (lib/aggregator.js:18
only handles falsy) into `setInterval`, which Node clamps to 1ms — the aggregator
flushes every millisecond, pegging CPU and defeating aggregation. The identical
hazard is explicitly guarded for `bufferFlushInterval` at lib/statsd.js:85-94.

### 7. Invalid DD_DOGSTATSD_URL never falls back to DD_DOGSTATSD_SOCKET
**File:** `lib/helpers.js:326`

When DD_DOGSTATSD_URL is set but invalid/unsupported, `getDogstatsdEnvTransport`
returns null without falling back to DD_DOGSTATSD_SOCKET, silently defaulting to
UDP localhost:8125.

**Failure scenario:** `DD_DOGSTATSD_URL='unixstream:///var/run/datadog/dsd.socket'`
(a scheme official clients accept but hot-shots rejects) plus
`DD_DOGSTATSD_SOCKET='/var/run/datadog/dsd.socket'`: `parseDogstatsdUrl` returns
null, the socket var is never consulted (lib/helpers.js:325-330), and in a
UDS-only environment every metric is black-holed over UDP with only a one-line
startup console.error.

### 8. DD_TAGS clobbers a child client's explicit globalTags overrides
**File:** `lib/statsd.js:1193`

DD_TAGS is applied inside `setupDatadogGlobalTags`, which re-runs on every child
construction after the child's globalTags merge, so DD_TAGS silently clobbers a
child's explicit override of any matching key.

**Failure scenario:** `DD_TAGS=team:core; statsd.childClient({globalTags:
['team:checkout']})` — ChildClient merges child tags first (lib/statsd.js:1061),
then the constructor calls `setupDatadogGlobalTags` with no isChild guard, and
`overrideTags` puts the env tags on the winning side: the child ends up with
`team:core`, discarding `team:checkout`. Verified empirically. Only reproduces
where DD_TAGS is set (i.e. production), and unlike DD_ENV/DD_SERVICE/DD_VERSION
this now affects arbitrary user-defined keys.

### 9. contextKey merges clients that differ only in default cardinality
**File:** `lib/aggregator.js:33`

`contextKey` omits client identity and the client's default cardinality, so a
parent and child with identical globalTags merge into one context that is
emitted with the first recorder's `|card:` setting.

**Failure scenario:** `parent = new StatsD({datadog: true, aggregation: true});
child = parent.childClient({cardinality: 'high'})`; both increment 'm' —
identical keys (child inherits `parent.globalTags` by reference,
lib/statsd.js:1060-1061; only per-call cardinality is in the key), so the
combined count is sent through one client and `getDatadogExtensionFields`
(lib/statsd.js:261) applies that client's default cardinality to both samples —
wrong for the other; send errors also route to the wrong client's errorHandler.

### 10. Env-transport config applies to telegraf clients, including a UDP→UDS protocol switch
**File:** `lib/statsd.js:57`

The DD_DOGSTATSD_URL/DD_DOGSTATSD_SOCKET env-transport block has no telegraf
guard, so a Telegraf client with no transport options gets silently rerouted to
the Datadog agent socket.

**Failure scenario:** Host has `DD_DOGSTATSD_URL=unix:///var/run/datadog/dsd.socket`
exported process-wide plus a Telegraf listener on localhost:8125;
`new StatsD({telegraf: true})` switches to UDS and sends Telegraf-formatted
metrics to the Datadog socket (and can fail at construction if optional
unix-dgram isn't installed). Contrast `detectDatadogMode`, which explicitly
excludes telegraf (lib/helpers.js:249-253).

## Confirmed but cut by the 10-finding cap

- **JSON.stringify tag keying** (`lib/aggregator.js:34`): object tags with
  different key order split into separate contexts, which for gauges can deliver
  a stale final value to the server (flush emits in insertion order; the server
  treats tag sets as unordered, so last write wins). Also `{a: undefined}` and
  `{}` collide into one context ('{}' key) and can cross-contaminate tags —
  `formatTags` emits `a:undefined` for an undefined-valued key.
- **NaN poisons a count context** (`lib/aggregator.js:81`): one
  `increment('m', NaN)` makes the whole window's sum NaN (`typeof NaN ===
  'number'` passes the sendStat guard) — pre-aggregation, each bad value was an
  isolated bad packet and other increments survived.
- **No telegraf gate on aggregation** (`lib/statsd.js:1301`): violates the
  documented DogStatsD-only feature pattern that `setupDatadogTelemetry`,
  `event`, and `check` all follow; a telegraf client gets delayed/merged metrics
  with no warning.
- **test/datadogMode.js cleanup list omits `DATADOG_TAGS`**
  (`test/datadogMode.js:12`): the code now reads it (lib/statsd.js:1193), so a
  host with `DATADOG_TAGS` set breaks the file's exact-output assertions (e.g.
  lines 146, 155, 169, 176, 226). One-word fix to the concat list.

## Themes

- **Drain/lifecycle coordination** is the highest-severity cluster: `flush()`,
  `close()`, and the interval flush each handle "wait for aggregated sends"
  differently (no timeout, budgeted timeout, and not at all, respectively).
  Findings 1, 2, and 5 are direct consequences. Consolidating drain tracking in
  one place (e.g. the aggregator persistently tracking clients it has routed
  through, or a shared drain primitive) would fix all three together.
- **Duplication:** this diff adds two more copies of the errorHandler try/catch
  boilerplate (now ~6-8 copies in lib/statsd.js plus lib/telemetry.js). A shared
  `reportError(client, err, context)` helper would shrink the diff and prevent
  drift. Likewise the guarded-unref'd-interval pattern now exists three times
  (buffer, telemetry, aggregation); Telemetry's `start()`/`stop()` shape is the
  better model.
- **Env-var precedence** is split across three sites: the constructor's
  5-field guard, the inline DD_AGENT_HOST/DD_DOGSTATSD_PORT fallbacks
  (lib/statsd.js:105-106), and a hardcoded 8125 inside `parseDogstatsdUrl`. A
  single `resolveTransportConfig()` in helpers would make the README's
  precedence chain match one function.
