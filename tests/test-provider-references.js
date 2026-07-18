'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findProviderReferences } = require('../src/provider-references');

test('provider deletion references include main, subagent, default and Aux with app isolation', () => {
  const sessions = new Map([
    ['main', { id: 'main', name: 'Main', cli: 'claude', provider: 'p1' }],
    ['sub', { id: 'sub', cli: 'claude', provider: 'other', subagent: { providerId: 'p1', model: 'm' } }],
    ['codex', { id: 'codex', cli: 'codex', provider: 'p1', subagent: { providerId: 'p1' } }],
  ]);
  const references = findProviderReferences({
    appType: 'claude',
    providerId: 'p1',
    sessions,
    defaults: { claude: 'p1', codex: null },
    aux: { protocol: 'anthropic', providerId: 'p1' },
  });
  assert.deepEqual(references.map(item => item.kind), ['main', 'subagent', 'default', 'aux']);
  assert.deepEqual(references.filter(item => item.sessionId).map(item => item.sessionId), ['main', 'sub']);
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
