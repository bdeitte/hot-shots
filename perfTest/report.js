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

/**
 * Sums the per-process counter files one measurement pass wrote.
 * @param {string} dir - directory holding the per-process JSON counter files
 * @returns {Object} totals, per-host DNS counts, files read, and any read error
 */
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

/**
 * Tallies the syscalls of interest in an strace log.
 * @param {string} logPath - path to the strace output
 * @returns {Object} per-syscall tallies and any read error
 */
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

/**
 * Formats a millisecond duration as seconds.
 * @param {number|string} ms - duration in milliseconds
 * @returns {string} the duration in seconds, to two decimal places
 */
function seconds(ms) {
  return `${(Number(ms) / 1000).toFixed(2)}s`;
}

/**
 * Prints one aligned label/value line of the report.
 * @param {string} label - the left-hand label
 * @param {string|number} value - the right-hand value
 * @returns {void}
 */
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
} else if (counts.processes === 0) {
  // An all-zero table looks like a real result, because http requests are
  // supposed to be 0. Someone comparing two runs would read it as a large
  // improvement. Print no numbers rather than numbers that look correct.
  console.log('  WARNING: the instrumentation did not run. No counts were');
  console.log(`  written to ${countsDir}, so there is nothing to report here.`);
  console.log('  Check that NODE_OPTIONS carried --require perfTest/instrument.js.');
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
