'use strict';
// Writes the frozen corpus for multicc_core::chat_history_frame from the
// frozen Node transcription in tests/helpers/legacy-chat-history-frame.js.
//
// Run: node docs/rust-migration/differential/chat-history-frame-oracle.js
//
// The fact space is a list of arbitrary JSON values against a byte budget, so
// the corpus is built from sweeps that are each exhaustive over the dimension
// the rule under test actually reads:
//
//   budget     the drop-oldest loop and its keep-at-least-one floor, over
//              every budget from "fits" to "impossible"
//   bytes      the budget is UTF-8 bytes: pages whose byte total is over the
//              budget while the char and UTF-16 totals are under it
//   hasmore    the `!!hasMore || start > 0` disjunction
//   clip       what clipValue walks: strings, arrays, objects, nesting, and
//              the values it must NOT walk
//   tools      what clipMessageTools accepts as a tool list and as a tool,
//              including the array-tool and missing-input/result cases
//   utf16      the cut boundary in UTF-16 code units, including splitting a
//              surrogate pair
//   unencodable values whose JSON is undefined, which must cost 0 bytes
//   options    the destructuring defaults and the degenerate budgets
//   default-budget  the 4 MiB / 16 KiB defaults at their exact boundaries
const fs = require('node:fs');
const path = require('node:path');
const oracle = require('../../../tests/helpers/legacy-chat-history-frame');

const OUT = path.join(__dirname, 'chat-history-frame-corpus.json');
const cases = [];

// A corpus is JSON, and JSON cannot carry `undefined`: inside an array it
// becomes null, which costs 4 bytes instead of 0 and so would silently turn
// the unencodable sweep into false coverage. The spec therefore carries a
// sentinel that BOTH sides rehydrate -- the generator before it calls the
// oracle, and the Rust test before it calls the kernel.
const UNDEFINED = { __corpusUndefined: true };

function rehydrate(value) {
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object') {
    if (value.__corpusUndefined === true) return undefined;
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = rehydrate(child);
    return out;
  }
  return value;
}

function add(sweep, name, messages, hasMore, options) {
  let fitted;
  try {
    fitted = oracle.fitHistoryFrame(rehydrate(messages), hasMore, options || {});
  } catch (error) {
    // The retired function has no throwing path; a throw here is a generator
    // bug, so it is surfaced instead of frozen.
    throw new Error(`${sweep}/${name}: oracle threw ${error.message}`);
  }
  const live = rehydrate(messages);
  // The sizes the production caller measures: `jsonBytes` per message, in the
  // frozen Node implementation. The Rust bridge takes these (never the page),
  // so the corpus carries them to drive the bridge exactly as production does.
  const sizes = Array.isArray(live) ? live.map(oracle.jsonBytes) : [];
  cases.push({
    sweep,
    name,
    input: { messages, hasMore, options: options || {}, sizes },
    // The kernel is compared on the JSON of the result, which is the wire the
    // frame is headed for. `dropped`/`clipped` ride along as the decisions.
    expected: {
      messages: fitted.messages,
      hasMore: fitted.hasMore,
      dropped: fitted.dropped,
      clipped: fitted.clipped,
    },
  });
}

// A message of a known, exact JSON byte size.
function sized(id, bytes) {
  const shell = JSON.stringify({ id, t: '' }).length;
  return { id, t: 'x'.repeat(Math.max(0, bytes - shell)) };
}

// ── budget ─────────────────────────────────────────────────────────────────
// Four messages of 100 bytes each. Every budget from "all four fit" down to
// "nothing fits" is swept, which walks the loop through every stopping point
// and onto its keep-at-least-one floor.
const four = [sized('a', 100), sized('b', 100), sized('c', 100), sized('d', 100)];
for (const maxBytes of [10000, 400, 399, 300, 299, 200, 199, 100, 99, 1, 0]) {
  add('budget', `four-100B maxBytes=${maxBytes}`, four, false, { maxBytes });
}
// The loop reads sizes, not counts: one big message in front of small ones.
const mixed = [sized('big', 1000), sized('s1', 50), sized('s2', 50)];
for (const maxBytes of [1100, 1099, 150, 100, 99, 50, 49]) {
  add('budget', `1000B+50B+50B maxBytes=${maxBytes}`, mixed, false, { maxBytes });
}
// Length boundaries: nothing, one, two.
add('budget', 'empty list', [], false, { maxBytes: 0 });
add('budget', 'one message under budget', [sized('a', 100)], false, { maxBytes: 1000 });
add('budget', 'one message over budget', [sized('a', 100)], false, { maxBytes: 10 });
add('budget', 'two messages, second alone fits', [sized('a', 100), sized('b', 100)], false, { maxBytes: 100 });
// Not an array at all: `Array.isArray(messages) ? messages : []`.
for (const notList of [null, undefined, 'text', 42, { messages: [] }]) {
  add('budget', `messages=${JSON.stringify(notList) || 'undefined'}`, notList, false, { maxBytes: 10 });
}

// ── bytes ──────────────────────────────────────────────────────────────────
// The budget is in UTF-8 BYTES, not characters and not UTF-16 units. ASCII
// padding cannot tell the three apart, so these use content whose byte, char
// and unit counts all differ: CJK is 3 bytes / 1 char / 1 unit, an emoji is
// 4 bytes / 1 char / 2 units, and an accented Latin letter is 2 bytes / 1 char
// / 1 unit. Each page is built so that the byte total is over the budget while
// BOTH the char total and the unit total are under it, which is the only shape
// in which counting the wrong thing changes the answer.
function padded(id, fill, count) {
  return { id, t: fill.repeat(count) };
}
for (const [label, fill] of [['cjk', '\u4e2d'], ['emoji', '\u{1F600}'], ['accented', '\u00e9']]) {
  const page = [padded('a', fill, 40), padded('b', fill, 40), padded('c', fill, 40)];
  const each = oracle.jsonBytes(page[0]);
  const chars = Array.from(JSON.stringify(page[0])).length;
  const units = JSON.stringify(page[0]).length;
  // Strictly between the char/unit-based size and the byte-based size.
  const between = Math.floor((Math.max(chars, units) + each) / 2) + 1;
  if (!(each > between && between >= Math.max(chars, units) && between > 0)) {
    // 'accented' is 2 bytes vs 1 char, so a gap exists; all three must.
    throw new Error(`bytes/${label}: no gap between ${Math.max(chars, units)} and ${each}`);
  }
  // Three pages: exactly one message fits per char/unit count but not per
  // byte count, so the correct answer drops where a wrong count would not.
  add('bytes', `${label} page budget between char count and byte count`, page, false,
    { maxBytes: between * 3 });
  add('bytes', `${label} page budget exactly at the byte total`, page, false,
    { maxBytes: each * 3 });
  add('bytes', `${label} page budget one under the byte total`, page, false,
    { maxBytes: each * 3 - 1 });
}

// ── hasmore ────────────────────────────────────────────────────────────────
// `!!hasMore || start > 0`, over both halves of the disjunction.
for (const hasMore of [false, true, 0, 1, '', 'yes', null, undefined, [], {}]) {
  add('hasmore', `hasMore=${JSON.stringify(hasMore) ?? 'undefined'} nothing dropped`,
    [sized('a', 100)], hasMore, { maxBytes: 10000 });
  add('hasmore', `hasMore=${JSON.stringify(hasMore) ?? 'undefined'} something dropped`,
    four, hasMore, { maxBytes: 100 });
}

// ── clip ───────────────────────────────────────────────────────────────────
// Everything clipValue can meet. The budget is 0 so the clip always runs, and
// the tool string limit is small so the cut is visible.
const CLIP_VALUES = [
  ['short string', 'abc'],
  ['long string', 'y'.repeat(40)],
  ['exactly at limit', 'z'.repeat(8)],
  ['one over limit', 'z'.repeat(9)],
  ['empty string', ''],
  ['number', 12345],
  ['true', true],
  ['null', null],
  ['array of strings', ['y'.repeat(40), 'ok']],
  ['nested array', [['y'.repeat(40)], ['ok']]],
  ['object', { deep: 'y'.repeat(40), keep: 1 }],
  ['nested object', { a: { b: { c: 'y'.repeat(40) } } }],
  ['array inside object', { list: ['y'.repeat(40)] }],
  ['object inside array', [{ k: 'y'.repeat(40) }]],
  ['empty array', []],
  ['empty object', {}],
];
for (const [label, value] of CLIP_VALUES) {
  add('clip', `input=${label}`,
    [{ role: 'assistant', tools: [{ name: 't', input: value }] }], false,
    { maxBytes: 0, toolStringChars: 8 });
  add('clip', `result=${label}`,
    [{ role: 'assistant', tools: [{ name: 't', result: value }] }], false,
    { maxBytes: 0, toolStringChars: 8 });
}

// ── tools ──────────────────────────────────────────────────────────────────
// What counts as a tool list, and what counts as a tool.
const TOOL_LISTS = [
  ['absent', undefined],
  ['null', null],
  ['empty array', []],
  ['not an array', { 0: { input: 'y'.repeat(40) } }],
  ['string', 'tools'],
];
for (const [label, tools] of TOOL_LISTS) {
  const message = { role: 'assistant', text: 'y'.repeat(40) };
  if (tools !== undefined) message.tools = tools;
  add('tools', `list=${label}`, [message], false, { maxBytes: 0, toolStringChars: 8 });
}
const TOOLS = [
  ['object with both', { name: 'n', input: 'y'.repeat(40), result: 'z'.repeat(40) }],
  ['object with neither', { name: 'n' }],
  ['object with input only', { name: 'n', input: 'y'.repeat(40) }],
  ['object with result only', { name: 'n', result: 'y'.repeat(40) }],
  ['object with input before name', { input: 'y'.repeat(40), name: 'n' }],
  ['empty object', {}],
  // `typeof tool === 'object'` is true for an array, so it is spread into an
  // object with index keys.
  ['array', ['y'.repeat(40), 'b']],
  ['empty array', []],
  ['null', null],
  ['string', 'y'.repeat(40)],
  ['number', 7],
  ['false', false],
];
for (const [label, tool] of TOOLS) {
  add('tools', `tool=${label}`,
    [{ role: 'assistant', tools: [tool] }], false, { maxBytes: 0, toolStringChars: 8 });
}
add('tools', 'several tools of mixed kinds',
  [{ role: 'assistant', tools: TOOLS.map(([, tool]) => tool) }], false,
  { maxBytes: 0, toolStringChars: 8 });
// The clip is applied to every kept message, and `tools` keeps its position.
add('tools', 'two messages both clipped',
  [{ role: 'user', tools: [{ input: 'y'.repeat(40) }] },
    { role: 'assistant', tools: [{ result: 'y'.repeat(40) }] }], false,
  { maxBytes: 0, toolStringChars: 8 });
add('tools', 'tools is not the last key',
  [{ role: 'assistant', tools: [{ input: 'y'.repeat(40) }], trailing: 'kept' }], false,
  { maxBytes: 0, toolStringChars: 8 });
// A message that is not an object at all.
for (const [label, message] of [['null', null], ['string', 'y'.repeat(40)], ['number', 1],
  ['array', ['y'.repeat(40)]]]) {
  add('tools', `message=${label}`, [message], false, { maxBytes: 0, toolStringChars: 8 });
}

// ── utf16 ──────────────────────────────────────────────────────────────────
// `length` and `slice` are UTF-16 code units, so an emoji costs two and a cut
// can split a surrogate pair.
const EMOJI = '\u{1F600}'; // one astral character, two code units
for (const limit of [0, 1, 2, 3, 4, 5, 6]) {
  add('utf16', `emoji run limit=${limit}`,
    [{ role: 'assistant', tools: [{ input: EMOJI.repeat(3) }] }], false,
    { maxBytes: 0, toolStringChars: limit });
  add('utf16', `ascii then emoji limit=${limit}`,
    [{ role: 'assistant', tools: [{ input: `ab${EMOJI}cd` }] }], false,
    { maxBytes: 0, toolStringChars: limit });
}
add('utf16', 'cjk counts one unit each',
  [{ role: 'assistant', tools: [{ input: '中文测试文本' }] }], false,
  { maxBytes: 0, toolStringChars: 3 });
add('utf16', 'combining mark is its own unit',
  [{ role: 'assistant', tools: [{ input: 'ééé' }] }], false,
  { maxBytes: 0, toolStringChars: 3 });

// ── unencodable ────────────────────────────────────────────────────────────
// `jsonBytes` returns 0 when JSON.stringify yields undefined, so the message
// costs nothing. Only values a corpus can carry through JSON are used for the
// round trip; the undefined-valued ones are built structurally below.
add('unencodable', 'undefined among sized messages',
  [UNDEFINED, sized('a', 100), sized('b', 100)], false, { maxBytes: 100 });
add('unencodable', 'only undefined', [UNDEFINED], false, { maxBytes: 0 });
// The decisive case: three messages whose JSON totals 100 bytes only because
// the two undefined ones cost nothing. Read as null they would total 108 and
// two messages would be dropped, so this case fails loudly if either side
// stops treating an unencodable message as free.
add('unencodable', 'undefined is never the reason to drop',
  [UNDEFINED, UNDEFINED, sized('a', 100)], false, { maxBytes: 100 });
add('unencodable', 'undefined next to a message that must be dropped',
  [UNDEFINED, sized('a', 100), UNDEFINED, sized('b', 100)], false, { maxBytes: 100 });
// Inside a tool: an undefined value is simply absent from the JSON, which is
// also what the kernel's `Undefined` produces.
add('unencodable', 'undefined tool input',
  [{ role: 'assistant', tools: [{ name: 'n', input: UNDEFINED, result: 'y'.repeat(40) }] }],
  false, { maxBytes: 0, toolStringChars: 8 });

// ── options ────────────────────────────────────────────────────────────────
// The destructuring defaults, and budgets that cannot be satisfied.
add('options', 'no options object', four, false, undefined);
add('options', 'empty options uses both defaults', four, false, {});
add('options', 'maxBytes undefined uses the default', four, false, { maxBytes: undefined });
add('options', 'toolStringChars undefined uses the default',
  [{ role: 'assistant', tools: [{ input: 'y'.repeat(40) }] }], false,
  { maxBytes: 0, toolStringChars: undefined });
add('options', 'maxBytes 0 with one message', [sized('a', 100)], false, { maxBytes: 0 });
add('options', 'toolStringChars 0 clips everything to the marker',
  [{ role: 'assistant', tools: [{ input: 'abc' }] }], false,
  { maxBytes: 0, toolStringChars: 0 });
add('options', 'huge maxBytes never drops or clips', four, false, { maxBytes: Number.MAX_SAFE_INTEGER });
// The default clip limit is 16 KiB of UTF-16 units. 16384 stays, 16385 is cut.
for (const length of [16383, 16384, 16385]) {
  add('options', `default toolStringChars at ${length} units`,
    [{ role: 'assistant', tools: [{ name: 't', input: 'q'.repeat(length) }] }], false,
    { maxBytes: 0 });
}
add('options', 'default budget leaves a normal page alone',
  [sized('a', 1000), sized('b', 1000)], false, {});

// ── default-budget ─────────────────────────────────────────────────────────
// The 4 MiB default is the number the 2026-10-01 incident was fixed with, so it
// is pinned at its boundary. The decision depends only on message sizes, so
// these cases carry sizes and the expectation comes from running the frozen
// oracle on real messages of exactly those sizes -- the corpus never stores the
// megabytes. Both sides are driven with NO maxBytes option, i.e. the default.
const MIB = 1024 * 1024;
const planCases = [];
function addPlan(name, bytesList, hasMore = false) {
  const messages = bytesList.map((bytes, index) => sized(`m${index}`, bytes));
  const sizes = messages.map(oracle.jsonBytes);
  if (sizes.some((size, index) => size !== bytesList[index])) {
    throw new Error(`default-budget/${name}: sized() missed its target ${sizes} vs ${bytesList}`);
  }
  const fitted = oracle.fitHistoryFrame(messages, hasMore, {});
  planCases.push({
    sweep: 'default-budget',
    name,
    input: { sizes, hasMore },
    expected: { hasMore: fitted.hasMore, dropped: fitted.dropped, clipped: fitted.clipped },
  });
}
addPlan('one page exactly at 4 MiB', [4 * MIB]);
addPlan('one page one byte over 4 MiB (floor keeps it, clip runs)', [4 * MIB + 1]);
addPlan('two halves exactly at 4 MiB', [2 * MIB, 2 * MIB]);
addPlan('two halves one byte over 4 MiB', [2 * MIB, 2 * MIB + 1]);
addPlan('three pieces one byte over 4 MiB', [MIB, MIB, 2 * MIB + 1]);
addPlan('the 2026-10-01 incident: 4 messages totalling 9.2 MB',
  [Math.floor(9.2 * 1000 * 1000 / 4), Math.floor(9.2 * 1000 * 1000 / 4),
    Math.floor(9.2 * 1000 * 1000 / 4), Math.floor(9.2 * 1000 * 1000 / 4)]);
addPlan('just under 2 MiB', [2 * MIB - 1]);
addPlan('hasMore carried through a default-budget page', [MIB], true);

const counts = {};
for (const c of cases) counts[c.sweep] = (counts[c.sweep] || 0) + 1;
fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: '2026-11-20',
  oracle: 'tests/helpers/legacy-chat-history-frame.js',
  counts,
  cases,
  planCases,
}, null, 1)}\n`);
console.log(`wrote ${cases.length} cases + ${planCases.length} default-budget plans to ${path.relative(process.cwd(), OUT)}`);
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
