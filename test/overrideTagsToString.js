const assert = require('assert');
const StatsD = require('../lib/statsd');
const helpers = require('../lib/helpers');

/**
 * Small seeded generator, so a failure can be reproduced from the case it prints.
 */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['env', 'region', 'service', 'a', 'b', 'a:b', 'a_b', 'with|pipe', 'with,comma', 'at@sign',
  'hash#tag', 'new\nline', 'cr\rkey', 'back\\', '', 'ünï', '0', '1'];
const VALUES = ['prod', 'us-east-1', '', 'a:b', 'http://h:80/p', 'x|y', 'x,y', 'x@y', 'x#y', 'x\ny', 'x\\', 7, true, null];

/**
 * Builds a random tag object, or a random tag array when asArray is set.
 */
function randomTags(rand, asArray) {
  const count = Math.floor(rand() * 5);
  const pick = list => list[Math.floor(rand() * list.length)];
  if (asArray) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(rand() < 0.2 ? String(pick(KEYS)) : `${pick(KEYS)}:${pick(VALUES)}`);
    }
    return out;
  }
  const out = {};
  for (let i = 0; i < count; i++) {
    out[pick(KEYS)] = pick(VALUES);
  }
  return out;
}

describe('#overrideTagsToString', () => {
  /**
   * What send used to do before the cache: merge into an array, then join.
   */
  function reference(globalTags, child, telegraf, separator) {
    let merged = globalTags;
    if (child && typeof child === 'object' &&
        (Array.isArray(child) ? child.length > 0 : Object.keys(child).length > 0)) {
      merged = helpers.overrideTags(globalTags, child, telegraf);
    }
    return merged.length > 0 ? merged.join(separator) : null;
  }

  it('should match overrideTags for generated global and per-call tags', () => {
    const rand = mulberry32(20260101);
    const mismatches = [];
    let cases = 0;
    for (let i = 0; i < 24000; i++) {
      const telegraf = rand() < 0.25;
      const separator = rand() < 0.8 ? ',' : ';';
      const globalTags = helpers.formatTags(randomTags(rand, rand() < 0.3), telegraf);
      const child = rand() < 0.1 ? undefined : randomTags(rand, rand() < 0.3);
      const cache = helpers.buildGlobalTagsCache(globalTags, separator);
      const expected = reference(globalTags, child, telegraf, separator);
      const actual = helpers.overrideTagsToString(cache, child, telegraf);
      cases++;
      if (actual !== expected) {
        mismatches.push({ globalTags, child, telegraf, separator, expected, actual });
      }
    }
    assert.strictEqual(cases, 24000);
    assert.deepStrictEqual(mismatches.slice(0, 3), []);
  });

  it('should not change the global tags or the per-call tags', () => {
    const globalTags = ['env:prod', 'region:us'];
    const child = { env: 'staging' };
    const cache = helpers.buildGlobalTagsCache(globalTags, ',');
    helpers.overrideTagsToString(cache, child, false);
    assert.deepStrictEqual(globalTags, ['env:prod', 'region:us']);
    assert.deepStrictEqual(child, { env: 'staging' });
    assert.strictEqual(cache.joined, 'env:prod,region:us');
  });

  it('should return null when there are no tags at all', () => {
    const cache = helpers.buildGlobalTagsCache([], ',');
    assert.strictEqual(helpers.overrideTagsToString(cache, undefined, false), null);
    assert.strictEqual(helpers.overrideTagsToString(cache, {}, false), null);
    assert.strictEqual(helpers.overrideTagsToString(cache, [], false), null);
  });
});

describe('#send tag merging', () => {
  let statsd;

  /**
   * Sends one metric in mock mode and returns the line it produced.
   */
  function lastMetric(client, tags) {
    client.mockBuffer.length = 0;
    client.increment('m', 1, undefined, tags);
    return client.mockBuffer[0];
  }

  afterEach(done => {
    delete process.env.DD_TAGS;
    delete process.env.DD_ENV;
    if (statsd) {
      statsd.close(() => done());
      statsd = undefined;
    } else {
      done();
    }
  });

  it('should keep global tags in order, then per-call tags, when a per-call tag overrides one', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1', b: '2', c: '3' } });
    assert.strictEqual(lastMetric(statsd, { a: 'x' }), 'm:1|c|#b:2,c:3,a:x');
    assert.strictEqual(lastMetric(statsd, { b: 'x', d: 'y' }), 'm:1|c|#a:1,c:3,b:x,d:y');
    assert.strictEqual(lastMetric(statsd, { a: 'x', b: 'y', c: 'z' }), 'm:1|c|#a:x,b:y,c:z');
  });

  it('should append per-call tags to global tags that they do not override', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1' } });
    assert.strictEqual(lastMetric(statsd, { b: '2', c: '3' }), 'm:1|c|#a:1,b:2,c:3');
  });

  it('should send only per-call tags when there are no global tags', () => {
    statsd = new StatsD({ mock: true });
    assert.strictEqual(lastMetric(statsd, { b: '2' }), 'm:1|c|#b:2');
    assert.strictEqual(lastMetric(statsd, undefined), 'm:1|c');
    assert.strictEqual(lastMetric(statsd, {}), 'm:1|c');
  });

  it('should send only global tags for empty per-call tags', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1' } });
    assert.strictEqual(lastMetric(statsd, undefined), 'm:1|c|#a:1');
    assert.strictEqual(lastMetric(statsd, {}), 'm:1|c|#a:1');
    assert.strictEqual(lastMetric(statsd, []), 'm:1|c|#a:1');
  });

  it('should sanitize per-call tags the way overrideTags does', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1' } });
    assert.strictEqual(lastMetric(statsd, { url: 'http://h:80/p' }), 'm:1|c|#a:1,url:http://h:80/p');
    assert.strictEqual(lastMetric(statsd, { k: 'x|y,z@w#v' }), 'm:1|c|#a:1,k:x_y_z_w_v');
    assert.strictEqual(lastMetric(statsd, { 'bad:key': 'v' }), 'm:1|c|#a:1,bad_key:v');
  });

  it('should override a global tag using a per-call key that sanitizing changes', () => {
    statsd = new StatsD({ mock: true, globalTags: { a_b: '1', c: '2' } });
    assert.strictEqual(lastMetric(statsd, { 'a:b': 'x' }), 'm:1|c|#c:2,a_b:x');
  });

  it('should use the new global tags after globalTags is replaced', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1' } });
    assert.strictEqual(lastMetric(statsd, { b: '2' }), 'm:1|c|#a:1,b:2');
    statsd.globalTags = ['z:9'];
    assert.strictEqual(lastMetric(statsd, { b: '2' }), 'm:1|c|#z:9,b:2');
    assert.strictEqual(lastMetric(statsd, { z: '8' }), 'm:1|c|#z:8');
    statsd.globalTags = [];
    assert.strictEqual(lastMetric(statsd, { b: '2' }), 'm:1|c|#b:2');
  });

  it('should use a custom tag separator and prefix', () => {
    statsd = new StatsD({ mock: true, tagSeparator: ';', tagPrefix: '@', globalTags: { a: '1', b: '2' } });
    assert.strictEqual(lastMetric(statsd, { b: 'x', c: 'y' }), 'm:1|c|@a:1;b:x;c:y');
  });

  it('should include tags from DD_TAGS and DD_ENV as global tags', () => {
    process.env.DD_TAGS = 'team:web,tier:1';
    process.env.DD_ENV = 'staging';
    statsd = new StatsD({ mock: true, globalTags: { a: '1' } });
    assert.strictEqual(lastMetric(statsd, { tier: '2' }), 'm:1|c|#a:1,team:web,env:staging,tier:2');
  });

  it('should merge a child client\'s global tags and per-call tags', () => {
    statsd = new StatsD({ mock: true, globalTags: { a: '1', b: '2' } });
    const child = statsd.childClient({ globalTags: { b: '3', c: '4' } });
    child.mockBuffer = statsd.mockBuffer;
    assert.strictEqual(lastMetric(child, { c: '5', d: '6' }), 'm:1|c|#a:1,b:3,c:5,d:6');
    assert.strictEqual(lastMetric(statsd, { b: 'x' }), 'm:1|c|#a:1,b:x');
  });

  it('should send tags for a telegraf client as before', () => {
    statsd = new StatsD({ mock: true, telegraf: true, globalTags: { a: '1', b: '2' } });
    assert.strictEqual(lastMetric(statsd, { b: 'x' }), 'm,a=1,b=x:1|c');
  });
});
