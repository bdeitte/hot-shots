const assert = require('assert');
const constants = require('../lib/constants');
const dgram = require('dgram');
const dns = require('dns');
const dnsCounter = require('./helpers/dnsCounter.js');
const EventEmitter = require('events');
const helpers = require('./helpers/helpers.js');
const net = require('net');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

/**
 * Socket mock constructor.
 * @constructor
 */
function SocketMock() {
  // eslint-disable-next-line no-empty-function
  this.emit = { bind: () => {} };
  // eslint-disable-next-line no-empty-function
  this.on = () => { return { bind: () => {} }; };
  // eslint-disable-next-line no-empty-function
  this.removeListener = { bind: () => {} };
  // eslint-disable-next-line no-empty-function
  this.close = { bind: () => {} };
  // eslint-disable-next-line no-empty-function
  this.unref = { bind: () => {} };
  this.sendCount = 0;
  this.send = (buf, offset, length, port, host, callback) => {
    this.buf = buf;
    this.offset = offset;
    this.length = length;
    this.port = port;
    this.host = host;
    this.sendCount++;
    callback();
  };
  // eslint-disable-next-line no-empty-function
  this.unref = () => {};
}

const mockDgramSocket = () => {
  const socketMock = new SocketMock();
  dgram.createSocket = () => socketMock;
  return socketMock;
};

describe('#udpDns', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  const originalDgramCreateSocket = dgram.createSocket;

  describe('lookups per send', () => {
    let server;
    let statsd;
    let counter;

    afterEach(done => {
      if (counter) {
        counter.restore();
        counter = null;
      }
      closeAll(server, statsd, false, done);
    });

    /**
     * Sends n metrics and invokes onDone once every send has called back.
     * @param {Object} client - the hot-shots client
     * @param {number} n - how many metrics to send
     * @param {Function} onDone - called after the last send completes
     */
    const sendN = (client, n, onDone) => {
      const state = { remaining: n };
      /**
       * Decrements the remaining count and calls onDone once it reaches zero.
       * @returns {void}
       */
      const onSendComplete = () => {
        state.remaining--;
        if (state.remaining === 0) {
          onDone();
        }
      };
      for (let i = 0; i < n; i++) {
        client.send(`test.${i}`, {}, onSendComplete);
      }
    };

    it('performs no dns lookups with the default host', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(opts, 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 0, `expected 0 lookups, saw ${counter.hostnames}`);
          done();
        });
      });
    });

    it('performs no dns lookups for an IPv4 host', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, { host: '127.0.0.1' }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 0, `expected 0 lookups, saw ${counter.hostnames}`);
          done();
        });
      });
    });

    it('performs no dns lookups for an IPv6 host', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, { host: '::1' }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 0, `expected 0 lookups, saw ${counter.hostnames}`);
          done();
        });
      });
    });

    it('still resolves a hostname when cacheDns is off', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, { host: 'localhost' }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 20);
          counter.hostnames.forEach(name => assert.strictEqual(name, 'localhost'));
          done();
        });
      });
    });

    it('performs no dns lookups when the socket type is set explicitly', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, {
          host: '127.0.0.1',
          udpSocketOptions: { type: 'udp4' }
        }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 0, `expected 0 lookups, saw ${counter.hostnames}`);
          done();
        });
      });
    });

    it('does not install its own lookup when the user supplies one', done => {
      let customCount = 0;
      /**
       * User-supplied lookup that resolves everything to loopback.
       * @param {string} hostname - name to resolve
       * @param {Object} options - lookup options
       * @param {Function} callback - node-style callback
       */
      const customLookup = (hostname, options, callback) => {
        customCount++;
        callback(null, '127.0.0.1', 4);
      };

      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          udpSocketOptions: { type: 'udp4', lookup: customLookup }
        }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 0, 'built-in dns.lookup must not be used');
          assert.ok(customCount >= 20, `custom lookup should handle every send, saw ${customCount}`);
          done();
        });
      });
    });

    it('performs one dns lookup per TTL with cacheDns and a hostname', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: 60000
        }), 'client');
        sendN(statsd, 20, () => {
          assert.strictEqual(counter.count, 1, `expected 1 lookup, saw ${counter.hostnames}`);
          done();
        });
      });
    });
  });

  describe('cacheDns transport', () => {
    let server;
    let statsd;
    let clock;

    afterEach(done => {
      if (clock) {
        clock.restore();
        clock = null;
      }
      dns.lookup = originalDnsLookup;
      dgram.createSocket = originalDgramCreateSocket;
      closeAll(server, statsd, false, done);
    });

    describe('Sending first message', () => {
      it('should lookup dns once', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          statsd = createHotShotsClient(Object.assign(opts, {
            host: 'localhost',
            cacheDns: true
          }), 'client');

          const resolvedHostAddress = '1.1.1.1';
          let dnsLookupCount = 0;
          dns.lookup = (host, options, callback) => {
            dnsLookupCount++;
            callback(undefined, resolvedHostAddress);
          };

          statsd.send('test title', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1000);
          assert.strictEqual(dnsLookupCount, 1);
          assert.strictEqual(socketMock.sendCount, 1);
          assert.strictEqual(socketMock.host, resolvedHostAddress);
          assert.strictEqual(socketMock.buf.toString(), 'test title');
          done();
        });
      });
    });

    describe('Sending messages within TTL', () => {
      it('should lookup dns once', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          statsd = createHotShotsClient(Object.assign(opts, {
            host: 'localhost',
            cacheDns: true
          }), 'client');

          const resolvedHostAddress = '1.1.1.1';
          let dnsLookupCount = 0;
          dns.lookup = (host, options, callback) => {
            callback(undefined, resolvedHostAddress);
            dnsLookupCount++;
          };

          statsd.send('message', {}, (error) => {
            assert.strictEqual(error, null);
          });

          statsd.send('other message', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1000);
          assert.strictEqual(dnsLookupCount, 1);
          assert.strictEqual(socketMock.sendCount, 2);
          assert.strictEqual(socketMock.host, resolvedHostAddress);
          done();
        });
      });
    });

    describe('Sending messages after TTL expired', () => {
      it('should lookup dns twice', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          const cacheDnsTtl = 100;
          statsd = createHotShotsClient(Object.assign(opts, {
            host: 'localhost',
            cacheDns: true,
            cacheDnsTtl: cacheDnsTtl
          }), 'client');

          const resolvedHostAddress = '1.1.1.1';
          let dnsLookupCount = 0;
          dns.lookup = (host, options, callback) => {
            callback(undefined, resolvedHostAddress);
            dnsLookupCount++;
          };

          statsd.send('message', {}, (error) => {
            assert.strictEqual(error, null);
          });

          statsd.send('other message', {}, (error) => {
            assert.strictEqual(error, null);
          });

          // Advance time past TTL
          clock.tick(cacheDnsTtl + 50);

          statsd.send('message 1ms after TTL', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1000);
          assert.strictEqual(dnsLookupCount, 2);
          assert.strictEqual(socketMock.sendCount, 3);
          done();
        });
      });
    });

    describe('DNS lookup failure', () => {
      it('should pass error to callback when DNS lookup fails', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          mockDgramSocket();

          statsd = createHotShotsClient(Object.assign(opts, {
            host: 'localhost',
            cacheDns: true,
          }), 'client');

          const dnsError = new Error('DNS lookup failed');
          dnsError.code = 'ENOTFOUND';
          dns.lookup = (host, options, callback) => {
            callback(dnsError);
          };

          statsd.send('test', {}, (error) => {
            assert.ok(error);
            assert.ok(error.message.includes('DNS lookup failed') || error.code === 'ENOTFOUND');
            done();
          });

          clock.tick(1000);
        });
      });
    });

    describe('IP address host', () => {
      it('should skip DNS lookup when host is an IP address', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          statsd = createHotShotsClient(Object.assign(opts, {
            host: '127.0.0.1',
            cacheDns: true,
          }), 'client');

          let dnsLookupCount = 0;
          dns.lookup = () => {
            dnsLookupCount++;
          };

          statsd.send('test', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1000);
          // Should not call dns.lookup for IP addresses
          assert.strictEqual(dnsLookupCount, 0);
          assert.strictEqual(socketMock.sendCount, 1);
          assert.strictEqual(socketMock.host, '127.0.0.1');
          done();
        });
      });

      it('should skip DNS lookup for IPv6 addresses', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          statsd = createHotShotsClient(Object.assign(opts, {
            host: '::1',
            cacheDns: true,
          }), 'client');

          let dnsLookupCount = 0;
          dns.lookup = () => {
            dnsLookupCount++;
          };

          statsd.send('test', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1000);
          assert.strictEqual(dnsLookupCount, 0);
          assert.strictEqual(socketMock.sendCount, 1);
          assert.strictEqual(socketMock.host, '::1');
          done();
        });
      });
    });

    describe('DNS resolution address change', () => {
      it('should use new address after TTL expires and DNS resolves differently', done => {
        server = createServer(udpServerType, opts => {
          clock = sinon.useFakeTimers();
          const socketMock = mockDgramSocket();

          const cacheDnsTtl = 100;
          statsd = createHotShotsClient(Object.assign(opts, {
            host: 'localhost',
            cacheDns: true,
            cacheDnsTtl: cacheDnsTtl
          }), 'client');

          let resolvedAddress = '1.1.1.1';
          dns.lookup = (host, options, callback) => {
            callback(undefined, resolvedAddress);
          };

          statsd.send('first', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1);
          assert.strictEqual(socketMock.host, '1.1.1.1');

          // Change DNS resolution
          resolvedAddress = '2.2.2.2';

          // Advance past TTL
          clock.tick(cacheDnsTtl + 50);

          // Stale-while-revalidate: this send goes out on the previous address
          // while the refresh runs in the background.
          statsd.send('second', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1);
          assert.strictEqual(socketMock.host, '1.1.1.1');

          // The next send picks up the refreshed address.
          statsd.send('third', {}, (error) => {
            assert.strictEqual(error, null);
          });

          clock.tick(1);
          assert.strictEqual(socketMock.host, '2.2.2.2');
          done();
        });
      });
    });
  });

  describe('cacheDns coalescing and refresh', () => {
    let server;
    let statsd;
    let clock;

    afterEach(done => {
      if (clock) {
        clock.restore();
        clock = null;
      }
      dns.lookup = originalDnsLookup;
      closeAll(server, statsd, false, done);
    });

    it('coalesces concurrent cold-start sends into one lookup', done => {
      server = createServer(udpServerType, opts => {
        let lookupCount = 0;
        let release;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          release = () => callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const state = { completed: 0 };
        /**
         * Callback shared by every coalesced send, tracking completion count via
         * the closed-over state object rather than a per-iteration function.
         * @param {Error|null} error - send error, expected null
         * @returns {void}
         */
        const onSendComplete = error => {
          assert.strictEqual(error, null);
          state.completed++;
          if (state.completed === 50) {
            assert.strictEqual(lookupCount, 1, 'concurrent cold-start sends must share one lookup');
            done();
          }
        };
        for (let i = 0; i < 50; i++) {
          statsd.send(`test.${i}`, {}, onSendComplete);
        }

        assert.strictEqual(lookupCount, 1, 'only one lookup should be in flight');
        release();
      });
    });

    it('serves the stale address and refreshes once in the background', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        let release;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            // Warm-up lookup resolves immediately.
            callback(null, '127.0.0.1');
            return;
          }
          // The refresh lookup is held open so three concurrent stale sends can
          // be issued while it is still in flight, proving they share it rather
          // than each completing before the next is issued.
          release = () => callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl
        }), 'client');

        statsd.send('first', {}, error => assert.strictEqual(error, null));
        clock.tick(1);
        assert.strictEqual(lookupCount, 1);

        clock.tick(cacheDnsTtl + 50);

        // Three concurrent stale sends must trigger exactly one refresh, not three.
        statsd.send('a', {}, error => assert.strictEqual(error, null));
        statsd.send('b', {}, error => assert.strictEqual(error, null));
        statsd.send('c', {}, error => assert.strictEqual(error, null));

        assert.strictEqual(lookupCount, 2, 'concurrent stale sends must share one in-flight refresh');
        release();
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'concurrent stale sends must share one refresh');
        done();
      });
    });

    it('keeps serving the stale address when a refresh fails', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            callback(null, '1.1.1.1');
            return;
          }
          callback(new Error('refresh boom'));
        };

        const errors = [];
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          errorHandler: err => errors.push(err)
        }), 'client');

        statsd.send('first', {}, error => assert.strictEqual(error, null));
        clock.tick(1);

        clock.tick(cacheDnsTtl + 50);
        statsd.send('second', {}, error => {
          // The send itself succeeds on the stale address.
          assert.strictEqual(error, null);
        });
        clock.tick(1);

        assert.strictEqual(errors.length, 1, 'refresh failure should reach errorHandler once');
        assert.ok(errors[0].message.includes('refresh boom'));
        done();
      });
    });

    // The TTL here is below DNS_COOLDOWN_BASE_MS, so the ramp is capped at it and
    // the cooldown is exactly one TTL. See the ramp tests below for the general rule.
    it('backs off after a failed refresh instead of retrying every send', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            // Warm the cache with one successful lookup.
            callback(null, '1.1.1.1');
            return;
          }
          // Every refresh after that fails, like a fast-failing resolver
          // (cached NXDOMAIN, SERVFAIL).
          callback(new Error('always fails'));
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        statsd.send('warm', {}, error => assert.strictEqual(error, null));
        clock.tick(1);
        assert.strictEqual(lookupCount, 1);

        clock.tick(cacheDnsTtl + 50);

        // Several sends immediately after the TTL expires must share the one
        // failed refresh, not each trigger their own lookup.
        // eslint-disable-next-line no-empty-function
        statsd.send('a', {}, () => {});
        // eslint-disable-next-line no-empty-function
        statsd.send('b', {}, () => {});
        // eslint-disable-next-line no-empty-function
        statsd.send('c', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'failed refresh should cool down, not retry per send');

        // Still within the cooldown: no further lookups. The wait after a first
        // failure is DNS_COOLDOWN_BASE_MS, independent of the TTL.
        clock.tick(constants.DNS_COOLDOWN_BASE_MS / 2);
        // eslint-disable-next-line no-empty-function
        statsd.send('d', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'no additional lookup before the cooldown elapses');

        // Past the cooldown: exactly one more attempt.
        clock.tick(constants.DNS_COOLDOWN_BASE_MS + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send('e', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 3, 'cooldown should allow exactly one more attempt');
        done();
      });
    });

    it('reports a refresh failure once per streak and re-arms after a success', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        let failing = true;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            callback(null, '1.1.1.1');
            return;
          }
          if (failing) {
            callback(new Error('still down'));
            return;
          }
          callback(null, '1.1.1.1');
        };

        const errors = [];
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          errorHandler: err => errors.push(err)
        }), 'client');

        // eslint-disable-next-line no-empty-function
        statsd.send('warm', {}, () => {});
        clock.tick(1);

        // Past both the TTL and any cooldown the streak has earned, so each
        // iteration gets a fresh attempt however far the backoff has ramped.
        const pastCooldown = constants.DNS_COOLDOWN_MAX_MS + 50;

        // Three consecutive failed refreshes should report only once.
        for (let i = 0; i < 3; i++) {
          clock.tick(pastCooldown);
          // eslint-disable-next-line no-empty-function
          statsd.send(`fail.${i}`, {}, () => {});
          clock.tick(1);
        }
        assert.strictEqual(errors.length, 1, 'streak should report once');

        // A success clears the streak.
        failing = false;
        clock.tick(pastCooldown);
        // eslint-disable-next-line no-empty-function
        statsd.send('recover', {}, () => {});
        clock.tick(1);

        // The next failure streak reports again.
        failing = true;
        clock.tick(pastCooldown);
        // eslint-disable-next-line no-empty-function
        statsd.send('fail-again', {}, () => {});
        clock.tick(1);
        assert.strictEqual(errors.length, 2, 'streak should re-arm after a success');
        done();
      });
    });

    it('falls back to console.error when no error listener is attached', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            callback(null, '1.1.1.1');
            return;
          }
          callback(new Error('refresh boom'));
        };

        const logged = [];
        const originalConsoleError = console.error;
        console.error = msg => logged.push(msg);

        // No errorHandler, so the only 'error' listener is the transport default.
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl
        }), 'client');

        // eslint-disable-next-line no-empty-function
        statsd.send('warm', {}, () => {});
        clock.tick(1);
        clock.tick(cacheDnsTtl + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send('second', {}, () => {});
        clock.tick(1);

        console.error = originalConsoleError;
        assert.strictEqual(logged.length, 1, `expected one console.error, saw ${logged.length}`);
        assert.ok(logged[0].includes('DNS refresh for localhost failed'));
        done();
      });
    });

    it('sends on the resolved address with the correct family', done => {
      server = createServer(udpServerType, opts => {
        let seenOptions = null;
        dns.lookup = (host, options, callback) => {
          seenOptions = options;
          // Resolve to an address that differs from args.host, which is the case
          // the old fixed-ipVersion bypass got wrong.
          callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        server.on('metrics', metrics => {
          assert.strictEqual(metrics, 'resolved.metric');
          // Pinned to the udp4 socket's family. Unpinned, getaddrinfo can answer
          // a udp4 socket with an AAAA record and every send fails with EINVAL.
          assert.ok(seenOptions, 'the lookup should receive an options argument');
          assert.strictEqual(seenOptions.family, 4,
            `a udp4 client must pin the lookup to family 4, saw ${JSON.stringify(seenOptions)}`);
          done();
        });

        statsd.send('resolved.metric', {}, error => {
          assert.strictEqual(error, null);
        });
      });
    });

    it('pins the lookup to family 6 for a udp6 socket', done => {
      // No server: the lookup argument is what is under test, and afterEach would
      // otherwise try to close the previous test's already-closed server.
      server = null;
      let seenOptions = null;
      dns.lookup = (host, options, callback) => {
        seenOptions = options;
        callback(null, '::1');
      };

      statsd = createHotShotsClient({
        host: 'localhost',
        port: 8125,
        cacheDns: true,
        udpSocketOptions: { type: 'udp6' }
      }, 'client');

      statsd.send('resolved.metric', {}, () => {
        assert.ok(seenOptions, 'the lookup should receive an options argument');
        assert.strictEqual(seenOptions.family, 6,
          `a udp6 client must pin the lookup to family 6, saw ${JSON.stringify(seenOptions)}`);
        done();
      });
    });

    it('still delivers to a udp4 agent when the resolver answers IPv6 first', done => {
      // The end-to-end half of the two pinning tests above. An unpinned lookup
      // gets ::1 here, which a udp4 socket cannot send to, so this fails with
      // EINVAL and delivers nothing unless the family pin is applied.
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => {
          const family = options && typeof options === 'object' ? options.family : 0;
          if (family === 4) {
            return callback(null, '127.0.0.1', 4);
          }
          return callback(null, '::1', 6);
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        server.on('metrics', metrics => {
          assert.strictEqual(metrics, 'ipv6first.metric');
          done();
        });

        statsd.send('ipv6first.metric', {}, error => {
          assert.strictEqual(error, null,
            `the send should reach the udp4 agent, got ${error && error.message}`);
        });
      });
    });

    it('retries within seconds of a long failure streak, not a whole TTL', done => {
      // Only an incoming send retries the lookup, so capping the cooldown at
      // cacheDnsTtl leaves a client refusing sends for up to a full TTL after the
      // resolver is healthy again. The ceiling must be seconds instead.
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 60000;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          callback(new Error('EAI_AGAIN'));
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // Drive a streak long enough that uncapped doubling would exceed the TTL.
        for (let i = 0; i < 10; i++) {
          // eslint-disable-next-line no-empty-function
          statsd.send(`fail.${i}`, {}, () => {});
          clock.tick(cacheDnsTtl + 1);
        }
        const afterStreak = lookupCount;

        // One ceiling's worth of time must be enough to earn another attempt.
        clock.tick(constants.DNS_COOLDOWN_MAX_MS + 1);
        // eslint-disable-next-line no-empty-function
        statsd.send('after.cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, afterStreak + 1,
          'a send one cooldown ceiling after the last failure should retry the lookup');

        // And the ceiling itself must be far below a default TTL.
        assert.ok(constants.DNS_COOLDOWN_MAX_MS <= 10000,
          `the cooldown ceiling should be seconds, saw ${constants.DNS_COOLDOWN_MAX_MS}`);
        done();
      });
    });

    it('keeps the resolver error code on a send refused during the cooldown', done => {
      // An errorHandler matching err.code === 'ENOTFOUND' must keep matching
      // while the cooldown is in effect, so the resolver's own code stays on the
      // error and the cooldown marker travels alongside it.
      server = null;
      dns.lookup = (host, options, callback) => {
        const error = new Error('getaddrinfo ENOTFOUND localhost');
        error.code = 'ENOTFOUND';
        callback(error);
      };

      statsd = createHotShotsClient({
        host: 'localhost',
        port: 8125,
        cacheDns: true
      }, 'client');

      statsd.send('first.metric', {}, firstError => {
        assert.strictEqual(firstError.code, 'ENOTFOUND',
          'the first failure should carry the resolver code');
        // This second send lands inside the cooldown.
        statsd.send('second.metric', {}, secondError => {
          assert.ok(secondError, 'a send during the cooldown should fail');
          assert.strictEqual(secondError.code, 'ENOTFOUND',
            `the cooldown rejection must keep the resolver code, saw ${secondError.code}`);
          assert.strictEqual(secondError.hotShotsCode, constants.DNS_COOLDOWN_CODE,
            `the cooldown marker should travel alongside, saw ${secondError.hotShotsCode}`);
          done();
        });
      });
    });

    it('fails every queued send when the cold-start lookup fails', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(new Error('cold boom'));
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const state = { failed: 0 };
        /**
         * Callback shared by every queued send, tracking failure count via the
         * closed-over state object rather than a per-iteration function.
         * @param {Error|null} error - the lookup error propagated to the send
         * @returns {void}
         */
        const onSendFailed = error => {
          assert.ok(error, 'queued send should receive the lookup error');
          state.failed++;
          if (state.failed === 10) {
            done();
          }
        };
        for (let i = 0; i < 10; i++) {
          statsd.send(`test.${i}`, {}, onSendFailed);
        }
        release();
      });
    });

    // TTL below DNS_COOLDOWN_BASE_MS again, so the capped cooldown is one TTL.
    it('backs off after a synchronous-throw refresh, on a warm cache', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (lookupCount === 1) {
            // Warm the cache with one successful lookup.
            callback(null, '1.1.1.1');
            return;
          }
          if (lookupCount === 2) {
            // The refresh triggered once the cache goes stale throws
            // synchronously instead of calling back, like an invalid-argument
            // dns.lookup failure.
            throw new Error('ERR_INVALID_ARG_TYPE: host must be a string');
          }
          callback(null, '1.1.1.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // eslint-disable-next-line no-empty-function
        statsd.send('warm', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 1);

        // Past the TTL: the send goes out on the stale address and triggers a
        // background refresh, which throws synchronously.
        clock.tick(cacheDnsTtl + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send('a', {}, () => {});
        assert.strictEqual(lookupCount, 2, 'stale send should trigger exactly one refresh attempt');

        // Still within the cooldown earned by the synchronous-throw catch block:
        // no further lookups.
        clock.tick(constants.DNS_COOLDOWN_BASE_MS / 2);
        // eslint-disable-next-line no-empty-function
        statsd.send('b', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2,
          'no additional lookup before the cooldown elapses after a synchronous throw');

        // Past the cooldown: exactly one more attempt.
        clock.tick(constants.DNS_COOLDOWN_BASE_MS + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send('c', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 3, 'cooldown should allow exactly one more attempt');
        done();
      });
    });

    it('calls back every queued send exactly once when dns.lookup throws synchronously', done => {
      server = createServer(udpServerType, opts => {
        dns.lookup = () => {
          // Some inputs (e.g. a non-string host) make dns.lookup throw synchronously
          // instead of invoking its callback.
          throw new Error('ERR_INVALID_ARG_TYPE: host must be a string');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const state = { failed: 0 };
        /**
         * Callback shared by every queued send, tracking failure count via the
         * closed-over state object rather than a per-iteration function.
         * @param {Error|null} error - the lookup error propagated to the send
         * @returns {void}
         */
        const onSendFailed = error => {
          assert.ok(error, 'queued send should receive the lookup error');
          state.failed++;
          if (state.failed === 10) {
            assert.strictEqual(statsd.messagesInFlight, 0,
              'messagesInFlight should drain back to 0 after every queued send is called back');
            done();
          }
        };
        for (let i = 0; i < 10; i++) {
          statsd.send(`test.${i}`, {}, onSendFailed);
        }
      });
    });

    // TTL below DNS_COOLDOWN_BASE_MS again, so the capped cooldown is one TTL.
    it('backs off after a failed cold-start lookup, with no cache to fall back on', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 100;
        let lookupCount = 0;
        // Never resolves, like a host whose name does not exist. There is no
        // cached address to fall back on, so the cooldown is the only thing
        // standing between this and a lookup per send.
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          callback(new Error('ENOTFOUND'));
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // eslint-disable-next-line no-empty-function
        statsd.send('a', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 1, 'the first cold-start send should attempt one lookup');

        // Still inside the cooldown: these sends must fail without attempting
        // another lookup, rather than each starting their own.
        for (let i = 0; i < 10; i++) {
          // eslint-disable-next-line no-empty-function
          statsd.send(`b.${i}`, {}, () => {});
        }
        clock.tick(constants.DNS_COOLDOWN_BASE_MS / 2);
        assert.strictEqual(lookupCount, 1, 'cold-start failure should cool down, not retry per send');

        // Past the cooldown: exactly one more attempt.
        clock.tick(constants.DNS_COOLDOWN_BASE_MS + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send('c', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'cooldown should allow exactly one more attempt');
        done();
      });
    });

    it('fails a send issued during the cold-start cooldown instead of queueing it forever', done => {
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => callback(new Error('ENOTFOUND'));

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: 60000
        }), 'client');

        statsd.send('first', {}, firstError => {
          assert.ok(firstError, 'the send that triggered the lookup should get the lookup error');
          // This one arrives while the cooldown is in effect, so there is no
          // lookup in flight for it to wait behind. It must call back rather than
          // sit in the pending queue until close().
          statsd.send('during-cooldown', {}, error => {
            assert.ok(error, 'a send during the cooldown should fail rather than queue');
            assert.ok(error.message.includes('recently failed'),
              `expected a cooldown message, got: ${error.message}`);
            assert.strictEqual(statsd.socket.getDnsPendingCount(), 0,
              'nothing should be left queued behind a lookup that is not running');
            assert.strictEqual(statsd.messagesInFlight, 0,
              'messagesInFlight should drain back to 0');
            done();
          });
        });
      });
    });

    it('ramps the cooldown from one second rather than blocking for a whole TTL', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        // Far larger than DNS_COOLDOWN_BASE_MS, so the ramp is visible instead of
        // being flattened by the cap the way a short test TTL would flatten it.
        const cacheDnsTtl = 60000;
        let lookupCount = 0;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          callback(new Error('EAI_AGAIN'));
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // eslint-disable-next-line no-empty-function
        statsd.send('cold', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 1);

        // First failure: one second, not one TTL.
        clock.tick(500);
        // eslint-disable-next-line no-empty-function
        statsd.send('during-first-cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 1, 'no retry within the first cooldown');

        clock.tick(600);
        // eslint-disable-next-line no-empty-function
        statsd.send('after-first-cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'a retry should be due about a second after the first failure');

        // Second failure doubles it to two seconds.
        clock.tick(1500);
        // eslint-disable-next-line no-empty-function
        statsd.send('during-second-cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 2, 'the second cooldown should be longer than the first');

        clock.tick(600);
        // eslint-disable-next-line no-empty-function
        statsd.send('after-second-cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 3, 'a retry should be due about two seconds after the second failure');
        done();
      });
    });

    it('caps the ramping cooldown at the TTL and resets it after a success', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const cacheDnsTtl = 10000;
        let lookupCount = 0;
        let failing = true;
        dns.lookup = (host, options, callback) => {
          lookupCount++;
          if (failing) {
            callback(new Error('EAI_AGAIN'));
            return;
          }
          callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: cacheDnsTtl,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // Doubling from 1s would pass the 10s TTL by the fifth failure, so drive
        // the streak well past that and confirm the wait never exceeds the TTL.
        for (let i = 0; i < 10; i++) {
          // eslint-disable-next-line no-empty-function
          statsd.send(`fail.${i}`, {}, () => {});
          clock.tick(cacheDnsTtl + 1);
        }
        assert.strictEqual(lookupCount, 10, 'each attempt past the capped cooldown should be allowed exactly once');

        // A success clears the streak, so the next failure starts back at one second.
        failing = false;
        statsd.send('recovers', {}, error => assert.strictEqual(error, null));
        clock.tick(1);
        assert.strictEqual(lookupCount, 11);

        failing = true;
        clock.tick(cacheDnsTtl + 1);
        // eslint-disable-next-line no-empty-function
        statsd.send('fails-again', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 12, 'a stale send after the success should refresh');

        clock.tick(1100);
        // eslint-disable-next-line no-empty-function
        statsd.send('after-reset-cooldown', {}, () => {});
        clock.tick(1);
        assert.strictEqual(lookupCount, 13, 'the streak should have reset, so the wait is a second again');
        done();
      });
    });

    it('keeps flushing the queue when a queued send callback throws', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(new Error('ENOTFOUND'));
        };

        const originalConsoleError = console.error;
        const state = { called: 0, logged: 0 };
        // eslint-disable-next-line no-empty-function
        console.error = () => { state.logged++; };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        // The first callback throws. Every later entry has already been spliced
        // out of the pending queue by the time it runs, so if the throw escaped
        // the flush loop nothing would ever call them back.
        for (let i = 0; i < 5; i++) {
          statsd.send(`test.${i}`, {}, () => {
            state.called++;
            if (state.called === 1) {
              throw new Error('callback blew up');
            }
          });
        }

        release();
        setImmediate(() => {
          console.error = originalConsoleError;
          assert.strictEqual(state.called, 5, 'every queued send should be called back despite the throw');
          assert.ok(state.logged > 0, 'the throw should be reported rather than swallowed');
          assert.strictEqual(statsd.messagesInFlight, 0, 'messagesInFlight should still drain to 0');
          done();
        });
      });
    });

    it('does not recurse without bound when a resending errorHandler meets a throwing lookup', done => {
      server = createServer(udpServerType, opts => {
        dns.lookup = () => {
          throw new Error('ERR_INVALID_ARG_TYPE: host must be a string');
        };

        // Raised so the depth measurements below are not truncated at the default
        // limit of 10 frames, which would hide the recursion this guards against.
        const originalStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = Infinity;

        const state = { calls: 0, maxDepth: 0 };
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          // The documented "emit a metric on send failure" pattern. Before the
          // failure paths were deferred, this re-entered the throwing lookup on
          // the same stack frame and grew the stack until the process wedged.
          errorHandler: () => {
            state.calls++;
            state.maxDepth = Math.max(state.maxDepth, new Error().stack.split('\n').length);
            if (state.calls < 200) {
              statsd.increment('resend');
              return;
            }
            Error.stackTraceLimit = originalStackLimit;
            assert.ok(state.maxDepth < 100,
              `each failure should land on a fresh tick, but the stack grew to ${state.maxDepth} frames`);
            done();
          }
        }), 'client');

        statsd.increment('first');
      });
    });
  });

  describe('cacheDns pending queue', () => {
    let server;
    let statsd;

    afterEach(done => {
      dns.lookup = originalDnsLookup;
      closeAll(server, statsd, false, done);
    });

    it('drops the oldest pending send past the cap and errors its callback', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const cap = constants.DNS_MAX_PENDING;
        const state = { dropped: [], delivered: 0 };

        const onSent = i => error => {
          if (error) {
            state.dropped.push(i);
          } else {
            state.delivered++;
          }
          if (state.dropped.length + state.delivered === cap + 1) {
            assert.deepStrictEqual(state.dropped, [0], 'the oldest queued send should be dropped');
            assert.strictEqual(state.delivered, cap);
            done();
          }
        };

        // One more than the cap, so exactly one send is dropped.
        for (let i = 0; i < cap + 1; i++) {
          statsd.send(`test.${i}`, {}, onSent(i));
        }

        release();
      });
    });

    it('counts a dropped send in datadog telemetry', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          includeDatadogTelemetry: true
        }), 'client');

        const cap = constants.DNS_MAX_PENDING;
        const state = { completed: 0 };

        const onSent = () => {
          state.completed++;
          if (state.completed === cap + 1) {
            assert.strictEqual(statsd.telemetry.packetsDroppedQueue, 1);
            assert.strictEqual(statsd.telemetry.packetsDroppedWriter, 0);
            done();
          }
        };

        for (let i = 0; i < cap + 1; i++) {
          statsd.send(`test.${i}`, {}, onSent);
        }

        release();
      });
    });

    it('never lets the pending queue exceed the cap, even when a drop callback sends again', done => {
      server = createServer(udpServerType, opts => {
        // dns.lookup never calls back, so every send stays queued (or dropped)
        // instead of being delivered - this isolates the queue-length invariant
        // from delivery timing.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const cap = constants.DNS_MAX_PENDING;
        const resendBudget = 20;
        const state = { maxPending: 0, reentrantSent: 0, finished: false };

        const recordMax = () => {
          const len = statsd.socket.getDnsPendingCount();
          if (len > state.maxPending) {
            state.maxPending = len;
          }
        };

        // A drop callback that synchronously sends again, e.g. an errorHandler
        // that emits a metric on drop. On the old shift-then-callback-then-push
        // ordering, this reentrant send observes the queue one entry under the
        // cap and does not drop, so the queue creeps upward by one per send.
        // The drop callback now fires on a deferred tick (see the recursion
        // regression test below), so this chain runs to completion - and this
        // test waits for that - before asserting and calling done().
        //
        // The cap entries left in the queue forever (dns.lookup never resolves)
        // share this same callback, and close() now cancels them in afterEach
        // (see task 4: Client.close() drains sends still queued behind a stuck
        // lookup instead of orphaning them) - so this fires again after done()
        // has already run. Guard so the extra cancellation callbacks are a
        // no-op instead of a double done() call.
        const onDropped = error => {
          recordMax();
          if (!error) {
            return;
          }
          if (state.reentrantSent < resendBudget) {
            state.reentrantSent++;
            statsd.send(`reentrant.${state.reentrantSent}`, {}, onDropped);
            return;
          }
          if (state.finished) {
            return;
          }
          state.finished = true;
          // The whole chain has run; assert on what it actually exercised, not
          // just that nothing blew up. A test that passes because the queue
          // never filled, or the drop path never fired, would be vacuous.
          assert.strictEqual(state.maxPending, cap,
            'the queue should have filled to exactly the cap');
          assert.ok(state.reentrantSent > 0, 'the reentrant drop path should have run');
          done();
        };

        // One over the cap, so exactly one send is dropped, kicking off the
        // reentrant chain above.
        for (let i = 0; i < cap + 1; i++) {
          statsd.send(`test.${i}`, {}, onDropped);
          recordMax();
        }
      });
    });

    it('breaks the synchronous recursion when a drop callback resends, avoiding a stack overflow (regression)', done => {
      server = createServer(udpServerType, opts => {
        // dns.lookup never calls back, so the cache never resolves and every
        // send past the cap keeps dropping and resending, exactly the
        // errorHandler-emits-a-metric shape that recurses under the bug.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const cap = constants.DNS_MAX_PENDING;
        // Deep enough that the old synchronous drop-callback ordering recurses
        // (genuine call-stack depth, not just a large loop) past Node's
        // default stack limit before this test could ever complete. Bounded so
        // the chain terminates deterministically instead of resending forever
        // against the never-resolving lookup.
        const resendBudget = 5000;
        const state = { maxPending: 0, reentrantSent: 0, finished: false };

        const recordMax = () => {
          const len = statsd.socket.getDnsPendingCount();
          if (len > state.maxPending) {
            state.maxPending = len;
          }
        };

        // See the equivalent guard in the test above: the cap entries left in
        // the queue forever share this callback, and close() (afterEach) now
        // cancels them instead of orphaning them, so this can fire again after
        // done() has already run.
        const onDropped = error => {
          recordMax();
          if (!error) {
            return;
          }
          if (state.reentrantSent < resendBudget) {
            state.reentrantSent++;
            statsd.send(`reentrant.${state.reentrantSent}`, {}, onDropped);
            return;
          }
          if (state.finished) {
            return;
          }
          state.finished = true;
          // Reaching here at all (without a RangeError further up the stack,
          // and within the test's timeout) is the regression check: the
          // deferred scheduling must have kept this from recursing.
          assert.strictEqual(state.maxPending, cap,
            'the queue should have filled to exactly the cap');
          assert.ok(state.reentrantSent > 0, 'the reentrant drop path should have run');
          done();
        };

        for (let i = 0; i < cap + 1; i++) {
          statsd.send(`test.${i}`, {}, onDropped);
          recordMax();
        }
      });
    }).timeout(9000);

    it('never lets messagesInFlight go negative when an overflow batch races finish()\'s force-zero (regression, Important 3)', done => {
      server = createServer(udpServerType, opts => {
        // Never resolves: every send stays queued (or overflows and drops)
        // rather than being delivered, so the flood below keeps racing the
        // DNS_MAX_PENDING cap for the whole close/drain window.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
          // Default closingFlushInterval (50ms) -> ~550ms drain budget, matching
          // the reported repro's default-config case (cfi=50, final=-100).
        }), 'client');

        const cap = constants.DNS_MAX_PENDING;
        let sending = true;
        let created = 0;
        let seenNegative = false;

        const checkNegative = () => {
          if (statsd.messagesInFlight < 0) {
            seenNegative = true;
          }
        };

        const floodOnce = () => {
          if (!sending) {
            return;
          }
          created++;
          statsd.send(`flood.${created}`, {}, checkNegative);
          checkNegative();
        };

        // Prime the queue past the cap so overflow drops start immediately...
        for (let i = 0; i < cap + 1; i++) {
          floodOnce();
        }
        // ...then keep sending continuously (one per event-loop turn, not a
        // tight synchronous loop) so a fresh overflow batch - with its
        // callbacks deferred via setImmediate - is reliably still scheduled
        // when close()'s drain timeout elapses and finish() force-zeroes
        // messagesInFlight below.
        const pump = () => {
          if (!sending) {
            return;
          }
          floodOnce();
          setImmediate(pump);
        };
        pump();

        statsd.close(() => {
          sending = false;
          // Let any overflow-drop callbacks still scheduled from before close()
          // finished land before asserting on the final settled state.
          setTimeout(() => {
            assert.strictEqual(seenNegative, false,
              'messagesInFlight must never be observed negative');
            assert.ok(statsd.messagesInFlight >= 0,
              `messagesInFlight must settle to >= 0, saw ${statsd.messagesInFlight}`);
            assert.ok(created > cap,
              'the flood should have produced more sends than the queue cap to actually exercise overflow');
            // Already closed above; let afterEach's closeAll skip re-closing.
            statsd = null;
            done();
          }, 100);
        });
      });
    }).timeout(9000);
  });

  describe('cacheDns close', () => {
    const originalConsoleError = console.error;
    let server;
    let clock;

    afterEach(done => {
      dns.lookup = originalDnsLookup;
      dgram.createSocket = originalDgramCreateSocket;
      // Restored here as well as in each test's close callback: a test whose close
      // never calls back would otherwise leave console.error swallowed for the rest
      // of the process, including mocha's own failure output.
      console.error = originalConsoleError;
      if (clock) {
        clock.restore();
        clock = null;
      }
      if (server) {
        server.close(() => done());
        server = null;
        return;
      }
      done();
    });

    it('does not force-close or corrupt the counter when a lookup is stuck', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup stays in flight forever.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        const logged = [];
        console.error = msg => logged.push(String(msg));

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        let sendErrored = false;
        statsd.send('stuck', {}, error => {
          assert.ok(error, 'the queued send should be failed during close');
          sendErrored = true;
        });

        statsd.close(() => {
          console.error = originalConsoleError;
          assert.ok(sendErrored, 'close must fail the queued send');
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must not go negative, saw ${statsd.messagesInFlight}`);
          const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
          assert.strictEqual(forced.length, 0, 'cancelling pending sends should avoid the force-close path');
          done();
        });
      });
    });

    it('completes close in buffered mode when the final flush lookup is stuck (regression, Important 2)', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup stays in flight forever. The
        // close-time flush guard now waits CLOSE_FLUSH_TIMEOUT (5s) instead of
        // the old closingFlushInterval * 11 (~550ms) budget, so drive it with fake
        // timers rather than actually waiting 5 real seconds.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};
        clock = sinon.useFakeTimers();

        const errors = [];
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          errorHandler: err => errors.push(err)
        }), 'client');

        // Buffered, so nothing is sent until close()'s final flushQueue.
        statsd.increment('buffered.metric');
        assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
          assert.strictEqual(statsd.messagesInFlight, 0,
            `messagesInFlight must not go negative, saw ${statsd.messagesInFlight}`);
          assert.strictEqual(errors.length, 1, 'the dropped final flush should be reported');
          assert.strictEqual(errors[0].code, constants.DNS_CANCELLED_CODE);
          done();
        });

        // Advance past CLOSE_FLUSH_TIMEOUT (5000ms) to fire the flush guard,
        // plus a little more to cover the subsequent drain-wait tick.
        clock.tick(constants.CLOSE_FLUSH_TIMEOUT + 1000);
      });
    });

    it('delivers the buffered final flush when a slow first lookup resolves within the close budget (regression, Important 2)', done => {
      server = createServer(udpServerType, opts => {
        // Resolves at ~800ms - well under the new 5s CLOSE_FLUSH_TIMEOUT budget,
        // but well past the old ~550ms drain-only budget that used to silently drop
        // this flush. Real timers here (not faked): this exercises the real send
        // path end-to-end, and 800ms real wait is short enough to stay well inside
        // mocha's 5000ms per-test timeout.
        dns.lookup = (host, options, callback) => {
          setTimeout(() => callback(null, '127.0.0.1'), 800);
        };

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000
        }), 'client');

        let received = null;
        server.on('metrics', metrics => {
          received = metrics;
        });

        statsd.increment('slow.lookup.metric');
        assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
          setTimeout(() => {
            assert.ok(received && received.includes('slow.lookup.metric'),
              `buffered metric should still be delivered, saw ${received}`);
            done();
          }, 50);
        });
      });
    });

    it('delivers the buffered final flush when the lookup resolves in time', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(null, '127.0.0.1');
        };

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000
        }), 'client');

        let received = null;
        server.on('metrics', metrics => {
          received = metrics;
        });

        statsd.increment('buffered.metric');
        setTimeout(() => release(), 10);

        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);
          setTimeout(() => {
            assert.ok(received && received.includes('buffered.metric'),
              `buffered metric should still be delivered, saw ${received}`);
            done();
          }, 20);
        });
      });
    });

    it('still delivers a queued send when the lookup resolves before the timeout', done => {
      server = createServer(udpServerType, opts => {
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(null, '127.0.0.1');
        };

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        let sendError = 'not called';
        statsd.send('inflight', {}, error => {
          sendError = error;
        });

        // Resolve shortly after close() begins, well inside the drain budget.
        setTimeout(() => release(), 10);

        statsd.close(() => {
          assert.strictEqual(sendError, null, 'a send that resolves in time must not be cancelled');
          done();
        });
      });
    });

    it('does not go negative or force-close when a resending errorHandler races the cancel pass (regression, Critical 1)', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup stays in flight forever.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        const logged = [];
        console.error = msg => logged.push(String(msg));

        // A bounded stand-in for the documented "emit a metric on send failure"
        // errorHandler pattern: an errorHandler that resends unconditionally,
        // forever, on every single failure (including failures caused by its
        // own resend) cannot be driven to completion by any library-side fix -
        // it is a caller-side retry storm, not a defect this task can cure.
        // This caps the resends the same way the pending-queue resendBudget
        // tests above do, while still exercising exactly the
        // reported shape: no per-send callbacks anywhere, only errorHandler,
        // against a lookup that never resolves.
        const resendBudget = 20;
        const state = { errorHandlerCalls: 0 };

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          errorHandler: () => {
            state.errorHandlerCalls++;
            if (state.errorHandlerCalls <= resendBudget) {
              statsd.increment('send.failure');
            }
          }
        }), 'client');

        statsd.increment('a');
        statsd.increment('b');
        statsd.increment('c');

        statsd.close(() => {
          // Let any still-settling deferred rejections land before asserting.
          setImmediate(() => {
            console.error = originalConsoleError;
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight must not go negative or stay stuck, saw ${statsd.messagesInFlight}`);
            const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
            assert.strictEqual(forced.length, 0,
              'a resending errorHandler must not spuriously trip the force-close path');
            assert.ok(state.errorHandlerCalls > 3,
              'the resend chain should have run beyond the 3 original sends');
            done();
          });
        });
      });
    });

    it('completes close and calls every queued send back when the errorHandler throws', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup stays in flight forever, so all
        // five sends are still queued when close() cancels them.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        const logged = [];
        console.error = msg => logged.push(String(msg));

        const state = { handlerCalls: 0 };
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          // A plainly buggy handler, but one the client must survive: close()
          // drives this synchronously from finish(), so before the guard an
          // escaping throw skipped the socket close and the close callback
          // entirely, hanging close() and stranding the rest of the queue.
          errorHandler: () => {
            state.handlerCalls++;
            throw new Error('handler blew up');
          }
        }), 'client');

        for (let i = 0; i < 5; i++) {
          statsd.increment(`queued.${i}`);
        }
        assert.strictEqual(statsd.socket.getDnsPendingCount(), 5, 'all five sends should be queued behind the lookup');

        statsd.close(closeError => {
          setImmediate(() => {
            console.error = originalConsoleError;
            assert.ok(!closeError, `close should still succeed, got ${closeError && closeError.message}`);
            assert.strictEqual(state.handlerCalls, 5,
              `every queued send should reach the handler, saw ${state.handlerCalls}`);
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight should drain to 0, saw ${statsd.messagesInFlight}`);
            const reported = logged.filter(msg => msg.includes('errorHandler threw'));
            assert.strictEqual(reported.length, 5,
              `every throw should be reported rather than swallowed, saw ${JSON.stringify(logged)}`);
            done();
          });
        });
      });
    });

    it('calls every entry back exactly once across a close with a resending callback (regression, Critical 2)', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup stays in flight forever.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const seen = {};
        const initialIds = ['entry0', 'entry1', 'entry2'];
        const maxGeneration = 2;
        // Every entry's callback resends exactly once more, through two bounded
        // generations of retry (generation 0 -> 1 -> 2, which does not resend
        // again). A single-pass cancellation with no latch only ever gets two
        // chances to flush `pending` (cancelPendingSends' one pass, then
        // transport.close()'s one pass) - enough to catch generation 1, but
        // generation 2 (created by generation 1's callback, during
        // transport.close()'s flush) has no third flush to catch it and is
        // orphaned forever. The latch fix must instead reject generation 2
        // immediately (no more `pending` involved at all), so nothing is ever
        // missing - and nothing is ever double-invoked either.
        const track = (id, generation) => error => {
          seen[id] = (seen[id] || 0) + 1;
          if (error && generation < maxGeneration) {
            const nextId = `${id}-gen${generation + 1}`;
            statsd.send(`retry.${nextId}`, {}, track(nextId, generation + 1));
          }
        };

        initialIds.forEach(id => {
          statsd.send(`test.${id}`, {}, track(id, 0));
        });

        statsd.close(() => {
          // Let the deferred later-generation rejections land before asserting.
          setImmediate(() => {
            const expectedIds = initialIds.
              concat(initialIds.map(id => `${id}-gen1`)).
              concat(initialIds.map(id => `${id}-gen1-gen2`));
            const missing = expectedIds.filter(id => !seen[id]);
            const duplicates = Object.keys(seen).filter(id => seen[id] > 1);
            assert.deepStrictEqual(missing, [], `entries never called back: ${missing}`);
            assert.deepStrictEqual(duplicates, [], `entries called back more than once: ${duplicates}`);
            done();
          });
        });
      });
    });

    it('ignores a DNS lookup that resolves after cancellation but before deferred rejections run (regression, late-resolve latch bypass)', done => {
      server = createServer(udpServerType, opts => {
        // Release-style stub: we control exactly when the lookup completes,
        // instead of it never resolving at all.
        let release;
        dns.lookup = (host, options, callback) => {
          release = () => callback(null, '127.0.0.1');
        };

        const logged = [];
        console.error = msg => logged.push(String(msg));

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        const seen = {};
        const initialIds = ['entry0', 'entry1', 'entry2'];
        // Each initial entry's cancellation callback resolves the still-in-flight
        // lookup (once, on the first callback to run) and then resends once,
        // under a distinct id. This is the exact race the finding describes:
        // the cancellation callback only runs from cancelPendingSends' flush,
        // which sets the `cancelled` latch before invoking any callback, so the
        // lookup resolves strictly AFTER cancellation - but strictly BEFORE any
        // deferred (setImmediate) rejection for the resend has had a chance to
        // run. If the late address were allowed to set resolvedAddress and
        // matter (the bug), the resend would take the warm sendToSocket branch
        // instead of being rejected.
        let released = false;
        const track = id => error => {
          seen[id] = (seen[id] || 0) + 1;
          if (!released) {
            released = true;
            release();
          }
          if (error && !id.endsWith('-retry')) {
            statsd.send(`retry.${id}`, {}, track(`${id}-retry`));
          }
        };

        initialIds.forEach(id => {
          statsd.send(`test.${id}`, {}, track(id));
        });

        statsd.close(() => {
          // Let any still-settling deferred rejections land before asserting.
          setImmediate(() => {
            console.error = originalConsoleError;
            const expectedIds = initialIds.concat(initialIds.map(id => `${id}-retry`));
            const missing = expectedIds.filter(id => !seen[id]);
            const duplicates = Object.keys(seen).filter(id => seen[id] > 1);
            assert.deepStrictEqual(missing, [], `entries never called back: ${missing}`);
            assert.deepStrictEqual(duplicates, [], `entries called back more than once: ${duplicates}`);
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight must settle to 0, saw ${statsd.messagesInFlight}`);
            const forced = logged.filter(msg => msg.includes('could not clear out messages in flight'));
            assert.strictEqual(forced.length, 0,
              'a lookup resolving after cancellation must not trip the force-close path');
            done();
          });
        });
      });
    });

    it('does not report DNS cancellation for a closed client that never enabled cacheDns', done => {
      server = createServer(udpServerType, opts => {
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost'
          // cacheDns intentionally left off - this is exactly the case
          // isDnsSendBlocked's `args.cacheDns` guard exists to leave untouched.
          // Without that guard, close() latching `cancelled` unconditionally
          // would make a post-close send here look DNS-cancelled even though
          // this client never queued anything behind a lookup at all.
        }), 'client');

        statsd.close(() => {
          const calls = [];
          statsd.send('after-close', {}, error => {
            calls.push(error);
          });

          // Let any deferred callback land before asserting exactly-once.
          setImmediate(() => {
            assert.strictEqual(calls.length, 1, `callback must fire exactly once, saw ${calls.length}`);
            assert.ok(calls[0], 'a send after close should still fail');
            assert.notStrictEqual(calls[0].code, constants.DNS_CANCELLED_CODE,
              'a client that never enabled cacheDns must not report DNS cancellation on close');
            assert.notStrictEqual(calls[0].code, constants.DNS_CLOSED_CODE,
              'a client that never enabled cacheDns must not report a DNS-closed-queue code either');
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight must settle to 0, saw ${statsd.messagesInFlight}`);
            done();
          });
        });
      });
    });

    it('does not claim DNS was cancelled for an ordinary post-close send on a warmed cacheDns client (regression, Important 1)', done => {
      server = createServer(udpServerType, opts => {
        // Resolves successfully right away - the lookup completes long before
        // close() ever runs, so nothing is stalled or queued behind DNS at close
        // time. Only the transport's cacheDns queue gets latched closed by
        // close() itself (finish() cancels it unconditionally on every close).
        dns.lookup = (host, options, callback) => callback(null, '127.0.0.1');

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
          // Deliberately no errorHandler here: the post-close send below has no
          // per-call callback either, so the only way to observe the error is a
          // socket 'error' listener - which is exactly what part (c) of the fix
          // must still deliver.
        }), 'client');

        // Warm the cache with a real resolved address before closing.
        statsd.send('warmup', {}, warmupError => {
          assert.strictEqual(warmupError, null, 'the warmup send should succeed');

          statsd.close(closeError => {
            assert.ok(!closeError, `close should not fail, got ${closeError && closeError.message}`);

            const socketErrors = [];
            statsd.socket.on('error', err => socketErrors.push(err));

            // No callback and no errorHandler: the only path left to observe the
            // failure is the socket 'error' listener above.
            statsd.send('after-close', {});

            setImmediate(() => {
              assert.strictEqual(socketErrors.length, 1,
                `expected exactly one socket error, saw ${socketErrors.length}`);
              const message = socketErrors[0] && socketErrors[0].message;
              assert.ok(message && !(/DNS resolution.*cancelled/).test(message),
                `error message must not claim DNS resolution was cancelled, got: ${message}`);
              assert.ok(message && message.includes('closed'),
                `error message should describe a closed client, got: ${message}`);
              assert.strictEqual(socketErrors[0].code, constants.DNS_CLOSED_CODE,
                'a send arriving after close on a warm client should carry DNS_CLOSED_CODE, not DNS_CANCELLED_CODE');
              done();
            });
          });
        });
      });
    });

    it('uses distinct codes for a cancelled in-flight lookup versus a send arriving after close (regression, DNS_CANCELLED_CODE vs DNS_CLOSED_CODE)', done => {
      server = createServer(udpServerType, opts => {
        // Never invoke the callback: the lookup for the first send stays in
        // flight forever, so close() must cancel it mid-lookup - the genuine
        // DNS_CANCELLED_CODE case.
        // eslint-disable-next-line no-empty-function
        dns.lookup = () => {};

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        // Queued behind the never-resolving lookup - close() below will cancel
        // this one mid-flight.
        let cancelledError = null;
        statsd.send('queued-before-close', {}, err => {
          cancelledError = err;
        });

        statsd.close(() => {
          // Arrives after close() already latched the queue shut - a
          // different case from the one above, even though both fail.
          statsd.send('after-close', {}, closedError => {
            assert.ok(cancelledError, 'the queued send should fail when close() cancels its lookup');
            assert.ok(closedError, 'the post-close send should also fail');
            assert.strictEqual(cancelledError.code, constants.DNS_CANCELLED_CODE,
              `a send queued and cancelled mid-lookup should carry DNS_CANCELLED_CODE, got ${cancelledError.code}`);
            assert.strictEqual(closedError.code, constants.DNS_CLOSED_CODE,
              `a send arriving after close should carry DNS_CLOSED_CODE, got ${closedError.code}`);
            assert.notStrictEqual(cancelledError.code, closedError.code,
              'the two cases must be distinguishable by error code');
            done();
          });
        });
      });
    });

    it('wraps a post-close send error with the same prefix every other send error has', done => {
      // Every send failure reaches the caller as `Error sending hot-shots
      // message: ...`, built in handleCallback. This rejection is raised before
      // the transport is reached, so it has to apply the same wrapping itself or
      // it becomes the one send error that does not match a caller's prefix check.
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => callback(null, '127.0.0.1');

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        // Warm the cache so close() latches a resolved queue rather than
        // cancelling a lookup in flight.
        statsd.send('warm', {}, () => {
          statsd.close(() => {
            statsd.send('after-close', {}, closedError => {
              assert.ok(closedError, 'the post-close send should fail');
              assert.ok(closedError.message.startsWith('Error sending hot-shots message: '),
                `expected the standard send-error prefix, got ${JSON.stringify(closedError.message)}`);
              assert.ok(closedError.message.includes('no longer accepted'),
                `the original reason should survive the wrapping, got ${JSON.stringify(closedError.message)}`);
              assert.strictEqual(closedError.code, constants.DNS_CLOSED_CODE,
                `the code must survive the wrapping, got ${closedError.code}`);
              done();
            });
          });
        });
      });
    });

    it('completes a second close() on an already-closed cacheDns client (regression, close() must accept DNS_CLOSED_CODE too)', done => {
      server = createServer(udpServerType, opts => {
        // Resolves successfully right away, so the first close() latches the
        // queue shut without ever cancelling an in-flight lookup - the second
        // close()'s own final flush is what then gets rejected with
        // DNS_CLOSED_CODE (not DNS_CANCELLED_CODE), since the queue was already
        // closed by the first close() by the time it runs.
        dns.lookup = (host, options, callback) => callback(null, '127.0.0.1');

        // A real dgram socket throws ERR_SOCKET_DGRAM_NOT_RUNNING on a second
        // close() regardless of any DNS-code handling - that's pre-existing,
        // general repeat-close behavior (reproduced independently, outside this
        // suite, against an unmocked client), orthogonal to what this test
        // targets. Mock the socket with an idempotent close() - emitting
        // 'close' the way the real socket eventually does, so Client._close()'s
        // listener-based callback still fires - so the assertions below isolate
        // exactly the regression under test: whether close()'s flush-error
        // branch lets a second close reach finish() at all for a DNS_CLOSED_CODE
        // flush error, the way it already does for DNS_CANCELLED_CODE.
        const socketMock = new EventEmitter();
        socketMock.send = (buf, offset, length, port, host, callback) => callback();
        socketMock.close = () => setImmediate(() => socketMock.emit('close'));
        // eslint-disable-next-line no-empty-function
        socketMock.unref = () => {};
        dgram.createSocket = () => socketMock;

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000
        }), 'client');

        // Buffered mode: this just queues - the actual dns.lookup (warming the
        // cache) happens when the buffer is flushed, which the first close()
        // below triggers.
        statsd.increment('warmup');
        assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

        statsd.close(firstCloseError => {
          assert.ok(!firstCloseError, `first close should not fail, got ${firstCloseError && firstCloseError.message}`);

          // Buffer another metric between the two closes so the second
          // close()'s own final flushQueue() has something to reject.
          statsd.increment('buffered.after.first.close');
          assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

          statsd.close(secondCloseError => {
            assert.ok(!secondCloseError,
              `second close should not fail, got ${secondCloseError && secondCloseError.message}`);
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight must settle to 0 after the second close, saw ${statsd.messagesInFlight}`);
            done();
          });
        });
      });
    });

    it('still closes the socket when the final flush is refused by the DNS cooldown', done => {
      server = createServer(udpServerType, opts => {
        // Every lookup fails, so the first send arms the cooldown and the
        // buffered final flush below is refused without a lookup being attempted.
        dns.lookup = (host, options, callback) => setImmediate(() => callback(new Error('ENOTFOUND')));

        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: 60000,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }), 'client');

        // Arm the cooldown with one genuinely failed lookup.
        statsd.increment('arm.the.cooldown');
        statsd.flush();

        setTimeout(() => {
          const state = { closed: false };
          const realSocketClose = statsd.socket.close.bind(statsd.socket);
          statsd.socket.close = () => {
            state.closed = true;
            realSocketClose();
          };

          // Give the final flush a payload to be refused.
          statsd.increment('buffered.during.cooldown');
          assert.ok(statsd.bufferLength > 0, 'metric should be sitting in the buffer');

          statsd.close(closeError => {
            // The refusal is reported through errorHandler, not by failing the
            // close: a refused flush means nothing reached the socket, so there
            // is no reason to abort the close and leak the socket.
            assert.ok(!closeError,
              `close should not fail on a refused final flush, got ${closeError && closeError.message}`);
            assert.ok(state.closed, 'the socket must still be closed after a refused final flush');
            assert.strictEqual(statsd.messagesInFlight, 0,
              `messagesInFlight must settle to 0, saw ${statsd.messagesInFlight}`);
            done();
          });
        }, 50);
      });
    });

    it('still closes the socket when a cold lookup fails during the final flush', done => {
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => setImmediate(() => {
          const err = new Error('getaddrinfo ENOTFOUND localhost');
          err.code = 'ENOTFOUND';
          callback(err);
        });
        const reported = [];
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          errorHandler: err => reported.push(err)
        }), 'client');
        const state = { closed: false };
        const realSocketClose = statsd.socket.close.bind(statsd.socket);
        statsd.socket.close = () => {
          state.closed = true;
          realSocketClose();
        };

        // Nothing has resolved yet, so the final flush starts the cold lookup.
        statsd.increment('buffered.before.first.lookup');
        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail on a failed lookup, got ${closeError && closeError.message}`);
          assert.ok(state.closed, 'the socket must be closed after a failed cold lookup');
          const failure = reported.find(err => err.code === 'ENOTFOUND');
          assert.ok(failure, `errorHandler should see the resolver's code, saw ${JSON.stringify(reported.map(e => e.code))}`);
          assert.strictEqual(failure.hotShotsCode, 'HOTSHOTS_DNS_LOOKUP_FAILED');
          done();
        });
      });
    });

    it('also closes a non-cacheDns client whose per-packet lookup fails during the final flush', done => {
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => setImmediate(() => {
          const err = new Error('getaddrinfo ENOTFOUND localhost');
          err.code = 'ENOTFOUND';
          callback(err);
        });
        const reported = [];
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          errorHandler: err => reported.push(err)
        }), 'client');
        const state = { closed: false };
        const realSocketClose = statsd.socket.close.bind(statsd.socket);
        statsd.socket.close = () => {
          state.closed = true;
          realSocketClose();
        };

        statsd.increment('buffered.before.lookup');
        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail on a failed lookup, got ${closeError && closeError.message}`);
          assert.ok(state.closed, 'the socket must be closed after a failed lookup');
          const failure = reported.find(err => err.code === 'ENOTFOUND');
          assert.ok(failure, `errorHandler should see the resolver's code, saw ${JSON.stringify(reported.map(e => e.code))}`);
          assert.strictEqual(failure.hotShotsCode, 'HOTSHOTS_DNS_LOOKUP_FAILED');
          done();
        });
      });
    });

    it('also closes a client whose custom udpSocketOptions.lookup fails during the final flush', done => {
      server = createServer(udpServerType, opts => {
        const reported = [];
        const statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          udpSocketOptions: {
            type: 'udp4',
            // dgram also looks up the IP-literal bind address before the
            // first send, so a realistic lookup has to answer those itself.
            lookup: (host, options, callback) => setImmediate(() => {
              if (net.isIP(host)) {
                callback(null, host, net.isIP(host));
                return;
              }
              const err = new Error('custom lookup failed');
              err.code = 'ENOTFOUND';
              callback(err);
            })
          },
          errorHandler: err => reported.push(err)
        }), 'client');
        const state = { closed: false };
        const realSocketClose = statsd.socket.close.bind(statsd.socket);
        statsd.socket.close = () => {
          state.closed = true;
          realSocketClose();
        };

        statsd.increment('buffered.before.custom.lookup');
        statsd.close(closeError => {
          assert.ok(!closeError, `close should not fail on a failed lookup, got ${closeError && closeError.message}`);
          assert.ok(state.closed, 'the socket must be closed after a failed custom lookup');
          const failure = reported.find(err => err.code === 'ENOTFOUND');
          assert.ok(failure, `errorHandler should see the lookup's code, saw ${JSON.stringify(reported.map(e => e.code))}`);
          assert.strictEqual(failure.hotShotsCode, 'HOTSHOTS_DNS_LOOKUP_FAILED');
          done();
        });
      });
    });
  });
});
