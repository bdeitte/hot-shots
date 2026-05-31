const assert = require('assert');
const StatsD = require('../lib/statsd');

const DD_ENV_VARS = [
  'DD_AGENT_HOST', 'DD_DOGSTATSD_PORT', 'DD_ENTITY_ID', 'DD_ENV',
  'DD_SERVICE', 'DD_VERSION', 'DD_EXTERNAL_ENV', 'DD_CARDINALITY',
  'DATADOG_CARDINALITY', 'DD_ORIGIN_DETECTION_ENABLED',
];

const clearDDEnv = () => {
  DD_ENV_VARS.forEach(name => delete process.env[name]);
};

describe('#datadogMode resolution', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  it('defaults datadog off with no signals (udp)', () => {
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.datadog, false);
    client.close(() => { /* close callback */ });
  });

  it('auto-enables when a DD_ env signal is present', () => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.datadog, true);
    client.close(() => { /* close callback */ });
  });

  it('honors explicit datadog:true', () => {
    const client = new StatsD({ mock: true, datadog: true });
    assert.strictEqual(client.datadog, true);
    client.close(() => { /* close callback */ });
  });

  it('honors explicit datadog:false even with signals', () => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({ mock: true, datadog: false });
    assert.strictEqual(client.datadog, false);
    client.close(() => { /* close callback */ });
  });

  it('telegraf wins over explicit datadog:true', () => {
    const client = new StatsD({ mock: true, telegraf: true, datadog: true });
    assert.strictEqual(client.datadog, false);
    client.close(() => { /* close callback */ });
  });

  it('auto-detect stays off when telegraf:true even with DD signals', () => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({ mock: true, telegraf: true });
    assert.strictEqual(client.datadog, false);
    client.close(() => { /* close callback */ });
  });

  it('sets containerID from explicit option in datadog mode', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'abc123' });
    assert.strictEqual(client.containerID, 'abc123');
    client.close(() => { /* close callback */ });
  });

  it('reads external data and cardinality in datadog mode', () => {
    process.env.DD_EXTERNAL_ENV = 'it-false,cn-foo';
    process.env.DD_CARDINALITY = 'low';
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.externalData, 'it-false,cn-foo');
    assert.strictEqual(client.cardinality, 'low');
    client.close(() => { /* close callback */ });
  });

  it('does not set fields when datadog mode is off', () => {
    const client = new StatsD({ mock: true, containerID: 'abc123' });
    assert.strictEqual(client.datadog, false);
    assert.strictEqual(client.containerID, undefined);
    client.close(() => { /* close callback */ });
  });
});

describe('#datadogMode metric wire output', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  const lastMessage = (client) => {
    return client.mockBuffer[client.mockBuffer.length - 1];
  };

  it('appends |c: and |e: to metrics in datadog mode', () => {
    const client = new StatsD({
      mock: true, datadog: true, containerID: 'cid123',
    });
    process.env.DD_EXTERNAL_ENV = 'it-false';
    // externalData was read at construction; set explicitly for determinism:
    client.externalData = 'it-false';
    client.increment('test');
    assert.strictEqual(lastMessage(client), 'test:1|c|c:cid123|e:it-false');
    client.close(() => { /* close callback */ });
  });

  it('appends client-default |card:', () => {
    const client = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    client.gauge('g', 5);
    assert.strictEqual(lastMessage(client), 'g:5|g|card:low');
    client.close(() => { /* close callback */ });
  });

  it('per-call cardinality overrides the client default', () => {
    const client = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    client.gauge('g', 5, { cardinality: 'high' });
    assert.strictEqual(lastMessage(client), 'g:5|g|card:high');
    client.close(() => { /* close callback */ });
  });

  it('adds no extension fields when datadog mode is off', () => {
    const client = new StatsD({ mock: true, containerID: 'cid123' });
    client.increment('test');
    assert.strictEqual(lastMessage(client), 'test:1|c');
    client.close(() => { /* close callback */ });
  });

  it('places extension fields after tags', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.increment('test', 1, ['a:b']);
    assert.strictEqual(lastMessage(client), 'test:1|c|#a:b|c:cid123');
    client.close(() => { /* close callback */ });
  });
});
