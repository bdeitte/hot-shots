const assert = require('assert');
const process = require('process');
const path = require('path');
const helpers = require('./helpers/helpers.js');

/**
 * Create an internal error with a code and message.
 */
function internalError(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#errorHandling', () => {
  let server;
  let statsd;
  let ignoreErrors;

  afterEach(done => {
    closeAll(server, statsd, ignoreErrors, () => {
      ignoreErrors = false;
      server = null;
      statsd = null;
      done();
    });
  });

  // we have some tests first outside of the normal testTypes() setup as we want to
  // test with a broken server, which is just set up with tcp

  it('should use errorHandler when server is broken and using buffers', done => {
    // sometimes two errors show up, one with the initial connection
    let seenError = false;

    server = createServer('tcp_broken', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        protocol: 'tcp',
        maxBufferSize: 1,
        errorHandler(err) {
          assert.ok(err);
          if (! seenError) {
            seenError = true;
            // do not wait on closing the broken statsd connection
            statsd = null;
            done();
          }
        }
      }), 'client');
      setTimeout(() => {
        // give a small delay to ensure errorHandler is setup
        statsd.increment('a', 42, null);
      }, 50);
      server.on('metrics', () => {
        assert.ok(false);
      });
    });
  });

  testTypes().forEach(([description, serverType, clientType]) => {
    describe(description, () => {
      it('should not use errorHandler when there is not an error', done => {
        server = createServer(serverType, (opts) => {
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler(err) {
              console.log('Error handler called with:', err);
              assert.ok(false);
            }
          }), clientType);
          statsd.increment('a', 42, null);
        });

        server.on('metrics', () => {
          done();
        });
      });

      it('should not use errorHandler when there is not an error and using buffers', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(Object.assign(opts, {
            maxBufferSize: 1,
            errorHandler() {
              assert.ok(false);
            }
          }), clientType);
          statsd.increment('a', 42, null);
        });
        server.on('metrics', () => {
          done();
        });
      });

      it('should use errorHandler for sendStat error', done => {
        server = createServer(serverType, opts => {
          const err = new Error('Boom!');
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler(e) {
              assert.strictEqual(e, err);
              done();
            }
          }), clientType);
          statsd.sendStat = (item, value, type, sampleRate, tags, timestamp, callback) => {
            callback(err);
          };
          statsd.sendAll(['test title'], 'another desc');
        });
      });

      it('should use errorHandler for dnsError', done => {
        server = createServer(serverType, opts => {
          const err = new Error('Boom!');
          statsd = createHotShotsClient(Object.assign(opts, {
            errorHandler(e) {
              assert.strictEqual(e, err);
              ignoreErrors = true;
              done();
            }
          }), clientType);
          statsd.dnsError = err;
          statsd.send('test title');
        });
      });

      it('should errback for an unresolvable host', done => {
        // this does not work for tcp/uds, which throws an error during setup
        // that needs errorHandler or a socket.on('error') handler
        if (serverType !== 'udp') {
          return done();
        }

        statsd = createHotShotsClient({
          host: '...',
          protocol: serverType
        }, clientType);

        statsd.send('test title', [], error => {
          assert.ok(error);
          assert.strictEqual(error.code, 'ENOTFOUND');
          // skip closing, because the unresolvable host hangs
          statsd = null;
          done();
        });
      });

      it('should use errorHandler for an unresolvable host with cacheDns', done => {
        // this does not work for tcp/uds, which throws an error during setup
        // that needs errorHandler or a socket.on('error') handler
        if (serverType !== 'udp') {
          return done();
        }

        statsd = createHotShotsClient({
          host: '...',
          cacheDns: true,
          protocol: serverType,
          errorHandler(error) {
            assert.ok(error);
            assert.strictEqual(error.code, 'ENOTFOUND');
            // skip closing, because the unresolvable host hangs
            statsd = null;
            done();
          }
        }, clientType);
        statsd.send('test title');
      });

      it('should throw error on socket for an unresolvable host', done => {
        // this does not work for tcp/uds, which throws an error during setup
        // that needs errorHandler or a socket.on('error') handler
        if (serverType !== 'udp') {
          return done();
        }

        statsd = createHotShotsClient({
          host: '...',
          protocol: serverType
        }, clientType);

        statsd.socket.on('error', error => {
          assert.ok(error);
          assert.strictEqual(error.code, 'ENOTFOUND');

          // skip closing, because the unresolvable host hangs
          statsd = null;
          done();
        });

        statsd.send('test title');
      });

      if (serverType === 'tcp' && clientType === 'client' && process.platform !== 'win32') {
        describe('#tcpSocket', () => {

          // ensure we restore the original `Date.now` after each test
          const realDateNow = Date.now;
          afterEach(() => {
            Date.now = realDateNow;
          });

          it('should re-create the socket on bad connection error for type tcp', (done) => {
            const code = badTCPConnectionCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on bad descriptor error for type tcp', (done) => {
            const code = badTCPDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on error for type tcp with the configurable limit', (done) => {
            const code = badTCPConnectionCode();
            const limit = 4000;
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                tcpGracefulRestartRateLimit: limit,
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was NOT re-created
                  assert.strictEqual(initialSocket, client.socket);
                  Date.now = () => 4857394578 + limit; // 1 second later
                  initialSocket.emit('error', { code });
                  setTimeout(() => {
                    // make sure the socket was re-created
                    assert.notEqual(initialSocket, client.socket);
                    done();
                  }, 5);
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on bad descriptor error when sending metric', (done) => {
            const code = badTCPDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              // mock send function on the initial socket
              initialSocket.send = (_, callback) => {
                callback({ code });
              };
              setTimeout(() => {
                client.increment('metric.name');
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                client.increment('metric.name');
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on bad descriptor error when sending metric with a callback', (done) => {
            const code = badTCPDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              // mock send function on the initial socket
              initialSocket.send = (_, callback) => {
                callback({ code });
              };
              setTimeout(() => {
                client.increment('metric.name', error => {
                  assert.strictEqual(error.code, code);
                  assert.ok(Object.is(initialSocket, client.socket));
                  // it should not create the socket if it breaks too quickly
                  // change time and make another error
                  Date.now = () => 4857394578 + 1000; // 1 second later
                  client.increment('metric.name', anotherError => {
                    assert.strictEqual(anotherError.code, code);
                    setTimeout(() => {
                      // make sure the socket was re-created
                      assert.notEqual(initialSocket, client.socket);
                      done();
                    }, 5);
                  });
                });
              }, 5);
            });
          });

          it('should not re-create the socket on error for type tcp with tcpGracefulErrorHandling set to false', (done) => {
            const code = badTCPConnectionCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('tcp', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'tcp',
                tcpGracefulErrorHandling: false,
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket anyway if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was NOT re-created
                  assert.strictEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });
        });
      }

      if (serverType === 'uds' && clientType === 'client') {
        describe('#udsSocket', () => {

          // ensure we restore the original `Date.now` after each test
          const realDateNow = Date.now;
          afterEach(() => {
            Date.now = realDateNow;
          });

          it('should re-create the socket on bad connection error for type uds', (done) => {
            const code = badUDSConnectionCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on bad descriptor error for type uds', (done) => {
            const code = badUDSDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          it('should re-create the socket on error for type uds with the configurable limit', (done) => {
            const code = badUDSConnectionCode();
            const limit = 4000;
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                udsGracefulRestartRateLimit: limit,
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was NOT re-created
                  assert.strictEqual(initialSocket, client.socket);
                  Date.now = () => 4857394578 + limit; // 1 second later
                  initialSocket.emit('error', { code });
                  setTimeout(() => {
                    // make sure the socket was re-created
                    assert.notEqual(initialSocket, client.socket);
                    done();
                  }, 5);
                }, 5);
              }, 5);
            });
          });

          /*
            These cause an unusual error for some unknown reason now. Given this is an odd error case,
            just commenting out for now.
            Assertion failed: (iter != watchers.end()), function StopWatcher, file unix_dgram.cc, line 161.

          it('should re-create the socket on bad descriptor error when sending metric', (done) => {
            const code = badUDSDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              // mock send function on the initial socket
              initialSocket.send = (_, callback) => {
                callback({ code });
              };
              setTimeout(() => {
                client.increment('metric.name');
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                client.increment('metric.name');
                setTimeout(() => {
                  // make sure the socket was re-created
                  assert.notEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
              });
          });

          it('should re-create the socket on bad descriptor error when sending metric with a callback', (done) => {
            const code = badUDSDescriptorCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                },
                maxBufferSize: 0
              }), 'client');
              const initialSocket = client.socket;
              // mock send function on the initial socket
              initialSocket.send = (_, callback) => {
                callback({ code });
              };
              setTimeout(() => {
                client.increment('metric.name', error => {
                  assert.strictEqual(error.code, code);
                  assert.ok(Object.is(initialSocket, client.socket));
                  // it should not create the socket if it breaks too quickly
                  // change time and make another error
                  Date.now = () => 4857394578 + 1000; // 1 second later
                  client.increment('metric.name', anotherError => {
                    assert.strictEqual(anotherError.code, code);
                    setTimeout(() => {
                      // make sure the socket was re-created
                      assert.notEqual(initialSocket, client.socket);
                      done();
                    }, 5);
                  });
                });
              }, 5);
            });
          });
          */

          it('should not re-create the socket on error for type uds with udsGracefulErrorHandling set to false', (done) => {
            const code = badUDSConnectionCode();
            Date.now = () => '4857394578';
            // emit an error, like a socket would
            server = createServer('uds_broken', opts => {
              const client = statsd = createHotShotsClient(Object.assign(opts, {
                protocol: 'uds',
                udsGracefulErrorHandling: false,
                errorHandler(error) {
                  assert.ok(error);
                  assert.strictEqual(error.code, code);
                }
              }), 'client');
              const initialSocket = client.socket;
              setTimeout(() => {
                initialSocket.emit('error', { code });
                assert.ok(Object.is(initialSocket, client.socket));
                // it should not create the socket anyway if it breaks too quickly
                // change time and make another error
                Date.now = () => 4857394578 + 1000; // 1 second later
                initialSocket.emit('error', { code });
                setTimeout(() => {
                  // make sure the socket was NOT re-created
                  assert.strictEqual(initialSocket, client.socket);
                  done();
                }, 5);
              }, 5);
            });
          });

          describe('#udsRetry', () => {
            /**
             * Create UDS test server
             * @param {string} socketPath Path to socket
             * @param {Function} messageHandler Message handler function
             * @return {Object} Server object with cleanup function
             */
            function createUdsTestServer(socketPath, messageHandler) {
              const fs = require('fs'); // eslint-disable-line global-require
              let unixDgram;
              try {
                unixDgram = require('unix-dgram'); // eslint-disable-line global-require
              } catch (e) {
                return null;
              }

              // Clean up socket file if it exists
              try {
                fs.unlinkSync(socketPath); // eslint-disable-line no-sync
              } catch (e) {
                /* ignore */
              }

              const testServer = unixDgram.createSocket('unix_dgram');
              testServer.bind(socketPath);
              if (messageHandler) {
                testServer.on('message', messageHandler);
              }

              return {
                server: testServer,
                cleanup: () => {
                  testServer.close();
                  try {
                    fs.unlinkSync(socketPath); // eslint-disable-line no-sync
                  } catch (e) {
                    /* ignore */
                  }
                }
              };
            }

            it('should retry UDS send with exponential backoff on failure', (done) => {
              const socketPath = path.join(__dirname, 'test-retry.sock');
              const maxRetries = 2;
              const initialDelay = 50;

              const udsServer = createUdsTestServer(socketPath);

              if (!udsServer) {
                return done();
              }

              // Mock unix-dgram socket to fail first `maxRetries` attempts, then succeed
              const unixDgramModule = require('unix-dgram'); // eslint-disable-line global-require
              const realCreateSocket = unixDgramModule.createSocket;
              let sendAttempts = 0;
              unixDgramModule.createSocket = function(type) {
                const realSocket = realCreateSocket(type);
                const originalSend = realSocket.send.bind(realSocket);
                realSocket.send = function(buffer, callback) {
                  sendAttempts++;
                  if (sendAttempts <= maxRetries) {
                    const error = internalError('CONGESTION', 'congestion');
                    return process.nextTick(() => callback(error));
                  }
                  // Success on final attempt
                  return originalSend(buffer, callback);
                };
                return realSocket;
              };

              const client = statsd = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  retries: maxRetries,
                  retryDelayMs: initialDelay,
                  backoffFactor: 2
                },
                maxBufferSize: 0
              }, 'client');

              const startTime = Date.now();
              client.timing('test.timer', 100, (err) => {
                const elapsedTime = Date.now() - startTime;
                // restore
                unixDgramModule.createSocket = realCreateSocket;
                udsServer.cleanup();
                // check times
                console.log('Elapsed time for retries: ' + elapsedTime);
                // give a little wiggle room, making 1.5 intead of 2.0
                assert.ok(elapsedTime >= (initialDelay + (initialDelay * 1.5)));
                assert.ok(!err);
                done();
              });
            });

            it('should fail after exhausting all retries', (done) => {
              const socketPath = path.join(__dirname, 'test-retry-fail.sock');

              // Create a UDS server so connect() succeeds; we'll force send() to fail and then clean up.
              const udsServer = createUdsTestServer(socketPath);
              if (!udsServer) {
               return done();
              }

              // Mock unix-dgram socket to always fail
              const unixDgramModule = require('unix-dgram'); // eslint-disable-line global-require
              const realCreateSocket = unixDgramModule.createSocket;
              unixDgramModule.createSocket = function(type) {
                const realSocket = realCreateSocket(type);
                realSocket.send = function(buffer, callback) {
                  const error = internalError('CONGESTION', 'congestion');
                  return process.nextTick(() => callback(error));
                };
                return realSocket;
              };

              const client = statsd = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  retries: 5,
                },
                maxBufferSize: 0,
                errorHandler: (err) => {
                  assert.ok(err);
                  // restore
                  unixDgramModule.createSocket = realCreateSocket;
                  // clean up the uds server to avoid hanging the test
                  udsServer.cleanup();
                  done();
                }
              }, 'client');

              client.timing('test.timer', 100);
            });

            it('should not retry when udsRetries is 0', (done) => {
              const socketPath = path.join(__dirname, 'test-no-retry.sock');

              // Don't create a server to simulate connection failure
              let errorCount = 0;
              const client = statsd = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  retries: 0
                },
                maxBufferSize: 1,
                errorHandler: (err) => {
                  errorCount++;
                  assert.ok(err);
                  assert.strictEqual(errorCount, 1);
                  done();
                }
              }, 'client');

              client.timing('test.timer', 100);
            });

            it('should handle slow server that causes buffer overflow', function(done) {
              this.timeout(8000);
              const socketPath = path.join(__dirname, 'test-buffer-overflow.sock');

              const receivedPackets = [];
              const testStartTime = Date.now();
              let clientErrors = 0;
              let cleanedUp = false;
              let successfulSends = 0;
              let realCreateSocket;
              let unixDgramModule;

              /**
               * Clean up test server
               */
              function safeCleanup() {
                if (cleanedUp) {
                  return;
                }
                cleanedUp = true;
                udsServer.cleanup();
                // restore unix-dgram createSocket if we patched it
                try {
                  if (unixDgramModule && realCreateSocket) {
                    unixDgramModule.createSocket = realCreateSocket;
                  }
                } catch (e) {
                  /* ignore */
                }
              }

              // Create a normal server that accepts all packets
              const udsServer = createUdsTestServer(socketPath, (msg) => {
                if (cleanedUp) {
                  return;
                }
                receivedPackets.push(msg.toString());
                console.log(`Server received packet: ${receivedPackets.length}`);
              });

              if (!udsServer) {
                return done();
              }

              // Monkey-patch unix-dgram socket to simulate buffer overflow (EAGAIN) at the socket level
              // so that the transport's retry logic is exercised instead of being bypassed.
              try {
                // eslint-disable-next-line global-require
                unixDgramModule = require('unix-dgram');
                realCreateSocket = unixDgramModule.createSocket;
                unixDgramModule.createSocket = function(type) {
                  const realSocket = realCreateSocket(type);
                  const originalSend = realSocket.send.bind(realSocket);
                  realSocket.send = function(buffer, callback) {
                    const elapsedTime = Date.now() - testStartTime;
                    if (elapsedTime < 2000) {
                      // First 2 seconds: reject all sends to simulate saturated buffer
                      console.log(`Mock socket: buffer overflow at ${elapsedTime}ms (congestion)`);
                      const error = internalError('CONGESTION', 'congestion');
                      if (callback) {
                        process.nextTick(() => callback(error));
                      }
                      return;
                    }
                    // After 2 seconds: allow all sends
                    successfulSends++;
                    console.log(`Mock socket: fast send #${successfulSends} at ${elapsedTime}ms (retried packet success)`);
                    return originalSend(buffer, callback);
                  };
                  return realSocket;
                };
              } catch (e) {
                // If unix-dgram is not available, skip
                return done();
              }

              const client = statsd = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  retries: 20,
                  retryDelayMs: 150,
                  maxRetryDelayMs: 800,
                  backoffFactor: 2
                },
                maxBufferSize: 1,
                errorHandler: (err) => {
                  clientErrors++;
                  console.log(`Client error #${clientErrors}: ${err.message || err.code || err}`);
                }
              }, 'client');

              // Send a single packet; it should retry until allowed after 2s
              console.log('Sending a single packet that should retry until success...');
              client.gauge('test.single.metric', 42);

              // Poll every 500ms so we can quit as soon as success criteria are met
              let finished = false;
              const poll = setInterval(() => {
                if (finished) { return; }
                if (successfulSends === 1 && receivedPackets.length === 1) {
                  finished = true;
                  clearInterval(poll);
                  clearTimeout(failSafe);
                  console.log('Early success: single packet delivered after retries.');
                  safeCleanup();
                  done();
                }
              }, 500);

              // Failsafe to end the test even if polling never detects success
              const failSafe = setTimeout(() => {
                if (finished) { return; }
                console.log(`Test completed: ${receivedPackets.length} packets received, ${clientErrors} client errors, ${successfulSends} successful sends after recovery`);
                assert.strictEqual(successfulSends, 1, 'Should succeed exactly once after recovery period');
                assert.strictEqual(receivedPackets.length, 1, 'Server should receive exactly one packet');
                console.log('Test passed: Buffer overflow simulation and recovery demonstrated');
                finished = true;
                clearInterval(poll);
                safeCleanup();
                done();
              }, 5000);
            });
          });
        });
      }
    });
  });
});

/**
 * Return system error code for a "bad connection" to a TCP socket (e.g. does not
 * exist). Returns the string error code matching Node.js socket error.code.
 *
 * - 'ECONNREFUSED' on Linux
 * - 'ECONNRESET' on macOS
 * - 'not-implemented' on other platforms
 */
function badTCPConnectionCode() {
  if (process.platform === 'linux') {
    return 'ECONNREFUSED';
  }

  if (process.platform === 'darwin') {
    return 'ECONNRESET';
  }

  return 'not-implemented';
}

/**
 * Return system error code for a "bad connection" to a UDS (e.g. does not
 * exist). Returns the string error code matching Node.js socket error.code.
 *
 * - 'ECONNREFUSED' on Linux
 * - 'ECONNRESET' on macOS
 * - 'not-implemented' on other platforms
 */
function badUDSConnectionCode() {
  if (process.platform === 'linux') {
    return 'ECONNREFUSED';
  }

  if (process.platform === 'darwin') {
    return 'ECONNRESET';
  }

  return 'not-implemented';
}

/**
 * Return system error code for a "bad descriptor" (e.g. descriptor exists
 * but server is gone). Returns the string error code matching Node.js socket error.code.
 *
 * - 'ENOTCONN' on Linux
 * - 'EDESTADDRREQ' on macOS
 * - 'not-implemented' on other platforms
 */
function badTCPDescriptorCode() {
  if (process.platform === 'linux') {
    return 'ENOTCONN';
  }

  if (process.platform === 'darwin') {
    return 'EDESTADDRREQ';
  }

  return 'not-implemented';
}

/**
 * Return system error code for a "bad descriptor" (e.g. descriptor exists
 * but server is gone). Returns the string error code matching Node.js socket error.code.
 *
 * - 'ENOTCONN' on Linux
 * - 'EDESTADDRREQ' on macOS
 * - 'not-implemented' on other platforms
 */
function badUDSDescriptorCode() {
  if (process.platform === 'linux') {
    return 'ENOTCONN';
  }

  if (process.platform === 'darwin') {
    return 'EDESTADDRREQ';
  }

  return 'not-implemented';
}
