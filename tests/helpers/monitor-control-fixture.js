'use strict';
const { EventEmitter } = require('node:events');

async function exercise(api, input) {
  const proc = new EventEmitter(), writes = [], delivered = [];
  proc.stdin = {
    destroyed: input.flag === 1, writableEnded: input.flag === 2,
    write(line) {
      if (writes.length && input.flag === 3) throw new Error('write refused');
      writes.push(JSON.parse(line)); return true;
    },
  };
  const control = api.createMonitorControl(proc, event => {
    delivered.push(event);
    if (input.mode === 7) throw new Error('delivery refused');
    return { monitorOwned: input.flag !== 4 };
  }, () => input.flag === 5);
  const requestId = writes[0].request_id;
  const accepted = [];
  if (input.mode === 2) proc.emit('exit');
  else {
    if (input.mode === 3) accepted.push(control.accept({ type: 'control_response', response: { request_id: 'other', subtype: 'success' } }));
    accepted.push(control.accept({ type: 'control_response', response: { request_id: requestId, subtype: input.mode === 1 ? 'error' : 'success' } }));
  }
  let initialized;
  try { await control.initialized; initialized = { ok: true }; }
  catch (error) { initialized = { name: error.name, message: error.message, code: error.code }; }
  const { CALLBACK_ID } = require('../../src/native/binding').getMonitorAdmission();
  const event = { type: input.mode === 5 ? 'other' : 'control_request', request_id: 'hook-42',
    request: { subtype: 'hook_callback', callback_id: input.mode === 4 ? 'other' : CALLBACK_ID,
      input: { source: input.mode === 6 ? 'user' : 'cli', hook_event_name: 'UserPromptSubmit',
        prompt_id: 'one', prompt: '<task-notification><task-id>watch</task-id><event>ready</event></task-notification>' } } };
  accepted.push(control.accept(event));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
  for (const row of writes) if (row.request_id === requestId) row.request_id = 'initialize-id';
  return { initialized, ready: control.ready, accepted, writes, delivered, uuid,
    exitListeners: proc.listenerCount('exit'), keys: Object.keys(control),
    acceptShape: [control.accept.name, control.accept.length] };
}
module.exports = { exercise };
