'use strict';

// POSIX process-group lifetime for workspace writers.
//
// A CLI spawned by the host can spawn its own background children (a Bash
// run_in_background, a watcher, a one-off daemon) without any event reaching
// the host — that gap was the write-before-registration window. Spawning the
// CLI as a process-group leader (detached) and holding its writer lease until
// the whole group is gone closes the window structurally: every descendant
// shares the group, so any write it ever makes happens while a registered
// lease is active, and the release transaction refuses early by itself.
//
// Windows has no POSIX group semantics; there the lease follows the direct
// child only and the descendant window stays documented, not closed.
const GROUPS = process.platform !== 'win32';
const GROUP_POLL_MS = 250;

function processGroups() {
  return GROUPS;
}

// Options fragment for child_process.spawn making the child a group leader.
function detachedSpawn() {
  return GROUPS ? { detached: true } : {};
}

// Is any member of the process group led by `pid` still alive? Anything but a
// clean ESRCH counts as alive — EPERM means the group exists but is not ours
// to signal, and an unexpected error must never read as "gone".
function groupAlive(pid) {
  if (!GROUPS || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// Invoke fn() once the group is (or becomes) empty. With no pid, no groups,
// or an already-empty group, fn runs synchronously. Returns the poll timer (or
// null) so callers can cancel; the timer is unref'd and never keeps the host
// alive for a leaked descendant.
function whenGroupEmpty(pid, fn, { pollMs = GROUP_POLL_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || !groupAlive(pid)) {
    fn();
    return null;
  }
  const timer = setInterval(() => {
    if (!groupAlive(pid)) {
      clearInterval(timer);
      fn();
    }
  }, pollMs);
  timer.unref?.();
  return timer;
}

module.exports = { processGroups, detachedSpawn, groupAlive, whenGroupEmpty, GROUP_POLL_MS };
