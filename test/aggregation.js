const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#aggregation', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  it('should sum counts for the same context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.count');
    statsd.increment('agg.count', 2);
    statsd.decrement('agg.count');
    assert.deepStrictEqual(statsd.mockBuffer, []);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.count:2|c']);
  });

  it('should keep the last gauge value', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.gauge', 1);
    statsd.gauge('agg.gauge', 5);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.gauge:5|g']);
  });

  it('should send each unique set value once', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.set('agg.set', 'a');
    statsd.set('agg.set', 'a');
    statsd.set('agg.set', 'b');
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.sort(), ['agg.set:a|s', 'agg.set:b|s']);
  });

  it('should keep different tags in different contexts', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.count', 1, ['route:a']);
    statsd.increment('agg.count', 1, ['route:b']);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.sort(), [
      'agg.count:1|c|#route:a',
      'agg.count:1|c|#route:b',
    ]);
  });

  it('should not be affected by mutating the tags array after recording', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const tags = ['route:a'];
    statsd.increment('agg.count', 1, tags);
    tags[0] = 'route:mutated';
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.count:1|c|#route:a']);
  });

  it('should not aggregate sampled metrics', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, sampleRate: 1 }, 'client');
    statsd.increment('agg.sampled', 1, 0.9999);
    // sampled metrics bypass aggregation entirely: either sent (in mockBuffer
    // with |@) or sampled out (not recorded anywhere)
    statsd.flush();
    statsd.mockBuffer.forEach(entry => {
      assert.ok(entry.includes('|@0.9999'));
    });
  });

  it('should not aggregate delta gauges', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gaugeDelta('agg.gauge', 5);
    statsd.gaugeDelta('agg.gauge', -2);
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.gauge:+5|g', 'agg.gauge:-2|g']);
  });

  it('should not aggregate timestamped metrics', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.ts', 1, { timestamp: 1700000000 });
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.ts:1|c|T1700000000']);
  });

  it('should not aggregate histograms or timings', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.histogram('agg.h', 5);
    statsd.timing('agg.t', 10);
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.h:5|h', 'agg.t:10|ms']);
  });

  it('should invoke the metric callback synchronously when aggregated', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.cb', 1, err => {
      assert.ok(!err);
      done();
    });
  });

  it('should aggregate separately for child clients with different global tags', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, globalTags: ['parent:tag'] }, 'client');
    const child = statsd.childClient({ globalTags: ['child:tag'] });
    statsd.increment('agg.count');
    child.increment('agg.count');
    // Parent and child mock clients each have their own mockBuffer; flushing the
    // shared aggregator sends each context through its recording client.
    statsd.flush();
    const sent = statsd.mockBuffer.concat(child.mockBuffer).sort();
    assert.deepStrictEqual(sent, [
      'agg.count:1|c|#parent:tag',
      'agg.count:1|c|#parent:tag,child:tag',
    ].sort());
  });

  it('should memoize the per-client context suffix', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, globalTags: ['g:1'] }, 'client');
    assert.strictEqual(statsd._aggContextSuffix, undefined);
    statsd.increment('agg.cache');
    const cached = statsd._aggContextSuffix;
    assert.ok(typeof cached === 'string' && cached.indexOf('g:1') !== -1);
    // Overwrite the memo with a sentinel: if the helper recomputed the suffix on
    // every record it would clobber this. The `=== undefined` guard means a second
    // record must leave the already-set value untouched, so the sentinel survives.
    statsd._aggContextSuffix = 'SENTINEL';
    statsd.increment('agg.cache');
    assert.strictEqual(statsd._aggContextSuffix, 'SENTINEL');
  });

  it('should flush aggregated metrics recorded through a child when the child is closed', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        aggregation: { flushInterval: 60000 },
      }), 'client');
      const child = statsd.childClient({});
      child.increment('agg.childclose', 4);
      child.close();
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'agg.childclose:4|c');
      done();
    });
  });

  it('should flush child-recorded aggregated metrics when the parent is closed', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        aggregation: { flushInterval: 60000 },
      }), 'client');
      const child = statsd.childClient({});
      child.increment('agg.parentclose', 7);
      statsd.close();
      statsd = null;
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'agg.parentclose:7|c');
      done();
    });
  });

  it('should flush on the aggregation interval', done => {
    statsd = createHotShotsClient({
      mock: true,
      aggregation: { flushInterval: 25 },
    }, 'client');
    statsd.increment('agg.interval');
    setTimeout(() => {
      assert.deepStrictEqual(statsd.mockBuffer, ['agg.interval:1|c']);
      done();
    }, 100);
  });

  it('should flush aggregated metrics on close', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        aggregation: { flushInterval: 60000 },
      }), 'client');
      statsd.increment('agg.close', 3);
      statsd.close();
      statsd = null;
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'agg.close:3|c');
      done();
    });
  });

  it('should still aggregate when the client default sampleRate is < 1', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true, sampleRate: 0.5 }, 'client');
    statsd.increment('agg.defaultrate');
    statsd.increment('agg.defaultrate');
    // A client-level default sampleRate must not disable aggregation entirely;
    // only an explicit per-call sample rate bypasses it.
    assert.deepStrictEqual(statsd.mockBuffer, []);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.defaultrate:2|c']);
  });

  it('should not aggregate NaN counts into the context sum', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.increment('agg.nan', NaN);
    statsd.increment('agg.nan', 3);
    statsd.flush();
    // The NaN value passes through unaggregated rather than poisoning the sum.
    assert.deepStrictEqual(statsd.mockBuffer.sort(), ['agg.nan:3|c', 'agg.nan:NaN|c'].sort());
  });

  it('should treat object tags differing only in key order as one context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.objorder', 1, { a: '1', b: '2' });
    statsd.gauge('agg.objorder', 5, { b: '2', a: '1' });
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.objorder:5|g|#a:1,b:2']);
  });

  it('should treat array tags differing only in order as one context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.arrorder', 1, ['a:1', 'b:2']);
    statsd.gauge('agg.arrorder', 5, ['b:2', 'a:1']);
    statsd.gauge('agg.arrorder', 2, ['a:1', 'b:2']);
    statsd.flush();
    // One Datadog series: the final recorded value (2) must win, not a stale 5.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.arrorder:2|g|#a:1,b:2']);
  });

  it('should treat object tags with equal String() forms as one context', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.strform', 1, { a: 1 });
    statsd.gauge('agg.strform', 5, { a: '1' });
    statsd.flush();
    // 1 and '1' both emit as a:1, so they must aggregate into one gauge (last wins).
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.strform:5|g|#a:1']);
  });

  it('should not merge object tags whose value is undefined vs null', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.undefnull', 1, { a: undefined });
    statsd.gauge('agg.undefnull', 2, { a: null });
    statsd.flush();
    // These emit different tags (a:undefined vs a:null), so they must stay in
    // separate contexts rather than collapsing into one gauge value.
    assert.strictEqual(statsd.mockBuffer.length, 2);
  });

  it('should not merge object tags whose values are different non-finite numbers', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.nonfinite', 1, { a: NaN });
    statsd.gauge('agg.nonfinite', 2, { a: Infinity });
    statsd.gauge('agg.nonfinite', 3, { a: -Infinity });
    statsd.flush();
    // NaN, Infinity and -Infinity emit as different tags (a:NaN, a:Infinity,
    // a:-Infinity), so they must stay in separate contexts rather than collapsing
    // into one gauge value. JSON.stringify alone would convert all three to null.
    assert.deepStrictEqual(statsd.mockBuffer.sort(), [
      'agg.nonfinite:1|g|#a:NaN',
      'agg.nonfinite:2|g|#a:Infinity',
      'agg.nonfinite:3|g|#a:-Infinity',
    ].sort());
  });

  it('should not merge parent and child contexts that differ in default cardinality', () => {
    statsd = createHotShotsClient({ mock: true, datadog: true, aggregation: true }, 'client');
    const child = statsd.childClient({ cardinality: 'high' });
    statsd.increment('agg.card');
    child.increment('agg.card');
    statsd.flush();
    const sent = statsd.mockBuffer.concat(child.mockBuffer).sort();
    assert.deepStrictEqual(sent, [
      'agg.card:1|c',
      'agg.card:1|c|card:high',
    ].sort());
  });

  it('should merge per-call cardinality that equals the client default', () => {
    statsd = createHotShotsClient({ mock: true, datadog: true, cardinality: 'high', aggregation: true }, 'client');
    statsd.gauge('agg.effcard', 1, { cardinality: 'high' });
    statsd.gauge('agg.effcard', 5);
    statsd.flush();
    // Per-call 'high' and the default 'high' emit identically, so one context (last wins).
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.effcard:5|g|card:high']);
  });

  it('should merge per-call cardinality that differs only in case', () => {
    statsd = createHotShotsClient({ mock: true, datadog: true, aggregation: true }, 'client');
    statsd.gauge('agg.cardcase', 1, { cardinality: 'HIGH' });
    statsd.gauge('agg.cardcase', 5, { cardinality: 'high' });
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.cardcase:5|g|card:high']);
  });

  it('should ignore per-call cardinality for context keying in non-datadog mode', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    statsd.gauge('agg.nocard', 1, { cardinality: 'high' });
    statsd.gauge('agg.nocard', 5, { cardinality: 'low' });
    statsd.flush();
    // Cardinality is never emitted outside datadog mode, so these are one context.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.nocard:5|g']);
  });

  it('should reject an invalid aggregation flushInterval and use the default', () => {
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected validation warning */ };
    try {
      statsd = createHotShotsClient({ mock: true, aggregation: { flushInterval: -5 } }, 'client');
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(statsd.aggregator.flushInterval, 2000);
  });

  it('should track only clients with in-flight routed sends, pruning once drained', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        maxBufferSize: 0,
        aggregation: { flushInterval: 60000 },
      }), 'client');
      const child = statsd.childClient({ globalTags: ['c:1'] });
      // Defer the routed send so it is genuinely in flight after the flush.
      let resolveSend;
      statsd.socket.send = (buf, cb) => {
        resolveSend = cb;
      };
      child.increment('agg.routed');
      // Simulate an interval-driven flush (no arguments). The child's send is in
      // flight, so it is tracked.
      statsd.aggregator.flush();
      assert.ok(statsd.aggregator.activeClients.has(child));
      // Completing the send drains the child, which must prune it from the set.
      resolveSend();
      setImmediate(() => {
        assert.ok(!statsd.aggregator.activeClients.has(child));
        done();
      });
    });
  });

  it('should not silently aggregate metrics recorded after close', done => {
    statsd = createHotShotsClient({ mock: true, aggregation: { flushInterval: 60000 } }, 'client');
    const child = statsd.childClient({});
    statsd.close(() => {
      assert.strictEqual(statsd.aggregator.closed, true);
      child.increment('agg.postclose', 1);
      // The post-close record goes straight through the send path rather than
      // landing in a window that will never flush.
      assert.strictEqual(statsd.aggregator.contexts.size, 0);
      assert.deepStrictEqual(child.mockBuffer, ['agg.postclose:1|c']);
      statsd = null;
      done();
    });
  });

  it('should fall through to direct send once the context cap is reached', () => {
    const originalConsoleError = console.error;
    let overflowLogged = 0;
    console.error = () => { overflowLogged += 1; };
    try {
      statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 2 } }, 'client');
      statsd.gauge('agg.cap', 1, ['k:a']); // context 1 (aggregated)
      statsd.gauge('agg.cap', 2, ['k:b']); // context 2 (aggregated)
      statsd.gauge('agg.cap', 3, ['k:c']); // new -> over cap -> direct send now
      statsd.gauge('agg.cap', 4, ['k:c']); // still over cap -> direct send now
    } finally {
      console.error = originalConsoleError;
    }
    // The two over-cap gauges were sent immediately (not held for flush).
    assert.deepStrictEqual(statsd.mockBuffer, [
      'agg.cap:3|g|#k:c',
      'agg.cap:4|g|#k:c',
    ]);
    assert.strictEqual(overflowLogged, 1, 'overflow should signal exactly once');
    // The two under-cap contexts still flush normally.
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer.slice(2).sort(), [
      'agg.cap:1|g|#k:a',
      'agg.cap:2|g|#k:b',
    ].sort());
  });

  it('should still update an existing context when at the cap', () => {
    const originalConsoleError = console.error;
    console.error = () => { /* suppress overflow signal */ };
    try {
      statsd = createHotShotsClient({ mock: true, aggregation: { maxContexts: 1 } }, 'client');
      statsd.increment('agg.capexisting', 1, ['k:a']);
      statsd.increment('agg.capexisting', 2, ['k:a']); // same context: still aggregates
      statsd.increment('agg.capexisting', 9, ['k:b']); // new over cap: direct send
    } finally {
      console.error = originalConsoleError;
    }
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b']);
    statsd.flush();
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.capexisting:9|c|#k:b', 'agg.capexisting:3|c|#k:a']);
  });

  it('should disable aggregation for telegraf clients', () => {
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected telegraf-disable warning */ };
    try {
      statsd = createHotShotsClient({ mock: true, telegraf: true, aggregation: true }, 'client');
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(statsd.aggregator, null);
    statsd.increment('agg.telegraf');
    // No aggregation: sent immediately instead of held for a flush.
    assert.deepStrictEqual(statsd.mockBuffer, ['agg.telegraf:1|c']);
  });

  it('should not drop remaining contexts when one context send throws', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: true }, 'client');
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected per-context send error */ };
    statsd.gauge('agg.throws', 1, ['k:a']);
    statsd.gauge('agg.ok', 2, ['k:b']);
    // Make the first context's send throw; the second must still be sent.
    const realSend = statsd.send.bind(statsd);
    let threwOnce = false;
    statsd.send = (message, tags, cardinality, cb) => {
      if (!threwOnce && message.indexOf('agg.throws') === 0) {
        threwOnce = true;
        throw new Error('boom');
      }
      return realSend(message, tags, cardinality, cb);
    };
    try {
      statsd.flush();
    } finally {
      console.error = originalConsoleError;
    }
    assert.ok(statsd.mockBuffer.some(m => m.indexOf('agg.ok:2|g') === 0),
      'a throwing context aborted the flush and dropped the remaining context');
  });

  it('should track a child client whose set send starts before a later value throws', () => {
    statsd = createHotShotsClient({ mock: true, aggregation: { flushInterval: 60000 } }, 'client');
    const child = statsd.childClient({ globalTags: ['c:1'] });
    // Record a set with two values so sendContext iterates twice.
    child.set('agg.partialset', 'a');
    child.set('agg.partialset', 'b');
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected send-throw error */ };
    // Simulate the first value going in flight (drainPromise + messagesInFlight)
    // and the second value's send throwing synchronously.
    let calls = 0;
    child.send = () => {
      calls += 1;
      if (calls === 1) {
        child.messagesInFlight = 1;
        child.drainPromise = new Promise(() => { /* stays pending */ });
        return;
      }
      throw new Error('boom on second set value');
    };
    try {
      statsd.aggregator.flush();
    } finally {
      console.error = originalConsoleError;
    }
    // Even though the second value threw, the child had a send in flight from the
    // first value, so it must be tracked for close()/flush() to wait on it.
    assert.ok(statsd.aggregator.activeClients.has(child),
      'partially-sent context did not track its in-flight child client');
    // Reset the simulated in-flight state so afterEach's close() does not wait for
    // a never-resolving drain and emit a force-close warning.
    child.messagesInFlight = 0;
    child.drainPromise = null;
    statsd.aggregator.activeClients.delete(child);
  });
});
