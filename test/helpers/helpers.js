const dgram = require('dgram');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const StatsD = require('../../lib/statsd.js');
const EventEmitter = require('events');
const { Writable } = require('stream');
const { STREAM, TCP, UDP, UDS } = require('../../lib/constants').PROTOCOL;
let unixDgram;
try {
  // this will not always be available
  unixDgram = require('unix-dgram'); // eslint-disable-line global-require
}
catch (err) {
  if (os.platform() !== 'win32') {
    console.error('Error installing unix-dgram: ', err);
  }
}

const CLIENT = 'client';
const CHILD_CLIENT = 'child client';
const CHILD_CHILD_CLIENT = 'child child client';
const TCP_BROKEN = 'tcp_broken';
const UDS_BROKEN = 'uds_broken';

// tcp puts a newline at the end but udp/uds do not
const TCP_METRIC_END = '\n';
const STREAM_METRIC_END = '\n';
const UDP_METRIC_END = '';
const UDS_METRIC_END = '';

const UDS_TEST_PATH = path.join(__dirname, 'test.sock');

// Since sampling uses random, we need to patch Math.random() to always give
// a consistent result
Math.random = () => {
  return 0.42;
};

/**
 * Close the server and stats client, waiting until both are really closed
 */
function closeAll(server, statsd, allowErrors, done) {
  if (! statsd) {
    statsd = { close: (func) => { func(); } };
  }
  if (! server) {
    server = { close: (func) => { func(); } };
  }
  try {
    statsd.close(() => {
      try {
        if (statsd.hasOwnProperty('protocol') && statsd.protocol === UDS) {
          server.close((err) => {
            if (err) {
              console.log('Error on close:', err);
            }
          });
          // this one is synchronous
          done();
        }
        else {
          server.close(() => {
            done();
          });
        }
      }
      catch (err) {
        done(allowErrors ? null : err);
      }
    });
  }
  catch (err) {
    done(allowErrors ? null : err);
  }
}

/**
 * Returns all permutations of test types to run through
 */
function testTypes() {
  const testTypesArr = [[`${UDP} ${CLIENT}`, UDP, CLIENT, UDP_METRIC_END],
    [`${UDP} ${CHILD_CLIENT}`, UDP, CHILD_CLIENT, UDP_METRIC_END],
    [`${UDP} ${CHILD_CHILD_CLIENT}`, UDP, CHILD_CHILD_CLIENT, UDP_METRIC_END],
    [`${TCP} ${CLIENT}`, TCP, CLIENT, TCP_METRIC_END],
    [`${TCP} ${CHILD_CLIENT}`, TCP, CHILD_CLIENT, TCP_METRIC_END]];

   // Not everywhere can run UDS, and we don't want to fail the tests in those places
  if (os.platform() !== 'win32') {
    testTypesArr.push([`${UDS} ${CLIENT}`, UDS, CLIENT, UDS_METRIC_END]);
    testTypesArr.push([`${UDS} ${CHILD_CLIENT}`, UDS, CLIENT, UDS_METRIC_END]);
  }

  testTypesArr.push([`${STREAM} ${CLIENT}`, STREAM, CLIENT, STREAM_METRIC_END]);
  testTypesArr.push([`${STREAM} ${CHILD_CLIENT}`, STREAM, CLIENT, STREAM_METRIC_END]);
  return testTypesArr;
}

/**
 * Returns simple protocol types to test, ignoring child testing
 */
function testProtocolTypes() {
  const protTypesArr = [[`${UDP} ${CLIENT}`, UDP, CLIENT, UDP_METRIC_END],
    [`${TCP} ${CLIENT}`, TCP, CLIENT, TCP_METRIC_END]];
  // Not everywhere can run UDS, and we don't want to fail the tests in those places
  if (os.platform() !== 'win32') {
    protTypesArr.push([`${UDS} ${CLIENT}`, UDS, CLIENT, UDS_METRIC_END]);
  }
  return protTypesArr;
}

/**
 * Create statsd server to send messages to for testing
 */
function createServer(serverType, callback) {
  const onListening = (opts) => {
    callback(Object.assign(opts, { protocol: serverType, bufferFlushInterval: 10 }));
  };

  let server;
  if (serverType === UDP) {
    server = dgram.createSocket('udp4');
    server.on('message', message => {
      const metrics = message.toString();
      server.emit('metrics', metrics);
    });
    server.on('listening', () => {
      onListening(server.address());
    });

    server.bind(0, '127.0.0.1');
  }
  else if (serverType === UDS) {
    // We always have to manually unlink the test socket
    if (fs.existsSync(UDS_TEST_PATH)) { // eslint-disable-line no-sync
      fs.unlinkSync(UDS_TEST_PATH); // eslint-disable-line no-sync
    }

    server = unixDgram.createSocket('unix_dgram', buf => {
      const metrics = buf.toString();
      server.emit('metrics', metrics);
    });
    server.on('listening', () => {
      onListening({ path: UDS_TEST_PATH });
    });
    server.on('error', (err) => {
      console.error('Error: uds connection failed', err);
      onListening({ path: UDS_TEST_PATH });
    });
    server.bind(UDS_TEST_PATH);
  }
  else if (serverType === UDS_BROKEN) {
    // we always have to manually unlink the test socket
    if (fs.existsSync(UDS_TEST_PATH)) { // eslint-disable-line no-sync
      fs.unlinkSync(UDS_TEST_PATH); // eslint-disable-line no-sync
    }

    server = unixDgram.createSocket('unix_dgram', buf => {
      const metrics = buf.toString();
      server.emit('metrics', metrics);
      server.close();
    });
    server.on('listening', () => {
      onListening({ path: UDS_TEST_PATH });
    });
    server.on('error', (err) => {
      console.log('uds connection failed', err);
      onListening({ path: UDS_TEST_PATH });
    });
    server.bind(UDS_TEST_PATH);
  }
  else if (serverType === TCP) {
    server = net.createServer(socket => {
      socket.setEncoding('ascii');
      socket.on('data', data => {
        if (data) {
          server.emit('metrics', data);
        }
      });
    });
    server.on('listening', () => {
      onListening(server.address());
    });

    server.listen(0, 'localhost');
  }
  else if (serverType === TCP_BROKEN) {
    server = net.createServer(socket => {
      socket.setEncoding('ascii');
      socket.on('data', data => {
        if (data) {
          server.emit('metrics', data);
        }
      });
      socket.destroy();
    });
    server.on('listening', () => {
      onListening(server.address());
    });

    server.listen(0, 'localhost');
  }
  else if (serverType === STREAM) {
    server = new EventEmitter();
    server.close = (onClose) => {
      if (onClose) { onClose(); }
    };

    class WritableMock extends Writable {
      _write(chunk, encoding, onFinish) { // eslint-disable-line class-methods-use-this
        onFinish();
        setTimeout(() => server.emit('metrics', chunk.toString()), 10);
      }
    }

    const stream = new WritableMock();
    onListening({ stream });
  }
  else {
    throw new Error(`Unknown server type: ${serverType}`);
  }

  return server;
}

/**
 * Create hot-shots client for usage in tests
 *
 * @param {} args
 * @param {*} clientType
 */
function createHotShotsClient(args, clientType) {
  if (args.protocol === UDS && args.maxBufferSize === undefined) {
    args.maxBufferSize = 1; // use a buffer like normal but shrink to get messages early
  }
   /* eslint-disable require-jsdoc */
  function construct(ctor, constructArgs) {
    function F() {
      return ctor.apply(this, constructArgs);
    }
    F.prototype = ctor.prototype;
    return new F();
  }
  const client = Array.isArray(args) ? construct(StatsD, args) : new StatsD(args);

  if (clientType === CLIENT) {
    return client;
  }
  else if (clientType === CHILD_CLIENT) {
    return client.childClient({});
  }
  else if (clientType === CHILD_CHILD_CLIENT) {
    return client.childClient({}).childClient({});
  }
  else {
    throw new Error(`Unknown client type: ${clientType}`);
  }
}

module.exports = {
  closeAll: closeAll,
  testTypes: testTypes,
  testProtocolTypes: testProtocolTypes,
  createServer: createServer,
  createHotShotsClient: createHotShotsClient,
};
