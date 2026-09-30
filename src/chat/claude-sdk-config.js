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

function processOptions(cfg, started, relayEnv) {
  const input = cfg.sdkOptions;
  const env = { ...cfg.env, ...relayEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'multicc-claude-exp/1.0',
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' };
  const settings = settingsFor(cfg);
  // Use a private file: SDK serializes object settings into argv, which would
  // expose credentials in ps. Never rewrite the host's shared settings file.
  settings.env = { ...settings.env };
  for (const [key, value] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)) settings.env[key] = value;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-sdk-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  const options = {
    cwd: cfg.cwd, env, includePartialMessages: true,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    settings: file,
    ...(started ? { resume: cfg.sessionId } : { sessionId: cfg.sessionId }),
  };
  for (const key of ['model', 'effort', 'agent', 'maxTurns']) if (input[key]) options[key] = input[key];
  if (input.systemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: input.systemPrompt };
  if (input.disallowedTools?.length) options.disallowedTools = input.disallowedTools;
  if (input.routerNode && input.routerScript) options.mcpServers = {
    multicc_router: { command: input.routerNode, args: [input.routerScript] },
  };
  return { options, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { fingerprint, processOptions };
