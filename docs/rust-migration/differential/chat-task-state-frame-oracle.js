'use strict';
// Writes the frozen corpus for multicc_core::chat_task_state_frame from the
// frozen Node transcription in tests/helpers/legacy-chat-task-state-frame.js.
//
// Run: node docs/rust-migration/differential/chat-task-state-frame-oracle.js
//
// Sweeps, each exhaustive over the dimensions its rule reads:
//
//   gate      the seed decision: goal x phase x apiError, over every value
//             class each of those three can hold
//   fields    every payload field against every value class, so no `||`
//             fallback and no vocabulary gate can be dropped silently
//   cancel    the cancelReason-gated-on-cancelledAt pair, exhaustively
//   aux       the live health reading, including a task record that tries to
//             override it
//   shape     a task that is not an object at all
const fs = require('node:fs');
const path = require('node:path');
const oracle = require('../../../tests/helpers/legacy-chat-task-state-frame');

const OUT = path.join(__dirname, 'chat-task-state-frame-corpus.json');
const cases = [];

// JSON cannot carry `undefined`, so an absent key stands for it: the payload
// reads every field with `||`, for which absent and undefined are identical.
function add(sweep, name, task, facts) {
  cases.push({
    sweep,
    name,
    input: { task, facts },
    expected: {
      seeds: oracle.seeds(task, facts),
      seed: oracle.taskStateSeed(task, facts),
      payload: oracle.taskStatePayload(task, facts),
    },
  });
}

const BASE_FACTS = { taskShortCode: 'ABCD', auxUnhealthy: false, auxUnhealthySince: null };

// Every value class a string-ish field can hold, including the falsy ones the
// `||` fallbacks exist for.
const VALUES = [
  ['absent', undefined],
  ['null', null],
  ['empty string', ''],
  ['string', 'value'],
  ['zero', 0],
  ['number', 7],
  ['false', false],
  ['true', true],
  ['object', { nested: 1 }],
  ['array', ['a']],
];

// ── gate ───────────────────────────────────────────────────────────────────
// `goal || (phase && phase !== 'idle') || apiError`, exhaustive over the three
// terms. `phase` also gets 'idle' explicitly, which is the one value that is
// truthy but still not a judgement.
const PHASES = [...VALUES, ['idle', 'idle'], ['running', 'running']];
for (const [goalLabel, goal] of VALUES) {
  for (const [phaseLabel, phase] of PHASES) {
    for (const [errLabel, apiError] of [['absent', undefined], ['null', null],
      ['empty string', ''], ['envelope', { code: 'upstream' }]]) {
      const task = {};
      if (goal !== undefined) task.goal = goal;
      if (phase !== undefined) task.phase = phase;
      if (apiError !== undefined) task.apiError = apiError;
      add('gate', `goal=${goalLabel} phase=${phaseLabel} apiError=${errLabel}`, task, BASE_FACTS);
    }
  }
}

// ── fields ─────────────────────────────────────────────────────────────────
// Each payload field against every value class, with a goal present so the
// seed gate is open and the frame is actually produced.
for (const field of ['goal', 'phase', 'classifyState', 'goalState', 'apiError']) {
  for (const [label, value] of VALUES) {
    const task = { goal: 'present' };
    if (value !== undefined) task[field] = value; else delete task[field];
    add('fields', `${field}=${label}`, task, BASE_FACTS);
  }
}
// The goal-state vocabulary gate is an identity test: only these two pass.
for (const goalState of ['achieved', 'interact', 'ACHIEVED', 'Interact', 'achieved ',
  'done', '', 'D-G', 'null']) {
  add('fields', `goalState=${JSON.stringify(goalState)}`,
    { goal: 'g', goalState }, BASE_FACTS);
}
// taskShortCode comes from the facts, never from the record.
for (const taskShortCode of ['', 'ABCD', '中文']) {
  add('fields', `taskShortCode=${JSON.stringify(taskShortCode)}`,
    { goal: 'g', taskId: 'task-1', taskShortCode: 'FROM-RECORD' },
    { ...BASE_FACTS, taskShortCode });
}

// ── cancel ─────────────────────────────────────────────────────────────────
// `cancelledAt ? (cancelReason || null) : null`, exhaustive over both.
for (const [atLabel, cancelledAt] of VALUES) {
  for (const [reasonLabel, cancelReason] of VALUES) {
    const task = { goal: 'g' };
    if (cancelledAt !== undefined) task.cancelledAt = cancelledAt;
    if (cancelReason !== undefined) task.cancelReason = cancelReason;
    add('cancel', `cancelledAt=${atLabel} cancelReason=${reasonLabel}`, task, BASE_FACTS);
  }
}

// ── aux ────────────────────────────────────────────────────────────────────
// The live reading, and a record that tries to override it.
// `health.sinceAt` is `Date.now()` in production (src/routes/aux-goal.js sets
// it from a number), so the real reading is a NUMBER. The first version of the
// kernel only accepted a string and would have turned every real unhealthy
// reading into null; an ISO string alone did not catch it, so the numeric
// forms are first-class here. 0 is included to pin pass-through: the caller
// applies `|| null`, the kernel must not.
for (const auxUnhealthy of [false, true]) {
  for (const auxUnhealthySince of [null, '2026-11-20T00:00:00.000Z', 1763600000000, 1, 0, 1.5]) {
    add('aux', `unhealthy=${auxUnhealthy} since=${auxUnhealthySince}`,
      { goal: 'g' }, { ...BASE_FACTS, auxUnhealthy, auxUnhealthySince });
    add('aux', `unhealthy=${auxUnhealthy} since=${auxUnhealthySince} record tries to override`,
      { goal: 'g', auxUnhealthy: !auxUnhealthy, auxUnhealthySince: 'FROM-RECORD' },
      { ...BASE_FACTS, auxUnhealthy, auxUnhealthySince });
  }
}

// ── shape ──────────────────────────────────────────────────────────────────
// `!task` and `task || {}` over the non-object task values.
for (const [label, task] of VALUES) {
  add('shape', `task=${label}`, task, BASE_FACTS);
}
add('shape', 'task is an empty object', {}, BASE_FACTS);
add('shape', 'every field at once', {
  goal: 'ship it', taskId: 't-1', phase: 'P', classifyState: 'D', goalState: 'interact',
  apiError: { code: 'upstream', status: 429 }, cancelledAt: '2026-11-20T01:02:03.000Z',
  cancelReason: 'user stopped it',
}, { taskShortCode: 'WXYZ', auxUnhealthy: true, auxUnhealthySince: '2026-11-20T00:00:00.000Z' });

const counts = {};
for (const c of cases) counts[c.sweep] = (counts[c.sweep] || 0) + 1;
fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: '2026-11-20',
  oracle: 'tests/helpers/legacy-chat-task-state-frame.js',
  counts,
  cases,
}, null, 1)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), OUT)}`);
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
