'use strict';

// Counts network and DNS API invocations for the perfTest harness. Attached
// with `node --require`, so it runs before any application code.
//
// IMPORTANT: dns.lookup is patched before dgram/net/http are required as a
// defensive ordering choice. Node's net/dgram/http resolve dns.lookup at call
// time (verified on Node 22 and 24), so the wrappers are picked up regardless.

const dns = require('dns');
const net = require('net');

const counts = {
  dnsLookup: 0,
  dnsLookupIpLiteral: 0,
  dnsLookupHostname: 0,
  dnsResolve: 0,
  dgramSend: 0,
  tcpConnect: 0,
  tcpWrite: 0,
  udsSend: 0,
  httpRequest: 0,
  httpsRequest: 0
};

const dnsByHost = Object.create(null);

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  counts.dnsLookup += 1;
  if (net.isIP(hostname)) {
    counts.dnsLookupIpLiteral += 1;
  } else {
    counts.dnsLookupHostname += 1;
  }
  const key = String(hostname);
  dnsByHost[key] = (dnsByHost[key] || 0) + 1;
  return originalLookup.call(this, hostname, ...rest);
};

for (const name of ['resolve', 'resolve4', 'resolve6']) {
  const original = dns[name];
  dns[name] = function resolveWrapper(...args) {
    counts.dnsResolve += 1;
    return original.apply(this, args);
  };
}

// Safe to require now that dns.lookup is wrapped.
const Module = require('module');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function send(...args) {
  counts.dgramSend += 1;
  return originalDgramSend.apply(this, args);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  counts.tcpConnect += 1;
  return originalConnect.apply(this, args);
};

const originalWrite = net.Socket.prototype.write;
net.Socket.prototype.write = function write(...args) {
  counts.tcpWrite += 1;
  return originalWrite.apply(this, args);
};

// http.get and https.get call their module-local request(), not the export, so
// wrapping both does not double count.
for (const [mod, key] of [[http, 'httpRequest'], [https, 'httpsRequest']]) {
  for (const name of ['request', 'get']) {
    const original = mod[name];
    mod[name] = function httpWrapper(...args) {
      counts[key] += 1;
      return original.apply(this, args);
    };
  }
}

// unix-dgram is a native module required lazily by lib/transport.js, so hook
// the loader to wrap sockets as they are created.
const originalLoad = Module._load;
Module._load = function _load(request, ...rest) {
  const loaded = originalLoad.call(this, request, ...rest);
  if (request === 'unix-dgram' && loaded && typeof loaded.createSocket === 'function' &&
      !loaded.__hotShotsInstrumented) {
    const originalCreateSocket = loaded.createSocket;
    loaded.createSocket = function createSocket(...args) {
      const socket = originalCreateSocket.apply(this, args);
      if (socket && typeof socket.send === 'function') {
        const originalSocketSend = socket.send;
        socket.send = function socketSend(...sendArgs) {
          counts.udsSend += 1;
          return originalSocketSend.apply(this, sendArgs);
        };
      }
      return socket;
    };
    loaded.__hotShotsInstrumented = true;
  }
  return loaded;
};

const outDir = process.env.HS_COUNTS_DIR || '/tmp/hs-counts';

process.on('exit', () => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, counts: counts, dnsByHost: dnsByHost })
    );
  } catch (err) {
    console.error(`hot-shots perfTest instrument: failed to write counts: ${err && err.message}`);
  }
});
