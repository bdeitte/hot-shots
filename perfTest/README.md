# Manual performance tests

Two tools for measuring hot-shots. Neither ships in the published package and
neither runs in CI. Run both by hand.

- `test.js` benchmarks the hot path in ops/sec.
- `Dockerfile` runs the full test suite on Ubuntu and counts the network and
  DNS calls it makes.

## Micro-benchmark

```bash
npm run perf
```

This exercises `increment`, `timing`, and the `timer` wrapper in mock mode
across several tag configurations. No packets leave the process, so the
numbers cover formatting and tag merging rather than transport.

| Variable | Default | Meaning |
|---|---|---|
| `ITERS` | `300000` | Measured iterations per case |
| `WARMUP` | `20000` | Unmeasured iterations first, so the JIT settles |

```bash
ITERS=1000000 WARMUP=50000 npm run perf
```

Compare runs on one machine with nothing else competing for it. Ops/sec
figures do not carry across machines.

## Measurement container

Build from the repo root. The build context is the whole checkout:

```bash
docker build -f perfTest/Dockerfile -t hot-shots-perf .
```

Run it:

```bash
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf
```

Those two flags let `strace` run inside the container. Drop them and the run
still reports wall time and in-process counts, with the syscall section marked
skipped.

The suite runs twice. Pass 1 attaches a preload module that counts calls into
`dns`, `dgram`, `net`, `http`, and `unix-dgram`, and its wall time is the
figure to quote. Pass 2 runs the same suite under `strace` for syscall counts,
and tracing inflates its wall time. Expect several minutes per pass with no
output while one is running.

Both passes skip the `pretest` lint step, which would add an unrelated Node
process to every count.

## Reading the report

DNS appears twice and the two figures will differ. `dns.lookup calls` counts
API invocations. `resolver syscalls (port 53)` counts queries that reached the
wire. Node answers an IP literal inside `dns.lookup` without touching the
network, and `localhost` comes from `/etc/hosts`, so the syscall count sits
near zero while the in-process count runs high. Never add the two together.

That split is the point of the harness. Changing how often hot-shots calls
`dns.lookup` moves the in-process number and leaves the syscall number flat.
Watch the `... for an IP literal` line for that kind of change.

`http requests` and `https requests` read 0. hot-shots speaks UDP, TCP, UDS,
and raw streams. The counters exist so a nonzero value would surface if that
ever changes.

The IP-literal count includes test scaffolding. Every
`server.listen(0, '127.0.0.1')` in the test helpers issues its own
`dns.lookup` on that literal, which is why `127.0.0.1` dominates the
by-hostname table. Tracing each lookup back to its call site is beyond what
this harness does. Diff the figure against another run of the same harness
instead of reading it as a count of library behavior.

## Comparing branches

Build and run once per branch, then compare the tables:

```bash
git checkout main
docker build -f perfTest/Dockerfile -t hot-shots-perf .
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf
```

Counts hold steady enough to compare. Wall time drifts, so take
several runs before trusting a timing difference.

Compare images built around the same time. The Dockerfile pulls
`ubuntu:latest` and NodeSource's `setup_22.x`, both floating tags, so builds
months apart can land on a different Ubuntu release or Node patch and shift
the numbers for reasons unrelated to your code. Pin both in the Dockerfile if
comparability over time matters more than tracking current versions.

## Micro-benchmark in the container

```bash
docker run --rm -e MODE=bench hot-shots-perf
```

`ITERS` and `WARMUP` work the same way here.

## Notes

- The image installs `build-essential` and `python3` so `unix-dgram` compiles.
  Without it the UDS tests degrade and the UDS send count reads 0.
- Node comes from NodeSource. Change the version by editing the `setup_22.x`
  line in the Dockerfile.
- The container exits nonzero if either pass fails. A failed strace pass also
  prints a warning that the syscall counts are incomplete. The report prints
  either way.
