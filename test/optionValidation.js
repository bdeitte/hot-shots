const assert = require('assert');
const StatsD = require('../lib/statsd');

describe('#optionValidation', () => {
  it('throws TypeError when port is not an integer in [1, 65535]', () => {
    assert.throws(() => new StatsD({ port: 0 }), TypeError);
    assert.throws(() => new StatsD({ port: -1 }), TypeError);
    assert.throws(() => new StatsD({ port: 70000 }), TypeError);
    assert.throws(() => new StatsD({ port: 'abc' }), TypeError);
    assert.throws(() => new StatsD({ port: 1.5 }), TypeError);
  });

  it('accepts valid port values', () => {
    // mock: true so no socket is actually created
    assert.doesNotThrow(() => new StatsD({ port: 1, mock: true }));
    assert.doesNotThrow(() => new StatsD({ port: 8125, mock: true }));
    assert.doesNotThrow(() => new StatsD({ port: 65535, mock: true }));
    // omitted port -> defaults to 8125, no throw
    assert.doesNotThrow(() => new StatsD({ mock: true }));
  });

  it('throws TypeError when sampleRate is outside [0, 1] or not a number', () => {
    assert.throws(() => new StatsD({ sampleRate: -0.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 1.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 'half', mock: true }), TypeError);
  });

  it('accepts valid sampleRate values', () => {
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0.5, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 1, mock: true }));
    assert.doesNotThrow(() => new StatsD({ mock: true }));
  });

  it('preserves an explicit sampleRate of 0 instead of coercing it to 1', () => {
    const client = new StatsD({ sampleRate: 0, mock: true });
    assert.strictEqual(client.sampleRate, 0,
      'sampleRate: 0 must be preserved (was previously coerced to 1 via `|| 1`)');
  });

  it('defaults sampleRate to 1 when omitted', () => {
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.sampleRate, 1);
  });

  it('client sampleRate of 0 actually samples out every metric', () => {
    const client = new StatsD({ sampleRate: 0, mock: true });
    for (let i = 0; i < 50; i++) {
      client.increment('a');
    }
    assert.strictEqual(client.mockBuffer.length, 0,
      'sampleRate: 0 must drop every metric (was previously coerced to 1 and emitted everything)');
  });

  it('per-call sampleRate of 0 samples out the metric even when client default is 1', () => {
    const client = new StatsD({ mock: true });
    for (let i = 0; i < 50; i++) {
      client.increment('a', 1, 0);
    }
    assert.strictEqual(client.mockBuffer.length, 0,
      'per-call sampleRate: 0 must drop the metric (was previously coerced to client default)');
  });

  it('throws TypeError when bufferFlushInterval is not a positive number', () => {
    assert.throws(() => new StatsD({ bufferFlushInterval: 0, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: -100, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: 'soon', mock: true }), TypeError);
  });
});
