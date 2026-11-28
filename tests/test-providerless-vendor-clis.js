'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/native/binding').providersHost;

test('vendor-auth CLIs stay providerless while pool-capable CLIs resolve MultiCC provider pools', () => {
  assert.equal(providers.appTypeForCli('claude'), 'claude');
  assert.equal(providers.appTypeForCli('opencode'), 'claude');
  assert.equal(providers.appTypeForCli('codex'), 'codex');
  assert.equal(providers.appTypeForCli('qoder'), null);
  assert.equal(providers.appTypeForCli('kimi'), null);
  assert.equal(providers.appTypeForCli('codebuddy'), null);
  // DSH speaks Anthropic Messages over DEEPSEEK_BASE_URL, so it joins the
  // claude-side pool (probe-verified 2026-10-15).
  assert.equal(providers.appTypeForCli('dsh'), 'claude');
  // gemini still rides its own vendor account with no MultiCC pool.
  assert.equal(providers.appTypeForCli('gemini'), null);
  // Grok resolves globally by provider id (both messages/responses backends).
  assert.equal(providers.appTypeForCli('grok'), null);
  assert.equal(providers.appTypeForCli('zcode'), null);
  assert.deepEqual(providers.appTypesForCli('qoder'), []);
  assert.deepEqual(providers.appTypesForCli('codebuddy'), []);
  assert.deepEqual(providers.appTypesForCli('dsh'), ['claude']);
  assert.deepEqual(providers.appTypesForCli('gemini'), []);
  assert.deepEqual(providers.appTypesForCli('grok'), ['claude', 'codex']);
  assert.deepEqual(providers.appTypesForCli('zcode'), ['claude', 'codex']);
});

test('stale vendor provider ids cannot silently fall through to another account', () => {
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'qoder', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'codebuddy', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'gemini', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  // Pool-capable CLIs fail closed on a stale binding instead of silently
  // degrading to the vendor's own account.
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'dsh', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'grok', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'zcode', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.buildChildEnv(
      { PATH: '/usr/bin' },
      { cli: 'zcode', provider: 'stale-provider' },
      { MULTICC_SESSION_ID: 'zcode-session' },
    ),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
});

test('host spawn paths apply CLI-specific proxies only after resolving the provider route', () => {
  const root = path.join(__dirname, '..');
  const terminalSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const native = require('../src/native/binding').getNative();
  assert.match(terminalSource, /providerRouterRuntime\.resolveSpawnEnv\(persisted\)/);

  // Execute the actual host adaptation boundaries with inert provider ports.
  // Sharing a provider pool does not make DSH/OpenCode a Claude executable:
  // their generic route materializers must not receive Claude-specific env.
  function boundary(source, begin, end) {
    const first = source.indexOf(begin);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, 'host proxy boundary must remain covered');
    return source.slice(first, last);
  }
  const terminalProxy = new Function('persisted', 'providers', 'termEnv', 'routeSession',
    'PORT', 'CLAUDE_OFFICIAL_VIA_PROXY', boundary(terminalSource,
      "if (persisted.cli === 'claude') {", '// Claude: pre-allocate'));
  function chatProxy(session, providers, route) {
    const afterRoute = new Error('代理配置完成');
    const prepared = { invocation: { cmd: 'test' }, binding: { providerId: 'attempt-provider' },
      proxySessionId: route, invocationEnvelope: { spawnOpts: {}, historyHandle: { isFirstTurn: false } } };
    let resolved = false;
    assert.throws(() => native.chatSpawnProcess({
      env: process.env, getPort: () => 3100, getClaudeOfficialViaProxy: () => true,
      resolveCliRelayTarget: () => null, processSpawnArgs: () => [], claudeSettingsExtra: () => ({}),
      providerRouterRuntime: { buildChildEnv(env, record) {
        assert.equal(record, session); assert.equal(env, process.env); resolved = true; return { env: {} };
      } },
      providers: { ...providers, settingsOverrideFor: () => null,
        applyClaudeProxyEnv(...args) { assert.equal(resolved, true); return providers.applyClaudeProxyEnv(...args); },
        applyCodexProxyConfig(...args) { assert.equal(resolved, true); return providers.applyCodexProxyConfig(...args); } },
      createAdapterCompletion() { throw afterRoute; },
    }, { sessionName: 'logical-session', persisted: session, cs: {}, turn: {}, prepared }), e => e === afterRoute);
    assert.equal(resolved, true);
  }

  for (const cli of ['claude', 'codex', 'claude-exp', 'codex-exp', 'qoder', 'kimi',
    'codebuddy', 'commandcode', 'gemini', 'pi', 'dsh', 'opencode', 'grok', 'zcode']) {
    for (const kind of ['terminal', 'chat']) {
      const calls = [];
      const port = {
        CLAUDE_ROUTING_KEYS: [],
        applyClaudeProxyEnv(_env, options) { calls.push({ protocol: 'claude', ...options }); return true; },
        applyCodexProxyConfig(_env, options) { calls.push({ protocol: 'codex', ...options }); return true; },
        codexProxyConfigRequired() { return true; },
        assertCodexProxyConfigApplied({ required, applied }) { assert.equal(required && applied, true); },
      };
      const session = { cli, provider: 'managed-provider', cliSessionId: 'native-session' };
      const route = 'session-capability';
      if (kind === 'terminal') terminalProxy(session, port, {}, route, 3100, true);
      else chatProxy(session, port, route);
      const protocol = cli === 'claude' || (kind === 'chat' && cli === 'claude-exp') ? 'claude'
        : cli === 'codex' || (kind === 'chat' && cli === 'codex-exp') ? 'codex' : null;
      assert.deepEqual(calls.map(call => call.protocol), protocol ? [protocol] : [], `${kind}:${cli}`);
      if (protocol) {
        assert.equal(calls[0].sessionId, route, 'proxy keeps the session capability rather than a bare id');
        assert.equal(calls[0].providerId, kind === 'terminal' ? session.provider : 'attempt-provider');
      }
    }
  }
  {
    const source = terminalSource;
    assert.doesNotMatch(source, /persisted\.cli !== 'qoder'\)\s*providers\.applyClaudeProxyEnv/);
    assert.doesNotMatch(source, /persisted\.cli !== 'codex' && persisted\.cli !== 'qoder'/);
  }
});

test('vendor login flows map each vendor-auth CLI to a whitelisted login terminal spec', () => {
  const { VENDOR_LOGIN, vendorLoginForCli, cliForLoginFlow, vendorLoginTerminalCmd } = require('../src/native/binding').getVendorLogin();
  assert.deepEqual(Object.keys(VENDOR_LOGIN).sort(), ['agy', 'codebuddy', 'commandcode', 'qoder']);
  assert.equal(vendorLoginForCli('codebuddy').loginFlow, 'codebuddy-login');
  assert.equal(vendorLoginForCli('codebuddy').label, 'WorkBuddy');
  assert.equal(vendorLoginForCli('qoder').loginFlow, 'qoder-login');
  assert.equal(vendorLoginForCli(' CodeBuddy '), VENDOR_LOGIN.codebuddy, 'cli matching is case/space tolerant');
  assert.equal(vendorLoginForCli('claude'), null);
  assert.equal(vendorLoginForCli('dsh'), null, 'dsh uses DEEPSEEK_API_KEY, not TUI login');
  assert.equal(cliForLoginFlow('codebuddy-login'), 'codebuddy');
  assert.equal(cliForLoginFlow('qoder-login'), 'qoder');
  assert.equal(cliForLoginFlow('commandcode-login'), 'commandcode');
  assert.equal(vendorLoginForCli('commandcode').autoStart, true);
  assert.equal(vendorLoginTerminalCmd('commandcode-login', { commandcode: '/a path/command-code' }), "'/a path/command-code' login --no-auto-update");
  assert.equal(vendorLoginForCli('agy').loginFlow, 'agy-login');
  assert.equal(vendorLoginForCli('agy').loginCommand, 'agy', 'agy has no login subcommand; the TUI is the command');
  assert.equal(cliForLoginFlow('agy-login'), 'agy');
  assert.equal(vendorLoginTerminalCmd('agy-login', { agy: '/a path/agy' }), '/a path/agy',
    'the agy login terminal launches the bare binary on the pinned account HOME');
  assert.equal(cliForLoginFlow('codex-login'), null, 'codex/claude login flows stay hardcoded in create-record');
  assert.equal(cliForLoginFlow('bogus'), null);
});


test('原生登录目录与旧 JS 的顺序、冻结对象和终端命令一致', () => {
  const old = require('./helpers/legacy-session-routes/vendor-login');
  const api = require('../src/native/binding').getVendorLogin();
  assert.deepEqual(Object.entries(api.VENDOR_LOGIN), Object.entries(old.VENDOR_LOGIN));
  assert.ok(Object.isFrozen(api.VENDOR_LOGIN));
  for (const [cli, spec] of Object.entries(api.VENDOR_LOGIN)) {
    assert.ok(Object.isFrozen(spec));
    assert.equal(api.vendorLoginForCli('  ' + cli.toUpperCase() + '  '), spec);
    assert.equal(api.cliForLoginFlow(' ' + spec.loginFlow + ' '), cli);
    for (const binary of [null, '', "/opt/a b'c", '\ud800end', '工具']) {
      const commands = { [cli]: binary };
      assert.equal(api.terminalLoginCommand(spec.loginFlow, commands), old.vendorLoginTerminalCmd(spec.loginFlow, commands));
    }
  }
  assert.equal(api.terminalLoginCommand('codex-login', { codex: 'my-codex' }), 'my-codex login');
  assert.equal(api.terminalLoginCommand('claude-auth-login', { claude: 'my-claude' }), 'my-claude auth login');
  assert.equal(api.terminalLoginCommand('regular', {}), null);
});

test('Pi local credentials do not acquire a MultiCC provider route', () => {
  assert.equal(providers.appTypeForCli('pi'), null);
  assert.deepEqual(providers.appTypesForCli('pi'), []);
  assert.equal(providers.providerSupportsCli({ apiFormat: 'anthropic' }, 'pi'), false);
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'pi', provider: 'stale-provider' }).env, {});
  const base = { PI_CODING_AGENT_DIR: '/pi-config', OPENAI_API_KEY: 'fixture-local-key' };
  assert.deepEqual(providers.buildChildEnv(base, { cli: 'pi' }).env, base);
});

test('DSH 的直接构造入口只读取 Anthropic 环境凭据', () => {
  const provider = {
    id: 'cross-pool', name: '跨池测试', appType: 'codex',
    settingsConfig: { auth: { OPENAI_API_KEY: 'fixture-codex' }, config: 'base_url = "https://example.test/v1"' },
  };
  assert.throws(() => providers.buildDshRoute(provider, { id: 'session' }), /DSH Provider 缺少可用的 API Key/);
  provider.settingsConfig.env = { ANTHROPIC_API_KEY: 'fixture-dsh', ANTHROPIC_BASE_URL: 'https://dsh.test' };
  assert.deepEqual(providers.buildDshRoute(provider, { id: 'session' }).env,
    { DEEPSEEK_API_KEY: 'fixture-dsh', DEEPSEEK_BASE_URL: 'https://dsh.test' });
});
