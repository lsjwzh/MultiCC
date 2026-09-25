'use strict';

// Keeps the optional MultiCC Agent (scripts/install-agent.sh) installed and
// current, so installing or updating MultiCC is the only step a user takes:
// every server start compares the installed agent with the shipped source and
// runs the installer in the background when they differ.
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

const LABEL = 'com.multicc.agent';
const OUTPUT_TAIL = 4000;

function createMacosAgentProvisioner(deps = {}) {
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  const os = deps.os || require('os');
  const crypto = deps.crypto || require('crypto');
  const spawn = deps.spawn || require('child_process').spawn;
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const rootDir = deps.rootDir;
  const home = deps.home || os.homedir();

  const script = path.join(rootDir, 'scripts', 'install-agent.sh');
  const source = path.join(rootDir, 'scripts', 'macos-agent', 'MultiCCAgent.swift');
  const app = env.MULTICC_AGENT_APP || path.join(home, 'Applications', 'MultiCC Agent.app');
  const bin = path.join(app, 'Contents', 'MacOS', 'MultiCCAgent');
  const stamp = path.join(app, 'Contents', 'Resources', 'source.sha256');
  const plist = env.MULTICC_AGENT_PLIST || path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const agentDir = env.MULTICC_AGENT_DIR || path.join(home, '.multicc', 'agent');

  let inFlight = null;
  let last = null;

  const exists = p => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
  const readTrim = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; } };

  // { action: 'skip' | 'install' | 'update', reason }
  function plan() {
    if (platform !== 'darwin') return { action: 'skip', reason: 'not-macos' };
    if (env.MULTICC_AGENT_AUTO_INSTALL === '0') return { action: 'skip', reason: 'disabled-by-env' };
    if (!exists(script) || !exists(source)) return { action: 'skip', reason: 'installer-not-shipped' };
    if (exists(path.join(agentDir, 'auto-install-disabled'))) return { action: 'skip', reason: 'uninstalled-by-user' };
    if (!exists(bin)) return { action: 'install', reason: 'not-installed' };
    const sum = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (readTrim(stamp) !== sum) return { action: 'update', reason: 'source-changed' };
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

  async function provision() {
    let decided;
    try {
      decided = plan();
    } catch (error) {
      return { action: 'skip', reason: 'check-failed', ok: false, error: error.message };
    }
    if (decided.action === 'skip') return { ...decided, ok: true };
    logger.log(`[multicc-agent] ${decided.action} (${decided.reason}) — running install-agent.sh in the background`);
    const result = await run('/bin/sh', [script, 'install']);
    if (result.code !== 0) {
      const tail = result.output.trim().split('\n').slice(-3).join(' | ');
      logger.warn(`[multicc-agent] ${decided.action} failed (exit ${result.code}): ${tail}`);
      return { ...decided, ok: false, error: tail };
    }
    logger.log(`[multicc-agent] ${decided.action} done`);
    if (decided.action === 'install') {
      // Put the app into the Accessibility / Screen Recording / Input
      // Monitoring lists once, so the user only has to flip the switches.
      const asked = await run(bin, ['request-permissions']);
      if (asked.code !== 0) logger.warn(`[multicc-agent] permission request failed: ${asked.output.trim().slice(-200)}`);
    }
    return { ...decided, ok: true };
  }

  // Single-flight; resolves with the outcome, never rejects.
  function ensure() {
    if (!inFlight) {
      inFlight = provision()
        .catch(error => ({ action: 'skip', reason: 'unexpected', ok: false, error: error.message }))
        .then(result => { last = { ...result, at: new Date().toISOString() }; inFlight = null; return last; });
    }
    return inFlight;
  }

  return { plan, ensure, getStatus: () => last };
}

module.exports = { createMacosAgentProvisioner, LABEL };
