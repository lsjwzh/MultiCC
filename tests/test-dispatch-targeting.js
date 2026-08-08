'use strict';

// Golden tests for the extracted dispatch targeting module
// (src/dispatch/targeting.js). Fakes the session registry / chat map / effort
// normalizer so the sibling-listing filter, the hint string, and the two
// context-prompt variants (plain vs ultracode) are pinned without a live host.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatchTargeting } = require('../src/dispatch/targeting');

function makeFactory(records, chatSessions, effort = () => 'normal') {
  return createDispatchTargeting({
    records: new Map(records.map(r => [r.id, r])),
    chatSessions: new Map(Object.entries(chatSessions || {})),
    normalizeEffort: effort,
  });
}

const BASE = [
  { id: 'me', dirId: 'd1', type: 'chat', effort: 'high' },
  { id: 'sib-a', dirId: 'd1', type: 'chat', label: 'Worker A', cli: 'claude', kind: 'chat' },
  { id: 'sib-b', dirId: 'd1', type: 'codex', label: '', cli: 'codex', kind: 'terminal' },
  {
    id: 'sib-b-gw-chat', dirId: 'd1', type: null, label: 'sib-b (gw)',
    cli: 'codex', kind: 'chat', ephemeral: true, gatewayFor: 'sib-b',
  },
  { id: 'other-dir', dirId: 'd2', type: 'chat', label: 'Elsewhere' },
  { id: 'aux', dirId: 'd1', type: 'aux' },
  { id: 'gw', dirId: 'd1', type: 'gateway' },
];

test('dispatchableSessionsFor lists same-dir non-system peers, excluding self', () => {
  const t = makeFactory(BASE, {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id).sort();
  assert.deepEqual(ids, ['sib-a', 'sib-b']);
});

test('excludes aux/gateway and other-directory sessions', () => {
  const t = makeFactory(BASE, {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id);
  assert.ok(!ids.includes('aux'));
  assert.ok(!ids.includes('gw'));
  assert.ok(!ids.includes('other-dir'));
  assert.ok(!ids.includes('sib-b-gw-chat'), 'terminal execution gateways are not a second worker choice');
});

test('maps label/cli/kind with defaults and derives active from the chat session', () => {
  const t = makeFactory(BASE, {
    'sib-a': { clients: { size: 2 }, isStreaming: false },   // active via clients
    'sib-b': { clients: { size: 0 }, isStreaming: true },    // active via streaming
  });
  const list = t.dispatchableSessionsFor('me');
  const a = list.find(s => s.id === 'sib-a');
  const b = list.find(s => s.id === 'sib-b');
  assert.deepEqual(a, { id: 'sib-a', label: 'Worker A', cli: 'claude', kind: 'chat', active: true });
  assert.equal(b.active, true);
  assert.equal(b.label, '');        // empty label preserved
  assert.equal(b.cli, 'codex');
});

test('a session with no chat entry is inactive', () => {
  const t = makeFactory(BASE, {});   // no chat sessions
  assert.equal(t.dispatchableSessionsFor('me').every(s => s.active === false), true);
});

test('returns empty for an unknown session or one without a dirId', () => {
  const t = makeFactory(BASE, {});
  assert.deepEqual(t.dispatchableSessionsFor('nope'), []);
  const t2 = makeFactory([{ id: 'x', type: 'chat' }], {});
  assert.deepEqual(t2.dispatchableSessionsFor('x'), []);
});

test('caps the target list at 30 peers', () => {
  const many = [{ id: 'me', dirId: 'd1', type: 'chat' }];
  for (let i = 0; i < 40; i++) many.push({ id: `p${i}`, dirId: 'd1', type: 'chat' });
  const t = makeFactory(many, {});
  assert.equal(t.dispatchableSessionsFor('me').length, 30);
});

test('dispatchTargetHintFor renders the target list or a no-target message', () => {
  const t = makeFactory(BASE, {});
  assert.match(t.dispatchTargetHintFor('me'), /可用目标 sessions: \[/);
  const alone = makeFactory([{ id: 'solo', dirId: 'd9', type: 'chat' }], {});
  assert.equal(alone.dispatchTargetHintFor('solo'), '当前同目录没有可分发的目标 session');
});

test('buildDispatchContextPrompt is empty for non-commander sessions and when there are no targets', () => {
  // no peers → empty
  const solo = makeFactory([{ id: 'solo', dirId: 'd9', type: 'chat' }], {});
  assert.equal(solo.buildDispatchContextPrompt('solo'), '');
  // non-commander with peers → empty (only commander gets the prompt)
  const nonCmd = makeFactory(
    [{ id: 'me', dirId: 'd1', type: 'chat' },
     { id: 'sib', dirId: 'd1', type: 'chat' }], {});
  assert.equal(nonCmd.buildDispatchContextPrompt('me'), '');
});

// ── Commander role (type='commander') ───────────────────────────────────────
// Commander is the only session type that receives the dispatch context prompt
// (target list + routing instructions). Ordinary sessions use MCP router tools.
const COMMANDER_BASE = [
  { id: 'cmd', dirId: 'd1', type: 'commander' },
  { id: 'w-a', dirId: 'd1', type: 'chat', label: 'W A', cli: 'claude', kind: 'chat' },
  { id: 'w-b', dirId: 'd2', type: 'chat', label: 'W B', cli: 'codex', kind: 'chat' },   // other fleet
  { id: 'cmd2', dirId: 'd2', type: 'commander' },                                 // another fleet's commander
  { id: 'aux', dirId: 'd1', type: 'aux' },
];

test('commander (real-LLM dispatcher) sees same-dir workers, not commanders/aux/self', () => {
  const t = makeFactory(COMMANDER_BASE, {});
  const ids = t.dispatchableSessionsFor('cmd').map(s => s.id).sort();
  assert.deepEqual(ids, ['w-a']);   // same-dir worker only; not w-b (d2), not cmd2/aux/self
});

test('commander sees bounded roles and deduplicated recent task evidence', () => {
  const records = [
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    {
      id: 'backend', dirId: 'd1', type: 'worker', kind: 'chat',
      label: '后端工程师',
      rolePrompt: '# 角色：后端与安全\n负责 API、数据和鉴权。token=top-secret /private/repo/server.js',
      taskState: {
        goal: '当前 API 修复',
        phase: 'implementing',
        classifyState: 'running',
        classifyHistory: [
          { goal: '旧 UI 任务', phase: 'done', state: 'completed' },
          { goal: '修复 OAuth 回调', phase: 'done', state: 'completed' },
          { goal: '修复OAuth回调', phase: 'verifying', state: 'completed' },
          { goal: '当前 API 修复', phase: 'planning', state: 'waiting' },
        ],
      },
    },
  ];
  const t = makeFactory(records, {
    backend: { clients: { size: 1 }, isStreaming: true },
  });
  const [target] = t.dispatchableSessionsFor('cmd');
  assert.equal(target.load, 'running');
  assert.equal(target.routingState, 'unknown');
  assert.match(target.role, /后端与安全/);
  assert.doesNotMatch(target.role, /top-secret|private\/repo/);
  assert.deepEqual(target.recentTasks, [
    { task: '当前 API 修复', phase: 'planning', state: 'waiting' },
    { task: '修复OAuth回调', phase: 'verifying', state: 'completed' },
    { task: '旧 UI 任务', phase: 'done', state: 'completed' },
  ]);
});

test('a normal session never sees a commander peer as a dispatch target', () => {
  const recs = [
    { id: 'me', dirId: 'd1', type: 'chat' },
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    { id: 'peer', dirId: 'd1', type: 'chat' },
  ];
  const t = makeFactory(recs, {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id);
  assert.ok(!ids.includes('cmd'));
  assert.deepEqual(ids, ['peer']);
});

test('a normal session stays in-directory', () => {
  const t = makeFactory(COMMANDER_BASE.concat({ id: 'me', dirId: 'd1', type: 'chat' }), {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id).sort();
  assert.deepEqual(ids, ['w-a']);   // only same-dir worker; not w-b (d2), not any commander
});

test('commander gets the dispatch prompt', () => {
  const t = makeFactory(COMMANDER_BASE, {});
  const p = t.buildDispatchContextPrompt('cmd');
  assert.match(p, /\[MultiCC Commander routing\]/);
  assert.match(p, /route-first|不是强制 route-only|优先 route_task|优先判断/);
  assert.match(p, /route_task/);
  assert.match(p, /优先复用/);
  assert.match(p, /role（稳定职责摘要）/);
  assert.match(p, /recentTasks/);
  assert.match(p, /上下文连续性/);
  assert.match(p, /load="running"/);
  assert.match(p, /routingState="waiting_user"/);
  assert.match(p, /相关性明显更高/);
  assert.match(p, /候选列表顺序不表示优先级/);
  assert.match(p, /不要根据 id、CLI 名称或最近活跃时间猜职责/);
  assert.match(p, /用户原话点名/);
  assert.match(p, /dispatch_status/);
  assert.match(p, /timeout、terminated/);
  assert.match(p, /session\.active\/streaming/);
  assert.match(p, /\/api\/sessions\/:id\/dispatches/);
  assert.doesNotMatch(p, /<<route target=/);
  assert.doesNotMatch(p, /\[MultiCC Ultracode workflow\]/);
  assert.match(p, /可用目标 sessions: \[/);
});

test('commander sees waiting-user workflow state as a soft routing signal', () => {
  const records = [
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    {
      id: 'waiting-worker',
      dirId: 'd1',
      type: 'worker',
      kind: 'chat',
      taskState: {
        classifyState: 'W',
        pendingUserInput: {
          resolved: false,
          question: 'sensitive question must not leak',
          options: ['secret choice'],
        },
      },
    },
    {
      id: 'available-worker',
      dirId: 'd1',
      type: 'worker',
      kind: 'chat',
      taskState: {
        classifyState: 'D',
        queueDepth: 0,
      },
    },
  ];
  const t = makeFactory(records, {
    'waiting-worker': { clients: { size: 1 }, isStreaming: false },
  });
  const waiting = t.dispatchableSessionsFor('cmd')
    .find(target => target.id === 'waiting-worker');
  const available = t.dispatchableSessionsFor('cmd')
    .find(target => target.id === 'available-worker');
  assert.equal(waiting.load, 'available');
  assert.equal(waiting.routingState, 'waiting_user');
  assert.equal(available.load, 'available');
  assert.equal(available.routingState, 'ready');
  assert.doesNotMatch(JSON.stringify(waiting), /sensitive question|secret choice/);
});

test('commander with ultracode stays on route-first route_task surface', () => {
  const records = COMMANDER_BASE.map(record => (
    record.id === 'cmd' ? { ...record, effort: 'ultracode' } : record
  ));
  const t = makeFactory(records, {}, () => 'ultracode');
  const p = t.buildDispatchContextPrompt('cmd');
  assert.match(p, /\[MultiCC Commander routing\]/);
  assert.match(p, /具备 Ultracode 能力/);
  assert.match(p, /可以在当前会话完成/);
  assert.match(p, /route_task/);
  assert.match(p, /跨 session 派发仍只使用 MCP route_task \/ dispatch_master/);
  assert.doesNotMatch(p, /\[MultiCC Ultracode workflow\]/);
  assert.doesNotMatch(p, /Task\/Agent\/Workflow/);
  assert.doesNotMatch(p, /<<dispatch target=/);
  assert.match(p, /\[MultiCC Commander routing end\]/);
});

test('commander target surface lists only same-dir workers', () => {
  const recs = [
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    { id: 'w', dirId: 'd1', type: 'chat', kind: 'chat' },
    { id: 'other', dirId: 'd2', type: 'chat', kind: 'chat' },   // other dir → excluded
  ];
  const t = makeFactory(recs, {});
  const ids = t.dispatchableSessionsFor('cmd').map(s => s.id);
  assert.deepEqual(ids, ['w']);
});

test('commander target surface caps at 30 same-dir sessions', () => {
  const many = [{ id: 'cmd', dirId: 'd1', type: 'commander' }];
  for (let i = 0; i < 140; i++) many.push({ id: `p${i}`, dirId: 'd1', type: 'chat' });
  const t = makeFactory(many, {});
  assert.equal(t.dispatchableSessionsFor('cmd').length, 30);
});

test('createDispatchTargeting validates its deps', () => {
  assert.throws(() => createDispatchTargeting({}), /records must be/);
  assert.throws(() => createDispatchTargeting({ records: new Map() }), /chatSessions must be/);
  assert.throws(() => createDispatchTargeting({ records: new Map(), chatSessions: new Map() }), /normalizeEffort/);
});
