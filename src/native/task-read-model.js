'use strict';

const runtime = require('./runtime');

// Async transport bridge. The Rust owner
// validates all commands and opens the source read-only. Node also supplies ICU
// collation for historical IDs, because it is part of the existing V8 contract.
// Do not add projection or caching rules here.
function createTaskReadModel({ addon = runtime.getNative('read_model', 'rust'), maxPending = 16 } = {}) {
  if (typeof addon?.RustTaskReadModel !== 'function') throw new Error('read_model_backend_unavailable');
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 16) throw new Error('read_model_invalid_queue_limit');
  const native = new addon.RustTaskReadModel();
  let tail = Promise.resolve(), pending = 0, closing = false, closed = false, closePromise;
  let idOrder;
  const invoke = input => runtime.runNative(() => native.run(input)).then(reply => JSON.parse(reply.result));
  async function execute(input) {
    const command = JSON.parse(input);
    if (command?.op === 'air' && ['apply', 'publish'].includes(command.command?.op)) {
      try { return await invoke(input); }
      catch (error) {
        if (!/read_model_identity_order_(required|stale)/.test(error.message)) throw error;
        const { idOrder: ignored, dayStarts, ...candidate } = command.command;
        const { ids } = await invoke(JSON.stringify({ op: 'air', command: { snapshot: candidate.snapshot, partial: candidate.partial, removed: candidate.removed, op: 'identities' } }));
        return invoke(JSON.stringify({ ...command, command: { ...candidate, ...(dayStarts ? { dayStarts } : {}), idOrder: ids.sort((a, b) => a.localeCompare(b)) } }));
      }
    }
    if (!['refresh', 'sync'].includes(command?.op)) {
      const result = await invoke(input);
      if (command?.op === 'open') idOrder = undefined;
      return result;
    }
    try { return await invoke(command.op === 'refresh' && idOrder ? JSON.stringify({ ...command, idOrder }) : input); }
    catch (error) {
      if (!/read_model_identity_order_(required|stale)/.test(error.message)) throw error;
      const { ids } = await invoke('{"op":"identities"}');
      idOrder = ids.sort((a, b) => a.localeCompare(b));
      // One retry only. Concurrent identity changes must fail visibly rather
      // than spin or publish a partially ordered snapshot.
      return invoke(JSON.stringify({ ...command, idOrder }));
    }
  }
  function enqueue(command) {
    if (pending >= maxPending) return Promise.reject(new Error('read_model_queue_full'));
    // Encode now so later caller mutations cannot change an admitted command.
    let input;
    try { input = JSON.stringify(command); } catch (error) { return Promise.reject(error); }
    pending++;
    const result = tail.then(() => execute(input));
    const settled = result.finally(() => { pending--; });
    tail = settled.then(() => {}, () => {});
    return settled;
  }
  function run(command) {
    if (closing || closed) return Promise.reject(new Error('read_model_closed'));
    if (command?.op === 'close') return close();
    return enqueue(command);
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    // Closing must be admitted even when the public queue is full, and must run
    // after all prior commands. Failure of one command never poisons the queue.
    closePromise = tail.then(() => runtime.runNative(() => native.run('{"op":"close"}')))
      .then(reply => { closed = true; return JSON.parse(reply.result); })
      .catch(error => { closing = false; closePromise = undefined; throw error; });
    return closePromise;
  }
  return { run, close };
}
module.exports = { createTaskReadModel };
