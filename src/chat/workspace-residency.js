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
  function idle(name) {
    const s = status(name);
    return !pending(name) && !s?.busy && !s?.queued && !s?.recycling;
  }
  function assertSend(name) {
    if (entries.get(name)?.parked) throw busy();
  }
  function track(name, cwd) {
    assertSend(name);
    const entry = entries.get(name);
    if (entry && entry.path !== location(cwd)) throw busy();
    if (!entry) entries.set(name, { path: location(cwd), workspaceId: null, parked: false });
  }
  function park(name, workspace) {
    if (!workspace?.path || !idle(name)) return { parked: false };
    const entry = entries.get(name);
    if (entry && entry.path !== location(workspace.path)) return { parked: false };
    entries.set(name, { path: location(workspace.path), workspaceId: workspace.id, parked: true });
    return { parked: true };
  }
  async function claim(name, workspace, { exclusive = false } = {}) {
    if (!workspace?.path) throw busy();
    const target = location(workspace.path);
    for (const [id, entry] of [...entries]) {
      if (id !== name && entry.path !== target && !(workspace.id && entry.workspaceId === workspace.id)) continue;
      if (!idle(id)) throw busy();
      if (id === name && entry.path === target && !exclusive) continue;
      if (status(id)?.backgroundActive) throw busy();
      // Block direct sends throughout the asynchronous close/join barrier.
      entry.parked = true;
      const result = await closeAndWait(id);
      if (result?.closed !== true) throw busy();
    }
    entries.set(name, { path: target, workspaceId: workspace.id, parked: exclusive });
    return { claimed: true };
  }
  return { track, park, claim, assertSend, forget: name => entries.delete(name) };
}

module.exports = { createWorkspaceResidency };
