#!/usr/bin/env node
'use strict';

// Differential for `latestAssistantConclusion`.
//
// OLD: the retired `conclusionFromHistory(service.read(id))`, frozen in
//      tests/helpers/legacy-event-conclusion.js - clones the whole history into
//      Node, then pages it eight messages at a time across the FFI. NEW: one `service.latestAssistantConclusion(id, home)` call that
//      walks the cached history in place and returns only the text.
//
// Both run against the SAME real Rust service holding the SAME history, and the
// result must be identical for every case. A coverage assertion requires every
// branch of the rule to be genuinely reached on both sides, so a corpus that
// quietly stops exercising a branch fails instead of passing vacuously.
//
// Usage: node latest-assistant-conclusion.js [repoRoot]
// Needs MULTICC_RUST_ADDON to point at an addon built from the current source.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const native = require(path.join(root, 'src/session/chat-history-service'));
const envelope = require(path.join(root, 'src/events/envelope'));
const legacy = require(path.join(root, 'tests/helpers/legacy-event-conclusion'));

const HOME = os.homedir();
const MAX = envelope.CONCLUSION_MAX;
const filler = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `u${i}` }));

// name -> { history, branches }. `branches` is what this case must prove it reached.
const corpus = [];
const add = (name, history, branches) => corpus.push({ name, history, branches });

add('empty history', [], ['empty']);
add('no assistant at all', [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }], ['no-assistant']);
add('plain string content', [{ role: 'assistant', content: 'hello' }], ['string']);
add('last assistant wins', [{ role: 'assistant', content: 'old' }, { role: 'assistant', content: 'new' }], ['string', 'newest-first']);
add('trailing user messages skipped',
  [{ role: 'assistant', content: 'answer' }, { role: 'user', content: 'thanks' }, { role: 'user', content: 'bye' }],
  ['string', 'skip-non-assistant']);
add('blank assistant falls back to previous',
  [{ role: 'assistant', content: 'real' }, { role: 'assistant', content: '   ' }], ['string', 'skip-blank']);
add('unicode whitespace is blank (nbsp, ideographic space, newline)',
  [{ role: 'assistant', content: 'real' }, { role: 'assistant', content: ' 　\n\t ' }], ['string', 'skip-blank']);
add('text blocks joined by newline',
  [{ role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }], ['blocks', 'join']);
add('tool_use and thinking blocks are ignored',
  [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'shown' }] }],
  ['blocks', 'skip-nontext-block']);
add('blocks with only non-text -> blank -> previous',
  [{ role: 'assistant', content: 'prev' }, { role: 'assistant', content: [{ type: 'tool_use' }] }], ['blocks', 'skip-blank']);
add('text block with non-string text is dropped',
  [{ role: 'assistant', content: [{ type: 'text', text: 7 }, { type: 'text', text: 'ok' }] }], ['blocks', 'nonstring-text']);
add('null and falsy blocks tolerated',
  [{ role: 'assistant', content: [null, 0, '', { type: 'text', text: 'ok' }] }], ['blocks', 'falsy-block']);
add('content null', [{ role: 'assistant', content: 'prev' }, { role: 'assistant', content: null }], ['nullish-content', 'skip-blank']);
add('content missing', [{ role: 'assistant', content: 'prev' }, { role: 'assistant' }], ['nullish-content', 'skip-blank']);
add('content is a number', [{ role: 'assistant', content: 'prev' }, { role: 'assistant', content: 42 }], ['odd-content', 'skip-blank']);
add('content is an object', [{ role: 'assistant', content: 'prev' }, { role: 'assistant', content: { type: 'text', text: 'x' } }], ['odd-content', 'skip-blank']);
add('role must match exactly (case)',
  [{ role: 'assistant', content: 'lower' }, { role: 'Assistant', content: 'upper' }], ['string', 'role-exact']);
add('role with trailing space is not assistant',
  [{ role: 'assistant', content: 'lower' }, { role: 'assistant ', content: 'x' }], ['string', 'role-exact']);
add('non-assistant roles carrying text are skipped',
  [{ role: 'assistant', content: 'a' }, { role: 'tool', content: 'noise' }, { role: 'system', content: 'sys' }], ['string', 'skip-non-assistant']);
add('redacts an api key', [{ role: 'assistant', content: 'key sk-abcdefghijklmnop1234 here' }], ['string', 'redact']);
add('redacts a bearer token', [{ role: 'assistant', content: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' }], ['string', 'redact']);
add('home directory is rewritten', [{ role: 'assistant', content: `see ${HOME}/project/file.txt now` }], ['string', 'redact-home']);
add('surrounding whitespace is trimmed', [{ role: 'assistant', content: '  \n padded \n  ' }], ['string', 'trim']);
add('exactly at the clip limit is not clipped', [{ role: 'assistant', content: 'x'.repeat(MAX) }], ['string', 'clip-boundary']);
add('one over the clip limit is clipped', [{ role: 'assistant', content: 'x'.repeat(MAX + 1) }], ['string', 'clip']);
add('far over the clip limit is clipped', [{ role: 'assistant', content: 'x'.repeat(MAX * 3) }], ['string', 'clip']);
// 2000 UTF-16 units land in the middle of a surrogate pair: the lone high
// surrogate must survive exactly as String.prototype.slice leaves it.
add('clip cuts through a surrogate pair',
  [{ role: 'assistant', content: `${'a'.repeat(MAX - 1)}😀${'b'.repeat(10)}` }], ['string', 'clip', 'surrogate-cut']);
add('lone surrogate in the text survives', [{ role: 'assistant', content: 'x\ud83dy' }], ['string', 'lone-surrogate']);
add('CJK text', [{ role: 'assistant', content: '完成了，没有问题。' }], ['string', 'cjk']);
// The old path pages eight messages at a time; a conclusion 25 messages from the
// tail forces it across four pages while the new path walks once.
add('conclusion is 25 messages from the tail',
  [{ role: 'assistant', content: 'deep' }, ...filler(25)], ['string', 'multi-page', 'skip-non-assistant']);
add('conclusion exactly on a page boundary',
  [{ role: 'assistant', content: 'edge' }, ...filler(8)], ['string', 'multi-page']);
add('conclusion one before a page boundary',
  [{ role: 'assistant', content: 'edge' }, ...filler(7)], ['string']);
add('many blanks then a real one',
  [{ role: 'assistant', content: 'real' }, ...Array.from({ length: 20 }, () => ({ role: 'assistant', content: ' ' }))], ['string', 'multi-page', 'skip-blank']);
add('nothing but blank assistants',
  Array.from({ length: 12 }, () => ({ role: 'assistant', content: '\n' })), ['no-text']);
add('a long history with a late conclusion',
  [{ role: 'assistant', content: 'start' }, ...filler(500), { role: 'assistant', content: 'finish' }, ...filler(3)], ['string', 'multi-page']);

function serviceFor(history) {
  const rows = JSON.parse(JSON.stringify(history));
  let n = 0;
  return native.createChatHistoryService({
    history: { read: () => rows, write() {}, deleteSession() { return true; }, hasPersistedDelivery() { return false; } },
    idFactory: () => `id-${++n}`,
  });
}

const reached = new Map();
const hit = (branch) => reached.set(branch, (reached.get(branch) || 0) + 1);
let same = 0;
const failures = [];

for (const { name, history, branches } of corpus) {
  const service = serviceFor(history);
  // OLD: the retired path, exactly as it ran: deep-clone via `read`, then page.
  const oldValue = legacy.conclusionFromHistory(service.read('s'));
  // NEW: a fresh service so neither side can influence the other's cache.
  const raw = serviceFor(history).latestAssistantConclusion('s', HOME);
  const newValue = raw == null ? '' : raw;
  try {
    assert.equal(newValue, oldValue, name);
    assert.deepEqual(Array.from(newValue, (c) => c.charCodeAt(0)), Array.from(oldValue, (c) => c.charCodeAt(0)), `${name} (UTF-16 units)`);
    same += 1;
    branches.forEach(hit);
  } catch (error) {
    failures.push(`${name}: ${error.message.split('\n')[0]}`);
  }
}

// Every branch a case claims must really have been observed with a distinguishing
// result, not just declared. These assertions look at the produced values.
const seen = (name) => corpus.find((c) => c.name === name);
const value = (name) => {
  const raw = serviceFor(seen(name).history).latestAssistantConclusion('s', HOME);
  return raw == null ? '' : raw;
};
const semantic = [
  ['plain string content yields its text', value('plain string content') === 'hello'],
  ['newest assistant wins', value('last assistant wins') === 'new'],
  ['trailing user messages are skipped', value('trailing user messages skipped') === 'answer'],
  ['blank assistant falls back', value('blank assistant falls back to previous') === 'real'],
  ['unicode whitespace counts as blank', value('unicode whitespace is blank (nbsp, ideographic space, newline)') === 'real'],
  ['text blocks join with a newline', value('text blocks joined by newline') === 'one\ntwo'],
  ['non-text blocks are ignored', value('tool_use and thinking blocks are ignored') === 'shown'],
  ['non-string block text is dropped', value('text block with non-string text is dropped') === 'ok'],
  ['exact role match only', value('role must match exactly (case)') === 'lower'],
  ['api key is redacted', !value('redacts an api key').includes('sk-abcdefghijklmnop1234')],
  ['bearer token is redacted', !value('redacts a bearer token').includes('abcdefghijklmnopqrstuvwxyz')],
  ['home directory becomes ~', value('home directory is rewritten').includes('~') && !value('home directory is rewritten').includes(HOME)],
  ['text is trimmed', value('surrounding whitespace is trimmed') === 'padded'],
  ['at the limit is not clipped', value('exactly at the clip limit is not clipped').length === MAX],
  ['over the limit is clipped with an ellipsis', value('one over the clip limit is clipped').endsWith('…') && value('one over the clip limit is clipped').length === MAX + 1],
  ['a cut through a surrogate pair keeps the lone high surrogate',
    (() => { const out = value('clip cuts through a surrogate pair'); return out.charCodeAt(MAX - 1) === 0xd83d && out.endsWith('…'); })()],
  ['a lone surrogate in the text survives', value('lone surrogate in the text survives') === 'x\ud83dy'],
  ['a conclusion 25 messages deep is found', value('conclusion is 25 messages from the tail') === 'deep'],
  ['a late conclusion in a long history is found', value('a long history with a late conclusion') === 'finish'],
  ['no assistant yields empty', value('no assistant at all') === '' && value('empty history') === '' && value('nothing but blank assistants') === ''],
];
for (const [label, ok] of semantic) if (!ok) failures.push(`semantic: ${label}`);

const required = ['empty', 'no-assistant', 'no-text', 'string', 'blocks', 'join', 'skip-nontext-block', 'nonstring-text', 'falsy-block',
  'nullish-content', 'odd-content', 'newest-first', 'skip-non-assistant', 'skip-blank', 'role-exact', 'redact', 'redact-home',
  'trim', 'clip-boundary', 'clip', 'surrogate-cut', 'lone-surrogate', 'cjk', 'multi-page'];
const missing = required.filter((branch) => !reached.has(branch));
if (missing.length) failures.push(`branches never reached: ${missing.join(', ')}`);

console.log(`[latest-assistant-conclusion] same ${same}/${corpus.length}; semantic ${semantic.filter(([, ok]) => ok).length}/${semantic.length}; branches ${required.length - missing.length}/${required.length}`);
if (failures.length) {
  console.error(failures.map((line) => `  FAIL ${line}`).join('\n'));
  process.exit(1);
}
