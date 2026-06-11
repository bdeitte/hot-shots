const assert = require('assert');
const StatsD = require('../lib/statsd');
const constants = require('../lib/constants');
const helpers = require('./helpers/helpers.js');
const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

// Derive the signal vars from constants so the cleanup list stays in sync as new
// Datadog signal env vars are added, plus a couple of related vars not in that list.
const DD_ENV_VARS = constants.DATADOG_SIGNAL_ENV_VARS.concat([
  'DATADOG_CARDINALITY', 'DD_ORIGIN_DETECTION_ENABLED',
]);

let savedEnv = {};

// Save originals then clear, so detection tests are deterministic regardless of
// the host environment. restoreDDEnv puts the originals back in afterEach.
const clearDDEnv = () => {
  savedEnv = {};
  DD_ENV_VARS.forEach(name => {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  });
};

const restoreDDEnv = () => {
  DD_ENV_VARS.forEach(name => {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  });
};

describe('#datadogMode resolution', () => {
  beforeEach(clearDDEnv);
  afterEach(restoreDDEnv);

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

  it('does not auto-enable from the uds protocol alone', () => {
    const client = new StatsD({ mock: true, protocol: 'uds' });
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

  it('falls back to DATADOG_CARDINALITY when DD_CARDINALITY is absent', () => {
    process.env.DATADOG_CARDINALITY = 'high';
    const client = new StatsD({ mock: true, datadog: true });
    assert.strictEqual(client.cardinality, 'high');
    client.close(() => { /* close callback */ });
  });

  it('does not set fields when datadog mode is off', () => {
    const client = new StatsD({ mock: true, containerID: 'abc123' });
    assert.strictEqual(client.datadog, false);
    assert.strictEqual(client.containerID, undefined);
    client.close(() => { /* close callback */ });
  });

  it('disables origin detection via originDetection:false', () => {
    const client = new StatsD({ mock: true, datadog: true, originDetection: false });
    assert.strictEqual(client.datadog, true);
    assert.strictEqual(client.originDetection, false);
    client.close(() => { /* close callback */ });
  });

  it('disables origin detection via DD_ORIGIN_DETECTION_ENABLED falsey value', () => {
    process.env.DD_ORIGIN_DETECTION_ENABLED = 'false';
    const client = new StatsD({ mock: true, datadog: true });
    assert.strictEqual(client.datadog, true);
    assert.strictEqual(client.originDetection, false);
    client.close(() => { /* close callback */ });
  });
});

describe('#datadogMode metric wire output', () => {
  beforeEach(clearDDEnv);
  afterEach(restoreDDEnv);

  const lastMessage = (client) => {
    return client.mockBuffer[client.mockBuffer.length - 1];
  };

  it('appends |c: and |e: to metrics in datadog mode', () => {
    // Set DD_EXTERNAL_ENV before construction so externalData is read naturally.
    process.env.DD_EXTERNAL_ENV = 'it-false';
    const client = new StatsD({
      mock: true, datadog: true, containerID: 'cid123',
    });
    client.increment('test');
    assert.strictEqual(lastMessage(client), 'test:1|c|c:cid123|e:it-false');
    client.close(() => { /* close callback */ });
  });

  it('appends client-default |card:', () => {
    // Disable origin detection so a host container id (e.g. CI cgroups) does not
    // append a |c: field and pollute the wire output this test asserts on.
    const client = new StatsD({ mock: true, datadog: true, originDetection: false, cardinality: 'low' });
    client.gauge('g', 5);
    assert.strictEqual(lastMessage(client), 'g:5|g|card:low');
    client.close(() => { /* close callback */ });
  });

  it('per-call cardinality overrides the client default', () => {
    const client = new StatsD({ mock: true, datadog: true, originDetection: false, cardinality: 'low' });
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

describe('#datadogMode event/check wire output', () => {
  beforeEach(clearDDEnv);
  afterEach(restoreDDEnv);

  const lastMessage = (client) => {
    return client.mockBuffer[client.mockBuffer.length - 1];
  };

  it('appends |c: and |card: to events', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.event('title', 'text', { cardinality: 'low' });
    const msg = lastMessage(client);
    assert.ok(msg.indexOf('|c:cid123') !== -1, msg);
    assert.ok(msg.indexOf('|card:low') !== -1, msg);
    client.close(() => { /* close callback */ });
  });

  it('appends |c: to service checks before the message field', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.check('svc', 0, { message: 'all good' });
    const msg = lastMessage(client);
    assert.ok(msg.indexOf('|c:cid123') !== -1, msg);
    // container id must come before the trailing m: field
    assert.ok(msg.indexOf('|c:cid123') < msg.indexOf('|m:all good'), msg);
    client.close(() => { /* close callback */ });
  });

  it('check supports per-call cardinality', () => {
    const client = new StatsD({ mock: true, datadog: true });
    client.check('svc', 0, { cardinality: 'high' });
    assert.ok(lastMessage(client).indexOf('|card:high') !== -1);
    client.close(() => { /* close callback */ });
  });
});

describe('#datadogMode child inheritance', () => {
  beforeEach(clearDDEnv);
  afterEach(restoreDDEnv);

  it('child inherits datadog mode and container id', () => {
    const parent = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    const child = parent.childClient({});
    assert.strictEqual(child.datadog, true);
    assert.strictEqual(child.containerID, 'cid123');
    child.increment('c');
    assert.strictEqual(child.mockBuffer[child.mockBuffer.length - 1], 'c:1|c|c:cid123');
    parent.close(() => { /* close callback */ });
  });

  it('child can override cardinality default', () => {
    const parent = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    const child = parent.childClient({ cardinality: 'high' });
    assert.strictEqual(child.cardinality, 'high');
    parent.close(() => { /* close callback */ });
  });
});

describe('#datadogMode real-transport ordering (udp)', () => {
  let server;
  let statsd;
  beforeEach(clearDDEnv);
  afterEach(done => {
    closeAll(server, statsd, false, () => { restoreDDEnv(); done(); });
  });

  it('emits |#tags then |c: over udp', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        datadog: true, containerID: 'cid123', includeDatadogTelemetry: false,
      }), 'client');
      statsd.increment('test', 1, ['a:b']);
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'test:1|c|#a:b|c:cid123');
      done();
    });
  });
});

describe('#datadogMode telemetry default', () => {
  beforeEach(clearDDEnv);
  afterEach(restoreDDEnv);

  // These use real (non-mock) clients because mock mode always disables telemetry;
  // each client is closed in its assertion's callback.

  it('explicit datadog:true defaults telemetry on', done => {
    const client = new StatsD({ datadog: true });
    assert.strictEqual(client.includeDatadogTelemetry, true);
    client.close(() => done());
  });

  it('a DD_* env signal defaults telemetry on', done => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({});
    assert.strictEqual(client.datadog, true);
    assert.strictEqual(client.includeDatadogTelemetry, true);
    client.close(() => done());
  });

  it('bare uds (no DD env, no explicit datadog) keeps datadog mode and telemetry off', done => {
    if (process.platform === 'win32') {
      return done();
    }
    const client = new StatsD({ protocol: 'uds', path: '/tmp/hot-shots-telemetry-default.sock' });
    assert.strictEqual(client.datadog, false);
    assert.strictEqual(client.includeDatadogTelemetry, false);
    client.close(() => done());
  });

  it('includeDatadogTelemetry:false opts out even with datadog:true', done => {
    const client = new StatsD({ datadog: true, includeDatadogTelemetry: false });
    assert.strictEqual(client.includeDatadogTelemetry, false);
    client.close(() => done());
  });

  it('no Datadog signal (plain udp) keeps telemetry off', done => {
    const client = new StatsD({});
    assert.strictEqual(client.datadog, false);
    assert.strictEqual(client.includeDatadogTelemetry, false);
    client.close(() => done());
  });
});
