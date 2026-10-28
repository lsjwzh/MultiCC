'use strict';

// Keeps the optional MultiCC Agent (scripts/install-agent.sh) installed and
// current, so installing or updating MultiCC is the only step a user takes:
// every server start compares the installed agent with the shipped source and
// runs the installer in the background when they differ.
//
// "Differs" includes an agent that is installed but unusable — a binary without
// its executable bit, or a missing client symlink — so a half-install repairs
// itself at the next start instead of failing every request forever.
//
// Cheap when nothing changed (a stat and one SHA-256 of a ~60 KB file); the
// installer itself restarts the agent, so it runs only when needed. It never
// blocks startup and never throws. The one thing it cannot do is grant the
// macOS permissions — on a first install it asks the agent to put itself into
// the System Settings lists (the system shows its own prompt), and the user
// flips the switches.
//
// Opt-outs: MULTICC_AGENT_AUTO_INSTALL=0, or `install-agent.sh uninstall`
// (leaves ~/.multicc/agent/auto-install-disabled until a manual install).
//
// Several MultiCC copies on one Mac (desktop app, standalone package, source
// checkout) share this one Agent. The rules that keep them from replacing each
// other in turn:
//   - only upgrade: a copy never replaces an Agent with a higher build number
//     (src/macos-agent-build.js) — it shares the newer one;
//   - same build, different code, installed by another copy: leave it and say
//     so; the user can choose to replace it (ensure({ replace: true }));
//   - install-agent.sh records who installed what in ~/.multicc/agent/install.json.
//     An Agent that no longer matches that record was replaced by a copy that
//     predates these rules; it is upgraded back and the replacement is reported.
//   - install-agent.sh exits 75 instead of re-signing ad-hoc when the identity
//     the Agent was signed with is unusable right now (a wrong clock at boot);
//     that would silently revoke every grant. The next start retries.

const { readShippedBuild, sourceHash } = require('./macos-agent-build');

const LABEL = 'com.multicc.agent';
const OUTPUT_TAIL = 4000;
const SIGNING_DEFERRED_EXIT = 75;
const DESKTOP_SERVER_SUFFIX = '.app/Contents/Resources/app-server';

function createMacosAgentProvisioner(deps = {}) {
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  const os = deps.os || require('os');
  const spawn = deps.spawn || require('child_process').spawn;
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const rootDir = deps.rootDir;
  const home = deps.home || os.homedir();

  const script = path.join(rootDir, 'scripts', 'install-agent.sh');
  const source = path.join(rootDir, 'scripts', 'macos-agent', 'MultiCCAgent.swift');
  const bridgeHeader = path.join(rootDir, 'scripts', 'macos-agent', 'LidBrightnessBridge.h');
  const bridgeSource = path.join(rootDir, 'scripts', 'macos-agent', 'LidBrightnessBridge.m');
  const h264Source = path.join(rootDir, 'scripts', 'macos-agent', 'MultiCCAgentH264.swift');
  const permissionSource = path.join(rootDir, 'scripts', 'macos-agent', 'AgentPermissions.swift');
  const icon = path.join(rootDir, 'scripts', 'macos-agent', 'AgentIcon.icns');
  // macOS installation adapter: keep this default aligned with install-agent.sh.
  const app = env.MULTICC_AGENT_APP || '/Applications/MultiCC Agent.app';
  const bin = path.join(app, 'Contents', 'MacOS', 'MultiCCAgent');
  const stamp = path.join(app, 'Contents', 'Resources', 'source.sha256');
  const plist = env.MULTICC_AGENT_PLIST || path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const link = env.MULTICC_AGENT_LINK || path.join(home, '.multicc', 'bin', 'multicc-agent');
  const agentDir = env.MULTICC_AGENT_DIR || path.join(home, '.multicc', 'agent');
  const record = path.join(agentDir, 'install.json');
  const desktopApps = deps.desktopApps || ['/Applications/MultiCC.app', path.join(home, 'Applications', 'MultiCC.app')];
  const desktopEnvFile = deps.desktopEnvFile || path.join(home, 'Library', 'Application Support', 'MultiCC', 'multicc.env');
  const X_OK = (fs.constants && fs.constants.X_OK) || 1;

  let inFlight = null;
  let last = null;

  const exists = p => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
  const isExec = p => { try { fs.accessSync(p, X_OK); return true; } catch (_) { return false; } };
  const readTrim = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; } };
  const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
  const realpath = p => { try { return fs.realpathSync(p); } catch (_) { return null; } };
  const appOf = binary => (binary && binary.endsWith('.app/Contents/MacOS/MultiCCAgent') ? path.resolve(binary, '../../..') : null);

  function installerKind(root) {
    if (root.endsWith(DESKTOP_SERVER_SUFFIX)) return 'desktop';
    return exists(path.join(root, '.git')) ? 'source' : 'package';
  }

  function self() {
    const root = realpath(rootDir) || rootDir;
    const pkg = readJson(path.join(rootDir, 'package.json'));
    return { kind: installerKind(root), version: (pkg && pkg.version) || null, root };
  }

  // Desktop apps whose bundled server still uses the replace-on-any-difference
  // rule: opening one puts its own Agent back (in ~/Applications for <= 2.11).
  function otherCopies(selfRoot) {
    const found = [];
    for (const appDir of desktopApps) {
      const server = path.join(appDir, 'Contents', 'Resources', 'app-server');
      if (!exists(server) || selfRoot.startsWith((realpath(appDir) || appDir) + path.sep)) continue;
      const pkg = readJson(path.join(server, 'package.json'));
      found.push({
        kind: 'desktop', app: appDir, version: (pkg && pkg.version) || null,
        legacyRules: !exists(path.join(server, 'scripts', 'macos-agent', 'agent-build.json')),
        autoInstallDisabled: /^\s*MULTICC_AGENT_AUTO_INSTALL\s*=\s*['"]?0['"]?\s*$/m.test(readTrim(desktopEnvFile)),
      });
    }
    return found;
  }

  // What is installed, by whom, and how it ranks against what this copy ships.
  function inspect() {
    const shipped = readShippedBuild(rootDir, fs);
    const me = self();
    const activeBin = realpath(link) || (exists(bin) ? bin : null);
    const activeApp = appOf(activeBin) || (exists(bin) ? app : null);
    const stampSum = activeApp ? readTrim(path.join(activeApp, 'Contents', 'Resources', 'source.sha256')) : '';
    const rec = readJson(record);
    // The installer records the path it was given; compare resolved paths.
    const recordApp = rec && typeof rec.app === 'string' ? (realpath(rec.app) || rec.app) : null;
    const recordMatches = Boolean(rec && activeApp && rec.sourceSha256 === stampSum && recordApp === activeApp);
    let shippedSum = '';
    try { shippedSum = sourceHash(rootDir, fs); } catch (_) { /* a package without the Agent sources */ }
    let build = 0;
    if (stampSum && stampSum === shippedSum) build = shipped.build;
    else if (recordMatches && Number.isSafeInteger(rec.build)) build = rec.build;
    const owner = recordMatches
      ? { kind: rec.installerKind || null, version: rec.installerVersion || null, root: rec.installerRoot || null, at: rec.installedAt || null }
      : null;
    return {
      self: me,
      shipped: { build: shipped.build, sourceSha256: shippedSum },
      installed: activeApp ? { app: activeApp, build, sourceSha256: stampSum || null, owner, mine: Boolean(owner && owner.root === me.root) } : null,
      // A recorded install that the Agent on disk no longer matches: a copy
      // without these rules replaced it.
      replaced: rec && activeApp && !recordMatches ? { app: activeApp, previousBuild: Number.isSafeInteger(rec.build) ? rec.build : null, previousApp: rec.app || null } : null,
      others: otherCopies(me.root),
    };
  }

  // { action: 'skip' | 'install' | 'update', reason }
  function plan(options = {}) {
    if (platform !== 'darwin') return { action: 'skip', reason: 'not-macos' };
    if (env.MULTICC_AGENT_AUTO_INSTALL === '0') return { action: 'skip', reason: 'disabled-by-env' };
    if (![script, source, bridgeHeader, bridgeSource, h264Source, permissionSource, icon].every(exists)) return { action: 'skip', reason: 'installer-not-shipped' };
    if (exists(path.join(agentDir, 'auto-install-disabled'))) return { action: 'skip', reason: 'uninstalled-by-user' };
    if (!exists(bin)) return { action: 'install', reason: 'not-installed' };
    // Installed but unrunnable: what a copy that lost its executable bit leaves
    // behind (see install-agent.sh). The stamps all match, launchd cannot start
    // it, and every request fails — so repair it instead of reporting "current".
    if (!isExec(bin)) return { action: 'install', reason: 'not-executable' };
    // The client symlink is what the probe and mcu.sh call; a missing one is the
    // same kind of half-install.
    if (!isExec(link)) return { action: 'install', reason: 'client-link-missing' };
    const seen = inspect();
    const { installed, shipped } = seen;
    if (installed.build > shipped.build) return { action: 'skip', reason: 'installed-newer', installedBuild: installed.build, shippedBuild: shipped.build };
    if (installed.build === shipped.build && installed.sourceSha256 !== shipped.sourceSha256 && installed.owner
      && !installed.mine && !options.replace) {
      return { action: 'skip', reason: 'other-owner', owner: installed.owner, installedBuild: installed.build };
    }
    // A global copy may already exist while this user's launcher still points
    // at the old ~/Applications bundle. Let the installer switch both paths.
    if (fs.realpathSync(link) !== fs.realpathSync(bin)) return { action: 'update', reason: 'client-location-changed' };
    if (readTrim(stamp) !== shipped.sourceSha256) return { action: 'update', reason: 'source-changed' };
    const installedIcon = path.join(app, 'Contents', 'Resources', 'AgentIcon.icns');
    if (!exists(installedIcon) || !fs.readFileSync(icon).equals(fs.readFileSync(installedIcon))) return { action: 'update', reason: 'icon-changed' };
    if (!exists(plist)) return { action: 'update', reason: 'launch-agent-missing' };
    return { action: 'skip', reason: 'up-to-date' };
  }

  function run(file, args) {
    return new Promise(resolve => {
      let output = '';
      let child;
      try {
        child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: -1, output: error.message });
        return;
      }
      const collect = chunk => { output = (output + chunk).slice(-OUTPUT_TAIL); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', error => resolve({ code: -1, output: `${output}${error.message}` }));
      child.on('close', code => resolve({ code, output }));
    });
  }

  // The agent is a LaunchAgent: launchctl returned, but the process may still be
  // failing to start. Ask it, so a half-install shows up in the log now instead
  // of much later as "automatic unlock is not ready".
  async function waitReady(attempts = 3) {
    for (let i = 0; i < attempts; i += 1) {
      if (i) await new Promise(resolve => setTimeout(resolve, 500));
      const ping = await run(bin, ['ping']);
      if (ping.code === 0) return { ready: true };
      if (i === attempts - 1) {
        const tail = ping.output.trim().split('\n').filter(Boolean).pop() || `exit ${ping.code}`;
        return { ready: false, error: tail.slice(0, 200) };
      }
    }
    return { ready: false };
  }

  async function provision(options = {}) {
    let decided;
    let replaced = null;
    try {
      decided = plan(options);
      if (decided.action === 'update') replaced = inspect().replaced;
    } catch (error) {
      return { action: 'skip', reason: 'check-failed', ok: false, error: error.message };
    }
    if (decided.action === 'skip') return { ...decided, ok: true };
    if (replaced) logger.warn(`[multicc-agent] the Agent was replaced by another MultiCC (now ${replaced.app}); upgrading it back`);
    logger.log(`[multicc-agent] ${decided.action} (${decided.reason}) — running install-agent.sh in the background`);
    const result = await run('/bin/sh', [script, 'install']);
    if (result.code === SIGNING_DEFERRED_EXIT) {
      logger.warn('[multicc-agent] signing identity unavailable right now; kept the installed Agent and its grants, will retry at the next start');
      return { ...decided, action: 'skip', reason: 'signing-unavailable', ok: true, replaced };
    }
    if (result.code !== 0) {
      const tail = result.output.trim().split('\n').slice(-3).join(' | ');
      logger.warn(`[multicc-agent] ${decided.action} failed (exit ${result.code}): ${tail}`);
      return { ...decided, ok: false, error: tail };
    }
    logger.log(`[multicc-agent] ${decided.action} done`);
    if (decided.action === 'install') {
      // Put the app into the Accessibility / Screen Recording lists once, so
      // the user only has to flip the switches. Input Monitoring is not
      // requested: it only backs the optional Esc stop, and stopping computer
      // use now uses the chat's stop button instead.
      const asked = await run(bin, ['request-permissions']);
      if (asked.code !== 0) logger.warn(`[multicc-agent] permission request failed: ${asked.output.trim().slice(-200)}`);
    }
    const ready = await waitReady();
    if (!ready.ready) logger.warn(`[multicc-agent] installed but not answering yet: ${ready.error || 'no reply'}`);
    return { ...decided, ok: true, ...ready, replaced };
  }

  // Single-flight; resolves with the outcome, never rejects. replace: true is
  // the user's explicit "use this copy's Agent" for an other-owner conflict.
  function ensure(options = {}) {
    if (!inFlight) {
      inFlight = provision(options)
        .catch(error => ({ action: 'skip', reason: 'unexpected', ok: false, error: error.message }))
        .then(result => { last = { ...result, at: new Date().toISOString() }; inFlight = null; return last; });
    }
    return inFlight;
  }

  return { plan, inspect, ensure, getStatus: () => last };
}

// The server has one provisioner per install root, shared by the startup path
// (skill-sync) and the settings routes, so both see the same last outcome and
// a button press cannot start a second installer next to the startup one.
const shared = new Map();
function sharedMacosAgentProvisioner({ rootDir, logger } = {}) {
  if (!shared.has(rootDir)) shared.set(rootDir, createMacosAgentProvisioner({ rootDir, logger }));
  return shared.get(rootDir);
}

module.exports = { createMacosAgentProvisioner, sharedMacosAgentProvisioner, LABEL, SIGNING_DEFERRED_EXIT };
