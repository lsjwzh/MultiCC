'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const {
  GLOBAL_VOICE_GATEWAY_ID,
  bindingState,
  isGlobalVoiceGatewayRecord,
  isVoiceGatewayRecord,
  resolveVoiceGateway,
} = require('./voice-gateway');
const { ensurePrivateDir } = require('./runtime-security');

// Realtime voice is a single machine-wide child. GLOBAL_KEY is its slot in the
// same state map the per-Fleet runtimes use, so restart budgets, health polling
// and shutdown are shared code rather than a parallel implementation.
//
// The per-Fleet path below is retained only for the compatibility window: it is
// still directly reachable (and still pinned by tests), but `reconcileAll` will
// not start it once a global gateway exists, which is what keeps "two Fleets
// enabled" from becoming two processes.
const GLOBAL_KEY = '__global__';

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const HEALTH_INTERVAL_MS = 15000;
const START_TIMEOUT_MS = 45000;

const PUBLIC_ERRORS = Object.freeze({
  directory_not_found: 'Fleet 不存在',
  voice_gateway_not_found: '该 Fleet 尚未配置 Qwen Audio Gateway',
  voice_gateway_disabled: '该 Fleet 的 Qwen Audio Gateway 已停用',
  commander_not_found: '该 Fleet 没有唯一 Commander',
  commander_ambiguous: '该 Fleet 存在多个 Commander',
  commander_binding_stale: 'Qwen Audio Gateway 的 Commander 绑定已过期',
  voice_gateway_ambiguous: '该 Fleet 存在重复的 Qwen Audio Gateway',
  qwen_runtime_not_installed: 'Qwen Audio Runtime 尚未安装',
  qwen_api_key_missing: '尚未配置 Qwen Audio 的 DashScope API Key',
  directory_path_missing: 'Fleet 工作目录不可用',
  port_unavailable: '没有可用的 Qwen Audio 本地端口',
  spawn_failed: 'Qwen Audio 进程启动失败',
  startup_failed: 'Qwen Audio Gateway 未能通过启动自检',
  restart_budget_exhausted: 'Qwen Audio 连续异常退出，已暂停自动重启',
});

function publicError(code) {
  return { code, message: PUBLIC_ERRORS[code] || PUBLIC_ERRORS.startup_failed };
}

function fleetRuntimeKey(directoryId) {
  return crypto.createHash('sha256').update(String(directoryId), 'utf8').digest('hex').slice(0, 32);
}

function preferredPort(directoryId, start = 32100, span = 3000) {
  const hash = crypto.createHash('sha256').update(String(directoryId), 'utf8').digest();
  return start + (hash.readUInt32BE(0) % span);
}

function portAvailable(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function redactLogLine(value, secrets = []) {
  let line = String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
  for (const secret of secrets) {
    if (secret) line = line.split(secret).join('[REDACTED]');
  }
  line = line.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  return line;
}

function createQwenAudioSupervisor({
  records,
  directories,
  installer,
  getConfig,
  getBaseUrl,
  acpAgentPath,
  frontendPromptDir = path.join(__dirname, 'voice', 'frontend-prompt'),
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = console,
  healthIntervalMs = HEALTH_INTERVAL_MS,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('qwen supervisor requires records Map');
  if (!(directories instanceof Map)) throw new TypeError('qwen supervisor requires directories Map');
  if (!installer || typeof installer.resolveInstalled !== 'function') {
    throw new TypeError('qwen supervisor requires installer');
  }
  if (typeof getConfig !== 'function') throw new TypeError('qwen supervisor requires getConfig');
  if (typeof getBaseUrl !== 'function') throw new TypeError('qwen supervisor requires getBaseUrl');
  if (!path.isAbsolute(acpAgentPath || '')) throw new TypeError('qwen supervisor requires absolute acpAgentPath');

  const states = new Map();
  let shuttingDown = false;

  function stateFor(directoryId) {
    let state = states.get(directoryId);
    if (!state) {
      state = {
        directoryId,
        scope: directoryId === GLOBAL_KEY ? 'global' : 'fleet',
        state: 'stopped',
        child: null,
        desired: false,
        port: null,
        url: null,
        startPromise: null,
        restartTimer: null,
        healthTimer: null,
        healthFailures: 0,
        restartTimes: [],
        intentionalStop: false,
        lastError: null,
        lastExitAt: null,
        health: null,
        logs: [],
      };
      states.set(directoryId, state);
    }
    return state;
  }

  function gatewayFor(directoryId) {
    const result = resolveVoiceGateway(records, directoryId);
    return result.ok ? result.record : null;
  }

  function globalGateway() {
    const record = records.get(GLOBAL_VOICE_GATEWAY_ID);
    return isGlobalVoiceGatewayRecord(record) ? record : null;
  }

  function hasGlobalGateway() {
    return !!globalGateway();
  }

  function desiredFor(directoryId) {
    if (directoryId === GLOBAL_KEY) {
      const record = globalGateway();
      return !!(record && record.enabled === true);
    }
    // Once the global gateway exists it is the only realtime runtime, so a
    // leftover per-Fleet record must not read as "should be running".
    if (hasGlobalGateway()) return false;
    const gateway = gatewayFor(directoryId);
    return !!(gateway && gateway.enabled === true);
  }

  function globalStatus() {
    const state = stateFor(GLOBAL_KEY);
    state.desired = desiredFor(GLOBAL_KEY);
    const installed = installer.status();
    return {
      scope: 'global',
      id: GLOBAL_VOICE_GATEWAY_ID,
      desired: state.desired,
      state: state.state,
      url: state.url,
      installedVersion: installed.installed ? installed.package.version : null,
      restartCount: state.restartTimes.filter(ts => now() - ts < RESTART_WINDOW_MS).length,
      health: state.health ? {
        voiceConfigured: state.health.voiceConfigured === true,
        backendReady: state.health.backend?.ok === true,
        model: state.health.realtimeModel || null,
      } : null,
      lastError: state.lastError,
      lastExitAt: state.lastExitAt,
    };
  }

  function status(directoryId) {
    if (directoryId === GLOBAL_KEY) return globalStatus();
    if (!directories.has(directoryId)) {
      const installed = installer.status();
      return {
        directoryId,
        desired: false,
        state: 'directory_not_found',
        url: null,
        installedVersion: installed.installed ? installed.package.version : null,
        restartCount: 0,
        health: null,
        lastError: publicError('directory_not_found'),
        lastExitAt: null,
      };
    }
    const state = stateFor(directoryId);
    state.desired = desiredFor(directoryId);
    const installed = installer.status();
    return {
      directoryId,
      desired: state.desired,
      state: state.state,
      url: state.url,
      installedVersion: installed.installed ? installed.package.version : null,
      restartCount: state.restartTimes.filter(ts => now() - ts < RESTART_WINDOW_MS).length,
      health: state.health ? {
        voiceConfigured: state.health.voiceConfigured === true,
        backendReady: state.health.backend?.ok === true,
        model: state.health.realtimeModel || null,
      } : null,
      lastError: state.lastError,
      lastExitAt: state.lastExitAt,
    };
  }

  async function allocatePort(directoryId) {
    const first = preferredPort(directoryId);
    const reserved = new Set([...states.values()].map(state => state.port).filter(Boolean));
    for (let offset = 0; offset < 128; offset++) {
      const candidate = 32100 + ((first - 32100 + offset) % 3000);
      if (reserved.has(candidate)) continue;
      if (await portAvailable(candidate)) return candidate;
    }
    return null;
  }

  function clearRuntimeTimers(state) {
    if (state.restartTimer) clearTimeout(state.restartTimer);
    if (state.healthTimer) clearInterval(state.healthTimer);
    state.restartTimer = null;
    state.healthTimer = null;
  }

  function stopChild(state, signal = 'SIGTERM') {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, signal); return; } catch (_) {}
    }
    try { child.kill(signal); } catch (_) {}
  }

  function rememberLog(state, chunk, secrets) {
    const line = redactLogLine(chunk, secrets);
    if (!line) return;
    state.logs.push(line);
    if (state.logs.length > 40) state.logs.splice(0, state.logs.length - 40);
  }

  async function readHealth(url, timeoutMs = 2500) {
    if (typeof fetchImpl !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(`${url}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      return await response.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function scheduleRestart(state) {
    if (shuttingDown || !desiredFor(state.directoryId) || state.restartTimer) return;
    const cutoff = now() - RESTART_WINDOW_MS;
    state.restartTimes = state.restartTimes.filter(ts => ts >= cutoff);
    if (state.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      state.state = 'failed';
      state.lastError = publicError('restart_budget_exhausted');
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(state.restartTimes.length, RESTART_DELAYS_MS.length - 1)];
    state.restartTimes.push(now());
    state.state = 'backoff';
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      start(state.directoryId).catch(() => {});
    }, delay);
    if (typeof state.restartTimer.unref === 'function') state.restartTimer.unref();
  }

  function attachHealthMonitor(state) {
    if (state.healthTimer) clearInterval(state.healthTimer);
    state.healthTimer = setInterval(async () => {
      if (!state.child || state.state !== 'running') return;
      const health = await readHealth(state.url);
      if (health?.voiceConfigured === true && health?.backend?.ok === true) {
        state.health = health;
        state.healthFailures = 0;
        return;
      }
      state.healthFailures += 1;
      if (state.healthFailures < 3) return;
      state.lastError = publicError('startup_failed');
      stopChild(state, 'SIGTERM');
    }, healthIntervalMs);
    if (typeof state.healthTimer.unref === 'function') state.healthTimer.unref();
  }

  function childEnvironment(runtime, directory, directoryId, port, config) {
    const isGlobal = directoryId === GLOBAL_KEY;
    const configDirectory = path.join(runtime.fleetConfigRoot, fleetRuntimeKey(directoryId));
    const env = {
      HOME: process.env.HOME || '',
      PATH: `${path.dirname(runtime.nodePath)}${path.delimiter}${process.env.PATH || ''}`,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      QWAUDIO_CONFIG_DIR: configDirectory,
      QWEN_AUDIO_AGENT_RUNTIME_ROOT: runtime.packageRoot,
      // Repo-owned identity prompt. Only the stable identity lives here; the
      // per-call session/Fleet/project context is injected by the Host at launch
      // resolution time, never baked into a machine-wide prompt.
      QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR: frontendPromptDir,
      QWEN_AUDIO_REALTIME_API_KEY: config.apiKey,
      QWEN_AUDIO_REALTIME_MODEL: config.model || 'qwen-audio-3.0-realtime-plus',
      QWEN_AUDIO_REALTIME_VOICE: config.voice || 'longanqian',
      AGENT_PROTOCOL: 'acp',
      ACP_COMMAND: runtime.nodePath,
      // The global child is not bound to a Fleet at spawn time: every prompt
      // carries its own launch id, which the ACP agent resolves against the Host.
      ACP_ARGS: JSON.stringify(isGlobal ? [acpAgentPath] : [acpAgentPath, '--directory-id', directoryId]),
      ACP_LABEL: isGlobal ? 'MultiCC 实时语音' : 'MultiCC Commander',
      ACP_WORKSPACE: isGlobal ? configDirectory : (directory.path || directory.cwd),
      QWEN_AUDIO_AGENT_BACKEND_MODEL: '',
      QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE: 'native',
      MULTICC_BASE_URL: getBaseUrl(),
    };
    if (config.baseUrl) env.QWEN_AUDIO_REALTIME_BASE_URL = config.baseUrl;
    for (const name of [
      'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY',
      'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    ]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    return env;
  }

  async function waitUntilReady(state) {
    const deadline = now() + startTimeoutMs;
    while (now() < deadline) {
      if (!state.child || state.child.exitCode !== null || state.child.signalCode !== null) return null;
      const health = await readHealth(state.url);
      if (health?.voiceConfigured === true && health?.backend?.ok === true) return health;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }

  // The global runtime has no Commander binding to validate: it is not bound to a
  // Fleet at all. Routing is decided per utterance from the launch ticket, which
  // is what lets one child serve every Fleet without a restart.
  function validateStartGlobal() {
    const gateway = globalGateway();
    if (!gateway) return { ok: false, code: 'voice_gateway_not_found' };
    if (gateway.enabled !== true) return { ok: false, code: 'voice_gateway_disabled' };
    const runtime = installer.resolveInstalled();
    if (!runtime) return { ok: false, code: 'qwen_runtime_not_installed' };
    const config = getConfig();
    if (!config?.apiKey) return { ok: false, code: 'qwen_api_key_missing' };
    return { ok: true, gateway, runtime, config, directory: null };
  }

  function validateStart(directoryId) {
    if (directoryId === GLOBAL_KEY) return validateStartGlobal();
    const gateway = gatewayFor(directoryId);
    if (!gateway) return { ok: false, code: 'voice_gateway_not_found' };
    const binding = bindingState(records, gateway);
    if (!binding.ready) return { ok: false, code: binding.code || 'startup_failed' };
    const runtime = installer.resolveInstalled();
    if (!runtime) return { ok: false, code: 'qwen_runtime_not_installed' };
    const config = getConfig();
    if (!config?.apiKey) return { ok: false, code: 'qwen_api_key_missing' };
    const directory = directories.get(directoryId);
    if (!directory || !(directory.path || directory.cwd)) return { ok: false, code: 'directory_path_missing' };
    return { ok: true, gateway, runtime, config, directory };
  }

  function known(directoryId) {
    return directoryId === GLOBAL_KEY || directories.has(directoryId);
  }

  async function start(directoryId) {
    if (!known(directoryId)) return status(directoryId);
    const state = stateFor(directoryId);
    state.desired = desiredFor(directoryId);
    if (state.startPromise) return state.startPromise;
    if (state.child && state.state === 'running') return status(directoryId);

    const validated = validateStart(directoryId);
    if (!validated.ok) {
      state.state = validated.code === 'voice_gateway_disabled' ? 'stopped' : validated.code;
      state.lastError = publicError(validated.code);
      return status(directoryId);
    }
    state.lastError = null;
    state.intentionalStop = false;
    state.state = 'starting';
    state.startPromise = (async () => {
      const port = await allocatePort(directoryId);
      if (!port) {
        state.state = 'failed';
        state.lastError = publicError('port_unavailable');
        return status(directoryId);
      }
      state.port = port;
      state.url = `http://127.0.0.1:${port}`;
      ensurePrivateDir(validated.runtime.fleetConfigRoot);
      const configDirectory = path.join(validated.runtime.fleetConfigRoot, fleetRuntimeKey(directoryId));
      ensurePrivateDir(configDirectory);
      const env = childEnvironment(
        validated.runtime,
        validated.directory,
        directoryId,
        port,
        validated.config,
      );
      let child;
      try {
        child = spawnImpl(validated.runtime.nodePath, [validated.runtime.serverEntry], {
          cwd: path.join(validated.runtime.packageRoot, 'server'),
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (_) {
        state.state = 'failed';
        state.lastError = publicError('spawn_failed');
        scheduleRestart(state);
        return status(directoryId);
      }
      state.child = child;
      const secrets = [validated.config.apiKey];
      child.stdout?.on('data', chunk => rememberLog(state, chunk, secrets));
      child.stderr?.on('data', chunk => rememberLog(state, chunk, secrets));
      child.once('error', () => {
        state.lastError = publicError('spawn_failed');
      });
      child.once('exit', () => {
        const intentional = state.intentionalStop;
        clearRuntimeTimers(state);
        state.child = null;
        state.health = null;
        state.lastExitAt = new Date(now()).toISOString();
        state.state = intentional ? 'stopped' : 'failed';
        state.intentionalStop = false;
        if (!intentional) {
          state.lastError ||= publicError('startup_failed');
          scheduleRestart(state);
        }
      });

      const health = await waitUntilReady(state);
      if (!health) {
        if (shuttingDown || !desiredFor(directoryId) || state.state === 'stopped') {
          return status(directoryId);
        }
        state.lastError ||= publicError('startup_failed');
        stopChild(state, 'SIGTERM');
        scheduleRestart(state);
        return status(directoryId);
      }
      state.state = 'running';
      state.health = health;
      state.healthFailures = 0;
      attachHealthMonitor(state);
      return status(directoryId);
    })().finally(() => { state.startPromise = null; });
    return state.startPromise;
  }

  async function stop(directoryId) {
    if (!known(directoryId)) return status(directoryId);
    const state = stateFor(directoryId);
    state.desired = desiredFor(directoryId);
    clearRuntimeTimers(state);
    state.intentionalStop = true;
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      state.child = null;
      state.state = 'stopped';
      state.url = null;
      return status(directoryId);
    }
    stopChild(state, 'SIGTERM');
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      const timer = setTimeout(() => {
        stopChild(state, 'SIGKILL');
        finish();
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
    });
    state.url = null;
    state.state = 'stopped';
    return status(directoryId);
  }

  function reconcile(directoryId, { installIfNeeded = false } = {}) {
    const state = stateFor(directoryId);
    state.desired = desiredFor(directoryId);
    if (!state.desired) {
      stop(directoryId).catch(() => {});
      return status(directoryId);
    }
    if (!installer.resolveInstalled() && installIfNeeded) {
      state.state = 'installing';
      state.lastError = null;
      installer.install()
        .then(() => start(directoryId))
        .catch(error => {
          state.state = 'failed';
          state.lastError = installer.status().lastError || publicError(error?.code || 'startup_failed');
        });
      return status(directoryId);
    }
    start(directoryId).catch(error => {
      try { log.error?.('[multicc/qwen-audio] start failed', { directoryId, error: error?.message }); } catch (_) {}
    });
    return status(directoryId);
  }

  // The single point that decides how many realtime children exist. Once the
  // global gateway record is present it is the only runtime reconciled up;
  // legacy per-Fleet records are reconciled *down*, so two Fleets that were both
  // enabled before the migration still resolve to exactly one process.
  //
  // Every call is serialized on a shared lifecycle chain: a concurrent reconcile
  // (boot + install + a Fleet toggle landing at once) must not re-enter and start
  // the global child while a legacy child is still exiting — that overlap is a
  // double-spawn. We await every legacy stop *fully* before reconciling global.
  // The chain never rejects, so fire-and-forget callers cannot cause an unhandled
  // rejection; the caller still receives the Promise and may await the result.
  let lifecycleChain = Promise.resolve();
  function reconcileAll(options = {}) {
    const run = async () => {
      try {
        const legacy = [...records.values()]
          .filter(record => isVoiceGatewayRecord(record))
          .map(record => record.dirId);
        if (hasGlobalGateway()) {
          await Promise.allSettled(legacy.map(directoryId => stop(directoryId)));
          return reconcile(GLOBAL_KEY, options);
        }
        for (const directoryId of legacy) reconcile(directoryId, options);
        return undefined;
      } catch (error) {
        try { log.error?.('[multicc/qwen-audio] reconcileAll failed', { error: error?.message }); } catch (_) {}
        return undefined;
      }
    };
    lifecycleChain = lifecycleChain.then(run);
    return lifecycleChain;
  }

  async function restart(directoryId) {
    const state = stateFor(directoryId);
    state.restartTimes = [];
    await stop(directoryId);
    return start(directoryId);
  }

  async function restartAll() {
    const ids = [...states.keys()].filter(desiredFor);
    return Promise.allSettled(ids.map(id => restart(id)));
  }

  async function stopAll() {
    shuttingDown = true;
    const ids = new Set([
      ...states.keys(),
      ...[...records.values()]
        .filter(record => isVoiceGatewayRecord(record))
        .map(record => record.dirId),
    ]);
    if (hasGlobalGateway()) ids.add(GLOBAL_KEY);
    await Promise.allSettled([...ids].filter(Boolean).map(id => stop(id)));
  }

  return Object.freeze({
    globalKey: GLOBAL_KEY,
    hasGlobalGateway,
    reconcile,
    reconcileAll,
    reconcileGlobal: (options = {}) => reconcile(GLOBAL_KEY, options),
    restart,
    restartAll,
    restartGlobal: () => restart(GLOBAL_KEY),
    start,
    startGlobal: () => start(GLOBAL_KEY),
    status,
    statusGlobal: () => status(GLOBAL_KEY),
    stop,
    stopGlobal: () => stop(GLOBAL_KEY),
    stopAll,
  });
}

module.exports = {
  GLOBAL_KEY,
  HEALTH_INTERVAL_MS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  START_TIMEOUT_MS,
  createQwenAudioSupervisor,
  fleetRuntimeKey,
  portAvailable,
  preferredPort,
  publicError,
  redactLogLine,
};
