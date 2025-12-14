const assert = require('assert');
const helpers = require('./helpers/helpers.js');
const dns = require('dns');
const dgram = require('dgram');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#udpSocketOptions', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  const originalDgramCreateSocket = dgram.createSocket;
  let server;
  let statsd;

  afterEach(done => {
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
      statsd = createHotShotsClient(Object.assign(opts, {
        cacheDns: true,
        udpSocketOptions: {
          type: 'udp4',
          lookup: customDnsLookup,
        },
      }), 'client');

      statsd.send('test title', {}, (error) => {
        assert.strictEqual(error, null);
        setTimeout(() => {
          assert.strictEqual(dnsLookupCount, 2);
          done();
        }, 1000);
      });
    });
  });

  it('should bypass dns.lookup when host is an IP address', done => {
    server = createServer(udpServerType, opts => {
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
        setTimeout(() => {
          // dns.lookup should NOT have been called for IP addresses
          assert.strictEqual(dnsLookupCalled, false, 'dns.lookup should not be called for IP addresses');
          done();
        }, 100);
      });
    });
  });

  it('should bypass dns.lookup for IPv6 addresses', done => {
    server = createServer(udpServerType, opts => {
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
        setTimeout(() => {
          // dns.lookup should NOT have been called for IPv6 addresses
          assert.strictEqual(dnsLookupCalled, false, 'dns.lookup should not be called for IPv6 addresses');
          done();
        }, 100);
      });
    });
  });
});
