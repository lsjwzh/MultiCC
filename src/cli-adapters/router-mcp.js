'use strict';

function stdioServer(node, script) {
  return {
    command: String(node),
    args: [String(script)],
  };
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

function applyRouterMcpEnv(env, cli, node, script) {
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
  }
  return env;
}

module.exports = {
  applyRouterMcpEnv,
  claudeLikeMcpArgs,
  stdioServer,
};
