'use strict';

// Can voice input work right now, and if not, what does the user have to do?
//
// Clients ask before they start recording (GET /api/voice/readiness), and both
// recognition paths answer with the same shape when they cannot run (HTTP 503
// `code: 'voice_not_ready'` from /api/voice/stt, a `{type:'error', code}` frame
// from /ws/voice). The client then offers the fix in place: download the local
// model and watch it install, or open settings to enter a cloud key. Without
// this the user dictated a whole sentence first and only then got a raw
// "WHISPER_API_KEY not set".
//
// `reason` is a machine state, never prose, so every client words it itself:
//   downloading | missing | failed  → the local model is the fix (offer download)
//   unsupported | disabled          → only a cloud key can help
const NOT_READY = 'voice_not_ready';

function cloudConfigured(voiceCfg = {}, streaming = {}) {
  if (voiceCfg.WHISPER_API_KEY || voiceCfg.OPENROUTER_API_KEY) return true;
  return ['openai', 'volcano', 'funasr'].some(k => streaming[k] && streaming[k].ready);
}

function voiceReadiness({ asrLocal, installer, voiceCfg, streamingStatus } = {}) {
  const download = installer && typeof installer.status === 'function' ? installer.status() : null;
  const localReady = !!(asrLocal && typeof asrLocal.isAvailable === 'function' && asrLocal.isAvailable());
  let streaming = {};
  try { streaming = (typeof streamingStatus === 'function' ? streamingStatus() : streamingStatus) || {}; } catch (_) {}
  const cloud = cloudConfigured(voiceCfg, streaming);
  const engine = localReady ? 'local' : (cloud ? 'cloud' : null);
  let reason = null;
  if (!engine) {
    const state = download && download.state;
    reason = ['downloading', 'failed', 'unsupported', 'disabled'].includes(state) ? state : 'missing';
  }
  return {
    ready: !!engine,
    engine,
    reason,
    cloudConfigured: cloud,
    // Lets a client draw the same progress bar the settings page shows.
    download,
  };
}

module.exports = { NOT_READY, voiceReadiness, cloudConfigured };
