'use strict';

const path = require('path');
const { mountVoiceRoutes } = require('../routes/voice');
const { createVoiceGatewayRoutes } = require('../routes/voice-gateway');
const { createGlobalVoiceGatewayRoutes } = require('../routes/voice-gateway-global');
const { createVoiceGatewayWebProxy, wireUpgrade } = require('../routes/voice-gateway-proxy');
const { GLOBAL_VOICE_GATEWAY_ID, legacyGatewayProjection } = require('./gateway');
const { createQwenAudioRuntimeRoutes } = require('../routes/qwen-audio-runtime');
const { createQwenAudioInstaller } = require('./qwen-audio-installer');
const { createQwenAudioSupervisor } = require('./qwen-audio-supervisor');
const { createVoiceLaunchRegistry } = require('./launch');
const { createVoiceRouterProvisioner } = require('./router');
const { createAsrModelInstaller } = require('./asr-model-installer');
const { resolveDirectoryCommander } = require('../task-board/core');

const DEFAULT_MODEL = 'qwen-audio-3.0-realtime-plus';
const DEFAULT_VOICE = 'longanqian';
const DEFAULT_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

// Compose the complete voice control plane in one host-owned boundary. Qwen is
// an isolated sidecar, never loaded into the MultiCC server process; this host
// only owns installation, lifecycle, settings and API route wiring.
function createVoiceHost({
  app,
  server,
  wss,
  serviceRoutes,
  records,
  directories,
  sessionPersistence,
  runtimeRoot,
  getBaseUrl,
  acpAgentPath = path.join(__dirname, 'multicc-acp-agent.mjs'),
  uploadVoice,
  voice = require('./config'),
  asrLocal = require('./asr-local'),
  // Local ASR weights are ~229MB fetched off the network, so the host decides
  // whether it may do that unprompted. Off by default: a host composed inside a
  // test must never reach HuggingFace. server.js opts in explicitly.
  autoDownloadAsrModels = false,
  voiceAsr,
  ttsService,
  readEnvFile,
  writeEnvFile,
  getAuxQueue,
  reportFailure,
  runtimeEnv = process.env,
  log = console,
} = {}) {
  if (typeof readEnvFile !== 'function') throw new TypeError('voice host requires readEnvFile');
  if (typeof getBaseUrl !== 'function') throw new TypeError('voice host requires getBaseUrl');

  const installer = createQwenAudioInstaller({ runtimeRoot, log });
  const getQwenAudioConfig = () => {
    const env = readEnvFile();
    return {
      apiKey: env.QWEN_AUDIO_DASHSCOPE_API_KEY
        || runtimeEnv.QWEN_AUDIO_DASHSCOPE_API_KEY
        || env.DASHSCOPE_API_KEY
        || runtimeEnv.DASHSCOPE_API_KEY
        || '',
      model: env.QWEN_AUDIO_REALTIME_MODEL || runtimeEnv.QWEN_AUDIO_REALTIME_MODEL || DEFAULT_MODEL,
      voice: env.QWEN_AUDIO_REALTIME_VOICE || runtimeEnv.QWEN_AUDIO_REALTIME_VOICE || DEFAULT_VOICE,
      baseUrl: env.QWEN_AUDIO_REALTIME_BASE_URL || runtimeEnv.QWEN_AUDIO_REALTIME_BASE_URL || DEFAULT_BASE_URL,
    };
  };
  const supervisor = createQwenAudioSupervisor({
    records,
    directories,
    installer,
    getConfig: getQwenAudioConfig,
    getBaseUrl,
    acpAgentPath,
    log,
  });

  const asrModelInstaller = createAsrModelInstaller({ asrLocal, log, autoDownload: autoDownloadAsrModels });

  mountVoiceRoutes(app, {
    uploadVoice,
    voice,
    asrLocal,
    asrModelInstaller,
    voiceAsr,
    ttsService,
    readEnvFile,
    writeEnvFile,
    getAuxQueue,
    reportFailure,
    runtimeEnv,
    getQwenAudioRuntimeStatus: () => installer.status(),
    onQwenAudioConfigChanged: () => supervisor.restartAll(),
  });
  const gatewayRoutes = createVoiceGatewayRoutes({
    records,
    directories,
    sessionPersistence,
    getBaseUrl,
    runtime: supervisor,
  });
  gatewayRoutes.mountRoutes(app);
  const launchRegistry = createVoiceLaunchRegistry({
    records,
    directories,
    resolveCommander: (map, directoryId) => resolveDirectoryCommander(map, directoryId),
  });
  const voiceRouter = createVoiceRouterProvisioner({
    records,
    mutate: (source, operation) => sessionPersistence.mutate(source, operation),
    runtimeRoot,
  });
  createGlobalVoiceGatewayRoutes({
    service: gatewayRoutes.service,
    launchRegistry,
    voiceRouter,
    runtime: supervisor,
    getBaseUrl,
    log,
  }).mountRoutes(app);
  createQwenAudioRuntimeRoutes({ installer, supervisor, log }).mountRoutes(app);

  // The Qwen child binds loopback; proxy its page/API/WebSocket through this
  // server so phones reach it via the same base URL they use for chat. The
  // WebSocket half (handleUpgrade) is wired where the HTTP server lives.
  const webProxy = createVoiceGatewayWebProxy({ runtime: supervisor, log });
  webProxy.mountRoutes(app);
  // Install the single 'upgrade' dispatcher: voice-child realtime sockets to
  // the proxy, every chat socket to the wss. No-op when server/wss are absent
  // (tests), and safe to call before the server listens.
  wireUpgrade(server, wss, webProxy, serviceRoutes);

  const gatewayService = gatewayRoutes.service;

  // Idempotent boot migration. ensureGlobal only ever ran on an HTTP PUT before,
  // so a boot that found legacy per-Fleet voice records but no global record let
  // reconcileAll start the old children (over-spawn). This runs once at startup,
  // before any reconcile: it creates the global record ONLY when there is no
  // global yet AND at least one legacy record exists — inheriting "enabled" from
  // any enabled legacy record. A brand-new empty record set creates nothing; an
  // existing global record is never mutated. When the effective global gateway is
  // enabled the __voice_router__ session is provisioned so global launches have
  // somewhere to land. Safe to call any number of times.
  function prepareBoot() {
    if (supervisor.hasGlobalGateway()) {
      const existing = records.get(GLOBAL_VOICE_GATEWAY_ID);
      const enabled = !!(existing && existing.enabled === true);
      if (enabled) voiceRouter.ensure();
      return { migrated: false, reason: 'global_exists', enabled };
    }
    const legacy = legacyGatewayProjection(records);
    if (!legacy.length) {
      return { migrated: false, reason: 'no_legacy', enabled: false };
    }
    const result = gatewayService.ensureGlobal({});
    const enabled = !!(result && result.record && result.record.enabled === true);
    if (enabled) voiceRouter.ensure();
    return { migrated: true, reason: 'migrated', enabled, created: !!(result && result.created) };
  }

  // First boot on a machine that has never held the weights: fetch them in the
  // background so on-device ASR is ready without anyone opening settings. The
  // delay keeps 229MB off the critical path of a cold start, and unref() means
  // the transfer never keeps the process alive on its own. maybeAutoDownload
  // re-checks every gate (ASR_LOCAL off, ASR_LOCAL_AUTO_DOWNLOAD off, files
  // already present), so this line only expresses intent, never a promise to
  // hit the network.
  if (autoDownloadAsrModels) {
    const timer = setTimeout(() => {
      try { asrModelInstaller.maybeAutoDownload(); } catch (_) {}
    }, 8000);
    if (timer.unref) timer.unref();
  }

  return Object.freeze({
    installer,
    asrModelInstaller,
    launchRegistry,
    voiceRouter,
    supervisor,
    webProxy,
    prepareBoot,
    reconcileAll: () => supervisor.reconcileAll(),
  });
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  DEFAULT_BASE_URL,
  createVoiceHost,
};
