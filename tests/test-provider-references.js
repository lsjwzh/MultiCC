'use strict';

// 两半：既有行为断言（主/子任务/默认值/Aux 与池隔离），以及规则迁入 Rust 后新增的
// 逐字节对拍 —— 同一份语料同时喂给冻结的旧实现（tests/helpers/
// legacy-provider-references.js）和现在的 Rust 实现，比较 JSON、键序与冻结状态。
// 对拍覆盖的分支必须被语料真正走到，否则覆盖断言会让测试失败而不是悄悄全绿。

const test = require('node:test');
const assert = require('node:assert/strict');
const { findProviderReferences } = require('../src/providers/references');
const legacy = require('./helpers/legacy-provider-references');


test('provider deletion references include main, subagent, default and Aux with app isolation', () => {
  const sessions = new Map([
    ['main', { id: 'main', name: 'Main', cli: 'claude', provider: 'p1' }],
    ['sub', { id: 'sub', cli: 'claude', provider: 'other', subagent: { providerId: 'p1', model: 'm' } }],
    ['codex', { id: 'codex', cli: 'codex', provider: 'p1', subagent: { providerId: 'p1' } }],
    ['zcode', { id: 'zcode', cli: 'zcode', provider: 'p1' }],
    ['qoder', { id: 'qoder', cli: 'qoder', provider: 'p1' }],
  ]);
  const references = findProviderReferences({
    appType: 'claude',
    providerId: 'p1',
    sessions,
    defaults: { claude: 'p1', codex: null },
    aux: { protocol: 'anthropic', providerId: 'p1' },
  });
  assert.deepEqual(references.map(item => item.kind), ['main', 'subagent', 'main', 'default', 'aux']);
  assert.deepEqual(references.filter(item => item.sessionId).map(item => item.sessionId), ['main', 'sub', 'zcode']);
  assert.equal(Object.isFrozen(references), true);
  assert.equal(Object.isFrozen(references[0]), true);
});

test('unreferenced provider can be deleted and Aux protocol maps to the correct pool', () => {
  assert.deepEqual(findProviderReferences({
    appType: 'claude', providerId: 'free', sessions: [],
    defaults: { claude: null }, aux: { protocol: 'openai', providerId: 'free' },
  }), []);
  assert.deepEqual(findProviderReferences({
    appType: 'codex', providerId: 'p2', sessions: [],
    defaults: { codex: null }, aux: { protocol: 'openai', providerId: 'p2' },
  }), [{ kind: 'aux', protocol: 'openai' }]);
});

// ── 逐字节对拍：冻结的旧实现 vs Rust ────────────────────────────────────────
// 语料刻意包含那些「看起来等价、实际不同」的输入：falsy 的 id、带空白的
// appType、非字符串的 provider 值、Map 之外的可迭代对象、以及空名字的回退链。
function corpus() {
  const session = (over) => ({ id: 's', name: 'S', cli: 'claude', provider: 'p1', ...over });
  const cases = [];
  const add = (name, world) => cases.push({ name, world });

  add('main reference in a Map', {
    appType: 'claude', providerId: 'p1',
    sessions: new Map([['s', session()]]), defaults: {}, aux: null,
  });
  add('main reference in an array', {
    appType: 'claude', providerId: 'p1', sessions: [session()], defaults: {}, aux: null,
  });
  // Not a Map and not an Array: the retired rule iterated neither.
  add('sessions as a bare iterable is ignored', {
    appType: 'claude', providerId: 'p1',
    sessions: { values: () => [session()][Symbol.iterator]() }, defaults: {}, aux: null,
  });
  add('sessions as a Set is ignored', {
    appType: 'claude', providerId: 'p1', sessions: new Set([session()]), defaults: {}, aux: null,
  });
  add('null session rows are skipped', {
    appType: 'claude', providerId: 'p1', sessions: [null, undefined, session()], defaults: {}, aux: null,
  });
  add('name falls back to label then id then empty', {
    appType: 'claude', providerId: 'p1',
    sessions: [
      session({ id: 'a', name: '', label: 'L' }),
      session({ id: 'b', name: '', label: '' }),
      session({ id: '', name: '', label: '' }),
      session({ id: 7, name: 0 }),
    ],
    defaults: {}, aux: null,
  });
  add('cross-pool clis skip the pool comparison', {
    appType: 'codex', providerId: 'p1',
    sessions: [session({ cli: 'opencode' }), session({ cli: 'zcode' }), session({ cli: 'claude' })],
    defaults: {}, aux: null,
  });
  add('exp lanes fold onto their base cli', {
    appType: 'codex', providerId: 'p1',
    sessions: [session({ cli: 'codex-exp' }), session({ cli: 'claude-exp' })],
    defaults: {}, aux: null,
  });
  add('an unknown cli has no pool', {
    appType: 'claude', providerId: 'p1',
    sessions: [session({ cli: 'qoder' }), session({ cli: undefined })],
    defaults: {}, aux: null,
  });
  add('auto candidates match by exact id', {
    appType: 'claude', providerId: 'p1',
    sessions: [
      session({ provider: 'other', providerSelection: { mode: 'auto', candidates: [{ providerId: 'p1' }] } }),
      session({ provider: 'other', providerSelection: { mode: 'manual', candidates: [{ providerId: 'p1' }] } }),
      session({ provider: 'other', providerSelection: { mode: 'auto', candidates: [] } }),
      session({ provider: 'other', providerSelection: { mode: 'auto' } }),
      session({ provider: 'other', providerSelection: null }),
    ],
    defaults: {}, aux: null,
  });
  add('all three kinds on one session keep their order', {
    appType: 'claude', providerId: 'p1',
    sessions: [session({
      providerSelection: { mode: 'auto', candidates: [{ providerId: 'p1' }] },
      subagent: { providerId: 'p1' },
    })],
    defaults: {}, aux: null,
  });
  add('a padded provider value is not a reference', {
    appType: 'claude', providerId: 'p1',
    sessions: [session({ provider: ' p1' }), session({ provider: 'p1 ' })], defaults: {}, aux: null,
  });
  add('a non-string provider value is not a reference', {
    appType: 'claude', providerId: '1',
    sessions: [session({ provider: 1 }), session({ provider: true })], defaults: {}, aux: null,
  });
  add('the target id is trimmed', {
    appType: 'claude', providerId: '  p1  ', sessions: [session()], defaults: {}, aux: null,
  });
  add('the app type is trimmed', {
    appType: ' claude ', providerId: 'p1', sessions: [session()], defaults: {}, aux: null,
  });
  // `String(x || '')`, not a nullish chain: these collapse to '' and so have no
  // references at all, whatever the sessions hold.
  add('a falsy zero id has no references', {
    appType: 'claude', providerId: 0, sessions: [session({ provider: 0 })], defaults: {}, aux: null,
  });
  add('a falsy zero app type has no references', {
    appType: 0, providerId: 'p1', sessions: [session()], defaults: {}, aux: null,
  });
  add('an empty id has no references', {
    appType: 'claude', providerId: '', sessions: [session()], defaults: {}, aux: null,
  });
  add('an unknown app type has no references', {
    appType: 'opencode', providerId: 'p1', sessions: [session({ cli: 'opencode' })], defaults: {}, aux: null,
  });
  add('missing input is empty', {});
  add('defaults match the pool being deleted', {
    appType: 'claude', providerId: 'p1', sessions: [],
    defaults: { claude: 'p1', codex: 'p1' }, aux: null,
  });
  add('defaults of the other pool do not match', {
    appType: 'codex', providerId: 'p1', sessions: [], defaults: { claude: 'p1' }, aux: null,
  });
  add('a falsy defaults object is skipped', {
    appType: 'claude', providerId: 'p1', sessions: [], defaults: null, aux: null,
  });
  add('aux on the openai protocol belongs to the codex pool', {
    appType: 'codex', providerId: 'p1', sessions: [], defaults: {},
    aux: { protocol: 'openai', providerId: 'p1' },
  });
  add('aux protocol case is ignored', {
    appType: 'codex', providerId: 'p1', sessions: [], defaults: {},
    aux: { protocol: 'OpenAI', providerId: 'p1' },
  });
  // Lowercased but never trimmed by the retired rule.
  add('a padded aux protocol stays anthropic-shaped', {
    appType: 'claude', providerId: 'p1', sessions: [], defaults: {},
    aux: { protocol: ' openai ', providerId: 'p1' },
  });
  add('an absent aux protocol is shown as anthropic', {
    appType: 'claude', providerId: 'p1', sessions: [], defaults: {},
    aux: { providerId: 'p1' },
  });
  add('an empty aux protocol is shown as anthropic', {
    appType: 'claude', providerId: 'p1', sessions: [], defaults: {},
    aux: { protocol: '', providerId: 'p1' },
  });
  add('aux pointing elsewhere is not a reference', {
    appType: 'claude', providerId: 'p1', sessions: [], defaults: {},
    aux: { protocol: 'anthropic', providerId: 'p2' },
  });
  add('everything at once keeps the retired order', {
    appType: 'claude', providerId: 'p1',
    sessions: new Map([
      ['a', session({ id: 'a', subagent: { providerId: 'p1' } })],
      ['b', session({ id: 'b', provider: 'x', providerSelection: { mode: 'auto', candidates: [{ providerId: 'p1' }] } })],
    ]),
    defaults: { claude: 'p1' }, aux: { protocol: 'anthropic', providerId: 'p1' },
  });
  return cases;
}

test('the Rust rules answer byte for byte what the frozen implementation did', () => {
  const cases = corpus();
  const seen = new Set();
  let identical = 0;
  for (const { name, world } of cases) {
    // Both sides read the same world: neither implementation may mutate the
    // caller's session table, so sharing it also pins that.
    const expected = legacy.findProviderReferences(world);
    const actual = findProviderReferences(world);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${name}: body`);
    assert.equal(Object.isFrozen(actual), true, `${name}: the array must be frozen`);
    for (const [index, reference] of actual.entries()) {
      assert.equal(Object.isFrozen(reference), true, `${name}: reference ${index} must be frozen`);
      assert.deepEqual(Object.keys(reference), Object.keys(expected[index]), `${name}: key order`);
    }
    for (const reference of actual) seen.add(reference.kind);
    identical += 1;
  }
  assert.equal(identical, cases.length);
  assert.equal(cases.length, 30, 'the corpus size is part of the record');
  // Coverage guard: a corpus that stopped exercising a reference kind would
  // otherwise keep passing while that branch rotted.
  assert.deepEqual([...seen].sort(), ['auto_candidate', 'aux', 'default', 'main', 'subagent']);
});
