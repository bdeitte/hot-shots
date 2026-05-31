# Datadog Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `datadog` mode flag to hot-shots that enables origin detection (`|c:` container ID), External Data (`|e:`), and cardinality (`|card:`), matching the official Datadog DogStatsD clients while leaving non-Datadog (StatsD/Telegraf) users unaffected.

**Architecture:** A new `datadog` constructor option (explicit `true`/`false`, or auto-detected from Datadog env signals / UDS protocol) gates three new DogStatsD protocol-extension fields. Container ID is resolved once at construction by a new pure-`fs` module (`lib/originDetection.js`) that parses cgroup/mountinfo files (Linux only, no-op elsewhere). External Data comes from `DD_EXTERNAL_ENV`; cardinality from a client-wide default (`cardinality` option / `DD_CARDINALITY` env) plus a per-call override on the existing metric/event/check options object. When datadog mode is active, client telemetry (`includeDatadogTelemetry`) also defaults on. The three fields are appended to metrics, events, and service checks at their respective wire-build sites, mirroring how the existing `|T` timestamp field is already appended.

**Tech Stack:** Node.js (>=18), CommonJS, Mocha + `assert` + Sinon for tests, ESLint 8.

**Spec:** `docs/superpowers/specs/2026-05-29-datadog-mode-design.md`

**Conventions to follow throughout:**
- Single quotes, curly braces on all `if`/`else`, JSDoc on all functions (`require-jsdoc`), sorted imports (`sort-imports`), operators at end of line.
- Run a single test file with: `npx mocha test/datadogMode.js --timeout 5000`
- Run the unit-only origin test with: `npx mocha test/originDetection.js --timeout 5000`
- Full gate (lint + all tests): `npm test`
- Commit after every task. We are on branch `datadog-mode`.

**Note on one spec refinement:** the spec lists the UDS auto-detect signal as "protocol is `uds` and `path` is the default Datadog socket." Because UDS is DogStatsD-only in hot-shots (per README) and defaults to the Datadog socket, this plan treats **any** `protocol === 'uds'` as a Datadog signal. This is simpler and strictly broader; update the spec wording if desired.

---

## File Structure

- **Create `lib/originDetection.js`** — pure container-ID resolver. One responsibility: given (injectable) fs access, return a container-ID string or `undefined`. No dependency on the Client.
- **Modify `lib/constants.js`** — add Datadog-mode constants (cardinality values, host cgroup-ns inode, default UDS path, cgroup/mountinfo paths, container-ID regex, Datadog signal env var list, origin-detection falsey values).
- **Modify `lib/helpers.js`** — add pure helpers: `detectDatadogMode`, `validateCardinality`, `sanitizeExternalData`, `isFalseyEnvValue`.
- **Modify `lib/statsd.js`** — resolve datadog mode + originDetection + containerID + externalData + cardinality at construction (with child inheritance); thread per-call `cardinality` through `sendAll`→`sendStat`; build the extension fields via a new `getDatadogExtensionFields` method; inject in `sendStat`; pass child fields in `ChildClient`.
- **Modify `lib/statsFunctions.js`** — accept `cardinality` in `event()`/`check()` options and inject the extension fields (checks insert before `m:`).
- **Modify `types.d.ts`** — new `ClientOptions`/`ChildClientOptions`/`MetricOptions`/`EventOptions`/`CheckOptions` fields.
- **Create `test/originDetection.js`** — unit tests for the resolver with injected fakes.
- **Create `test/datadogMode.js`** — integration tests for mode resolution + wire output.
- **Modify `README.md`, `CHANGES.md`** — docs.

---

## Task 1: Add constants

**Files:**
- Modify: `lib/constants.js`

- [ ] **Step 1: Add the new constants and exports**

Append to `lib/constants.js` before the final `exports.tcpErrors`/`exports.udsErrors` lines (keep those as-is). Add:

```javascript
// Valid Datadog tag cardinality values (DogStatsD `|card:` field).
exports.CARDINALITY_VALUES = ['none', 'low', 'orchestrator', 'high'];

// Env var values that mean "disabled" for DD_ORIGIN_DETECTION_ENABLED.
exports.FALSEY_ENV_VALUES = ['no', 'false', '0', 'n', 'off'];

// Env vars whose presence signals the client is talking to a Datadog Agent.
exports.DATADOG_SIGNAL_ENV_VARS = [
  'DD_AGENT_HOST',
  'DD_DOGSTATSD_PORT',
  'DD_ENTITY_ID',
  'DD_ENV',
  'DD_SERVICE',
  'DD_VERSION',
  'DD_EXTERNAL_ENV',
  'DD_CARDINALITY',
];

// Origin detection (container ID) constants. Linux-only paths.
exports.ORIGIN_DETECTION = {
  // Inode of /proc/self/ns/cgroup when in the host cgroup namespace.
  HOST_CGROUP_NAMESPACE_INODE: 0xEFFFFFFB,
  CGROUP_PATH: '/proc/self/cgroup',
  CGROUP_NS_PATH: '/proc/self/ns/cgroup',
  MOUNTINFO_PATH: '/proc/self/mountinfo',
  CGROUP_MOUNT_PATH: '/sys/fs/cgroup',
  CGROUPV1_BASE_CONTROLLER: 'memory',
  // Matches Docker (64 hex), ECS (32 hex + task id), and UUID/Garden container ids.
  // The UUID branch is a full 8-4-4-4-12 UUID; using {4} for the final group would
  // truncate real UUIDs to 28 chars and emit an invalid |c: value.
  CONTAINER_ID_RE: /([0-9a-f]{64})|([0-9a-f]{32}-\d+)|([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/,
};
```

- [ ] **Step 2: Verify it loads**

Run: `node -e "const c = require('./lib/constants'); console.log(c.CARDINALITY_VALUES, c.ORIGIN_DETECTION.HOST_CGROUP_NAMESPACE_INODE)"`
Expected: prints `[ 'none', 'low', 'orchestrator', 'high' ] 4026531835`

- [ ] **Step 3: Lint**

Run: `npx eslint lib/constants.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/constants.js
git commit -m "Add Datadog-mode constants (cardinality, origin detection, signals)"
```

---

## Task 2: Origin detection module

**Files:**
- Create: `lib/originDetection.js`
- Test: `test/originDetection.js`

- [ ] **Step 1: Write the failing tests**

Create `test/originDetection.js`:

```javascript
const assert = require('assert');
const originDetection = require('../lib/originDetection');

// Helper: build an injectable deps object backed by in-memory fake files/inodes.
const fakeDeps = ({ platform = 'linux', files = {}, inodes = {} } = {}) => {
  return {
    platform,
    readFileSync: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    statSync: (p) => {
      if (!(p in inodes)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { ino: inodes[p] };
    },
  };
};

const HOST_INODE = 0xEFFFFFFB;

describe('#originDetection', () => {
  it('returns undefined on non-linux platforms', () => {
    const deps = fakeDeps({ platform: 'darwin' });
    assert.strictEqual(originDetection.getContainerID(deps), undefined);
  });

  it('returns undefined when no /proc files exist', () => {
    const deps = fakeDeps({ platform: 'linux' });
    assert.strictEqual(originDetection.getContainerID(deps), undefined);
  });

  it('parses a Docker 64-hex container id from /proc/self/cgroup', () => {
    const id = 'a'.repeat(64);
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': `12:memory:/docker/${id}\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), id);
  });

  it('parses a systemd .scope docker container id', () => {
    const id = 'b'.repeat(64);
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': `0::/system.slice/docker-${id}.scope\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), id);
  });

  it('parses an ECS task container id (32hex-digits)', () => {
    const ecs = `${'c'.repeat(32)}-1234567890`;
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': `9:memory:/ecs/task/${ecs}\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), ecs);
  });

  it('parses a full UUID/Garden container id without truncation', () => {
    const uuid = '0123abcd-4567-89ab-cdef-0123456789ab';
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': `0::/system.slice/garden-${uuid}.scope\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), uuid);
  });

  it('falls back to mountinfo when cgroup has no id', () => {
    const id = 'd'.repeat(64);
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': '0::/\n',
        '/proc/self/mountinfo': `1234 1234 0:50 /docker/containers/${id}/resolv.conf /etc/resolv.conf\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), id);
  });

  it('uses cgroup v2 inode fallback (in-<inode>) when not in host namespace', () => {
    const deps = fakeDeps({
      inodes: {
        '/proc/self/ns/cgroup': 12345, // not the host inode
        '/sys/fs/cgroup/system.slice/app.service': 678901,
      },
      files: {
        '/proc/self/cgroup': '0::/system.slice/app.service\n',
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), 'in-678901');
  });

  it('rejects cgroup v2 inodes <= 2', () => {
    const deps = fakeDeps({
      inodes: {
        '/proc/self/ns/cgroup': 12345,
        '/sys/fs/cgroup/': 2,
      },
      files: {
        '/proc/self/cgroup': '0::/\n',
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/originDetection.js --timeout 5000`
Expected: FAIL — `Cannot find module '../lib/originDetection'` (or all assertions failing).

- [ ] **Step 3: Write the module**

Create `lib/originDetection.js`:

```javascript
const fs = require('fs');
const process = require('process');
const constants = require('./constants');
const util = require('util');

const debug = util.debuglog('hot-shots');
const OD = constants.ORIGIN_DETECTION;

/**
 * Builds the default dependency set (real fs / platform). Tests inject fakes.
 * @returns {Object} deps with platform, readFileSync, statSync
 */
function defaultDeps() {
  return {
    platform: process.platform,
    readFileSync: (p) => fs.readFileSync(p, 'utf8'), // eslint-disable-line no-sync
    statSync: (p) => fs.statSync(p), // eslint-disable-line no-sync
  };
}

/**
 * Returns true if /proc/self/ns/cgroup matches the host cgroup namespace inode.
 * @param {Function} statSync Stat function
 * @returns {boolean} Whether we are in the host cgroup namespace
 */
function isHostCgroupNamespace(statSync) {
  try {
    const stat = statSync(OD.CGROUP_NS_PATH);
    return Boolean(stat) && stat.ino === OD.HOST_CGROUP_NAMESPACE_INODE;
  } catch (e) {
    debug('hot-shots originDetection: cannot stat cgroup ns: %s', e && e.message);
    return false;
  }
}

/**
 * Scans text for a container id using the shared regex, returning the first match.
 * @param {String} text Text to scan (cgroup or mountinfo contents)
 * @returns {String|undefined} The matched container id
 */
function matchContainerID(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.indexOf('sandboxes') !== -1) {
      continue;
    }
    const match = OD.CONTAINER_ID_RE.exec(line);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * Reads /proc/self/cgroup and returns a matched container id, if any.
 * @param {Function} readFileSync Read function
 * @returns {String|undefined} The container id
 */
function readContainerIDFromCgroup(readFileSync) {
  try {
    return matchContainerID(readFileSync(OD.CGROUP_PATH));
  } catch (e) {
    debug('hot-shots originDetection: cannot read cgroup: %s', e && e.message);
    return undefined;
  }
}

/**
 * Reads /proc/self/mountinfo and returns a matched container id, if any.
 * @param {Function} readFileSync Read function
 * @returns {String|undefined} The container id
 */
function readContainerIDFromMountInfo(readFileSync) {
  try {
    return matchContainerID(readFileSync(OD.MOUNTINFO_PATH));
  } catch (e) {
    debug('hot-shots originDetection: cannot read mountinfo: %s', e && e.message);
    return undefined;
  }
}

/**
 * cgroup v2 inode fallback: stats the controller path under /sys/fs/cgroup and
 * returns "in-<inode>" for inodes greater than 2.
 * @param {Function} readFileSync Read function
 * @param {Function} statSync Stat function
 * @returns {String|undefined} The inode-based id
 */
function getCgroupInode(readFileSync, statSync) {
  let content;
  try {
    content = readFileSync(OD.CGROUP_PATH);
  } catch (e) {
    debug('hot-shots originDetection: cannot read cgroup for inode: %s', e && e.message);
    return undefined;
  }
  const lines = content.split('\n');
  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 3) {
      continue;
    }
    const controller = parts[1];
    const cgroupNodePath = parts.slice(2).join(':');
    // cgroup v2 uses an empty controller; cgroup v1 uses the memory controller.
    let controllerSegment;
    if (controller === '') {
      controllerSegment = '';
    } else if (controller.split(',').indexOf(OD.CGROUPV1_BASE_CONTROLLER) !== -1) {
      controllerSegment = `/${OD.CGROUPV1_BASE_CONTROLLER}`;
    } else {
      continue;
    }
    const fullPath = `${OD.CGROUP_MOUNT_PATH}${controllerSegment}${cgroupNodePath}`;
    try {
      const stat = statSync(fullPath);
      if (stat && stat.ino > 2) {
        return `in-${stat.ino}`;
      }
    } catch (e) {
      debug('hot-shots originDetection: cannot stat %s: %s', fullPath, e && e.message);
    }
  }
  return undefined;
}

/**
 * Resolves a container id for Datadog origin detection. Linux-only; returns
 * undefined on other platforms or when nothing can be detected. Never throws.
 * Absence of a container id is expected (not an error), so failures are only
 * debug-logged.
 * @param {Object=} deps Optional injected dependencies (platform, readFileSync, statSync)
 * @returns {String|undefined} The container id, or undefined
 */
function getContainerID(deps) {
  const d = deps || defaultDeps();
  if (d.platform !== 'linux') {
    return undefined;
  }
  if (isHostCgroupNamespace(d.statSync)) {
    const id = readContainerIDFromCgroup(d.readFileSync) ||
      readContainerIDFromMountInfo(d.readFileSync);
    if (id) {
      return id;
    }
  }
  return getCgroupInode(d.readFileSync, d.statSync);
}

module.exports = {
  getContainerID: getContainerID,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/originDetection.js --timeout 5000`
Expected: PASS (8 passing).

- [ ] **Step 5: Lint**

Run: `npx eslint lib/originDetection.js test/originDetection.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/originDetection.js test/originDetection.js
git commit -m "Add originDetection module for container-ID resolution"
```

---

## Task 3: Helper functions

**Files:**
- Modify: `lib/helpers.js`
- Test: `test/datadogHelpers.js` (create — must be top-level `test/*.js`; `npm test` runs `mocha test/*.js` non-recursively, so files under `test/helpers/` are NOT picked up)

- [ ] **Step 1: Write the failing tests**

Create `test/datadogHelpers.js`:

```javascript
const assert = require('assert');
const helpers = require('../lib/helpers');

describe('#helpers datadog-mode units', () => {
  afterEach(() => {
    delete process.env.DD_AGENT_HOST;
    delete process.env.DD_ENV;
    delete process.env.DD_ORIGIN_DETECTION_ENABLED;
  });

  describe('validateCardinality', () => {
    it('accepts valid values', () => {
      assert.strictEqual(helpers.validateCardinality('low'), 'low');
      assert.strictEqual(helpers.validateCardinality('HIGH'), 'high');
    });
    it('returns undefined for invalid or empty values', () => {
      assert.strictEqual(helpers.validateCardinality('bogus'), undefined);
      assert.strictEqual(helpers.validateCardinality(undefined), undefined);
      assert.strictEqual(helpers.validateCardinality(''), undefined);
    });
  });

  describe('sanitizeExternalData', () => {
    it('strips pipes and control chars', () => {
      assert.strictEqual(helpers.sanitizeExternalData('it-false,cn-foo|bar'), 'it-false,cn-foobar');
      assert.strictEqual(helpers.sanitizeExternalData('  trim\nme  '), 'trimme');
    });
    it('returns undefined for empty input', () => {
      assert.strictEqual(helpers.sanitizeExternalData(undefined), undefined);
      assert.strictEqual(helpers.sanitizeExternalData(''), undefined);
    });
  });

  describe('isFalseyEnvValue', () => {
    it('detects falsey values case-insensitively', () => {
      assert.strictEqual(helpers.isFalseyEnvValue('false'), true);
      assert.strictEqual(helpers.isFalseyEnvValue('OFF'), true);
      assert.strictEqual(helpers.isFalseyEnvValue('0'), true);
    });
    it('treats other values as not-falsey', () => {
      assert.strictEqual(helpers.isFalseyEnvValue('true'), false);
      assert.strictEqual(helpers.isFalseyEnvValue(undefined), false);
    });
  });

  describe('detectDatadogMode', () => {
    it('is false for telegraf regardless of signals', () => {
      process.env.DD_AGENT_HOST = '1.2.3.4';
      assert.strictEqual(helpers.detectDatadogMode(true, 'udp', undefined), false);
    });
    it('is true when a DD_ signal env var is present', () => {
      process.env.DD_ENV = 'prod';
      assert.strictEqual(helpers.detectDatadogMode(false, 'udp', undefined), true);
    });
    it('is true for uds protocol', () => {
      assert.strictEqual(helpers.detectDatadogMode(false, 'uds', undefined), true);
    });
    it('is false with no signals on udp', () => {
      assert.strictEqual(helpers.detectDatadogMode(false, 'udp', undefined), false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/datadogHelpers.js --timeout 5000`
Expected: FAIL — `helpers.validateCardinality is not a function`.

- [ ] **Step 3: Implement the helpers**

In `lib/helpers.js`, add `const constants = require('./constants');` at the top (after the existing `const fs = require('fs');`, keeping import order — `constants` sorts before `fs`, so place `const constants = require('./constants');` on the line above `const fs = require('fs');`). Then add these functions before the `module.exports` block:

```javascript
/**
 * Validates a cardinality value against the allowed set, returning the
 * normalized lowercase value or undefined (with a console.error on invalid).
 */
function validateCardinality(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).toLowerCase();
  if (constants.CARDINALITY_VALUES.indexOf(normalized) === -1) {
    console.error(`hot-shots: invalid cardinality '${value}' — expected one of ` +
      `${constants.CARDINALITY_VALUES.join(', ')}; ignoring`);
    return undefined;
  }
  return normalized;
}

/**
 * Sanitizes External Data (DD_EXTERNAL_ENV) by trimming and stripping control
 * characters and pipe characters. Returns undefined for empty input.
 */
function sanitizeExternalData(value) {
  if (!value) {
    return undefined;
  }
  // Strip control characters and the pipe delimiter, matching the C# client.
  const sanitized = String(value).trim().replace(/[\x00-\x1f|]+/g, ''); // eslint-disable-line no-control-regex
  return sanitized === '' ? undefined : sanitized;
}

/**
 * Returns true if an env var value represents a disabled/false setting.
 */
function isFalseyEnvValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  return constants.FALSEY_ENV_VALUES.indexOf(String(value).toLowerCase()) !== -1;
}

/**
 * Determines whether Datadog mode should auto-enable. True when not telegraf and
 * either a Datadog signal env var is set or the protocol is UDS (DogStatsD-only).
 */
function detectDatadogMode(telegraf, protocol) {
  if (telegraf) {
    return false;
  }
  if (constants.DATADOG_SIGNAL_ENV_VARS.some(name => process.env[name])) {
    return true;
  }
  if (protocol === constants.PROTOCOL.UDS) {
    return true;
  }
  return false;
}
```

Then add to the `module.exports` object:

```javascript
  validateCardinality: validateCardinality,
  sanitizeExternalData: sanitizeExternalData,
  isFalseyEnvValue: isFalseyEnvValue,
  detectDatadogMode: detectDatadogMode,
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/datadogHelpers.js --timeout 5000`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npx eslint lib/helpers.js test/datadogHelpers.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/helpers.js test/datadogHelpers.js
git commit -m "Add datadog-mode helpers: cardinality, external data, mode detection"
```

---

## Task 4: Resolve datadog mode + fields at construction

**Files:**
- Modify: `lib/statsd.js` (requires at top; constructor ~lines 113–172; ChildClient ~lines 910–949)
- Test: `test/datadogMode.js` (create)

- [ ] **Step 1: Write the failing tests (mode resolution)**

Create `test/datadogMode.js`:

```javascript
const assert = require('assert');
const StatsD = require('../lib/statsd');

const DD_ENV_VARS = [
  'DD_AGENT_HOST', 'DD_DOGSTATSD_PORT', 'DD_ENTITY_ID', 'DD_ENV',
  'DD_SERVICE', 'DD_VERSION', 'DD_EXTERNAL_ENV', 'DD_CARDINALITY',
  'DATADOG_CARDINALITY', 'DD_ORIGIN_DETECTION_ENABLED',
];

const clearDDEnv = () => {
  DD_ENV_VARS.forEach(name => delete process.env[name]);
};

describe('#datadogMode resolution', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  it('defaults datadog off with no signals (udp)', () => {
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.datadog, false);
    client.close(() => {});
  });

  it('auto-enables when a DD_ env signal is present', () => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.datadog, true);
    client.close(() => {});
  });

  it('honors explicit datadog:true', () => {
    const client = new StatsD({ mock: true, datadog: true });
    assert.strictEqual(client.datadog, true);
    client.close(() => {});
  });

  it('honors explicit datadog:false even with signals', () => {
    process.env.DD_ENV = 'prod';
    const client = new StatsD({ mock: true, datadog: false });
    assert.strictEqual(client.datadog, false);
    client.close(() => {});
  });

  it('telegraf wins over explicit datadog:true', () => {
    const client = new StatsD({ mock: true, telegraf: true, datadog: true });
    assert.strictEqual(client.datadog, false);
    client.close(() => {});
  });

  it('sets containerID from explicit option in datadog mode', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'abc123' });
    assert.strictEqual(client.containerID, 'abc123');
    client.close(() => {});
  });

  it('reads external data and cardinality in datadog mode', () => {
    process.env.DD_EXTERNAL_ENV = 'it-false,cn-foo';
    process.env.DD_CARDINALITY = 'low';
    const client = new StatsD({ mock: true });
    assert.strictEqual(client.externalData, 'it-false,cn-foo');
    assert.strictEqual(client.cardinality, 'low');
    client.close(() => {});
  });

  it('does not set fields when datadog mode is off', () => {
    const client = new StatsD({ mock: true, containerID: 'abc123' });
    assert.strictEqual(client.datadog, false);
    assert.strictEqual(client.containerID, undefined);
    client.close(() => {});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: FAIL — `client.datadog` is `undefined`.

- [ ] **Step 3: Add requires and constructor resolution**

In `lib/statsd.js`, add the require near the other lib requires at the top (keep `sort-imports` order; place alphabetically among the existing `require('./...')` lines):

```javascript
const originDetection = require('./originDetection');
```

Then, immediately after the existing `this.telegraf = options.telegraf || false;` line (currently line 113), insert the datadog-mode resolution block:

```javascript
  // Datadog mode: explicit true/false wins; otherwise auto-detect from signals.
  // Telegraf and datadog are mutually exclusive (telegraf wins).
  if (options.isChild) {
    this.datadog = options.datadog === true;
    this.originDetection = options.originDetection === true;
    this.containerID = options.containerID;
    this.externalData = options.externalData;
    this.cardinality = options.cardinality;
  } else {
    if (options.datadog === true && this.telegraf) {
      console.error('hot-shots: datadog and telegraf options are mutually exclusive; ' +
        'telegraf takes precedence and datadog features are disabled');
      this.datadog = false;
    } else if (typeof options.datadog === 'boolean') {
      this.datadog = options.datadog;
    } else {
      this.datadog = helpers.detectDatadogMode(this.telegraf, this.protocol);
    }

    this.originDetection = false;
    this.containerID = undefined;
    this.externalData = undefined;
    this.cardinality = undefined;

    if (this.datadog) {
      this.originDetection = options.originDetection !== false &&
        !helpers.isFalseyEnvValue(process.env.DD_ORIGIN_DETECTION_ENABLED);
      if (options.containerID) {
        this.containerID = options.containerID;
      } else if (this.originDetection) {
        this.containerID = originDetection.getContainerID();
      }
      this.externalData = helpers.sanitizeExternalData(process.env.DD_EXTERNAL_ENV);
      this.cardinality = helpers.validateCardinality(
        options.cardinality || process.env.DD_CARDINALITY || process.env.DATADOG_CARDINALITY);
    }
  }
```

- [ ] **Step 4: Flip telemetry default under datadog mode**

Replace the existing telemetry-enable line (currently lines 152–155):

```javascript
  this.includeDatadogTelemetry = options.includeDatadogTelemetry === true &&
    !options.telegraf &&
    !options.mock &&
    !options.isChild;
```

with:

```javascript
  // Under datadog mode telemetry defaults on (matching the official clients);
  // otherwise it stays opt-in. Always disabled for telegraf/mock/child clients.
  const telemetryRequested = options.includeDatadogTelemetry === undefined ?
    this.datadog === true :
    options.includeDatadogTelemetry === true;
  this.includeDatadogTelemetry = telemetryRequested &&
    !options.telegraf &&
    !options.mock &&
    !options.isChild;
```

- [ ] **Step 5: Run to verify pass**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: PASS (8 passing).

- [ ] **Step 6: Lint**

Run: `npx eslint lib/statsd.js test/datadogMode.js`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/statsd.js test/datadogMode.js
git commit -m "Resolve datadog mode, container ID, external data, cardinality at construction"
```

---

## Task 5: Build + inject extension fields for metrics

**Files:**
- Modify: `lib/statsd.js` (`sendAll` ~lines 276–351; `sendStat` ~lines 363–396; add `getDatadogExtensionFields` method)
- Test: `test/datadogMode.js`

- [ ] **Step 1: Write the failing tests (append to `test/datadogMode.js`)**

Add a new `describe` block to `test/datadogMode.js`:

```javascript
describe('#datadogMode metric wire output', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  const lastMessage = (client) => {
    return client.mockBuffer[client.mockBuffer.length - 1];
  };

  it('appends |c: and |e: to metrics in datadog mode', () => {
    const client = new StatsD({
      mock: true, datadog: true, containerID: 'cid123',
    });
    process.env.DD_EXTERNAL_ENV = 'it-false';
    // externalData was read at construction; set explicitly for determinism:
    client.externalData = 'it-false';
    client.increment('test');
    assert.strictEqual(lastMessage(client), 'test:1|c|c:cid123|e:it-false');
    client.close(() => {});
  });

  it('appends client-default |card:', () => {
    const client = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    client.gauge('g', 5);
    assert.strictEqual(lastMessage(client), 'g:5|g|card:low');
    client.close(() => {});
  });

  it('per-call cardinality overrides the client default', () => {
    const client = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    client.gauge('g', 5, { cardinality: 'high' });
    assert.strictEqual(lastMessage(client), 'g:5|g|card:high');
    client.close(() => {});
  });

  it('adds no extension fields when datadog mode is off', () => {
    const client = new StatsD({ mock: true, containerID: 'cid123' });
    client.increment('test');
    assert.strictEqual(lastMessage(client), 'test:1|c');
    client.close(() => {});
  });

  it('places extension fields after tags', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.increment('test', 1, ['a:b']);
    assert.strictEqual(lastMessage(client), 'test:1|c|#a:b|c:cid123');
    client.close(() => {});
  });
});
```

Note: mock mode stores the message **after** `send()` appends tags and extension fields (mock is handled in `_send`, downstream of the tag/extension append), so these mock-mode expected strings match the real wire output.

- [ ] **Step 2: Run to verify failure**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: FAIL — extension fields missing from messages.

- [ ] **Step 3: Add the field-builder method and thread cardinality**

In `lib/statsd.js`, add this method just above `Client.prototype.sendAll` (~line 276):

```javascript
/**
 * Builds the DogStatsD extension fields (container id, external data, cardinality)
 * to append to a metric/event/check when datadog mode is active. Returns an array
 * of field strings WITHOUT leading pipes (e.g. ['c:abc', 'e:xyz', 'card:low']).
 * @param {String=} cardinality Per-call cardinality override. Optional.
 * @returns {String[]} The extension fields, possibly empty.
 */
Client.prototype.getDatadogExtensionFields = function (cardinality) {
  const fields = [];
  if (!this.datadog) {
    return fields;
  }
  if (this.containerID) {
    fields.push(`c:${this.containerID}`);
  }
  if (this.externalData) {
    fields.push(`e:${this.externalData}`);
  }
  const card = helpers.validateCardinality(cardinality) || this.cardinality;
  if (card) {
    fields.push(`card:${card}`);
  }
  return fields;
};
```

In `sendAll`, extract `cardinality` from the options object alongside `timestamp`. Update the options-object detection and assignment. Change the declaration block:

```javascript
  let timestamp;
```

to:

```javascript
  let timestamp;
  let cardinality;
```

Change the options-object branch from:

```javascript
  if (sampleRate && typeof sampleRate === 'object' && !Array.isArray(sampleRate) &&
      ('sampleRate' in sampleRate || 'tags' in sampleRate || 'timestamp' in sampleRate)) {
    callback = tags;
    timestamp = sampleRate.timestamp;
    tags = sampleRate.tags;
    sampleRate = sampleRate.sampleRate;
  }
```

to:

```javascript
  if (sampleRate && typeof sampleRate === 'object' && !Array.isArray(sampleRate) &&
      ('sampleRate' in sampleRate || 'tags' in sampleRate || 'timestamp' in sampleRate ||
        'cardinality' in sampleRate)) {
    callback = tags;
    timestamp = sampleRate.timestamp;
    cardinality = sampleRate.cardinality;
    tags = sampleRate.tags;
    sampleRate = sampleRate.sampleRate;
  }
```

Update the two `sendStat` calls to pass `cardinality`. Change:

```javascript
  if (Array.isArray(stat)) {
    stat.forEach(item => {
      self.sendStat(item, value, type, sampleRate, tags, timestamp, onSend);
    });
  } else {
    this.sendStat(stat, value, type, sampleRate, tags, timestamp, callback);
  }
```

to:

```javascript
  if (Array.isArray(stat)) {
    stat.forEach(item => {
      self.sendStat(item, value, type, sampleRate, tags, timestamp, cardinality, onSend);
    });
  } else {
    this.sendStat(stat, value, type, sampleRate, tags, timestamp, cardinality, callback);
  }
```

Update `sendStat`'s signature to carry `cardinality` and pass it to `send()` (the extension fields themselves are injected inside `send()` in the next sub-step, so they land **after** tags). Change the signature line:

```javascript
Client.prototype.sendStat = function (stat, value, type, sampleRate, tags, timestamp, callback) {
```

to:

```javascript
Client.prototype.sendStat = function (stat, value, type, sampleRate, tags, timestamp, cardinality, callback) {
```

Change `sendStat`'s final call (current line 395) from:

```javascript
  this.send(message, tags, callback);
```

to:

```javascript
  this.send(message, tags, cardinality, callback);
```

Now inject the extension fields inside `send()` so they appear after tags for both metrics and events. Change `send`'s signature (current line 404) from:

```javascript
Client.prototype.send = function (message, tags, callback) {
```

to:

```javascript
Client.prototype.send = function (message, tags, cardinality, callback) {
  // Backward-compat: support the older send(message, tags, callback) call shape.
  if (typeof cardinality === 'function' && callback === undefined) {
    callback = cardinality;
    cardinality = undefined;
  }
```

Then, immediately before the final `this._send(message, callback);` line of `send()` (current line 429), after the tag-append block, insert:

```javascript
  // DogStatsD extension fields (container id / external data / cardinality),
  // appended after tags. Only present in datadog mode.
  const extensionFields = this.getDatadogExtensionFields(cardinality);
  if (extensionFields.length > 0) {
    message += `|${extensionFields.join('|')}`;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: PASS — including "places extension fields after tags" (`test:1|c|#a:b|c:cid123`), since `send()` appends tags then extension fields before the mock buffer records the message in `_send`.

- [ ] **Step 5: Run the full suite to check for regressions in timestamp/other callers**

Run: `npx mocha test/timestamp.js test/statsFunctions.js test/send.js --timeout 5000`
Expected: PASS (the new `cardinality` param is positional before `callback`; all `sendStat` callers go through `sendAll`, which now passes it).

- [ ] **Step 6: Lint**

Run: `npx eslint lib/statsd.js test/datadogMode.js`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/statsd.js test/datadogMode.js
git commit -m "Inject container ID / external data / cardinality into metrics"
```

---

## Task 6: Inject extension fields for events

**Files:**
- Modify: `lib/statsFunctions.js` (`event` ~lines 379–441)
- Test: `test/datadogMode.js`

- [ ] **Step 1: Write the failing test (append to the metric-wire `describe` or a new one)**

Add to `test/datadogMode.js`:

```javascript
describe('#datadogMode event/check wire output', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  const lastMessage = (client) => {
    return client.mockBuffer[client.mockBuffer.length - 1];
  };

  it('appends |c: and |card: to events', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.event('title', 'text', { cardinality: 'low' });
    const msg = lastMessage(client);
    assert.ok(msg.indexOf('|c:cid123') !== -1, msg);
    assert.ok(msg.indexOf('|card:low') !== -1, msg);
    client.close(() => {});
  });

  it('appends |c: to service checks before the message field', () => {
    const client = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    client.check('svc', 0, { message: 'all good' });
    const msg = lastMessage(client);
    assert.ok(msg.indexOf('|c:cid123') !== -1, msg);
    // container id must come before the trailing m: field
    assert.ok(msg.indexOf('|c:cid123') < msg.indexOf('|m:all good'), msg);
    client.close(() => {});
  });

  it('check supports per-call cardinality', () => {
    const client = new StatsD({ mock: true, datadog: true });
    client.check('svc', 0, { cardinality: 'high' });
    assert.ok(lastMessage(client).indexOf('|card:high') !== -1);
    client.close(() => {});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: FAIL — events/checks lack extension fields.

- [ ] **Step 3: Pass cardinality from `event()` into `send()`**

Events go through `send()`, which now injects the extension fields after tags (Task 5), so `event()` only needs to forward the per-call cardinality. In `lib/statsFunctions.js` `event()`, change the final call (current line 440) from:

```javascript
    this.send(message, tags, callback);
```

to:

```javascript
    this.send(message, tags, options && options.cardinality, callback);
```

(The container id / external data fields are added automatically inside `send()` whenever datadog mode is active.)

- [ ] **Step 4: Run events portion to verify pass**

Run: `npx mocha test/datadogMode.js --timeout 5000 -g "events"`
Expected: the events test PASSES. (Checks test still fails — handled in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add lib/statsFunctions.js test/datadogMode.js
git commit -m "Inject extension fields into events"
```

---

## Task 7: Inject extension fields for service checks

**Files:**
- Modify: `lib/statsFunctions.js` (`check` ~lines 309–363)

- [ ] **Step 1: Inject into `check()` before the message field**

In `lib/statsFunctions.js` `check()`, the `check` array is built and tags pushed (current lines 339–345), then the message is pushed last (lines 347–350). Insert the extension fields **between** the tags push and the message push. After this block:

```javascript
    if (mergedTags.length > 0) {
      check.push(`#${mergedTags.join(',')}`);
    }
```

insert:

```javascript
    // DogStatsD extension fields must come before the trailing message (m:) field.
    const checkExtensionFields = this.getDatadogExtensionFields(metadata.cardinality);
    for (const field of checkExtensionFields) {
      check.push(field);
    }
```

- [ ] **Step 2: Run to verify pass**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: PASS (all datadogMode tests, including the check ordering and per-call cardinality).

- [ ] **Step 3: Run existing event/check tests for regressions**

Run: `npx mocha test/event.js test/check.js --timeout 5000`
Expected: PASS (no extension fields appear because those tests don't enable datadog mode; verify they still match exact strings).

- [ ] **Step 4: Lint**

Run: `npx eslint lib/statsFunctions.js`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/statsFunctions.js test/datadogMode.js
git commit -m "Inject extension fields into service checks before message field"
```

---

## Task 8: Child-client inheritance + real-transport wire test

**Files:**
- Modify: `lib/statsd.js` (`ChildClient` ~lines 910–948)
- Test: `test/datadogMode.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/datadogMode.js`:

```javascript
const helpers = require('./helpers/helpers.js');
const closeAll = helpers.closeAll;
const createServer = helpers.createServer;
const createHotShotsClient = helpers.createHotShotsClient;

describe('#datadogMode child inheritance', () => {
  beforeEach(clearDDEnv);
  afterEach(clearDDEnv);

  it('child inherits datadog mode and container id', () => {
    const parent = new StatsD({ mock: true, datadog: true, containerID: 'cid123' });
    const child = parent.childClient({});
    assert.strictEqual(child.datadog, true);
    assert.strictEqual(child.containerID, 'cid123');
    child.increment('c');
    assert.strictEqual(child.mockBuffer[child.mockBuffer.length - 1], 'c:1|c|c:cid123');
    parent.close(() => {});
  });

  it('child can override cardinality default', () => {
    const parent = new StatsD({ mock: true, datadog: true, cardinality: 'low' });
    const child = parent.childClient({ cardinality: 'high' });
    assert.strictEqual(child.cardinality, 'high');
    parent.close(() => {});
  });
});

describe('#datadogMode real-transport ordering (udp)', () => {
  let server;
  let statsd;
  beforeEach(clearDDEnv);
  afterEach(done => {
    closeAll(server, statsd, false, () => { clearDDEnv(); done(); });
  });

  it('emits |#tags then |c: over udp', done => {
    server = createServer('udp', opts => {
      statsd = createHotShotsClient(Object.assign(opts, {
        datadog: true, containerID: 'cid123',
      }), 'client');
      statsd.increment('test', 1, ['a:b']);
    });
    server.on('metrics', metrics => {
      assert.strictEqual(metrics, 'test:1|c|#a:b|c:cid123');
      done();
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: FAIL — child `datadog`/`containerID` are `false`/`undefined` (ChildClient doesn't pass them yet).

- [ ] **Step 3: Pass datadog fields through ChildClient**

In `lib/statsd.js` `ChildClient`, add these properties to the options object passed to `Client.call(this, { ... })` (alongside the existing `telemetry: parent.telemetry` entry):

```javascript
    datadog        : parent.datadog,
    originDetection: parent.originDetection,
    containerID    : parent.containerID,
    externalData   : parent.externalData,
    cardinality    : options.cardinality ?
        helpers.validateCardinality(options.cardinality) :
        parent.cardinality,
```

(The constructor's `options.isChild` branch from Task 4 already reads these.)

- [ ] **Step 4: Run to verify pass**

Run: `npx mocha test/datadogMode.js --timeout 5000`
Expected: PASS (all, including the real-UDP tag-ordering test which confirms `|#a:b|c:cid123`).

- [ ] **Step 5: Lint**

Run: `npx eslint lib/statsd.js test/datadogMode.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/statsd.js test/datadogMode.js
git commit -m "Inherit datadog mode and fields in child clients; verify tag ordering"
```

---

## Task 9: TypeScript definitions

**Files:**
- Modify: `types.d.ts`
- Test: `test/typescript-compilation.js` already validates compilation; add usage to the existing TS fixture if one exists, otherwise rely on the compile test.

- [ ] **Step 1: Add option fields to `ClientOptions`**

In `types.d.ts`, inside `interface ClientOptions` (after `includeDataDogTags?: boolean;`), add:

```typescript
  datadog?: boolean;
  originDetection?: boolean;
  containerID?: string;
  cardinality?: 'none' | 'low' | 'orchestrator' | 'high';
```

- [ ] **Step 2: Add `cardinality` to `ChildClientOptions`**

```typescript
export interface ChildClientOptions {
  globalTags?: Tags;
  prefix?: string;
  suffix?: string;
  errorHandler?: (err: Error) => void;
  cardinality?: 'none' | 'low' | 'orchestrator' | 'high';
}
```

- [ ] **Step 3: Add `cardinality` to `MetricOptions`, `EventOptions`, `CheckOptions`**

In `MetricOptions` add after `timestamp`:

```typescript
  /** Tag cardinality for this metric (DogStatsD datadog mode only). */
  cardinality?: 'none' | 'low' | 'orchestrator' | 'high';
```

In `EventOptions` and `CheckOptions` add:

```typescript
  cardinality?: 'none' | 'low' | 'orchestrator' | 'high';
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx mocha test/typescript-compilation.js --timeout 60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add types.d.ts
git commit -m "Add datadog mode options to TypeScript definitions"
```

---

## Task 10: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the options to the options reference**

In `README.md`, in the constructor options list (near the `includeDataDogTags` / `telegraf` bullets, ~lines 77–102), add bullets:

```markdown
* `datadog`: Enable Datadog mode, turning on origin detection (`|c:`), External Data (`|e:`), cardinality (`|card:`), and client telemetry by default. Pass `true`/`false` to force it (like `telegraf`). When unset, it auto-detects: enabled when not using `telegraf` and either a Datadog signal env var is set (`DD_AGENT_HOST`, `DD_DOGSTATSD_PORT`, `DD_ENTITY_ID`, `DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_EXTERNAL_ENV`, `DD_CARDINALITY`) or the protocol is `uds`. `default: auto-detect`
* `originDetection`: When in Datadog mode, auto-detect the container ID from cgroups and send it as `|c:` for [origin detection](https://docs.datadoghq.com/developers/dogstatsd/?tab=kubernetes#origin-detection-over-udp). Respects `DD_ORIGIN_DETECTION_ENABLED`. Linux only. `default: true in datadog mode`
* `containerID`: Manually set the container ID (skips cgroup parsing). Only used in Datadog mode. `default: undefined`
* `cardinality`: Client-wide default tag cardinality sent as `|card:` — one of `none`, `low`, `orchestrator`, `high`. Falls back to the `DD_CARDINALITY` / `DATADOG_CARDINALITY` env var. Only used in Datadog mode. `default: undefined`
```

- [ ] **Step 2: Note per-call `cardinality` in the metric-options list**

Near the `timestamp` metric option (~line 117), add:

```markdown
* `cardinality`:  Tag cardinality for this metric (`none`/`low`/`orchestrator`/`high`). Overrides the client-wide `cardinality`. (DogStatsD datadog mode only)
```

- [ ] **Step 3: Update the backend-functionality list**

In the "DogStatsD, Telegraf, and OpenTelemetry functionality" list (~lines 327–338), add:

```markdown
* datadog parameter - DogStatsD
* originDetection parameter - DogStatsD
* containerID parameter - DogStatsD
* cardinality parameter / option - DogStatsD
* origin detection (|c:) and external data (|e:) - DogStatsD
```

- [ ] **Step 4: Add a "Datadog mode" section**

After the backend-functionality list (before "## OpenTelemetry Collector Compatibility"), add:

```markdown
## Datadog mode

When talking to a Datadog Agent, enable Datadog mode to get the same behavior as the official DogStatsD clients:

```javascript
const client = new StatsD({ datadog: true });
// or rely on auto-detection (DD_AGENT_HOST etc. set, or protocol: 'uds')
```

Datadog mode adds three DogStatsD protocol-extension fields and flips client telemetry on by default:

* **Origin detection** (`|c:`) — the container ID is auto-detected from cgroups (Linux only) for [origin detection](https://docs.datadoghq.com/developers/dogstatsd/?tab=kubernetes#origin-detection-over-udp). Disable with `originDetection: false` or `DD_ORIGIN_DETECTION_ENABLED=false`; override with `containerID`.
* **External Data** (`|e:`) — read from the `DD_EXTERNAL_ENV` environment variable (injected by the Datadog Admission Controller).
* **Cardinality** (`|card:`) — set a client-wide default via `cardinality` or `DD_CARDINALITY`, or per metric/event/check via the options object.
* **Telemetry** — `includeDatadogTelemetry` defaults to `true` in datadog mode (set it to `false` to opt out).

Datadog mode never activates for `telegraf` clients, and adds no extension fields when off, so non-Datadog (StatsD/Telegraf) usage is unaffected.

Per-call cardinality example:

```javascript
client.gauge('mem.used', 1234, { tags: ['x:y'], cardinality: 'low' });
```
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document datadog mode in README"
```

---

## Task 11: CHANGES.md entry + verification

**Files:**
- Modify: `CHANGES.md`

- [ ] **Step 1: Add the 16.0.0 entry**

In `CHANGES.md`, add above the `## 15.0.0 (2026-5-28)` heading:

```markdown
## 16.0.0 (2026-5-30)

* [@bdeitte](https://github.com/bdeitte) BREAKING: Add Datadog mode for parity with the official DogStatsD clients. A new `datadog` option (explicit `true`/`false`, or auto-detected from `DD_AGENT_HOST`/`DD_ENV`/other `DD_*` signals or the `uds` protocol) enables:
     * Origin detection — the container ID is detected from cgroups (Linux only) and sent as `|c:`. Configurable via `originDetection`, `containerID`, and `DD_ORIGIN_DETECTION_ENABLED`.
     * External Data — read from `DD_EXTERNAL_ENV` and sent as `|e:`.
     * Cardinality — a client-wide default (`cardinality` option or `DD_CARDINALITY`/`DATADOG_CARDINALITY`) plus a per metric/event/check `cardinality` option, sent as `|card:`.
     * Client telemetry (`includeDatadogTelemetry`) now defaults to on in Datadog mode.
   This is a breaking change because clients running in a Datadog environment (e.g. with `DD_AGENT_HOST` set) will auto-detect Datadog mode and begin emitting the new `|c:`/`|e:` wire fields and client telemetry. Opt out with `datadog: false`, `originDetection: false`, and/or `includeDatadogTelemetry: false`. Non-Datadog (StatsD/Telegraf) usage is unaffected.
```

- [ ] **Step 2: Run the full test suite + lint (the project gate)**

Run: `npm test`
Expected: lint passes and all tests pass, including `test/originDetection.js`, `test/datadogHelpers.js`, and `test/datadogMode.js`.

- [ ] **Step 3: Commit**

```bash
git add CHANGES.md
git commit -m "Add 16.0.0 CHANGES entry for datadog mode"
```

---

## Final verification checklist

- [ ] `npm test` is green (lint + all tests).
- [ ] `npx mocha test/datadogMode.js test/originDetection.js test/datadogHelpers.js --timeout 5000` passes.
- [ ] Non-datadog output unchanged: `npx mocha test/globalTags.js test/event.js test/check.js test/timestamp.js --timeout 5000` passes.
- [ ] No new ESLint disables beyond the documented `no-sync` / `no-control-regex` ones.
- [ ] README, types.d.ts, and CHANGES.md all updated (per CLAUDE.md "Follow for all code changes").

---

## Spec coverage self-check

- Datadog flag (explicit + auto-detect + telegraf conflict): Task 4.
- Origin detection module (cgroup v1, mountinfo, cgroup v2 inode, host-ns check, non-Linux no-op, explicit override): Task 2; wired in Task 4.
- External Data (`DD_EXTERNAL_ENV` → `|e:`, sanitization): Tasks 3, 4, 5.
- Cardinality (client default + env + per-call on metric/event/check, validation): Tasks 3, 5, 6, 7.
- Telemetry default flip under datadog mode: Task 4.
- Wire injection + ordering (metrics, events, checks-before-`m:`): Tasks 5, 6, 7; real-transport ordering verified Task 8.
- Child-client inheritance (no re-parse, cardinality override): Task 8.
- Docs/types/CHANGES: Tasks 9, 10, 11.
- Versioning (16.0.0, BREAKING note): Task 11.
