const util = require('util');
const debug = util.debuglog('hot-shots');

const DEFAULT_AGGREGATION_FLUSH_INTERVAL = 2000;

/**
 * Client-side metric aggregator for counts, gauges and sets. Samples recorded
 * here are combined per context (type + full metric name + per-call tags +
 * cardinality + recording client's global tags) and flushed on an interval,
 * reducing packet volume for hot metrics. Matches the basic client-side
 * aggregation in the official DogStatsD clients.
 * @constructor
 * @param options
 *   @option flushInterval {Number=} Interval in ms between flushes. Default 2000.
 */
const Aggregator = function (options) {
  options = options || {};
  this.flushInterval = options.flushInterval || DEFAULT_AGGREGATION_FLUSH_INTERVAL;
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
    tagsKey = JSON.stringify(tags);
  } else if (typeof tags === 'object') {
    // Sort object keys so tag objects that differ only in key order map to one
    // context — the server treats tag sets as unordered, so otherwise a gauge
    // could deliver a stale final value. Include each value's type so values that
    // format as different tags do not collide: JSON.stringify would otherwise
    // collapse an array-position `undefined` to `null`, merging `{a: undefined}`
    // (emitted as `a:undefined`) with `{a: null}` (emitted as `a:null`).
    tagsKey = JSON.stringify(Object.keys(tags).sort().map(k => {
      return [k, typeof tags[k], tags[k] === undefined ? '' : tags[k]];
    }));
  } else {
    tagsKey = JSON.stringify(tags);
  }
  // Include the recording client's emission-affecting defaults (its global tags
  // plus default cardinality / container id / external data) so two clients —
  // e.g. a parent and a child overriding cardinality — never merge into one
  // context that is then emitted with only the first recorder's settings.
  return `${type}|${name}|${tagsKey}|${cardinality || ''}|${client.globalTags.join(',')}|` +
    `${client.cardinality || ''}|${client.containerID || ''}|${client.externalData || ''}`;
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
 * Records a metric sample into the aggregator. Counts are summed, gauges keep
 * the most recent value, and sets accumulate unique values.
 * @param client The client the metric was recorded through (used at flush time).
 * @param name {String} Full metric name (prefix and suffix already applied).
 * @param value The metric value.
 * @param type {String} Metric type code: 'c', 'g' or 's'.
 * @param tags {Array|Object=} Per-call tags, exactly as passed by the caller.
 * @param cardinality {String=} Per-call cardinality.
 */
Aggregator.prototype.record = function (client, name, value, type, tags, cardinality) {
  const key = contextKey(client, name, type, tags, cardinality);
  let context = this.contexts.get(key);
  if (!context) {
    context = {
      client: client,
      name: name,
      type: type,
      // Clone the caller's tags so mutating them after recording does not change
      // what is emitted when this context is later flushed.
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
    if (context.type === 's') {
      for (const value of context.value) {
        context.client.send(`${context.name}:${value}|s`, context.tags, context.cardinality);
      }
    } else {
      context.client.send(`${context.name}:${context.value}|${context.type}`, context.tags, context.cardinality);
    }
    // Record the client only while its send is genuinely in flight; trackActive
    // self-prunes so this never grows without bound.
    this.trackActive(context.client);
  }
};

module.exports = Aggregator;
module.exports.DEFAULT_AGGREGATION_FLUSH_INTERVAL = DEFAULT_AGGREGATION_FLUSH_INTERVAL;
