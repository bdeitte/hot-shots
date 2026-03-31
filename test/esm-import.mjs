import assert from 'node:assert';
import { createRequire } from 'node:module';
import hotShots, { StatsD } from 'hot-shots';

// Default export is the Client constructor
assert.strictEqual(typeof hotShots, 'function', 'default export should be a function');

// Named export StatsD is the same constructor
assert.strictEqual(typeof StatsD, 'function', 'StatsD named export should be a function');
assert.strictEqual(StatsD, hotShots.StatsD, 'StatsD should match hotShots.StatsD');

// Can create a mock client
const client = new StatsD({ mock: true });
assert.ok(client, 'should create a mock client');
client.close();

// Deep subpath ESM imports (with extension) should still work
const statsd = await import('hot-shots/lib/statsd.js');
assert.strictEqual(typeof statsd.default, 'function', 'ESM deep import of lib/statsd.js should work');

const helpers = await import('hot-shots/lib/helpers.js');
assert.strictEqual(typeof helpers.default.formatTags, 'function', 'ESM deep import of lib/helpers.js should work');

// package.json should be accessible (use createRequire for JSON import compatibility on Node 18)
const require = createRequire(import.meta.url);
const pkg = require('hot-shots/package.json');
assert.strictEqual(pkg.name, 'hot-shots', 'package.json should be importable');

console.log('ESM import test passed');
