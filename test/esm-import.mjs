import assert from 'node:assert';
import hotShots, { StatsD } from '../index.mjs';

// Default export is the Client constructor
assert.strictEqual(typeof hotShots, 'function', 'default export should be a function');

// Named export StatsD is the same constructor
assert.strictEqual(typeof StatsD, 'function', 'StatsD named export should be a function');
assert.strictEqual(StatsD, hotShots.StatsD, 'StatsD should match hotShots.StatsD');

// Can create a mock client
const client = new StatsD({ mock: true });
assert.ok(client, 'should create a mock client');
client.close();

console.log('ESM import test passed');
