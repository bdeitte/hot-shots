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
    return stat.ino === OD.HOST_CGROUP_NAMESPACE_INODE;
  } catch (e) {
    debug('hot-shots originDetection: cannot stat cgroup ns: %s', e && e.message);
    return false;
  }
}

/**
 * Scans text for a container id using the shared regex, returning the RIGHTMOST
 * match on the first line that contains one. Rightmost matters because a cgroup
 * path can contain a pod/task UUID before the actual container id
 * (e.g. /kubepods/.../pod<uuid>/<container-id>); the container id is always last.
 * @param {String} text Text to scan (cgroup or mountinfo contents)
 * @returns {String|undefined} The matched container id
 */
function matchContainerID(text) {
  const re = new RegExp(OD.CONTAINER_ID_RE.source, 'g');
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.indexOf('sandboxes') === -1) {
      const matches = line.match(re);
      if (matches && matches.length > 0) {
        return matches[matches.length - 1];
      }
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
    if (parts.length >= 3) {
      const controller = parts[1];
      const cgroupNodePath = parts.slice(2).join(':');
      // cgroup v2 uses an empty controller; cgroup v1 uses the memory controller.
      let controllerSegment;
      if (controller === '') {
        controllerSegment = '';
      } else if (controller.split(',').indexOf(OD.CGROUPV1_BASE_CONTROLLER) !== -1) {
        controllerSegment = `/${OD.CGROUPV1_BASE_CONTROLLER}`;
      }
      if (controllerSegment !== undefined) {
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
  if (isHostCgroupNamespace(d.statSync)) { // eslint-disable-line no-sync
    const id = readContainerIDFromCgroup(d.readFileSync) || // eslint-disable-line no-sync
      readContainerIDFromMountInfo(d.readFileSync); // eslint-disable-line no-sync
    if (id) {
      return id;
    }
  }
  return getCgroupInode(d.readFileSync, d.statSync); // eslint-disable-line no-sync
}

module.exports = {
  getContainerID: getContainerID,
};
