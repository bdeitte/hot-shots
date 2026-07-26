const assert = require('assert');
const constants = require('../lib/constants');
const dns = require('dns');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheDrops', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  let server;
  let statsd;

  afterEach(done => {
    dns.lookup = originalDnsLookup;
    closeAll(server, statsd, false, done);
  });

  it('drops the oldest pending send past the cap and errors its callback', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
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
      dns.lookup = (host, callback) => {
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
          assert.strictEqual(statsd.telemetry.packetsDroppedWriter, 1);
          done();
        }
      };

      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, onSent);
      }

      release();
    });
  });
});
