# perfTest Docker Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manually-invoked Docker harness in `perfTest/` that runs the full hot-shots test suite on Ubuntu and reports suite wall time, in-process network/DNS call counts, and kernel-level syscall counts.

**Architecture:** An Ubuntu image runs the suite twice. Pass 1 attaches a `--require` preload module that monkey-patches `dns`, `dgram`, `net`, `http`/`https`, and `unix-dgram` to count API invocations; its wall time is the headline figure. Pass 2 re-runs the suite under `strace -f` for real syscall counts. A Node reporter merges both into one table.

**Tech Stack:** Docker, Ubuntu latest, Node 22 from NodeSource, bash, `strace`, Node core `dns`/`dgram`/`net`/`http`/`module`.

## Global Constraints

- All new files live in `perfTest/`, except `.dockerignore`, which must be at the repo root to take effect.
- Node floor is `>=18.0.0` per `package.json` `engines`. The image installs Node 22.
- `perfTest/` is not covered by the lint script (`eslint "./lib/**/*.js" "./test/**/*.{js,mjs}" "./*.mjs"`), so JSDoc and import-sort rules do not apply. Still use `'use strict'`, single quotes, and curly braces to match the codebase.
- Instrumentation must not change test outcomes. If the suite passes without the preload and fails with it, that is a harness bug, not a library bug.
- Do not add any file under `test/` — `npm test` globs `test/*.js`, and harness self-checks must not join the measured suite.
- The in-process DNS count and the syscall DNS count are expected to differ. Never present them as one number.
- Container exit status must equal the test suite's exit status, and the report must print regardless.

---

### Task 1: Image and build context

**Files:**
- Create: `.dockerignore`
- Create: `perfTest/Dockerfile`

**Interfaces:**
- Produces: an image with `/app` holding the repo, `node_modules` installed including a compiled `unix-dgram`, `strace` on `PATH`, and `ENTRYPOINT ["/app/perfTest/run.sh"]`. Later tasks fill in `run.sh`.

- [ ] **Step 1: Create `.dockerignore` at the repo root**

`node_modules` must be excluded so host macOS native builds of `unix-dgram` never enter the image; `npm ci` rebuilds it for Linux.

```
node_modules
.git
.nyc_output
coverage
*.log
```

- [ ] **Step 2: Create `perfTest/Dockerfile`**

`package.json` and `package-lock.json` are copied before the rest of the source so that editing library code does not invalidate the `npm ci` layer. `build-essential` and `python3` are required for `unix-dgram` to compile; without it the UDS tests degrade and this harness under-reports.

```dockerfile
FROM ubuntu:latest

ENV DEBIAN_FRONTEND=noninteractive

# build-essential + python3 are required to compile the optional unix-dgram
# dependency. Without it the UDS tests degrade and the harness under-reports.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg build-essential python3 strace \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chmod +x /app/perfTest/run.sh

ENV MODE=test

ENTRYPOINT ["/app/perfTest/run.sh"]
```

- [ ] **Step 3: Create a placeholder `perfTest/run.sh` so the image builds**

Task 4 replaces this entirely. It exists now only so `chmod` and `ENTRYPOINT` resolve.

```bash
#!/usr/bin/env bash
echo 'run.sh not implemented yet'
```

- [ ] **Step 4: Build the image and verify the toolchain**

Run from the repo root:

```bash
docker build -f perfTest/Dockerfile -t hot-shots-perf .
```

Expected: build succeeds.

- [ ] **Step 5: Verify Node, strace, and the compiled unix-dgram**

```bash
docker run --rm --entrypoint bash hot-shots-perf -c "node -v && strace -V | head -1 && node -e \"require('unix-dgram'); console.log('unix-dgram OK')\""
```

Expected: a `v22.x` version, an strace version line, and `unix-dgram OK`. If `unix-dgram` throws, the build toolchain is wrong — fix it before continuing, since the UDS tests are a primary reason this harness exists.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore perfTest/Dockerfile perfTest/run.sh
git commit -m "Add the Ubuntu image for the perfTest harness"
```

---

### Task 2: In-process counter preload module

**Files:**
- Create: `perfTest/instrument.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a module attached via `node --require`. On process exit it writes `${HS_COUNTS_DIR}/<pid>.json` (default `HS_COUNTS_DIR` is `/tmp/hs-counts`) with this exact shape, which `report.js` in Task 3 reads:

```json
{
  "pid": 123,
  "counts": {
    "dnsLookup": 0,
    "dnsLookupIpLiteral": 0,
    "dnsLookupHostname": 0,
    "dnsResolve": 0,
    "dgramSend": 0,
    "tcpConnect": 0,
    "tcpWrite": 0,
    "udsSend": 0,
    "httpRequest": 0,
    "httpsRequest": 0
  },
  "dnsByHost": { "localhost": 2 }
}
```

- [ ] **Step 1: Write `perfTest/instrument.js`**

Load order is a defensive ordering choice. Node's `dgram`, `net`, and `http` modules resolve `dns.lookup` at call time (verified on Node 22 and 24), so the wrappers are picked up regardless of require order. Still, patch `dns.lookup` early before requiring those modules.

```js
'use strict';

// Counts network and DNS API invocations for the perfTest harness. Attached
// with `node --require`, so it runs before any application code.
//
// IMPORTANT: dns.lookup is patched before dgram/net/http are required as a
// defensive ordering choice. Node's net/dgram/http resolve dns.lookup at call
// time (verified on Node 22 and 24), so the wrappers are picked up regardless.

const dns = require('dns');
const net = require('net');

const counts = {
  dnsLookup: 0,
  dnsLookupIpLiteral: 0,
  dnsLookupHostname: 0,
  dnsResolve: 0,
  dgramSend: 0,
  tcpConnect: 0,
  tcpWrite: 0,
  udsSend: 0,
  httpRequest: 0,
  httpsRequest: 0
};

const dnsByHost = Object.create(null);

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  counts.dnsLookup += 1;
  if (net.isIP(hostname)) {
    counts.dnsLookupIpLiteral += 1;
  } else {
    counts.dnsLookupHostname += 1;
  }
  const key = String(hostname);
  dnsByHost[key] = (dnsByHost[key] || 0) + 1;
  return originalLookup.call(this, hostname, ...rest);
};

for (const name of ['resolve', 'resolve4', 'resolve6']) {
  const original = dns[name];
  dns[name] = function resolveWrapper(...args) {
    counts.dnsResolve += 1;
    return original.apply(this, args);
  };
}

// Safe to require now that dns.lookup is wrapped.
const Module = require('module');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function send(...args) {
  counts.dgramSend += 1;
  return originalDgramSend.apply(this, args);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  counts.tcpConnect += 1;
  return originalConnect.apply(this, args);
};

const originalWrite = net.Socket.prototype.write;
net.Socket.prototype.write = function write(...args) {
  counts.tcpWrite += 1;
  return originalWrite.apply(this, args);
};

// http.get and https.get call their module-local request(), not the export, so
// wrapping both does not double count.
for (const [mod, key] of [[http, 'httpRequest'], [https, 'httpsRequest']]) {
  for (const name of ['request', 'get']) {
    const original = mod[name];
    mod[name] = function httpWrapper(...args) {
      counts[key] += 1;
      return original.apply(this, args);
    };
  }
}

// unix-dgram is a native module required lazily by lib/transport.js, so hook
// the loader to wrap sockets as they are created.
const originalLoad = Module._load;
Module._load = function _load(request, ...rest) {
  const loaded = originalLoad.call(this, request, ...rest);
  if (request === 'unix-dgram' && loaded && typeof loaded.createSocket === 'function' &&
      !loaded.__hotShotsInstrumented) {
    const originalCreateSocket = loaded.createSocket;
    loaded.createSocket = function createSocket(...args) {
      const socket = originalCreateSocket.apply(this, args);
      if (socket && typeof socket.send === 'function') {
        const originalSocketSend = socket.send;
        socket.send = function socketSend(...sendArgs) {
          counts.udsSend += 1;
          return originalSocketSend.apply(this, sendArgs);
        };
      }
      return socket;
    };
    loaded.__hotShotsInstrumented = true;
  }
  return loaded;
};

const outDir = process.env.HS_COUNTS_DIR || '/tmp/hs-counts';

process.on('exit', () => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, counts: counts, dnsByHost: dnsByHost })
    );
  } catch (err) {
    console.error(`hot-shots perfTest instrument: failed to write counts: ${err && err.message}`);
  }
});
```

- [ ] **Step 2: Verify the counters fire, on the host**

This checks the wrappers directly. It does not need Docker.

```bash
HS_COUNTS_DIR=/tmp/hs-verify node --require ./perfTest/instrument.js -e "
const dgram = require('dgram');
const dns = require('dns');
const s = dgram.createSocket('udp4');
s.send('x', 8125, '127.0.0.1', () => { s.close(); });
dns.lookup('localhost', () => {});
"
cat /tmp/hs-verify/*.json
```

Expected: JSON showing `dgramSend` at least 1, `dnsLookup` at least 1, `dnsLookupHostname` at least 1, and `dnsByHost` containing `localhost`. `httpRequest` and `httpsRequest` are 0.

- [ ] **Step 3: Verify the IP-literal split**

This is the number the `fix/dns-lookup-per-packet` branch moves, so confirm it is tracked separately.

```bash
rm -rf /tmp/hs-verify
HS_COUNTS_DIR=/tmp/hs-verify node --require ./perfTest/instrument.js -e "
require('dns').lookup('127.0.0.1', () => {});
"
cat /tmp/hs-verify/*.json
```

Expected: `dnsLookupIpLiteral` is 1 and `dnsLookupHostname` is 0.

- [ ] **Step 4: Verify the suite still passes under the preload**

The instrumentation must be transparent. `test/helpers/dnsCounter.js` also patches `dns.lookup` and restores it; the two wrappers compose, but confirm it.

```bash
HS_COUNTS_DIR=/tmp/hs-verify npx mocha -R dot --timeout 5000 \
  --require ./perfTest/instrument.js \
  test/udpDnsLookupCount.js test/transport.js
```

Run it a second time without `--require ./perfTest/instrument.js` and confirm the
result is identical. That comparison is the actual check — one run alone proves
nothing about transparency.

Expected: PASS, same result as running those files without `--require`. If `test/udpDnsLookupCount.js` fails, the preload is interfering — stop and fix `instrument.js` rather than changing the test.

- [ ] **Step 5: Clean up the scratch directory**

```bash
rm -rf /tmp/hs-verify
```

- [ ] **Step 6: Commit**

```bash
git add perfTest/instrument.js
git commit -m "Add the in-process network and DNS counter for perfTest"
```

---

### Task 3: Report aggregator

**Files:**
- Create: `perfTest/report.js`

**Interfaces:**
- Consumes: the `${pid}.json` files written by `perfTest/instrument.js` (Task 2), and an strace log produced in Task 4.
- Produces: `node perfTest/report.js <countsDir> <straceLog> <wallMainMs> <wallStraceMs> <straceOk>` prints the final table to stdout and always exits 0. `straceOk` is the string `1` or `0`.

- [ ] **Step 1: Write `perfTest/report.js`**

```js
'use strict';

// Merges the in-process counts written by instrument.js with syscall tallies
// parsed out of an strace log, and prints the harness report.

const fs = require('fs');
const path = require('path');

const [countsDir, straceLog, wallMainMs, wallStraceMs, straceOk] = process.argv.slice(2);

const COUNT_KEYS = [
  'dnsLookup',
  'dnsLookupIpLiteral',
  'dnsLookupHostname',
  'dnsResolve',
  'dgramSend',
  'tcpConnect',
  'tcpWrite',
  'udsSend',
  'httpRequest',
  'httpsRequest'
];

const SYSCALLS = ['socket', 'connect', 'sendto', 'sendmsg', 'sendmmsg'];

function readCounts(dir) {
  const totals = {};
  for (const key of COUNT_KEYS) {
    totals[key] = 0;
  }
  const byHost = Object.create(null);
  let processes = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch (err) {
    return { totals: totals, byHost: byHost, processes: 0, error: err.message };
  }

  for (const name of entries) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (err) {
      console.error(`report: skipping unreadable ${name}: ${err && err.message}`);
      continue;
    }
    processes += 1;
    for (const key of COUNT_KEYS) {
      totals[key] += (parsed.counts && parsed.counts[key]) || 0;
    }
    for (const host of Object.keys(parsed.dnsByHost || {})) {
      byHost[host] = (byHost[host] || 0) + parsed.dnsByHost[host];
    }
  }

  return { totals: totals, byHost: byHost, processes: processes };
}

function readStrace(logPath) {
  const tallies = { dnsPort53: 0 };
  for (const name of SYSCALLS) {
    tallies[name] = 0;
  }

  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    return { tallies: tallies, error: err.message };
  }

  // Lines look like `1234  connect(3, {sa_family=AF_INET, sin_port=htons(53), ...`
  // or `[pid  1234] connect(...` depending on strace version.
  const callPattern = /^(?:\[pid\s+\d+\]\s+|\d+\s+)?([a-z_0-9]+)\(/;

  for (const line of text.split('\n')) {
    const match = callPattern.exec(line);
    if (!match) {
      continue;
    }
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(tallies, name)) {
      continue;
    }
    tallies[name] += 1;
    if (line.includes('htons(53)')) {
      tallies.dnsPort53 += 1;
    }
  }

  return { tallies: tallies };
}

function seconds(ms) {
  return `${(Number(ms) / 1000).toFixed(2)}s`;
}

function row(label, value) {
  console.log(`  ${String(label).padEnd(42)} ${String(value).padStart(12)}`);
}

const counts = readCounts(countsDir);
const strace = readStrace(straceLog);

console.log('\n========================================================');
console.log(' hot-shots test suite measurement');
console.log('========================================================\n');

console.log(' Wall time');
row('test suite (instrumented)', seconds(wallMainMs));
if (straceOk === '1') {
  row('test suite under strace (inflated)', seconds(wallStraceMs));
} else {
  row('test suite under strace', 'skipped');
}

console.log('\n In-process counts (API invocations)');
if (counts.error) {
  console.log(`  unavailable: ${counts.error}`);
} else {
  row('node processes measured', counts.processes);
  row('dns.lookup calls', counts.totals.dnsLookup);
  row('  ... for an IP literal', counts.totals.dnsLookupIpLiteral);
  row('  ... for a hostname', counts.totals.dnsLookupHostname);
  row('dns.resolve* calls', counts.totals.dnsResolve);
  row('dgram sends (UDP)', counts.totals.dgramSend);
  row('net connects (TCP)', counts.totals.tcpConnect);
  row('net writes (TCP)', counts.totals.tcpWrite);
  row('unix-dgram sends (UDS)', counts.totals.udsSend);
  row('http requests', counts.totals.httpRequest);
  row('https requests', counts.totals.httpsRequest);

  const hosts = Object.keys(counts.byHost).sort((a, b) => counts.byHost[b] - counts.byHost[a]);
  if (hosts.length) {
    console.log('\n dns.lookup by hostname');
    for (const host of hosts.slice(0, 15)) {
      row(host, counts.byHost[host]);
    }
  }
}

console.log('\n Syscall counts (what the kernel saw)');
if (straceOk !== '1') {
  console.log('  skipped: strace could not run.');
  console.log('  Re-run with --cap-add=SYS_PTRACE --security-opt seccomp=unconfined');
} else if (strace.error) {
  console.log(`  unavailable: ${strace.error}`);
} else {
  row('resolver syscalls (port 53)', strace.tallies.dnsPort53);
  for (const name of SYSCALLS) {
    row(`${name}()`, strace.tallies[name]);
  }
}

console.log('\n Note: the two DNS numbers measure different layers. dns.lookup');
console.log(' short-circuits an IP literal inside Node without issuing a');
console.log(' resolver syscall, and the suite targets 127.0.0.1 almost');
console.log(' everywhere, so the port-53 count is expected to be far lower.');
console.log(' See perfTest/README.md.\n');
```

- [ ] **Step 2: Verify aggregation across multiple processes**

Build two fixture count files and confirm they sum.

```bash
mkdir -p /tmp/hs-fixture
echo '{"pid":1,"counts":{"dnsLookup":3,"dnsLookupIpLiteral":2,"dnsLookupHostname":1,"dnsResolve":0,"dgramSend":10,"tcpConnect":1,"tcpWrite":4,"udsSend":0,"httpRequest":0,"httpsRequest":0},"dnsByHost":{"localhost":1,"127.0.0.1":2}}' > /tmp/hs-fixture/1.json
echo '{"pid":2,"counts":{"dnsLookup":1,"dnsLookupIpLiteral":0,"dnsLookupHostname":1,"dnsResolve":2,"dgramSend":5,"tcpConnect":0,"tcpWrite":0,"udsSend":7,"httpRequest":0,"httpsRequest":0},"dnsByHost":{"localhost":1}}' > /tmp/hs-fixture/2.json
node perfTest/report.js /tmp/hs-fixture /tmp/does-not-exist 12340 45670 0
```

Expected: `node processes measured` is 2, `dns.lookup calls` is 4, `dgram sends (UDP)` is 15, `unix-dgram sends (UDS)` is 7, `localhost` shows 2 in the by-hostname block, wall time reads `12.34s`, and the syscall section says `skipped`.

- [ ] **Step 3: Verify strace log parsing**

```bash
cat > /tmp/hs-fixture/strace.log <<'EOF'
1234  socket(AF_INET, SOCK_DGRAM, IPPROTO_IP) = 3
1234  connect(3, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.11")}, 16) = 0
1234  sendto(3, "\27", 30, 0, NULL, 0) = 30
[pid  1299] sendmsg(4, {msg_name={sa_family=AF_INET, sin_port=htons(8125)}}, 0) = 12
1234  close(3) = 0
EOF
node perfTest/report.js /tmp/hs-fixture /tmp/hs-fixture/strace.log 1000 2000 1
```

Expected: `resolver syscalls (port 53)` is 1, `socket()` is 1, `connect()` is 1, `sendto()` is 1, `sendmsg()` is 1. `close()` is not counted because it is not in `SYSCALLS`.

- [ ] **Step 4: Clean up fixtures**

```bash
rm -rf /tmp/hs-fixture
```

- [ ] **Step 5: Commit**

```bash
git add perfTest/report.js
git commit -m "Add the perfTest report aggregator"
```

---

### Task 4: Container entrypoint

**Files:**
- Modify: `perfTest/run.sh` (replaces the placeholder from Task 1)

**Interfaces:**
- Consumes: `perfTest/instrument.js` (Task 2) and `perfTest/report.js` (Task 3).
- Produces: the container entrypoint. Honors `MODE` (`test` default, or `bench`), and for `bench` honors the existing `WARMUP` and `ITERS` variables already read by `perfTest/test.js`.

- [ ] **Step 1: Replace `perfTest/run.sh`**

`set -e` is deliberately not used: a failing test suite must still produce a report, and its status is propagated at the end instead.

The measured passes use `npm test --ignore-scripts`, which skips the `pretest` lint step. Lint is not a test, and running eslint inside the measurement would add an unrelated Node process to every count.

```bash
#!/usr/bin/env bash
# Entrypoint for the hot-shots perfTest measurement container.
# Deliberately not using `set -e`: a failing suite must still print a report.
set -uo pipefail

MODE="${MODE:-test}"
INSTRUMENT=/app/perfTest/instrument.js
COUNTS_ROOT=/tmp/hs-counts
STRACE_LOG=/tmp/hs-strace.log

if [ "$MODE" = "bench" ]; then
  echo '==> Running the perfTest micro-benchmark'
  exec node /app/perfTest/test.js
fi

if [ "$MODE" != "test" ]; then
  echo "run.sh: unknown MODE '$MODE' (expected 'test' or 'bench')" >&2
  exit 2
fi

rm -rf "$COUNTS_ROOT"
mkdir -p "$COUNTS_ROOT/pass1" "$COUNTS_ROOT/pass2"

echo '==> Pass 1: test suite with in-process counters'
start_ns=$(date +%s%N)
HS_COUNTS_DIR="$COUNTS_ROOT/pass1" NODE_OPTIONS="--require $INSTRUMENT" npm test --ignore-scripts
test_status=$?
end_ns=$(date +%s%N)
wall_main=$(( (end_ns - start_ns) / 1000000 ))

if strace -o /dev/null -f /bin/true >/dev/null 2>&1; then
  strace_ok=1
else
  strace_ok=0
fi

wall_strace=0
if [ "$strace_ok" = "1" ]; then
  echo
  echo '==> Pass 2: test suite under strace (timing here is inflated)'
  start_ns=$(date +%s%N)
  HS_COUNTS_DIR="$COUNTS_ROOT/pass2" \
    strace -f -qq -o "$STRACE_LOG" \
      -e trace=socket,connect,sendto,sendmsg,sendmmsg \
      npm test --ignore-scripts
  end_ns=$(date +%s%N)
  wall_strace=$(( (end_ns - start_ns) / 1000000 ))
else
  echo
  echo '==> Pass 2 skipped: strace cannot run in this container.'
  echo '    Re-run with --cap-add=SYS_PTRACE --security-opt seccomp=unconfined'
fi

node /app/perfTest/report.js \
  "$COUNTS_ROOT/pass1" "$STRACE_LOG" "$wall_main" "$wall_strace" "$strace_ok"

exit $test_status
```

- [ ] **Step 2: Rebuild the image**

```bash
docker build -f perfTest/Dockerfile -t hot-shots-perf .
```

Expected: build succeeds.

- [ ] **Step 3: Verify the full run with strace enabled**

```bash
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf
```

Expected: pass 1 runs the suite, pass 2 runs it again under strace, and the report prints with both sections populated. `dgram sends (UDP)` should be well above zero. `http requests` should be 0.

- [ ] **Step 4: Verify graceful degradation without the ptrace capability**

```bash
docker run --rm hot-shots-perf
```

Expected: pass 2 announces it was skipped, the report still prints, the syscall section says `skipped` and names the flags to add, and the container exit status still reflects the suite result.

- [ ] **Step 5: Verify exit status propagation**

```bash
docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined hot-shots-perf; echo "exit=$?"
```

Expected: `exit=0` on a green suite. If the suite is red, the report must still print and the status must be nonzero.

- [ ] **Step 6: Verify bench mode**

```bash
docker run --rm -e MODE=bench -e ITERS=50000 -e WARMUP=5000 hot-shots-perf
```

Expected: the ops/sec table from `perfTest/test.js`, with no measurement report.

- [ ] **Step 7: Commit**

```bash
git add perfTest/run.sh
git commit -m "Add the perfTest container entrypoint with both measurement passes"
```

---

### Task 5: Documentation

**Files:**
- Create: `perfTest/README.md`
- Modify: `CHANGES.md`

**Interfaces:**
- Consumes: everything from Tasks 1 through 4.
- Produces: nothing consumed by later tasks.

The root `README.md` is API documentation for library consumers and is deliberately not touched — this harness is a development tool and is not part of the published package (`package.json` `files` does not include `perfTest/`). `types.d.ts` is likewise untouched: no library API changed.

- [ ] **Step 1: Write `perfTest/README.md`**

````markdown
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

That distinction is the whole point of the split. Work on how often hot-shots
invokes `dns.lookup` — for example, the per-packet lookup that used to happen
on every UDP send to an IP-literal host — moves the in-process number and
leaves the syscall number flat. Watch the `... for an IP literal` line for that
kind of change.

`http requests` and `https requests` should always read 0. hot-shots speaks
UDP, TCP, UDS, and raw streams, and makes no HTTP calls. The counters exist so
that a nonzero value would be visible if that ever stopped being true.

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
- The container exits with the test suite's status, so a red suite fails the
  run. The report prints either way.
````

- [ ] **Step 2: Add the CHANGES.md entry**

Add this line to the top unreleased section of `CHANGES.md`, matching the existing format.

```markdown
* [@bdeitte](https://github.com/bdeitte) Add a perfTest Docker harness that runs the full suite on Ubuntu and reports suite wall time, network and DNS call counts, and syscall counts
```

- [ ] **Step 3: Verify the documented commands work**

Run each command block from the README exactly as written, from the repo root, and confirm the described output. Specifically confirm that `npm run perf` still works and that the `docker build` line uses `-f perfTest/Dockerfile .` with the repo root as context.

- [ ] **Step 4: Verify lint still passes**

`perfTest/` is outside the lint globs, but confirm nothing regressed.

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add perfTest/README.md CHANGES.md
git commit -m "Document the perfTest harness and micro-benchmark"
```
