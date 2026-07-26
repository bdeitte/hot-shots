const assert = require('assert');
const dnsCounter = require('./helpers/dnsCounter.js');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsLookupCount', () => {
  const udpServerType = 'udp';
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
});
