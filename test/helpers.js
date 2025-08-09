const assert = require('assert');
const fs = require('fs');
const helpers = require('../lib/helpers');

describe('#helpersExtended', () => {
  describe('#formatDate', () => {
    it('should format Date object to seconds timestamp', () => {
      const date = new Date('2023-01-01T00:00:00.000Z');
      const result = helpers.formatDate(date);
      assert.strictEqual(result, 1672531200);
    });

    it('should format Date object with milliseconds to rounded seconds', () => {
      const date = new Date('2023-01-01T00:00:00.750Z');
      const result = helpers.formatDate(date);
      assert.strictEqual(result, 1672531201); // Should round up
    });

    it('should format number timestamp to integer', () => {
      const timestamp = 1672531200.5;
      const result = helpers.formatDate(timestamp);
      assert.strictEqual(result, 1672531201); // Should round up
    });

    it('should format Number object to integer', () => {
      const timestamp = Number(1672531200.7);
      const result = helpers.formatDate(timestamp);
      assert.strictEqual(result, 1672531201); // Should round up
    });

    it('should return undefined for invalid input', () => {
      const result = helpers.formatDate('invalid');
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for null input', () => {
      const result = helpers.formatDate(null);
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for undefined input', () => {
      const result = helpers.formatDate(undefined);
      assert.strictEqual(result, undefined);
    });
  });

  describe('#intToIP', () => {
    it('should convert integer to IP address', () => {
      // 192.168.1.1 = 0xC0A80101 = 3232235777
      const result = helpers.intToIP(3232235777);
      assert.strictEqual(result, '192.168.1.1');
    });

    it('should convert 0 to 0.0.0.0', () => {
      const result = helpers.intToIP(0);
      assert.strictEqual(result, '0.0.0.0');
    });

    it('should convert localhost IP', () => {
      // 127.0.0.1 = 0x7F000001 = 2130706433
      const result = helpers.intToIP(2130706433);
      assert.strictEqual(result, '127.0.0.1');
    });

    it('should convert max IP address', () => {
      // 255.255.255.255 = 0xFFFFFFFF = 4294967295
      const result = helpers.intToIP(4294967295);
      assert.strictEqual(result, '255.255.255.255');
    });

    it('should handle endianness correctly', () => {
      // Test specific byte ordering
      const result = helpers.intToIP(0x01020304);
      assert.strictEqual(result, '1.2.3.4');
    });
  });

  describe('#getDefaultRoute', () => {
    let originalReadFileSync;
    let originalConsoleError;
    let consoleErrorCalls;

    beforeEach(() => {
      originalReadFileSync = fs.readFileSync; // eslint-disable-line no-sync
      originalConsoleError = console.error;
      consoleErrorCalls = [];
      console.error = (...args) => {
        consoleErrorCalls.push(args);
      };
    });

    afterEach(() => {
      fs.readFileSync = originalReadFileSync; // eslint-disable-line no-sync
      console.error = originalConsoleError;
    });

    it('should return default route IP when /proc/net/route exists', () => {
      // Mock /proc/net/route content with default route (tab-separated)
      const mockRouteContent = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0';

      fs.readFileSync = (path, encoding) => { // eslint-disable-line no-sync
        if (path === '/proc/net/route' && encoding === 'utf8') {
          return mockRouteContent;
        }
        return originalReadFileSync(path, encoding);
      };

      const result = helpers.getDefaultRoute();
      assert.strictEqual(result, '192.168.0.1'); // 0100A8C0 in little endian
    });

    it('should return null when no default route found', () => {
      // Mock /proc/net/route content without default route (tab-separated)
      const mockRouteContent = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0';

      fs.readFileSync = (path, encoding) => { // eslint-disable-line no-sync
        if (path === '/proc/net/route' && encoding === 'utf8') {
          return mockRouteContent;
        }
        return originalReadFileSync(path, encoding);
      };

      const result = helpers.getDefaultRoute();
      assert.strictEqual(result, null);
    });

    it('should return null and log error when file cannot be read', () => {
      fs.readFileSync = (path, encoding) => { // eslint-disable-line no-sync
        if (path === '/proc/net/route') {
          throw new Error('Permission denied');
        }
        return originalReadFileSync(path, encoding);
      };

      const result = helpers.getDefaultRoute();
      assert.strictEqual(result, null);
      assert.strictEqual(consoleErrorCalls.length, 1);
      assert.strictEqual(consoleErrorCalls[0][0], 'Could not get default route from /proc/net/route');
    });

    it('should handle empty file', () => {
      fs.readFileSync = (path, encoding) => { // eslint-disable-line no-sync
        if (path === '/proc/net/route' && encoding === 'utf8') {
          return '';
        }
        return originalReadFileSync(path, encoding);
      };

      const result = helpers.getDefaultRoute();
      assert.strictEqual(result, null);
    });

    it('should handle malformed route file', () => {
      fs.readFileSync = (path, encoding) => { // eslint-disable-line no-sync
        if (path === '/proc/net/route' && encoding === 'utf8') {
          return 'malformed content';
        }
        return originalReadFileSync(path, encoding);
      };

      const result = helpers.getDefaultRoute();
      assert.strictEqual(result, null);
    });
  });

  describe('#sanitizeTags', () => {
    it('should sanitize tags for StatsD (default)', () => {
      const result = helpers.sanitizeTags('tag:with|special@chars,here');
      assert.strictEqual(result, 'tag_with_special_chars_here');
    });

    it('should sanitize tags for Telegraf', () => {
      const result = helpers.sanitizeTags('tag:with|special,chars', true);
      assert.strictEqual(result, 'tag_with_special_chars');
    });

    it('should handle non-string values', () => {
      const result = helpers.sanitizeTags(123);
      assert.strictEqual(result, '123');
    });

    it('should handle null values', () => {
      const result = helpers.sanitizeTags(null);
      assert.strictEqual(result, 'null');
    });

    it('should handle undefined values', () => {
      const result = helpers.sanitizeTags(undefined);
      assert.strictEqual(result, 'undefined');
    });
  });

  describe('#overrideTags - exact results verification', () => {
    describe('Array child tags', () => {
      it('should return exact array when child overrides single parent tag', () => {
        const parent = ['env:prod', 'version:1.0'];
        const child = ['env:dev'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['version:1.0', 'env:dev']);
      });

      it('should handle multiple values for same key in child array', () => {
        const parent = ['env:prod', 'service:api'];
        const child = ['env:dev', 'env:staging'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['service:api', 'env:dev', 'env:staging']);
      });

      it('should preserve all parent tags when child has no matching keys', () => {
        const parent = ['env:prod', 'service:api'];
        const child = ['region:us-west', 'team:backend'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:prod', 'service:api', 'region:us-west', 'team:backend']);
      });

      it('should handle tags without colons correctly', () => {
        const parent = ['env:prod', 'standalone'];
        const child = ['env:dev', 'another'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['standalone', 'env:dev', 'another']);
      });

      it('should handle empty value after colon', () => {
        const parent = ['key:value', 'other:data'];
        const child = ['key:', 'another:'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['other:data', 'key:', 'another:']);
      });

      it('should handle multiple colons in value', () => {
        const parent = ['url:http://old.com'];
        const child = ['url:https://new.com:8080'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['url:https://new.com:8080']);
      });

      it('should handle complex override scenario with exact results', () => {
        const parent = ['app:web', 'env:prod', 'team:backend', 'feature:enabled'];
        const child = ['env:staging', 'team:frontend', 'region:eu-west'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['app:web', 'feature:enabled', 'env:staging', 'team:frontend', 'region:eu-west']);
      });

      it('should handle non-string values in child array', () => {
        const parent = ['env:prod', 'version:1.0'];
        const child = [123, null, undefined, 'env:dev'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['version:1.0', 'env:dev', 123, null, undefined]);
      });

      it('should handle tags with colon as first character', () => {
        const parent = ['normal:tag'];
        const child = [':invalid', 'valid:tag'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['normal:tag', 'valid:tag', ':invalid']);
      });
    });

    describe('Object child tags', () => {
      it('should return exact array when child object overrides parent', () => {
        const parent = ['env:prod', 'version:1.0'];
        const child = { env: 'dev' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['version:1.0', 'env:dev']);
      });

      it('should handle multiple keys in child object', () => {
        const parent = ['env:prod', 'service:api', 'region:us-east'];
        const child = { env: 'staging', region: 'eu-west' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['service:api', 'env:staging', 'region:eu-west']);
      });

      it('should add new keys from child object', () => {
        const parent = ['env:prod'];
        const child = { team: 'frontend', region: 'us-west' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:prod', 'team:frontend', 'region:us-west']);
      });

      it('should sanitize object keys and values', () => {
        const parent = ['env:prod'];
        const child = { 'key|with|pipes': 'value@with@ats' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:prod', 'key_with_pipes:value_with_ats']);
      });

      it('should handle object with numeric and special values', () => {
        const parent = ['env:prod'];
        const child = { count: 123, enabled: true, disabled: false, empty: null };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:prod', 'count:123', 'enabled:true', 'disabled:false', 'empty:null']);
      });

      it('should handle empty object', () => {
        const parent = ['env:prod', 'version:1.0'];
        const child = {};
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:prod', 'version:1.0']);
      });

      it('should handle complex object override scenario', () => {
        const parent = ['app:web', 'env:prod', 'team:backend', 'feature:enabled'];
        const child = { env: 'staging', team: 'frontend', region: 'eu-west' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['app:web', 'feature:enabled', 'env:staging', 'team:frontend', 'region:eu-west']);
      });

      it('should handle telegraf mode sanitization', () => {
        const parent = ['env:prod'];
        const child = { 'key,with,commas': 'value,with,commas' };
        const result = helpers.overrideTags(parent, child, true);

        assert.deepStrictEqual(result, ['env:prod', 'key_with_commas:value_with_commas']);
      });
    });

    describe('Mixed scenarios and edge cases', () => {
      it('should handle empty parent with array child', () => {
        const parent = [];
        const child = ['env:dev', 'region:us-west'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:dev', 'region:us-west']);
      });

      it('should handle empty parent with object child', () => {
        const parent = [];
        const child = { env: 'dev', region: 'us-west' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:dev', 'region:us-west']);
      });

      it('should handle parent with non-string values and array child', () => {
        const parent = ['env:prod', 123, null, undefined];
        const child = ['env:dev'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, [123, null, undefined, 'env:dev']);
      });

      it('should handle parent with non-string values and object child', () => {
        const parent = ['env:prod', 123, null, undefined];
        const child = { env: 'dev' };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, [123, null, undefined, 'env:dev']);
      });

      it('should preserve order correctly with multiple overrides', () => {
        const parent = ['a:1', 'b:2', 'c:3', 'd:4'];
        const child = ['b:5', 'd:6', 'e:7'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['a:1', 'c:3', 'b:5', 'd:6', 'e:7']);
      });

      it('should handle complete override of all parent tags', () => {
        const parent = ['env:prod', 'team:backend'];
        const child = ['env:dev', 'team:frontend'];
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:dev', 'team:frontend']);
      });

      it('should handle array values in object child', () => {
        const parent = ['env:prod'];
        const child = { env: ['dev', 'staging'] };
        const result = helpers.overrideTags(parent, child);

        assert.deepStrictEqual(result, ['env:dev_staging']);
      });
    });
  });

  describe('#overrideTags edge cases', () => {
    it('should return false when child is null', () => {
      const parent = ['parent:tag'];
      const result = helpers.overrideTags(parent, null);
      assert.strictEqual(result, false);
    });

    it('should return false when child is undefined', () => {
      const parent = ['parent:tag'];
      const result = helpers.overrideTags(parent, undefined);
      assert.strictEqual(result, false);
    });

    it('should handle tags without colons', () => {
      const parent = ['env:prod', 'standalone'];
      const child = ['env:dev', 'another'];
      const result = helpers.overrideTags(parent, child);

      assert(result.includes('standalone'));
      assert(result.includes('another'));
      assert(result.includes('env:dev'));
      // env:prod should be removed because child overrides the 'env' key
      assert(!result.includes('env:prod'));
    });

    it('should handle object tags with multiple values for same key', () => {
      const parent = ['env:prod', 'version:1.0'];
      const child = { env: 'staging' };
      const result = helpers.overrideTags(parent, child);

      // Object tags get formatted as key:value
      assert(result.includes('env:staging'));
      assert(result.includes('version:1.0'));
      assert(!result.includes('env:prod'));
    });

    it('should handle empty parent array', () => {
      const parent = [];
      const child = ['child:tag'];
      const result = helpers.overrideTags(parent, child);

      assert.strictEqual(result.length, 1);
      assert(result.includes('child:tag'));
    });

    it('should handle tags with colon as first character', () => {
      const parent = ['normal:tag'];
      const child = [':invalid', 'valid:tag'];
      const result = helpers.overrideTags(parent, child);

      assert(result.includes(':invalid'));
      assert(result.includes('valid:tag'));
      // normal:tag should remain because child doesn't override 'normal' key
      assert(result.includes('normal:tag'));
    });

    it('should handle duplicate keys in child array tags', () => {
      const parent = ['env:prod', 'service:api'];
      const child = ['env:dev', 'env:staging', 'region:us-west'];
      const result = helpers.overrideTags(parent, child);

      // Both env values from child should be present
      assert(result.includes('env:dev'));
      assert(result.includes('env:staging'));
      assert(result.includes('region:us-west'));
      assert(result.includes('service:api'));
      assert(!result.includes('env:prod'));
    });

    it('should handle empty child array', () => {
      const parent = ['env:prod', 'version:1.0'];
      const child = [];
      const result = helpers.overrideTags(parent, child);

      assert.strictEqual(result.length, 2);
      assert(result.includes('env:prod'));
      assert(result.includes('version:1.0'));
    });

    it('should handle empty child object', () => {
      const parent = ['env:prod', 'version:1.0'];
      const child = {};
      const result = helpers.overrideTags(parent, child);

      assert.strictEqual(result.length, 2);
      assert(result.includes('env:prod'));
      assert(result.includes('version:1.0'));
    });

    it('should sanitize object keys and values', () => {
      const parent = ['env:prod'];
      const child = { 'key|with|pipes': 'value@with@ats', 'env': 'dev' };
      const result = helpers.overrideTags(parent, child);

      // Keys and values should be sanitized
      assert(result.includes('key_with_pipes:value_with_ats'));
      assert(result.includes('env:dev'));
      assert(!result.includes('env:prod'));
    });

    it('should handle tags with multiple colons', () => {
      const parent = ['url:http://example.com'];
      const child = ['url:https://newsite.com:8080', 'path:/api/v2'];
      const result = helpers.overrideTags(parent, child);

      // Only first colon is used as separator
      assert(result.includes('url:https://newsite.com:8080'));
      assert(result.includes('path:/api/v2'));
      assert(!result.includes('url:http://example.com'));
    });

    it('should handle tags with empty values', () => {
      const parent = ['key:value'];
      const child = ['key:', 'another:'];
      const result = helpers.overrideTags(parent, child);

      assert(result.includes('key:'));
      assert(result.includes('another:'));
      assert(!result.includes('key:value'));
    });

    it('should handle telegraf mode for sanitization', () => {
      const parent = ['env:prod'];
      const child = { 'key,with,commas': 'value,with,commas' };
      const telegraf = true;
      const result = helpers.overrideTags(parent, child, telegraf);

      // Telegraf mode should sanitize differently
      assert(result.includes('key_with_commas:value_with_commas'));
      assert(result.includes('env:prod'));
    });

    it('should preserve parent tags that are not overridden', () => {
      const parent = ['env:prod', 'service:api', 'version:1.0', 'region:us-east'];
      const child = ['env:dev', 'region:us-west'];
      const result = helpers.overrideTags(parent, child);

      assert(result.includes('env:dev'));
      assert(result.includes('region:us-west'));
      assert(result.includes('service:api'));
      assert(result.includes('version:1.0'));
      assert(!result.includes('env:prod'));
      assert(!result.includes('region:us-east'));
    });

    it('should handle mixed array and object child scenarios', () => {
      const parent = ['env:prod', 'standalone'];
      const child = { 'env': ['dev', 'staging'] }; // Object with array value
      const result = helpers.overrideTags(parent, child);

      // Should handle array values in object
      assert(result.includes('env:dev,staging') || result.includes('env:dev_staging'));
      assert(result.includes('standalone'));
      assert(!result.includes('env:prod'));
    });

    it('should return false for falsy child values other than empty array/object', () => {
      const parent = ['env:prod'];

      assert.strictEqual(helpers.overrideTags(parent, false), false);
      assert.strictEqual(helpers.overrideTags(parent, 0), false);
      assert.strictEqual(helpers.overrideTags(parent, ''), false);
      assert.strictEqual(helpers.overrideTags(parent, NaN), false);
    });

    it('should handle parent with non-string values', () => {
      const parent = ['env:prod', 123, null, undefined];
      const child = ['env:dev'];
      const result = helpers.overrideTags(parent, child);

      // Non-string parent values should be preserved
      assert(result.includes('env:dev'));
      assert(result.includes(123));
      assert(result.includes(null));
      assert(result.includes(undefined));
      assert(!result.includes('env:prod'));
    });

    it('should handle complex nested override scenario', () => {
      const parent = ['app:web', 'env:prod', 'team:backend', 'feature:enabled'];
      const child = { 'env': 'staging', 'team': 'frontend', 'region': 'eu-west' };
      const result = helpers.overrideTags(parent, child);

      assert(result.includes('app:web'));
      assert(result.includes('env:staging'));
      assert(result.includes('team:frontend'));
      assert(result.includes('feature:enabled'));
      assert(result.includes('region:eu-west'));
      assert(!result.includes('env:prod'));
      assert(!result.includes('team:backend'));
    });
  });
});
