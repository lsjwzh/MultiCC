'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createDispatchTargeting } = require('../src/dispatch/targeting');
const { composeMessage } = require('../src/message-composer');
const { recordsOf } = require('./helpers/session-records');

const ROOT = path.join(__dirname, '..');
const PRESET_ID = 'testing__testing-engineer';

function testEngineerPreset() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'agent-presets.json'), 'utf8'));
  return {
    catalog,
    preset: catalog.presets.find(item => item.id === PRESET_ID),
  };
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

test('a persisted role worker keeps its system prompt and Commander routing', () => {
  const { preset } = testEngineerPreset();
  const commander = {
    id: 'commander',
    dirId: 'fleet-1',
    cli: 'codex',
    kind: 'chat',
    type: 'commander',
  };
  const worker = {
    id: 'existing-engineer',
    dirId: commander.dirId,
    cli: preset.defaultCli,
    kind: 'chat',
    type: 'worker',
    label: preset.name,
    rolePrompt: preset.prompt,
    rolePresetId: preset.id,
  };
  const records = recordsOf([[commander.id, commander], [worker.id, worker]]);

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
    records,
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
