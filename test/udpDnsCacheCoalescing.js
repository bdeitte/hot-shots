const assert = require('assert');
const dns = require('dns');
const helpers = require('./helpers/helpers.js');
const sinon = require('sinon');

const closeAll = helpers.closeAll;
const createHotShotsClient = helpers.createHotShotsClient;
const createServer = helpers.createServer;

describe('#udpDnsCacheCoalescing', () => {
  const udpServerType = 'udp';
  const originalDnsLookup = dns.lookup;
  let server;
  let statsd;
  let clock;

  afterEach(done => {
    if (clock) {
      clock.restore();
      clock = null;
    }
    dns.lookup = originalDnsLookup;
    closeAll(server, statsd, false, done);
  });

  it('coalesces concurrent cold-start sends into one lookup', done => {
    server = createServer(udpServerType, opts => {
      let lookupCount = 0;
      let release;
      dns.lookup = (host, callback) => {
        lookupCount++;
        release = () => callback(null, '127.0.0.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const state = { completed: 0 };
      /**
       * Callback shared by every coalesced send, tracking completion count via
       * the closed-over state object rather than a per-iteration function.
       * @param {Error|null} error - send error, expected null
       * @returns {void}
       */
      const onSendComplete = error => {
        assert.strictEqual(error, null);
        state.completed++;
        if (state.completed === 50) {
          assert.strictEqual(lookupCount, 1, 'concurrent cold-start sends must share one lookup');
          done();
        }
      };
      for (let i = 0; i < 50; i++) {
        statsd.send(`test.${i}`, {}, onSendComplete);
      }

      assert.strictEqual(lookupCount, 1, 'only one lookup should be in flight');
      release();
    });
  });

  it('serves the stale address and refreshes once in the background', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      dns.lookup = (host, callback) => {
        lookupCount++;
        callback(null, '127.0.0.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl
      }), 'client');

      statsd.send('first', {}, error => assert.strictEqual(error, null));
      clock.tick(1);
      assert.strictEqual(lookupCount, 1);

      clock.tick(cacheDnsTtl + 50);

      // Three concurrent stale sends must trigger exactly one refresh, not three.
      statsd.send('a', {}, error => assert.strictEqual(error, null));
      statsd.send('b', {}, error => assert.strictEqual(error, null));
      statsd.send('c', {}, error => assert.strictEqual(error, null));

      clock.tick(1);
      assert.strictEqual(lookupCount, 2, 'concurrent stale sends must share one refresh');
      done();
    });
  });

  it('keeps serving the stale address when a refresh fails', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          callback(null, '1.1.1.1');
          return;
        }
        callback(new Error('refresh boom'));
      };

      const errors = [];
      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl,
        errorHandler: err => errors.push(err)
      }), 'client');

      statsd.send('first', {}, error => assert.strictEqual(error, null));
      clock.tick(1);

      clock.tick(cacheDnsTtl + 50);
      statsd.send('second', {}, error => {
        // The send itself succeeds on the stale address.
        assert.strictEqual(error, null);
      });
      clock.tick(1);

      assert.strictEqual(errors.length, 1, 'refresh failure should reach errorHandler once');
      assert.ok(errors[0].message.includes('refresh boom'));
      done();
    });
  });

  it('reports a refresh failure once per streak and re-arms after a success', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      let failing = true;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          callback(null, '1.1.1.1');
          return;
        }
        if (failing) {
          callback(new Error('still down'));
          return;
        }
        callback(null, '1.1.1.1');
      };

      const errors = [];
      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl,
        errorHandler: err => errors.push(err)
      }), 'client');

      // eslint-disable-next-line no-empty-function
      statsd.send('warm', {}, () => {});
      clock.tick(1);

      // Three consecutive failed refreshes should report only once.
      for (let i = 0; i < 3; i++) {
        clock.tick(cacheDnsTtl + 50);
        // eslint-disable-next-line no-empty-function
        statsd.send(`fail.${i}`, {}, () => {});
        clock.tick(1);
      }
      assert.strictEqual(errors.length, 1, 'streak should report once');

      // A success clears the streak.
      failing = false;
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('recover', {}, () => {});
      clock.tick(1);

      // The next failure streak reports again.
      failing = true;
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('fail-again', {}, () => {});
      clock.tick(1);
      assert.strictEqual(errors.length, 2, 'streak should re-arm after a success');
      done();
    });
  });

  it('falls back to console.error when no error listener is attached', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          callback(null, '1.1.1.1');
          return;
        }
        callback(new Error('refresh boom'));
      };

      const logged = [];
      const originalConsoleError = console.error;
      console.error = msg => logged.push(msg);

      // No errorHandler, so the only 'error' listener is the transport default.
      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl
      }), 'client');

      // eslint-disable-next-line no-empty-function
      statsd.send('warm', {}, () => {});
      clock.tick(1);
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('second', {}, () => {});
      clock.tick(1);

      console.error = originalConsoleError;
      assert.strictEqual(logged.length, 1, `expected one console.error, saw ${logged.length}`);
      assert.ok(logged[0].includes('DNS refresh for localhost failed'));
      done();
    });
  });

  it('sends on the resolved address with the correct family', done => {
    server = createServer(udpServerType, opts => {
      dns.lookup = (host, callback) => {
        // Resolve to an address that differs from args.host, which is the case
        // the old fixed-ipVersion bypass got wrong.
        callback(null, '127.0.0.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'resolved.metric');
        done();
      });

      statsd.send('resolved.metric', {}, error => {
        assert.strictEqual(error, null);
      });
    });
  });

  it('fails every queued send when the cold-start lookup fails', done => {
    server = createServer(udpServerType, opts => {
      let release;
      dns.lookup = (host, callback) => {
        release = () => callback(new Error('cold boom'));
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true
      }), 'client');

      const state = { failed: 0 };
      /**
       * Callback shared by every queued send, tracking failure count via the
       * closed-over state object rather than a per-iteration function.
       * @param {Error|null} error - the lookup error propagated to the send
       * @returns {void}
       */
      const onSendFailed = error => {
        assert.ok(error, 'queued send should receive the lookup error');
        state.failed++;
        if (state.failed === 10) {
          done();
        }
      };
      for (let i = 0; i < 10; i++) {
        statsd.send(`test.${i}`, {}, onSendFailed);
      }
      release();
    });
  });
});
