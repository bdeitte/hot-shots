const assert = require('assert');
const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const StatsD = require('../index.js');

/**
 * Patches dns.lookup to count calls. Self-contained rather than using
 * test/helpers so the same file can run against an older checkout when
 * comparing behavior across branches.
 * @returns {Object} state carrying count, names and restore
 */
function countLookups() {
  const original = dns.lookup;
  const state = {
    count: 0,
    names: [],
    restore: () => {
      dns.lookup = original;
    }
  };
  dns.lookup = function (...lookupArgs) {
    state.count++;
    state.names.push(lookupArgs[0]);
    return original.apply(this, lookupArgs);
  };
  return state;
}

/**
 * Binds a udp4 server on the loopback address and hands back its port.
 * @param onMessage {Function} called with each received message string
 * @param callback {Function} called with the socket and its port
 * @returns {void}
 */
function udp4Server(onMessage, callback) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', message => onMessage(message.toString()));
  socket.bind(0, '127.0.0.1', () => callback(socket, socket.address().port));
}

describe('#regressionGuards', () => {
  let lookups = null;
  let server = null;
  let statsd = null;

  afterEach(done => {
    if (lookups) {
      lookups.restore();
      lookups = null;
    }
    const closeServer = () => {
      if (!server) {
        return done();
      }
      const target = server;
      server = null;
      try {
        target.close(() => done());
      } catch (err) {
        done();
      }
      return undefined;
    };
    if (statsd) {
      const client = statsd;
      statsd = null;
      return client.close(() => closeServer());
    }
    return closeServer();
  });

  describe('dns lookups on the default send path', () => {
    it('performs no dns lookups for a client with no host', done => {
      udp4Server(() => { /* payload ignored */ }, (socket, port) => {
        server = socket;
        lookups = countLookups();
        statsd = new StatsD({ port: port });
        let sent = 0;
        const sendOne = () => {
          statsd.increment('regression.metric', err => {
            assert.ok(!err, `unexpected send error: ${err && err.message}`);
            sent++;
            if (sent < 5) {
              return sendOne();
            }
            assert.strictEqual(lookups.count, 0,
              `expected no dns lookups, saw ${lookups.count}: ${lookups.names.join(', ')}`);
            return done();
          });
        };
        sendOne();
      });
    });

    it('performs no dns lookups for an IP literal host', done => {
      udp4Server(() => { /* payload ignored */ }, (socket, port) => {
        server = socket;
        lookups = countLookups();
        statsd = new StatsD({ host: '127.0.0.1', port: port });
        let sent = 0;
        const sendOne = () => {
          statsd.increment('regression.metric', err => {
            assert.ok(!err, `unexpected send error: ${err && err.message}`);
            sent++;
            if (sent < 5) {
              return sendOne();
            }
            assert.strictEqual(lookups.count, 0,
              `expected no dns lookups, saw ${lookups.count}: ${lookups.names.join(', ')}`);
            return done();
          });
        };
        sendOne();
      });
    });
  });

  describe('hostname resolution delivers to an IPv4 agent', () => {
    it('delivers with cacheDns when the hostname also resolves to IPv6', done => {
      let received = 0;
      udp4Server(() => {
        received++;
      }, (socket, port) => {
        server = socket;
        statsd = new StatsD({ host: 'localhost', port: port, cacheDns: true });
        const errors = [];
        let settled = 0;
        const onSend = err => {
          settled++;
          if (err) {
            errors.push(err.code || err.message);
          }
        };
        for (let i = 0; i < 3; i++) {
          statsd.increment('regression.metric', onSend);
        }
        setTimeout(() => {
          assert.strictEqual(errors.length, 0,
            `cacheDns sends failed: ${errors.join(', ')}`);
          assert.strictEqual(settled, 3, 'every send callback should fire');
          assert.strictEqual(received, 3,
            `expected 3 packets at the IPv4 server, saw ${received}`);
          done();
        }, 800);
      });
    }).timeout(9000);

    it('delivers without cacheDns when the hostname also resolves to IPv6', done => {
      let received = 0;
      udp4Server(() => {
        received++;
      }, (socket, port) => {
        server = socket;
        statsd = new StatsD({ host: 'localhost', port: port });
        setTimeout(() => {
          assert.strictEqual(received, 3,
            `expected 3 packets at the IPv4 server, saw ${received}`);
          done();
        }, 800);
        for (let i = 0; i < 3; i++) {
          statsd.increment('regression.metric');
        }
      });
    }).timeout(9000);
  });

  describe('close() always completes', () => {
    it('completes close() when the tcp peer never connects', done => {
      const started = Date.now();
      // 192.0.2.1 is TEST-NET-1, reserved for documentation and unroutable,
      // so the connect attempt hangs rather than being refused.
      const client = new StatsD({
        protocol: 'tcp',
        host: '192.0.2.1',
        port: 65000,
        maxBufferSize: 1000,
        bufferFlushInterval: 60000,
        errorHandler: () => { /* failures are expected here */ }
      });
      client.increment('regression.metric');
      client.close(() => {
        assert.ok(Date.now() - started < 12000,
          'close() should finish rather than wait on the hanging connect');
        done();
      });
    }).timeout(20000);

    it('still flushes buffered metrics on close', done => {
      let received = '';
      udp4Server(message => {
        received += message;
      }, (socket, port) => {
        server = socket;
        const client = new StatsD({
          host: '127.0.0.1',
          port: port,
          maxBufferSize: 10000,
          bufferFlushInterval: 60000
        });
        client.increment('regression.a');
        client.increment('regression.b');
        client.increment('regression.c');
        client.close(() => {
          setTimeout(() => {
            ['regression.a:1|c', 'regression.b:1|c', 'regression.c:1|c'].forEach(metric => {
              assert.ok(received.indexOf(metric) !== -1,
                `close() dropped ${metric}; received: ${received}`);
            });
            done();
          }, 300);
        });
      });
    }).timeout(9000);
  });

  describe('tcp pending-write cap', () => {
    /**
     * Runs a burst of same-sized metrics at a peer that stalls for stallMs
     * and then drains, reporting what the server received and what the
     * client refused.
     * @param options {Object} stallMs, count, size
     * @param callback {Function} called with the tally
     * @returns {void}
     */
    function burstAtSlowPeer(options, callback) {
      let received = 0;
      let buffered = '';
      const peer = net.createServer(connection => {
        connection.pause();
        setTimeout(() => {
          connection.on('data', chunk => {
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop();
            received += lines.filter(line => line.indexOf('regression.') === 0).length;
          });
          connection.resume();
        }, options.stallMs);
      });
      peer.listen(0, '127.0.0.1', () => {
        const port = peer.address().port;
        const client = new StatsD({
          protocol: 'tcp',
          host: '127.0.0.1',
          port: port,
          errorHandler: () => { /* failures are expected here */ }
        });
        const padding = 'x'.repeat(options.size);
        let refused = 0;
        let accepted = 0;
        let firstCode = null;
        const onSend = err => {
          if (err) {
            refused++;
            firstCode = firstCode || err.code || err.message;
          } else {
            accepted++;
          }
        };
        setTimeout(() => {
          for (let i = 0; i < options.count; i++) {
            client.increment(`regression.${padding}`, 1, onSend);
          }
          setTimeout(() => {
            client.close(() => peer.close(() => callback({
              received: received,
              accepted: accepted,
              refused: refused,
              firstCode: firstCode
            })));
          }, options.stallMs + 5000);
        }, 300);
      });
    }

    it('does not refuse a burst that stays under the cap', done => {
      burstAtSlowPeer({ stallMs: 500, count: 500, size: 1000 }, tally => {
        assert.strictEqual(tally.refused, 0,
          `a 500 KB burst must not be refused, saw ${tally.refused} (${tally.firstCode})`);
        assert.strictEqual(tally.received, 500,
          `the slow peer should still receive every metric, saw ${tally.received}`);
        done();
      });
    }).timeout(20000);

    it('refuses sends past the cap rather than queueing without bound', done => {
      burstAtSlowPeer({ stallMs: 1000, count: 2000, size: 1000 }, tally => {
        assert.ok(tally.refused > 0,
          'a 2 MB burst at a stalled peer should hit the pending-write cap');
        assert.strictEqual(tally.firstCode, 'HOTSHOTS_WRITE_QUEUE_FULL',
          `expected HOTSHOTS_WRITE_QUEUE_FULL, saw ${tally.firstCode}`);
        assert.strictEqual(tally.accepted + tally.refused, 2000,
          'every send must settle exactly once');
        done();
      });
    }).timeout(20000);
  });

  describe('a throwing errorHandler cannot end the process', () => {
    it('survives an errorHandler that throws on a send failure', done => {
      udp4Server(() => { /* payload ignored */ }, (socket, port) => {
        server = socket;
        const client = new StatsD({
          host: '127.0.0.1',
          port: port,
          errorHandler: () => {
            throw new Error('errorHandler boom');
          }
        });
        // Close the underlying socket so the next send fails inside the
        // transport's completion callback, where a throw has no caller.
        client.socket.close();
        setTimeout(() => {
          assert.doesNotThrow(() => client.increment('regression.metric'));
          setTimeout(() => done(), 400);
        }, 100);
      });
    }).timeout(9000);
  });

  describe('intentional behavior changes from 17.1.1', () => {
    it('defaults the tcp host to an IPv4 loopback agent', done => {
      let received = '';
      const peer = net.createServer(connection => {
        connection.on('data', chunk => {
          received += chunk.toString();
        });
      });
      peer.listen(0, '127.0.0.1', () => {
        const client = new StatsD({
          protocol: 'tcp',
          port: peer.address().port,
          errorHandler: () => { /* failures are expected here */ }
        });
        client.increment('regression.metric');
        setTimeout(() => {
          assert.ok(received.indexOf('regression.metric:1|c') !== -1,
            `a no-host tcp client should reach the IPv4 agent; received: ${received}`);
          client.close(() => peer.close(() => done()));
        }, 800);
      });
    }).timeout(9000);

    it('still reaches an IPv6 loopback agent when host is given explicitly', done => {
      let received = '';
      const peer = net.createServer(connection => {
        connection.on('data', chunk => {
          received += chunk.toString();
        });
      });
      peer.on('error', () => done());
      peer.listen(0, '::1', () => {
        const client = new StatsD({
          protocol: 'tcp',
          host: '::1',
          port: peer.address().port,
          errorHandler: () => { /* failures are expected here */ }
        });
        client.increment('regression.metric');
        setTimeout(() => {
          assert.ok(received.indexOf('regression.metric:1|c') !== -1,
            `an explicit ::1 host must still work; received: ${received}`);
          client.close(() => peer.close(() => done()));
        }, 800);
      });
    }).timeout(9000);

    it('delivers a send failure on a later tick, not the calling frame', done => {
      const client = new StatsD({ host: '127.0.0.1', port: 8125 });
      client.close(() => {
        let onCallingFrame = true;
        client.increment('regression.metric', err => {
          assert.ok(err, 'a send after close should fail');
          assert.strictEqual(onCallingFrame, false,
            'the failure callback must not run on the calling frame');
          done();
        });
        onCallingFrame = false;
      });
    }).timeout(9000);

    it('rejects a post-close cacheDns send with its own code', done => {
      udp4Server(() => { /* payload ignored */ }, (socket, port) => {
        server = socket;
        const client = new StatsD({ host: 'localhost', port: port, cacheDns: true });
        client.increment('regression.warm', () => {
          client.close(() => {
            client.increment('regression.after', err => {
              assert.ok(err, 'a send after close should fail');
              assert.strictEqual(err.code, 'HOTSHOTS_DNS_CLOSED',
                `expected HOTSHOTS_DNS_CLOSED, saw ${err.code}`);
              done();
            });
          });
        });
      });
    }).timeout(9000);

    it('counts a post-close cacheDns drop in the queue telemetry bucket', done => {
      udp4Server(() => { /* payload ignored */ }, (socket, port) => {
        server = socket;
        const client = new StatsD({
          host: 'localhost',
          port: port,
          cacheDns: true,
          datadog: true,
          includeDatadogTelemetry: true
        });
        client.increment('regression.warm', () => {
          client.close(() => {
            client.increment('regression.after', () => {
              const telemetry = client.telemetry;
              assert.strictEqual(telemetry.packetsDropped, 1, 'one packet should be dropped');
              assert.strictEqual(telemetry.packetsDroppedQueue, 1,
                'the drop belongs to the queue bucket');
              assert.strictEqual(telemetry.packetsDroppedWriter, 0,
                'the drop no longer belongs to the writer bucket');
              done();
            });
          });
        });
      });
    }).timeout(9000);

    it('does not let a throwing errorHandler escape the constructor', done => {
      assert.doesNotThrow(() => {
        const client = new StatsD({
          protocol: 'bogus',
          errorHandler: err => {
            throw err;
          }
        });
        if (client && typeof client.close === 'function') {
          try {
            client.close(() => { /* nothing to close */ });
          } catch (err) {
            // the client never built a socket; nothing to clean up
          }
        }
      });
      done();
    });
  });
});
