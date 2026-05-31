// ── Streaming ASR provider abstraction + WebSocket proxy ──
//
// Goal: a "豆包-like" low-latency dictation experience that works both in China
// and abroad. The browser streams PCM16 audio chunks over a WebSocket to us; we
// proxy to a region-appropriate streaming ASR provider and relay incremental
// (partial) + finalized transcript back, so text appears while the user speaks.
//
// Providers (selected per request or by a configured default):
//   - openai : OpenAI Realtime transcription   — default abroad, easiest to wire
//   - volcano: 火山引擎 流式语音识别 (豆包同款)  — best in China (binary protocol)
//   - funasr : self-hosted FunASR wss server    — offline / data-stays-local
//
// All providers implement the same tiny interface via createAsrSession():
//   { pushAudio(int16Buffer), finish(), close() }
// and report back through callbacks: onReady, onPartial, onFinal, onDone, onError.
//
// Browser ⇄ server `/ws/voice` protocol:
//   client → { type:'start', provider?, lang?, sampleRate }  then binary PCM16 frames
//   client → { type:'stop' }                                  (flush + finalize)
//   server → { type:'ready' | 'partial' | 'final' | 'done' | 'error', ... }

const WebSocket = require('ws');
const zlib = require('zlib');

// ── Provider config (mutated by server.js when settings change) ──
const cfg = {
  defaultProvider: process.env.ASR_PROVIDER || 'openai',

  openai: {
    apiKey: process.env.OPENAI_REALTIME_API_KEY || '',
    url: process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-transcribe',
    sampleRate: parseInt(process.env.OPENAI_REALTIME_SAMPLE_RATE || '24000', 10),
  },
  volcano: {
    appId: process.env.VOLC_ASR_APP_ID || '',
    accessToken: process.env.VOLC_ASR_ACCESS_TOKEN || '',
    resourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
    url: process.env.VOLC_ASR_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    sampleRate: 16000,
  },
  funasr: {
    url: process.env.FUNASR_WS_URL || '',          // e.g. ws://127.0.0.1:10095
    mode: process.env.FUNASR_MODE || '2pass',
    sampleRate: 16000,
  },
};

function applyConfig(updates) {
  if (!updates) return;
  if (updates.ASR_PROVIDER) cfg.defaultProvider = updates.ASR_PROVIDER;
  if (updates.OPENAI_REALTIME_API_KEY !== undefined) cfg.openai.apiKey = updates.OPENAI_REALTIME_API_KEY;
  if (updates.OPENAI_REALTIME_URL) cfg.openai.url = updates.OPENAI_REALTIME_URL;
  if (updates.OPENAI_REALTIME_MODEL) cfg.openai.model = updates.OPENAI_REALTIME_MODEL;
  if (updates.OPENAI_REALTIME_SAMPLE_RATE) cfg.openai.sampleRate = parseInt(updates.OPENAI_REALTIME_SAMPLE_RATE, 10) || 24000;
  if (updates.VOLC_ASR_APP_ID !== undefined) cfg.volcano.appId = updates.VOLC_ASR_APP_ID;
  if (updates.VOLC_ASR_ACCESS_TOKEN !== undefined) cfg.volcano.accessToken = updates.VOLC_ASR_ACCESS_TOKEN;
  if (updates.VOLC_ASR_RESOURCE_ID) cfg.volcano.resourceId = updates.VOLC_ASR_RESOURCE_ID;
  if (updates.VOLC_ASR_URL) cfg.volcano.url = updates.VOLC_ASR_URL;
  if (updates.FUNASR_WS_URL !== undefined) cfg.funasr.url = updates.FUNASR_WS_URL;
  if (updates.FUNASR_MODE) cfg.funasr.mode = updates.FUNASR_MODE;
}

// Which providers have enough config to actually run — surfaced to the UI so the
// client knows what it can pick.
function providerStatus() {
  return {
    default: cfg.defaultProvider,
    openai:  { ready: !!cfg.openai.apiKey,  model: cfg.openai.model,  sampleRate: cfg.openai.sampleRate },
    volcano: { ready: !!(cfg.volcano.appId && cfg.volcano.accessToken), sampleRate: cfg.volcano.sampleRate },
    funasr:  { ready: !!cfg.funasr.url, mode: cfg.funasr.mode, sampleRate: cfg.funasr.sampleRate },
  };
}

function targetSampleRate(provider) {
  const p = (cfg[provider] || cfg.openai);
  return p.sampleRate || 16000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: OpenAI Realtime transcription  (default abroad)
// Docs: wss://api.openai.com/v1/realtime ; session.update(type=transcription),
//       input_audio_buffer.append (base64 pcm16), server_vad auto-segments,
//       conversation.item.input_audio_transcription.{delta,completed}.
// ─────────────────────────────────────────────────────────────────────────────
function openaiSession(opts, cb) {
  const c = cfg.openai;
  if (!c.apiKey) { cb.onError('OPENAI_REALTIME_API_KEY 未配置'); return null; }

  const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : undefined;
  const upstream = new WebSocket(c.url, {
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
  let open = false;
  let finished = false;

  upstream.on('open', () => {
    open = true;
    upstream.send(JSON.stringify({
      type: 'session.update',
      session: {
        // beta transcription-session shape (most widely deployed)
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: c.model, ...(lang ? { language: lang } : {}) },
        turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
      },
    }));
    cb.onReady();
  });

  upstream.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    switch (m.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (m.delta) cb.onPartial(m.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (m.transcript) cb.onFinal(m.transcript);
        break;
      case 'error':
        cb.onError(m.error?.message || 'OpenAI realtime error');
        break;
    }
  });
  upstream.on('error', (e) => cb.onError(e.message));
  upstream.on('close', () => { if (!finished) cb.onDone(); });

  return {
    pushAudio(int16) {
      if (!open || upstream.readyState !== WebSocket.OPEN) return;
      const b64 = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
      upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    },
    finish() {
      finished = true;
      if (open && upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch (_) {}
      }
      // Give the server a moment to emit the final completed event before closing.
      setTimeout(() => { try { upstream.close(); } catch (_) {} cb.onDone(); }, 1200);
    },
    close() { finished = true; try { upstream.close(); } catch (_) {} },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: FunASR self-hosted wss server  (offline / data-stays-local)
// Protocol (funasr_wss_server): first JSON config, then raw PCM16 binary chunks,
// finish with {is_speaking:false}. Responses are JSON:
//   2pass-online → partial,  2pass-offline → corrected final per sentence.
// ─────────────────────────────────────────────────────────────────────────────
function funasrSession(opts, cb) {
  const c = cfg.funasr;
  if (!c.url) { cb.onError('FUNASR_WS_URL 未配置'); return null; }

  const upstream = new WebSocket(c.url, { rejectUnauthorized: false });
  let open = false;
  let finished = false;

  upstream.on('open', () => {
    open = true;
    upstream.send(JSON.stringify({
      mode: c.mode,
      chunk_size: [5, 10, 5],
      chunk_interval: 10,
      wav_name: 'multicc',
      is_speaking: true,
      itn: true,
    }));
    cb.onReady();
  });
  upstream.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const text = m.text || '';
    if (!text) return;
    if (m.mode === '2pass-offline' || m.is_final) cb.onFinal(text);
    else cb.onPartial(text);
  });
  upstream.on('error', (e) => cb.onError(e.message));
  upstream.on('close', () => { if (!finished) cb.onDone(); });

  return {
    pushAudio(int16) {
      if (!open || upstream.readyState !== WebSocket.OPEN) return;
      upstream.send(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength));
    },
    finish() {
      finished = true;
      if (open && upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(JSON.stringify({ is_speaking: false })); } catch (_) {}
      }
      setTimeout(() => { try { upstream.close(); } catch (_) {} cb.onDone(); }, 1500);
    },
    close() { finished = true; try { upstream.close(); } catch (_) {} },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider: 火山引擎 流式语音识别 (豆包同款) — binary protocol v3 (sauc bigmodel)
// NOTE: implemented to the documented framing but NOT yet verified against a live
// account. Needs real AppID/AccessToken to finish-tune (resourceId, seq, full vs
// audio-only flags). Marked clearly so it isn't mistaken for battle-tested code.
// Frame: [4-byte header][optional 4-byte seq][4-byte payload size][payload].
//   header[0]=0x11 (protocol v1, header size 1*4)
//   header[1]= msgType<<4 | flags ; header[2]= serialization<<4 | compression
//   serialization: 0x1 JSON ; compression: 0x1 gzip
// ─────────────────────────────────────────────────────────────────────────────
function volcanoBuildFrame(msgType, flags, payload) {
  const header = Buffer.from([0x11, (msgType << 4) | flags, (0x1 << 4) | 0x1, 0x00]);
  const gz = zlib.gzipSync(payload);
  const size = Buffer.alloc(4); size.writeUInt32BE(gz.length, 0);
  return Buffer.concat([header, size, gz]);
}
function volcanoParse(buf, cb) {
  try {
    const msgTypeFlags = buf[1];
    const msgType = msgTypeFlags >> 4;
    const compression = buf[2] & 0x0f;
    // full-server-response (0x9) / error (0xf); payload after header(4)+seq?(4)+size(4)
    let off = 4;
    // server responses carry a 4-byte sequence before the size in v3
    const seq = buf.readInt32BE(off); off += 4;
    const size = buf.readUInt32BE(off); off += 4;
    let payload = buf.subarray(off, off + size);
    if (compression === 0x1) payload = zlib.gunzipSync(payload);
    const json = JSON.parse(payload.toString('utf8'));
    if (msgType === 0xf) { cb.onError(json.error || 'volcano asr error'); return; }
    const result = json.result || {};
    const text = result.text || '';
    if (!text) return;
    // definite=true / seq<0 marks an utterance end → final
    if (result.definite || seq < 0) cb.onFinal(text);
    else cb.onPartial(text);
  } catch (e) { /* ignore malformed frames */ }
}
function volcanoSession(opts, cb) {
  const c = cfg.volcano;
  if (!c.appId || !c.accessToken) { cb.onError('火山 AppID/AccessToken 未配置'); return null; }
  const reqId = `mc_${Date.now().toString(36)}`;
  const upstream = new WebSocket(c.url, {
    headers: {
      'X-Api-App-Key': c.appId,
      'X-Api-Access-Key': c.accessToken,
      'X-Api-Resource-Id': c.resourceId,
      'X-Api-Connect-Id': reqId,
    },
  });
  let open = false, finished = false, seq = 1;

  upstream.on('open', () => {
    open = true;
    const config = {
      user: { uid: 'multicc' },
      audio: { format: 'pcm', rate: c.sampleRate, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_itn: true, enable_punc: true,
        result_type: 'single',
        ...(opts.lang && opts.lang !== 'auto' ? { language: opts.lang } : {}),
      },
    };
    // full client request: msgType=0x1, flags=0x1 (has seq)
    const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(seq++, 0);
    const frame = volcanoBuildFrame(0x1, 0x1, Buffer.from(JSON.stringify(config)));
    upstream.send(Buffer.concat([frame.subarray(0, 4), seqBuf, frame.subarray(4)]));
    cb.onReady();
  });
  upstream.on('message', (raw) => volcanoParse(Buffer.from(raw), cb));
  upstream.on('error', (e) => cb.onError(e.message));
  upstream.on('close', () => { if (!finished) cb.onDone(); });

  const sendAudio = (int16, last) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    const pcm = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
    const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(last ? -seq : seq, 0); seq++;
    // audio-only request: msgType=0x2, flags=0x1 (has seq); last frame flags=0x3
    const header = Buffer.from([0x11, (0x2 << 4) | (last ? 0x3 : 0x1), (0x0 << 4) | 0x1, 0x00]);
    const gz = zlib.gzipSync(pcm);
    const size = Buffer.alloc(4); size.writeUInt32BE(gz.length, 0);
    upstream.send(Buffer.concat([header, seqBuf, size, gz]));
  };

  return {
    pushAudio(int16) { if (open) sendAudio(int16, false); },
    finish() {
      finished = true;
      if (open) sendAudio(new Int16Array(0), true);
      setTimeout(() => { try { upstream.close(); } catch (_) {} cb.onDone(); }, 1500);
    },
    close() { finished = true; try { upstream.close(); } catch (_) {} },
  };
}

function createAsrSession(provider, opts, cb) {
  switch (provider) {
    case 'volcano': return volcanoSession(opts, cb);
    case 'funasr':  return funasrSession(opts, cb);
    case 'openai':
    default:        return openaiSession(opts, cb);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket handler: bridges one browser connection to one ASR upstream session.
// ─────────────────────────────────────────────────────────────────────────────
function handleVoiceWs(ws, req, urlObj) {
  let upstream = null;
  let provider = '';
  let aggregate = '';   // accumulated finalized text
  let partial = '';     // current (not-yet-final) hypothesis

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (_) {} };

  const cb = {
    onReady:   () => send({ type: 'ready', provider, sampleRate: targetSampleRate(provider) }),
    onPartial: (t) => { partial = t; send({ type: 'partial', text: aggregate + partial }); },
    onFinal:   (t) => { aggregate += t; partial = ''; send({ type: 'final', text: aggregate }); },
    onDone:    () => { send({ type: 'done', text: aggregate }); },
    onError:   (m) => { send({ type: 'error', message: m }); },
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Raw PCM16LE mono audio chunk from the browser.
      if (upstream) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        upstream.pushAudio(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2)));
      }
      return;
    }
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'start') {
      const requested = (msg.provider && msg.provider !== 'auto') ? msg.provider : cfg.defaultProvider;
      provider = requested;
      try {
        upstream = createAsrSession(provider, { lang: msg.lang }, cb);
      } catch (e) { cb.onError(e.message); }
      if (!upstream) { /* createAsrSession already reported the error */ }
    } else if (msg.type === 'stop') {
      if (upstream) upstream.finish();
    }
  });

  ws.on('close', () => { if (upstream) upstream.close(); upstream = null; });
  ws.on('error', () => { if (upstream) upstream.close(); upstream = null; });
}

module.exports = { handleVoiceWs, applyConfig, providerStatus, targetSampleRate, cfg };
