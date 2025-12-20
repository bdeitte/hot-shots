const assert = require('assert');
const dns = require('dns');

const StatsD = require('../lib/statsd');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#init', () => {
  let server;
  let statsd;
  let skipClose = false;
  const clientType = 'client';

  afterEach(done => {
    if (skipClose) {
      done();
    }
    else {
      closeAll(server, statsd, false, done);
    }
    server = null;
    statsd = null;
    global.statsd = undefined;
    skipClose = false;
    delete process.env.DD_AGENT_HOST;
    delete process.env.DD_DOGSTATSD_PORT;
    delete process.env.DD_ENTITY_ID;
    delete process.env.DD_ENV;
    delete process.env.DD_SERVICE;
    delete process.env.DD_VERSION;
  });

  it('should set the proper values when specified', () => {
    // cachedDns isn't tested here, hence the null
    statsd = createHotShotsClient(
      ['host', 1234, 'prefix', 'suffix', true, null, true, ['gtag'], 0, 60, false, 0.5, 'udp'],
      clientType
    );

    assert.strictEqual(statsd.host, 'host');
    assert.strictEqual(statsd.port, 1234);
    assert.strictEqual(statsd.prefix, 'prefix');
    assert.strictEqual(statsd.suffix, 'suffix');
    assert.strictEqual(statsd, global.statsd);
    assert.strictEqual(statsd.mock, true);
    assert.deepStrictEqual(statsd.globalTags, ['gtag']);
    assert.strictEqual(statsd.maxBufferSize, 0);
    assert.strictEqual(statsd.bufferFlushInterval, 60);
    assert.strictEqual(statsd.telegraf, false);
    assert.strictEqual(statsd.sampleRate, 0.5);
    assert.strictEqual(statsd.protocol, 'udp');
  });

  it('should set the proper values with options hash format', () => {
    // Don't do DNS lookup for this test
    const originalLookup = dns.lookup;
    dns.lookup = () => {}; // eslint-disable-line no-empty-function

    // cachedDns isn't tested here, hence the null
    statsd = createHotShotsClient({
      host: 'host',
      port: 1234,
      prefix: 'prefix',
      suffix: 'suffix',
      globalize: true,
      mock: true,
      globalTags: ['gtag'],
      sampleRate: 0.6,
      maxBufferSize: 0,
      bufferFlushInterval: 60,
      telegraf: false,
      protocol: 'tcp'
    }, clientType);

    assert.strictEqual(statsd.host, 'host');
    assert.strictEqual(statsd.port, 1234);
    assert.strictEqual(statsd.prefix, 'prefix');
    assert.strictEqual(statsd.suffix, 'suffix');
    assert.strictEqual(statsd, global.statsd);
    assert.strictEqual(statsd.mock, true);
    assert.strictEqual(statsd.sampleRate, 0.6);
    assert.deepStrictEqual(statsd.globalTags, ['gtag']);
    assert.strictEqual(statsd.maxBufferSize, 0);
    assert.strictEqual(statsd.bufferFlushInterval, 60);
    assert.deepStrictEqual(statsd.telegraf, false);
    assert.strictEqual(statsd.protocol, 'tcp');

    dns.lookup = originalLookup;
  });

  it('should get host and port values from env vars when not specified', () => {
    // set the DD_AGENT_HOST and DD_DOGSTATSD_PORT env vars
    process.env.DD_AGENT_HOST = 'envhost';
    process.env.DD_DOGSTATSD_PORT = '1234';

    statsd = createHotShotsClient({}, clientType);
    assert.strictEqual(statsd.host, 'envhost');
    assert.strictEqual(statsd.port, 1234);
    assert.strictEqual(statsd.prefix, '');
    assert.strictEqual(statsd.suffix, '');
    assert.strictEqual(global.statsd, undefined);
    assert.strictEqual(statsd.mock, undefined);
    assert.deepStrictEqual(statsd.globalTags, []);
    assert.ok(!statsd.mock);
    assert.strictEqual(statsd.sampleRate, 1);
    assert.strictEqual(statsd.maxBufferSize, 0);
    assert.strictEqual(statsd.bufferFlushInterval, 1000);
    assert.strictEqual(statsd.telegraf, false);
    assert.strictEqual(statsd.protocol, 'udp');
  });

  it('should treat empty DD_AGENT_HOST as undefined for default host behavior', () => {
    // set DD_AGENT_HOST to empty string (problematic case from issue #260)
    process.env.DD_AGENT_HOST = '';

    statsd = createHotShotsClient({}, clientType);
    assert.strictEqual(statsd.host, undefined);
    assert.strictEqual(statsd.port, 8125);
  });

  it('should warn and cap maxBufferSize for UDS protocol when exceeding 8192 bytes', () => {
    let warningCalled = false;
    const originalWarn = console.warn;
    console.warn = (message) => {
      if (message.includes('maxBufferSize') && message.includes('8192') && message.includes('UDS')) {
        warningCalled = true;
      }
    };

    try {
      statsd = createHotShotsClient({
        maxBufferSize: 10000,
        protocol: 'uds',
        mock: true
      }, clientType);

      assert.strictEqual(warningCalled, true);
      assert.strictEqual(statsd.maxBufferSize, 8192);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('should allow maxBufferSize > 8192 for non-UDS protocols', () => {
    let warningCalled = false;
    const originalWarn = console.warn;
    console.warn = (message) => {
      if (message.includes('maxBufferSize') && message.includes('8192')) {
        warningCalled = true;
      }
    };

    try {
      statsd = createHotShotsClient({
        maxBufferSize: 10000,
        protocol: 'udp',
        mock: true
      }, clientType);

      assert.strictEqual(warningCalled, false);
      assert.strictEqual(statsd.maxBufferSize, 10000);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('should set default values when not specified', () => {
    statsd = createHotShotsClient({}, clientType);
    assert.strictEqual(statsd.host, undefined);
    assert.strictEqual(statsd.port, 8125);
    assert.strictEqual(statsd.prefix, '');
    assert.strictEqual(statsd.suffix, '');
    assert.strictEqual(global.statsd, undefined);
    assert.strictEqual(statsd.mock, undefined);
    assert.deepStrictEqual(statsd.globalTags, []);
    assert.ok(!statsd.mock);
    assert.strictEqual(statsd.sampleRate, 1);
    assert.strictEqual(statsd.maxBufferSize, 0);
    assert.strictEqual(statsd.bufferFlushInterval, 1000);
    assert.strictEqual(statsd.telegraf, false);
    assert.strictEqual(statsd.protocol, 'udp');
  });

  it('should map global_tags to globalTags for backwards compatibility', () => {
    statsd = createHotShotsClient({ global_tags: ['gtag'] }, clientType);
    assert.deepStrictEqual(statsd.globalTags, ['gtag']);
  });

  it('should get global tags from DD_ prefixed env vars', () => {
    // set DD_ prefixed env vars
    process.env.DD_ENTITY_ID = '04652bb7-19b7-11e9-9cc6-42010a9c016d';
    process.env.DD_ENV = 'test';
    process.env.DD_SERVICE = 'test-service';
    process.env.DD_VERSION = '1.0.0';

    statsd = createHotShotsClient({}, clientType);
    assert.deepStrictEqual(statsd.globalTags, [
      'dd.internal.entity_id:04652bb7-19b7-11e9-9cc6-42010a9c016d',
      'env:test',
      'service:test-service',
      'version:1.0.0'
    ]);
  });

  it('should get global tag from DD_ prefixed env vars and append them to existing tags', () => {
    // set DD_ prefixed env vars
    process.env.DD_ENTITY_ID = '04652bb7-19b7-11e9-9cc6-42010a9c016d';
    process.env.DD_ENV = 'test';
    process.env.DD_SERVICE = 'test-service';
    process.env.DD_VERSION = '1.0.0';

    statsd = createHotShotsClient({ globalTags: ['gtag'] }, clientType);
    assert.deepStrictEqual(statsd.globalTags, [
      'gtag',
      'dd.internal.entity_id:04652bb7-19b7-11e9-9cc6-42010a9c016d',
      'env:test',
      'service:test-service',
      'version:1.0.0'
    ]);
  });

  it('should not lookup a dns record if dnsCache is not specified', done => {
    const originalLookup = dns.lookup;

    // Replace the dns lookup function with our mock dns lookup
    dns.lookup = () => {
      assert.ok(false, 'StatsD constructor should not invoke dns.lookup when dnsCache is unspecified');
      dns.lookup = originalLookup;
    };

    statsd = createHotShotsClient({ host: 'test' }, clientType);
    process.nextTick(() => {
      dns.lookup = originalLookup;
      done();
    });
  });

  it('should given an error in callbacks for a bad dns record if dnsCache is specified', done => {
    const originalLookup = dns.lookup;

    // Replace the dns lookup function with our mock dns lookup
    dns.lookup = (host, callback) => {
      return callback(new Error('Bad host'));
    };

    statsd = createHotShotsClient({ host: 'test', cacheDns: true }, clientType);

    statsd.increment('test', 1, 1, null, err => {
      assert.strictEqual(err.message, 'Error sending hot-shots message: Error: Bad host');
      dns.lookup = originalLookup;
      done();
    });
  });

  it('should create a global variable set to StatsD() when specified', () => {
    statsd = createHotShotsClient(['host', 1234, 'prefix', 'suffix', true], clientType);
    assert.ok(global.statsd instanceof StatsD);
  });

  it('should not create a global variable when not specified', () => {
    statsd = createHotShotsClient(['host', 1234, 'prefix', 'suffix'], clientType);
    assert.strictEqual(global.statsd, undefined);
  });

  it('should create a mock Client when mock variable is specified', () => {
    statsd = createHotShotsClient(['host', 1234, 'prefix', 'suffix', false, false, true], clientType);
    assert.ok(statsd.mock);
  });

  it('should create a mock transport when mock mode is enabled', () => {
    statsd = createHotShotsClient({ mock: true }, clientType);
    assert.ok(statsd.mock);
    assert.ok(statsd.socket);
    assert.strictEqual(statsd.socket.type, 'mock');
    assert.strictEqual(typeof statsd.socket.send, 'function');
    assert.strictEqual(typeof statsd.socket.close, 'function');
  });

  it('should create a socket variable that is an instance of dgram.Socket', () => {
    statsd = createHotShotsClient({}, clientType);
    assert.strictEqual(statsd.socket.type, 'udp');
    skipClose = true;
  });

  it('should set the closingFlushInterval option with the provided value', () => {
    statsd = createHotShotsClient({
      closingFlushInterval: 10
    }, clientType);
    assert.strictEqual(statsd.closingFlushInterval, 10);
  });

  it('should set the closingFlushInterval option with the default value', () => {
    statsd = createHotShotsClient({}, clientType);
    assert.strictEqual(statsd.closingFlushInterval, 50);
  });

  it('should create a socket variable that is an instance of net.Socket if set to TCP', done => {
    server = createServer('tcp', opts => {
      statsd = createHotShotsClient(opts, clientType);
      assert.strictEqual(statsd.socket.type, 'tcp');
      done();
    });
  });
});
