'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { differential, response, tick } = require('./helpers/b18-voice-world');

for (const name of ['voice-asr', 'tts-service', 'asr-local']) {
  test(`${name}: exact frozen config coercion, nested identity and synchronous update`, async () => {
    await differential(name, (api) => {
      const cfg = api.cfg;
      const child = cfg.openai;
      const updates = {
        ASR_PROVIDER: 'funasr', OPENAI_REALTIME_API_KEY: '', OPENAI_REALTIME_URL: '', OPENAI_REALTIME_SAMPLE_RATE: 'not a number',
        VOLC_ASR_APP_ID: '', VOLC_ASR_ACCESS_TOKEN: '', FUNASR_WS_URL: '', FUNASR_MODE: 'online',
        TTS_PROVIDER: 'openai', EDGE_TTS_VOICE: 'en-US-AriaNeural', OPENAI_TTS_API_KEY: '', OPENAI_TTS_MODEL: 'new',
        VOLC_TTS_VOICE: 'unused', ASR_LOCAL_THREADS: '7', ASR_LOCAL_LANGUAGE: 'en', ASR_LOCAL_MODEL_DIR: '/new-models',
      };
      const returned = name === 'asr-local' ? api.applyEnvUpdates(updates) : api.applyConfig(updates);
      assert.equal(api.cfg, cfg); if (child) assert.equal(api.cfg.openai, child);
      assert.equal(returned, undefined);
      return cfg;
    }, { noModels: true });
  });
}
for (const provider of ['openai', 'funasr', 'volcano', 'unknown-provider']) {
  test(`ASR ${provider}: frozen handshake, PCM framing, aggregation, stop and timer`, async () => {
    await differential('voice-asr', (api, w) => {
      api.applyConfig({ OPENAI_REALTIME_API_KEY: 'test', VOLC_ASR_APP_ID: 'app', VOLC_ASR_ACCESS_TOKEN: 'token', FUNASR_WS_URL: 'wss://funasr.test' });
      const ws = w.peer(); api.handleVoiceWs(ws, {}, new URL('http://x/ws/voice'));
      const json = value => ws.emit('message', Buffer.from(JSON.stringify(value)), false);
      json({ type: 'start', provider, lang: 'zh', sampleRate: 44100 });
      ws.emit('message', Buffer.from([0, 0]), true); // dropped before ready
      const upstream = w.sockets[0]; upstream.emit('open');
      const pooled = Buffer.from([9, 0, 128, 255, 127, 7]);
      ws.emit('message', pooled.subarray(1, 4), true); // odd offset and split sample
      ws.emit('message', Buffer.from([127]), true);
      if (provider === 'volcano') { upstream.emit('message', Buffer.from('bad')); upstream.emit('message', response('hello', 1)); upstream.emit('message', response('final')); }
      else if (provider === 'funasr') {
        upstream.emit('message', Buffer.from(JSON.stringify({ text: 'hello', mode: '2pass-online' })));
        upstream.emit('message', Buffer.from(JSON.stringify({ text: 'final', mode: '2pass-offline' })));
      } else {
        for (const delta of ['a', 'b']) upstream.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta })));
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'final' })));
      }
      json({ type: 'stop' }); w.fireTimers(provider === 'openai' || provider === 'unknown-provider' ? 1200 : 1500);
      ws.emit('close'); return ws.messages;
    });
  });
}
test('ASR: auto readiness and errors remain nonterminal, repeated start retains old callbacks', async () => {
  await differential('voice-asr', (api, w) => {
    const ws = w.peer(); api.handleVoiceWs(ws);
    const start = provider => ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider })), false);
    start('auto'); assert.equal(ws.messages[0].code, 'voice_not_ready');
    api.applyConfig({ OPENAI_REALTIME_API_KEY: 'test' });
    start('openai'); const first = w.sockets[0]; first.emit('open');
    first.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'A' })));
    start('openai'); w.sockets[1].emit('open');
    first.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'B' })));
    ws.emit('error', Error('client gone')); return { messages: ws.messages, status: api.providerStatus() };
  });
});
test('ASR: audio exception closes the current local handle and discards tail', async () => {
  await differential('voice-asr', (api, w) => {
    const ws = w.peer(); api.handleVoiceWs(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider: 'local' })), false);
    w.flushMicrotasks(); ws.emit('message', Buffer.from([0, 0, 8]), true); ws.emit('close');
    return ws.messages;
  }, { audioError: true });
});
for (const options of [{ noModels: true }, { noAddon: true }, { noVad: true }, {}]) {
  test(`local ASR: readiness, sticky SDK/model state and VAD failure ${JSON.stringify(options)}`, async () => {
    await differential('asr-local', async (api, w) => {
      const status = api.status(), files = api.modelFilesExist(), addon = api.addonAvailable();
      if (!status.ready) { await api.warmup(); return { status, files, addon }; }
      const events = [];
      const session = api.createStreamingSession({ lang: 'ja' }, {
        onReady: () => events.push('ready'), onFinal: text => events.push(['final', text]),
        onDone: () => events.push('done'), onError: error => events.push(['error', error]),
      });
      w.flushMicrotasks();
      if (session) { session.pushAudio(new Int16Array(5000)); session.finish(); session.finish(); session.close(); }
      api.applyEnvUpdates({ ASR_LOCAL_MODEL_DIR: '/changed', ASR_LOCAL_LANGUAGE: 'en', ASR_LOCAL_THREADS: '4' });
      await api.warmup(); return { status, files, addon, events, after: api.status() };
    }, options);
  });
}
test('local ASR: VAD padding and sub-window tail use frozen ordering', async () => {
  await differential('asr-local', (api, w) => {
    const events = []; const session = api.createStreamingSession({}, {
      onReady: () => events.push('ready'), onFinal: value => events.push(value), onDone: () => events.push('done'), onError: value => events.push(value),
    });
    session.pushAudio(new Int16Array(511)); w.flushMicrotasks(); session.pushAudio(new Int16Array(514));
    session.finish(); return events;
  }, { vadSegment: true });
});
function wav(channels = 1) {
  const data = Buffer.alloc(channels * 8); for (let i = 0; i < data.length; i += 2) data.writeInt16LE(i % 4 ? 32767 : -32768, i);
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(22050 * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}
for (const channels of [1, 2]) test(`local ASR: PCM16 WAV ${channels} channel fast path and timed vocab cache`, async () => {
  await differential('asr-local', async (api, w) => {
    const promise = api.transcribeBuffer(wav(channels), 'ignored/type'); assert.equal(typeof promise.then, 'function');
    const output = await promise;
    api.applyVocabCorrections('MULTI CC and work tree'); w.advance(10000); api.applyVocabCorrections('multicc');
    w.advance(30001); const correction = api.applyVocabCorrections('before_work tree_after');
    const sync = api.transcribeFloat32(new Float32Array([0, 1]), 16000); assert.equal(typeof sync.then, 'undefined');
    return { output, correction, sync };
  });
});
for (const outcome of ['ok', 'empty', 'error', 'exit', 'timeout']) test(`local ASR: ffmpeg ${outcome} retains Promise/error contract`, async () => {
  await differential('asr-local', async (api, w) => {
    const promise = api.transcribeBuffer(Buffer.from('not a wav'), 'audio/webm');
    const observed = promise.then(value => ({ value }), error => ({ error: error.message }));
    const proc = w.children[0];
    if (outcome === 'error') proc.emit('error', Error('missing binary'));
    else if (outcome === 'timeout') w.fireTimers(15000);
    else {
      if (outcome === 'ok') proc.stdout.emit('data', Buffer.from(new Float32Array([0, .5, -.5]).buffer));
      proc.stderr.emit('data', Buffer.from('decode problem')); proc.emit('close', outcome === 'exit' ? 2 : 0);
    }
    return observed;
  });
});
for (const outcome of ['ok', 'exit', 'spawn-error', 'stop', 'close']) test(`TTS Edge: ${outcome}, buffering and voice argv match frozen bytes`, async () => {
  await differential('tts-service', async (api, w) => {
    api.applyConfig({ EDGE_TTS_VOICE: 'en-US-AriaNeural' });
    const ws = w.peer(); api.handleTtsWs(ws);
    ws.emit('message', JSON.stringify({ type: 'start', text: 'hello', provider: 'edge' }), false); await tick();
    const child = w.children[0]; child.stdout.emit('data', Buffer.from('mp3'));
    assert.equal(ws.messages.length, 0, 'Edge buffers until exit');
    if (outcome === 'stop') ws.emit('message', JSON.stringify({ type: 'stop' }), false);
    else if (outcome === 'close') ws.emit('close');
    if (outcome === 'spawn-error') child.emit('error', Error('ENOENT'));
    child.emit('close', outcome === 'exit' ? 2 : 0); return ws.messages;
  });
});
for (const provider of ['edge', 'volcano', 'openai', 'unknown']) test(`TTS ${provider}: empty text error count and binary input`, async () => {
  await differential('tts-service', async (api, w) => {
    const ws = w.peer(); api.handleTtsWs(ws); ws.emit('message', Buffer.from('bad binary'), true);
    ws.emit('message', 'not json', false); ws.emit('message', JSON.stringify({ type: 'start', text: '', provider }), false);
    await tick(); return ws.messages;
  });
});
test('TTS status: edge is added asynchronously and uses which rather than EDGE_TTS_CMD', async () => {
  await differential('tts-service', (api, w) => {
    const status = api.providerStatus(); const before = JSON.stringify(status); w.children[0].emit('close', 0);
    return { before, after: status };
  }, { env: { EDGE_TTS_CMD: '/custom/edge' } });
});
for (const status of [200, 403]) test(`OpenAI TTS: ${status}, full buffering and Promise cancellation gap`, async () => {
  await differential('tts-service', async (api, w) => {
    api.applyConfig({ OPENAI_TTS_API_KEY: 'test', OPENAI_TTS_URL: 'https://speech.test:8443/v1/audio/speech?ignored=1' });
    const ws = w.peer(); api.handleTtsWs(ws); ws.emit('message', JSON.stringify({ type: 'start', text: 'hello', provider: 'openai' }), false);
    ws.emit('message', JSON.stringify({ type: 'stop' }), false); // the legacy Promise is not cancellable
    const res = new EventEmitter(); res.statusCode = status; w.requests[0].callback(res);
    res.emit('data', Buffer.from('audio')); assert.equal(ws.messages.length, 0); res.emit('end'); await tick(); return ws.messages;
  });
});
for (const outcome of ['close', 'error', 'stop']) test(`Volcano TTS: ${outcome} binary and terminal events`, async () => {
  await differential('tts-service', (api, w) => {
    const ws = w.peer(); api.handleTtsWs(ws); ws.emit('message', JSON.stringify({ type: 'start', text: 'hello', provider: 'volcano' }), false);
    const upstream = w.sockets[0]; upstream.emit('open'); upstream.emit('message', Buffer.from('{}'), false); upstream.emit('message', Buffer.from([1, 2]), true);
    if (outcome === 'stop') ws.emit('message', JSON.stringify({ type: 'stop' }), false);
    else if (outcome === 'error') upstream.emit('error', Error('connection failed'));
    upstream.emit('close'); return ws.messages;
  });
});
