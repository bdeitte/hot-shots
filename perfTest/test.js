'use strict';

const StatsD = require('../lib/statsd');

const WARMUP = process.env.WARMUP ? parseInt(process.env.WARMUP) : 20000;
const ITERS  = process.env.ITERS  ? parseInt(process.env.ITERS)  : 300000;

const noTagClient = new StatsD({ mock: true });
const globalTagClient = new StatsD({
  mock: true,
  globalTags: { env: 'prod', region: 'us-east-1', service: 'api' }
});

const timerWrapped = noTagClient.timer(function noop() {}, 'hot.shots.perf.timer');

function bench(label, fn) {
  noTagClient.mockBuffer = [];
  globalTagClient.mockBuffer = [];

  for (let i = 0; i < WARMUP; i++) { fn(); }

  noTagClient.mockBuffer = [];
  globalTagClient.mockBuffer = [];

  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) { fn(); }
  const ns = Number(process.hrtime.bigint() - start);

  const opsPerSec = Math.round(ITERS / (ns / 1e9));
  console.log(`  ${label.padEnd(45)} ${opsPerSec.toLocaleString().padStart(14)} ops/sec`);
}

console.log(`\nhot-shots performance (${ITERS.toLocaleString()} iters, ${WARMUP.toLocaleString()} warmup, mock mode):\n`);

bench('increment, no tags',
  () => noTagClient.increment('hot.shots.perf.metric', 1));

bench('increment, global tags only',
  () => globalTagClient.increment('hot.shots.perf.metric', 1));

bench('increment, per-metric tags (no overlap)',
  () => noTagClient.increment('hot.shots.perf.metric', 1, { status: 'ok', host: 'web-01' }));

bench('increment, per-metric + global tags (overlap)',
  () => globalTagClient.increment('hot.shots.perf.metric', 1, { env: 'staging', version: 'v2' }));

bench('timing',
  () => noTagClient.timing('hot.shots.perf.metric', 250));

bench('timer wrapper',
  () => timerWrapped());

console.log();
