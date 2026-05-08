const assert = require('assert');
const sinon = require('sinon');
const StatsD = require('../lib/statsd');

describe('#optionValidation', () => {
  let consoleErrorStub;

  beforeEach(() => {
    consoleErrorStub = sinon.stub(console, 'error');
  });

  afterEach(() => {
    if (consoleErrorStub) {
      consoleErrorStub.restore();
      consoleErrorStub = null;
    }
  });

  /**
   * Returns true iff console.error was called with a string matching needle.
   */
  const warnedAbout = (needle) => {
    return consoleErrorStub.getCalls().some(c => {
      return typeof c.args[0] === 'string' && c.args[0].includes(needle);
    });
  };

  describe('port', () => {
    it('warns (does not throw) when port is not an integer in [1, 65535]', () => {
      // Note: invalid values are NOT rejected — preserved for backwards compatibility.
      // Construction continues with the value; later code falls back to defaults
      // for falsy values via existing `||` chains.
      assert.doesNotThrow(() => new StatsD({ port: 0, mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: -1, mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: 70000, mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: 'abc', mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: 1.5, mock: true }));
      assert.ok(warnedAbout('\'port\''),
        'expected at least one console.error mentioning port');
    });

    it('does not warn for valid port values', () => {
      assert.doesNotThrow(() => new StatsD({ port: 1, mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: 8125, mock: true }));
      assert.doesNotThrow(() => new StatsD({ port: 65535, mock: true }));
      assert.doesNotThrow(() => new StatsD({ mock: true }));
      assert.strictEqual(warnedAbout('\'port\''), false,
        'expected no port warnings');
    });
  });

  describe('sampleRate', () => {
    it('warns (does not throw) when sampleRate is outside (0, 1] or not a number', () => {
      assert.doesNotThrow(() => new StatsD({ sampleRate: 0, mock: true }));
      assert.doesNotThrow(() => new StatsD({ sampleRate: -0.1, mock: true }));
      assert.doesNotThrow(() => new StatsD({ sampleRate: 1.1, mock: true }));
      assert.doesNotThrow(() => new StatsD({ sampleRate: 'half', mock: true }));
      assert.ok(warnedAbout('\'sampleRate\''),
        'expected at least one console.error mentioning sampleRate');
    });

    it('does not warn for valid sampleRate values', () => {
      assert.doesNotThrow(() => new StatsD({ sampleRate: 0.001, mock: true }));
      assert.doesNotThrow(() => new StatsD({ sampleRate: 0.5, mock: true }));
      assert.doesNotThrow(() => new StatsD({ sampleRate: 1, mock: true }));
      assert.doesNotThrow(() => new StatsD({ mock: true }));
      assert.strictEqual(warnedAbout('\'sampleRate\''), false);
    });

    it('defaults sampleRate to 1 when omitted', () => {
      const client = new StatsD({ mock: true });
      assert.strictEqual(client.sampleRate, 1);
    });
  });

  describe('bufferFlushInterval', () => {
    it('warns (does not throw) when bufferFlushInterval is not a positive number', () => {
      assert.doesNotThrow(() => new StatsD({ bufferFlushInterval: 0, mock: true }));
      assert.doesNotThrow(() => new StatsD({ bufferFlushInterval: -100, mock: true }));
      assert.doesNotThrow(() => new StatsD({ bufferFlushInterval: 'soon', mock: true }));
      assert.ok(warnedAbout('\'bufferFlushInterval\''),
        'expected at least one console.error mentioning bufferFlushInterval');
    });

    it('rejects Infinity (Node clamps oversized setTimeout delays to 1ms → hot loop)', () => {
      const client = new StatsD({ bufferFlushInterval: Infinity, maxBufferSize: 1000, mock: true });
      assert.ok(warnedAbout('\'bufferFlushInterval\''));
      assert.strictEqual(client.bufferFlushInterval, 1000,
        `expected default 1000, got ${client.bufferFlushInterval}`);
    });

    it('rejects values above setTimeout max (2^31 - 1)', () => {
      const client = new StatsD({ bufferFlushInterval: 2147483648, maxBufferSize: 1000, mock: true });
      assert.ok(warnedAbout('\'bufferFlushInterval\''));
      assert.strictEqual(client.bufferFlushInterval, 1000);
    });

    it('accepts the maximum supported setTimeout value', () => {
      const client = new StatsD({ bufferFlushInterval: 2147483647, maxBufferSize: 1000, mock: true });
      assert.strictEqual(warnedAbout('\'bufferFlushInterval\''), false);
      assert.strictEqual(client.bufferFlushInterval, 2147483647);
    });
  });

  describe('invalid value sanitization', () => {
    it('falls back to default port when invalid value is provided', () => {
      // Without sanitization, this.port would be the raw 'abc' string.
      const client = new StatsD({ port: 'abc', mock: true });
      assert.strictEqual(client.port, 8125, `expected default port 8125, got ${client.port}`);
    });

    it('falls back to default sampleRate when invalid value is provided', () => {
      const client = new StatsD({ sampleRate: 'half', mock: true });
      assert.strictEqual(client.sampleRate, 1, `expected default sampleRate 1, got ${client.sampleRate}`);
    });

    it('falls back to default bufferFlushInterval when invalid value is provided', () => {
      // Without sanitization, this.bufferFlushInterval would be 'soon' (or -100), and
      // setInterval('soon') / setInterval(-100) would create a hot flush loop.
      const client = new StatsD({ bufferFlushInterval: 'soon', maxBufferSize: 1000, mock: true });
      assert.strictEqual(client.bufferFlushInterval, 1000,
        `expected default bufferFlushInterval 1000, got ${client.bufferFlushInterval}`);
    });

  });

  describe('per-call sampleRate', () => {
    it('silently falls back to client sampleRate when per-call sampleRate is 0 (positional)', () => {
      const client = new StatsD({ mock: true });
      assert.doesNotThrow(() => client.increment('a', 1, 0));
      assert.doesNotThrow(() => client.gauge('a', 1, 0));
      assert.doesNotThrow(() => client.histogram('a', 1, 0));
      assert.strictEqual(warnedAbout('\'sampleRate\''), false);
    });

    it('silently falls back to client sampleRate when per-call sampleRate is 0 (options object)', () => {
      const client = new StatsD({ mock: true });
      assert.doesNotThrow(() => client.gauge('a', 1, { sampleRate: 0 }));
      assert.doesNotThrow(() => client.increment('a', 1, { sampleRate: 0 }));
      assert.strictEqual(warnedAbout('\'sampleRate\''), false);
    });

    it('does not warn for valid per-call sampleRate values', () => {
      const client = new StatsD({ mock: true });
      client.increment('a', 1, 0.5);
      client.gauge('a', 1, { sampleRate: 0.001 });
      client.histogram('a', 1, 1);
      assert.strictEqual(warnedAbout('\'sampleRate\''), false);
    });
  });
});
