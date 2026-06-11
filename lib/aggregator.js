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
  const tagsKey = tags === undefined || tags === null ? '' : JSON.stringify(tags);
  return `${type}|${name}|${tagsKey}|${cardinality || ''}|${client.globalTags.join(',')}`;
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
 * which applies tags, datadog extension fields and buffering as usual.
 * @param involvedClients {Set=} Optional Set the flush records each client it
 *   sent a metric through into, so callers can wait for those clients to drain.
 */
Aggregator.prototype.flush = function (involvedClients) {
  if (this.contexts.size === 0) {
    return;
  }
  debug('hot-shots aggregator: flushing %d contexts', this.contexts.size);
  const contexts = this.contexts;
  this.contexts = new Map();
  for (const context of contexts.values()) {
    if (involvedClients) {
      involvedClients.add(context.client);
    }
    if (context.type === 's') {
      for (const value of context.value) {
        context.client.send(`${context.name}:${value}|s`, context.tags, context.cardinality);
      }
    } else {
      context.client.send(`${context.name}:${context.value}|${context.type}`, context.tags, context.cardinality);
    }
  }
};

module.exports = Aggregator;
module.exports.DEFAULT_AGGREGATION_FLUSH_INTERVAL = DEFAULT_AGGREGATION_FLUSH_INTERVAL;
