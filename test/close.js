const assert = require('assert');
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
          // snapshotted _drainPromise and then force-closed when this new send was
          // still in flight. Post-fix, the re-check loop waits for it to drain too.
          statsd.increment('b', 1, undefined, undefined, () => {
            bFired = true;
          });
        });

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
      });
    });

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
      });
    });
  });
});
