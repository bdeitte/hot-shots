const execSync = require('child_process').execSync; // eslint-disable-line no-sync
const StatsD = require('../lib/statsd');
const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

const TIMER_BUFFER = 1000;

describe('#timer', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
    server = null;
    statsd = null;
  });

  testTypes().forEach(([description, serverType, clientType]) => {
    describe(description, () => {

      it('should send stat and time to execute to timing function', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const testFn = (a, b) => {
            return a + b;
          };
          statsd.timer(testFn, 'test')(2, 2);
        });
        server.on('metrics', metrics => {
          // Search for a string similar to 'test:0.123|ms'
          const re = RegExp('(test:)([0-9]+.[0-9]+)\\|{1}(ms)');
          assert.strictEqual(true, re.test(metrics));
          done();
        });
      });

      it('should send data with tags to timing function', done => {
        server = createServer(serverType, opts => {
          statsd = createHotShotsClient(opts, clientType);
          const testFn = (a, b) => {
            return a + b;
          };
          statsd.timer(testFn, 'test', undefined, ['foo', 'bar'])(2, 2);
        });
        server.on('metrics', metrics => {
          // Search for a string similar to 'test:0.123|ms|#foo,bar'
          const re = RegExp('(test:)([0-9]+.[0-9]+)\\|{1}(ms)\\|{1}\\#(foo,bar)');
          assert.strictEqual(true, re.test(metrics));
          done();
        });
      });
    });
  });

  it('should record "real" time of function call', () => {
    statsd = new StatsD({ mock:true });
    const instrumented = statsd.timer(sleep(100), 'blah');

    instrumented();

    const timeFromStatLine = statsd.mockBuffer[0].match(/blah:(\d+\.\d+)\|/)[1];

    assert.ok(timeFromStatLine >= 50);
    assert.ok(timeFromStatLine < (100 + TIMER_BUFFER));
  });

  it('should record "user time" of promise', () => {
    statsd = new StatsD({ mock:true });

    const onehundredMsFunc = () => { return delay(100); };

    const instrumented = statsd.asyncTimer(onehundredMsFunc, 'name-thingy');

    return instrumented().then(() => {

      const stat = statsd.mockBuffer[0];
      const name = stat.split(/:|\|/)[0];
      const time = stat.split(/:|\|/)[1];

      assert.strictEqual(name, 'name-thingy');
      assert.ok(parseFloat(time) >= 50);
      assert.ok(parseFloat(time) < (100 + TIMER_BUFFER));
    });
  });

  it('should record "user time" of promise using a distribution', () => {
    statsd = new StatsD({ mock:true });

    const onehundredMsFunc = () => { return delay(100); };

    const instrumented = statsd.asyncDistTimer(onehundredMsFunc, 'name-thingy');

    return instrumented().then(() => {

      const stat = statsd.mockBuffer[0];
      const name = stat.split(/:|\|/)[0];
      const time = stat.split(/:|\|/)[1];

      assert.strictEqual(name, 'name-thingy');
      console.log('User time: ' + time);
      assert.ok(parseFloat(time) >= 50);
      assert.ok(parseFloat(time) < (100 + TIMER_BUFFER));
    });
  });

  it('asyncTimer should return the resolved value from the wrapped function', () => {
    statsd = new StatsD({ mock: true });

    const valueFunc = (a, b) => Promise.resolve(a + b);
    const instrumented = statsd.asyncTimer(valueFunc, 'test-stat');

    return instrumented(5, 3).then((result) => {
      assert.strictEqual(result, 8);
    });
  });

  it('asyncTimer should propagate rejections from the wrapped function', () => {
    statsd = new StatsD({ mock: true });

    const expectedError = new Error('test-error');
    const errorFunc = () => Promise.reject(expectedError);
    const instrumented = statsd.asyncTimer(errorFunc, 'test-stat');

    return instrumented().
      then(() => {
        assert.fail('Should have rejected');
      }).
      catch((err) => {
        assert.strictEqual(err, expectedError);
      });
  });

  it('asyncDistTimer should return the resolved value from the wrapped function', () => {
    statsd = new StatsD({ mock: true });

    const valueFunc = (a, b) => Promise.resolve(a + b);
    const instrumented = statsd.asyncDistTimer(valueFunc, 'test-stat');

    return instrumented(5, 3).then((result) => {
      assert.strictEqual(result, 8);
    });
  });

  it('asyncDistTimer should propagate rejections from the wrapped function', () => {
    statsd = new StatsD({ mock: true });

    const expectedError = new Error('test-error');
    const errorFunc = () => Promise.reject(expectedError);
    const instrumented = statsd.asyncDistTimer(errorFunc, 'test-stat');

    return instrumented().
      then(() => {
        assert.fail('Should have rejected');
      }).
      catch((err) => {
        assert.strictEqual(err, expectedError);
      });
  });

  describe('dynamic tags via context (issue #202)', () => {
    it('timer should allow adding tags during execution with array', () => {
      statsd = new StatsD({ mock: true });

      const testFn = (a, b, ctx) => {
        ctx.addTags(['dynamic:tag']);
        return a + b;
      };
      const instrumented = statsd.timer(testFn, 'test-stat');
      const result = instrumented(2, 3);

      assert.strictEqual(result, 5);
      assert.ok(statsd.mockBuffer[0].includes('dynamic:tag'));
    });

    it('timer should allow adding tags during execution with object', () => {
      statsd = new StatsD({ mock: true });

      const testFn = (a, b, ctx) => {
        ctx.addTags({ status: 'success', code: 200 });
        return a + b;
      };
      const instrumented = statsd.timer(testFn, 'test-stat');
      instrumented(2, 3);

      assert.ok(statsd.mockBuffer[0].includes('status:success'));
      assert.ok(statsd.mockBuffer[0].includes('code:200'));
    });

    it('timer should merge dynamic tags with static tags', () => {
      statsd = new StatsD({ mock: true });

      const testFn = (a, b, ctx) => {
        ctx.addTags(['dynamic:tag']);
        return a + b;
      };
      const instrumented = statsd.timer(testFn, 'test-stat', undefined, ['static:tag']);
      instrumented(2, 3);

      assert.ok(statsd.mockBuffer[0].includes('static:tag'));
      assert.ok(statsd.mockBuffer[0].includes('dynamic:tag'));
    });

    it('timer should work without using context', () => {
      statsd = new StatsD({ mock: true });

      // Function that ignores the context parameter
      const testFn = (a, b) => {
        return a + b;
      };
      const instrumented = statsd.timer(testFn, 'test-stat', undefined, ['static:tag']);
      const result = instrumented(2, 3);

      assert.strictEqual(result, 5);
      assert.ok(statsd.mockBuffer[0].includes('static:tag'));
    });

    it('asyncTimer should allow adding tags during execution', () => {
      statsd = new StatsD({ mock: true });

      const asyncFn = (value, ctx) => {
        return delay(10).then(() => {
          ctx.addTags({ result: 'ok' });
          return value * 2;
        });
      };
      const instrumented = statsd.asyncTimer(asyncFn, 'async-test');

      return instrumented(5).then((result) => {
        assert.strictEqual(result, 10);
        assert.ok(statsd.mockBuffer[0].includes('result:ok'));
      });
    });

    it('asyncTimer should merge dynamic tags with static tags', () => {
      statsd = new StatsD({ mock: true });

      const asyncFn = (value, ctx) => {
        return delay(10).then(() => {
          ctx.addTags(['dynamic:value']);
          return value;
        });
      };
      const instrumented = statsd.asyncTimer(asyncFn, 'async-test', undefined, ['static:value']);

      return instrumented(5).then(() => {
        assert.ok(statsd.mockBuffer[0].includes('static:value'));
        assert.ok(statsd.mockBuffer[0].includes('dynamic:value'));
      });
    });

    it('asyncTimer should record tags even on rejection', () => {
      statsd = new StatsD({ mock: true });

      const asyncFn = (ctx) => {
        ctx.addTags({ error: 'true' });
        return Promise.reject(new Error('test error'));
      };
      const instrumented = statsd.asyncTimer(asyncFn, 'async-test');

      return instrumented().catch(() => {
        assert.ok(statsd.mockBuffer[0].includes('error:true'));
      });
    });

    it('asyncDistTimer should allow adding tags during execution', () => {
      statsd = new StatsD({ mock: true });

      const asyncFn = (value, ctx) => {
        return delay(10).then(() => {
          ctx.addTags({ result: 'ok' });
          return value * 2;
        });
      };
      const instrumented = statsd.asyncDistTimer(asyncFn, 'dist-test');

      return instrumented(5).then((result) => {
        assert.strictEqual(result, 10);
        assert.ok(statsd.mockBuffer[0].includes('result:ok'));
        assert.ok(statsd.mockBuffer[0].includes('|d')); // distribution type
      });
    });

    it('asyncDistTimer should merge dynamic tags with static tags', () => {
      statsd = new StatsD({ mock: true });

      const asyncFn = (value, ctx) => {
        return delay(10).then(() => {
          ctx.addTags(['dynamic:value']);
          return value;
        });
      };
      const instrumented = statsd.asyncDistTimer(asyncFn, 'dist-test', undefined, { static: 'value' });

      return instrumented(5).then(() => {
        assert.ok(statsd.mockBuffer[0].includes('static:value'));
        assert.ok(statsd.mockBuffer[0].includes('dynamic:value'));
      });
    });

    it('context addTags can be called multiple times', () => {
      statsd = new StatsD({ mock: true });

      const testFn = (ctx) => {
        ctx.addTags(['tag1:value1']);
        ctx.addTags({ tag2: 'value2' });
        ctx.addTags(['tag3:value3']);
        return 'done';
      };
      const instrumented = statsd.timer(testFn, 'test-stat');
      instrumented();

      assert.ok(statsd.mockBuffer[0].includes('tag1:value1'));
      assert.ok(statsd.mockBuffer[0].includes('tag2:value2'));
      assert.ok(statsd.mockBuffer[0].includes('tag3:value3'));
    });
  });
});

/**
 * Use system sleep for given milliseconds
 */
function sleep(ms) {
  return () => {
    execSync(`sleep ${ms / 1000}`);
  };
}

/**
 * Delay with a promise for given milliseconds
 */
function delay(n) {
  return new Promise((resolve) => {
    setTimeout(resolve, n);
  });
}
