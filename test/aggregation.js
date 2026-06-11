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
});
