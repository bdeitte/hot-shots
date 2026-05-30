# Datadog mode — design

Date: 2026-05-29
Status: Approved (pending implementation plan)
Target release: 16.0.0 (major — see Versioning)

## Goal

Close the largest DogStatsD parity gaps between hot-shots and the official
Datadog clients (datadog-go, datadogpy, dogstatsd-csharp-client) by adding:

- Origin detection / container-ID auto-detection (`|c:` wire field)
- External Data (`DD_EXTERNAL_ENV` → `|e:` wire field)
- Cardinality (`|card:` wire field; client-wide default + per-call override)

These are introduced under a single new `datadog` mode flag (symmetric with the
existing `telegraf` flag) so that hot-shots' multi-backend audience (Etsy
StatsD, statsite, Telegraf, OpenTelemetry) is never silently affected.

## Background and motivation

`|c:`, `|e:`, and `|card:` are Datadog/DogStatsD protocol extensions. The
official clients can emit them unconditionally because they only ever talk to a
Datadog Agent. hot-shots cannot: it also targets vanilla StatsD and Telegraf
servers and has no inherent way to know which backend it is pointed at. Emitting
these extension fields by default would change the wire output for non-Datadog
users (wasted bytes at best, parser confusion at worst).

The `datadog` flag provides an explicit, positive signal that resolves this
ambiguity without fragile heuristics, and gives a forward-looking home for
future Datadog-only features (e.g. client-side aggregation).

Note: hot-shots already supports timestamped metrics (`|T`) for all metric
types via the per-call options object, so timestamps are *not* part of this
work despite being a parity item in some other clients.

## The `datadog` mode flag

### New constructor options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `datadog` | boolean \| undefined | `undefined` → auto-detect | Explicit `true`/`false` (like `telegraf`) forces the mode; unset auto-detects. |
| `originDetection` | boolean | `true` when in datadog mode | Sub-toggle for `\|c:` container-ID detection. Respects `DD_ORIGIN_DETECTION_ENABLED` env (falsey → off). |
| `containerID` | string | `undefined` | Manual container-ID override; skips cgroup parsing entirely. |
| `cardinality` | string | `DD_CARDINALITY` / `DATADOG_CARDINALITY` env, else unset | Client-wide default cardinality: `none`/`low`/`orchestrator`/`high`. |

### Resolving `this.datadog` at construction

- `datadog === true` or `datadog === false` → use verbatim (explicit wins).
- `datadog === undefined` → **auto-detect**: `true` when `telegraf` is false
  **and** a Datadog signal is present, else `false`.

**Datadog signals** (any one is sufficient):

- Any of these env vars set: `DD_AGENT_HOST`, `DD_DOGSTATSD_PORT`,
  `DD_ENTITY_ID`, `DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_EXTERNAL_ENV`,
  `DD_CARDINALITY`.
- Protocol is `uds` and `path` is the default Datadog socket
  (`/var/run/datadog/dsd.socket`).

### What `this.datadog === true` switches on

Each is independently overridable by an explicit option:

- `originDetection` defaults to `true` → resolve container ID, emit `|c:`.
- External data: read `DD_EXTERNAL_ENV`, emit `|e:`.
- `includeDatadogTelemetry` defaults to `true` (the flip described in
  Versioning; still settable to `false`).
- Cardinality env vars are read for the client-wide default.

### Guardrails

- `datadog: true` **and** `telegraf: true` → `console.error` warning; `telegraf`
  wins (more restrictive), datadog features stay off. Consistent with the
  existing "Not supported by Telegraf" posture.
- When not in datadog mode, behavior is **byte-for-byte unchanged** from today:
  no `|c:`/`|e:`/`|card:`, telemetry stays opt-in.
- `includeDataDogTags` (DD_* → `|#tags`) stays on by default regardless, exactly
  as today. (This is independent of `datadog` mode.)

## Feature: origin detection (`lib/originDetection.js`)

A new, self-contained, Linux-only resolver returning a container-ID string or
`undefined`. Resolved **once at construction**, cached on the client as
`this.containerID`; never re-read per metric. Pure `fs` — no new dependencies.

Resolution order (mirrors the official clients):

1. **Explicit `containerID` option** → use verbatim, skip all parsing.
2. **Host cgroup namespace check** — `fs.statSync('/proc/self/ns/cgroup').ino`.
   If it equals the host constant `0xEFFFFFFB`, proceed to cgroup-ID parsing
   (steps 3–4); otherwise prefer the inode fallback (step 5).
3. **`/proc/self/cgroup`** — parse lines, match the last path segment against the
   container-ID regexes (64-hex Docker; `32-hex-\d+` ECS; UUID/Garden). → `|c:<id>`.
4. **`/proc/self/mountinfo`** fallback — same regexes, rightmost match,
   excluding containerd sandboxes.
5. **cgroup v2 inode fallback** — build the controller path under
   `/sys/fs/cgroup`, `statSync` it, emit `in-<inode>` (reject inodes ≤ 2).

### Error-visibility rules

- All file reads are wrapped in try/catch.
- A *missing* `/proc` file (the normal case on macOS/Windows or outside a
  container) is **not** an error — it means "no container ID," logged only via
  `debug()`. The module no-ops cleanly on non-Linux.
- A genuine unexpected failure follows the CLAUDE.md convention: `errorHandler`
  if set, else `console.error` (never debug-only).

## Feature: external data

Read `process.env.DD_EXTERNAL_ENV` once at construction. Sanitize by stripping
control characters and `|` (matching the C# client: `replace(/[\x00-\x1f|]+/g, '')`).
Store as `this.externalData`. Emitted as `|e:<value>`.

## Feature: cardinality

- **Client-wide default**: `cardinality` option, else `DD_CARDINALITY` /
  `DATADOG_CARDINALITY` env. Validated against `none`/`low`/`orchestrator`/`high`;
  invalid → `console.error` warning + ignore.
- **Per-call override**: via the existing options-object path that already
  carries `{ sampleRate, tags, timestamp }` — add `cardinality`:

  ```js
  client.gauge('mem.used', 1234, { tags: ['x:y'], cardinality: 'low' });
  ```

  Per-call value wins over the client default. Also accepted in the `options`
  object of `event()` and `check()` for parity. Emitted as `|card:<value>`.

## Child clients

Child clients inherit the parent's resolved `datadog` mode, `this.containerID`,
`this.externalData`, and the client-wide `cardinality` default. They do **not**
re-run origin detection (no repeated cgroup parsing) — the parent resolves once
and children reuse the result, consistent with how children already share the
parent's socket and telemetry instance. A child may still override the
cardinality default via `childClient({ cardinality })`, and per-call cardinality
works on a child exactly as on the parent.

## Wire-format injection and field ordering

`|c:` and `|e:` are per-client constants; `|card:` is per-call. A small helper
builds the trailing field string. These fields are added **only when
`this.datadog === true`**, so non-datadog output is unchanged.

Three injection points, because of differing format rules:

- **Metrics** (`sendStat` / `send`): append `|c:…|e:…|card:…` after tags.
  (`|T` timestamp already sits here; trailing-field order is not significant to
  the Agent.)
- **Events** (`event` → `send`): appended after tags.
- **Service checks** (`check` → `_send`): inserted into the `check` array
  **after tags but before the `m:` message** field, preserving the "message must
  be last" rule.

## Versioning

Ship as **16.0.0 (major)**. Auto-detected datadog mode changes behavior for some
existing users:

1. New `|c:`/`|e:` wire fields appear for clients running in a Datadog
   environment (e.g. `DD_AGENT_HOST` set).
2. `includeDatadogTelemetry` flips to on under datadog mode, so those clients
   begin emitting `datadog.dogstatsd.client.*` telemetry every flush interval.

Both are the intended parity behavior and both are suppressible
(`originDetection: false`, `includeDatadogTelemetry: false`, or `datadog: false`).
CHANGES.md gets a prominent `BREAKING:` note describing the two changes and how
to opt out.

## Testing

New `test/datadogMode.js` plus origin-detection unit coverage, following the
existing Mocha + `test/helpers/helpers.js` conventions.

### Origin detection (`lib/originDetection.js`)

Inject the fs reads / paths so tests don't depend on the host:

- container ID from a Docker 64-hex cgroup line; ECS `32hex-\d+`; UUID/Garden.
- mountinfo fallback when cgroup has no match.
- cgroup-v2 inode → `in-<inode>`; inode ≤ 2 rejected.
- host-namespace branch vs. non-host branch.
- non-Linux / missing files → returns `undefined`, no throw, no `console.error`
  (debug only).
- explicit `containerID` option short-circuits all parsing.

### Mode resolution

- `datadog: true`/`false` explicit wins; `undefined` + each Datadog signal →
  auto-on; no signal → off.
- `datadog` + `telegraf` conflict → warns, telegraf wins, no `|c:`.
- telemetry default flips on under datadog mode, off otherwise, and
  `includeDatadogTelemetry: false` still suppresses it.

### Wire output

Via mock client / `createServer`, across UDP & UDS per `testTypes()` where
relevant:

- metrics, events, and service checks each carry `|c:`/`|e:` in datadog mode;
  service-check `m:` stays last.
- `|card:` from client default and from per-call options; per-call overrides
  default; valid on event/check.
- non-datadog mode emits **no** new fields (byte-for-byte regression guard).
- `DD_EXTERNAL_ENV` sanitization strips `|` and control chars.

## Documentation (per CLAUDE.md "Follow for all code changes")

### README.md

1. New "Datadog mode" section: the `datadog` flag, auto-detect signals, and the
   `originDetection` / `containerID` / `cardinality` options.
2. Update the backend-functionality list ("DogStatsD, Telegraf, and
   OpenTelemetry functionality", ~lines 323–338) with new DogStatsD-only
   entries:
   - `datadog parameter - DogStatsD`
   - `originDetection parameter - DogStatsD`
   - `containerID parameter - DogStatsD`
   - `cardinality parameter / option - DogStatsD`
   - `origin detection (|c:) and external data (|e:) - DogStatsD`
3. Add the new options to the options reference (~lines 67–102).
4. Note `cardinality` in the metric-options list (~line 117, beside `timestamp`).

### types.d.ts

- Add `datadog`, `originDetection`, `containerID`, `cardinality` to
  `ClientOptions`.
- Add `cardinality` to the metric options object (`MetricOptions` / the
  per-call tag options) and to `EventOptions` / `CheckOptions`.

### CHANGES.md

Entry in the required format with a prominent `BREAKING:` note covering the two
behavior changes and how to opt out.

## Files touched

- **New:** `lib/originDetection.js`, `test/datadogMode.js`, this design doc.
- **Modified:** `lib/statsd.js` (option parsing, mode resolution, container /
  external / cardinality resolution, injection in `sendStat` / `send` / `check`),
  `lib/statsFunctions.js` (`event` / `check` cardinality + injection),
  `lib/helpers.js` (cardinality validation / sanitization helper),
  `lib/constants.js` (cardinality values, host-ns inode, default Datadog socket
  path, cgroup regexes / paths), `types.d.ts`, `README.md`, `CHANGES.md`.

## Out of scope (future work, will also live under the `datadog` flag)

- Client-side aggregation (count/gauge/set, then extended) — needs its own
  design pass.
- `DD_DOGSTATSD_URL` address auto-detection.
- Windows named pipes; UDS stream (length-prefixed) transport.
- Bounded sender queue with explicit drop semantics.
