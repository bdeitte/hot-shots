# perfTest Docker harness design

Date: 2026-07-28
Branch: fix/dns-lookup-per-packet

## Purpose

Give a repeatable, manually-invoked way to run the full hot-shots test suite on
Linux and report three things at the end of the run:

1. Wall time for the suite.
2. How many outbound network calls the suite made.
3. How many DNS lookups the suite made.

The motivating question is the `fix/dns-lookup-per-packet` branch, which stopped
`dns.lookup` from being invoked once per UDP packet for IP-literal hosts. The
harness exists so that effect can be observed rather than assumed.

## Why two measurement layers

`dns.lookup` short-circuits an IP literal inside Node and never issues a
resolver syscall. The test suite also targets `127.0.0.1` nearly everywhere, and
`localhost` resolves from `/etc/hosts`. A syscall-level counter alone would
therefore show almost no movement from this branch, because the change happened
above the wire.

So the harness reports both layers and labels them distinctly:

- In-process counts, from a `--require` preload module. Counts API invocations,
  including lookups that short-circuit. This is the layer this branch changed.
- Syscall counts, from `strace -f`. Counts what the kernel actually saw. This is
  the ground truth for real network egress.

The two DNS numbers are expected to differ. The README explains why, so the gap
reads as information rather than as a bug.

## Files

All new files live in `perfTest/`, except `.dockerignore`, which must sit at the
repo root to take effect.

| File | Role |
|---|---|
| `perfTest/Dockerfile` | Ubuntu latest, Node, build toolchain, `strace` |
| `perfTest/instrument.js` | Preload module; monkey-patches and counts in-process |
| `perfTest/run.sh` | Container entrypoint; orchestrates passes, parses strace |
| `perfTest/report.js` | Merges per-process JSON counts and strace tallies into the final table |
| `perfTest/README.md` | How to run the container and the `test.js` micro-benchmark |
| `.dockerignore` | Excludes `node_modules` so host macOS binaries do not leak into the image |

## Image

Base is `ubuntu:latest`. Node is installed from NodeSource so the version is a
current release rather than whatever the Ubuntu archive happens to carry;
`package.json` requires Node >= 18.

`build-essential` and `python3` are installed so that the optional `unix-dgram`
dependency compiles. This is not optional for this harness: without
`unix-dgram`, `test/helpers/helpers.js` logs an install error and the UDS tests
degrade, and UDS drain and retry behavior is a large part of what this branch
touches. `strace` is installed for the second pass.

Build context is the repo root with `-f perfTest/Dockerfile`. `package.json` and
`package-lock.json` are copied first and `npm ci` runs before the rest of the
source is copied, so editing library code does not invalidate the dependency
layer.

## Instrumentation

`perfTest/instrument.js` is attached through
`NODE_OPTIONS="--require /app/perfTest/instrument.js"`, which propagates to every
Node process the test script spawns.

It wraps and counts:

- `dns.lookup`, `dns.resolve4`, `dns.resolve6`
- `dgram.Socket.prototype.send`
- `net.Socket.prototype.connect`, `net.Socket.prototype.write`
- `http.request`, `http.get`, `https.request`, `https.get`
- `unix-dgram` socket `send`, reached by hooking `Module._load` so the wrapper is
  in place even though `lib/transport.js` requires the module lazily

DNS lookups are additionally bucketed by hostname and split into IP-literal
versus name, using `net.isIP`. That split is the specific number expected to move
on this branch.

Every wrapper preserves the original return value and argument shape, and passes
through unchanged on error. The instrumentation must not alter test outcomes; if
a pass fails under instrumentation but passes without it, that is a harness bug.

`npm test` runs `mocha` and then `node test/esm-import.mjs`, two separate
processes. Each writes `/tmp/hs-counts/<pid>.json` from a `process.on('exit')`
handler, and `report.js` sums the directory.

## Passes

Pass 1 runs `npm test` with the preload attached and nothing else. Its wall time
is the headline number reported to the user. Preload overhead is a small number
of wrapper frames per call and is treated as negligible for a test-suite-scale
measurement.

Pass 2 re-runs the same suite under `strace -f`, writing a trace log that is then
tallied. Its wall time is also reported, explicitly labeled as strace-inflated,
so it cannot be mistaken for the real figure.

strace invocation traces the network syscall set. Tallies come from the log:

- Resolver syscalls: `connect`/`sendto`/`sendmsg` lines whose sockaddr contains
  `sin_port=htons(53)`
- Raw totals for `socket`, `connect`, `sendto`, `sendmsg`, `sendmmsg`

`-f` is required because `getaddrinfo` runs on libuv's threadpool, so the
resolver syscalls appear on worker threads rather than the main thread.

## Running

The container needs `--cap-add=SYS_PTRACE --security-opt seccomp=unconfined` for
the strace pass. The README documents this. If the capability is missing, the
strace pass reports itself as skipped and pass 1 results still print, rather than
failing the whole run.

`MODE` selects what runs:

- `MODE=test` (default) runs the full suite as described above.
- `MODE=bench` runs `perfTest/test.js` for a Linux ops/sec baseline, honoring the
  existing `WARMUP` and `ITERS` environment variables.

## Output

A single table at the end of the run:

- Wall time for pass 1, and wall time for pass 2 marked as strace-inflated
- In-process counts section: DNS lookups total, split IP-literal versus name,
  per-hostname breakdown, dgram sends, TCP connects and writes, UDS sends, and
  HTTP/HTTPS requests
- Syscall counts section: port-53 syscalls and raw socket/connect/send totals

Exit status reflects the test suite result, so a failing suite fails the
container even though the report still prints.

## Non-goals

- No CI wiring. This is manually invoked.
- No cross-branch diffing inside the container. Comparing branches means building
  and running the image once per branch and comparing the printed tables.
- No attempt to make HTTP counts meaningful. hot-shots makes no HTTP calls; the
  counter exists so that a nonzero value is visible if that ever changes.
