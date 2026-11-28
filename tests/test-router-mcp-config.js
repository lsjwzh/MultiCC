'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyRouterMcpEnv,
  claudeLikeMcpArgs,
} = require('../src/native/binding').routerMcp;

function tempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-mcp-'));
}

function readWorkspaceConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.zcode', 'config.json'), 'utf8'));
}

test('Kimi 保留已有工具和 null 配置，损坏的 JSON 从空配置恢复', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-kimi-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp.json');
  const env = { KIMI_CODE_HOME: dir };
  const entry = { command: '/opt/node', args: ['/opt/router.js'], env: {} };
  for (const [input, expected] of [
    ['null', null],
    ['{bad', { multicc_router: entry }],
    ['{"other":{"args":[]}}', { other: { args: [] }, multicc_router: entry }],
  ]) {
    fs.writeFileSync(file, input);
    const conversions = [];
    const node = { toString() { conversions.push('node'); return '/opt/node'; } };
    const script = { toString() { conversions.push('script'); return '/opt/router.js'; } };
    assert.strictEqual(applyRouterMcpEnv(env, 'kimi', node, script), env);
    assert.deepEqual(conversions, ['node', 'script', 'node', 'script']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
  }
});

test('路由环境通过原对象的 setter 写入，其他 CLI 也保留命令的字符串转换异常', () => {
  let content;
  const env = {
    get OPENCODE_CONFIG_CONTENT() { return '{"mcp":{"other":{}}}'; },
    set OPENCODE_CONFIG_CONTENT(value) { content = JSON.parse(value); },
  };
  assert.strictEqual(applyRouterMcpEnv(env, 'opencode', 'node', 'router'), env);
  assert.deepEqual(Object.keys(content.mcp), ['other', 'multicc_router']);
  const failure = new Error('无法转换命令');
  const node = { toString() { throw failure; } };
  assert.throws(() => applyRouterMcpEnv({}, 'unknown', node, 'router'), error => error === failure);
});

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

test('Antigravity MCP config merges multicc_router into HOME without persisting secrets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-agy-mcp-'));
  const cfgPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    mcpServers: { user_tool: { command: 'uvx', args: ['mcp-server'] } },
  }), 'utf8');
  const env = {
    HOME: home,
    MULTICC_SESSION_ID: 'sess-agy',
    MULTICC_ROUTER_CAPABILITY: 'secret-token-must-not-be-written',
  };
  applyRouterMcpEnv(env, 'agy', '/opt/node', '/opt/router.js');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(!raw.includes('secret-token-must-not-be-written'), 'per-turn capability token must not be written to disk');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.mcpServers.user_tool, { command: 'uvx', args: ['mcp-server'] });
  assert.deepEqual(parsed.mcpServers.multicc_router, { command: '/opt/node', args: ['/opt/router.js'] });
  fs.rmSync(home, { recursive: true, force: true });
});
