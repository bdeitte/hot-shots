const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const dns = require('dns');
const dgram = require('dgram');
const net = require('net');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

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

describe('#udpDnsCacheTransport', () => {
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
          callback = typeof options === 'function' ? options : callback;
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
          callback = typeof options === 'function' ? options : callback;
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
          callback = typeof options === 'function' ? options : callback;
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
          callback = typeof options === 'function' ? options : callback;
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

  describe('No host', () => {
    // DD_AGENT_HOST would otherwise become the client's host
    let originalAgentHost;

    beforeEach(() => {
      originalAgentHost = process.env.DD_AGENT_HOST;
      delete process.env.DD_AGENT_HOST;
    });

    afterEach(() => {
      if (originalAgentHost !== undefined) {
        process.env.DD_AGENT_HOST = originalAgentHost;
      }
    });

    // Node 26 rejects dns.lookup(undefined), so a lookup here fails every send
    it('should skip DNS lookup and let dgram pick the default address', done => {
      server = createServer(udpServerType, opts => {
        clock = sinon.useFakeTimers();
        const socketMock = mockDgramSocket();

        statsd = createHotShotsClient(Object.assign(opts, {
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
        assert.strictEqual(socketMock.host, undefined);
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
          callback = typeof options === 'function' ? options : callback;
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

        statsd.send('second', {}, (error) => {
          assert.strictEqual(error, null);
        });

        clock.tick(1);
        assert.strictEqual(socketMock.host, '2.2.2.2');
        done();
      });
    });
  });

  describe('Address family', () => {
    it('pins the lookup to family 4 for a udp4 socket', done => {
      server = createServer(udpServerType, opts => {
        let seenOptions = null;
        dns.lookup = (host, options, callback) => {
          seenOptions = options;
          callback(null, '127.0.0.1');
        };

        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');

        server.on('metrics', metrics => {
          assert.strictEqual(metrics, 'resolved.metric');
          // Unpinned, getaddrinfo can answer a udp4 socket with an AAAA record
          // and every send fails with EINVAL.
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
      // No server: the lookup argument is what is under test.
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
      // An unpinned lookup gets ::1 here, which a udp4 socket cannot send to, so
      // this fails with EINVAL and delivers nothing unless the family pin is
      // applied.
      server = createServer(udpServerType, opts => {
        dns.lookup = (host, options, callback) => {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          // Like the real dns.lookup, an IP literal resolves to itself.
          if (net.isIP(host)) {
            return callback(null, host, net.isIP(host));
          }
          const family = typeof options === 'object' ? options.family : options;
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
  });
});
