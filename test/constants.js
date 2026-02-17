const assert = require('assert');
const constants = require('../lib/constants');

describe('#constants', () => {
  describe('PROTOCOL', () => {
    it('should define all protocol types', () => {
      assert.strictEqual(constants.PROTOCOL.TCP, 'tcp');
      assert.strictEqual(constants.PROTOCOL.UDS, 'uds');
      assert.strictEqual(constants.PROTOCOL.UDP, 'udp');
      assert.strictEqual(constants.PROTOCOL.STREAM, 'stream');
    });
  });

  describe('tcpErrors', () => {
    it('should return an array of retryable TCP error codes', () => {
      const errors = constants.tcpErrors();
      assert.ok(Array.isArray(errors));
      assert.ok(errors.length > 0);
      assert.ok(errors.includes('ECONNREFUSED'));
      assert.ok(errors.includes('ECONNRESET'));
      assert.ok(errors.includes('EPIPE'));
      assert.ok(errors.includes('ENOTCONN'));
      assert.ok(errors.includes('EDESTADDRREQ'));
    });

    it('should include Windows-specific error codes', () => {
      const errors = constants.tcpErrors();
      assert.ok(errors.includes('WSAENOTCONN'));
      assert.ok(errors.includes('WSAECONNREFUSED'));
      assert.ok(errors.includes('WSAECONNRESET'));
    });
  });

  describe('udsErrors', () => {
    it('should return an array for the current platform', () => {
      const errors = constants.udsErrors();
      assert.ok(Array.isArray(errors));
    });

    it('should return platform-specific error codes', () => {
      const errors = constants.udsErrors();
      if (process.platform === 'linux') {
        assert.ok(errors.includes('ENOTCONN'));
        assert.ok(errors.includes('ECONNREFUSED'));
        assert.strictEqual(errors.length, 2);
      } else if (process.platform === 'darwin') {
        assert.ok(errors.includes('EDESTADDRREQ'));
        assert.ok(errors.includes('ECONNRESET'));
        assert.strictEqual(errors.length, 2);
      } else {
        // Unknown platforms return empty array
        assert.strictEqual(errors.length, 0);
      }
    });
  });
});
