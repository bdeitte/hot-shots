const helpers = require('./helpers');
const util = require('util');
const debug = util.debuglog('hot-shots');

const DEFAULT_AGGREGATION_FLUSH_INTERVAL = 2000;
const DEFAULT_MAX_CONTEXTS = 5000;

/**
 * Client-side metric aggregator for counts, gauges and sets. Samples recorded
 * here are combined per context (type + full metric name + per-call tags +
 * cardinality + recording client's global tags) and flushed on an interval,
 * reducing packet volume for hot metrics. Matches the basic client-side
 * aggregation in the official DogStatsD clients.
 * @constructor
 * @param options
 *   @option flushInterval {Number=} Interval in ms between flushes. Default 2000.
 *   @option maxContexts {Number=} Max distinct contexts held per flush window; new contexts beyond this are sent directly. Default 5000.
 */
const Aggregator = function (options) {
  options = options || {};
  this.flushInterval = options.flushInterval || DEFAULT_AGGREGATION_FLUSH_INTERVAL;
  this.maxContexts = options.maxContexts || DEFAULT_MAX_CONTEXTS;
  this.overflowSignaled = false;
  this.contexts = new Map();
  // Clients that currently have an in-flight send a flush routed through them.
  // close()/flush() drain these before signaling completion so an interval-driven
  // flush can't leave a child's send in flight. Entries are pruned as soon as the
  // client drains (see trackActive), so this stays bounded to genuinely-active
  // clients rather than accumulating every child ever routed through.
  this.activeClients = new Set();
  // Set true by close() once the aggregator's contexts have been flushed for the
  // last time. sendStat checks this so post-close records fall through to the
  // normal send path (which surfaces the closed-socket error) instead of being
  // silently aggregated into a window that will never flush.
  this.closed = false;
};

/**
 * Tracks a client that a flush just routed a send through, but only while that
 * send is genuinely in flight. The entry removes itself once the client fully
 * drains, re-hooking across any intervening sends, so activeClients never grows
 * without bound for long-lived parents that create child clients dynamically.
 * @param client The client a context was just sent through.
 */
Aggregator.prototype.trackActive = function (client) {
  // No in-flight send (buffered, mock, or already drained) — nothing to wait for.
  if (!client.drainPromise || client.messagesInFlight === 0) {
    return;
  }
  this.activeClients.add(client);
  const recheck = () => {
    if (client.messagesInFlight === 0) {
      this.activeClients.delete(client);
    } else if (client.drainPromise) {
      // A later send is still in flight; follow its drain promise instead.
      client.drainPromise.then(recheck);
    }
  };
  client.drainPromise.then(recheck);
};

/**
 * Returns the client-specific portion of the context key (global tags plus
 * datadog origin fields), memoized on the client. These are fixed at
 * construction time, so the serialized form is computed once per client.
 * @param client The client the metric was recorded through.
 * @returns {String} The cached per-client key suffix.
 */
function clientContextSuffix(client) {
  if (client._aggContextSuffix === undefined) {
    client._aggContextSuffix =
      `${client.globalTags.join(',')}|${client.containerID || ''}|${client.externalData || ''}`;
  }
  return client._aggContextSuffix;
}

/**
 * Builds the aggregation context key for a metric. Includes the recording
 * client's global tags so parent and child clients with different global tags
 * never merge into one context.
 * @param client The client the metric was recorded through.
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param type {String} Metric type code: 'c', 'g' or 's'.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @param cardinality {String=} Per-call cardinality.
 * @returns {String} The context key.
 */
function contextKey(client, name, type, tags, cardinality) {
  let tagsKey;
  if (tags === undefined || tags === null) {
    tagsKey = '';
  } else if (Array.isArray(tags)) {
    // Sort a copy so array tags that differ only in order map to one context (the
    // server treats tag sets as unordered). Emission keeps caller order via
    // cloneTags — only the key is normalized.
    tagsKey = JSON.stringify(tags.slice().sort());
  } else if (typeof tags === 'object') {
    // Sort object keys so tag objects that differ only in key order map to one
    // context — the server treats tag sets as unordered, so otherwise a gauge
    // could deliver a stale final value. Encode each value via String() — its
    // emitted form — so values that format as identical tags map to one context
    // and values that format as distinct tags stay separate. Passing values
    // straight to JSON.stringify would collapse an array-position `undefined`,
    // `NaN`, `Infinity` and `-Infinity` all to `null`, merging contexts that
    // emit as distinct tags (`a:undefined` vs `a:null`, `a:NaN` vs `a:Infinity`
    // vs `a:-Infinity`).
    tagsKey = JSON.stringify(Object.keys(tags).sort().map(k => {
      return [k, String(tags[k])];
    }));
  } else {
    tagsKey = JSON.stringify(tags);
  }
  // Key on the cardinality that will actually be emitted (validated/lowercased,
  // falling back to the client default), and only in datadog mode where it is
  // emitted at all. Mirrors getDatadogExtensionFields so contexts that emit
  // byte-identical cardinality never split.
  const effectiveCardinality = client.datadog ?
    (helpers.validateCardinality(cardinality) || client.cardinality || '') :
    '';
  // Include the recording client's emission-affecting defaults (its global tags
  // plus container id / external data) so two clients — e.g. a parent and a child
  // with different cardinality — never merge into one context that is then
  // emitted with only the first recorder's settings.
  return `${type}|${name}|${tagsKey}|${effectiveCardinality}|${clientContextSuffix(client)}`;
}

/**
 * Clones caller-provided tags so later mutation of the original array/object
 * does not change what gets emitted at flush time.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @returns {Array|Object=} A shallow copy of the tags, or the value unchanged
 *   when there is nothing to copy.
 */
function cloneTags(tags) {
  if (Array.isArray(tags)) {
    return tags.slice();
  }
  if (tags && typeof tags === 'object') {
    return Object.assign({}, tags);
  }
  return tags;
}

/**
 * Signals — at most once for the aggregator's lifetime — that the context cap
 * was reached and further new contexts are being sent directly. Routed through
 * the recording client's errorHandler if set, else console.error.
 * @param client The client whose record triggered the overflow.
 */
Aggregator.prototype.signalOverflow = function (client) {
  if (this.overflowSignaled) {
    return;
  }
  this.overflowSignaled = true;
  const message = `hot-shots: aggregation context limit (${this.maxContexts}) reached; ` +
    'further new contexts are sent directly without aggregation';
  if (client.errorHandler) {
    try {
      client.errorHandler(new Error(message));
    } catch (handlerErr) {
      console.error(`hot-shots: errorHandler threw inside aggregation overflow signal: ${handlerErr && handlerErr.message}`);
    }
  } else {
    console.error(message);
  }
};

/**
 * Records a metric sample into the aggregator. Counts are summed, gauges keep
 * the most recent value, and sets accumulate unique values. Returns true when
 * the sample was aggregated (new or existing context), false when a new context
 * is rejected because the context cap has been reached.
 * @param client The client the metric was recorded through (used at flush time).
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param value The metric value.
 * @param type {String} Metric type code: 'c', 'g' or 's'.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @param cardinality {String=} Per-call cardinality.
 * @returns {boolean} True if aggregated, false if rejected due to the context cap.
 */
Aggregator.prototype.record = function (client, name, value, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  let context = this.contexts.get(key);
  if (!context) {
    // Cap the number of live contexts: a high-cardinality tag would otherwise
    // grow memory for the whole flush window while aggregation saves nothing.
    // A rejected sample falls through to the caller's direct-send path.
    if (this.contexts.size >= this.maxContexts) {
      this.signalOverflow(client);
      return false;
    }
    context = {
      client: client,
      name: name,
      type: type,
      tags: cloneTags(tags),
      cardinality: cardinality,
      value: type === 's' ? new Set() : 0,
    };
    this.contexts.set(key, context);
  }
  if (type === 'c') {
    context.value += value;
  } else if (type === 'g') {
    context.value = value;
  } else {
    context.value.add(value);
  }
  return true;
};

/**
 * Sends a single aggregated context through its recording client's send path,
 * then records that client if its send is left in flight. May throw if the
 * client's send throws synchronously; callers isolate that.
 * @param context The aggregated context to send.
 */
Aggregator.prototype.sendContext = function (context) {
  try {
    if (context.type === 's') {
      for (const value of context.value) {
        context.client.send(`${context.name}:${value}|s`, context.tags, context.cardinality);
      }
    } else {
      context.client.send(`${context.name}:${context.value}|${context.type}`, context.tags, context.cardinality);
    }
  } finally {
    // Track the client even if a send threw partway through a multi-value set:
    // an earlier value may already be in flight, and close()/flush() must wait
    // for it. trackActive no-ops when nothing is actually in flight.
    this.trackActive(context.client);
  }
};

/**
 * If a context matching the given key components is currently pending, remove it
 * and send it immediately. Used to preserve call order when a same-context
 * metric bypasses aggregation (e.g. a delta/NaN/timestamped gauge) and would
 * otherwise reach the wire before the earlier aggregated value.
 * @param client The client the metric was recorded through.
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param type {String} Metric type code.
 * @param tags {Array|Object=} Per-call tags.
 * @param cardinality {String=} Per-call cardinality.
 */
Aggregator.prototype.flushContext = function (client, name, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  const context = this.contexts.get(key);
  if (!context) {
    return;
  }
  this.contexts.delete(key);
  try {
    this.sendContext(context);
  } catch (err) {
    if (context.client.errorHandler) {
      try {
        context.client.errorHandler(err);
      } catch (handlerErr) {
        console.error('hot-shots: errorHandler threw inside aggregator flushContext; ' +
          `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
      }
    } else {
      console.error(`hot-shots: aggregator flushContext send threw: ${err && err.message}`);
    }
  }
};

/**
 * Flushes all aggregated contexts through each context's client send path,
 * which applies tags, datadog extension fields and buffering as usual. Each
 * client whose send is left in flight is recorded in `activeClients` (and pruned
 * once it drains) so close()/flush() can wait for it — including for the
 * interval-driven flushes that pass no arguments.
 */
Aggregator.prototype.flush = function () {
  if (this.contexts.size === 0) {
    return;
  }
  debug('hot-shots aggregator: flushing %d contexts', this.contexts.size);
  const contexts = this.contexts;
  this.contexts = new Map();
  for (const context of contexts.values()) {
    // Isolate each context: a synchronous throw from one client's send must not
    // abort the loop and silently drop every remaining context (their per-metric
    // callbacks already reported success at record time).
    try {
      this.sendContext(context);
    } catch (err) {
      if (context.client.errorHandler) {
        try {
          context.client.errorHandler(err);
        } catch (handlerErr) {
          console.error('hot-shots: errorHandler threw inside aggregator flush; ' +
            `original error: ${err && err.message}; handler error: ${handlerErr && handlerErr.message}`);
        }
      } else {
        console.error(`hot-shots: aggregator flush send threw: ${err && err.message}`);
      }
    }
  }
};

module.exports = Aggregator;
