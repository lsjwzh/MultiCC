'use strict';

const path = require('node:path');
const fs = require('node:fs');
const busy = () => Object.assign(new Error('workspace_busy'), { code: 'workspace_busy', backpressure: true });

// A warm process owns residency, not an execution lease. Parking fences new
// sends until admission acquires the next lease. A different writer must join
// the parked process before it can use that physical checkout. Lifecycle close
// (hibernation, separation, deletion) still destroys residency altogether.
function createWorkspaceResidency({ status, closeAndWait, pending }) {
  const entries = new Map();
  const location = value => {
    if (!value) return null;
    try { return fs.realpathSync(value); } catch (_) { return path.resolve(value); }
  };
  const owner = require('../native/binding').getNative().workspaceResidency({
    setActivity(entry, callback) { entry.onActivity = callback; },
    setParked(entry) { entry.parked = true; },
    entries, location, busy, status: name => status(name), pending: name => pending(name),
  });
  function activity(name) { entries.get(name)?.onActivity?.(); }
  async function claim(name, workspace, { exclusive = false } = {}) {
    if (!workspace?.path) throw busy();
    const target = location(workspace.path);
    for (const [id, entry] of [...entries]) {
      if (!owner.prepareClose(name, workspace, target, exclusive, id, entry)) continue;
      const result = await closeAndWait(id);
      if (result?.closed !== true) throw busy();
    }
    return owner.finish(name, workspace, target, exclusive);
  }
  return { track: owner.track, park: owner.park, claim, assertSend: owner.assertSend, activity, forget: name => entries.delete(name) };
}

module.exports = { createWorkspaceResidency };
