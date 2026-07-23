'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyRouterMcpEnv,
  claudeLikeMcpArgs,
} = require('../src/cli-adapters/router-mcp');

test('Claude/Qoder receive an isolated inline stdio MCP config', () => {
  const args = claudeLikeMcpArgs('/opt/node', '/opt/router.js');
  assert.equal(args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(args[1]), {
    mcpServers: {
      multicc_router: {
        command: '/opt/node',
        args: ['/opt/router.js'],
      },
    },
  });
});

test('OpenCode runtime MCP config preserves existing inline settings', () => {
  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      username: 'test',
      mcp: { existing: { type: 'remote', url: 'https://example.invalid/mcp' } },
    }),
  };
  applyRouterMcpEnv(env, 'opencode', '/opt/node', '/opt/router.js');
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.username, 'test');
  assert.equal(config.mcp.existing.type, 'remote');
  assert.deepEqual(config.mcp.multicc_router.command, ['/opt/node', '/opt/router.js']);
  assert.equal(config.mcp.multicc_router.type, 'local');
});

test('ZCode receives native and OpenCode-compatible runtime MCP shapes', () => {
  const env = {};
  applyRouterMcpEnv(env, 'zcode', '/opt/node', '/opt/router.js');
  const compatible = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  const native = JSON.parse(env.ZCODE_CONFIG_CONTENT);
  assert.deepEqual(compatible.mcp.multicc_router.command, ['/opt/node', '/opt/router.js']);
  assert.deepEqual(native.mcp.servers.multicc_router, {
    command: '/opt/node',
    args: ['/opt/router.js'],
    env: {},
  });
});
