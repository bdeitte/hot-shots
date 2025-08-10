const assert = require('assert');
const { Writable } = require('stream');
const StatsD = require('../lib/statsd.js');

describe('#transportExtended', () => {
  it('should handle empty messages correctly', done => {
    class TestStream extends Writable {
      _write(chunk, encoding, callback) { // eslint-disable-line class-methods-use-this
        const data = chunk.toString();
        // addEol does NOT add newline to empty strings (length === 0)
        assert.strictEqual(data, '');
        callback();
        done();
      }
    }

    const stream = new TestStream();
    const client = new StatsD({
      protocol: 'stream',
      stream: stream
    });

    // Send empty message - addEol won't add newline to empty messages
    client.socket.send(Buffer.from(''), () => {
      client.close();
    });
  });

  it('should handle stream destroy properly', done => {
    class TestStream extends Writable {
      _write(chunk, encoding, callback) { // eslint-disable-line class-methods-use-this
        callback();
      }

      destroy() { // eslint-disable-line class-methods-use-this
        this.emit('close');
      }
    }

    const stream = new TestStream();
    const client = new StatsD({
      protocol: 'stream',
      stream: stream
    });

    stream.on('close', () => {
      done();
    });

    client.close();
  });

  it('should require stream option for stream transport', done => {
    // The error is caught by the transport module and sent to errorHandler
    let errorCaught = false;
    new StatsD({ // eslint-disable-line no-new
      protocol: 'stream',
      // Missing stream option
      errorHandler: (error) => {
        assert(error.message.includes('`stream` option required'));
        errorCaught = true;
        done();
      }
    });

    // Give time for error to be handled
    setTimeout(() => {
      if (!errorCaught) {
        done(new Error('Expected error was not caught'));
      }
    }, 100);
  });

  it('should handle unsupported protocol error', () => {
    let errorHandled = false;

    const client = new StatsD({
      protocol: 'invalid-protocol',
      errorHandler: (error) => {
        assert(error.message.includes('Unsupported protocol'));
        errorHandled = true;
      }
    });

    // Give some time for error to be handled
    setTimeout(() => {
      assert(errorHandled, 'Error should have been handled');
      client.close();
    }, 10);
  });

  it('should log error to console when no errorHandler provided', done => {
    const originalConsoleError = console.error;
    let errorLogged = false;

    console.error = (error) => {
      if (error.message && error.message.includes('Unsupported protocol')) {
        errorLogged = true;
      }
    };

    const client = new StatsD({
      protocol: 'invalid-protocol'
    });

    setTimeout(() => {
      console.error = originalConsoleError;
      assert(errorLogged, 'Error should have been logged to console');
      client.close();
      done();
    }, 10);
  });

  it('should handle DNS lookup errors with cacheDns enabled', done => {
    const client = new StatsD({
      host: 'definitely-not-a-real-host-12345.invalid',
      protocol: 'udp',
      cacheDns: true,
      errorHandler: (error) => {
        assert(error.code === 'ENOTFOUND' || error.code === 'EAI_NONAME');
        client.close();
        done();
      }
    });

    client.increment('test.metric');
  });

});
