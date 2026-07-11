# hot-shots

A Node.js client for Datadog's [DogStatsD](http://docs.datadoghq.com/guides/dogstatsd/) server, InfluxDB's [Telegraf](https://github.com/influxdb/telegraf) StatsD server, the OpenTelemetry Collector [StatsD receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/statsdreceiver), and Etsy's [StatsD](https://github.com/etsy/statsd) server.

This project was originally a fork off of [node-statsd](https://github.com/sivy/node-statsd).  This project
includes many additional changes, including:
* uds (Unix domain socket) and tcp protocol support
* TypeScript types
* Telegraf support
* Datadog mode
* events
* child clients
* debug logging
* client-side aggregation
* much more, including many bug fixes

You can read about all changes in [the changelog](CHANGES.md).

hot-shots supports Node 18.x and higher. When using types.d.ts, hot-shots require TypeScript 4.0 or higher.

![Build Status](https://github.com/bdeitte/hot-shots/actions/workflows/node-test.js.yml/badge.svg)

## Table of contents

- [Example](#example)
- [Usage](#usage)
  - [StatsD methods](#statsd-methods)
- [Errors](#errors)
  - [Callback semantics](#callback-semantics)
  - [Congestion error](#congestion-error)
  - [Sending metrics during process shutdown](#sending-metrics-during-process-shutdown)
- [Datadog, Telegraf, and OpenTelemetry functionality](#datadog-telegraf-and-opentelemetry-functionality)
  - [Datadog mode](#datadog-mode)
  - [Datadog's Unix domain socket support](#datadogs-unix-domain-socket-support)
  - [Datadog Telemetry](#datadog-telemetry)
  - [OpenTelemetry Collector Compatibility](#opentelemetry-collector-compatibility)
- [Client-side aggregation](#client-side-aggregation)
  - [Flushing buffered metrics](#flushing-buffered-metrics)
- [Sanitization](#sanitization)
- [Debugging](#debugging)
- [Submitting changes](#submitting-changes)
- [Package versioning and security](#package-versioning-and-security)
- [License](#license)

## Example

```javascript
// CommonJS
const StatsD = require('hot-shots');
const client = new StatsD();

client.increment('my_counter');
```

```javascript
// ESM
import StatsD from 'hot-shots';
const client = new StatsD();

client.gauge('my_gauge', 123.45);
```

```typescript
// TypeScript
import StatsD, { type ClientOptions } from 'hot-shots';
const options: ClientOptions = {
  port: 8125,
  globalTags: { env: 'production' }
};
const client = new StatsD(options);

client.histogram('my_histogram', 42)
```

## Usage

All initialization parameters are optional.

Parameters (specified as one object passed into hot-shots):

* `host`:        The host to send stats to, if not set, the constructor tries to
  retrieve it from the `DD_AGENT_HOST` environment variable, `default: 'undefined'` which as per [UDP/datagram socket docs](https://nodejs.org/api/dgram.html#dgram_socket_send_msg_offset_length_port_address_callback) results in `127.0.0.1` or `::1` being used.
* `port`:        The port to send stats to, if not set, the constructor tries to retrieve it from the `DD_DOGSTATSD_PORT` environment variable, `default: 8125`
* `prefix`:      What to prefix each stat name with `default: ''`. A period separator is automatically added if not present (e.g. `my_prefix` becomes `my_prefix.`).
* `suffix`:      What to suffix each stat name with `default: ''`. A period separator is automatically added if not present (e.g. `my_suffix` becomes `.my_suffix`).
* `tagPrefix`:   Prefix tag list with character `default: '#'`. Note does not work with `telegraf` option.
* `tagSeparator`: Separate tags with character `default: ','`. Note does not work with `telegraf` option.
* `globalize`:   Expose this StatsD instance globally. `default: false`
* `cacheDns`:    Caches dns lookup to *host* for *cacheDnsTtl*, only used
  when protocol is `udp`, `default: false`
* `cacheDnsTtl`: time-to-live of dns lookups in milliseconds, when *cacheDns* is enabled. `default: 60000`
* `mock`:        Create a mock StatsD instance, using a mock transport that doesn't create real sockets.
  Stats are not sent to the server but can be read from mockBuffer for testing.  Note that
  mockBuffer will keep growing, so only use for testing or clear out periodically. `default: false`
* `globalTags`:  Tags that will be added to every metric. Can be either an object or list of tags. `default: {}`.
* `includeDataDogTags`: Whether to include DataDog tags to the global tags. `default: true`. The following *Datadog* tags are appended to `globalTags` from the corresponding environment variable if the latter is set:
  * `dd.internal.entity_id` from `DD_ENTITY_ID` ([docs](https://docs.datadoghq.com/developers/dogstatsd/?tab=kubernetes#origin-detection-over-udp))
  * `env` from `DD_ENV` ([docs](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/?tab=kubernetes#full-configuration))
  * `service` from `DD_SERVICE` ([docs](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/?tab=kubernetes#full-configuration))
  * `version` from `DD_VERSION` ([docs](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/?tab=kubernetes#full-configuration))

  In addition, comma-delimited tags from the `DD_TAGS` environment variable (or its legacy alias `DATADOG_TAGS`) are added to `globalTags`. For example `DD_TAGS=rack:1,team:core` adds `rack:1` and `team:core`. These are applied before the `DD_ENV`/`DD_SERVICE`/`DD_VERSION` mapping above, so those env vars win on a key conflict.
* `maxBufferSize`: If larger than 0,  metrics will be buffered and only sent when the string length is greater than the size. `default: 0` for udp and tcp.  `default: 8192` for uds.
* `bufferFlushInterval`: If buffering is in use, this is the time in ms to always flush any buffered metrics. `default: 1000`
* `telegraf`:    Use Telegraf's StatsD line protocol, which is slightly different than the rest `default: false`
* `sampleRate`:    Sends only a sample of data to StatsD for all StatsD methods.  Can be overridden at the method level. `default: 1`
* `errorHandler`: A function with one argument. It is called to handle various errors. `default: none`, errors are thrown/logger to console
* `useDefaultRoute`: Use the default interface on a Linux system. Useful when running in containers
* `protocol`: Use `tcp` option for TCP protocol, or `uds` for the Unix Domain Socket protocol or `stream` for the raw stream. Defaults to `udp` otherwise.
* `path`: Used only when the protocol is `uds`. Defaults to `/var/run/datadog/dsd.socket`.
* `stream`: Reference to a stream instance. Used only when the protocol is `stream`.

If no transport options (`host`, `port`, `protocol`, `path`, `stream`) are passed, the transport can be configured from environment variables for parity with the official DogStatsD clients (these are Datadog-agent variables and are ignored for `telegraf` clients):
* `DD_DOGSTATSD_URL`: A transport URL. `udp://host[:port]` configures UDP (port defaults to 8125), while `unix:///path/to/socket` or `unixgram:///path/to/socket` configures a Unix Domain Socket. The `unixstream://` scheme is not supported.
* `DD_DOGSTATSD_SOCKET`: A Unix Domain Socket path (used when `DD_DOGSTATSD_URL` is not set, or is set but invalid/unsupported).

Precedence is: explicit transport options > `DD_DOGSTATSD_URL` > `DD_DOGSTATSD_SOCKET` > `DD_AGENT_HOST`/`DD_DOGSTATSD_PORT`.
* `tcpGracefulErrorHandling`: Used only when the protocol is `tcp`. Boolean indicating whether to handle socket errors gracefully. Defaults to true.
* `tcpGracefulRestartRateLimit`: Used only when the protocol is `tcp`. Time (ms) between re-creating the socket. Defaults to `1000`.
* `udsGracefulErrorHandling`: Used only when the protocol is `uds`. Boolean indicating whether to handle socket errors gracefully. Defaults to true.
* `udsGracefulRestartRateLimit`: Used only when the protocol is `uds`. Time (ms) between re-creating the socket. Defaults to `1000`.
* `closingFlushInterval`: Before closing, StatsD will check for inflight messages. Time (ms) between each check. Defaults to `50`.
* `udsRetryOptions`: Used only when the protocol is `uds`. Retry/backoff options for UDS sends:
  * `retries`: Number of retry attempts for failed packet sends. Defaults to `3`.
  * `retryDelayMs`: Initial delay in milliseconds before retrying a failed packet send. Defaults to `100`.
  * `maxRetryDelayMs`: Maximum delay in milliseconds between retry attempts (caps exponential backoff). Defaults to `1000`.
  * `backoffFactor`: Exponential backoff multiplier for retry delays. Defaults to `2`.
* `udpSocketOptions`: Used only when the protocol is `udp`. Specify the options passed into dgram.createSocket(). The socket type (`udp4` or `udp6`) is auto-detected based on the host: IPv6 addresses (e.g., `::1`) use `udp6`, IPv4 addresses use `udp4`, and hostnames default to `udp4`. You can override auto-detection by explicitly setting `type` (e.g., `{ type: 'udp6' }`).
* `includeDatadogTelemetry`: Enable client-side telemetry to track metrics about the client itself. This helps diagnose high-throughput metric delivery issues. Telemetry metrics are prefixed with `datadog.dogstatsd.client.` and are not billed as custom metrics. `default: false`, except it defaults to `true` whenever Datadog mode is active (an explicit `datadog: true` or one of the Datadog signal env vars listed under the `datadog` option). An explicit value always wins. See [Client-Side Telemetry](#client-side-telemetry) for details.
* `telemetryFlushInterval`: When telemetry is enabled, how often (in ms) to send telemetry metrics. `default: 10000`
* `datadog`: Enable Datadog mode, turning on origin detection (`|c:`), External Data (`|e:`), cardinality (`|card:`), and client telemetry. Pass `true`/`false` to force it (like `telegraf`). When unset, it auto-detects: enabled when not using `telegraf` and a Datadog signal env var is set (`DD_AGENT_HOST`, `DD_DOGSTATSD_PORT`, `DD_ENTITY_ID`, `DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_EXTERNAL_ENV`, `DD_CARDINALITY`, `DD_TAGS`, `DD_DOGSTATSD_URL`, `DD_DOGSTATSD_SOCKET`). Note that the legacy `DATADOG_TAGS` alias does **not** auto-enable Datadog mode — only `DD_TAGS` is treated as a signal. The `uds` protocol alone does **not** auto-enable Datadog mode — set `datadog: true` explicitly if you want it. `default: auto-detect`
* `originDetection`: When in Datadog mode, auto-detect the container ID from cgroups and send it as `|c:` for [origin detection](https://docs.datadoghq.com/developers/dogstatsd/?tab=kubernetes#origin-detection-over-udp). Respects `DD_ORIGIN_DETECTION_ENABLED`. Linux only. `default: true in datadog mode`
* `containerID`: Manually set the container ID (skips cgroup parsing). Only used in Datadog mode. `default: undefined`
* `cardinality`: Client-wide default tag cardinality sent as `|card:` — one of `none`, `low`, `orchestrator`, `high`. Falls back to the `DD_CARDINALITY` / `DATADOG_CARDINALITY` env var. Only used in Datadog mode. `default: undefined`
* `aggregation`: Opt in to client-side aggregation of counts, gauges and sets before sending, reducing packet volume for hot metrics. Pass `true` to enable with defaults, or an object `{ flushInterval, maxContexts }` to configure the flush interval (ms, `default: 2000`) and the max distinct contexts held per flush window (`default: 5000`). `default: false`. See [Client-side aggregation](#client-side-aggregation) for details.

### StatsD methods
All StatsD methods other than `event`, `close`, and `check` have the same API:
* `name`:       Stat name `required`
* `value`:      Stat value `required except in increment/decrement where it defaults to 1/-1 respectively`
* `sampleRate`: Sends only a sample of data to StatsD `default: 1`
* `tags`:       The tags to add to metrics. Can be either an object `{ tag: "value"}` or an array of tags. `default: []`
* `callback`:   See [Callback semantics](#callback-semantics) for details, as the contract differs between unbuffered (`maxBufferSize === 0`) and buffered (`maxBufferSize > 0`) mode.

Alternatively, you can pass an options object in place of `sampleRate` and `tags`:
* `options`:    An object with optional properties:
  * `sampleRate`: Sends only a sample of data to StatsD `default: 1`
  * `tags`:       The tags to add to metrics `default: []`
  * `timestamp`:  A timestamp to associate with the metric. Can be a `Date` object or Unix timestamp in seconds. (DogStatsD only, ignored for Telegraf)
  * `cardinality`:  Tag cardinality for this metric (`none`/`low`/`orchestrator`/`high`). Overrides the client-wide `cardinality`. (DogStatsD datadog mode only)
* `callback`:   See [Callback semantics](#callback-semantics) below.

If an array is specified as the `name` parameter each item in that array will be sent along with the specified value.

#### `close`
The close method has the following API:

* `callback`:   The callback to execute once close is complete.  All other calls to statsd will fail once this is called.

#### `event`
The event method has the following API:

* `title`:       Event title `required`
* `text`:        Event description `default is title`
* `options`:     Options for the event
  * `date_happened`    Assign a timestamp to the event `default is now`
  * `hostname`         Assign a hostname to the event.
  * `aggregation_key`  Assign an aggregation key to the event, to group it with some others.
  * `priority`         Can be ‘normal’ or ‘low’ `default: normal`
  * `source_type_name` Assign a source type to the event.
  * `alert_type`       Can be ‘error’, ‘warning’, ‘info’ or ‘success’ `default: info`
  * `cardinality`      Tag cardinality (`none`/`low`/`orchestrator`/`high`). (DogStatsD datadog mode only)
* `tags`:       The tags to add to metrics. Can be either an object `{ tag: "value"}` or an array of tags. `default: []`
* `callback`:   The callback to execute once the metric has been sent.

#### `check`
The check method has the following API:

* `name`:        Check name `required`
* `status`:      Check status `required`
* `options`:     Options for the check
  * `date_happened`    Assign a timestamp to the check `default is now`
  * `hostname`         Assign a hostname to the check.
  * `message`          Assign a message to the check.
  * `cardinality`      Tag cardinality (`none`/`low`/`orchestrator`/`high`). (DogStatsD datadog mode only)
* `tags`:       The tags to add to metrics. Can be either an object `{ tag: "value"}` or an array of tags. `default: []`
* `callback`:   The callback to execute once the metric has been sent.

```javascript
  var StatsD = require('hot-shots'),
      client = new StatsD({
          port: 8020,
          globalTags: { env: process.env.NODE_ENV },
          errorHandler: errorHandler,
      });

  // Increment: Increments a stat by a value (default is 1)
  client.increment('my_counter');

  // Decrement: Decrements a stat by a value (default is -1)
  client.decrement('my_counter');

  // Histogram: send data for histogram stat (DataDog and Telegraf only)
  client.histogram('my_histogram', 42);

  // Distribution: Tracks the statistical distribution of a set of values across your infrastructure.
  // (DataDog v6)
  client.distribution('my_distribution', 42);

  // Gauge: Gauge a stat by a specified amount
  client.gauge('my_gauge', 123.45);

  // Gauge: Gauge a stat by a specified amount, but change it rather than setting it
  client.gaugeDelta('my_gauge', -10);
  client.gaugeDelta('my_gauge', 4);

  // Set: Counts unique occurrences of a stat (alias of unique)
  client.set('my_unique', 'foobar');
  client.unique('my_unique', 'foobarbaz');

  // Event: sends the titled event (DataDog only)
  client.event('my_title', 'description');

  // Check: sends a service check (DataDog only)
  client.check('service.up', client.CHECKS.OK, { hostname: 'host-1' }, ['foo', 'bar'])

  // Incrementing multiple items
  client.increment(['these', 'are', 'different', 'stats']);

  // Incrementing with tags
  client.increment('my_counter', ['foo', 'bar']);

  // Incrementing with tags and a callback (value defaults to 1)
  client.increment('my_counter', { env: 'production' }, function(error, bytes) {
    console.log('Sent counter with tags');
  });

  // Sampling, this will sample 25% of the time the StatsD Daemon will compensate for sampling
  client.increment('my_counter', 1, 0.25);

  // Tags, this will add user-defined tags to the data
  // (DataDog and Telegraf only)
  client.histogram('my_histogram', 42, ['foo', 'bar']);

  // Options object, allows combining sampleRate, tags, and timestamp
  // (DataDog only for timestamp)
  client.gauge('my_gauge', 42, { sampleRate: 0.25, tags: ['foo', 'bar'] });

  // Timestamp: send a metric with a specific timestamp (DataDog only)
  client.gauge('my_gauge', 42, { timestamp: new Date('2022-01-01') });
  client.increment('my_counter', 1, { timestamp: 1640995200 }); // Unix seconds

  // Using the callback. This (error, bytes) signature applies in unbuffered mode
  // (maxBufferSize === 0). In buffered mode the per-metric callback fires
  // synchronously with no arguments — see "Callback semantics" below.
  client.set(['foo', 'bar'], 42, function(error, bytes){
    //this only gets called once after all messages have been sent
    if(error){
      console.error('Oh noes! There was an error:', error);
    } else {
      console.log('Successfully sent', bytes, 'bytes');
    }
    });

  // Timing: sends a timing command with the specified milliseconds
  client.timing('response_time', 42);

  // Timing: also accepts a Date object of which the difference is calculated
  client.timing('response_time', new Date());

  // Timing: measuring elapsed time with Date.now()
  var startTime = Date.now();
  // ... your code here ...
  client.timing('response_time', Date.now() - startTime);

  // Timer: Returns a function that you call to record how long the first
  // parameter takes to execute (in milliseconds) and then sends that value
  // using 'client.timing'.
  // The parameters after the first one (in this case 'fn')
  // match those in 'client.timing'.
  var fn = function(a, b) { return a + b };
  client.timer(fn, 'fn_execution_time')(2, 2);

  // Async timer: Similar to timer above, but you instead pass in a function
  // that returns a Promise.  And then it returns a Promise that will record the timing.
  var fn = function () { return new Promise(function (resolve, reject) { setTimeout(resolve, n); }); };
  var instrumented = statsd.asyncTimer(fn, 'fn_execution_time');
  instrumented().then(function() {
    console.log('Code run and metric sent');
  });

  // Async timer: Similar to asyncTimer above, but it instead emits a distribution.
  var fn = function () { return new Promise(function (resolve, reject) { setTimeout(resolve, n); }); };
  var instrumented = statsd.asyncDistTimer(fn, 'fn_execution_time');
  instrumented().then(function() {
    console.log('Code run and metric sent');
  });

  // Async timer with dynamic tags: Add tags during function execution based on results
  // The ctx parameter is passed as the last argument to your function and is optional to use
  var fetchData = function (url, ctx) {
    return fetch(url).then(function(response) {
      ctx.addTags({ status: response.status, cached: 'false' });
      return response.json();
    });
  };
  var instrumentedFetch = statsd.asyncTimer(fetchData, 'api_call_time');
  instrumentedFetch('/api/data').then(function(data) {
    console.log('Data fetched with timing recorded');
  });

  // Timer without using dynamic tags (ctx parameter can be ignored)
  var simpleAdd = function (a, b) {
    return a + b;
  };
  var instrumentedAdd = statsd.timer(simpleAdd, 'add_time');
  instrumentedAdd(2, 3); // ctx is passed but simpleAdd doesn't use it

  // Sampling, tags and callback are optional and could be used in any combination (DataDog and Telegraf only)
  client.histogram('my_histogram', 42, 0.25); // 25% Sample Rate
  client.histogram('my_histogram', 42, { tag: 'value'}); // User-defined tag
  client.histogram('my_histogram', 42, ['tag:value']); // Tags as an array
  client.histogram('my_histogram', 42, next); // Callback
  client.histogram('my_histogram', 42, 0.25, ['tag']);
  client.histogram('my_histogram', 42, 0.25, next);
  client.histogram('my_histogram', 42, { tag: 'value'}, next);
  client.histogram('my_histogram', 42, 0.25, { tag: 'value'}, next);

  // Use a child client to add more context to the client.
  // Clients can be nested.
  var childClient = client.childClient({
    prefix: 'additionalPrefix.',
    suffix: '.additionalSuffix',
    globalTags: { globalTag1: 'forAllMetricsFromChildClient'}
  });
  childClient.increment('my_counter_with_more_tags');

  // Close statsd.  This will ensure all stats are sent and stop statsd
  // from doing anything more.
  client.close(function(err) {
    console.log('The close did not work quite right: ', err);
  });

  // UDS client with automatic retry on packet failures
  var client = new StatsD({
      protocol: 'uds',
      path: '/var/run/datadog/dsd.socket',
      udsRetryOptions: {
        // Retry options (all optional, showing defaults):
        // retries: 3,           // Number of retry attempts (set to 0 to disable)
        // retryDelayMs: 100,    // Initial delay in ms
        // maxRetryDelayMs: 1000,// Maximum delay cap in ms
        // backoffFactor: 2      // Exponential backoff multiplier
      }
  });
```

## Errors

You can have an error in both the message and close callbacks. See [Callback semantics](#callback-semantics) below for the exact contract per mode.

If the optional callback is not given, an error is thrown in some cases and a console.error message is used in others. An error will only be explicitly thrown when there is a missing callback or if it is some potential configuration issue to be fixed.

For broad error coverage, specify an `errorHandler` in your root client. It catches errors in socket setup, sending of messages, and closing of the socket.

In unbuffered mode (`maxBufferSize === 0`), if you specify both an `errorHandler` and a per-metric callback, the callback takes precedence. In buffered mode (`maxBufferSize > 0`), per-metric callbacks do not receive send errors from periodic or overflow-driven flushes — those errors go to `errorHandler` (or are logged). See [Callback semantics](#callback-semantics) for details.

### Callback semantics

The per-metric `callback` argument has different behavior depending on whether buffering is enabled:

Unbuffered mode (`maxBufferSize === 0`, the default for UDP/TCP):
- On the successful send path the callback is invoked asynchronously after the underlying transport completes, with signature `(error, bytes)` — `error` is `null` and `bytes` is the number of bytes written.
- On failure `error` is set. Some failure paths invoke the callback synchronously before any async send happens — for example, a cached DNS lookup error or a missing socket. Sampled-out metrics also invoke the callback synchronously, with no arguments.
- If you specify both `errorHandler` and `callback`, the callback takes precedence — the error is reported to the callback only.

Buffered mode (`maxBufferSize > 0`, the default for UDS):
- The callback is a synchronous completion signal for the client call: it is invoked synchronously with no arguments once `hot-shots` has finished handling the call (queued into the buffer, or skipped because of sampling).
- It is not a delivery signal — the actual UDP/TCP/UDS send happens later, when the buffer fills or the flush interval fires.
- Send failures from the periodic flush interval and overflow-driven flush are routed to `errorHandler` (or logged), never to the per-metric callback.

`close`'s callback receives an error as its first parameter on failure. On the success path it fires after the socket close completes. On a flush failure it fires early with the error and the socket close is skipped — your code should not assume the socket has been closed when the callback receives an error.

```javascript
// Using errorHandler
var client = new StatsD({
  errorHandler: function (error) {
    console.error("Socket errors caught here: ", error);
  }
})
```

### Congestion error

If you get an error like `Error sending hot-shots message: Error: congestion` with an error code of `1`,
it is probably because you are sending large volumes of metrics to a single agent/ server.
This error only arises when using the UDS protocol and means that packages are being dropped.
Take a look at the [Datadog docs](https://docs.datadoghq.com/developers/dogstatsd/high_throughput/?#over-uds-unix-domain-socket) for some tips on tuning your connection.

### Sending metrics during process shutdown

Metrics sent from `process.on('exit')` handlers will **not** be delivered. This is a fundamental Node.js limitation, not a bug in hot-shots. When the `exit` event fires, the event loop has stopped processing async operations, so socket send callbacks will never execute.

The same applies to `process.on('uncaughtExceptionMonitor')` since that handler is also synchronous.

Alternatives that work:

Use `beforeExit` for graceful shutdown (fires when event loop is empty but before exit):
```javascript
process.on('beforeExit', (code) => {
  client.increment('app.shutdown');
  client.close();
});
```

Use signal handlers for external shutdown requests:
```javascript
function gracefulShutdown(signal) {
  client.increment('app.shutdown', [`signal:${signal}`]);
  client.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

For uncaught exceptions, use `uncaughtException` (not `uncaughtExceptionMonitor`) and delay exit:
```javascript
process.on('uncaughtException', (err) => {
  client.increment('app.crash');
  client.close(() => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
});
```

## Datadog, Telegraf, and OpenTelemetry functionality

Some of the functionality mentioned above is specific to certain backends and will not work with others.

* datadog parameter - Datadog
* uds option in protocol parameter - Datadog
* distribution method - Datadog
* event method - Datadog
* check method - Datadog
* timestamp option - Datadog
* includeDatadogTelemetry parameter - Datadog
* telemetryFlushInterval parameter - Datadog
* originDetection parameter - Datadog
* containerID parameter - Datadog
* cardinality parameter / option - Datadog
* origin detection (|c:) and external data (|e:) - Datadog
* telegraf parameter - Telegraf
* set / unique method - Datadog or Telegraf

### Datadog mode

When talking to a Datadog Agent, enable Datadog mode to get similar behavior as the official Datadog clients. Datadog mode adds three Datadog protocol-extension fields and turns client telemetry on:

* **Origin detection** (`|c:`) — the container ID is auto-detected from cgroups (Linux only) for [origin detection](https://docs.datadoghq.com/developers/dogstatsd/?tab=kubernetes#origin-detection-over-udp). Disable with `originDetection: false` or `DD_ORIGIN_DETECTION_ENABLED=false`; override with `containerID`.
* **External Data** (`|e:`) — read from the `DD_EXTERNAL_ENV` environment variable (injected by the Datadog Admission Controller).
* **Cardinality** (`|card:`) — set a client-wide default via `cardinality` or `DD_CARDINALITY`, or per metric/event/check via the options object.
* **Telemetry** — `includeDatadogTelemetry` defaults to `true` whenever datadog mode is active (an explicit `datadog: true` or one of the Datadog signal env vars listed under the `datadog` option above). Because the `uds` protocol alone no longer auto-enables datadog mode, bare `uds` clients stay off by default. Set it to `false` to opt out, or `true` to force it on.

Datadog mode never activates for `telegraf` clients, and adds no extension fields when off, so non-Datadog (StatsD/Telegraf/OpenTelemetry) usage is unaffected.

Per-call cardinality example:

```javascript
client.gauge('mem.used', 1234, { tags: ['x:y'], cardinality: 'low' });
```

### Datadog's Unix domain socket support

The 'uds' option as the protocol is to support [Unix Domain Sockets for Datadog](https://docs.datadoghq.com/developers/dogstatsd/unix_socket/).  It has the following limitations:
- It only works where 'node-gyp' works. If you don't know what this is, this
is probably fine for you. If you had an troubles with libraries that
you 'node-gyp' before, you will have problems here as well.
- It does not work on Windows

The above will cause the underlying library that is used, unix-dgram,
to not install properly.  Given the library is listed as an
optionalDependency, and how it's used in the codebase, this install
failure will not cause any problems.  It only means that you can't use
the uds feature.

### Datadog Telemetry

When `includeDatadogTelemetry` is enabled, the client automatically sends telemetry metrics about itself to help diagnose metric delivery issues in high-throughput scenarios. This feature should matche the behavior of official Datadog clients as described in [the docs](https://docs.datadoghq.com/developers/dogstatsd/high_throughput/?tab=go#client-side-telemetry).

Telemetry is automatically disabled when using `mock: true`, `telegraf: true`, or in child clients.

The following metrics are sent every `telemetryFlushInterval` milliseconds (default: 10 seconds):

| Metric | Description |
|--------|-------------|
| `datadog.dogstatsd.client.metrics` | Total number of metrics sent |
| `datadog.dogstatsd.client.metrics_by_type` | Metrics broken down by type (gauge, count, set, timing, histogram, distribution) |
| `datadog.dogstatsd.client.events` | Total number of events sent |
| `datadog.dogstatsd.client.service_checks` | Total number of service checks sent |
| `datadog.dogstatsd.client.bytes_sent` | Total bytes successfully sent |
| `datadog.dogstatsd.client.bytes_dropped` | Total bytes dropped |
| `datadog.dogstatsd.client.packets_sent` | Total packets successfully sent |
| `datadog.dogstatsd.client.packets_dropped` | Total packets dropped |

The `metric_dropped_on_receive` from the official Datadog clients is intentionally omitted. That metric tracks drops on an internal receive channel, which doesn't apply to hot-shots' architecture. Also `bytes_dropped_queue` is omitted as this also didn't fit into how hot-shots works.

All telemetry metrics include these tags:
* `client:nodejs` - Identifies the hot-shots client
* `client_version:<version>` - The hot-shots version
* `client_transport:<protocol>` - The transport protocol (udp, tcp, uds, stream)

Example:

```javascript
var client = new StatsD({
  host: 'localhost',
  includeDatadogTelemetry: true,
  telemetryFlushInterval: 10000  // Optional, default is 10 seconds
});
```

### OpenTelemetry Collector Compatibility

hot-shots is compatible with the [OpenTelemetry Collector's StatsD receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/statsdreceiver). The following features work out of the box:

| Feature | hot-shots Method | OTel Support |
|---------|------------------|--------------|
| Counter | `increment()`, `decrement()` | Yes |
| Gauge | `gauge()` | Yes |
| Gauge delta (+/-) | `gaugeDelta()` | Yes |
| Timer | `timing()` | Yes (converted to gauge/summary/histogram) |
| Histogram | `histogram()` | Yes (treated as timer) |
| Sample rate | All methods | Yes |
| Tags | All methods | Yes |

Example configuration for OpenTelemetry Collector:

```javascript
var client = new StatsD({
  host: 'localhost',
  port: 8125,
  protocol: 'udp'  // or 'tcp'
});

// These all work with OpenTelemetry
client.increment('requests');
client.gauge('queue_size', 100);
client.gaugeDelta('connections', 1);
client.timing('response_time', 250);
client.histogram('request_size', 1024);
```

## Client-side aggregation

hot-shots can optionally aggregate counts, gauges and sets on the client before sending, reducing packet volume for hot metrics. It mirrors the client-side aggregation in the official DogStatsD clients, but it should work for StatsD, DogStatsD and Telegraf clients alike. It is opt-in via the `aggregation` option:

```javascript
const client = new StatsD({ aggregation: true });
// or configure the flush interval (default 2000ms) and/or context cap (default 5000):
const client = new StatsD({ aggregation: { flushInterval: 1000, maxContexts: 5000 } });
```

When enabled, metrics are combined per context (metric type, name, per-call tags, cardinality and the recording client's global tags) and flushed on the aggregation interval, on [`flush()`](#flushing-buffered-metrics), and on `close()`:
* Counts are summed.
* Gauges keep the most recent value.
* Sets emit each unique value once.

The following always bypass aggregation and are sent immediately: histograms, distributions, timings, events and service checks, plus any count/gauge/set that uses a *per-call* sample rate, a timestamp, a delta gauge (`+`/`-` value), or a `NaN` value. A client-level default `sampleRate` does **not** disable aggregation. Child clients share the parent's aggregator instance; clients that differ in their global tags or default cardinality aggregate into separate contexts.

The per-metric callback fires synchronously when a metric is aggregated, as a "queued" signal (the same way buffered mode behaves).

To bound memory, at most `maxContexts` (default 5000) distinct contexts are held per flush window; once the cap is reached, additional new contexts are sent directly without aggregation and a one-time warning is emitted.

### Flushing buffered metrics

`flush([callback])` sends any buffered metrics to the transport immediately, without waiting for the `bufferFlushInterval`. With client-side-aggregation enabled, pending aggregated metrics are flushed into the buffer first. This is useful in serverless and other short-lived environments where you want to ensure metrics are sent before the process freezes or exits.

```javascript
client.increment('my.metric');
client.flush(() => {
  // buffered payload has been handed to the transport
});
```

## Sanitization

To prevent malformed packets, hot-shots automatically replaces protocol-breaking characters with underscores (`_`).

* Metric names: `:`, `|`, `\n`, `\r`
* Tag keys: `:`, `|`, `,`, `\n`, `\r`, plus `@` and `#` for StatsD/Datadog
* Tag values: `|`, `,`, `\n`, `\r`, plus `@` and `#` for StatsD/Datadog

Colons are allowed in tag values (e.g., `url:https://example.com:8080`).

## Debugging

If you're having issues with metrics not being sent or want to understand what hot-shots is doing
in detail, you can enable debug logging using Node.js's built-in `NODE_DEBUG` environment variable:

```bash
NODE_DEBUG=hot-shots node your-app.js
```

## Submitting changes

Thanks for considering making any updates to this project! This project is entirely community-driven, and so your changes are important. Here are the steps to take in your fork:

1. Run "npm install"
2. Add your changes in your fork as well as any new tests needed
3. Run "npm test"
4. Update README.md with any needed documentation
5. If you have made any API changes, update types.d.ts (note: timer/asyncTimer/asyncDistTimer type signatures require TypeScript 4.0+ for variadic tuple support)
6. Push your changes and create the PR

When you've done all this we're happy to try to get this merged in right away.

## Package versioning and security

Versions will attempt to follow semantic versioning, with major changes only coming in major versions.

npm publishing is possible by one person, [bdeitte](https://github.com/bdeitte), who has two-factor authentication enabled for publishes.  Publishes only contain one additional library, [unix-dgram](https://github.com/bnoordhuis/node-unix-dgram).

## License

hot-shots is licensed under the MIT license.
