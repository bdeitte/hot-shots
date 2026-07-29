# perfTest

Development tools for measuring hot-shots. Neither is part of the published
package, and neither runs in CI — both are invoked by hand.

- `test.js` is a micro-benchmark of the hot path, in ops/sec.
- `Dockerfile` runs the full test suite on Ubuntu and reports how long it took,
  how many network calls it made, and how many DNS lookups it made.

## Micro-benchmark

```bash
npm run perf
```

That runs `node perfTest/test.js`, which exercises `increment`, `timing`, and
the `timer` wrapper in mock mode across several tag configurations. Mock mode
means no packets leave the process, so the numbers isolate formatting and tag
merging rather than transport.

Two environment variables tune it:

| Variable | Default | Meaning |
|---|---|---|
| `ITERS` | `300000` | Measured iterations per case |
| `WARMUP` | `20000` | Unmeasured iterations first, to let the JIT settle |

```bash
ITERS=1000000 WARMUP=50000 npm run perf
```

Compare runs on the same machine with nothing else running. Absolute ops/sec
figures are not comparable across machines.

## Measurement container

Build from the repo root, not from `perfTest/` — the build context is the whole
checkout:

```bash
docker build -f perfTest/Dockerfile -t hot-shots-perf .
```

Run it:

```bash
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf
```

The two extra flags let `strace` run inside the container. Without them the run
still works and still reports wall time and in-process counts, but the syscall
section reports itself as skipped.

### How long it takes

A default run takes roughly 6 minutes total: about 2.5 minutes for the
instrumented pass, then a second pass of the same suite under `strace` that
runs slower still because tracing every syscall is not free. There is no
progress output between the two `==> Pass` lines while a pass is running, so
it is normal for the container to look idle for a couple of minutes at a
time — that is not a hang.

The container is not slower than running the same suite on the host. A
verified run measured 155s for the instrumented pass in-container against
152s for the plain suite on the host it was built on — noise-level, not a
container tax.

### What it does

The suite runs twice.

Pass 1 attaches `perfTest/instrument.js` through `NODE_OPTIONS=--require`. That
module wraps `dns.lookup`, `dns.resolve*`, `dgram.Socket#send`,
`net.Socket#connect` and `#write`, `http`/`https` `request` and `get`, and
`unix-dgram` socket sends, counting invocations. Pass 1's wall time is the
headline figure, because the wrappers add only a few frames per call.

Pass 2 runs the same suite under `strace -f` and tallies real syscalls. Its wall
time is reported too, but labeled as inflated — tracing every syscall is not
free, so never quote that number as the suite's runtime.

Both passes run `npm test --ignore-scripts`, which skips the `pretest` lint
step. Lint is not a test, and eslint would otherwise add an unrelated Node
process to every count.

### Reading the two DNS numbers

The report shows DNS twice, and the numbers will not match. That is expected,
not a bug.

`dns.lookup calls` counts how many times the API was invoked. `resolver
syscalls (port 53)` counts how many times a query actually went out on the
wire. The gap comes from two places: `dns.lookup` short-circuits an IP literal
inside Node without touching the network, and `localhost` resolves out of
`/etc/hosts`. Since the test suite targets `127.0.0.1` nearly everywhere, the
port-53 count stays close to zero even when the in-process count is large.

These two numbers measure different layers and must not be added together or
otherwise merged into one figure.

That distinction is the whole point of the split. Work on how often hot-shots
invokes `dns.lookup` — for example, the per-packet lookup that used to happen
on every UDP send to an IP-literal host — moves the in-process number and
leaves the syscall number flat. Watch the `... for an IP literal` line for that
kind of change.

`http requests` and `https requests` should always read 0. hot-shots speaks
UDP, TCP, UDS, and raw streams, and makes no HTTP calls. The counters exist so
that a nonzero value would be visible if that ever stopped being true.

### The IP-literal count includes test scaffolding, not just hot-shots

`dns.lookup ... for an IP literal` is not a pure hot-shots number. Every
`server.listen(0, '127.0.0.1')` and `server.bind(0, '127.0.0.1')` in the test
helpers issues its own `dns.lookup` on that literal, and there are many of
them across the suite. That is why `127.0.0.1` dominates the `dns.lookup by
hostname` table (949 of 1295 total lookups in the verified run below) —
most of it is test setup binding listeners, not client code resolving a
destination.

Attributing the count properly would require tracking which call site issued
each lookup, which this harness does not do. Treat the IP-literal figure as a
signal to compare between two runs of this same harness (for example, before
and after a change to hot-shots' DNS behavior), not as an absolute count of
what the library itself does.

### Example output

From a clean run of the full suite (2018 passing, exit 0):

```
Wall time
  test suite (instrumented)                       155.12s
  test suite under strace (inflated)               188.75s

In-process counts (API invocations)
  dns.lookup calls                                    1295
    ... for an IP literal                              949
    ... for a hostname                                  346
  dns.resolve* calls                                     0
  dgram sends (UDP)                                   4748
  net connects (TCP)                                   320
  net writes (TCP)                                    26311
  unix-dgram sends (UDS)                                292
  http requests                                          0
  https requests                                         0

dns.lookup by hostname
  127.0.0.1                                            949
  localhost                                             336
  ...                                                      9
  definitely-not-a-real-host-12345.invalid                 1

Syscall counts (what the kernel saw)
  resolver syscalls (port 53)                            1
  socket()                                             3114
  connect()                                             992
  sendto()                                              339
  sendmsg()                                             3031
  sendmmsg()                                              0
```

These are one run's numbers, shown as an illustration of the report's shape,
not a guarantee of what any other run will print. Treat them the same way as
the IP-literal caveat above: useful to diff against a later run of this same
harness, not to be quoted as a fixed baseline.

### Comparing branches

There is no built-in diffing. Build and run once per branch, and compare the
printed tables:

```bash
git checkout main
docker build -f perfTest/Dockerfile -t hot-shots-perf .
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf

git checkout my-branch
docker build -f perfTest/Dockerfile -t hot-shots-perf .
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf
```

Counts are deterministic enough to compare directly. Wall time is not — take
several runs before believing a timing difference.

Only compare runs from images built around the same time. The Dockerfile
pulls `ubuntu:latest` and NodeSource's `setup_22.x`, both floating tags, so a
build done months apart can land on a different Ubuntu release or Node patch
version than an earlier build (the verified run above used Ubuntu 26.04 and
Node v22.23.1) and shift both timing and syscall counts for reasons that have
nothing to do with the code under test. Pin the base image and the NodeSource
setup script version in the Dockerfile if strict comparability over time
matters more than tracking current Node/Ubuntu.

### Micro-benchmark in the container

```bash
docker run --rm -e MODE=bench hot-shots-perf
```

`ITERS` and `WARMUP` work the same way here.

### Notes

- The image installs `build-essential` and `python3` so the optional
  `unix-dgram` dependency compiles. Without it the UDS tests degrade and the
  UDS send count reads 0.
- Node comes from NodeSource rather than the Ubuntu archive. To change the
  version, edit the `setup_22.x` line in the Dockerfile.
- The container exits nonzero if either pass fails. A pass 2 (strace) failure
  additionally prints an explicit warning that the syscall counts are
  incomplete and must not be compared against another run. The report is
  printed either way.
