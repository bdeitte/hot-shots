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

Those two flags let `strace` run inside the container. If you drop them, the run
still reports wall time and in-process counts. The syscall section is then
marked skipped.

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
network, and `localhost` comes from `/etc/hosts`. The syscall count therefore
sits near zero while the in-process count runs high. Never add the two together.

That split is why the harness exists. Changing how often hot-shots calls
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
`ubuntu:latest` and NodeSource's `setup_22.x`, both floating tags. Builds months
apart can therefore land on a different Ubuntu release or Node patch, and shift
the numbers for reasons unrelated to your code. If comparability over time
matters more than current versions, pin both in the Dockerfile.

Use the same `test/` tree on both sides. A branch that adds tests otherwise
measures its own new tests as well as its code change. Copy one checkout's
`test/` over the other's and confirm both still report the same test count
before you compare anything.

## A worked comparison

Measured 2026-08-22, `main` at 798f1cc against `fix/dns-lookup-per-packet` at
a145310. Three runs each, alternating between the two images. Both images ran
an identical `test/` tree, `perfTest/`, `package.json`, and lockfile, so `lib/`
was the only difference. Every run reported 1963 passing and 0 failing.

Every count below was identical across all three runs of each image. Only wall
time moved.

| | main | branch |
|---|---|---|
| wall time, mean of 3 | 137.04s | 137.05s |
| dns.lookup calls | 1922 | 915 |
| ... for an IP literal | 1893 | 905 |
| ... for a hostname | 29 | 10 |
| dgram sends (UDP) | 1027 | 524 |
| net connects (TCP) | 316 | 316 |
| net writes (TCP) | 2660 | 2661 |
| unix-dgram sends (UDS) | 290 | 290 |
| resolver syscalls (port 53) | 1 | 1 |
| socket() | 2364 | 2364 |
| connect() | 648 | 648 |
| sendmsg() | 806 | 806 |

The `dns.lookup` drop is the change under test. It is entirely in the
by-hostname table: `0.0.0.0` falls from 475 to 0, `127.0.0.1` from 1418 to 905,
and `undefined` from 19 to 0. The 905 that remain are test scaffolding, which
the section above explains.

The `dgram sends` drop is not fewer packets. `sendmsg()` is unchanged at 806,
so the same datagrams reached the kernel. Node re-enters `Socket.send` when the
socket has not finished binding: it queues a bound copy of the call and replays
it after `listening`. The instrument counts both. Binding resolves its own
address, so a socket without the IP-bypass `lookup` waits on a thread-pool
`dns.lookup` and every early send doubles. With the bypass the bind resolves
in line and each send counts once. Confirm this with a two-line probe rather
than reading the number as saved packets.

Wall time did not move. The removed lookups short-circuit inside Node, so they
cost a small amount of CPU rather than any network wait. The gain is fewer APM
spans, not a faster test suite.

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
