'use strict';

const { getNative } = require('../native/binding');
const fs = require('fs');
const path = require('path');

const VOICE_ROUTER_ID = '__voice_router__';
const VOICE_ROUTER_LABEL = '🎙️ 实时语音 Router';

function isVoiceRouterRecord(record) {
  return getNative().isVoiceRouter(record);
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

  return getNative().voiceRouterProvisioner({
    mutate, cwd, cli, now: () => now(),
    lookup: id => records.get(id), draftGet: (draft, id) => draft.get(id),
    draftSet: (draft, id, record) => draft.set(id, record),
    mkdir: () => fs.mkdirSync(cwd, { recursive: true }),
  });
}
module.exports = {
  VOICE_ROUTER_ID,
  VOICE_ROUTER_LABEL,
  createVoiceRouterProvisioner,
  isVoiceRouterRecord,
};
