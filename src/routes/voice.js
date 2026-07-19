'use strict';

const CONFIG_SNAPSHOT_UNAVAILABLE = Symbol('voice-config-snapshot-unavailable');

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`voice routes require ${name}`);
  return value;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = cloneValue(nested);
    return copy;
  }
  return value;
}

function replaceMutable(target, snapshot) {
  if (!target || typeof target !== 'object') throw new TypeError('runtime config is not mutable');
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    const current = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      replaceMutable(current, value);
    } else {
      target[key] = cloneValue(value);
    }
  }
}

function snapshotService(service) {
  if (typeof service.snapshotConfig === 'function') return service.snapshotConfig();
  if (!service.cfg) return CONFIG_SNAPSHOT_UNAVAILABLE;
  return cloneValue(service.cfg);
}

function restoreService(service, snapshot) {
  if (snapshot === CONFIG_SNAPSHOT_UNAVAILABLE) {
    throw new TypeError('runtime service does not expose a config restore port');
  }
  if (typeof service.restoreConfig === 'function') return service.restoreConfig(snapshot);
  return replaceMutable(service.cfg, snapshot);
}

function snapshotRuntimeEnv(runtimeEnv, keys) {
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = Object.prototype.hasOwnProperty.call(runtimeEnv, key)
      ? { present: true, value: runtimeEnv[key] }
      : { present: false, value: undefined };
  }
  return snapshot;
}

function restoreRuntimeEnv(runtimeEnv, snapshot) {
  for (const [key, entry] of Object.entries(snapshot)) {
    if (entry.present) runtimeEnv[key] = entry.value;
    else delete runtimeEnv[key];
  }
}

function buildEnvRestore(oldEnv, keys) {
  const restore = {};
  for (const key of keys) {
    restore[key] = Object.prototype.hasOwnProperty.call(oldEnv, key) ? oldEnv[key] : null;
  }
  return restore;
}

function mountVoiceRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('voice routes require an Express-compatible app');
  }

  const {
    uploadVoice,
    voice,
    asrLocal,
    voiceAsr,
    ttsService,
    readEnvFile,
    writeEnvFile,
    getAuxQueue,
    runtimeEnv = process.env,
    fetchImpl = globalThis.fetch,
    FormDataCtor = globalThis.FormData,
    BlobCtor = globalThis.Blob,
    log = console,
    reportFailure = () => {},
    applyRuntimeEnv = (env, updates) => {
      for (const [key, value] of Object.entries(updates)) env[key] = value;
    },
    rollbackRuntimeEnv = restoreRuntimeEnv,
  } = deps;

  requireFunction(uploadVoice, 'uploadVoice middleware');
  requireFunction(readEnvFile, 'readEnvFile');
  requireFunction(writeEnvFile, 'writeEnvFile');
  requireFunction(getAuxQueue, 'getAuxQueue');
  if (!voice || !voice.cfg) throw new TypeError('voice routes require voice service');
  if (!asrLocal || typeof asrLocal.isAvailable !== 'function') throw new TypeError('voice routes require local ASR service');
  if (!voiceAsr || typeof voiceAsr.providerStatus !== 'function') throw new TypeError('voice routes require streaming ASR service');
  if (!ttsService || typeof ttsService.providerStatus !== 'function') throw new TypeError('voice routes require TTS service');

  const {
    loadVoiceExamples,
    appendVoiceExample,
    loadWhisperVocab,
    saveWhisperVocab,
    extractCorrections,
    mergeWhisperVocab,
    buildWhisperPrompt,
  } = voice;

  const consistency = {
    degraded: false,
    dirty: false,
    reason: null,
    lastFailureAt: null,
  };

  function safeReport(stage, category) {
    try { reportFailure(stage, category); } catch (_) {}
  }

  function markConsistency(rollbackFailures) {
    if (rollbackFailures.length === 0) {
      consistency.degraded = false;
      consistency.dirty = false;
      consistency.reason = null;
      consistency.lastFailureAt = null;
      return;
    }
    consistency.degraded = true;
    consistency.dirty = true;
    consistency.reason = rollbackFailures[0];
    consistency.lastFailureAt = Date.now();
  }

  app.post('/api/voice/refine', async (req, res) => {
    const reqId = `vr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const raw = (req.body.raw || '').trim();
    log.log(`[multicc/voice][${reqId}] POST /api/voice/refine received, raw length: ${raw.length}, raw: ${JSON.stringify(raw.slice(0, 100))}`);

    if (!raw) return res.json({ ok: true, text: '', ms: 0 });

    const examples = loadVoiceExamples();
    let examplesStr = '';
    if (examples.length > 0) {
      examplesStr = '\n\n历史优化案例（供参考）：\n' + examples.map((ex, i) =>
        `[案例${i + 1}] 原始：${ex.raw}\n优化后：${ex.userFinal}`
      ).join('\n');
    }

    const prompt = `你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。
任务：
1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）
2. 将口语转为专业简洁的程序员描述
3. 整理成清晰可操作的需求
4. 忠实原意，不臆造功能${examplesStr}

原始语音：${raw}
直接输出优化后的文本，不要任何解释或前缀。`;

    log.log(`[multicc/voice][${reqId}] Routing to AuxQueue (prompt ${prompt.length} chars)`);
    const t0 = Date.now();
    try {
      const result = await getAuxQueue().enqueue({ type: 'voice_refine', prompt, meta: { reqId } });
      const ms = Date.now() - t0;
      log.log(`[multicc/voice][${reqId}] AuxQueue done in ${ms}ms, text length: ${(result.text || '').length}`);
      res.json({ ok: true, text: result.text || '', ms });
    } catch (err) {
      const ms = Date.now() - t0;
      const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
      log.error(`[multicc/voice][${reqId}] AuxQueue error after ${ms}ms:`, errMsg);
      res.json({ ok: false, text: `[错误: ${errMsg}]`, ms });
    }
  });

  app.post('/api/voice/feedback', (req, res) => {
    const { raw, refined, userFinal } = req.body;
    if (raw && refined !== undefined && userFinal !== undefined && userFinal !== refined) {
      appendVoiceExample({ raw, refined, userFinal, ts: new Date().toISOString() });
      const corrections = extractCorrections(raw, userFinal);
      if (corrections.length > 0) mergeWhisperVocab(corrections);
    }
    res.json({ ok: true });
  });

  app.post('/api/voice/confirm', async (req, res) => {
    const reqId = `s2s_c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const { text, previousBreakdown, userFeedback } = req.body;
    const raw = (text || '').trim();
    log.log(`[multicc/s2s][${reqId}] POST /api/voice/confirm, raw: ${JSON.stringify(raw.slice(0, 120))}`);

    if (!raw && !userFeedback) return res.status(400).json({ error: '缺少 text 或 userFeedback' });

    const ctxParts = [];
    if (previousBreakdown) ctxParts.push(`之前你给出的理解（JSON）：\n${JSON.stringify(previousBreakdown, null, 2)}`);
    if (userFeedback) ctxParts.push(`用户对此的语音反馈：${userFeedback}`);
    const ctx = ctxParts.length ? '\n\n' + ctxParts.join('\n\n') : '';

    const prompt = `你是语音交互的需求确认助手。用户通过连续语音描述了一个编程/技术任务。你的职责是把用户的口语描述整理成清晰、可逐项确认的需求条目，以便在执行前与用户对齐。

${ctx ? ctx + '\n\n' : ''}用户本次的语音输入：${raw || '（无新增，仅根据反馈调整）'}

请输出严格的 JSON（只输出 JSON，不要 markdown 代码块，不要任何解释）：
{
  "summary": "一句话总结你理解的整体需求（用'我理解你要做的是：...'的口吻）",
  "items": ["需求条目1", "需求条目2", "..."],
  "questions": ["如果有需要进一步确认的疑问写在这里，没有则空数组"],
  "allConfirmed": false
}

规则：
- allConfirmed 只有在用户的反馈明确表示"全部正确/确认/没问题/对了/可以了"等时才设为 true，其余情况一律 false
- items 每条用简洁的短句，适合语音逐条念出
- 如果是首次确认（没有 previousBreakdown），根据原始语音拆解；如果有 previousBreakdown + userFeedback，根据反馈更新条目
- questions 只在有真正需要澄清的疑问时才填，通常为空数组`;

    const t0 = Date.now();
    try {
      const result = await getAuxQueue().enqueue({ type: 'voice_confirm', prompt, meta: { reqId } });
      const ms = Date.now() - t0;
      let parsed;
      const rawText = result.text || '';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
      }
      if (!parsed) parsed = { summary: rawText.trim(), items: [], questions: [], allConfirmed: false };
      log.log(`[multicc/s2s][${reqId}] Confirm done in ${ms}ms, items: ${parsed.items?.length || 0}, allConfirmed: ${parsed.allConfirmed}`);
      res.json({ ok: true, ...parsed, ms });
    } catch (err) {
      const ms = Date.now() - t0;
      const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
      log.error(`[multicc/s2s][${reqId}] Confirm error after ${ms}ms:`, errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  app.post('/api/voice/progress-summary', async (req, res) => {
    const reqId = `s2s_p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const { events, taskDescription } = req.body;
    log.log(`[multicc/s2s][${reqId}] POST /api/voice/progress-summary, events: ${Array.isArray(events) ? events.length : 0}`);
    if (!Array.isArray(events) || events.length === 0) return res.json({ ok: true, summary: '' });

    const eventsStr = events.map((e, i) =>
      `${i + 1}. [${e.type || '?'}] ${(e.summary || e.text || JSON.stringify(e)).slice(0, 300)}`
    ).join('\n');
    const prompt = `你是语音交互的进展汇报助手。用户通过语音发起了一个任务，正在等待结果。请根据最近的任务进展事件，用口语化的中文给用户做一个简洁的进展汇报，适合语音播报。

任务描述：${taskDescription || '编程任务'}

最近的进展事件：
${eventsStr}

要求：
- 用 1-3 句话总结当前进展，口语化，自然
- 直接说内容，不要加"汇报："等前缀
- 如果看到错误或卡住，也如实说明
- 如果进展正常，简单说明已完成了什么、还在做什么
- 不超过 100 字`;

    const t0 = Date.now();
    try {
      const result = await getAuxQueue().enqueue({ type: 'progress_summary', prompt, meta: { reqId } });
      const ms = Date.now() - t0;
      const summary = (result.text || '').trim();
      log.log(`[multicc/s2s][${reqId}] Progress summary done in ${ms}ms, len: ${summary.length}`);
      res.json({ ok: true, summary, ms });
    } catch (err) {
      const ms = Date.now() - t0;
      const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
      log.error(`[multicc/s2s][${reqId}] Progress summary error after ${ms}ms:`, errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  app.get('/api/voice/vocab', (req, res) => res.json(loadWhisperVocab()));

  app.delete('/api/voice/vocab/:term', (req, res) => {
    const target = req.params.term.toLowerCase();
    const vocab = loadWhisperVocab().filter(v => v.term.toLowerCase() !== target);
    saveWhisperVocab(vocab);
    res.json({ ok: true, remaining: vocab.length });
  });

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
    if (!apiKey) return res.status(500).json({ error: '本地 ASR 未就绪，且 WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置' });

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

  app.get('/api/settings/voice', (req, res) => {
    const env = readEnvFile();
    const key = env.OPENROUTER_API_KEY || runtimeEnv.OPENROUTER_API_KEY || '';
    const wsKey = env.WHISPER_API_KEY || runtimeEnv.WHISPER_API_KEY || '';
    res.json({
      baseUrl: env.OPENROUTER_BASE_URL || runtimeEnv.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: key ? key.slice(0, 8) + '****' + key.slice(-4) : '',
      model: env.OPENROUTER_MODEL || runtimeEnv.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
      hasKey: !!key,
      whisperBaseUrl: env.WHISPER_BASE_URL || runtimeEnv.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1',
      whisperApiKey: wsKey ? wsKey.slice(0, 8) + '****' + wsKey.slice(-4) : '',
      whisperModel: env.WHISPER_MODEL || runtimeEnv.WHISPER_MODEL || 'whisper-large-v3-turbo',
      hasWhisperKey: !!wsKey,
      whisperLanguage: env.WHISPER_LANGUAGE || runtimeEnv.WHISPER_LANGUAGE || 'zh',
      whisperPrompt: env.WHISPER_PROMPT || runtimeEnv.WHISPER_PROMPT || '',
      asr: {
        provider: env.ASR_PROVIDER || runtimeEnv.ASR_PROVIDER || 'auto',
        status: voiceAsr.providerStatus(),
        openaiUrl: env.OPENAI_REALTIME_URL || runtimeEnv.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
        openaiModel: env.OPENAI_REALTIME_MODEL || runtimeEnv.OPENAI_REALTIME_MODEL || 'gpt-4o-transcribe',
        hasOpenaiKey: !!(env.OPENAI_REALTIME_API_KEY || runtimeEnv.OPENAI_REALTIME_API_KEY),
        volcUrl: env.VOLC_ASR_URL || runtimeEnv.VOLC_ASR_URL || '',
        volcResourceId: env.VOLC_ASR_RESOURCE_ID || runtimeEnv.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
        hasVolcAppId: !!(env.VOLC_ASR_APP_ID || runtimeEnv.VOLC_ASR_APP_ID),
        hasVolcToken: !!(env.VOLC_ASR_ACCESS_TOKEN || runtimeEnv.VOLC_ASR_ACCESS_TOKEN),
        funasrUrl: env.FUNASR_WS_URL || runtimeEnv.FUNASR_WS_URL || '',
        funasrMode: env.FUNASR_MODE || runtimeEnv.FUNASR_MODE || '2pass',
      },
      tts: {
        provider: env.TTS_PROVIDER || runtimeEnv.TTS_PROVIDER || 'edge',
        status: ttsService.providerStatus(),
        edgeVoice: env.EDGE_TTS_VOICE || runtimeEnv.EDGE_TTS_VOICE || 'zh-CN-XiaoxiaoNeural',
        openaiVoice: env.OPENAI_TTS_VOICE || runtimeEnv.OPENAI_TTS_VOICE || 'alloy',
        hasOpenaiKey: !!(env.OPENAI_TTS_API_KEY || runtimeEnv.OPENAI_TTS_API_KEY || runtimeEnv.OPENAI_API_KEY),
        volcanoVoice: env.VOLC_TTS_VOICE || runtimeEnv.VOLC_TTS_VOICE || 'zh_female_shuangkuaisisi_moon_bigtts',
        hasVolcanoAppId: !!(env.VOLC_TTS_APP_ID || runtimeEnv.VOLC_TTS_APP_ID),
        hasVolcanoToken: !!(env.VOLC_TTS_ACCESS_TOKEN || runtimeEnv.VOLC_TTS_ACCESS_TOKEN),
      },
    });
  });

  app.post('/api/settings/voice', (req, res) => {
    const { baseUrl, apiKey, model, whisperBaseUrl, whisperApiKey, whisperModel, whisperLanguage, whisperPrompt } = req.body;
    const updates = {};
    if (baseUrl !== undefined) updates.OPENROUTER_BASE_URL = baseUrl;
    if (apiKey !== undefined && !apiKey.includes('****')) updates.OPENROUTER_API_KEY = apiKey;
    if (model !== undefined) updates.OPENROUTER_MODEL = model;
    if (whisperBaseUrl !== undefined) updates.WHISPER_BASE_URL = whisperBaseUrl;
    if (whisperApiKey !== undefined && !whisperApiKey.includes('****')) updates.WHISPER_API_KEY = whisperApiKey;
    if (whisperModel !== undefined) updates.WHISPER_MODEL = whisperModel;
    if (whisperLanguage !== undefined) updates.WHISPER_LANGUAGE = whisperLanguage;
    if (whisperPrompt !== undefined) updates.WHISPER_PROMPT = whisperPrompt;

    const asr = req.body.asr || {};
    const setAsr = (keyName, value) => {
      if (value !== undefined && !(typeof value === 'string' && value.includes('****'))) updates[keyName] = value;
    };
    setAsr('ASR_PROVIDER', asr.provider);
    setAsr('OPENAI_REALTIME_API_KEY', asr.openaiApiKey);
    setAsr('OPENAI_REALTIME_URL', asr.openaiUrl);
    setAsr('OPENAI_REALTIME_MODEL', asr.openaiModel);
    setAsr('VOLC_ASR_APP_ID', asr.volcAppId);
    setAsr('VOLC_ASR_ACCESS_TOKEN', asr.volcAccessToken);
    setAsr('VOLC_ASR_RESOURCE_ID', asr.volcResourceId);
    setAsr('VOLC_ASR_URL', asr.volcUrl);
    setAsr('FUNASR_WS_URL', asr.funasrUrl);
    setAsr('FUNASR_MODE', asr.funasrMode);

    const tts = req.body.tts || {};
    const setTts = (keyName, value) => {
      if (value !== undefined && !(typeof value === 'string' && value.includes('****'))) updates[keyName] = value;
    };
    setTts('TTS_PROVIDER', tts.provider);
    setTts('EDGE_TTS_VOICE', tts.edgeVoice);
    setTts('OPENAI_TTS_API_KEY', tts.openaiApiKey);
    setTts('OPENAI_TTS_URL', tts.openaiUrl);
    setTts('OPENAI_TTS_MODEL', tts.openaiModel);
    setTts('OPENAI_TTS_VOICE', tts.openaiVoice);
    setTts('VOLC_TTS_APP_ID', tts.volcanoAppId);
    setTts('VOLC_TTS_ACCESS_TOKEN', tts.volcanoToken);
    setTts('VOLC_TTS_URL', tts.volcanoUrl);
    setTts('VOLC_TTS_VOICE', tts.volcanoVoice);

    const keys = Object.keys(updates);
    const oldEnv = readEnvFile();
    const envRestore = buildEnvRestore(oldEnv, keys);
    const runtimeSnapshot = snapshotRuntimeEnv(runtimeEnv, keys);
    const asrSnapshot = snapshotService(voiceAsr);
    const ttsSnapshot = snapshotService(ttsService);
    const voiceSnapshot = snapshotService(voice);
    const attempted = { persist: false, asr: false, tts: false, runtime: false, voice: false };
    let stage = 'persist';

    try {
      attempted.persist = true;
      writeEnvFile(updates);
      stage = 'voice_asr_apply';
      attempted.asr = true;
      voiceAsr.applyConfig(updates);
      stage = 'tts_apply';
      attempted.tts = true;
      ttsService.applyConfig(updates);
      stage = 'runtime_env_apply';
      attempted.runtime = true;
      applyRuntimeEnv(runtimeEnv, updates);
      stage = 'voice_apply';
      attempted.voice = true;
      voice.applyEnvUpdates(updates);
      markConsistency([]);
    } catch (error) {
      safeReport(stage, 'apply_failed');
      const rollbackFailures = [];
      const compensate = (rollbackStage, action) => {
        try { action(); } catch (_) {
          rollbackFailures.push(rollbackStage);
          safeReport(rollbackStage, 'compensation_failed');
        }
      };

      // Restore every attempted boundary. The attempted bit is set before each
      // call because an apply function can mutate partially and then throw.
      if (attempted.voice) compensate('voice_restore', () => restoreService(voice, voiceSnapshot));
      if (attempted.runtime) compensate('runtime_env_restore', () => rollbackRuntimeEnv(runtimeEnv, runtimeSnapshot));
      if (attempted.tts) compensate('tts_restore', () => restoreService(ttsService, ttsSnapshot));
      if (attempted.asr) compensate('voice_asr_restore', () => restoreService(voiceAsr, asrSnapshot));
      if (attempted.persist) compensate('env_restore', () => writeEnvFile(envRestore));
      markConsistency(rollbackFailures);
      throw error;
    }

    log.log(`[multicc/voice] Settings updated: model=${voice.cfg.OPENROUTER_MODEL}, baseUrl=${voice.cfg.OPENROUTER_BASE_URL}, key=${voice.cfg.OPENROUTER_API_KEY ? 'set' : 'empty'}`);
    log.log(`[multicc/stt] Settings updated: model=${voice.cfg.WHISPER_MODEL}, baseUrl=${voice.cfg.WHISPER_BASE_URL}, key=${voice.cfg.WHISPER_API_KEY ? 'set' : 'empty'}`);
    res.json({ ok: true });
  });

  app.get('/api/voice/test-sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    let index = 0;
    const interval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ text: `SSE test chunk ${++index}` })}\n\n`);
      if (index >= 3) {
        clearInterval(interval);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 500);
    req.on('close', () => clearInterval(interval));
  });

  return {
    getConsistency() { return { ...consistency }; },
  };
}

module.exports = { mountVoiceRoutes };
