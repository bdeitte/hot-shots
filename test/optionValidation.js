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

  it('throws TypeError when sampleRate is outside (0, 1] or not a number', () => {
    // 0 is rejected: dropping every metric is not a valid use case (just stop calling
    // the metric methods). Negative values and > 1 are also nonsense.
    assert.throws(() => new StatsD({ sampleRate: 0, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: -0.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 1.1, mock: true }), TypeError);
    assert.throws(() => new StatsD({ sampleRate: 'half', mock: true }), TypeError);
  });

  it('accepts valid sampleRate values', () => {
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0.001, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 0.5, mock: true }));
    assert.doesNotThrow(() => new StatsD({ sampleRate: 1, mock: true }));
    assert.doesNotThrow(() => new StatsD({ mock: true }));
  });

  it('defaults sampleRate to 1 when omitted', () => {
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.sampleRate, 1);
  });

  it('throws TypeError when bufferFlushInterval is not a positive number', () => {
    assert.throws(() => new StatsD({ bufferFlushInterval: 0, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: -100, mock: true }), TypeError);
    assert.throws(() => new StatsD({ bufferFlushInterval: 'soon', mock: true }), TypeError);
  });

  describe('per-call sampleRate', () => {
    it('throws TypeError when per-call sampleRate is 0 (positional)', () => {
      const client = new StatsD({ mock: true });
      assert.throws(() => client.increment('a', 1, 0), TypeError);
      assert.throws(() => client.gauge('a', 1, 0), TypeError);
      assert.throws(() => client.histogram('a', 1, 0), TypeError);
    });

    it('throws TypeError when per-call sampleRate is 0 (options object)', () => {
      const client = new StatsD({ mock: true });
      assert.throws(() => client.gauge('a', 1, { sampleRate: 0 }), TypeError);
      assert.throws(() => client.increment('a', 1, { sampleRate: 0 }), TypeError);
    });

    it('accepts valid per-call sampleRate values', () => {
      const client = new StatsD({ mock: true });
      assert.doesNotThrow(() => client.increment('a', 1, 0.5));
      assert.doesNotThrow(() => client.gauge('a', 1, { sampleRate: 0.001 }));
      assert.doesNotThrow(() => client.histogram('a', 1, 1));
    });
  });
});
