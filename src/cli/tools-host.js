'use strict';

// The native owner holds install jobs, mutexes, log rings, caches and response
// policy. This adapter only gathers host facts and executes process/file effects.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getNative } = require('../native/runtime');
const capability = require('./cli-capability');
const cliUpstream = require('./cli-upstream-version');
const homebrewTakeover = require('./homebrew-takeover');
const { bundledClaudeCodeBinary } = require('./claude-bundled-binary');
const { getChildProxyEnv } = require('../network/outbound');
const native = getNative();
const OFFICIAL_INSTALL_SPECS = Object.freeze(Object.fromEntries(
  Object.entries(native.cliToolsOfficialSpecs(capability.updateSpecs()))
    .map(([family, spec]) => [family, Object.freeze(spec)]),
));
const VERSION_TIMEOUT_MS = Number(process.env.CLI_VERSION_TIMEOUT_MS || 8000);

function createCliToolsHost(options) {
  const clock = options.clock || Date.now;
  const installSpecs = options.installSpecs || OFFICIAL_INSTALL_SPECS;
  const state = new native.RustCliToolsRuntime({
    specs: installSpecs, supported: options.supportedClis,
    npmPackages: capability.npmPackages(),
    catalog: options.supportedClis.map(id => ({
      id, canonical: capability.nameOf(id), family: capability.familyOf(id),
      familyName: capability.familyNameOf(id), bundled: capability.isBundled(id),
      terminal: capability.offersIn(id, 'terminal'), engines: capability.bundledEnginesOf(id),
    })),
  });
  const call = (op, input = {}) => state.request(op, input);
  const pinEnv = options.env || process.env;
  const envFile = options.envFile || path.join(__dirname, '..', '..', '.env');
  const refresh = options.refreshCliEnvironment || require('../windows-env').refresh;
  const spawn = options.spawnProcess || require('node:child_process').spawn;
  const execFile = options.execFileVersion || require('node:child_process').execFile;
  const brewOwnerOf = options.homebrewOwnerOf || homebrewTakeover.homebrewOwnerOf;
  const pinNames = call('pinNames');
  const pins = () => Object.fromEntries(pinNames.map(name => [name, pinEnv[name]]));
  const availability = () => options.cliAvailabilitySummary() || {};
  const send = (res, result) => res.status(result.response.status).json(result.response.body);
  const at = () => new Date(clock()).toISOString();
  const realPath = cmd => { try { return fs.realpathSync(cmd); } catch (_) { return cmd; } };
  const commandMap = () => {
    if (options.cliCommands && typeof options.cliCommands === 'object') return options.cliCommands;
    try { return require('../cli-adapters/commands').resolveCliCommands({ logger: { log() {}, warn() {} } }); }
    catch (_) { return {}; }
  };
  // The package descriptor is a Node module-resolution fact, not version policy.
  let installedEngine, declaredEngine;
  try {
    const binary = bundledClaudeCodeBinary();
    if (binary) installedEngine = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), 'package.json'), 'utf8')).version;
  } catch (_) {}
  try { declaredEngine = require('../../package.json').dependencies?.['@anthropic-ai/claude-agent-sdk']; } catch (_) {}
  const bundledVersions = { claude: call('bundledEngineVersion', { installed: installedEngine, declared: declaredEngine }) };

  function probe(cmd) {
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(call('probeVersion', value)); } };
      try {
        execFile(cmd, ['--version'], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
          (error, stdout, stderr) => done({ stdout, stderr, error: error ? String(error.message || error) : null }));
      } catch (error) { done({ error: String(error?.message || error) }); }
    });
  }
  async function bundledVersion(force) {
    if (typeof options.bundledClaudeCodeVersion === 'function') return options.bundledClaudeCodeVersion();
    if (options.bundledClaudeCodeVersion !== undefined) return options.bundledClaudeCodeVersion;
    const now = clock();
    const plan = call('bundledPlan', { now, force });
    if (plan.cached) return plan.version;
    const binary = bundledClaudeCodeBinary();
    const result = binary ? await probe(binary) : null;
    return call('bundledCommit', { now, version: result?.version || null });
  }
  function activeLanes() {
    const active = [];
    if (typeof options.records.values !== 'function') return active;
    for (const session of options.records.values()) {
      if (!session?.cli || !session?.id) continue;
      try {
        if (options.chatSessions.has(session.id) || options.hasLiveBackgroundTasks(session.id)) active.push(session.cli);
      } catch (_) {}
    }
    return active;
  }
  async function fetchLatest(pkg) {
    if (typeof options.fetchLatestVersionWithSource === 'function') return options.fetchLatestVersionWithSource(pkg);
    if (typeof options.fetchLatestVersion === 'function') return { version: await options.fetchLatestVersion(pkg), registry: options.registryBase || null };
    // The upstream module bridges the shared Rust registry and transport owner.
    return cliUpstream.fetchLatestVersionWithSource(pkg, { registryBase: options.registryBase });
  }
  async function collectVersions(force) {
    const now = clock();
    let local = call('localPeek', { now, force });
    if (!local) {
      local = call('localPlan', { now, force, commands: commandMap(), availability: availability(), bundledVersions });
      const results = [];
      await Promise.all(local.probes.map(async item => { results.push({ ...item, result: await probe(item.cmd) }); }));
      local = call('localCommit', { now: local.at, initial: local.initial, results });
    }
    const baseline = await bundledVersion(force);
    let upstream = call('latestPlan', { now: clock(), force, versions: local.versions, baseline });
    if (!upstream.cached) {
      const results = [];
      await Promise.all(upstream.probes.map(async item => {
        let result = null;
        try { result = await fetchLatest(item.pkg); } catch (_) {}
        results.push({ family: item.family, result });
      }));
      upstream = call('latestCommit', { now: upstream.at, initial: upstream.initial, registry: upstream.registry, results });
    }
    const pinFacts = pins();
    const realPaths = Object.fromEntries(Object.values(pinFacts).filter(Boolean).map(value => [String(value).trim(), realPath(String(value).trim())]));
    return call('versions', { local, upstream, baseline, active: activeLanes(), pins: pinFacts, realPaths, sep: path.sep });
  }
  function startUpdateWatch() {
    const plan = call('watchStart');
    if (!plan.start) return true;
    const run = () => Promise.resolve().then(() => collectVersions(true)).catch(error => {
      (options.logger || console).warn?.(`[multicc] CLI update check failed: ${error?.message || String(error)}`);
    });
    const startup = setTimeout(run, plan.startupMs); startup.unref?.();
    const interval = setInterval(run, plan.intervalMs); interval.unref?.();
    return true;
  }
  async function launch(cli) {
    const environment = call('installEnvironment', { cli, path: process.env.PATH, localBin: path.join(os.homedir(), '.local/bin') });
    const env = { ...process.env, ...environment.patch };
    const cmd = commandMap()[cli];
    const nativeUpgrade = call('nativeUpgrade', { cmd, real: realPath(cmd), target: environment.target, sep: path.sep });
    const spec = installSpecs[environment.target];
    let brewOwner = null;
    if (call('needsBrewProbe', { nativeUpgrade, command: spec.command })) {
      try { brewOwner = brewOwnerOf(commandMap()[cli], { envPath: env.PATH }); } catch (_) {}
    }
    // Native registers the running mutex before the first asynchronous effect.
    const job = call('launch', { cli, id: `cli-install_${crypto.randomBytes(8).toString('hex')}`, at: at(), nativeUpgrade, brewOwner });
    const event = (kind, facts = {}) => call('jobEvent', { id: job.id, kind, at: at(), ...facts });
    let proc;
    try {
      const childEnv = await (options.getChildProxyEnv || getChildProxyEnv)(env);
      proc = spawn('bash', ['-c', job.command], { env: childEnv });
    } catch (error) { event('spawnError', { error: String(error?.message || error) }); return job; }
    let timer = setTimeout(() => {
      const result = event('timeout');
      if (result.kill) { try { proc.kill('SIGKILL'); } catch (_) {} }
    }, job.timeoutMs);
    timer.unref?.();
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    for (const stream of [proc.stdout, proc.stderr]) stream?.on?.('data', chunk => call('jobLog', { id: job.id, text: String(chunk) }));
    proc.on('error', error => { if (event('error', { error: String(error?.message || error) }).accepted) clearTimer(); });
    proc.on('exit', async (code, signal) => {
      const result = event('exit', { code, signal });
      if (!result.accepted) return;
      clearTimer();
      if (!result.refresh) return;
      try { await refresh({ force: true }); } catch (_) {}
      const next = call('jobRefresh', { id: job.id, availability: availability() });
      if (next?.verify) Promise.resolve().then(async () => {
        const resolved = commandMap()[next.cli];
        if (!resolved) return;
        const checked = await probe(resolved);
        call('jobVerify', { id: job.id, cmd: resolved, version: checked.version, pins: pins() });
      }).catch(() => {});
    });
    return job;
  }
  function mountRoutes(app, asyncHandler) {
    app.get('/api/cli/install-specs', asyncHandler(async (_req, res) => {
      await refresh(); return send(res, call('specs', { availability: availability() }));
    }));
    for (const kind of ['install', 'upgrade']) {
      app.post(`/api/cli/:cli/${kind}`, asyncHandler(async (req, res) => {
        const requested = req.params?.cli || '';
        const validation = call('installValidate', { kind, requested });
        if (validation.response) return send(res, validation);
        const plan = call('installPlan', { kind, requested, availability: validation.needAvailability ? availability() : null });
        if (plan.response) return send(res, plan);
        const job = await launch(plan.cli);
        return send(res, call('installResponse', { id: job.id, kind, active: plan.needActive ? activeLanes() : [] }));
      }));
    }
    app.get('/api/cli/install-status/:jobId', asyncHandler(async (req, res) => {
      const id = String(req.params?.jobId || '');
      const lookup = call('jobStatus', { id, lookupOnly: true });
      if (lookup.response) return send(res, lookup);
      return send(res, call('jobStatus', { id, availability: availability() }));
    }));
    app.get('/api/cli/versions', asyncHandler(async (req, res) => send(res,
      await collectVersions(call('force', { query: req.query })))));
    app.post('/api/cli/:cli/unpin', asyncHandler(async (req, res) => {
      const requested = req.params?.cli || '';
      const validation = call('unpinValidate', { requested });
      if (validation.response) return send(res, validation);
      const plan = call('unpinStart', { requested, pins: { [validation.name]: pinEnv[validation.name] } });
      if (plan.response) return send(res, plan);
      let text = null;
      try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) {}
      const rewrite = call('unpinText', { ...plan, text, at: at() });
      if (rewrite.response) return send(res, rewrite);
      const tmp = `${envFile}.tmp-${process.pid}`;
      try { fs.writeFileSync(tmp, rewrite.text); fs.renameSync(tmp, envFile); }
      catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        return send(res, call('unpinResult', { ...plan, success: false }));
      }
      delete pinEnv[plan.name];
      return send(res, call('unpinResult', { ...plan, success: true }));
    }));
  }
  return Object.freeze({ mountRoutes, startUpdateWatch });
}

module.exports = { createCliToolsHost, OFFICIAL_INSTALL_SPECS };
