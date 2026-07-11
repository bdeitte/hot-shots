const assert = require('assert');
const createHotShotsClient = require('./helpers/helpers.js').createHotShotsClient;

describe('#useDefaultRoute with DD env transport', () => {
  const origSocket = process.env.DD_DOGSTATSD_SOCKET;
  afterEach(() => {
    if (origSocket === undefined) {
      delete process.env.DD_DOGSTATSD_SOCKET;
    } else {
      process.env.DD_DOGSTATSD_SOCKET = origSocket;
    }
  });

  it('should stay a UDP client when useDefaultRoute is set even if DD_DOGSTATSD_SOCKET is present', () => {
    process.env.DD_DOGSTATSD_SOCKET = '/tmp/dsd.sock';
    const statsd = createHotShotsClient({ useDefaultRoute: true, mock: true }, 'client');
    assert.strictEqual(statsd.protocol, 'udp');
    assert.strictEqual(statsd.path, undefined);
  });
});
