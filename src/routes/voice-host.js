'use strict';

// 宿主端口（host port）：`/api/voice/*` 与 `/api/settings/voice*` 的 13 条路由
// 已经由 Rust 前门（multicc-gateway）独占。HTTP 方法、路径、状态码、错误码映射、
// 设置校验（包括 Qwen Audio 的 wss/回环规则与 `****` 掩码）都在 Rust 一侧；
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   examples       历史优化案例（refine 提示词由 Rust 组装）
//   auxEnqueue     AuxQueue 入队与结果文本（refine / confirm / progress-summary）
//   feedbackApply  写学习案例、合并词表、教热词学习器
//   vocabGet / vocabDelete   Whisper 词表读写
//   hotwords / hotwordsReject 热词快照与否决
//   readinessFacts / settingsFacts  录音前与设置面板需要的运行时事实
//   settingsApply  已通过校验的环境变量事务（持久化 + 热应用 + 补偿回滚）
//   asrModelCancel / asrModelStart  本地 ASR 权重的传输控制
//
// 这张表与 Rust 侧的 op 契约逐字段对齐：成功统一回 200 `{ok:true,...}`，
// 抛异常统一回 200 `{ok:false,error:{message[,statusCode]}}`（Express 旧路由的
// throw 由前门负责渲染成状态码）。`auxEnqueue` 是唯一例外：它的失败形状沿用
// 旧 `/api/voice/refine` 的 `{ok:false,cancelled,message}`。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/voice';

const CONFIG_SNAPSHOT_UNAVAILABLE = Symbol('voice-config-snapshot-unavailable');

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`[voice-host] ${name} is required`);
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

function mountVoiceHostRoute(app, deps = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[voice-host] Express-compatible app is required');
  }

  const {
    voice,
    asrLocal,
    asrModelInstaller = null,
    voiceAsr,
    ttsService,
    readEnvFile,
    writeEnvFile,
    getAuxQueue,
    runtimeEnv = process.env,
    log = console,
    reportFailure = () => {},
    getQwenAudioRuntimeStatus = () => null,
    onQwenAudioConfigChanged = () => {},
    applyRuntimeEnv = (env, updates) => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
    },
    rollbackRuntimeEnv = restoreRuntimeEnv,
    // 测试注入；生产解析与其余路由同一个实现。
    isLocal = isLocalRequest,
  } = deps;

  requireFunction(readEnvFile, 'readEnvFile');
  requireFunction(writeEnvFile, 'writeEnvFile');
  requireFunction(getAuxQueue, 'getAuxQueue');
  if (!voice || !voice.cfg) throw new TypeError('[voice-host] voice service is required');
  if (!asrLocal || typeof asrLocal.isAvailable !== 'function') {
    throw new TypeError('[voice-host] local ASR service is required');
  }
  if (!voiceAsr || typeof voiceAsr.providerStatus !== 'function') {
    throw new TypeError('[voice-host] streaming ASR service is required');
  }
  if (!ttsService || typeof ttsService.providerStatus !== 'function') {
    throw new TypeError('[voice-host] TTS service is required');
  }

  const {
    loadVoiceExamples,
    appendVoiceExample,
    loadWhisperVocab,
    saveWhisperVocab,
    extractCorrections,
    mergeWhisperVocab,
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

  function installerStatus() {
    if (!asrModelInstaller || typeof asrModelInstaller.status !== 'function') return null;
    return asrModelInstaller.status();
  }

  app.post(HOST_PATH, async (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

    try {
      if (body.op === 'examples') {
        return res.json({ ok: true, examples: loadVoiceExamples() });
      }

      if (body.op === 'auxEnqueue') {
        const meta = (body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) ? body.meta : {};
        const reqId = meta.reqId || `aux_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const type = body.type;
        const prompt = body.prompt;
        const t0 = Date.now();
        log.log(`[multicc/voice][${reqId}] Routing to AuxQueue (prompt ${String(prompt || '').length} chars)`);
        try {
          const result = await getAuxQueue().enqueue({ type, prompt, meta });
          const ms = Date.now() - t0;
          // Reading `result.text` inside the try keeps the old TypeError shape
          // when enqueue resolves undefined.
          const text = result.text || '';
          log.log(`[multicc/voice][${reqId}] AuxQueue ${type} done in ${ms}ms, text length: ${text.length}`);
          return res.json({ ok: true, text });
        } catch (err) {
          const ms = Date.now() - t0;
          const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
          log.error(`[multicc/voice][${reqId}] AuxQueue ${type} error after ${ms}ms:`, errMsg);
          return res.json({
            ok: false,
            cancelled: !!(err && err.cancelled),
            message: (err && err.message) || String(err),
          });
        }
      }

      if (body.op === 'feedbackApply') {
        const { raw, refined, userFinal } = body;
        appendVoiceExample({ raw, refined, userFinal, ts: new Date().toISOString() });
        const corrections = extractCorrections(raw, userFinal);
        if (corrections.length > 0) mergeWhisperVocab(corrections);
        if (voice.autoHotwordsEnabled && voice.autoHotwords) {
          try { voice.autoHotwords.learnFromExample({ raw, userFinal, ts: new Date().toISOString() }); } catch (e) {
            log.error('[multicc/hotwords] learn failed:', e.message);
          }
        }
        return res.json({ ok: true });
      }

      if (body.op === 'vocabGet') {
        return res.json({ ok: true, vocab: loadWhisperVocab() });
      }

      if (body.op === 'vocabDelete') {
        // target 由前门小写化后传来。
        const target = body.target;
        const vocab = loadWhisperVocab().filter(v => v.term.toLowerCase() !== target);
        saveWhisperVocab(vocab);
        return res.json({ ok: true, remaining: vocab.length });
      }

      if (body.op === 'hotwords') {
        const present = !!voice.autoHotwords;
        return res.json({
          ok: true,
          present,
          enabled: !!voice.autoHotwordsEnabled,
          snapshot: present ? voice.autoHotwords.snapshot() : null,
        });
      }

      if (body.op === 'hotwordsReject') {
        const present = !!voice.autoHotwords;
        const accepted = present && !!voice.autoHotwords.reject({ term: body.term, alias: body.alias });
        return res.json({ ok: true, present, accepted });
      }

      if (body.op === 'readinessFacts') {
        let streaming = null;
        try { streaming = voiceAsr.providerStatus() || null; } catch (_) { streaming = null; }
        return res.json({
          ok: true,
          localAvailable: !!(asrLocal && asrLocal.isAvailable()),
          download: installerStatus(),
          cloudKeys: {
            whisper: !!voice.cfg.WHISPER_API_KEY,
            openrouter: !!voice.cfg.OPENROUTER_API_KEY,
          },
          streaming,
        });
      }

      if (body.op === 'settingsFacts') {
        // 只回 keys 白名单里的字符串项，绝不回传整份 process.env。
        const wanted = Array.isArray(body.keys) ? body.keys.filter(key => typeof key === 'string') : [];
        const envFile = readEnvFile() || {};
        const env = {};
        const runtime = {};
        for (const key of wanted) {
          if (typeof envFile[key] === 'string') env[key] = envFile[key];
          if (typeof runtimeEnv[key] === 'string') runtime[key] = runtimeEnv[key];
        }
        const asrStatus = voiceAsr.providerStatus();
        // The panel reads the ~229MB local-model download from
        // asr.status.local.download, exactly where the old GET put it.
        if (asrStatus && asrStatus.local) asrStatus.local.download = installerStatus();
        return res.json({
          ok: true,
          env,
          runtime,
          asrStatus,
          ttsStatus: ttsService.providerStatus(),
          qwenRuntime: getQwenAudioRuntimeStatus(),
        });
      }

      if (body.op === 'settingsApply') {
        // 前门已完成校验；这里只执行旧 POST /api/settings/voice 的事务块。
        const updates = (body.updates && typeof body.updates === 'object' && !Array.isArray(body.updates))
          ? body.updates : {};
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
        if (keys.some(keyName => keyName.startsWith('QWEN_AUDIO_'))) {
          Promise.resolve(onQwenAudioConfigChanged())
            .catch(() => safeReport('qwen_audio_runtime_refresh', 'apply_failed'));
        }
        return res.json({ ok: true });
      }

      if (body.op === 'asrModelCancel') {
        return res.json({
          ok: true,
          cancelled: asrModelInstaller.cancel(),
          status: asrModelInstaller.status(),
        });
      }

      if (body.op === 'asrModelStart') {
        // Never await: the transfer outlives the request, and start() resolves
        // only when the download settles.
        asrModelInstaller.start('manual').catch(() => {});
        return res.json({ ok: true, status: asrModelInstaller.status() });
      }

      return res.status(400).json({ error: 'unknown host operation' });
    } catch (error) {
      const payload = { ok: false, error: { message: String((error && error.message) || error) } };
      if (error && error.statusCode !== undefined && error.statusCode !== null) {
        payload.error.statusCode = error.statusCode;
      }
      return res.json(payload);
    }
  });

  return Object.freeze({ getConsistency() { return { ...consistency }; } });
}

module.exports = { mountVoiceHostRoute, HOST_PATH };
