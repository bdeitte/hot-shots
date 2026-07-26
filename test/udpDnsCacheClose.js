const assert = require('assert');
const constants = require('../lib/constants');
const dns = require('dns');
const helpers = require('./helpers/helpers.js');

const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheClose', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  let server;

  afterEach(done => {
    dns.lookup = originalDnsLookup;
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
      const originalConsoleError = console.error;
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

  it('completes close in buffered mode when the final flush lookup is stuck', done => {
    server = createServer(udpServerType, opts => {
      // Never invoke the callback: the lookup stays in flight forever.
      // eslint-disable-next-line no-empty-function
      dns.lookup = () => {};

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
    });
  });

  it('delivers the buffered final flush when the lookup resolves in time', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
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
      dns.lookup = (host, callback) => {
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
});
