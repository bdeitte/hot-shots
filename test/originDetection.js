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

  it('returns the container id, not a pod UUID earlier in the cgroup path', () => {
    const podUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const containerId = 'f'.repeat(64);
    const deps = fakeDeps({
      inodes: { '/proc/self/ns/cgroup': HOST_INODE },
      files: {
        '/proc/self/cgroup': `11:memory:/kubepods/besteffort/pod${podUuid}/${containerId}\n`,
      },
    });
    assert.strictEqual(originDetection.getContainerID(deps), containerId);
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
