'use strict';

const path = require('path');
const fs = require('fs');

const ROUTER_ENV_KEYS = [
  'MULTICC_SESSION_ID',
  'MULTICC_BASE_URL',
  'MULTICC_TURN_ID',
  'MULTICC_ORIGIN_DISPATCH_ID',
  'MULTICC_ROUTER_CAPABILITY',
];

function stdioServer(node, script) {
  return {
    command: String(node),
    args: [String(script)],
  };
}

// The official ZCode engine neither reads ZCODE_CONFIG_CONTENT nor inherits
// arbitrary MULTICC_* variables into stdio MCP children (it rebuilds the child
// environment from a HOME/PATH/USER/... whitelist plus the entry's own env),
// so the router credentials must be embedded in a config file the engine
// actually loads. Workspace scope keeps the per-spawn capability token out of
// the shared user config; each session directory therefore gets its own entry.
function writeZcodeWorkspaceMcp(cwd, node, script, env) {
  if (!cwd || !env.MULTICC_BASE_URL || !env.MULTICC_ROUTER_CAPABILITY) return;
  try {
    const dir = path.join(String(cwd), '.zcode');
    const configPath = path.join(dir, 'config.json');
    let existing = {};
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (_) {
        // An existing project config we cannot parse must not be clobbered;
        // this turn simply runs without the router tools.
        return;
      }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    }
    const routerEnv = {};
    for (const key of ROUTER_ENV_KEYS) {
      if (env[key]) routerEnv[key] = String(env[key]);
    }
    existing.mcp = { ...(existing.mcp || {}) };
    existing.mcp.servers = {
      ...(existing.mcp.servers || {}),
      multicc_router: {
        type: 'stdio',
        ...stdioServer(node, script),
        env: routerEnv,
      },
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (_) { /* best effort — MCP injection failure should not crash the turn */ }
}

function claudeLikeMcpArgs(node, script) {
  if (!node || !script) return [];
  const config = JSON.stringify({
    mcpServers: { multicc_router: stdioServer(node, script) },
  });
  return ['--mcp-config', config];
}

function mergeJson(raw, patch) {
  let value = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch (_) { /* invalid vendor config remains isolated to the child */ }
  }
  return patch(value);
}

function applyRouterMcpEnv(env, cli, node, script, options = {}) {
  if (!env || !node || !script) return env;
  const command = [String(node), String(script)];
  if (cli === 'opencode' || cli === 'zcode') {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(mergeJson(
      env.OPENCODE_CONFIG_CONTENT,
      source => ({
        ...source,
        mcp: {
          ...(source.mcp || {}),
          multicc_router: {
            type: 'local',
            command,
            enabled: true,
            timeout: 10000,
          },
        },
      }),
    ));
  }
  if (cli === 'zcode') {
    env.ZCODE_CONFIG_CONTENT = JSON.stringify(mergeJson(
      env.ZCODE_CONFIG_CONTENT,
      source => ({
        ...source,
        mcp: {
          ...(source.mcp || {}),
          servers: {
            ...(source.mcp?.servers || {}),
            multicc_router: {
              command: String(node),
              args: [String(script)],
              env: {},
            },
          },
        },
      }),
    ));
    writeZcodeWorkspaceMcp(options.cwd, node, script, env);
  }
  if (cli === 'kimi' && env.KIMI_CODE_HOME) {
    // Kimi Code reads MCP servers from its settings.json or mcp.json under
    // KIMI_CODE_HOME. Write a minimal mcp.json so the spawned child can see
    // the multicc_router tool server. Non-destructive: only sets the one key.
    try {
      const mcpDir = env.KIMI_CODE_HOME;
      if (mcpDir && typeof mcpDir === 'string') {
        fs.mkdirSync(mcpDir, { recursive: true });
        const mcpPath = path.join(mcpDir, 'mcp.json');
        let existing = {};
        try {
          const raw = fs.readFileSync(mcpPath, 'utf8');
          existing = JSON.parse(raw);
          if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
        } catch (_) { /* no existing mcp.json — start fresh */ }
        existing.multicc_router = {
          command: String(node),
          args: [String(script)],
          env: {},
        };
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2), 'utf8');
      }
    } catch (_) { /* best effort — MCP injection failure should not crash the turn */ }
  }
  return env;
}

module.exports = {
  applyRouterMcpEnv,
  claudeLikeMcpArgs,
  stdioServer,
};
