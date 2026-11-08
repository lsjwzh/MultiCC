'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { managedRoute } = require('./claude-sdk-route');

function settingsFor(cfg) {
  return cfg.settingsFile ? JSON.parse(fs.readFileSync(cfg.settingsFile, 'utf8')) : {};
}

function fingerprint(cfg) {
  const { model, ...options } = cfg.sdkOptions;
  const route = managedRoute(cfg.env);
  const settings = settingsFor(cfg);
  const env = { ...settings.env, ...cfg.env };
  const keys = Object.keys(env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|HOME$)/.test(k)).sort();
  const stable = {};
  for (const key of keys) {
    if (route && ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(key)) continue;
    stable[key] = env[key];
  }
  delete settings.env;
  return createHash('sha256').update(JSON.stringify({ cwd: cfg.cwd, sessionId: cfg.sessionId,
    route: route?.identity, env: stable, options, settings })).digest('hex');
}

// Materialize the option set the old `@anthropic-ai/claude-agent-sdk` transport
// received into the flat shape `RustClaudeLane.start()` expects. The native
// kernel owns argv/env/settings assembly (see native/core/src/claude_lane.rs),
// so this only names the same inputs.
function laneOptions(cfg, started, relayEnv) {
  const input = cfg.sdkOptions;
  const env = { ...cfg.env, ...relayEnv };
  const settings = settingsFor(cfg);
  // Use a private file: credentials travel through this 0600 file, never argv.
  // The native lane writes it immediately before spawn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sdk-'));
  fs.chmodSync(dir, 0o700);
  const settingsPath = path.join(dir, 'settings.json');
  const config = {
    cwd: cfg.cwd,
    env,
    settings,
    settingsPath,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    sessionId: cfg.sessionId,
    hookCallback: !!cfg.onBackgroundEvent,
    ...(started ? { resume: true } : {}),
  };
  for (const key of ['model', 'effort', 'agent', 'maxTurns']) if (input[key]) config[key] = input[key];
  if (Number.isFinite(cfg.initializeTimeoutMs)) config.initializeTimeoutMs = cfg.initializeTimeoutMs;
  if (input.systemPrompt) config.systemPromptAppend = input.systemPrompt;
  if (input.disallowedTools?.length) config.disallowedTools = input.disallowedTools;
  if (input.routerNode && input.routerScript) config.mcpServers = {
    multicc_router: { command: input.routerNode, args: [input.routerScript] },
  };
  return { config, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { fingerprint, laneOptions };
