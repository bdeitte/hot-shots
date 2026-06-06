const assert = require('assert');
const constants = require('../lib/constants');
const helpers = require('../lib/helpers');

const ENV_VARS = constants.DATADOG_SIGNAL_ENV_VARS.concat(['DD_ORIGIN_DETECTION_ENABLED']);

describe('#helpers datadog-mode units', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    ENV_VARS.forEach(name => {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    });
  });

  afterEach(() => {
    ENV_VARS.forEach(name => {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    });
  });

  describe('validateCardinality', () => {
    it('accepts valid values', () => {
      assert.strictEqual(helpers.validateCardinality('low'), 'low');
      assert.strictEqual(helpers.validateCardinality('HIGH'), 'high');
    });
    it('returns undefined for invalid or empty values', () => {
      assert.strictEqual(helpers.validateCardinality('bogus'), undefined);
      assert.strictEqual(helpers.validateCardinality(undefined), undefined);
      assert.strictEqual(helpers.validateCardinality(''), undefined);
    });
    it('warns via console.error on an invalid value', () => {
      const originalError = console.error;
      let callCount = 0;
      let firstArg;
      console.error = (msg) => {
        callCount += 1;
        firstArg = msg;
      };
      try {
        helpers.validateCardinality('bogus');
      } finally {
        console.error = originalError;
      }
      assert.strictEqual(callCount, 1);
      assert.ok(String(firstArg).indexOf('bogus') !== -1, firstArg);
    });
  });

  describe('sanitizeExternalData', () => {
    it('strips pipes and control chars', () => {
      assert.strictEqual(helpers.sanitizeExternalData('it-false,cn-foo|bar'), 'it-false,cn-foobar');
      assert.strictEqual(helpers.sanitizeExternalData('  trim\nme  '), 'trimme');
    });
    it('returns undefined for empty input', () => {
      assert.strictEqual(helpers.sanitizeExternalData(undefined), undefined);
      assert.strictEqual(helpers.sanitizeExternalData(''), undefined);
    });
    it('returns undefined when input is only strippable characters', () => {
      assert.strictEqual(helpers.sanitizeExternalData('|||'), undefined);
    });
  });

  describe('isFalseyEnvValue', () => {
    it('detects falsey values case-insensitively', () => {
      assert.strictEqual(helpers.isFalseyEnvValue('false'), true);
      assert.strictEqual(helpers.isFalseyEnvValue('OFF'), true);
      assert.strictEqual(helpers.isFalseyEnvValue('0'), true);
    });
    it('treats other values as not-falsey', () => {
      assert.strictEqual(helpers.isFalseyEnvValue('true'), false);
      assert.strictEqual(helpers.isFalseyEnvValue(undefined), false);
    });
  });

  describe('detectDatadogMode', () => {
    it('is false for telegraf regardless of signals', () => {
      process.env.DD_AGENT_HOST = '1.2.3.4';
      assert.strictEqual(helpers.detectDatadogMode(true), false);
    });
    it('is true when a DD_ signal env var is present', () => {
      process.env.DD_ENV = 'prod';
      assert.strictEqual(helpers.detectDatadogMode(false), true);
    });
    it('is false for uds protocol without a DD signal', () => {
      assert.strictEqual(helpers.detectDatadogMode(false), false);
    });
    it('is false with no signals', () => {
      assert.strictEqual(helpers.detectDatadogMode(false), false);
    });
  });
});
