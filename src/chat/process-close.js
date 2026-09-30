'use strict';

// A caller's deadline is not a process exit. Keep the captured child until its
// actual exit, independently of callers timing out or the session being deleted.
function createProcessCloser({ timeoutMs: defaultTimeout, code }) {
  const closing = new Map();
  function track(name, proc) {
    if (!proc || proc.exitCode !== null || proc.signalCode != null) return;
    let children = closing.get(name);
    if (!children) closing.set(name, children = new Map());
    if (children.has(proc)) return;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    children.set(proc, done);
    const exited = () => {
      proc.removeListener('exit', exited); proc.removeListener('error', failed);
      children.delete(proc);
      if (!children.size && closing.get(name) === children) closing.delete(name);
      finish();
    };
    const failed = () => { if (!proc.pid) exited(); };
    proc.once('exit', exited); proc.once('error', failed);
  }
  async function wait(name, stop, { timeoutMs = defaultTimeout } = {}) {
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(timeout) || timeout < 1) {
      throw Object.assign(new TypeError('valid close timeout required'), { code: `${code}_INVALID` });
    }
    stop();
    const children = closing.get(name);
    if (!children?.size) return { closed: true, hadProcess: false };
    let timer;
    try {
      await Promise.race([Promise.all([...children.values()]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('process did not exit before cleanup deadline'), { code })), timeout);
      })]);
      return { closed: true, hadProcess: true };
    } finally { clearTimeout(timer); }
  }
  return { track, wait, isClosing: name => closing.has(name),
    drained: name => Promise.all([...(closing.get(name)?.values() || [])]) };
}

module.exports = { createProcessCloser };
