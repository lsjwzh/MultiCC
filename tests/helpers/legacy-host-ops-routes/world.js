'use strict';

// The scripted host facts behind the retired host-and-system-operations
// handlers. The oracle and the front door's Node child both build this world
// from the same bag of dependency objects, so every value in a response comes
// from the handler that produced it, not from the real machine.
//
// Nothing here touches the system: the process launchers are fakes that record
// their arguments and never run, TCC/power/tunnel services are in-memory, and
// the only filesystem work is inside the temporary `rootDir` the restart and
// update preflights read (a fake ./multicc manager and .git dir).
const path = require('node:path');

// Both sides freeze the clock: the restart route counts streaming turns with
// Date.now(), and the update route stamps `startedAt`.
const FROZEN_NOW = 1794687600000;

const quiet = { log() {}, warn() {}, error() {}, info() {} };

/** A child-process stand-in: records the call, never spawns anything. */
function fakeChild(record) {
  const child = {
    killed: false,
    once(event) { record.events.push(event); return child; },
    on() { return child; },
    unref() {},
    kill() { child.killed = true; return true; },
    stdout: null,
    stderr: null,
  };
  return child;
}

function createWorld({ rootDir }) {
  const state = {
    env: { BARK_URL: 'https://bark.example/key', WEBHOOK_URL: '' },
    accessToken: 'secret-token-1',
    allowRemote: false,
    pushCfg: { BARK_URL: 'https://bark.example/key', WEBHOOK_URL: '' },
    tunnelConfig: {
      phddns: { enabled: false },
      tailscale: { enabled: false, funnel: false },
      natapp: { enabled: false },
      cpolar: { enabled: false },
      sakurafrp: { enabled: false },
    },
    funnelOn: false,
    funnelPort: 3000,
    lidEnabled: false,
    hasPassword: false,
    prefs: false,
    attrMode: 'auto',
    toolsInstalled: true,
    jobs: [],
    envRuns: new Map(),
    doctorRuns: new Map(),
    syncCalls: 0,
    failures: [],
    logs: [],
    spawns: [],
  };

  const sessions = new Map([
    ['s1', { id: 's1', isStreaming: true, lastStreamAt: FROZEN_NOW - 1000 }],
    ['s2', { id: 's2', isStreaming: true, lastStreamAt: FROZEN_NOW - 900000 }],
    ['s3', { id: 's3', isStreaming: false }],
  ]);

  // ── developer tools: xcode-select / git probes ───────────────────────────
  const developerRun = (file, args, options, callback) => {
    const key = `${file} ${args.join(' ')}`;
    if (key === 'xcode-select -p') {
      if (!state.toolsInstalled) return callback(Object.assign(new Error('missing'), { code: 1 }), '', '');
      return callback(null, '/Library/Developer/CommandLineTools\n', '');
    }
    if (key === 'xcode-select --install') {
      return callback(
        Object.assign(new Error('exit 1'), { code: 1 }), '',
        'xcode-select: error: install requested, install already in progress\n',
      );
    }
    if (key === '/bin/sh -c command -v git') return callback(null, '/opt/homebrew/bin/git\n', '');
    if (key === '/opt/homebrew/bin/git --version') return callback(null, 'git version 2.43.0\n', '');
    return callback(new Error(`unexpected ${key}`));
  };

  const developerTools = {
    platform: 'darwin',
    run: developerRun,
    log: quiet,
    portableGit: {
      isInstalled: () => false,
      addToPath() {},
      installScriptPath: () => path.join(rootDir, 'install-git.sh'),
    },
    spawnProcess: (...args) => {
      state.spawns.push({ module: 'developer-tools', args: args.slice(0, 2) });
      return fakeChild({ events: [] });
    },
    childEnv: async () => ({}),
  };

  // ── macOS privacy / Agent ────────────────────────────────────────────────
  const agentBin = '/opt/multicc/bin/multicc-agent';
  const privacyRun = (file, args, options, callback) => {
    const key = `${file} ${args.join(' ')}`;
    if (file === agentBin && args[0] === 'status') {
      return callback(null, JSON.stringify({
        ok: true,
        accessibility: true,
        screenRecording: false,
        escTaps: { hid: { enabled: true }, session: { enabled: false } },
      }));
    }
    if (file === agentBin && args[0] === 'call') {
      const request = JSON.parse(args[1]);
      // One permission deliberately fails so the 503 branch is compared too.
      if (request.permission === 'screenRecording') return callback(new Error('agent refused'));
      return callback(null, '{"ok":true}');
    }
    if (key.startsWith('/bin/launchctl kickstart')) return callback(null, '', '');
    if (file === '/usr/bin/open') return callback(null, '', '');
    return callback(new Error('unexpected'));
  };

  const macosPrivacy = {
    platform: 'darwin',
    run: privacyRun,
    log: quiet,
    permissionTargets: () => ({
      service: true,
      execPath: '/opt/multicc/multicc',
      appBundle: '/Applications/MultiCC.app',
      translocated: false,
    }),
    agentBin,
    uid: 501,
    delay: async () => {},
    agentProvisioner: () => ({
      inspect: () => ({ installed: '2.14.0', owner: 'other', build: '2.14.0' }),
      plan: () => ({ reason: 'other-owner', action: 'replace' }),
      getStatus: () => null,
      ensure: async () => ({ ok: true, replaced: true }),
    }),
    resolveAgentApp: () => null,
  };

  // ── repair terminal ─────────────────────────────────────────────────────
  const probeAnswers = {
    'command -v git': { code: 0, stdout: '/usr/bin/git\n' },
    'git --version': { code: 0, stdout: 'git version 2.39.2\n' },
    'git config --get user.name': { code: 0, stdout: 'multicc\n' },
    'git config --get user.email': { code: 0, stdout: '' },
    'id -un': { code: 0, stdout: 'multicc\n' },
    'id -u': { code: 0, stdout: '1000\n' },
    'sudo -n true': { code: 0, stdout: '' },
    'for c in dnf yum apt-get apk pacman zypper brew; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; break; }; done':
      { code: 0, stdout: 'apt-get\n' },
  };
  const opsTerminal = {
    platform: 'linux',
    log: quiet,
    now: () => FROZEN_NOW,
    exec: async command => probeAnswers[command] || { code: 1, stdout: '' },
    runGit: async () => ({ code: 1, stdout: '' }),
    start: (command, { onOutput } = {}) => {
      let finish = () => {};
      const done = new Promise(resolve => { finish = resolve; });
      onOutput('installing git\n', 'stdout');
      return { done, stop: () => finish({ code: null, timedOut: false }) };
    },
  };

  // ── host write services ─────────────────────────────────────────────────
  const hostWrite = {
    readEnvFile: () => ({ ...state.env }),
    writeEnvFile: updates => {
      for (const [key, value] of Object.entries(updates || {})) {
        if (value == null) delete state.env[key];
        else state.env[key] = value;
      }
    },
    getAccessToken: () => state.accessToken,
    setAccessToken: token => { state.accessToken = token; },
    getAllowRemote: () => state.allowRemote,
    isLocalRequest: req => req.local === true,
    push: {
      cfg: state.pushCfg,
      applyEnvUpdates: updates => {
        for (const [key, value] of Object.entries(updates || {})) {
          if (value == null) delete state.pushCfg[key];
          else state.pushCfg[key] = value;
        }
      },
    },
    tunnel: {
      getStatus: () => ({ config: state.tunnelConfig }),
      applyConfig: update => {
        state.tunnelConfig = { ...state.tunnelConfig, ...update };
        return state.tunnelConfig;
      },
      restartNow: async provider => {
        if (!['natapp', 'cpolar', 'sakurafrp'].includes(provider)) {
          return { ok: false, error: 'unknown provider' };
        }
        if (provider === 'cpolar') {
          return { ok: false, error: 'restart_failed', message: 'auth token **** rejected' };
        }
        return { ok: true, provider, restarted: true };
      },
      sakuraApplyPublicUrl: async ({ boundDomain }) => {
        if (!boundDomain) return { ok: false, reason: 'underivable', message: '' };
        if (!/\.nyat\.app$/.test(boundDomain)) return { ok: false, reason: 'invalid-domain', message: 'not a *.nyat.app host' };
        return { ok: true, url: `https://${boundDomain}` };
      },
      setFunnel: async (on, port) => {
        if (on === false) return { ok: false, error: 'funnel_disabled' };
        state.funnelOn = on;
        state.funnelPort = port;
        return { ok: true, funnel: true, port };
      },
      funnelStatus: async () => ({ running: state.funnelOn, port: state.funnelPort }),
    },
    macosPower: {
      isAvailable: () => true,
      getLidModeSettings: async () => ({ enabled: state.lidEnabled }),
      setLidSleepPrevention: async enabled => {
        state.lidEnabled = enabled;
        return { ok: true };
      },
    },
    unlockPassword: {
      isAvailable: () => true,
      hasPassword: async () => state.hasPassword,
      setPassword: async () => { state.hasPassword = true; },
      clearPassword: async () => { state.hasPassword = false; },
    },
    powerPreferences: {
      read: () => state.prefs,
      write: value => { state.prefs = !!value; },
    },
    unlockProbe: {
      probe: async () => ({ state: 'authorized' }),
      runtimeReady: async () => true,
      desktopPermissions: async () => ({ state: 'authorized' }),
    },
    taskAttributionMode: {
      get: () => state.attrMode,
      set: value => {
        const mode = String(value ?? '').trim().toLowerCase();
        if (!['auto', 'manual', 'off'].includes(mode)) {
          throw Object.assign(new Error('invalid attribution mode'), { status: 400, code: 'invalid_mode' });
        }
        state.attrMode = mode;
      },
    },
    reportFailure: (stage, category) => state.failures.push(`${stage}:${category}`),
    log: message => state.logs.push(message),
  };

  // ── skill sync runtime ──────────────────────────────────────────────────
  const skillSync = {
    getStatus: () => ({ running: state.syncCalls === 1, runs: state.syncCalls, lastRun: null }),
    runNow: () => {
      state.syncCalls += 1;
      if (state.syncCalls === 2) throw Object.assign(new Error('busy'), { code: 'SKILL_SYNC_RUNNING' });
      if (state.syncCalls === 3) throw new Error('registry mirror unreachable at /Users/secret/path');
      return { synced: state.syncCalls === 1 ? 2 : 1, skipped: 0 };
    },
  };

  // ── environment doctor ──────────────────────────────────────────────────
  let envSequence = 0;
  const envDoctor = {
    start: input => {
      if (!input.error && !input.path) {
        return { ok: false, status: 400, code: 'INVALID_INPUT', error: 'error or path is required' };
      }
      envSequence += 1;
      const run = {
        id: `env-${envSequence}`,
        status: 'running',
        target: input.path || null,
        fix: input.fix === true,
      };
      state.envRuns.set(run.id, run);
      return { ok: true, run };
    },
    get: id => {
      const run = state.envRuns.get(id);
      if (!run) return null;
      if (run.id === 'env-1') return { ...run, status: 'done', diagnosis: 'git is missing' };
      return run;
    },
    cancel: id => {
      const run = state.envRuns.get(id);
      if (!run || run.id !== 'env-1') return false;
      state.envRuns.delete(id);
      return true;
    },
  };

  // ── session doctor ──────────────────────────────────────────────────────
  let doctorSequence = 0;
  const doctor = {
    start: input => {
      if (input.sessionId === 'ghost') return { ok: false, status: 404, error: 'session not found' };
      doctorSequence += 1;
      const run = { id: `doc-${doctorSequence}`, sessionId: input.sessionId, status: 'running', autofix: input.autofix === true };
      state.doctorRuns.set(run.id, run);
      return { ok: true, run };
    },
    list: sessionId => [...state.doctorRuns.values()].filter(run => run.sessionId === sessionId),
    get: id => state.doctorRuns.get(id) || null,
    cancel: id => {
      const run = state.doctorRuns.get(id);
      if (!run) return false;
      state.doctorRuns.delete(id);
      return true;
    },
  };

  const restartDeps = {
    chatSessions: sessions,
    spawn: (...args) => {
      state.spawns.push({ module: 'restart', args: args.slice(0, 2) });
      return fakeChild({ events: [] });
    },
    rootDir,
    getShuttingDown: () => false,
    log: quiet,
    isDesktopMode: () => false,
  };

  const updateDeps = {
    chatSessions: sessions,
    spawn: (...args) => {
      state.spawns.push({ module: 'update', args: args.slice(0, 2) });
      return fakeChild({ events: [] });
    },
    rootDir,
    getShuttingDown: () => false,
    log: quiet,
    now: () => FROZEN_NOW,
    isDesktopMode: () => false,
    isStandalone: () => false,
    getPort: () => 3000,
  };

  return {
    state,
    restartDeps,
    updateDeps,
    developerTools,
    macosPrivacy,
    opsTerminal,
    hostWrite,
    skillSync,
    envDoctor,
    doctor,
  };
}

/**
 * The oracle side: mount the ten frozen modules exactly in the order
 * server.js used, on a real Express app so the automatic OPTIONS union is
 * Express's own.
 */
function mountFrozen(app, frozen, world) {
  const serverRestart = frozen.serverRestart().createServerRestartRoute(world.restartDeps);
  const update = frozen.update().createUpdateRoute(world.updateDeps);
  serverRestart.mountRoutes(app);
  update.mountRoutes(app);
  frozen.developerTools().createDeveloperToolsRoutes(world.developerTools).mountRoutes(app);
  frozen.macosPrivacy().createMacosPrivacyRoutes(world.macosPrivacy).mountRoutes(app);
  frozen.opsTerminal().createOpsTerminalRoutes(world.opsTerminal).mountRoutes(app);
  frozen.hostWrite().mountHostWriteRoutes(app, world.hostWrite);
  frozen.skillSync().mountSkillSyncRoutes(app, world.skillSync);
  frozen.envDoctor().mountEnvDoctorRoutes(app, { doctor: world.envDoctor });
  frozen.doctor().mountDoctorRoutes(app, { doctor: world.doctor });
}

module.exports = { FROZEN_NOW, createWorld, mountFrozen, fakeChild };
