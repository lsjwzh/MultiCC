'use strict';
const { EventEmitter } = require('node:events');

async function exercise(api, input) {
  const timeout = [0, 1, 20, '3', NaN, Infinity][input.timeout];
  const closer = api.createProcessCloser({ timeoutMs: 20, code: 'FIXTURE_CLOSE' });
  const trace = [];
  function process(pid) {
    const proc = new EventEmitter();
    Object.assign(proc, { pid, exitCode: null, signalCode: null });
    const once = proc.once, remove = proc.removeListener;
    proc.once = function (name, listener) { trace.push(['once', pid, name]); return once.call(this, name, listener); };
    proc.removeListener = function (name, listener) { trace.push(['remove', pid, name]); return remove.call(this, name, listener); };
    return proc;
  }
  const first = process(input.mode === 4 ? 0 : 10), second = process(20);
  if (input.mode !== 0) { closer.track('name', first); closer.track('name', first); }
  if (input.mode === 3) closer.track('name', second);
  if (input.mode === 4 || input.mode === 5) first.emit('error', new Error('spawn failed'));
  const before = closer.isClosing('name');
  const sentinel = new Error('stop refused');
  let result, error;
  try {
    result = await closer.wait('name', () => {
      trace.push('stop');
      if (input.mode === 7) throw sentinel;
      if (input.mode === 1) first.emit('exit');
      if ([3, 5, 6].includes(input.mode)) queueMicrotask(() => { first.emit('exit'); second.emit('exit'); });
    }, { timeoutMs: timeout });
  } catch (caught) {
    error = { name: caught.name, message: caught.message, code: caught.code || null, identity: caught === sentinel };
  }
  const after = closer.isClosing('name');
  first.emit('exit'); second.emit('exit');
  const drained = await closer.drained('name');
  return { result: result || null, error: error || null, before, after,
    final: closer.isClosing('name'), drained, listeners: [first.listenerCount('exit'), first.listenerCount('error')], trace };
}
module.exports = { exercise };
