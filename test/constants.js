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
        // unix-dgram sets err.code to negative errno (ENOTCONN=107, ECONNREFUSED=111)
        assert.ok(errors.includes(-107));
        assert.ok(errors.includes(-111));
        assert.strictEqual(errors.length, 4);
      } else if (process.platform === 'darwin') {
        assert.ok(errors.includes('EDESTADDRREQ'));
        assert.ok(errors.includes('ECONNRESET'));
        // unix-dgram sets err.code to negative errno (EDESTADDRREQ=39, ECONNRESET=54)
        assert.ok(errors.includes(-39));
        assert.ok(errors.includes(-54));
        assert.strictEqual(errors.length, 4);
      } else {
        // Unknown platforms return empty array
        assert.strictEqual(errors.length, 0);
      }
    });
  });
});
