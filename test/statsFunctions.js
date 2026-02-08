const assert = require('assert');
const helpers = require('./helpers/helpers.js');

const closeAll = helpers.closeAll;
const testTypes = helpers.testTypes;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#statsFunctions', () => {
  let server;
  let statsd;

  afterEach(done => {
    closeAll(server, statsd, false, done);
  });

  testTypes().forEach(([description, serverType, clientType, metricsEnd]) => {
    describe(description, () => {
      [{ name: 'timing', unit: 'ms', bytes: 14, sign: '' },
      { name: 'histogram', unit: 'h', bytes: 12, sign: '' },
      { name: 'distribution', unit: 'd', bytes: 12, sign: '' },
      { name: 'gauge', unit: 'g', bytes: 12, sign: '' },
      { name: 'gaugeDelta', unit: 'g', bytes: 12, sign: '+' },
      { name: 'set', unit: 's', bytes: 12, sign: '' },
      ].forEach(statFunction => {

        describe(`#${statFunction.name}`, () => {
          it(`should send proper ${statFunction.name} format without prefix, suffix, sampling and callback`, done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(opts, clientType);
              statsd[statFunction.name]('test', 42);
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test:${statFunction.sign}42|${statFunction.unit}${metricsEnd}`);
              done();
            });
          });

          it(`should send proper ${statFunction.name} format with array tags`, done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(opts, clientType);
              statsd[statFunction.name]('test', 42, ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test:${statFunction.sign}42|${statFunction.unit}|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
              done();
            });
          });

          it(`should send proper ${statFunction.name} format with object tags`, done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(opts, clientType);
              statsd[statFunction.name]('test', 42, { gtag:'gvalue1', gtag2:'gvalue2' });
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test:${statFunction.sign}42|${statFunction.unit}|#gtag:gvalue1,gtag2:gvalue2${metricsEnd}`);
              done();
            });
          });

          it(`should send proper ${statFunction.name} format with cacheDns`, done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(Object.assign(opts, {
                cacheDns: true
              }), clientType);
              statsd[statFunction.name]('test', 42, ['foo', 'bar']);
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test:${statFunction.sign}42|${statFunction.unit}|#foo,bar${metricsEnd}`);
              done();
            });
          });

          it(`should send proper ${statFunction.name} format with prefix, suffix, sampling and callback`, done => {
            let called = false;
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(Object.assign(opts, {
                prefix: 'foo.',
                suffix: '.bar',
              }), clientType);
              statsd[statFunction.name]('test', 42, 0.5, () => {
                called = true;
              });
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `foo.test.bar:${statFunction.sign}42|${statFunction.unit}|@0.5${metricsEnd}`);
              assert.strictEqual(called, true);
              done();
            });
          });

          it('should properly send a and b with the same value', done => {
            let called = 0;
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(Object.assign(opts, {
                maxBufferSize: 1000,
                bufferFlushInterval: 5
              }), clientType);
              statsd[statFunction.name](['a', 'b'], 42, null, (error) => {
                called += 1;
                assert.ok(called === 1); // Ensure it only gets called once
                assert.strictEqual(error, null);
              });
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `a:${statFunction.sign}42|${statFunction.unit}\nb:${statFunction.sign}42|${statFunction.unit}${metricsEnd}`);
              done();
            });
          });

          it('should format tags to datadog format by default', done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(opts, clientType);
              statsd[statFunction.name]('test', 42, { foo: 'bar' });
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test:${statFunction.sign}42|${statFunction.unit}|#foo:bar${metricsEnd}`);
              done();
            });
          });

          it('should format tags when using telegraf format', done => {
            server = createServer(serverType, opts => {
              statsd = createHotShotsClient(Object.assign(opts, {
                telegraf: true,
              }), clientType);
              statsd[statFunction.name]('test', 42, { foo: 'bar' });
            });
            server.on('metrics', metrics => {
              assert.strictEqual(metrics, `test,foo=bar:${statFunction.sign}42|${statFunction.unit}${metricsEnd}`);
              done();
            });
          });
        });
      });

      describe('#timing', () => {
        it('should send when no dates are specified', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.timing('test', 1592198027348);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:1592198027348|ms${metricsEnd}`);
            done();
          });
        });
        it('should send when dates are specified', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.timing('test', new Date(Date.now() - 10));
          });
          server.on('metrics', metrics => {
            assert.ok(metrics === `test:10|ms${metricsEnd}` ||
              metrics === `test:11|ms${metricsEnd}`);
            done();
          });
        });
      });

      describe('#increment', () => {
        it('should send count by 1 when no params are specified', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test');
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:1|c${metricsEnd}`);
            done();
          });
        });

        it('should use when increment is 0', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test', 0);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:0|c${metricsEnd}`);
            done();
          });
        });

        it('should send proper count format with tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test', 42, ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:42|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send default count 1 with tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test', ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:1|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send tags when sampleRate is omitted', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.increment('test', 23, ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:23|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send proper count format with prefix, suffix, sampling and callback', done => {
          let called = false;
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              prefix: 'foo.',
              suffix: '.bar',
            }), clientType);
            statsd.increment('test', 42, 0.5, () => {
              called = true;
            });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `foo.test.bar:42|c|@0.5${metricsEnd}`);
            assert.strictEqual(called, true);
            done();
          });
        });

        it('should properly send a and b with the same value', done => {
          let called = 0;
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              maxBufferSize: 1000,
              bufferFlushInterval: 5
            }), clientType);
            statsd.increment(['a', 'b'], 42, null, (error, bytes) => {
              called += 1;
              assert.ok(called === 1); // Ensure it only gets called once
              assert.strictEqual(error, null);
              assert.strictEqual(bytes, 0);
            });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `a:42|c\nb:42|c${metricsEnd}`);
            done();
        });
        });
      });

      describe('#decrement', () => {
        it('should send count by -1 when no params are specified', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.decrement('test');
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:-1|c${metricsEnd}`);
            done();
          });
        });

        it('should send default count -1 with tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.decrement('test', ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:-1|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send tags when sampleRate is omitted', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.decrement('test', 23, ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:-23|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send proper count format with tags', done => {
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(opts, clientType);
            statsd.decrement('test', 42, ['foo', 'bar', 'gtag:gvalue1', 'gtag:gvalue2']);
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `test:-42|c|#gtag:gvalue1,gtag:gvalue2,foo,bar${metricsEnd}`);
            done();
          });
        });

        it('should send proper count format with prefix, suffix, sampling and callback', done => {
          let called = false;
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              prefix: 'foo.',
              suffix: '.bar',
            }), clientType);
            statsd.decrement('test', 42, 0.5, () => {
              called = true;
            });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `foo.test.bar:-42|c|@0.5${metricsEnd}`);
            assert.strictEqual(called, true);
            done();
          });
        });

        it('should properly send a and b with the same value', done => {
          let called = 0;
          server = createServer(serverType, opts => {
            statsd = createHotShotsClient(Object.assign(opts, {
              maxBufferSize: 1000,
              bufferFlushInterval: 5
            }), clientType);
            statsd.decrement(['a', 'b'], 42, null, (error, bytes) => {
              called += 1;
              assert.ok(called === 1); // Ensure it only gets called once
              assert.strictEqual(error, null);
              assert.strictEqual(bytes, 0);
            });
          });
          server.on('metrics', metrics => {
            assert.strictEqual(metrics, `a:-42|c\nb:-42|c${metricsEnd}`);
            done();
        });
        });
      });
    });
  });

  describe('gaugeDelta', () => {
    it('Adds a plus sign when the value is positive', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gaugeDelta('test', 42);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:+42|g');
        done();
      });
    });
    it('Adds a minus sign when the value is negative', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gaugeDelta('test', -42);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:-42|g');
        done();
      });
    });
  });

  describe('sanitization of protocol-breaking characters', () => {
    it('should sanitize colons and pipes in metric names', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('check:11|g', 42);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'check_11_g:42|g');
        done();
      });
    });

    it('should sanitize newlines in metric names', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('metric\nname', 42);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'metric_name:42|g');
        done();
      });
    });

    it('should sanitize newlines in tags', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('test', 42, ['tag1,tag2,\ntag3']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:42|g|#tag1_tag2__tag3');
        done();
      });
    });

    it('should sanitize hash characters in tags for DogStatsD', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('test', 42, ['tag#value']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:42|g|#tag_value');
        done();
      });
    });

    it('should handle the exact example from issue #238', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('check:11|g#this:out', 42, 1, ['tag1,tag2,\ntag3']);
      });
      server.on('metrics', metrics => {
        // Metric name: check:11|g#this:out -> check_11_g#this_out (: and | replaced, # preserved in metric name)
        // Tags: tag1,tag2,\ntag3 -> tag1_tag2__tag3 (, and \n replaced)
        assert.strictEqual(metrics, 'check_11_g#this_out:42|g|#tag1_tag2__tag3');
        done();
      });
    });

    it('should sanitize metric names with prefix and suffix', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(Object.assign(opts, {
          prefix: 'foo.',
          suffix: '.bar'
        }), 'client');
        statsd.gauge('test:metric|name', 42);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'foo.test_metric_name.bar:42|g');
        done();
      });
    });

    it('should sanitize tags passed as object with special characters', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('test', 42, { 'tag:key': 'value|with#special\nchars' });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:42|g|#tag_key:value_with_special_chars');
        done();
      });
    });

    it('should sanitize increment metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.increment('count:er|name', 1, ['bad\ntag']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'count_er_name:1|c|#bad_tag');
        done();
      });
    });

    it('should sanitize timing metrics', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('time:r|name', 100, ['bad\ntag']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'time_r_name:100|ms|#bad_tag');
        done();
      });
    });
  });

  describe('increment/decrement with tags and callback, no value (issue #139)', () => {
    it('should handle increment with tags object and callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.increment('test', { tagName: 'tagValue' }, () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:1|c|#tagName:tagValue');
        assert.strictEqual(called, true);
        done();
      });
    });

    it('should handle increment with tags array and callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.increment('test', ['foo', 'bar'], () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:1|c|#foo,bar');
        assert.strictEqual(called, true);
        done();
      });
    });

    it('should handle decrement with tags object and callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.decrement('test', { tagName: 'tagValue' }, () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:-1|c|#tagName:tagValue');
        assert.strictEqual(called, true);
        done();
      });
    });

    it('should handle decrement with tags array and callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.decrement('test', ['foo', 'bar'], () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:-1|c|#foo,bar');
        assert.strictEqual(called, true);
        done();
      });
    });

    it('should still work with explicit value and tags', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.increment('test', 5, ['foo']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:5|c|#foo');
        done();
      });
    });
  });

  describe('empty object for sampleRate (issue #43)', () => {
    it('should not lose tags when empty object is passed for sampleRate', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('test', 100, {}, ['foo', 'bar']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:100|ms|#foo,bar');
        done();
      });
    });

    it('should not lose tags when empty object is passed for sampleRate with callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('test', 100, {}, ['foo', 'bar'], () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:100|ms|#foo,bar');
        assert.strictEqual(called, true);
        done();
      });
    });

    it('should work with gauge and empty object for sampleRate', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.gauge('test', 42, {}, { tag: 'value' });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:42|g|#tag:value');
        done();
      });
    });

    it('should work with histogram and empty object for sampleRate', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.histogram('test', 42, {}, ['mytag']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:42|h|#mytag');
        done();
      });
    });
  });

  describe('null handling in parameters', () => {
    it('should handle null passed as sampleRate', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('test', 100, null, ['foo', 'bar']);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:100|ms|#foo,bar');
        done();
      });
    });

    it('should handle null passed as tags', done => {
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('test', 100, null, null);
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:100|ms');
        done();
      });
    });

    it('should handle null tags with callback', done => {
      let called = false;
      server = createServer('udp', opts => {
        statsd = createHotShotsClient(opts, 'client');
        statsd.timing('test', 100, 1, null, () => {
          called = true;
        });
      });
      server.on('metrics', metrics => {
        assert.strictEqual(metrics, 'test:100|ms');
        assert.strictEqual(called, true);
        done();
      });
    });
  });
});
