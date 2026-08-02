'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AGENT_COMMANDER_PRESET_ID,
  COMMANDER_ROUTER_PROMPT,
  createAgentResourcesRoutes,
} = require('../src/routes/agent-resources');

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

async function invoke(app, method, route, { params = {}, query = {} } = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ params, query }, response);
  return response;
}

function fixture(options = {}) {
  const presets = options.presets || {
    source: 'fixture',
    version: 2,
    generatedAt: '2026-01-01',
    categories: ['specialized'],
    featured: [AGENT_COMMANDER_PRESET_ID],
    presets: [
      {
        id: AGENT_COMMANDER_PRESET_ID,
        prompt: 'command the fleet',
        defaultCli: 'codex',
        defaultProviderKey: 'openai-codex',
      },
      {
        id: 'xf',
        prompt: 'use maas',
        defaultCli: 'claude',
        defaultProviderKey: 'xf-maas-coding',
        defaultModel: 'spark-code',
      },
    ],
  };
  let reads = 0;
  const removals = [];
  const reportedErrors = [];
  const histories = options.histories || [];
  const service = createAgentResourcesRoutes({
    fs: {
      readFileSync() {
        reads += 1;
        if (options.readError) throw options.readError;
        return JSON.stringify(presets);
      },
    },
    presetsFile: '/runtime/agent-presets.json',
    providers: {
      listProviders(cli) {
        if (options.providerLists) return options.providerLists[cli] || [];
        return cli === 'claude'
          ? [
            { id: 'xf-name', name: '讯飞 MaaS', modelOptions: [] },
            { id: 'xf-model', name: 'Relay', modelOptions: ['spark-code'] },
          ]
          : [
            { id: 'official', name: 'OpenAI Codex 官方', modelOptions: ['gpt-5.5'] },
          ];
      },
    },
    providerRouter: {
      getProviderSummary(cli, id) {
        return options.providerSummary ? options.providerSummary(cli, id) : { id, cli, name: `summary:${id}` };
      },
    },
    listInstalledSkills: () => options.skills || [],
    listClaudeHistory: () => histories,
    removeClaudeHistorySession(project, id) {
      removals.push({ project, id });
      if (options.remove) return options.remove(project, id);
      return { ok: true, freed: 10 };
    },
    reportError(error, fields) { reportedErrors.push({ error, fields }); },
    now: options.now || (() => Date.parse('2026-01-10T00:00:00Z')),
  });
  const app = fakeApp();
  service.mountRoutes(app);
  return { app, presets, reads: () => reads, removals, reportedErrors, service };
}

test('dependency and mount boundaries fail closed and own the complete route surface', () => {
  assert.throws(() => createAgentResourcesRoutes({}), /preset storage/);
  const current = fixture();
  assert.deepEqual([...current.app.routes.keys()].sort(), [
    'DELETE /api/agent-resources/claude-sessions',
    'DELETE /api/agent-resources/claude-sessions/:project/:id',
    'GET /api/agent-presets',
    'GET /api/agent-presets/:id',
    'GET /api/agent-resources/claude-sessions',
    'GET /api/agent-resources/skills',
  ]);
  assert.throws(() => current.service.mountRoutes(current.app), /already mounted/);
});

test('preset cache and commander prompt preserve provider default resolution', async () => {
  const current = fixture();
  assert.equal(current.service.agentCommanderPrompt(), COMMANDER_ROUTER_PROMPT);
  assert.equal(current.reads(), 1);
  assert.equal(current.service.agentCommanderPreset().id, AGENT_COMMANDER_PRESET_ID);
  assert.equal(current.service.agentPreset('xf').id, 'xf');
  assert.equal(current.service.agentPreset('missing'), null);
  assert.equal(current.service.agentCommanderPrompt(), COMMANDER_ROUTER_PROMPT);
  assert.equal(current.reads(), 1);
  const commander = await invoke(current.app, 'GET', '/api/agent-presets/:id', {
    params: { id: AGENT_COMMANDER_PRESET_ID },
  });
  assert.equal(commander.body.defaultProviderId, 'official');
  const xf = await invoke(current.app, 'GET', '/api/agent-presets/:id', { params: { id: 'xf' } });
  assert.equal(xf.body.defaultProviderId, 'xf-model');
  assert.equal(xf.body.defaultProviderName, 'summary:xf-model');
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /commanderPrompt: agentCommanderPrompt/);
  assert.match(server, /createCommanderMigrationHost\([\s\S]*?createSessionRecord/);
  assert.doesNotMatch(server, /r\.session\.rolePrompt = commander\.prompt/);
  const migration = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'commander-migration.js'), 'utf8');
  assert.doesNotMatch(migration, /isTrustedLegacyCommander|isExactLegacyCommanderLabel|hasLegacyCommanderPromptSignature|stampSession/,
    'migration recognizes only stable type metadata and never stamps an untyped session');
});

test('preset list strips prompts while detail preserves them and returns legacy errors', async () => {
  const current = fixture();
  const list = await invoke(current.app, 'GET', '/api/agent-presets');
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.source, 'fixture');
  assert.equal(list.body.presets.length, 2);
  assert.equal(Object.hasOwn(list.body.presets[0], 'prompt'), false);
  assert.equal(list.body.presets[0].defaultProviderId, 'official');
  const detail = await invoke(current.app, 'GET', '/api/agent-presets/:id', {
    params: { id: AGENT_COMMANDER_PRESET_ID },
  });
  assert.equal(detail.body.prompt, COMMANDER_ROUTER_PROMPT);
  assert.match(detail.body.description, /Route-first/);
  assert.match(detail.body.prompt, /不是强制 route-only/);
  assert.match(detail.body.prompt, /跨 session 派发的【唯一通道】是 MCP/);
  assert.match(detail.body.prompt, /dispatch_master 的两种回执模式/);
  assert.match(detail.body.prompt, /不要输出 <<route>> 或 <<dispatch>>/);
  assert.match(detail.body.prompt, /routingState="waiting_user"/);
  assert.match(detail.body.prompt, /相关性相近时优先选择非 waiting_user/);
  assert.match(detail.body.prompt, /相关性明显更高时仍可选择/);
  assert.match(detail.body.prompt, /列表顺序不表示优先级/);
  assert.equal(current.reads(), 1);
  const missing = await invoke(current.app, 'GET', '/api/agent-presets/:id', {
    params: { id: 'missing' },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { error: 'not found' });
});

test('provider fallback keeps model and name priority plus id name fallback', async () => {
  const current = fixture({
    presets: {
      presets: [
        { id: 'openai', defaultProviderKey: 'OPENAI-CODEX', defaultCli: 'codex' },
        { id: 'xf', defaultProviderKey: 'XF-MAAS-CODING', defaultCli: 'claude', defaultModel: 'missing' },
      ],
    },
    providerLists: {
      codex: [
        { id: 'other', name: 'Relay', modelOptions: [] },
        { id: 'gpt', name: 'Generic', modelOptions: ['gpt-next'] },
      ],
      claude: [
        { id: 'xf-name', name: 'XF MaaS', modelOptions: [] },
      ],
    },
    providerSummary: () => null,
  });
  const openai = await invoke(current.app, 'GET', '/api/agent-presets/:id', { params: { id: 'openai' } });
  assert.equal(openai.body.defaultProviderId, 'gpt');
  assert.equal(openai.body.defaultProviderName, 'gpt');
  const xf = await invoke(current.app, 'GET', '/api/agent-presets/:id', { params: { id: 'xf' } });
  assert.equal(xf.body.defaultProviderId, 'xf-name');
});

test('preset read failure is cached and preserves the unavailable response', async () => {
  const current = fixture({ readError: new Error('disk failed') });
  for (let index = 0; index < 2; index += 1) {
    const response = await invoke(current.app, 'GET', '/api/agent-presets');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'agent presets unavailable' });
  }
  assert.equal(current.reads(), 1);
  assert.equal(current.service.agentCommanderPrompt(), null);
});

test('skills and Claude history summaries preserve counts and sizes', async () => {
  const histories = [
    { id: 'a', project: 'p', size: 10, linked: true },
    { id: 'b', project: 'p', size: 25, linked: false },
  ];
  const current = fixture({
    skills: [
      { name: 'a', provider: 'claude' },
      { name: 'b', provider: 'claude' },
      { name: 'c', provider: 'codex' },
      { name: 'd', provider: 'other' },
    ],
    histories,
  });
  const skills = await invoke(current.app, 'GET', '/api/agent-resources/skills');
  assert.deepEqual(skills.body.counts, { claude: 2, codex: 1 });
  const history = await invoke(current.app, 'GET', '/api/agent-resources/claude-sessions');
  assert.deepEqual(history.body, {
    sessions: histories,
    count: 2,
    totalSize: 35,
    protectedCount: 1,
  });
});

test('single history delete maps protected, missing, success and thrown results', async () => {
  for (const [result, status] of [
    [{ ok: false, error: 'protected linked session' }, 409],
    [{ ok: false, error: 'not found' }, 404],
    [{ ok: true, freed: 12 }, 200],
  ]) {
    const current = fixture({ remove: () => result });
    const response = await invoke(current.app, 'DELETE', '/api/agent-resources/claude-sessions/:project/:id', {
      params: { project: 'p', id: 's' },
    });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.body, result.ok ? result : { error: result.error });
  }
  const thrown = fixture({ remove: () => { throw new Error('cleanup failed'); } });
  const response = await invoke(thrown.app, 'DELETE', '/api/agent-resources/claude-sessions/:project/:id', {
    params: { project: 'p', id: 's' },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'history delete failed' });
  assert.equal(JSON.stringify(response.body).includes('cleanup failed'), false);
  assert.equal(thrown.reportedErrors.length, 1);
});

test('bulk cleanup validates age and skips linked, recent and failed histories', async () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const histories = [
    { id: 'linked', project: 'p', size: 1, linked: true, updatedAt: '2025-01-01' },
    { id: 'recent', project: 'p', size: 2, linked: false, updatedAt: '2026-01-09' },
    { id: 'cutoff', project: 'p', size: 2, linked: false, updatedAt: '2026-01-03' },
    { id: 'old-ok', project: 'p', size: 3, linked: false, updatedAt: '2025-12-01' },
    { id: 'old-no', project: 'p', size: 4, linked: false, updatedAt: '2025-12-02' },
    { id: 'old-throw', project: 'p', size: 5, linked: false, updatedAt: '2025-12-03' },
    { id: 'invalid-date', project: 'p', size: 6, linked: false, updatedAt: 'not-a-date' },
  ];
  const current = fixture({
    histories,
    now: () => now,
    remove(project, id) {
      if (id === 'old-ok') return { ok: true, freed: 33 };
      if (id === 'old-throw') throw new Error('ignored');
      return { ok: false, error: 'not found' };
    },
  });
  for (const value of [undefined, '0', 'nan']) {
    const invalid = await invoke(current.app, 'DELETE', '/api/agent-resources/claude-sessions', {
      query: { olderThanDays: value },
    });
    assert.equal(invalid.statusCode, 400);
  }
  const response = await invoke(current.app, 'DELETE', '/api/agent-resources/claude-sessions', {
    query: { olderThanDays: '7' },
  });
  assert.deepEqual(response.body, { ok: true, deleted: 1, freed: 33 });
  assert.deepEqual(current.removals.map(item => item.id), ['old-ok', 'old-no', 'old-throw']);
});
