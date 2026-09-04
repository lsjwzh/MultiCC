'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createDispatchTargeting } = require('../src/dispatch/targeting');
const { composeMessage } = require('../src/message-composer');
const { createSessionPersistence } = require('../src/session-persistence');
const {
  createRoleWorkerService,
  roleWorkerSpec,
} = require('../src/session/role-worker');

const ROOT = path.join(__dirname, '..');
const PRESET_ID = 'testing__testing-engineer';

function testEngineerPreset() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'agent-presets.json'), 'utf8'));
  return {
    catalog,
    preset: catalog.presets.find(item => item.id === PRESET_ID),
  };
}

function createHarness(initialRecords = []) {
  const records = new Map(initialRecords.map(record => [record.id, record]));
  const saved = [];
  const persistence = createSessionPersistence({
    records,
    store: { save(payload) { saved.push(payload); } },
  });
  let createCalls = 0;
  const service = createRoleWorkerService({
    records,
    mutate: persistence.mutate,
    async createSession(options) {
      createCalls += 1;
      const id = `worker-${createCalls}`;
      const session = {
        id,
        dirId: options.dir.id,
        cli: options.cli,
        kind: options.kind,
        label: options.label,
        model: options.model,
        effort: options.effort,
        provider: options.provider === undefined ? null : options.provider,
        rolePrompt: options.rolePrompt,
        rolePresetId: options.rolePresetId,
        type: options.type,
      };
      records.set(id, session);
      persistence.bestEffort('test.create-role-worker');
      return { ok: true, id, session };
    },
  });
  return { records, saved, service, createCalls: () => createCalls };
}

test('测试工程师 template is complete, categorized, and keeps existing presets intact', () => {
  const { catalog, preset } = testEngineerPreset();
  assert.ok(preset, 'persistent preset exists');
  assert.equal(preset.name, '测试工程师');
  assert.equal(preset.category, 'testing');
  assert.equal(preset.defaultCli, 'codex');
  assert.equal(preset.defaultProviderKey, '');
  assert.equal(preset.defaultModel, '');
  for (const phrase of [
    '先读需求、接口契约和已有测试',
    '重试与幂等',
    '断线恢复',
    '重复事件',
    '不使用真实敏感数据',
    '最小复现',
    'flaky',
    '不覆盖其他会话未提交的修改',
    '默认只诊断和验证',
  ]) assert.match(preset.prompt, new RegExp(phrase));
  const testing = catalog.presets.filter(item => item.category === 'testing');
  assert.equal(catalog.categories.find(item => item.key === 'testing').count, testing.length);
  assert.ok(catalog.presets.some(item => item.id === 'testing__testing-api-tester'));
  assert.ok(catalog.presets.some(item => item.id === 'specialized__agent-commander'));
});

test('role worker spec follows fleet defaults and rejects incomplete templates', () => {
  const { preset } = testEngineerPreset();
  const spec = roleWorkerSpec({ ...preset, defaultProviderId: null });
  assert.deepEqual({
    cli: spec.cli,
    kind: spec.kind,
    label: spec.label,
    model: spec.model,
    provider: spec.provider,
    effort: spec.effort,
    rolePresetId: spec.rolePresetId,
    type: spec.type,
  }, {
    cli: 'codex',
    kind: 'chat',
    label: '测试工程师',
    model: null,
    provider: undefined,
    effort: 'high',
    rolePresetId: PRESET_ID,
    type: 'worker',
  });
  assert.throws(() => roleWorkerSpec({ id: PRESET_ID, name: '测试工程师' }), /prompt and name/);
});

test('ensure creates once, persists template identity, and is idempotent', async () => {
  const { preset } = testEngineerPreset();
  const harness = createHarness();
  const dir = { id: 'fleet-1' };
  const first = await harness.service.ensure({ dir, preset });
  const second = await harness.service.ensure({ dir, preset });

  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.id, first.id);
  assert.equal(harness.createCalls(), 1);
  const workers = [...harness.records.values()].filter(item => item.rolePresetId === PRESET_ID);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].kind, 'chat');
  assert.equal(workers[0].type, 'worker');
  assert.equal(workers[0].label, '测试工程师');
  assert.equal(workers[0].rolePrompt, preset.prompt);
  assert.ok(harness.saved.some(payload => payload.some(item =>
    item.id === first.id && item.rolePresetId === PRESET_ID && item.rolePrompt === preset.prompt)));
});

test('ensure upgrades compatible legacy data without duplicating or touching other roles', async () => {
  const { preset } = testEngineerPreset();
  const existing = {
    id: 'legacy-qa',
    dirId: 'fleet-1',
    cli: 'claude',
    kind: 'chat',
    label: '测试工程师',
    rolePrompt: preset.prompt,
  };
  const architect = {
    id: 'architect',
    dirId: 'fleet-1',
    cli: 'claude',
    kind: 'chat',
    label: '架构师',
    rolePrompt: '# 角色：架构师',
  };
  const beforeArchitect = JSON.parse(JSON.stringify(architect));
  const harness = createHarness([existing, architect]);
  const result = await harness.service.ensure({ dir: { id: 'fleet-1' }, preset });

  assert.equal(result.reused, true);
  assert.equal(result.id, 'legacy-qa');
  assert.equal(harness.createCalls(), 0);
  assert.equal(harness.records.get('legacy-qa').type, 'worker');
  assert.equal(harness.records.get('legacy-qa').rolePresetId, PRESET_ID);
  assert.deepEqual(harness.records.get('architect'), beforeArchitect);
});

test('created role is injected into the system prompt and visible to Commander routing', async () => {
  const { preset } = testEngineerPreset();
  const commander = {
    id: 'commander',
    dirId: 'fleet-1',
    cli: 'codex',
    kind: 'chat',
    type: 'commander',
  };
  const harness = createHarness([commander]);
  const result = await harness.service.ensure({ dir: { id: 'fleet-1' }, preset });
  const worker = harness.records.get(result.id);

  const envelope = composeMessage({
    text: '验证发布候选',
    persisted: worker,
    sessionName: worker.id,
    opts: { isFirstTurn: true, bare: true },
    deps: {
      resolveRolePrompt: record => record.rolePrompt || null,
      multiccImgHint: '[image hint]',
      normalizeEffort: value => value || null,
    },
  });
  assert.equal(envelope.rolePrompt, preset.prompt);
  assert.equal(envelope.systemPrompt, `[image hint]\n\n${preset.prompt}`);

  const targeting = createDispatchTargeting({
    records: harness.records,
    chatSessions: new Map(),
    normalizeEffort: value => value || null,
    isTargetBusy: () => false,
  });
  const candidate = targeting.dispatchableSessionsFor('commander')
    .find(item => item.id === worker.id);
  assert.ok(candidate, 'Commander candidate list includes the role worker');
  assert.equal(candidate.kind, 'chat');
  assert.equal(candidate.label, '测试工程师');
  assert.match(candidate.role, /质量验证与发布把关/);
  assert.match(targeting.buildDispatchContextPrompt('commander'), /测试工程师/);
});
