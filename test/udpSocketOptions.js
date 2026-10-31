const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const dns = require('dns');
const dnsCounter = require('./helpers/dnsCounter.js');
const dgram = require('dgram');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#udpSocketOptions', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  const originalDgramCreateSocket = dgram.createSocket;
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

  it('should use custom DNS lookup function', done => {
    const resolvedHostAddress = '127.0.0.1';
    let dnsLookupCount = 0;
    const customDnsLookup = (host, options, callback) => {
      dnsLookupCount++;
      callback(undefined, resolvedHostAddress);
    };

    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      statsd = createHotShotsClient(Object.assign(opts, {
        cacheDns: true,
        udpSocketOptions: {
          type: 'udp4',
          lookup: customDnsLookup,
        },
      }), 'client');

      statsd.send('test title', {}, (error) => {
        assert.strictEqual(error, null);
      });

      clock.tick(1000);
      assert.strictEqual(dnsLookupCount, 2);
      done();
    });
  });

  it('should bypass dns.lookup when host is an IP address', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      let dnsLookupCalled = false;

      // Override dns.lookup AFTER server is created to avoid detecting server's own lookup
      dns.lookup = (...args) => {
        dnsLookupCalled = true;
        return originalDnsLookup(...args);
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: '127.0.0.1', // Use IP address instead of hostname
        udpSocketOptions: {
          type: 'udp4',
        },
      }), 'client');

      statsd.send('test', {}, (error) => {
        assert.strictEqual(error, null);
      });

      clock.tick(100);
      // dns.lookup should NOT have been called for IP addresses
      assert.strictEqual(dnsLookupCalled, false, 'dns.lookup should not be called for IP addresses');
      done();
    });
  });

  it('should bypass dns.lookup for IPv6 addresses', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      let dnsLookupCalled = false;

      // Override dns.lookup AFTER server is created to avoid detecting server's own lookup
      dns.lookup = (...args) => {
        dnsLookupCalled = true;
        return originalDnsLookup(...args);
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: '::1', // IPv6 localhost
        udpSocketOptions: {
          type: 'udp6',
        },
      }), 'client');

      statsd.send('test', {}, (error) => {
        assert.strictEqual(error, null);
      });

      clock.tick(100);
      // dns.lookup should NOT have been called for IPv6 addresses
      assert.strictEqual(dnsLookupCalled, false, 'dns.lookup should not be called for IPv6 addresses');
      done();
    });
  });

  it('should auto-detect udp6 socket type for IPv6 addresses', done => {
    let socketTypeUsed = null;

    // Override dgram.createSocket to capture the socket type
    dgram.createSocket = (options) => {
      socketTypeUsed = options.type;
      return originalDgramCreateSocket(options);
    };

    server = createServer(udpServerType, opts => {
      // Create client with IPv6 address but NO explicit socket type
      statsd = createHotShotsClient(Object.assign(opts, {
        host: '::1', // IPv6 localhost
        // Note: no udpSocketOptions.type specified - should auto-detect
      }), 'client');

      // Verify that udp6 was auto-detected
      assert.strictEqual(socketTypeUsed, 'udp6', 'should auto-detect udp6 for IPv6 address');
      done();
    });
  });

  it('should auto-detect udp4 socket type for IPv4 addresses', done => {
    let socketTypeUsed = null;

    // Override dgram.createSocket to capture the socket type
    dgram.createSocket = (options) => {
      socketTypeUsed = options.type;
      return originalDgramCreateSocket(options);
    };

    server = createServer(udpServerType, opts => {
      // Create client with IPv4 address but NO explicit socket type
      statsd = createHotShotsClient(Object.assign(opts, {
        host: '127.0.0.1', // IPv4 localhost
        // Note: no udpSocketOptions.type specified - should auto-detect
      }), 'client');

      // Verify that udp4 was auto-detected
      assert.strictEqual(socketTypeUsed, 'udp4', 'should auto-detect udp4 for IPv4 address');
      done();
    });
  });

  it('should default to udp4 for hostnames', done => {
    let socketTypeUsed = null;

    // Override dgram.createSocket to capture the socket type
    dgram.createSocket = (options) => {
      socketTypeUsed = options.type;
      return originalDgramCreateSocket(options);
    };

    server = createServer(udpServerType, opts => {
      // Create client with hostname (not an IP address)
      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        // Note: no udpSocketOptions.type specified - should default to udp4
      }), 'client');

      // Verify that udp4 is used as default for hostnames
      assert.strictEqual(socketTypeUsed, 'udp4', 'should default to udp4 for hostnames');
      done();
    });
  });

  it('should respect explicit socket type even for IPv6 addresses', done => {
    let socketTypeUsed = null;

    // Override dgram.createSocket to capture the socket type
    dgram.createSocket = (options) => {
      socketTypeUsed = options.type;
      return originalDgramCreateSocket(options);
    };

    server = createServer(udpServerType, opts => {
      // Create client with IPv6 address but explicit udp4 type (user override)
      statsd = createHotShotsClient(Object.assign(opts, {
        host: '::1', // IPv6 localhost
        udpSocketOptions: {
          type: 'udp4', // Explicit override - should be respected even though it will fail
        },
      }), 'client');

      // Verify that explicit type is respected
      assert.strictEqual(socketTypeUsed, 'udp4', 'should respect explicit socket type');
      done();
    });
  });

  describe('lookups per send', () => {
    let counter;

    afterEach(() => {
      if (counter) {
        counter.restore();
        counter = null;
      }
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

    it('performs one dns lookup for repeated cacheDns sends to a hostname', done => {
      server = createServer(udpServerType, opts => {
        counter = dnsCounter.startCounting();
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true,
          cacheDnsTtl: 60000
        }), 'client');
        // The first send warms the cache. Concurrent cold-start sends each start
        // their own lookup, so the rest go out once it has resolved.
        statsd.send('test.warm', {}, () => {
          sendN(statsd, 20, () => {
            // Previously every send also looked up the resolved address itself.
            assert.strictEqual(counter.count, 1, `expected 1 lookup, saw ${counter.hostnames}`);
            done();
          });
        });
      });
    });
  });
});
