'use strict';

// `/api/voice/stt` is the one voice REST route Node still owns: it feeds an
// uploaded audio buffer straight into the in-process sherpa-onnx ASR and stays
// behind the upload admission gate. Every other voice route (refine, confirm,
// progress-summary, feedback, vocab, readiness, hotwords, test-sse and the
// `/api/settings/voice*` family) is owned by the Rust front door; the Node-only
// facts and side effects those handlers need live in `voice-host.js`.
//
// The full pre-migration implementation is frozen in
// tests/helpers/legacy-voice-routes.js as the differential oracle.

const { NOT_READY, voiceReadiness } = require('../voice/readiness');
const { mountVoiceHostRoute } = require('./voice-host');

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`voice routes require ${name}`);
  return value;
}

function mountVoiceRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('voice routes require an Express-compatible app');
  }

  const {
    uploadVoice,
    voice,
    asrLocal,
    asrModelInstaller,
    voiceAsr,
    fetchImpl = globalThis.fetch,
    FormDataCtor = globalThis.FormData,
    BlobCtor = globalThis.Blob,
    log = console,
  } = deps;

  requireFunction(uploadVoice, 'uploadVoice middleware');
  if (!voice || !voice.cfg) throw new TypeError('voice routes require voice service');
  if (!asrLocal || typeof asrLocal.isAvailable !== 'function') throw new TypeError('voice routes require local ASR service');
  if (!asrModelInstaller || typeof asrModelInstaller.status !== 'function'
    || typeof asrModelInstaller.start !== 'function' || typeof asrModelInstaller.cancel !== 'function') {
    throw new TypeError('voice routes require the local ASR model installer');
  }
  if (!voiceAsr || typeof voiceAsr.providerStatus !== 'function') throw new TypeError('voice routes require streaming ASR service');

  const { buildWhisperPrompt } = voice;

  // Asked by every mic button before it records (see src/voice/readiness.js).
  function readiness() {
    return voiceReadiness({
      asrLocal,
      installer: asrModelInstaller,
      voiceCfg: voice.cfg,
      streamingStatus: () => voiceAsr.providerStatus(),
    });
  }

  app.post('/api/voice/stt', uploadVoice, async (req, res) => {
    const reqId = `stt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    log.log(`[multicc/stt][${reqId}] POST /api/voice/stt received`);
    if (!req.file) return res.status(400).json({ error: '未收到音频文件' });

    log.log(`[multicc/stt][${reqId}] File: ${req.file.originalname}, size: ${req.file.size}, mime: ${req.file.mimetype}`);
    if (asrLocal.isAvailable()) {
      try {
        const result = await asrLocal.transcribeBuffer(req.file.buffer, req.file.mimetype);
        log.log(`[multicc/stt][${reqId}] Local ASR ok in ${result.ms}ms (decode ${result.decodeMs}ms + infer ${result.inferMs}ms, audio ${result.audioSec.toFixed(1)}s), text length: ${result.text.length}`);
        return res.json({ text: result.text, duration_ms: result.ms, engine: 'local' });
      } catch (err) {
        log.error(`[multicc/stt][${reqId}] Local ASR failed, falling back to cloud:`, err.message);
      }
    }

    const apiKey = voice.cfg.WHISPER_API_KEY || voice.cfg.OPENROUTER_API_KEY;
    if (!apiKey) {
      // Not a server fault: the client turns `readiness` into "download the
      // local model / enter a cloud key" instead of showing this text.
      return res.status(503).json({
        error: '本地 ASR 未就绪，且 WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置',
        code: NOT_READY,
        readiness: readiness(),
      });
    }

    log.log(`[multicc/stt][${reqId}] Forwarding to ${voice.cfg.WHISPER_BASE_URL}/audio/transcriptions (model: ${voice.cfg.WHISPER_MODEL})`);
    const t0 = Date.now();
    const abort = new AbortController();
    const fetchTimeout = setTimeout(() => abort.abort(), 30000);
    try {
      const formData = new FormDataCtor();
      const blob = new BlobCtor([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
      formData.append('file', blob, req.file.originalname || 'audio.webm');
      formData.append('model', voice.cfg.WHISPER_MODEL);
      if (voice.cfg.WHISPER_LANGUAGE) formData.append('language', voice.cfg.WHISPER_LANGUAGE);
      const whisperPrompt = buildWhisperPrompt();
      if (whisperPrompt) {
        formData.append('prompt', whisperPrompt);
        log.log(`[multicc/stt][${reqId}] Whisper prompt (${whisperPrompt.length} chars): ${whisperPrompt.slice(0, 120)}...`);
      }

      const response = await fetchImpl(`${voice.cfg.WHISPER_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: abort.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        log.error(`[multicc/stt][${reqId}] Whisper API error ${response.status}: ${errText.slice(0, 300)}`);
        return res.status(502).json({ error: `Whisper API ${response.status}: ${errText.slice(0, 200)}` });
      }
      const result = await response.json();
      const durationMs = Date.now() - t0;
      log.log(`[multicc/stt][${reqId}] Success in ${durationMs}ms, text length: ${(result.text || '').length}`);
      res.json({ text: result.text || '', duration_ms: durationMs, engine: 'cloud' });
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err.name === 'AbortError' ? '云端 Whisper 超时（30s）' : err.message;
      log.error(`[multicc/stt][${reqId}] Error after ${durationMs}ms:`, message);
      res.status(500).json({ error: message });
    } finally {
      clearTimeout(fetchTimeout);
    }
  });

  // The Rust front door owns the public voice HTTP surface; this host port is
  // the Node-only runtime facts and side effects it calls back for.
  const host = mountVoiceHostRoute(app, deps);
  return { getConsistency() { return host.getConsistency(); } };
}

module.exports = { mountVoiceRoutes };
