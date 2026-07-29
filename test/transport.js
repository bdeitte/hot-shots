const assert = require('assert');
const dnsCounter = require('./helpers/dnsCounter.js');
const net = require('net');
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

  it('should handle write to destroyed stream gracefully (issue #247)', done => {
    let writeAttempted = false;

    class TestStream extends Writable {
      _write(chunk, encoding, callback) { // eslint-disable-line class-methods-use-this
        writeAttempted = true;
        callback();
      }
    }

    const stream = new TestStream();
    const client = new StatsD({
      protocol: 'stream',
      stream: stream,
      errorHandler: (error) => {
        // Error should be handled gracefully and identified by the expected error code
        assert.strictEqual(error.code, 'ERR_STREAM_DESTROYED');
        assert.strictEqual(writeAttempted, false, 'Should not attempt write to destroyed stream');
        client.close();
        done();
      }
    });

    // Destroy the stream before sending - this sets stream.destroyed = true
    stream.destroy();

    // This should call errorHandler with a graceful error, not throw ERR_STREAM_DESTROYED
    client.increment('test.metric');
  });

  it('should send metric when stream is writable', done => {
    let writeAttempted = false;

    class TestStream extends Writable {
      _write(chunk, encoding, callback) { // eslint-disable-line class-methods-use-this
        writeAttempted = true;
        callback();
        // Verify write was attempted
        assert.strictEqual(writeAttempted, true);
        client.close();
        done();
      }
    }

    const stream = new TestStream();
    const client = new StatsD({
      protocol: 'stream',
      stream: stream
    });

    client.increment('test.metric');
  });

  it('should handle sendMessage when socket is null', done => {
    const client = new StatsD({
      protocol: 'udp',
      host: 'localhost',
      port: 8125,
      errorHandler: (error) => {
        assert.ok(error.message.includes('Socket not created properly'));
        client.close(() => {
          done();
        });
      }
    });

    // Force socket to null
    client.socket.close();
    client.socket = null;
    client.sendMessage('test:1|c');
  });

  it('should handle mock transport emit and removeListener', () => {
    const client = new StatsD({ mock: true });
    let called = false;
    const listener = () => {
      called = true;
    };

    client.socket.on('test', listener);
    client.socket.emit('test');
    assert.strictEqual(called, true);

    called = false;
    client.socket.removeListener('test', listener);
    client.socket.emit('test');
    assert.strictEqual(called, false);

    client.close();
  });

  it('should add newline to TCP messages', done => {
    const tcpServer = net.createServer(socket => {
      socket.setEncoding('ascii');
      socket.on('data', data => {
        // TCP messages should end with newline
        assert.ok(data.endsWith('\n'), `Expected newline at end, got: ${JSON.stringify(data)}`);
        client.close(() => {
          tcpServer.close(() => {
            done();
          });
        });
      });
    });

    let client;
    // Bind and connect the IP literal rather than 'localhost'. Where localhost
    // resolves to ::1 first, the server listens on IPv6 only while the client
    // reaches IPv4, and this test times out without ever closing tcpServer --
    // the leaked handle then keeps mocha from exiting at all.
    tcpServer.listen(0, '127.0.0.1', () => {
      const addr = tcpServer.address();
      client = new StatsD({
        protocol: 'tcp',
        host: '127.0.0.1',
        port: addr.port,
      });
      client.increment('test.metric');
    });
  });

  it('should perform no dns lookups for TCP when no host is given', done => {
    // Defaulting to the IPv4 literal rather than 'localhost' means the loopback
    // path costs no resolution at all, matching UDP's behavior (see #185).
    let counter;
    const tcpServer = net.createServer(socket => {
      socket.setEncoding('ascii');
      socket.on('data', () => {
        const seen = counter.count;
        const hostnames = JSON.stringify(counter.hostnames);
        counter.restore();
        // Tear down before asserting. An assertion thrown from this handler
        // would otherwise leave tcpServer open, and the live handle stops
        // mocha exiting at all rather than just failing the test.
        client.close(() => {
          tcpServer.close(() => {
            assert.strictEqual(seen, 0, `expected no dns lookups, got ${seen} for ${hostnames}`);
            done();
          });
        });
      });
    });

    let client;
    tcpServer.listen(0, '127.0.0.1', () => {
      // Start counting only now: listen() resolves its own bind address, and
      // that scaffolding lookup is not the client's.
      counter = dnsCounter.startCounting();
      client = new StatsD({
        protocol: 'tcp',
        port: tcpServer.address().port,
      });
      client.increment('test.metric');
    });
  });

  it('should reach an IPv4-only agent over TCP when no host is given', done => {
    // With no host, Node connects to 'localhost'. Where that resolves to ::1
    // first, the connection must still fall back to the IPv4 agent rather than
    // failing outright. Node 20+ does this by default; Node 18 needs it asked
    // for explicitly, and Node 18 is still supported.
    const tcpServer = net.createServer(socket => {
      socket.setEncoding('ascii');
      socket.on('data', data => {
        assert.ok(data.includes('test.metric'), `unexpected payload: ${data}`);
        client.close(() => {
          tcpServer.close(() => {
            done();
          });
        });
      });
    });

    let client;
    tcpServer.listen(0, '127.0.0.1', () => {
      client = new StatsD({
        protocol: 'tcp',
        port: tcpServer.address().port,
      });
      client.increment('test.metric');
    });
  });

  it('should add newline to stream messages', done => {
    class TestStream extends Writable {
      _write(chunk, encoding, callback) { // eslint-disable-line class-methods-use-this
        const data = chunk.toString();
        // Stream messages should end with newline
        assert.ok(data.endsWith('\n'), `Expected newline at end, got: ${JSON.stringify(data)}`);
        callback();
        client.close();
        done();
      }
    }

    const stream = new TestStream();
    const client = new StatsD({
      protocol: 'stream',
      stream: stream
    });

    client.increment('test.metric');
  });
});
