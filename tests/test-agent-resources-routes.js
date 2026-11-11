'use strict';

// Agent presets / skills / Claude history runtime.
//
// The 6 public routes now live in the Rust front door
// (native/gateway/src/app/agent_resources.rs; byte-level integration tests in
// native/gateway/tests/agent_resources.rs). What remains in Node is the presets
// file cache, the Agent Commander override, provider enrichment and the Claude
// history filesystem operations. This file asserts exactly that surface; the
// host contract is covered by tests/test-agent-resources-host.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AGENT_COMMANDER_PRESET_ID,
  COMMANDER_ROUTER_PROMPT,
  createAgentResourcesRuntime,
} = require('../src/routes/agent-resources');

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
  const runtime = createAgentResourcesRuntime({
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
  });
  return { runtime, presets, reads: () => reads, removals, reportedErrors };
}

test('the runtime fails closed and exposes only the host-port operations', () => {
  assert.throws(() => createAgentResourcesRuntime({}), /preset storage/);
  const { runtime } = fixture();
  for (const name of [
    'agentPreset', 'agentCommanderPreset', 'agentCommanderPrompt',
    'installedSkills', 'presetsList', 'presetLookup', 'claudeSessions', 'removeClaudeSession',
  ]) {
    assert.equal(typeof runtime[name], 'function', name);
  }
  assert.equal(Object.isFrozen(runtime), true);
});

test('no http route surface is left in the Node module', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'routes', 'agent-resources.js'), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /app\.(?:get|delete|post)\(/);
  assert.doesNotMatch(code, /\/api\/agent-(?:presets|resources)/);
  assert.doesNotMatch(code, /mountRoutes/);
});

test('preset cache and commander prompt preserve provider default resolution', () => {
  const current = fixture();
  assert.equal(current.runtime.agentCommanderPrompt(), COMMANDER_ROUTER_PROMPT);
  assert.equal(current.reads(), 1);
  assert.equal(current.runtime.agentCommanderPreset().id, AGENT_COMMANDER_PRESET_ID);
  assert.equal(current.runtime.agentPreset('xf').id, 'xf');
  assert.equal(current.runtime.agentPreset('missing'), null);
  assert.equal(current.runtime.agentCommanderPrompt(), COMMANDER_ROUTER_PROMPT);
  assert.equal(current.reads(), 1);
  const commander = current.runtime.presetLookup(AGENT_COMMANDER_PRESET_ID);
  assert.deepEqual(Object.keys(commander), ['ok', 'found', 'preset']);
  assert.equal(commander.preset.defaultProviderId, 'official');
  const xf = current.runtime.presetLookup('xf');
  assert.equal(xf.preset.defaultProviderId, 'xf-model');
  assert.equal(xf.preset.defaultProviderName, 'summary:xf-model');
  const server = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /mountAgentResourcesHostRoute\(app, \{ runtime: agentResources \}\)/);
  assert.doesNotMatch(server, /agentResources\.mountRoutes/);
});

test('generated Agent Commander asset carries the same busy-aware MCP routing contract', () => {
  const catalog = require('../public/agent-presets.json');
  const preset = catalog.presets.find(item => item.id === AGENT_COMMANDER_PRESET_ID);
  assert.ok(preset);
  assert.equal(preset.prompt, COMMANDER_ROUTER_PROMPT);
});

test('preset list strips prompts while detail preserves them', () => {
  const current = fixture();
  const list = current.runtime.presetsList();
  assert.equal(list.ok, true);
  assert.equal(list.source, 'fixture');
  assert.equal(list.version, 2);
  assert.equal(list.generatedAt, '2026-01-01');
  assert.deepEqual(list.categories, ['specialized']);
  assert.deepEqual(list.featured, [AGENT_COMMANDER_PRESET_ID]);
  assert.equal(list.presets.length, 2);
  assert.equal(Object.hasOwn(list.presets[0], 'prompt'), false);
  assert.equal(list.presets[0].defaultProviderId, 'official');
  const detail = current.runtime.presetLookup(AGENT_COMMANDER_PRESET_ID).preset;
  assert.equal(detail.prompt, COMMANDER_ROUTER_PROMPT);
  assert.match(detail.description, /Route-first/);
  assert.match(detail.prompt, /not strictly route-only/);
  assert.match(detail.prompt, /The ONLY channel for cross-session dispatch is MCP/);
  assert.match(detail.prompt, /The two receipt modes of dispatch_master/);
  assert.match(detail.prompt, /Do not output <<route>> or <<dispatch>>/);
  assert.match(detail.prompt, /routingState="waiting_user"/);
  assert.match(detail.prompt, /prefer the related session when its load="available"/);
  assert.match(detail.prompt, /related session has load="running".*prefer another qualified load="available"/);
  assert.match(detail.prompt, /every qualified session is busy.*FIFO/);
  assert.match(detail.prompt, /explicitly named by the user must be chosen as-is, never redirected/);
  assert.match(detail.prompt, /waiting_user.*background.*error/);
  assert.match(detail.prompt, /goal, known facts, constraints.*acceptance criteria/);
  assert.match(detail.prompt, /never a full conversation or secrets/);
  assert.doesNotMatch(detail.prompt, /不要因此改投不相关 worker/);
  assert.match(detail.prompt, /list order carries no priority/);
  assert.match(detail.prompt, /dispatch_status/);
  assert.match(detail.prompt, /timeout, terminated stream/);
  assert.match(detail.prompt, /\/api\/sessions\/:id\/dispatches/);
  assert.equal(current.reads(), 1);
  assert.deepEqual(current.runtime.presetLookup('missing'), { ok: true, found: false });
});

test('provider fallback keeps model and name priority plus id name fallback', () => {
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
  const openai = current.runtime.presetLookup('openai').preset;
  assert.equal(openai.defaultProviderId, 'gpt');
  assert.equal(openai.defaultProviderName, 'gpt');
  const xf = current.runtime.presetLookup('xf').preset;
  assert.equal(xf.defaultProviderId, 'xf-name');
});

test('preset read failure is cached and reported as the not-ok host answer', () => {
  const current = fixture({ readError: new Error('disk failed') });
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(current.runtime.presetsList(), { ok: false });
    assert.deepEqual(current.runtime.presetLookup('xf'), { ok: false });
  }
  assert.equal(current.reads(), 1);
  assert.equal(current.runtime.agentCommanderPrompt(), null);
});

test('skills and Claude history are passed through untouched', () => {
  const histories = [
    { id: 'a', project: 'p', size: 10, linked: true },
    { id: 'b', project: 'p', size: 25, linked: false },
  ];
  const skills = [
    { name: 'a', provider: 'claude' },
    { name: 'b', provider: 'codex' },
  ];
  const current = fixture({ skills, histories });
  assert.deepEqual(current.runtime.installedSkills(), skills);
  assert.deepEqual(current.runtime.claudeSessions(), histories);
});

test('single history delete maps protected, missing, success and thrown results', () => {
  for (const [result, expected] of [
    [{ ok: false, error: 'protected linked session' }, { ok: false, error: 'protected linked session' }],
    [{ ok: false, error: 'not found' }, { ok: false, error: 'not found' }],
    [{ ok: true, freed: 12 }, { ok: true, freed: 12 }],
  ]) {
    const current = fixture({ remove: () => result });
    assert.deepEqual(current.runtime.removeClaudeSession('p', 's'), expected);
    assert.deepEqual(current.removals, [{ project: 'p', id: 's' }]);
  }
  const thrown = fixture({ remove: () => { throw new Error('cleanup failed'); } });
  assert.deepEqual(thrown.runtime.removeClaudeSession('p', 's'), { ok: false, threw: true });
  assert.equal(thrown.reportedErrors.length, 1);
  assert.equal(thrown.reportedErrors[0].fields.operation, 'claude_history_delete');
  assert.equal(JSON.stringify(thrown.runtime.removeClaudeSession('p', 's')).includes('cleanup failed'), false);
});
