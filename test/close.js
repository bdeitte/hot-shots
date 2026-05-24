const assert = require('assert');
const sinon = require('sinon');
const helpers = require('./helpers/helpers.js');

const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#close', () => {
  let server;
  let statsd;

  testTypes().forEach(([description, serverType, clientType, metricsEnd]) => {
    describe(description, () => {
      it('should call callback after close call', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.close(() => {
            server.close();
            done();
          });
        });
      });

      it('should send metrics before close call', done => {
        let metricSeen = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          statsd.set('test', 42);
          statsd.close(() => {
            // give the metric a bit of time to get handled by the server
            const serverClose = setInterval(() => {
              server.close();
              clearInterval(serverClose);
              assert.ok(metricSeen, 'Metric was not seen as expected');
              done();
            }, 100);
          });
        });
        server.on('metrics', metrics => {
          assert.strictEqual(metrics, `test:42|s${metricsEnd}`);
          metricSeen = true;
        });
      });

      it('should send metric before close call when buffering enabled', done => {
        let metricSeen = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 1
          }), clientType);
          statsd.set('test', 42);
          statsd.close(() => {
            // give the metric a bit of time to get handled by the server
            const serverClose = setInterval(() => {
              server.close();
              clearInterval(serverClose);
              assert.ok(metricSeen, 'Metric was not seen as expected');
              done();
            }, 100);
          });
        });
        server.on('metrics', metrics => {
          // this uses '\n' instead of metricsEnd because that's how things are set up when
          // maxBufferSize is in use
          assert.strictEqual(metrics, `test:42|s${metricsEnd}`);
          metricSeen = true;
        });
      });

      it('should send metric before close call when buffered', done => {
        let metricSeen = false;
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 5000
          }), clientType);
          statsd.set('test', 42);
          statsd.close(() => {
            // give the metric a bit of time to get handled by the server
            const serverClose = setInterval(() => {
              server.close();
              clearInterval(serverClose);
              assert.ok(metricSeen, 'Metric was not seen as expected');
              done();
            }, 100);
          });
        });
        server.on('metrics', metrics => {
          // this uses '\n' instead of metricsEnd because that's how things are set up when
          // maxBufferSize is in use
          assert.strictEqual(metrics, `test:42|s${metricsEnd}`);
          metricSeen = true;
        });
      });

      it('should use errorHandler on close issue', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler() {
              server.close();
              done();
            }
          }), clientType);

          // copy the real socket so it can cleaned up at the end
          const socketRef = Object.assign({}, statsd.socket);

          statsd.socket.destroy = () => {
            throw new Error('Boom!');
          };

          statsd.socket.close = statsd.socket.destroy;

          statsd.close();

          // cleanup socket
          socketRef.close();
        });
      });

      it('should handle close when errorHandler is defined but socket is null', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler() {
              assert.fail('errorHandler should not be called');
            }
          }), clientType);

          // save the socket reference to close it later
          const socketRef = statsd.socket;

          // simulate a scenario where socket becomes null
          statsd.socket = null;

          // this should not throw an error
          statsd.close(() => {
            // cleanup socket
            if (socketRef) {
              socketRef.close();
            }
            server.close();
            done();
          });
        });
      });

      it('should force close after 10 attempts when messagesInFlight stays positive', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            closingFlushInterval: 5,
          }), clientType);

          // Simulate stuck messages in flight
          statsd.messagesInFlight = 5;

          statsd.close(() => {
            // The force close resets messagesInFlight to 0
            assert.strictEqual(statsd.messagesInFlight, 0);
            server.close();
            done();
          });
        });
      });

      it('should close with telemetry enabled', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            includeDatadogTelemetry: true,
            telemetryFlushInterval: 60000,
          }), clientType);

          statsd.increment('test.counter');
          assert.ok(statsd.telemetry !== null);

          let calledDone = false;
          statsd.close(() => {
            if (!calledDone) {
              calledDone = true;
              server.close();
              done();
            }
          });
        });
      });
    });
  });

  describe('drain re-check', () => {
    it('waits for sends started from a user callback during the drain window', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          // Plenty of room so the timeout doesn't fire before async sends complete.
          closingFlushInterval: 100,
        }), 'client');

        // Stub socket.send to fire callbacks asynchronously (simulating a real socket).
        // This guarantees that 'a' is still in-flight when close() runs and that the
        // user callback for 'a' fires from within the drain window.
        const originalSend = statsd.socket.send.bind(statsd.socket);
        let sendCount = 0;
        statsd.socket.send = function (buf, cb) {
          sendCount++;
          setImmediate(() => {
            if (cb) {
              cb(null, buf.length);
            }
          });
        };

        let aFired = false;
        let bFired = false;
        statsd.increment('a', 1, undefined, undefined, () => {
          aFired = true;
          // Issue a new send from inside the user callback. Pre-fix, the close drain
          // snapshotted drainPromise and then force-closed when this new send was
          // still in flight. Post-fix, the re-check loop waits for it to drain too.
          statsd.increment('b', 1, undefined, undefined, () => {
            bFired = true;
          });
        });

        // Snapshot state at close() call time. aFired === false here proves the
        // drain actually waited; otherwise the test could pass coincidentally if a
        // never-waiting drain happened to run after the callback for unrelated reasons.
        statsd.close(() => {
          assert.strictEqual(aFired, true, 'a callback must have fired');
          assert.strictEqual(bFired, true,
            'b started during drain must have completed before close callback fires');
          assert.ok(sendCount >= 2, `expected at least 2 socket sends, got ${sendCount}`);
          statsd.socket.send = originalSend;
          server.close();
          server = null;
          statsd = null;
          done();
        });
        assert.strictEqual(aFired, false,
          'a callback must NOT have fired synchronously — proves close had to wait for drain');
      });
    });

    it('waits for sends queued via setTimeout(0) during the drain window', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          closingFlushInterval: 100,
        }), 'client');

        const originalSend = statsd.socket.send.bind(statsd.socket);
        let sendCount = 0;
        statsd.socket.send = function (buf, cb) {
          sendCount++;
          setImmediate(() => {
            if (cb) {
              cb(null, buf.length);
            }
          });
        };

        let aFired = false;
        let bFired = false;
        statsd.increment('a', 1, undefined, undefined, () => {
          aFired = true;
          // setTimeout(0) lands in the timer phase, AFTER setImmediate. A drain
          // implementation that only waits one setImmediate tick would close before
          // this fires.
          setTimeout(() => {
            statsd.increment('b', 1, undefined, undefined, () => {
              bFired = true;
            });
          }, 0);
        });

        statsd.close(() => {
          assert.strictEqual(aFired, true, 'a callback must have fired');
          assert.strictEqual(bFired, true,
            'b queued via setTimeout(0) during drain must have completed before close callback');
          assert.ok(sendCount >= 2, `expected at least 2 socket sends, got ${sendCount}`);
          statsd.socket.send = originalSend;
          server.close();
          server = null;
          statsd = null;
          done();
        });
        assert.strictEqual(aFired, false,
          'a callback must NOT have fired synchronously — proves close had to wait for drain');
      });
    });

    // Note: there is no direct regression test for the provisional-drain budget cap
    // (Math.min(this.closingFlushInterval, remaining) in lib/statsd.js's close()
    // drain). The cap saves at most closingFlushInterval - remaining ms over the
    // buggy path, which is comparable to OS timer precision (~16ms), so any
    // real-clock assertion either lets the buggy path pass within slack or is
    // flaky. A fully deterministic version would require sinon fake timers wrapped
    // around the Promise.race + setImmediate machinery in the drain loop —
    // possible but disproportionate for a 4-character correctness-by-inspection
    // change. Tracked as follow-up work; correctness is currently verified by
    // code review only.
    it('waits for sends queued asynchronously (setImmediate) during the drain window', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          closingFlushInterval: 100,
        }), 'client');

        const originalSend = statsd.socket.send.bind(statsd.socket);
        let sendCount = 0;
        statsd.socket.send = function (buf, cb) {
          sendCount++;
          setImmediate(() => {
            if (cb) {
              cb(null, buf.length);
            }
          });
        };

        let aFired = false;
        let bFired = false;
        statsd.increment('a', 1, undefined, undefined, () => {
          aFired = true;
          // Defer the follow-up send via setImmediate so it does NOT start synchronously
          // inside the send callback. This is the case review #775 flagged: the sync
          // re-check loop alone misses async-queued follow-ups because messagesInFlight
          // is briefly 0 between the callback returning and setImmediate firing.
          setImmediate(() => {
            statsd.increment('b', 1, undefined, undefined, () => {
              bFired = true;
            });
          });
        });

        statsd.close(() => {
          assert.strictEqual(aFired, true, 'a callback must have fired');
          assert.strictEqual(bFired, true,
            'b queued asynchronously during drain must have completed before close callback');
          assert.ok(sendCount >= 2, `expected at least 2 socket sends, got ${sendCount}`);
          statsd.socket.send = originalSend;
          server.close();
          server = null;
          statsd = null;
          done();
        });
        assert.strictEqual(aFired, false,
          'a callback must NOT have fired synchronously — proves close had to wait for drain');
      });
    });
  });

  describe('force-close budget', () => {
    // Pins the documented "11 ticks of closingFlushInterval" budget. The drain in
    // lib/statsd.js's close() intentionally preserves this from the prior polling
    // implementation so callers that mutate messagesInFlight directly (or whose
    // sends genuinely fail to drain) close in a bounded time. Without tight bounds
    // here, a refactor could silently shorten the multiplier (e.g. * 11 → * 2) and
    // stuck callers would force-close in 40ms instead of 220ms, losing in-flight
    // sends that the prior implementation would have allowed to drain. The bounds
    // below are calibrated to fail for any multiplier other than ~11.

    it('force-closes near closingFlushInterval * 11 ms when messagesInFlight stays positive', done => {
      // Interval is large enough that OS timer / GC jitter (~20-50ms even on loaded
      // CI) is small relative to the budget (1100ms). The bounds below allow ~150ms
      // of slack — wide enough to be non-flaky, tight enough to fail at multiplier
      // 9 (900ms) or 13 (1300ms).
      const closingFlushInterval = 100;
      const expectedBudgetMs = closingFlushInterval * 11;
      const lowerBoundMs = expectedBudgetMs - 50;  // 1050 — fails for multiplier <= 10
      const upperBoundMs = expectedBudgetMs + 150; // 1250 — fails for multiplier >= 13
      const consoleLogStub = sinon.stub(console, 'log');

      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          closingFlushInterval,
        }), 'client');

        // Stuck-sends scenario: a caller (or buggy transport) leaves messagesInFlight
        // positive without ever resolving via sendMessage's handleCallback.
        statsd.messagesInFlight = 5;

        const start = Date.now();
        statsd.close(() => {
          const elapsed = Date.now() - start;
          consoleLogStub.restore();

          assert.strictEqual(statsd.messagesInFlight, 0,
            'force close must reset messagesInFlight to 0');
          assert.ok(elapsed >= lowerBoundMs,
            'force close must wait close to the full budget; elapsed ' +
            `${elapsed}ms < lower bound ${lowerBoundMs}ms (budget ${expectedBudgetMs}ms). ` +
            'A regression that shortened the multiplier (e.g. * 11 → * 2) would land here.');
          assert.ok(elapsed <= upperBoundMs,
            'force close must complete within the documented budget; elapsed ' +
            `${elapsed}ms > upper bound ${upperBoundMs}ms (budget ${expectedBudgetMs}ms).`);

          const stuckLog = consoleLogStub.getCalls().find(c => {
            return typeof c.args[0] === 'string' &&
              c.args[0].includes('could not clear out messages in flight');
          });
          assert.ok(stuckLog, 'force close must emit the "could not clear out messages" log line');

          server.close();
          server = null;
          statsd = null;
          done();
        });
      });
    });
  });

  describe('child close', () => {
    // Helper: delay socket.close so _close's listener window stays open long enough
    // for our synthetic emit to land while handleSocketErr is still attached.
    const delaySocketClose = (statsdClient, ms) => {
      const origClose = statsdClient.socket.close.bind(statsdClient.socket);
      statsdClient.socket.close = () => {
        setTimeout(origClose, ms);
      };
    };

    it('async close-time error reaches inherited errorHandler exactly once (no double-delivery)', done => {
      let inheritedHandlerCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { inheritedHandlerCalls++; },
          closingFlushInterval: 5,
        }), 'client');

        const child = statsd.childClient();
        delaySocketClose(statsd, 100);

        child.close(() => { /* close callback */ });

        // Emit AFTER _close attaches listeners but BEFORE the delayed socket.close
        // completes. Pre-fix: parent's listener fires AND handleSocketErr →
        // this.errorHandler (same inherited fn) fires = 2 calls. Post-fix: only
        // parent's listener fires.
        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(inheritedHandlerCalls, 1,
            `inherited errorHandler should fire exactly once; got ${inheritedHandlerCalls}`);
          server.close();
          server = null;
          done();
        }, 200);
      });
    });

    it('async close-time error reaches close callback when child has overridden errorHandler', done => {
      let parentCalls = 0;
      let childCalls = 0;
      let callbackErr = null;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { parentCalls++; },
          closingFlushInterval: 5,
        }), 'client');

        const child = statsd.childClient({
          errorHandler: () => { childCalls++; },
        });
        delaySocketClose(statsd, 100);

        child.close((err) => { callbackErr = err; });

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(parentCalls, 1, `parent errorHandler should fire once; got ${parentCalls}`);
          assert.strictEqual(childCalls, 0,
            'child callback was supplied — child errorHandler should not be called');
          assert.ok(callbackErr, 'child close callback should receive the async error');
          assert.ok((/synthetic async error/).test(callbackErr.message),
            `expected wrapped synthetic error, got: ${callbackErr && callbackErr.message}`);
          server.close();
          server = null;
          done();
        }, 200);
      });
    });

    it('async close-time error reaches overridden child errorHandler when no close callback is supplied', done => {
      let parentCalls = 0;
      let childCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { parentCalls++; },
          closingFlushInterval: 5,
        }), 'client');

        const child = statsd.childClient({
          errorHandler: () => { childCalls++; },
        });
        delaySocketClose(statsd, 100);

        child.close();

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(parentCalls, 1, `parent errorHandler should fire once; got ${parentCalls}`);
          assert.strictEqual(childCalls, 1,
            `child overridden errorHandler should fire exactly once; got ${childCalls}`);
          server.close();
          server = null;
          done();
        }, 200);
      });
    });

    it('async close-time error reaches root errorHandler when no close callback (regression for stale on-socket flag)', done => {
      // The persistent _errorHandlerIsOnSocket flag is true for a root client with
      // an errorHandler at construction. But _close() removes the user's handler
      // from the socket, so by the time handleSocketErr fires it must NOT use the
      // stale flag — the local errorHandlerOnSocketDuringClose tracks the runtime
      // state. Pre-fix: root errorHandler was suppressed and the close-time error
      // dropped entirely.
      let rootCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { rootCalls++; },
          closingFlushInterval: 5,
        }), 'client');
        delaySocketClose(statsd, 100);

        // No close callback — handleSocketErr must route to errorHandler.
        statsd.close();

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(rootCalls, 1,
            `root errorHandler should receive the async error; got ${rootCalls}`);
          server.close();
          server = null;
          // Null out so afterEach doesn't try to close again.
          statsd = null;
          done();
        }, 200);
      });
    });

    it('grandchild inheriting through an overriding child does not lose async error delivery', done => {
      let rootCalls = 0;
      let intermediateCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { rootCalls++; },
          closingFlushInterval: 5,
        }), 'client');

        const intermediate = statsd.childClient({
          errorHandler: () => { intermediateCalls++; },
        });

        // Grandchild inherits intermediate's overridden handler. The handler is NOT
        // on the shared socket (only root's is), so the propagation must result in
        // grandchild._errorHandlerIsOnSocket === false; handleSocketErr must call it
        // explicitly on async errors.
        const grandchild = intermediate.childClient();
        delaySocketClose(statsd, 100);

        grandchild.close();

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(rootCalls, 1, `root errorHandler should fire once; got ${rootCalls}`);
          assert.strictEqual(intermediateCalls, 1,
            `grandchild's inherited handler should fire once; got ${intermediateCalls}`);
          server.close();
          server = null;
          done();
        }, 200);
      });
    });
  });

  describe('close-time buffer flush errors', () => {
    let consoleErrorStub;

    afterEach(done => {
      if (consoleErrorStub) {
        consoleErrorStub.restore();
        consoleErrorStub = null;
      }
      helpers.closeAll(server, statsd, true, done);
      server = null;
      statsd = null;
    });

    it('routes buffered close-time flush error to errorHandler when no close callback is given', done => {
      let handlerErr = null;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
          errorHandler: err => {
            handlerErr = err;
          },
        }), 'client');

        statsd.flushQueue = function (cb) {
          if (cb) {
            cb(new Error('boom from close-time flush'));
          }
        };

        statsd.close();

        setTimeout(() => {
          assert.ok(handlerErr, 'errorHandler should have received the flush error');
          assert.strictEqual(handlerErr.message, 'boom from close-time flush');
          done();
        }, 50);
      });
    });

    it('prefers close callback over errorHandler for buffered close-time flush error', done => {
      let handlerCalled = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
          errorHandler: () => {
            handlerCalled = true;
          },
        }), 'client');

        statsd.flushQueue = function (cb) {
          if (cb) {
            cb(new Error('boom from close-time flush'));
          }
        };

        statsd.close(err => {
          assert.ok(err, 'close callback should receive the flush error');
          assert.strictEqual(err.message, 'boom from close-time flush');
          setTimeout(() => {
            assert.strictEqual(handlerCalled, false,
              'errorHandler must not be called when close callback is supplied');
            done();
          }, 20);
        });
      });
    });

    it('falls back to console.error when neither close callback nor errorHandler is set', done => {
      server = createServer('udp', opts => {
        consoleErrorStub = sinon.stub(console, 'error');

        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
        }), 'client');

        statsd.flushQueue = function (cb) {
          if (cb) {
            cb(new Error('boom from close-time flush'));
          }
        };

        statsd.close();

        setTimeout(() => {
          const calls = consoleErrorStub.getCalls().filter(c => {
            return c.args[0] && c.args[0].message === 'boom from close-time flush';
          });
          assert.ok(calls.length >= 1, 'console.error should have been called with the flush error');
          done();
        }, 50);
      });
    });

    it('falls back to console.error preserving original when errorHandler throws', done => {
      server = createServer('udp', opts => {
        consoleErrorStub = sinon.stub(console, 'error');

        statsd = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
          errorHandler: () => { throw new Error('handler exploded'); },
        }), 'client');

        statsd.flushQueue = function (cb) {
          if (cb) {
            cb(new Error('boom from close-time flush'));
          }
        };

        statsd.close();

        setTimeout(() => {
          const calls = consoleErrorStub.getCalls().filter(c => {
            return typeof c.args[0] === 'string' &&
              c.args[0].includes('errorHandler threw inside final buffer flush');
          });
          assert.ok(calls.length >= 1, 'console.error should have been called when handler throws');
          const msg = calls[0].args[0];
          assert.ok(msg.includes('boom from close-time flush'),
            `console.error must preserve original flush error, got: ${msg}`);
          assert.ok(msg.includes('handler exploded'),
            `console.error must include handler error, got: ${msg}`);
          done();
        }, 50);
      });
    });
  });
});
