# Per-Packet DNS Lookup Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the hot-shots UDP transport from performing a `dns.lookup` on every packet, and make `cacheDns` actually reduce lookups.

**Architecture:** Two changes in `lib/transport.js`. First, the socket's bypass `lookup` becomes always-installed and decides per call via `net.isIP(hostname)` instead of being gated on `args.host` being an IP literal. Second, the `cacheDns` path becomes a small state machine: single-flight for the cold start (concurrent sends queue behind one lookup) and stale-while-revalidate at TTL expiry (send on the stale address, refresh in the background).

**Tech Stack:** Node.js >= 18, CommonJS, Mocha + Sinon, ESLint 8.

## Global Constraints

- Node.js >= 18.0.0.
- No new runtime dependencies.
- ESLint rules that bite here: single quotes, curly braces on every `if`, JSDoc required on every function (`require-jsdoc`), sorted imports (`sort-imports`), operators at end of line, no trailing whitespace.
- `npm test` runs lint first. Lint failures block tests.
- Real errors must be visible without `NODE_DEBUG=hot-shots`. `debug()` may add context but must never be the only signal for a real failure.
- Every queued send must invoke its callback exactly once on every path, and at the right time. `lib/statsd.js:618-625` decrements `messagesInFlight` and resolves `drainPromise` in that callback. A skipped callback stalls `close()` for its full drain budget and triggers the force-close warning at `lib/statsd.js:811`; a callback fired after `finish()` zeroes the counter at `lib/statsd.js:813` drives it negative. See Task 4.
- Do not add public constructor options in this work. The queue cap is an internal constant.

---

### Task 1: Always-on bypass lookup

Closes the default-host gap. Today `lib/transport.js:126` only installs the bypass when `args.host` is an IP literal, so the common no-host configuration pays a lookup per packet.

**Files:**
- Create: `test/helpers/dnsCounter.js`
- Create: `test/udpDnsLookupCount.js`
- Modify: `lib/transport.js:126-136`

**Interfaces:**
- Consumes: nothing.
- Produces: `dnsCounter.startCounting()` returning `{ count: number, hostnames: string[], restore: () => void }`, used by Tasks 2 and 3.

- [ ] **Step 1: Write the counting helper**

Create `test/helpers/dnsCounter.js`:

```js
const dns = require('dns');

/**
 * Patches dns.lookup to count invocations, so tests can assert on the exact
 * number of lookups a configuration performs. Call restore() in afterEach.
 * @returns {Object} state with count, hostnames and a restore function
 */
function startCounting() {
  const original = dns.lookup;
  const state = {
    count: 0,
    hostnames: [],
    restore: () => {
      dns.lookup = original;
    }
  };
  dns.lookup = function (...lookupArgs) {
    state.count++;
    state.hostnames.push(lookupArgs[0]);
    return original.apply(this, lookupArgs);
  };
  return state;
}

module.exports = {
  startCounting: startCounting
};
```

- [ ] **Step 2: Write the failing count-matrix tests**

Create `test/udpDnsLookupCount.js`:

```js
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
    let remaining = n;
    for (let i = 0; i < n; i++) {
      client.send(`test.${i}`, {}, () => {
        remaining--;
        if (remaining === 0) {
          onDone();
        }
      });
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
```

- [ ] **Step 3: Run the tests to verify the first one fails**

Run: `npx mocha test/udpDnsLookupCount.js --timeout 5000`

Expected: `performs no dns lookups with the default host` FAILS with a count of 20 or 21. The IPv4, IPv6, explicit-type, hostname and custom-lookup cases should already pass.

- [ ] **Step 4: Make the bypass unconditional**

In `lib/transport.js`, replace lines 126-136 with:

```js
  // Bypass dns.lookup for IP literals. Node calls the socket's lookup before
  // every packet, and although dns.lookup short-circuits an IP without hitting
  // a resolver, it still creates an instrumented async operation that APM tools
  // report as a span. This is installed even when args.host is a hostname,
  // because Node also routes the default address and any address resolved by
  // the cacheDns path through here.
  if (!socketOptions.lookup) {
    debug('hot-shots createUdpTransport: installing IP-bypass lookup');
    socketOptions.lookup = (hostname, options, callback) => {
      // Handle both lookup(hostname, callback) and lookup(hostname, options, callback)
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const version = net.isIP(hostname);
      if (version) {
        callback(null, hostname, version);
        return;
      }
      dns.lookup(hostname, options, callback);
    };
  }
```

The family now comes from `net.isIP(hostname)` per call rather than the outer `ipVersion`, which was wrong for any address other than `args.host`.

- [ ] **Step 5: Run the new tests**

Run: `npx mocha test/udpDnsLookupCount.js --timeout 5000`
Expected: all 6 PASS.

- [ ] **Step 6: Run the full suite for regressions**

Run: `npm test`
Expected: PASS. Pay attention to `test/udpSocketOptions.js`, which asserts an exact custom-lookup call count.

- [ ] **Step 7: Commit**

```bash
git add lib/transport.js test/helpers/dnsCounter.js test/udpDnsLookupCount.js
git commit -m "Bypass dns.lookup for IP literals on every UDP send"
```

---

### Task 2: Single-flight and stale-while-revalidate DNS cache

Makes `cacheDns` do its job. Today the cache is only populated in the async callback, so concurrent cold-start sends each launch their own lookup.

**Files:**
- Modify: `lib/transport.js:35-41` (return the default error listener)
- Modify: `lib/transport.js:143-211` (cache state and `sendUsingDnsCache`)
- Modify: `test/udpDnsCacheTransport.js:65,96,130,172,256` (add explicit hosts, update the address-change test)
- Test: `test/udpDnsCacheCoalescing.js` (create)

**Interfaces:**
- Consumes: `dnsCounter.startCounting()` from Task 1.
- Produces: `dnsResolutionData` with fields `timestamp` (number), `resolvedAddress` (string|undefined), `refreshInFlight` (boolean), `consecutiveFailures` (number), `pending` (array of `{ buf, callback }`). Task 3 adds the cap to `pending`; Task 4 drains it in `close()`.

- [ ] **Step 1: Write the failing coalescing tests**

Create `test/udpDnsCacheCoalescing.js`:

```js
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

      let completed = 0;
      for (let i = 0; i < 50; i++) {
        statsd.send(`test.${i}`, {}, error => {
          assert.strictEqual(error, null);
          completed++;
          if (completed === 50) {
            assert.strictEqual(lookupCount, 1, 'concurrent cold-start sends must share one lookup');
            done();
          }
        });
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

      statsd.send('warm', {}, () => {});
      clock.tick(1);

      // Three consecutive failed refreshes should report only once.
      for (let i = 0; i < 3; i++) {
        clock.tick(cacheDnsTtl + 50);
        statsd.send(`fail.${i}`, {}, () => {});
        clock.tick(1);
      }
      assert.strictEqual(errors.length, 1, 'streak should report once');

      // A success clears the streak.
      failing = false;
      clock.tick(cacheDnsTtl + 50);
      statsd.send('recover', {}, () => {});
      clock.tick(1);

      // The next failure streak reports again.
      failing = true;
      clock.tick(cacheDnsTtl + 50);
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

      statsd.send('warm', {}, () => {});
      clock.tick(1);
      clock.tick(cacheDnsTtl + 50);
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

      let failed = 0;
      for (let i = 0; i < 10; i++) {
        statsd.send(`test.${i}`, {}, error => {
          assert.ok(error, 'queued send should receive the lookup error');
          failed++;
          if (failed === 10) {
            done();
          }
        });
      }
      release();
    });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx mocha test/udpDnsCacheCoalescing.js --timeout 5000`
Expected: the coalescing, stale-serving, streak, console.error-fallback and cold-start-failure tests FAIL. Current code issues one lookup per send and has no stale serving. The `correct family` test may already pass; keep it as a regression guard for the per-call `net.isIP(hostname)` family.

- [ ] **Step 3: Return the default error listener**

Replace `lib/transport.js:35-41` with:

```js
const attachDefaultErrorListener = (socket, label) => {
  if (socket && typeof socket.on === 'function') {
    const listener = (err) => {
      debug('hot-shots %s default error listener: %s', label, err && err.message ? err.message : err);
    };
    socket.on('error', listener);
    return listener;
  }
  return null;
};
```

Update its JSDoc `@returns` line to `@returns {Function|null} the attached listener, or null if none was attached`.

- [ ] **Step 4: Replace the cache state and send path**

In `createUdpTransport`, change `const socket = dgram.createSocket(socketOptions);` and the lines that follow so the listener is captured:

```js
  const socket = dgram.createSocket(socketOptions);
  // do not block node from shutting down
  socket.unref();
  const defaultErrorListener = attachDefaultErrorListener(socket, 'udp');

  const dnsResolutionData = {
    timestamp: 0,
    resolvedAddress: undefined,
    refreshInFlight: false,
    consecutiveFailures: 0,
    pending: []
  };
```

Keep `sendToSocket` (lines 148-173) exactly as it is. Then replace `sendUsingDnsCache` (lines 175-211) with:

```js
  /**
   * Reports whether a user-supplied 'error' listener is attached, as opposed to
   * only the default debug listener installed by this transport.
   * @returns {boolean} true if a user listener is present
   */
  const hasUserErrorListener = () => {
    if (typeof socket.listeners !== 'function') {
      return false;
    }
    return socket.listeners('error').some(listener => listener !== defaultErrorListener);
  };

  /**
   * Reports a failed background DNS refresh. Sends keep working on the stale
   * address, so there is no send callback to carry this error. Reported once per
   * contiguous failure streak so a flapping resolver does not emit every TTL.
   * @param {Error} error - the lookup error
   */
  const reportRefreshFailure = (error) => {
    if (dnsResolutionData.consecutiveFailures === 0) {
      socket.emit('error', error);
      if (!hasUserErrorListener()) {
        console.error(`hot-shots: DNS refresh for ${args.host} failed, ` +
          `continuing with cached address ${dnsResolutionData.resolvedAddress}: ` +
          `${error && error.message}`);
      }
    }
    dnsResolutionData.consecutiveFailures++;
  };

  /**
   * Flushes queued sends. On success each queued buffer is sent to the resolved
   * address; on failure each queued callback receives the error. Every entry is
   * always called back exactly once, which the client's drain logic depends on.
   * @param {Error|null} error - lookup error, or null on success
   * @param {string} [address] - the resolved address when error is null
   */
  const flushPending = (error, address) => {
    const pending = dnsResolutionData.pending;
    dnsResolutionData.pending = [];
    pending.forEach(entry => {
      if (error) {
        if (entry.callback) {
          entry.callback(error);
        }
        return;
      }
      sendToSocket(entry.buf, address, entry.callback);
    });
  };

  /**
   * Starts a single DNS lookup for args.host. Only one runs at a time; callers
   * must check refreshInFlight before calling.
   */
  const startLookup = () => {
    dnsResolutionData.refreshInFlight = true;
    const isRefresh = dnsResolutionData.resolvedAddress !== undefined;
    debug('hot-shots UDP transport: performing DNS lookup for %s (refresh=%s)', args.host, isRefresh);

    dns.lookup(args.host, (error, address) => {
      dnsResolutionData.refreshInFlight = false;

      if (error) {
        debug('hot-shots UDP transport: DNS lookup error - %s', error.message);
        if (isRefresh) {
          reportRefreshFailure(error);
        } else {
          flushPending(error);
        }
        return;
      }

      debug('hot-shots UDP transport: DNS resolved %s to %s', args.host, address);
      dnsResolutionData.resolvedAddress = address;
      dnsResolutionData.timestamp = Date.now();
      dnsResolutionData.consecutiveFailures = 0;
      flushPending(null, address);
    });
  };

  /**
   * Sends data using cached DNS resolution. Concurrent cold-start sends share a
   * single lookup, and a send past the TTL goes out immediately on the stale
   * address while one refresh runs in the background.
   * @param {Function} callback - Callback function to invoke after send completes
   * @param {Buffer} buf - The data buffer to send
   */
  const sendUsingDnsCache = (callback, buf) => {
    // Nothing to resolve: an IP literal, or no host at all (Node picks the
    // loopback default, which the socket's bypass lookup then short-circuits).
    if (!args.host || net.isIP(args.host)) {
      debug('hot-shots UDP transport: host needs no resolution, sending directly');
      sendToSocket(buf, args.host, callback);
      return;
    }

    if (dnsResolutionData.resolvedAddress !== undefined) {
      sendToSocket(buf, dnsResolutionData.resolvedAddress, callback);
      const isStale = Date.now() - dnsResolutionData.timestamp > args.cacheDnsTtl;
      if (isStale && !dnsResolutionData.refreshInFlight) {
        startLookup();
      }
      return;
    }

    dnsResolutionData.pending.push({ buf: buf, callback: callback });
    if (!dnsResolutionData.refreshInFlight) {
      startLookup();
    }
  };
```

- [ ] **Step 5: Run the new tests**

Run: `npx mocha test/udpDnsCacheCoalescing.js --timeout 5000`
Expected: all 7 PASS.

- [ ] **Step 6: Update the existing cache tests for explicit hosts**

`test/udpDnsCacheTransport.js` has four tests that mock `dns.lookup` but never set `host`, so they were exercising `dns.lookup(undefined)`. With the no-host short-circuit they would perform no lookup at all. Add `host: 'localhost'` to the options object in each of these, so they test what their names claim:

- line 70-72, `Sending first message / should lookup dns once`
- line 101-103, `Sending messages within TTL / should lookup dns once`
- line 136-139, `Sending messages after TTL expired / should lookup dns twice`
- line 177-179, `DNS lookup failure / should pass error to callback when DNS lookup fails`
- line 262-265, `DNS resolution address change`

For example the first becomes:

```js
        statsd = createHotShotsClient(Object.assign(opts, {
          host: 'localhost',
          cacheDns: true
        }), 'client');
```

- [ ] **Step 7: Update the address-change test for stale-while-revalidate**

This is a deliberate behavior change: the first send after TTL expiry now goes out on the previous address, and the send after that uses the refreshed one. Replace the body of the test at `test/udpDnsCacheTransport.js:256-292` after the `resolvedAddress = '2.2.2.2'` line with:

```js
        // Change DNS resolution
        resolvedAddress = '2.2.2.2';

        // Advance past TTL
        clock.tick(cacheDnsTtl + 50);

        // Stale-while-revalidate: this send goes out on the previous address
        // while the refresh runs in the background.
        statsd.send('second', {}, (error) => {
          assert.strictEqual(error, null);
        });

        clock.tick(1);
        assert.strictEqual(socketMock.host, '1.1.1.1');

        // The next send picks up the refreshed address.
        statsd.send('third', {}, (error) => {
          assert.strictEqual(error, null);
        });

        clock.tick(1);
        assert.strictEqual(socketMock.host, '2.2.2.2');
        done();
```

- [ ] **Step 8: Add a cacheDns count assertion to the matrix**

Append to `test/udpDnsLookupCount.js`, inside the existing `describe`:

```js
  it('performs one dns lookup per TTL with cacheDns and a hostname', done => {
    server = createServer(udpServerType, opts => {
      counter = dnsCounter.startCounting();
      statsd = createHotShotsClient(Object.assign(opts, {
        host: 'localhost',
        cacheDns: true,
        cacheDnsTtl: 60000
      }), 'client');
      sendN(statsd, 20, () => {
        assert.strictEqual(counter.count, 1, `expected 1 lookup, saw ${counter.hostnames}`);
        done();
      });
    });
  });
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/transport.js test/udpDnsCacheCoalescing.js test/udpDnsCacheTransport.js test/udpDnsLookupCount.js
git commit -m "Coalesce cacheDns lookups and serve stale addresses while refreshing"
```

---

### Task 3: Bound the pending queue and account for drops

A hung resolver under a high send rate would otherwise grow `pending` without limit.

**Files:**
- Modify: `lib/constants.js` (add `DNS_MAX_PENDING`)
- Modify: `lib/transport.js` (import the constant, enforce the cap)
- Test: `test/udpDnsCacheDrops.js` (create)

**Interfaces:**
- Consumes: `dnsResolutionData.pending` from Task 2.
- Produces: `exports.DNS_MAX_PENDING = 1000` from `lib/constants.js`.

- [ ] **Step 1: Write the failing drop tests**

Create `test/udpDnsCacheDrops.js`:

```js
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
      const dropped = [];
      let delivered = 0;

      // One more than the cap, so exactly one send is dropped.
      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, error => {
          if (error) {
            dropped.push(i);
          } else {
            delivered++;
          }
          if (dropped.length + delivered === cap + 1) {
            assert.deepStrictEqual(dropped, [0], 'the oldest queued send should be dropped');
            assert.strictEqual(delivered, cap);
            done();
          }
        });
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
      let completed = 0;
      for (let i = 0; i < cap + 1; i++) {
        statsd.send(`test.${i}`, {}, () => {
          completed++;
          if (completed === cap + 1) {
            assert.strictEqual(statsd.telemetry.packetsDroppedWriter, 1);
            done();
          }
        });
      }

      release();
    });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx mocha test/udpDnsCacheDrops.js --timeout 5000`
Expected: FAIL. `constants.DNS_MAX_PENDING` is undefined, so the loop bound is `NaN` and nothing is sent.

- [ ] **Step 3: Add the constant**

In `lib/constants.js`, after the `CARDINALITY_VALUES` export, add:

```js
// Maximum sends queued behind an in-flight DNS lookup when cacheDns is enabled.
// Past this, the oldest queued send is dropped so a hung resolver under load
// cannot grow memory without bound.
exports.DNS_MAX_PENDING = 1000;
```

- [ ] **Step 4: Enforce the cap**

In `lib/transport.js`, change the constants import on line 7 to:

```js
const { DNS_MAX_PENDING, PROTOCOL } = require('./constants');
```

Then in `sendUsingDnsCache`, replace the `dnsResolutionData.pending.push(...)` line with:

```js
    if (dnsResolutionData.pending.length >= DNS_MAX_PENDING) {
      const oldest = dnsResolutionData.pending.shift();
      debug('hot-shots UDP transport: pending DNS queue full, dropping oldest send');
      if (oldest.callback) {
        oldest.callback(new Error(
          `hot-shots: dropped metric while resolving ${args.host}, ` +
          `${DNS_MAX_PENDING} sends already queued`));
      }
    }
    dnsResolutionData.pending.push({ buf: buf, callback: callback });
```

Telemetry needs no extra wiring: `lib/statsd.js:666` passes `handleCallback` as the send callback, and `handleCallback` already routes an error into `recordBytesDroppedWriter` at `lib/statsd.js:631-633`.

- [ ] **Step 5: Run the tests**

Run: `npx mocha test/udpDnsCacheDrops.js --timeout 5000`
Expected: both PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/constants.js lib/transport.js test/udpDnsCacheDrops.js
git commit -m "Bound the pending DNS queue and report drops through the error path"
```

---

### Task 4: Drain safety on close

A `close()` racing an in-flight lookup breaks in two different ways. Unbuffered, the queued entries hold `messagesInFlight` above zero, so close stalls its full drain budget, emits a spurious force-close warning, zeroes the counter, and only then fires the queued callbacks — driving the counter negative. Buffered, the final flush's own send is the thing stuck in the queue, so close hangs outright before any drain logic is installed. Read Step 2 before implementing; the obvious fix addresses neither.

**Files:**
- Modify: `lib/constants.js` (add `DNS_CANCELLED_CODE`)
- Modify: `lib/transport.js` (add `cancelPendingSends`, drain in `close`)
- Modify: `lib/statsd.js:769` (guard the final flush), `:804` (cancel before zeroing), `:1161` (helper)
- Test: `test/udpDnsCacheClose.js` (create)

**Interfaces:**
- Consumes: `dnsResolutionData.pending` and `flushPending` from Task 2; `lib/constants.js` from Task 3.
- Produces: `transport.cancelPendingSends(error)` on the UDP transport, an optional method other transports do not implement, so callers must guard with `typeof`; `cancelDnsPendingSends(client)` in `lib/statsd.js`; `constants.DNS_CANCELLED_CODE`.

- [ ] **Step 1: Write the failing test**

Create `test/udpDnsCacheClose.js`:

```js
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
```

- [ ] **Step 2: Run to verify the stuck-lookup tests fail**

Run: `npx mocha test/udpDnsCacheClose.js --timeout 5000`

Expected: `does not force-close or corrupt the counter` FAILS on its assertions, and `completes close in buffered mode` FAILS by timing out. Trace the actual close sequence before implementing, because there are two distinct hazards and the obvious fix addresses neither.

**Hazard 1, unbuffered.** `Client.close()` (`lib/statsd.js:722`) runs `flushQueue`, then `waitForDrain()`, then `finish()`, then `_close()`, and only `_close()` reaches `transport.close()`. The queued DNS callbacks are what decrement `messagesInFlight`, so draining them inside `transport.close()` happens too late. With `closingFlushInterval` defaulting to 50 (`lib/statsd.js:149`), `waitForDrain` burns its full `closingFlushInterval * 11` budget (`:794`), `finish()` logs `could not clear out messages in flight but closing anyways` (`:811`) and forces the counter to 0 (`:813`) — and only then does `transport.close()` fire the queued callbacks, each decrementing past zero and leaving `messagesInFlight` negative.

Cancellation must therefore run inside `finish()`, before the counter is zeroed, and no earlier than that: running it before the drain wait would discard sends whose lookup would have resolved in time, breaking the documented serverless "flush then exit" behavior.

**Hazard 2, buffered.** `finish()` is only reached from inside the final `flushQueue` callback. `flushQueue(cb)` calls `sendMessage(buffer, cb)` (`:567`), which invokes `cb` from the transport's send callback — and `sendMessage` short-circuits early only when the message is empty (`:581`). So if the buffer holds data and the cold-start lookup never resolves, that final flush sits in `dnsResolutionData.pending`, its callback never fires, and close hangs before any of the drain or cancellation logic above is installed. This needs a separate guard around the final flush itself.

**The trap in fixing Hazard 2.** The flush-error branch at `:769-787` returns early *without closing the socket*. Cancelling the final flush with an ordinary error would therefore abort the close entirely. The cancellation error must carry a distinguishing code so this branch can let it through, report it, and keep closing.

- [ ] **Step 3: Expose a cancel hook on the UDP transport**

In `lib/transport.js`, add a `cancelPendingSends` property to the object returned by `createUdpTransport`, alongside `send` and `close`:

```js
    cancelPendingSends: (error) => {
      if (dnsResolutionData.pending.length === 0) {
        return;
      }
      debug('hot-shots UDP transport: cancelling %d sends queued behind a DNS lookup',
        dnsResolutionData.pending.length);
      flushPending(error);
    },
```

Also keep a drain in `close()` as a safety net for any path that reaches the transport with entries still queued:

```js
    close: () => {
      debug('hot-shots UDP transport: closing socket');
      // Normally already empty: Client.close() cancels pending sends before it
      // zeroes messagesInFlight. This only catches a transport closed directly.
      flushPending(new Error('hot-shots: transport closed while resolving DNS'));
      socket.close();
    },
```

- [ ] **Step 4: Add the cancellation error code**

In `lib/constants.js`, next to `DNS_MAX_PENDING` from Task 3, add:

```js
// Marks the error given to sends cancelled because close() gave up waiting on an
// in-flight DNS lookup. close() checks for this code so the cancelled final buffer
// flush is reported without aborting the socket close.
exports.DNS_CANCELLED_CODE = 'HOTSHOTS_DNS_CANCELLED';
```

`handleCallback` copies `err.code` onto the error it builds (`lib/statsd.js:628`), so the code survives the wrapping.

- [ ] **Step 5: Add the cancellation helper in statsd.js**

In `lib/statsd.js`, add `DNS_CANCELLED_CODE` to the constants import, then add this module-level function near `collectDrainClients` (line 1161):

```js
/**
 * Fails any sends queued behind an in-flight DNS lookup on the client's transport.
 * Only the UDP transport queues sends this way, so the hook is optional.
 * @param {Client} client - the client whose transport should be drained
 * @returns {void}
 */
function cancelDnsPendingSends(client) {
  if (client.socket && typeof client.socket.cancelPendingSends === 'function') {
    const error = new Error('hot-shots: closing while still resolving DNS');
    error.code = DNS_CANCELLED_CODE;
    client.socket.cancelPendingSends(error);
  }
}
```

- [ ] **Step 6: Guard the final flush against a stuck lookup**

In `Client.prototype.close`, replace the `this.flushQueue((err) => {` line (line 769) and its error branch with:

```js
  // The final flush's callback fires from the transport's send callback, so a
  // cold-start DNS lookup that never resolves would hang close() here — before the
  // drain logic below is even installed. Give the lookup the same budget the drain
  // gets, then cancel it so close can proceed.
  const flushGuard = setTimeout(() => {
    cancelDnsPendingSends(this);
  }, this.closingFlushInterval * 11);

  // flush the queue one last time, if needed
  this.flushQueue((err) => {
    clearTimeout(flushGuard);

    // A flush cancelled by the guard above must not abort the close: the socket
    // still needs closing and the caller's callback still needs to fire. Report the
    // dropped metrics and carry on. Any other flush error keeps the existing
    // early-return behavior.
    if (err && err.code === DNS_CANCELLED_CODE) {
      if (this.errorHandler) {
        try {
          this.errorHandler(err);
        } catch (handlerErr) {
          console.error('hot-shots: errorHandler threw inside cancelled final flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: final flush dropped while resolving DNS: ${err && err.message}`);
      }
    }
    else if (err) {
```

The rest of the existing error branch body is unchanged; only its `if (err) {` opener becomes `else if (err) {`.

Do not unref `flushGuard`, for the reason given at `lib/statsd.js:862`: the UDP socket is already unref'd, so an unref'd timer would let Node exit before the guard fires. Clearing it on the normal path is what keeps a healthy close from being delayed.

This gives a stuck-DNS close two sequential budgets, roughly 1.1s with the defaults. That is deliberate: sharing one budget would mean moving `closeStart` above the flush, which shortens the drain window for every close and risks destabilizing the timing assertions in `test/close.js`.

- [ ] **Step 7: Cancel pending sends before the counter is forced to zero**

In `lib/statsd.js`, at the top of `finish()` (line 804, before the `if (totalInFlight() > 0)` check), add:

```js
    const finish = () => {
      // Fail sends still queued behind an in-flight DNS lookup so their callbacks
      // decrement messagesInFlight before we read it below. Draining them later —
      // in transport.close() — would fire those callbacks after the counter was
      // forced to 0, leaving it negative. Doing it here rather than before the
      // drain wait preserves every send whose lookup resolves within the budget.
      drainClients.forEach(client => cancelDnsPendingSends(client));

      if (totalInFlight() > 0) {
```

Clients sharing a socket will call this more than once; it is idempotent because `flushPending` empties the queue.

- [ ] **Step 8: Run the tests**

Run: `npx mocha test/udpDnsCacheClose.js --timeout 5000`
Expected: all 4 PASS.

- [ ] **Step 9: Run the close and drain suites specifically**

Run: `npx mocha test/close.js --timeout 5000`
Expected: PASS. This file contains the force-close and drain tests that the `finish()` and final-flush changes touch.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add lib/constants.js lib/statsd.js lib/transport.js test/udpDnsCacheClose.js
git commit -m "Keep close working when a DNS lookup stalls the final flush or drain"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CHANGES.md`
- Modify: `README.md:89-91`

`types.d.ts` needs no change: no public API moved, since the queue cap is an internal constant.

- [ ] **Step 1: Add the changelog entries**

At the top of the unreleased section of `CHANGES.md`, add:

```markdown
* [@bdeitte](https://github.com/bdeitte) Skip `dns.lookup` on every UDP send. Node routes each packet's address through the socket's lookup, which created a `dns.lookup` async operation per packet and showed up as APM spans. IP hosts and the default no-host configuration now perform no lookups at all. See [#2984](https://github.com/DataDog/dd-trace-js/issues/2984)
* [@bdeitte](https://github.com/bdeitte) `cacheDns` now coalesces concurrent lookups into one and serves the cached address while refreshing in the background, instead of one lookup per send. Note that the first send after the TTL expires now goes out on the previous address while the refresh runs
```

- [ ] **Step 2: Update the README option descriptions**

Replace `README.md:89-91` with:

```markdown
* `cacheDns`:    Caches dns lookup to *host* for *cacheDnsTtl*, only used
                 when *protocol* is `udp` and *host* is a hostname. Concurrent
                 sends share a single lookup, and once an address is cached,
                 sends never block on DNS: an expired entry is still used to
                 send while a refresh runs in the background. `default: false`
* `cacheDnsTtl`: time-to-live of dns lookups in milliseconds, when *cacheDns* is enabled. `default: 60000`
```

Then add a note after the options list, near the other UDP notes:

```markdown
When *host* is an IP address, or is left unset, hot-shots performs no DNS
lookups at all regardless of *cacheDns*. Node otherwise routes every UDP packet
through `dns.lookup`, which is a no-op for an IP address but still shows up as a
span in APM tools.
```

- [ ] **Step 3: Verify the docs render and lint passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CHANGES.md README.md
git commit -m "Document the DNS lookup and cacheDns changes"
```

---

## Verification

After all tasks, confirm the target behavior directly rather than trusting the unit tests alone. Create a scratch script that patches `dns.lookup` to count, then sends 20 metrics sequentially per configuration, and check it reports:

| config | expected lookups per 20 sends |
| --- | --- |
| no host (default) | 0 |
| `host: '127.0.0.1'` | 0 |
| `host: '::1'` | 0 |
| `host: 'localhost'` | 20 |
| `host: 'localhost'`, `cacheDns: true` | 1 |

Run `npm test` one final time and confirm the full suite passes before considering the work complete.
