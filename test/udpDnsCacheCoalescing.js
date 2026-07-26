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
      let release;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          // Warm-up lookup resolves immediately.
          callback(null, '127.0.0.1');
          return;
        }
        // The refresh lookup is held open so three concurrent stale sends can
        // be issued while it is still in flight, proving they share it rather
        // than each completing before the next is issued.
        release = () => callback(null, '127.0.0.1');
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

      assert.strictEqual(lookupCount, 2, 'concurrent stale sends must share one in-flight refresh');
      release();
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

  it('backs off for a full TTL after a failed refresh instead of retrying every send', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          // Warm the cache with one successful lookup.
          callback(null, '1.1.1.1');
          return;
        }
        // Every refresh after that fails, like a fast-failing resolver
        // (cached NXDOMAIN, SERVFAIL).
        callback(new Error('always fails'));
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl,
        // eslint-disable-next-line no-empty-function
        errorHandler: () => {}
      }), 'client');

      statsd.send('warm', {}, error => assert.strictEqual(error, null));
      clock.tick(1);
      assert.strictEqual(lookupCount, 1);

      clock.tick(cacheDnsTtl + 50);

      // Several sends immediately after the TTL expires must share the one
      // failed refresh, not each trigger their own lookup.
      // eslint-disable-next-line no-empty-function
      statsd.send('a', {}, () => {});
      // eslint-disable-next-line no-empty-function
      statsd.send('b', {}, () => {});
      // eslint-disable-next-line no-empty-function
      statsd.send('c', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 2, 'failed refresh should cool down, not retry per send');

      // Still within the cooldown TTL: no further lookups.
      clock.tick(cacheDnsTtl / 2);
      // eslint-disable-next-line no-empty-function
      statsd.send('d', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 2, 'no additional lookup before the cooldown TTL elapses');

      // Past the cooldown TTL: exactly one more attempt.
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('e', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 3, 'cooldown should allow exactly one more attempt per TTL');
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

  it('backs off for a full TTL after a synchronous-throw refresh, on a warm cache', done => {
    server = createServer(udpServerType, opts => {
      clock = sinon.useFakeTimers();
      const cacheDnsTtl = 100;
      let lookupCount = 0;
      dns.lookup = (host, callback) => {
        lookupCount++;
        if (lookupCount === 1) {
          // Warm the cache with one successful lookup.
          callback(null, '1.1.1.1');
          return;
        }
        if (lookupCount === 2) {
          // The refresh triggered once the cache goes stale throws
          // synchronously instead of calling back, like an invalid-argument
          // dns.lookup failure.
          throw new Error('ERR_INVALID_ARG_TYPE: host must be a string');
        }
        callback(null, '1.1.1.1');
      };

      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: cacheDnsTtl,
        // eslint-disable-next-line no-empty-function
        errorHandler: () => {}
      }), 'client');

      // eslint-disable-next-line no-empty-function
      statsd.send('warm', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 1);

      // Past the TTL: the send goes out on the stale address and triggers a
      // background refresh, which throws synchronously.
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('a', {}, () => {});
      assert.strictEqual(lookupCount, 2, 'stale send should trigger exactly one refresh attempt');

      // Still within the cooldown TTL earned by the synchronous-throw catch
      // block: no further lookups.
      clock.tick(cacheDnsTtl / 2);
      // eslint-disable-next-line no-empty-function
      statsd.send('b', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 2,
        'no additional lookup before the cooldown TTL elapses after a synchronous throw');

      // Past the cooldown TTL: exactly one more attempt.
      clock.tick(cacheDnsTtl + 50);
      // eslint-disable-next-line no-empty-function
      statsd.send('c', {}, () => {});
      clock.tick(1);
      assert.strictEqual(lookupCount, 3, 'cooldown should allow exactly one more attempt per TTL');
      done();
    });
  });

  it('calls back every queued send exactly once when dns.lookup throws synchronously', done => {
    server = createServer(udpServerType, opts => {
      dns.lookup = () => {
        // Some inputs (e.g. a non-string host) make dns.lookup throw synchronously
        // instead of invoking its callback.
        throw new Error('ERR_INVALID_ARG_TYPE: host must be a string');
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
          assert.strictEqual(statsd.messagesInFlight, 0,
            'messagesInFlight should drain back to 0 after every queued send is called back');
          done();
        }
      };
      for (let i = 0; i < 10; i++) {
        statsd.send(`test.${i}`, {}, onSendFailed);
      }
    });
  });
});
