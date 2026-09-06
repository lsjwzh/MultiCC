'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyRouterMcpEnv,
  claudeLikeMcpArgs,
} = require('../src/cli-adapters/router-mcp');

function tempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-mcp-'));
}

function readWorkspaceConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.zcode', 'config.json'), 'utf8'));
}

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

test('ZCode workspace config embeds router env for the engine env whitelist', () => {
  const dir = tempProjectDir();
  const env = {
    MULTICC_SESSION_ID: 'sess-1',
    MULTICC_BASE_URL: 'http://127.0.0.1:3000',
    MULTICC_TURN_ID: 'turn-1',
    MULTICC_ROUTER_CAPABILITY: 'tok-1',
  };
  applyRouterMcpEnv(env, 'zcode', '/opt/node', '/opt/router.js', { cwd: dir });
  assert.deepEqual(readWorkspaceConfig(dir).mcp.servers.multicc_router, {
    type: 'stdio',
    command: '/opt/node',
    args: ['/opt/router.js'],
    env: {
      MULTICC_SESSION_ID: 'sess-1',
      MULTICC_BASE_URL: 'http://127.0.0.1:3000',
      MULTICC_TURN_ID: 'turn-1',
      MULTICC_ROUTER_CAPABILITY: 'tok-1',
    },
  });
});

test('ZCode workspace config preserves unrelated project settings', () => {
  const dir = tempProjectDir();
  const configPath = path.join(dir, '.zcode', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    model: 'zai/glm-5.2',
    mcp: { servers: { other: { command: '/opt/other' } } },
  }), 'utf8');
  const env = {
    MULTICC_BASE_URL: 'http://127.0.0.1:3000',
    MULTICC_ROUTER_CAPABILITY: 'tok-2',
  };
  applyRouterMcpEnv(env, 'zcode', '/opt/node', '/opt/router.js', { cwd: dir });
  const config = readWorkspaceConfig(dir);
  assert.equal(config.model, 'zai/glm-5.2');
  assert.deepEqual(config.mcp.servers.other, { command: '/opt/other' });
  assert.equal(config.mcp.servers.multicc_router.env.MULTICC_ROUTER_CAPABILITY, 'tok-2');
});

test('ZCode workspace config is skipped without cwd or router credentials', () => {
  const withoutCwd = {
    MULTICC_BASE_URL: 'http://127.0.0.1:3000',
    MULTICC_ROUTER_CAPABILITY: 'tok-3',
  };
  applyRouterMcpEnv(withoutCwd, 'zcode', '/opt/node', '/opt/router.js');
  const noCredentialsDir = tempProjectDir();
  applyRouterMcpEnv({}, 'zcode', '/opt/node', '/opt/router.js', { cwd: noCredentialsDir });
  assert.equal(fs.existsSync(path.join(noCredentialsDir, '.zcode', 'config.json')), false);
  const malformed = tempProjectDir();
  const configPath = path.join(malformed, '.zcode', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{not json', 'utf8');
  applyRouterMcpEnv({
    MULTICC_BASE_URL: 'http://127.0.0.1:3000',
    MULTICC_ROUTER_CAPABILITY: 'tok-4',
  }, 'zcode', '/opt/node', '/opt/router.js', { cwd: malformed });
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{not json');
});
