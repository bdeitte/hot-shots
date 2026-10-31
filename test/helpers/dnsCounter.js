const dns = require('dns');

/**
 * Patches dns.lookup to count invocations, so tests can assert on the exact
 * number of lookups a configuration performs. Call restore() in afterEach.
 * @returns {Object} state with count, hostnames and a restore function
 */
function startCounting() {
  const original = dns.lookup;
  const state = {
    count: 0,
    hostnames: [],
    restore: () => {
      dns.lookup = original;
    }
  };
  dns.lookup = function (...lookupArgs) {
    state.count++;
    state.hostnames.push(lookupArgs[0]);
    return original.apply(this, lookupArgs);
  };
  return state;
}

module.exports = {
  startCounting: startCounting
};
