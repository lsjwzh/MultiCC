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
  { id: 'me', dirId: 'd1', type: 'chat', autoDispatch: true, effort: 'high' },
  { id: 'sib-a', dirId: 'd1', type: 'chat', label: 'Worker A', cli: 'claude', kind: 'chat' },
  { id: 'sib-b', dirId: 'd1', type: 'codex', label: '', cli: 'codex', kind: 'terminal' },
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

test('buildDispatchContextPrompt is empty when there are no targets or autoDispatch is off', () => {
  // autoDispatch on but no peers → empty
  const solo = makeFactory([{ id: 'solo', dirId: 'd9', type: 'chat', autoDispatch: true }], {});
  assert.equal(solo.buildDispatchContextPrompt('solo'), '');
  // peers exist but autoDispatch off → empty
  const off = makeFactory(
    [{ id: 'me', dirId: 'd1', type: 'chat', autoDispatch: false },
     { id: 'sib', dirId: 'd1', type: 'chat' }], {});
  assert.equal(off.buildDispatchContextPrompt('me'), '');
});

test('buildDispatchContextPrompt (plain) includes the marker format and target list', () => {
  const t = makeFactory(BASE, {}, () => 'normal');
  const p = t.buildDispatchContextPrompt('me');
  assert.match(p, /\[MultiCC cross-session dispatch\]/);
  assert.match(p, /<<dispatch target=/);
  assert.match(p, /可用目标 sessions: \[/);
  assert.doesNotMatch(p, /Ultracode/);
});

test('buildDispatchContextPrompt (ultracode) switches to the ultra workflow intro', () => {
  const t = makeFactory(BASE, {}, () => 'ultracode');
  const p = t.buildDispatchContextPrompt('me');
  assert.match(p, /\[MultiCC Ultracode workflow\]/);
  assert.match(p, /Task\/Agent\/Workflow/);
  assert.match(p, /<<dispatch target=/);
});

// ── Commander role (type='commander') ───────────────────────────────────────
// Commander is a host-owned router and never receives the legacy LLM dispatch
// surface. Ordinary sessions retain their explicit opt-in behavior.
const COMMANDER_BASE = [
  { id: 'cmd', dirId: 'd1', type: 'commander' },                                  // no autoDispatch
  { id: 'w-a', dirId: 'd1', type: 'chat', label: 'W A', cli: 'claude', kind: 'chat' },
  { id: 'w-b', dirId: 'd2', type: 'chat', label: 'W B', cli: 'codex', kind: 'chat' },   // other fleet
  { id: 'cmd2', dirId: 'd2', type: 'commander' },                                 // another fleet's commander
  { id: 'aux', dirId: 'd1', type: 'aux' },
];

test('commander receives no legacy dispatch targets', () => {
  const t = makeFactory(COMMANDER_BASE, {});
  assert.deepEqual(t.dispatchableSessionsFor('cmd'), []);
});

test('a normal session never sees a commander peer as a dispatch target', () => {
  const recs = [
    { id: 'me', dirId: 'd1', type: 'chat', autoDispatch: true },
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    { id: 'peer', dirId: 'd1', type: 'chat' },
  ];
  const t = makeFactory(recs, {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id);
  assert.ok(!ids.includes('cmd'));
  assert.deepEqual(ids, ['peer']);
});

test('a normal session stays in-directory', () => {
  const t = makeFactory(COMMANDER_BASE.concat({ id: 'me', dirId: 'd1', type: 'chat', autoDispatch: true }), {});
  const ids = t.dispatchableSessionsFor('me').map(s => s.id).sort();
  assert.deepEqual(ids, ['w-a']);   // only same-dir worker; not w-b (d2), not any commander
});

test('commander gets no dispatch prompt even when autoDispatch is set', () => {
  const t = makeFactory(COMMANDER_BASE, {});
  assert.equal(t.buildDispatchContextPrompt('cmd'), '');
});

test('commander target surface remains empty with raw terminals present', () => {
  const recs = [
    { id: 'cmd', dirId: 'd1', type: 'commander' },
    { id: 'w', dirId: 'd1', type: 'chat', kind: 'chat' },
    { id: 'term', dirId: 'd2', type: 'chat', kind: 'terminal' },
  ];
  const t = makeFactory(recs, {});
  const ids = t.dispatchableSessionsFor('cmd').map(s => s.id);
  assert.deepEqual(ids, []);
});

test('commander target surface remains empty with many sessions', () => {
  const many = [{ id: 'cmd', dirId: 'd1', type: 'commander' }];
  for (let i = 0; i < 140; i++) many.push({ id: `p${i}`, dirId: `d${i % 5}`, type: 'chat' });
  const t = makeFactory(many, {});
  assert.equal(t.dispatchableSessionsFor('cmd').length, 0);
});

test('createDispatchTargeting validates its deps', () => {
  assert.throws(() => createDispatchTargeting({}), /records must be/);
  assert.throws(() => createDispatchTargeting({ records: new Map() }), /chatSessions must be/);
  assert.throws(() => createDispatchTargeting({ records: new Map(), chatSessions: new Map() }), /normalizeEffort/);
});
