'use strict';

const { randomUUID } = require('node:crypto');
const { createMonitorAdmission, CALLBACK_ID } = require('./monitor-admission');

// stream-json exposes the same hook protocol used by the SDK. Install before
// the first prompt; unsupported/failed initialization must not silently allow
// native Monitor inference outside the host's admission path.
function createMonitorControl(proc, deliver, isOwnPrompt) {
  const requestId = randomUUID();
  const hook = createMonitorAdmission(deliver, isOwnPrompt);
  let ready = false, resolve, reject;
  const initialized = new Promise((yes, no) => { resolve = yes; reject = no; });
  const fail = () => reject(Object.assign(new Error('Monitor hook initialization failed'), { code: 'MONITOR_INIT_FAILED' }));
  const timer = setTimeout(fail, 10000);
  const write = value => proc.stdin.write(`${JSON.stringify(value)}\n`);
  proc.once('exit', fail);
  initialized.finally(() => { clearTimeout(timer); proc.removeListener('exit', fail); }).catch(() => {});
  write({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize',
    hooks: { UserPromptSubmit: [{ hookCallbackIds: [CALLBACK_ID] }] } } });
  function accept(event) {
    if (event.type === 'control_response' && event.response?.request_id === requestId) {
      if (event.response.subtype === 'success') { ready = true; resolve(); } else fail();
      return true;
    }
    if (event.type !== 'control_request' || event.request?.subtype !== 'hook_callback'
        || event.request.callback_id !== CALLBACK_ID) return false;
    void hook(event.request.input).then(response => {
      if (!proc.stdin.destroyed && !proc.stdin.writableEnded) write({ type: 'control_response',
        response: { subtype: 'success', request_id: event.request_id, response } });
    }).catch(() => {
      // No permission to continue if the host could not process this hook.
      try { write({ type: 'control_response', response: { subtype: 'error',
        request_id: event.request_id, error: 'Monitor admission failed' } }); } catch (_) {}
    });
    return true;
  }
  return { initialized, accept, get ready() { return ready; } };
}

module.exports = { createMonitorControl };
