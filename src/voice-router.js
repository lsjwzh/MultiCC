'use strict';

// The global voice router session.
//
// A chat launch already knows where it belongs — the session the user pressed
// the phone button in. A *global* launch does not, and guessing a Fleet from a
// spoken sentence is exactly the failure mode invariant 6 forbids. So global
// voice lands in one dedicated gateway session whose only job is to decide, in
// the open, which Fleet's Commander should receive the work — the same shape as
// the WeChat gateway, with its own prompt and its own pending state.
//
// It is provisioned when the global voice gateway is first configured, on the
// same principle as the WeChat bridge creating `__gateway__` at start: a router
// that does not exist fails closed (`voice_router_not_provisioned`) rather than
// silently routing somewhere else.

const fs = require('fs');
const path = require('path');

const VOICE_ROUTER_ID = '__voice_router__';
const VOICE_ROUTER_LABEL = '🎙️ 实时语音 Router';

function isVoiceRouterRecord(record) {
  return !!record && record.id === VOICE_ROUTER_ID && record.type === 'gateway' && record.kind === 'chat';
}

function createVoiceRouterProvisioner({
  records,
  mutate,
  runtimeRoot,
  cli = 'claude',
  now = () => new Date().toISOString(),
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('voice router provisioner requires records Map');
  if (typeof mutate !== 'function') throw new TypeError('voice router provisioner requires mutate');
  const cwd = path.join(String(runtimeRoot || process.cwd()), 'voice-router');

  function get() {
    const record = records.get(VOICE_ROUTER_ID);
    return isVoiceRouterRecord(record) ? record : null;
  }

  function ensure() {
    const existing = records.get(VOICE_ROUTER_ID);
    if (existing) {
      // Someone else owns this id. Refuse rather than overwrite a real session.
      if (!isVoiceRouterRecord(existing)) return { ok: false, code: 'voice_router_id_conflict' };
      return { ok: true, created: false, record: existing };
    }
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
    const stamp = now();
    let record = null;
    mutate('voice.router-provision', draft => {
      const collision = draft.get(VOICE_ROUTER_ID);
      if (collision) { record = collision; return; }
      record = {
        id: VOICE_ROUTER_ID,
        type: 'gateway',
        kind: 'chat',
        cli,
        cliSessionId: null,
        dirId: null,
        label: VOICE_ROUTER_LABEL,
        cwd,
        createdAt: stamp,
        updatedAt: stamp,
      };
      draft.set(VOICE_ROUTER_ID, record);
    });
    return { ok: true, created: true, record };
  }

  return Object.freeze({ cwd, ensure, get, id: VOICE_ROUTER_ID });
}

module.exports = {
  VOICE_ROUTER_ID,
  VOICE_ROUTER_LABEL,
  createVoiceRouterProvisioner,
  isVoiceRouterRecord,
};
