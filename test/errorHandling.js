const assert = require('assert');
const constants = require('../lib/constants');
const process = require('process');
const path = require('path');
const helpers = require('./helpers/helpers.js');
const { EventEmitter } = require('events');
const net = require('net');

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

  it('should contain an errorHandler that throws on the socket error event', done => {
    // hot-shots registers errorHandler as the socket's 'error' listener, so a
    // throw there escapes through EventEmitter.emit and ends the process.
    const originalConsoleError = console.error;
    const logged = [];
    console.error = msg => logged.push(String(msg));

    statsd = createHotShotsClient({
      host: '127.0.0.1',
      port: 8125,
      errorHandler() {
        throw new Error('listener boom');
      }
    }, 'client');

    statsd.socket.emit('error', new Error('socket blew up'));

    setImmediate(() => {
      console.error = originalConsoleError;
      const contained = logged.filter(msg => msg.includes('listener boom'));
      assert.strictEqual(contained.length, 1,
        `the throw should be reported once with console.error, saw ${JSON.stringify(logged)}`);
      done();
    });
  });

  it('should contain an errorHandler that throws when socket replacement fails', done => {
    // Two calls on this path, both previously bare: createTransport reports the
    // creation failure, then protocolErrorHandler reports that it could not
    // replace the socket. Both run inside a socket 'error' emit.
    const originalConsoleError = console.error;
    const originalConnect = net.connect;
    const logged = [];
    console.error = msg => logged.push(String(msg));

    server = createServer('tcp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        protocol: 'tcp',
        errorHandler() {
          throw new Error('replacement boom');
        }
      }), 'client');

      setTimeout(() => {
        // Make the replacement transport fail to build.
        net.connect = () => {
          throw new Error('connect refused');
        };
        // Old enough to clear the graceful-restart rate limit.
        statsd.socket.createdAt = Date.now() - 60000;
        statsd.socket.emit('error', internalError(badTCPConnectionCode(), 'bad connection'));

        setTimeout(() => {
          net.connect = originalConnect;
          console.error = originalConsoleError;
          // The replacement failed, so protocolErrorHandler returned with the
          // original socket still in place and the client closes normally.
          ignoreErrors = true;
          const contained = logged.filter(msg => msg.includes('replacement boom'));
          assert.ok(contained.length >= 1,
            `the throws should be reported with console.error, saw ${JSON.stringify(logged)}`);
          done();
        }, 20);
      }, 20);
    });
  });

  it('should contain an errorHandler that throws on the send-failure path', done => {
    // README documents that a throwing errorHandler is contained rather than
    // propagated. This is the single-send failure path, where hot-shots calls
    // errorHandler itself from inside the transport's write callback. Without
    // containment the throw escapes as an uncaught exception and ends the
    // process. The stream here reports a write failure without emitting
    // 'error', so only that path is under test.
    const originalConsoleError = console.error;
    const logged = [];
    console.error = msg => logged.push(String(msg));

    const stream = new EventEmitter();
    stream.destroyed = false;
    stream.writableLength = 0;
    stream.write = (chunk, writeCallback) => {
      setImmediate(() => writeCallback(new Error('write failed')));
      return true;
    };
    stream.destroy = () => {
      stream.destroyed = true;
      setImmediate(() => stream.emit('close'));
    };

    statsd = createHotShotsClient({
      protocol: 'stream',
      stream: stream,
      errorHandler() {
        throw new Error('handler boom');
      }
    }, 'client');

    statsd.increment('a');

    setTimeout(() => {
      console.error = originalConsoleError;
      const contained = logged.filter(msg => msg.includes('handler boom'));
      assert.strictEqual(contained.length, 1,
        `the throw should be reported once with console.error, saw ${JSON.stringify(logged)}`);
      done();
    }, 50);
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
          statsd.sendStat = (item, value, type, sampleRate, tags, timestamp, cardinality, callback) => {
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

          it('should re-create the socket on numeric unix-dgram errno for type uds', function (done) {
            const code = badUDSNumericCode();
            if (code === null) {
              // No known unix-dgram numeric errno for this platform
              this.skip();
              return;
            }
            Date.now = () => '4857394578';
            // emit an error, like the real unix-dgram transport would: err.code
            // is a negative numeric errno, not a string name (regression for the
            // v14 string-only check that never matched unix-dgram errors)
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

            it('should still deliver a retry that lands inside close()\'s drain budget', (done) => {
              const socketPath = path.join(__dirname, 'test-retry-drain.sock');
              const received = [];
              const udsServer = createUdsTestServer(socketPath, buf => received.push(buf.toString()));

              if (!udsServer) {
                return done();
              }

              // First attempt reports congestion; the retry falls at the default
              // 100ms, well inside the drain budget (closingFlushInterval * 11).
              const unixDgramModule = require('unix-dgram'); // eslint-disable-line global-require
              const realCreateSocket = unixDgramModule.createSocket;
              let attempts = 0;
              unixDgramModule.createSocket = function(type) {
                const realSocket = realCreateSocket(type);
                const realSend = realSocket.send.bind(realSocket);
                realSocket.send = function(buffer, callback) {
                  attempts++;
                  if (attempts === 1) {
                    return process.nextTick(() => callback(internalError('CONGESTION', 'congestion')));
                  }
                  return realSend(buffer, callback);
                };
                return realSocket;
              };

              // Not assigned to the shared `statsd`; this test closes it itself.
              const client = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                maxBufferSize: 0
              }, 'client');

              client.timing('drain.retry.metric', 100);

              // Closing while the retry is still in backoff must not abandon it:
              // the drain wait exists precisely to let an in-flight send finish,
              // and cancelling retries any earlier would drop this metric.
              client.close(() => {
                setTimeout(() => {
                  unixDgramModule.createSocket = realCreateSocket;
                  udsServer.cleanup();
                  assert.strictEqual(attempts, 2, 'the retry should have been attempted');
                  assert.ok(received.some(msg => msg.includes('drain.retry.metric')),
                    `the retried metric should still be delivered, saw ${JSON.stringify(received)}`);
                  done();
                }, 150);
              });
            });

            it('should abandon a retry still waiting out its backoff when close() runs', (done) => {
              const socketPath = path.join(__dirname, 'test-retry-abandon.sock');
              const udsServer = createUdsTestServer(socketPath);

              if (!udsServer) {
                return done();
              }

              // Every attempt reports congestion, so the send is always sitting in
              // a backoff timer rather than completing.
              const unixDgramModule = require('unix-dgram'); // eslint-disable-line global-require
              const realCreateSocket = unixDgramModule.createSocket;
              unixDgramModule.createSocket = function(type) {
                const realSocket = realCreateSocket(type);
                realSocket.send = function(buffer, callback) {
                  process.nextTick(() => callback(internalError('CONGESTION', 'congestion')));
                };
                return realSocket;
              };

              // Deliberately not assigned to the shared `statsd`: this test closes
              // the client itself, and letting afterEach close it again races that
              // close and trips a native assertion inside unix-dgram.
              const client = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  // Long enough that the retry is certainly still pending at close.
                  retries: 5,
                  retryDelayMs: 2000,
                  backoffFactor: 2
                },
                maxBufferSize: 0
              }, 'client');

              const state = { err: 'not called' };
              client.timing('test.timer', 100, (err) => {
                state.err = err;
              });

              // Let the first attempt fail and schedule its retry, then close.
              setTimeout(() => {
                client.close(() => {
                  setImmediate(() => {
                    unixDgramModule.createSocket = realCreateSocket;
                    udsServer.cleanup();
                    assert.ok(state.err && state.err !== 'not called',
                      'the abandoned retry should fail its callback rather than hang');
                    assert.strictEqual(state.err.code, constants.UDS_RETRY_CANCELLED_CODE);
                    done();
                  });
                });
              }, 50);
            });

            it('should drop the oldest pending retry past the cap rather than grow without bound', (done) => {
              const socketPath = path.join(__dirname, 'test-retry-cap.sock');
              const udsServer = createUdsTestServer(socketPath);

              if (!udsServer) {
                return done();
              }

              // Every attempt reports congestion, so every send parks in a
              // backoff timer holding its buffer and never completes. Without a
              // cap this is the same unbounded growth the tcp/stream and DNS
              // paths already bound.
              const unixDgramModule = require('unix-dgram'); // eslint-disable-line global-require
              const realCreateSocket = unixDgramModule.createSocket;
              unixDgramModule.createSocket = function(type) {
                const realSocket = realCreateSocket(type);
                realSocket.send = function(buffer, callback) {
                  process.nextTick(() => callback(internalError('CONGESTION', 'congestion')));
                };
                return realSocket;
              };

              // Closed by this test, not by afterEach: closing twice races the
              // native unix-dgram socket.
              const client = createHotShotsClient({
                protocol: 'uds',
                path: socketPath,
                udsRetryOptions: {
                  // Long enough that no retry fires during the test.
                  retries: 5,
                  retryDelayMs: 60000,
                  backoffFactor: 2
                },
                maxBufferSize: 0
              }, 'client');

              const overflow = 25;
              const total = constants.UDS_MAX_PENDING_RETRIES + overflow;
              const dropped = [];
              for (let i = 0; i < total; i++) {
                client.timing(`capped.${i}`, 100, err => {
                  if (err && err.code === constants.UDS_RETRY_QUEUE_FULL_CODE) {
                    dropped.push(i);
                  }
                });
              }

              // Drops are deferred a tick, and each send needs a tick to report
              // congestion before it parks, so let the whole batch settle.
              setTimeout(() => {
                client.close(() => {
                  setImmediate(() => {
                    unixDgramModule.createSocket = realCreateSocket;
                    udsServer.cleanup();
                    assert.strictEqual(dropped.length, overflow,
                      `exactly the ${overflow} oldest sends should be dropped, saw ${dropped.length}`);
                    // The oldest are the ones evicted, so the dropped indexes are
                    // the first `overflow` sends in order.
                    const expected = [];
                    for (let i = 0; i < overflow; i++) {
                      expected.push(i);
                    }
                    assert.deepStrictEqual(dropped, expected,
                      'the cap should evict the oldest pending retry, not the newest');
                    done();
                  });
                });
              }, 300);
            });

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
              let reported = false;
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
                // Only the first error is the one under test. close() may report
                // a second one later if it gives up on its final flush, so this
                // must not assume a single invocation.
                errorHandler: (err) => {
                  assert.ok(err);
                  if (reported) {
                    return;
                  }
                  reported = true;
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
                // Bounded rather than exact. With retries off the send fails once,
                // and close()'s final flush fails the same way (both are ENOENT
                // against a socket with no server), so two is expected. Anything
                // beyond that would mean a retry happened, which is what this test
                // exists to catch.
                errorHandler: (err) => {
                  assert.ok(err);
                  errorCount++;
                  assert.ok(errorCount <= 2,
                    `retries are off, so expected at most the send plus the close flush, saw ${errorCount}`);
                  if (errorCount > 1) {
                    return;
                  }
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
                // Stop the afterEach from blocking on this client. Its
                // udsRetryOptions allow 20 attempts at up to 800ms, so a send
                // still mid-retry here can take far longer to settle than
                // close()'s CLOSE_FLUSH_TIMEOUT budget. Close it without
                // waiting so the shared afterEach does not race that budget.
                if (statsd === client) {
                  statsd = null;
                }
                client.close();
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
 * Return the Node.js error code string for a "bad connection" to a TCP socket
 * (e.g. server not accepting connections).
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
 * Return the Node.js error code string for a "bad connection" to a UDS
 * (e.g. server not accepting connections or peer reset).
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
 * Return the Node.js error code string for a "bad descriptor" (e.g. descriptor
 * exists but server is gone).
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

/**
 * Return the negative numeric errno that `unix-dgram` sets on `err.code` for a
 * "bad connection" UDS failure. unix-dgram does `err.code = errorno` where
 * errorno is a negative errno (e.g. -111 for ECONNREFUSED on Linux), not a
 * string name. This is the code the real UDS transport produces.
 *
 * - -ECONNREFUSED on Linux
 * - -ECONNRESET on macOS
 * - null on other platforms
 */
function badUDSNumericCode() {
  const errno = require('os').constants.errno; // eslint-disable-line global-require
  if (process.platform === 'linux') {
    return -errno.ECONNREFUSED;
  }

  if (process.platform === 'darwin') {
    return -errno.ECONNRESET;
  }

  return null;
}
