const assert = require('assert');
const constants = require('../lib/constants');
const sinon = require('sinon');
const helpers = require('./helpers/helpers.js');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

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
      // Interval is large enough that OS timer / GC jitter is small relative to the
      // budget (1100ms). Bounds are wide enough to tolerate heavily loaded CI runners
      // (macOS App Nap, GC pauses, container CPU contention) while still tight enough
      // to fail any meaningful regression of the multiplier (e.g. * 11 → * 2 lands at
      // ~200ms; * 11 → * 20 lands at ~2000ms).
      const closingFlushInterval = 100;
      const expectedBudgetMs = closingFlushInterval * 11;
      const lowerBoundMs = expectedBudgetMs - 100; // 1000 — fails for multiplier <= 9
      const upperBoundMs = expectedBudgetMs + 400; // 1500 — fails for multiplier >= 15
      const consoleErrorStub = sinon.stub(console, 'error');

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
          consoleErrorStub.restore();

          assert.strictEqual(statsd.messagesInFlight, 0,
            'force close must reset messagesInFlight to 0');
          assert.ok(elapsed >= lowerBoundMs,
            'force close must wait close to the full budget; elapsed ' +
            `${elapsed}ms < lower bound ${lowerBoundMs}ms (budget ${expectedBudgetMs}ms). ` +
            'A regression that shortened the multiplier (e.g. * 11 → * 2) would land here.');
          assert.ok(elapsed <= upperBoundMs,
            'force close must complete within the documented budget; elapsed ' +
            `${elapsed}ms > upper bound ${upperBoundMs}ms (budget ${expectedBudgetMs}ms).`);

          const stuckLog = consoleErrorStub.getCalls().find(c => {
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

    it('async close-time error reaches a late-assigned inherited errorHandler exactly once', done => {
      let inheritedHandlerCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          closingFlushInterval: 5,
        }), 'client');
        // Assigned after construction, so the setter is what attaches the
        // socket listener. A child created afterwards inherits the handler and
        // must know it is already on the shared socket.
        statsd.errorHandler = () => { inheritedHandlerCalls++; };

        const child = statsd.childClient();
        delaySocketClose(statsd, 100);

        // No close callback, so a close-time socket error is routed to the
        // errorHandler rather than to a callback, which is where the second
        // delivery would come from.
        child.close();

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

    it('async close-time error reaches an inherited handler once when it clears the parent\'s handler', done => {
      let inheritedHandlerCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          // Clearing the parent's handler from inside the delivery detaches the
          // listener that just delivered. The child's close listener runs next
          // in the same emit and must still see that this error was delivered.
          errorHandler: () => {
            inheritedHandlerCalls++;
            statsd.errorHandler = undefined;
          },
          closingFlushInterval: 5,
        }), 'client');
        const child = statsd.childClient();
        delaySocketClose(statsd, 100);

        child.close();

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

    it('async close-time error is logged once a child\'s parent cleared the shared errorHandler', done => {
      let handlerCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { handlerCalls++; },
          closingFlushInterval: 5,
        }), 'client');
        const child = statsd.childClient();
        // Detaches the parent's socket listener. The child follows the parent's
        // handler, so it has none either, and the child's close path must log
        // the error instead of dropping it.
        statsd.errorHandler = undefined;
        delaySocketClose(statsd, 100);

        const logged = [];
        const originalConsoleError = console.error;
        console.error = msg => logged.push(String(msg));

        child.close();

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          console.error = originalConsoleError;
          server.close();
          server = null;
          try {
            assert.strictEqual(handlerCalls, 0,
              `the cleared errorHandler must not fire; got ${handlerCalls}`);
            assert.ok(logged.some(msg => msg.includes('synthetic async error')),
              `the close-time error should be logged, saw ${JSON.stringify(logged)}`);
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 200);
      });
    });

    it('async close-time error reaches a handler the child swapped in after construction', done => {
      let parentCalls = 0;
      let childCalls = 0;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          errorHandler: () => { parentCalls++; },
          closingFlushInterval: 5,
        }), 'client');
        const child = statsd.childClient();
        child.errorHandler = () => { childCalls++; };
        delaySocketClose(statsd, 100);

        child.close();

        setTimeout(() => {
          statsd.socket.emit('error', new Error('synthetic async error'));
        }, 30);
        setTimeout(() => {
          assert.strictEqual(childCalls, 1, `the child's own handler should fire once; got ${childCalls}`);
          assert.strictEqual(parentCalls, 1, `the parent's socket listener should fire once; got ${parentCalls}`);
          server.close();
          server = null;
          done();
        }, 200);
      });
    });

    it('async close-time error reaches an overriding child once after the child replaced its socket', done => {
      let childCalls = 0;
      server = createServer('tcp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          protocol: 'tcp',
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {},
          closingFlushInterval: 5,
        }), 'client');
        const child = statsd.childClient({ errorHandler: () => { childCalls++; } });
        setTimeout(() => {
          // Make the child's send fail with a replaceable tcp error, so the
          // child replaces its own socket and attaches its listener there.
          const sharedSocket = statsd.socket;
          sharedSocket.createdAt = Date.now() - 60000;
          sharedSocket.send = (buf, callback) => setImmediate(() => callback({ code: 'ECONNRESET' }));
          child.increment('replace.me', () => {
            assert.notStrictEqual(child.socket, sharedSocket, 'the child should have replaced its socket');
            childCalls = 0;
            delaySocketClose(child, 100);
            child.close();
            setTimeout(() => {
              child.socket.emit('error', new Error('synthetic async error'));
            }, 30);
            setTimeout(() => {
              // The child moved off the shared socket without closing it, so
              // the parent still has its own socket to close.
              statsd.close(() => {
                server.close();
                server = null;
                assert.strictEqual(childCalls, 1, `the child's handler should fire exactly once; got ${childCalls}`);
                done();
              });
            }, 200);
          });
        }, 20);
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
      // The construction-time _errorHandlerInitiallyOnSocket flag is true for a root client with
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

    it('async close-time error reaches root errorHandler when that error replaces the socket mid-close', done => {
      let rootCalls = 0;
      server = createServer('tcp', opts => {
        setTimeout(() => {
          statsd = createHotShotsClient(Object.assign(opts, {
            protocol: 'tcp',
            errorHandler: () => { rootCalls++; },
            closingFlushInterval: 5,
          }), 'client');
          const closingSocket = statsd.socket;
          // Old enough to clear the graceful-restart rate limit, so the error
          // below has protocolErrorHandler swap in a replacement while close
          // is still waiting on this socket.
          closingSocket.createdAt = Date.now() - 60000;
          delaySocketClose(statsd, 100);

          // No close callback, so the close-time error must reach errorHandler.
          statsd.close();

          setTimeout(() => {
            const err = new Error('reset while closing');
            err.code = 'ECONNRESET';
            closingSocket.emit('error', err);
            assert.notStrictEqual(statsd.socket, closingSocket, 'the error should have replaced the socket');
          }, 30);
          setTimeout(() => {
            const calls = rootCalls;
            // Close the replacement socket and the server before asserting, so
            // a failure leaves nothing holding the process open.
            statsd.close(() => {
              server.close();
              server = null;
              statsd = null;
              try {
                assert.strictEqual(calls, 1,
                  `root errorHandler should receive the close-time error; got ${calls}`);
                done();
              } catch (assertErr) {
                done(assertErr);
              }
            });
          }, 200);

        }, 20);
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
        // grandchild._errorHandlerInitiallyOnSocket === false; handleSocketErr must call it
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

  describe('final flush that never completes', () => {
    let clock;
    let consoleErrorStub;

    afterEach(() => {
      if (clock) {
        clock.restore();
        clock = null;
      }
      if (consoleErrorStub) {
        consoleErrorStub.restore();
        consoleErrorStub = null;
      }
    });

    it('stops waiting after FLUSH_TIMEOUT, reports it, and still closes the socket', done => {
      server = createServer('udp', opts => {
        // Installed after the server is listening, which uses real timers.
        clock = sinon.useFakeTimers();
        // The stuck send also trips close()'s force-close warning.
        consoleErrorStub = sinon.stub(console, 'error');

        const state = { reported: null, socketClosed: false, calls: [] };
        const closingFlushInterval = 5;
        const client = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          closingFlushInterval: closingFlushInterval,
          errorHandler: err => {
            state.reported = err;
          }
        }), 'client');
        // A send that never calls back, as a tcp write into a socket whose
        // connect never completes is left.
        client.socket.send = () => { /* never calls back */ };
        const realClose = client.socket.close;
        client.socket.close = () => {
          state.socketClosed = true;
          realClose();
        };

        // Buffered, so it is only handed to the stuck send by close()'s final
        // flushQueue.
        client.increment('buffered.metric');
        client.close(err => state.calls.push(err));

        clock.tickAsync(constants.FLUSH_TIMEOUT - 1).then(() => {
          assert.strictEqual(state.reported, null, 'close should keep waiting until FLUSH_TIMEOUT');
          return clock.tickAsync(1);
        }).then(() => {
          assert.ok(state.reported, 'giving up on the final flush should be reported');
          assert.strictEqual(state.reported.code, constants.FLUSH_TIMEOUT_CODE);
          // Then the drain budget for the send that is still in flight.
          return clock.tickAsync(closingFlushInterval * 12);
        }).then(() => {
          clock.restore();
          clock = null;
          // dgram emits 'close' on a later tick of the real event loop.
          setTimeout(() => {
            try {
              assert.ok(state.socketClosed, 'the socket should still be closed');
              assert.strictEqual(state.calls.length, 1, `close callback must fire once, fired ${state.calls.length} times`);
              assert.ok(!state.calls[0], `close should not fail, got ${state.calls[0] && state.calls[0].message}`);
              server.close();
              server = null;
              done();
            } catch (assertErr) {
              done(assertErr);
            }
          }, 20);
        }).catch(done);
      });
    });
  });

  describe('a send error after close stopped waiting on the final flush', () => {
    let clock;
    let consoleErrorStub;

    afterEach(() => {
      if (clock) {
        clock.restore();
        clock = null;
      }
      if (consoleErrorStub) {
        consoleErrorStub.restore();
        consoleErrorStub = null;
      }
    });

    it('reports the send error to errorHandler', done => {
      server = createServer('udp', opts => {
        clock = sinon.useFakeTimers();
        // The stuck send also trips close()'s force-close warning.
        consoleErrorStub = sinon.stub(console, 'error');
        const reported = [];
        const client = createHotShotsClient(Object.assign(opts, {
          maxBufferSize: 1024,
          bufferFlushInterval: 100000,
          closingFlushInterval: 5,
          errorHandler: err => reported.push(err)
        }), 'client');
        // Holds the send's callback so the test can fail the send later.
        let sendCallback = null;
        client.socket.send = (buf, callback) => { sendCallback = callback; };
        client.increment('buffered.metric');
        const calls = [];
        client.close(err => calls.push(err));

        clock.tickAsync(constants.FLUSH_TIMEOUT).then(() => {
          assert.strictEqual(reported.length, 1, 'giving up on the final flush should be reported');
          assert.strictEqual(reported[0].code, constants.FLUSH_TIMEOUT_CODE);
          return clock.tickAsync(5 * 12);
        }).then(() => {
          clock.restore();
          clock = null;
          assert.ok(sendCallback, 'the buffered payload should have been handed to the transport');
          sendCallback(new Error('write failed'));
          // dgram emits 'close' on a later tick of the real event loop.
          setTimeout(() => {
            try {
              assert.strictEqual(calls.length, 1, `close callback must fire once, fired ${calls.length} times`);
              assert.ok(!calls[0], `close should not fail, got ${calls[0] && calls[0].message}`);
              assert.strictEqual(reported.length, 2, `the late send error should also be reported, saw ${reported.length}`);
              assert.ok(reported[1].message.includes('write failed'),
                `errorHandler should get the send error, got ${reported[1].message}`);
              server.close();
              server = null;
              done();
            } catch (assertErr) {
              done(assertErr);
            }
          }, 20);
        }).catch(done);
      });
    });
  });

  describe('already-destroyed socket', () => {
    it('tcp: completes close when the socket was destroyed out of band', function (done) {
      this.timeout(4000);
      const tcpServer = net.createServer(() => {}); // eslint-disable-line no-empty-function
      tcpServer.listen(0, '127.0.0.1', () => {
        const client = createHotShotsClient({
          protocol: 'tcp',
          host: '127.0.0.1',
          port: tcpServer.address().port,
          tcpGracefulErrorHandling: false,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }, 'client');

        setTimeout(() => {
          // Destroy the socket behind the client's back, then close normally.
          client.socket.close();
          tcpServer.close();

          const state = { calls: 0 };
          client.close(() => {
            state.calls++;
            // Give any real 'close' event a chance to arrive after the emulated
            // one, so a double-invocation would be caught.
            setTimeout(() => {
              assert.strictEqual(state.calls, 1,
                `close callback must fire exactly once, fired ${state.calls} times`);
              done();
            }, 100);
          });
        }, 100);
      });
    });

    it('stream: completes close when the application destroyed its own stream first', function (done) {
      this.timeout(4000);
      const stream = new PassThrough();
      const state = { calls: 0, appCloseEvents: 0 };
      // The application's own listener on the stream it owns.
      stream.on('close', () => {
        state.appCloseEvents++;
      });

      const client = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

      // The owning application destroys the stream it handed us.
      stream.destroy();

      setTimeout(() => {
        assert.strictEqual(state.appCloseEvents, 1,
          'the stream should have emitted its own close exactly once by now');

        client.close(() => {
          state.calls++;
          setTimeout(() => {
            assert.strictEqual(state.calls, 1,
              `close callback must fire exactly once, fired ${state.calls} times`);
            // The client must not synthesize a second 'close' on a stream it
            // does not own: the application's listeners would run again.
            assert.strictEqual(state.appCloseEvents, 1,
              `close() must not re-emit 'close' on the caller's stream, saw ${state.appCloseEvents} events`);
            done();
          }, 100);
        });
      }, 50);
    });

    describe('a destroy that is still pending', () => {
      let savedUncaught;
      let uncaught;

      beforeEach(() => {
        // Swapped out so an escaping 'error' is recorded rather than failing the
        // run from mocha's own handler, which would hide what is asserted.
        savedUncaught = process.listeners('uncaughtException');
        process.removeAllListeners('uncaughtException');
        uncaught = [];
        process.on('uncaughtException', err => uncaught.push(err));
      });

      afterEach(() => {
        process.removeAllListeners('uncaughtException');
        savedUncaught.forEach(listener => process.on('uncaughtException', listener));
      });

      /**
       * Builds a stream whose _destroy finishes later, with an error, as a
       * stream flushing to a slow resource can.
       * @returns {Writable} the stream
       */
      const createSlowDestroyStream = () => new Writable({
        write(chunk, encoding, callback) {
          callback();
        },
        destroy(_err, callback) {
          setTimeout(() => callback(new Error('late destroy failure')), 300);
        }
      });

      it('stream: waits for the destroy and routes its error to errorHandler', done => {
        const stream = createSlowDestroyStream();
        const seen = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        // destroyed is now true, but the stream has not closed yet.
        stream.destroy();
        client.close();

        setTimeout(() => {
          try {
            assert.deepStrictEqual(uncaught.map(err => err.message), [],
              'the late destroy error must not escape as an uncaught exception');
            assert.ok(seen.some(msg => msg.includes('late destroy failure')),
              `the late destroy error should reach errorHandler, saw ${JSON.stringify(seen)}`);
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 500);
      });

      it('stream: logs a child\'s late destroy error when the parent clears its handler mid-close', done => {
        const stream = createSlowDestroyStream();
        const seen = [];
        const handler = err => seen.push(err.message);
        const parent = createHotShotsClient({ protocol: 'stream', stream: stream, errorHandler: handler }, 'client');
        // Reads the parent's handler, which the shared socket delivers when
        // close() starts.
        const child = parent.childClient({});

        stream.destroy();
        child.close();
        // Clearing the parent's handler detaches the listener that was
        // delivering the child's errors, while the child's close is pending.
        // The child follows the parent, so it has no handler either now.
        const logged = [];
        const originalConsoleError = console.error;
        setTimeout(() => {
          parent.errorHandler = undefined;
          console.error = msg => logged.push(String(msg));
        }, 100);

        setTimeout(() => {
          console.error = originalConsoleError;
          try {
            assert.deepStrictEqual(uncaught.map(err => err.message), []);
            assert.deepStrictEqual(seen, [], 'the cleared handler must not be called');
            assert.ok(logged.some(msg => msg.includes('late destroy failure')),
              `the destroy error should be logged, saw ${JSON.stringify(logged)}`);
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 500);
      });

      /**
       * Builds a stream that never emits 'close', whose _destroy finishes later
       * with the given result.
       * @param {Error|null} result - what _destroy calls back with
       * @returns {Writable} the stream
       */
      const createSilentSlowDestroyStream = result => new Writable({
        emitClose: false,
        write(chunk, encoding, callback) {
          callback();
        },
        destroy(_err, callback) {
          setTimeout(() => callback(result), 300);
        }
      });

      it('stream: completes close after a pending destroy on a stream with emitClose: false', done => {
        const stream = createSilentSlowDestroyStream(null);
        const calls = [];
        // eslint-disable-next-line no-empty-function
        const client = createHotShotsClient({ protocol: 'stream', stream: stream, errorHandler: () => {} }, 'client');

        stream.destroy();
        client.close(err => calls.push(err));

        setTimeout(() => {
          try {
            assert.deepStrictEqual(uncaught.map(err => err.message), []);
            assert.strictEqual(calls.length, 1, `close callback must fire exactly once, fired ${calls.length} times`);
            assert.ok(!calls[0], `close should not fail, got ${calls[0] && calls[0].message}`);
            assert.strictEqual(stream.listenerCount('error'), 0,
              'close should remove its temporary error listener once the destroy finishes');
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 700);
      });

      it('stream: routes a late destroy error on a stream with emitClose: false', done => {
        const stream = createSilentSlowDestroyStream(new Error('late destroy failure'));
        const seen = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        stream.destroy();
        client.close();

        setTimeout(() => {
          try {
            assert.deepStrictEqual(uncaught.map(err => err.message), [],
              'the late destroy error must not escape as an uncaught exception');
            assert.ok(seen.some(msg => msg.includes('late destroy failure')),
              `the late destroy error should reach errorHandler, saw ${JSON.stringify(seen)}`);
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 700);
      });

      it('stream: routes a destroy error that reuses an Error the stream emitted before close', done => {
        const reused = new Error('reused stream failure');
        const stream = new Writable({
          write(chunk, encoding, callback) {
            callback();
          },
          destroy(_err, callback) {
            setTimeout(() => callback(reused), 50);
          }
        });
        const seen = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        // Delivered by the client's regular listener. The same object comes
        // back from the destroy below, a separate emission that only close()'s
        // listener is there to route.
        stream.emit('error', reused);
        setImmediate(() => {
          client.close();
          setTimeout(() => {
            try {
              assert.deepStrictEqual(uncaught.map(err => err.message), []);
              assert.strictEqual(seen.length, 2, `both emissions should be routed, saw ${JSON.stringify(seen)}`);
              assert.ok(seen[1].includes('Error closing hot-shots socket') && seen[1].includes('reused stream failure'),
                `the close-time emission should be routed as a close error, saw ${JSON.stringify(seen)}`);
              done();
            } catch (assertErr) {
              done(assertErr);
            }
          }, 300);
        });
      });

      it('stream: routes a destroy error that another stream emitted on the same tick', done => {
        const shared = new Error('shared stream failure');
        // eslint-disable-next-line no-empty-function
        const openStream = new Writable({ write(chunk, encoding, callback) { callback(); } });
        let failDestroy = null;
        const closingStream = new Writable({
          write(chunk, encoding, callback) {
            callback();
          },
          destroy(_err, callback) {
            failDestroy = () => callback(shared);
          }
        });
        const seen = [];
        const handler = err => seen.push(err.message);
        const openClient = createHotShotsClient({ protocol: 'stream', stream: openStream, errorHandler: handler }, 'client');
        const closingClient = createHotShotsClient({ protocol: 'stream', stream: closingStream, errorHandler: handler }, 'client');

        closingClient.close();
        setTimeout(() => {
          // The same Error object, delivered on the open stream and then, on
          // the same tick, failing the other stream's destroy.
          openStream.emit('error', shared);
          failDestroy();
          setTimeout(() => {
            openClient.close(() => {
              try {
                assert.deepStrictEqual(uncaught.map(err => err.message), []);
                assert.strictEqual(seen.length, 2, `both streams' failures should be routed, saw ${JSON.stringify(seen)}`);
                assert.ok(seen[1].includes('Error closing hot-shots socket'),
                  `the closing stream's failure should be routed as a close error, saw ${JSON.stringify(seen)}`);
                done();
              } catch (assertErr) {
                done(assertErr);
              }
            });
          }, 50);
        // Past close()'s drain wait, so its destroy has started.
        }, 200);
      });

      it('stream: calls the close callback once, after the destroy finishes', done => {
        const stream = createSlowDestroyStream();
        const calls = [];
        // eslint-disable-next-line no-empty-function
        const client = createHotShotsClient({ protocol: 'stream', stream: stream, errorHandler: () => {} }, 'client');

        stream.destroy();
        client.close(err => calls.push(err));

        setTimeout(() => {
          try {
            assert.deepStrictEqual(uncaught.map(err => err.message), []);
            assert.strictEqual(calls.length, 1, `close callback must fire exactly once, fired ${calls.length} times`);
            assert.ok(calls[0] && calls[0].message.includes('late destroy failure'),
              `the close callback should get the destroy error, got ${calls[0] && calls[0].message}`);
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 500);
      });
    });
  });

  describe('a socket replaced while close waits on it', () => {
    /**
     * Builds a transport over an EventEmitter whose close() emits 'close'
     * asynchronously, like a real socket does. onClose runs inside close(),
     * where a test can swap a replacement onto the client the way
     * protocolErrorHandler does after a connection error.
     * @param {Function} onClose - run synchronously inside close()
     * @returns {Object} the transport
     */
    const createTransport = onClose => {
      const emitter = new EventEmitter();
      return {
        on: emitter.on.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
        emit: emitter.emit.bind(emitter),
        listenerCount: emitter.listenerCount.bind(emitter),
        send: (buf, callback) => callback(),
        close: () => {
          onClose();
          setTimeout(() => emitter.emit('close'), 20);
        },
        unref: () => {} // eslint-disable-line no-empty-function
      };
    };

    it('removes its listeners from the socket it closed rather than the replacement', done => {
      const client = createHotShotsClient({ host: '127.0.0.1', port: 8125, closingFlushInterval: 5 }, 'client');
      client.socket.close();
      const replacement = createTransport(() => {}); // eslint-disable-line no-empty-function
      const closing = createTransport(() => {
        client.socket = replacement;
      });
      client.socket = closing;

      client.close(err => {
        try {
          assert.ifError(err);
          assert.strictEqual(closing.listenerCount('close'), 0,
            'close should remove its close listener from the socket it closed');
          assert.strictEqual(closing.listenerCount('error'), 0,
            'close should remove its error listener from the socket it closed');
          assert.strictEqual(replacement.listenerCount('error'), 0,
            'close should not touch the replacement socket');
          done();
        } catch (assertErr) {
          done(assertErr);
        }
      });
    });
  });

  describe('a stream with emitClose: false', () => {
    /**
     * Builds an open stream that never emits 'close'.
     * @param {number|null} destroyDelayMs - how long _destroy takes to succeed,
     *   or null for Node's default, which finishes synchronously
     * @returns {Writable} the stream
     */
    const createSilentStream = destroyDelayMs => {
      const options = {
        emitClose: false,
        write(chunk, encoding, callback) {
          callback();
        }
      };
      if (destroyDelayMs !== null) {
        options.destroy = (_err, callback) => {
          setTimeout(() => callback(null), destroyDelayMs);
        };
      }
      return new Writable(options);
    };

    [['an asynchronous', 100], ['a synchronous', null]].forEach(([kind, delay]) => {
      it(`completes close when close() starts ${kind} destroy`, done => {
        const stream = createSilentStream(delay);
        const calls = [];
        // eslint-disable-next-line no-empty-function
        const client = createHotShotsClient({ protocol: 'stream', stream: stream, errorHandler: () => {} }, 'client');

        // The stream is still open, so close() is what starts the destroy.
        client.close(err => calls.push(err));

        setTimeout(() => {
          try {
            assert.strictEqual(calls.length, 1, `close callback must fire exactly once, fired ${calls.length} times`);
            assert.ok(!calls[0], `close should not fail, got ${calls[0] && calls[0].message}`);
            assert.strictEqual(stream.listenerCount('error'), 0,
              'close should remove its temporary error listener once the destroy finishes');
            done();
          } catch (assertErr) {
            done(assertErr);
          }
        }, 400);
      });
    });

    /**
     * Builds a stream whose destroy never finishes, so close() has to stop
     * waiting on it.
     * @returns {Writable} the stream
     */
    const createStuckStream = () => new Writable({
      emitClose: false,
      write(chunk, encoding, callback) {
        callback();
      },
      // Never calls back, so the stream never finishes closing.
      destroy() {} // eslint-disable-line no-empty-function
    });

    it('stops waiting on a destroy that never finishes and fails the close callback', () => {
      const clock = sinon.useFakeTimers();
      try {
        const stream = createStuckStream();
        const seen = [];
        const calls = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        client.close(err => calls.push(err));
        clock.tick(constants.FLUSH_TIMEOUT - 1000);
        assert.strictEqual(calls.length, 0, 'close should still be waiting on the destroy');

        clock.tick(2000);
        assert.strictEqual(calls.length, 1, `close callback must fire exactly once, fired ${calls.length} times`);
        assert.ok(calls[0] && calls[0].message.includes('stopped waiting on the stream\'s destroy'),
          `the close callback should get the timeout error, got ${calls[0] && calls[0].message}`);
        assert.strictEqual(seen.length, 0,
          `the error goes to the close callback, not errorHandler, saw ${JSON.stringify(seen)}`);
        assert.strictEqual(stream.listenerCount('error'), 1,
          'close should keep an error listener on a destroy that may still fail');
        // Nothing keeps polling a destroy that may never finish, which would
        // hold the client and stream in memory for good.
        clock.tick(60000);
        assert.strictEqual(clock.countTimers(), 0,
          'close should leave no timer running once it stops waiting');
      } finally {
        clock.restore();
      }
    });

    it('reports a destroy it stopped waiting on to errorHandler when close has no callback', () => {
      const clock = sinon.useFakeTimers();
      try {
        const stream = createStuckStream();
        const seen = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        client.close();
        clock.tick(constants.FLUSH_TIMEOUT + 1000);
        assert.ok(seen.some(msg => msg.includes('stopped waiting on the stream\'s destroy')),
          `the abandoned destroy should be reported, saw ${JSON.stringify(seen)}`);
      } finally {
        clock.restore();
      }
    });

    it('routes a destroy error that arrives after it stopped waiting', () => {
      const clock = sinon.useFakeTimers();
      const seen = [];
      const calls = [];
      let stream;
      let escaped = null;
      try {
        stream = new Writable({
          emitClose: false,
          write(chunk, encoding, callback) {
            callback();
          },
          destroy(_err, callback) {
            setTimeout(() => callback(new Error('destroy failed after the timeout')), constants.FLUSH_TIMEOUT + 1000);
          }
        });
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          errorHandler: err => seen.push(err.message)
        }, 'client');

        client.close(err => calls.push(err));
        clock.tick(constants.FLUSH_TIMEOUT + 500);
        // The fake clock also runs process.nextTick, so an 'error' emitted
        // with no listener is thrown out of tick() here.
        clock.tick(1000);
      } catch (err) {
        escaped = err;
      } finally {
        clock.restore();
      }
      assert.strictEqual(escaped, null, `the late destroy error must not escape, got ${escaped && escaped.message}`);
      assert.strictEqual(calls.length, 1, `close callback must fire exactly once, fired ${calls.length} times`);
      assert.ok(calls[0] && calls[0].message.includes('stopped waiting on the stream\'s destroy'),
        `the close callback should get the timeout error, got ${calls[0] && calls[0].message}`);
      assert.ok(seen.some(msg => msg.includes('destroy failed after the timeout')),

        `the late destroy error should reach errorHandler, saw ${JSON.stringify(seen)}`);
      assert.strictEqual(stream.listenerCount('error'), 0,
        'close should remove its error listener once the late destroy finishes');
    });

    it('still routes a late destroy error after a send error was emitted past the timeout', () => {
      const clock = sinon.useFakeTimers();
      const consoleError = sinon.stub(console, 'error');
      let stream;
      let escaped = null;
      try {
        stream = new Writable({
          emitClose: false,
          write(chunk, encoding, callback) {
            callback();
          },
          destroy(_err, callback) {
            setTimeout(() => callback(new Error('destroy failed after the timeout')), constants.FLUSH_TIMEOUT + 1000);
          }
        });
        // No errorHandler and no send callback, so a send error is emitted on
        // the socket, where close()'s remaining listener is the one to see it.
        const client = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

        client.close();
        clock.tick(constants.FLUSH_TIMEOUT + 500);
        client.increment('after.timeout');
        clock.tick(1000);
      } catch (err) {
        escaped = err;
      } finally {
        consoleError.restore();
        clock.restore();
      }
      assert.strictEqual(escaped, null, `the late destroy error must not escape, got ${escaped && escaped.message}`);
      const logged = consoleError.getCalls().map(call => String(call.args[0]));
      assert.ok(logged.some(msg => msg.includes('destroy failed after the timeout')),
        `the late destroy error should be logged, saw ${JSON.stringify(logged)}`);
      assert.strictEqual(stream.listenerCount('error'), 0,
        'close should remove its error listener once the destroy finishes');
    });

    it('still routes a late destroy error when a send error lands between it finishing and emitting', () => {
      const clock = sinon.useFakeTimers();
      const consoleError = sinon.stub(console, 'error');
      let stream;
      let client;
      let escaped = null;
      try {
        stream = new Writable({
          emitClose: false,
          write(chunk, encoding, callback) {
            callback();
          },
          destroy(_err, callback) {
            setTimeout(() => {
              // Node marks the stream closed here but emits this error on the
              // next tick, after the send error emitted just below.
              callback(new Error('destroy failed after the timeout'));
              client.increment('after.destroy');
            }, constants.FLUSH_TIMEOUT + 1000);
          }
        });
        client = createHotShotsClient({ protocol: 'stream', stream: stream }, 'client');

        client.close();
        clock.tick(constants.FLUSH_TIMEOUT + 2000);
      } catch (err) {
        escaped = err;
      } finally {
        consoleError.restore();
        clock.restore();
      }
      assert.strictEqual(escaped, null, `the late destroy error must not escape, got ${escaped && escaped.message}`);
      const logged = consoleError.getCalls().map(call => String(call.args[0]));
      assert.ok(logged.some(msg => msg.includes('destroy failed after the timeout')),
        `the late destroy error should be logged, saw ${JSON.stringify(logged)}`);
      assert.strictEqual(stream.listenerCount('error'), 0,
        'close should remove its error listener once the destroy has reported');
    });

    it('stops waiting within the timeout when closingFlushInterval is longer', () => {
      const clock = sinon.useFakeTimers();
      try {
        const stream = new Writable({
          emitClose: false,
          write(chunk, encoding, callback) {
            callback();
          },
          destroy() {} // eslint-disable-line no-empty-function
        });
        const calls = [];
        const client = createHotShotsClient({
          protocol: 'stream',
          stream: stream,
          closingFlushInterval: 60000,
          // eslint-disable-next-line no-empty-function
          errorHandler: () => {}
        }, 'client');

        client.close(err => calls.push(err));
        // close() first gives in-flight sends one closingFlushInterval to
        // drain, and only then starts the destroy.
        clock.tick(60000);
        assert.strictEqual(calls.length, 0, 'close should be waiting on the destroy');
        clock.tick(constants.FLUSH_TIMEOUT + 100);
        assert.strictEqual(calls.length, 1,
          `close should call back once the timeout passes, fired ${calls.length} times`);
      } finally {
        clock.restore();
      }
    });

    it('calls back before the process exits when the destroy held its last handle', function (done) {
      this.timeout(10000);
      // Run alone in a child process, so nothing but the destroy's own timer
      // holds the event loop open. Once that timer fires, close() must still
      // get to call back. The destroy takes long enough to still be pending
      // when close() reaches the socket.
      const script = `
        const { Writable } = require('stream');
        const StatsD = require(${JSON.stringify(path.join(__dirname, '..'))});
        const stream = new Writable({
          emitClose: false,
          write(chunk, encoding, callback) { callback(); },
          destroy(_err, callback) { setTimeout(() => callback(null), 200); }
        });
        const client = new StatsD({ protocol: 'stream', stream: stream });
        stream.destroy();
        client.close(err => process.stdout.write(err ? 'error: ' + err.message : 'closed'));
      `;
      // DD_* variables can turn on Datadog mode and its telemetry timer.
      const env = Object.assign({}, process.env);
      Object.keys(env).filter(key => key.startsWith('DD_')).forEach(key => delete env[key]);
      execFile(process.execPath, ['-e', script], { env: env, timeout: 8000 }, (err, stdout, stderr) => {
        try {
          assert.ifError(err);
          assert.strictEqual(stdout, 'closed', `close() should call back before exit, stderr: ${stderr}`);
          done();
        } catch (assertErr) {
          done(assertErr);
        }
      });
    });
  });
});
