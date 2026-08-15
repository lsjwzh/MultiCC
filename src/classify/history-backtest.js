'use strict';

const { parseTaskAttribution } = require('./task-attribution');

// A deterministic fake model for replaying historical conversations. Fixtures
// own the raw model text, so parser/prompt/state-machine changes can be tested
// without network calls or a healthy Aux provider.
function createFakeAuxModel(responses = {}) {
  const table = responses instanceof Map ? responses : new Map(Object.entries(responses));
  const calls = [];
  return Object.freeze({
    calls,
    async complete(request = {}) {
      const caseId = String(request.caseId || '');
      calls.push({ ...request });
      if (!table.has(caseId)) throw new Error(`fake Aux response missing: ${caseId}`);
      return { text: String(table.get(caseId)) };
    },
  });
}

async function runHistoryBacktest(cases, model, { parse = parseTaskAttribution } = {}) {
  const results = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    const response = await model.complete({
      caseId: item.id,
      systemPrompt: item.systemPrompt || '',
      prompt: item.prompt || '',
      history: item.history || [],
    });
    const actual = parse(response.text, {
      fallbackTaskId: item.fallbackTaskId || null,
      allowedTaskIds: Array.isArray(item.allowedTaskIds) ? item.allowedTaskIds : null,
    });
    const expected = item.expected || {};
    const mismatches = Object.keys(expected)
      .filter(key => actual[key] !== expected[key])
      .map(key => ({ key, expected: expected[key], actual: actual[key] }));
    results.push({ id: item.id, ok: mismatches.length === 0, actual, expected, mismatches });
  }
  return Object.freeze({
    total: results.length,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  });
}

function expectedFromRun(run = {}) {
  const parsed = run.parsed && typeof run.parsed === 'object' ? run.parsed : {};
  const relation = parsed.relation === 'new' ? 'new' : 'same';
  const expected = {
    taskName: String(parsed.taskName || parsed.goal || '').trim(),
    phase: parsed.phase || null,
    relation,
    taskId: relation === 'new' ? null : parsed.taskId || run.taskId || null,
  };
  return expected;
}

// Convert durable aux-run JSONL records into the same deterministic fake-model
// corpus used by hand-authored cases. This replays parser/normalisation changes
// against exactly what the historical model returned; it does not call a model.
function corpusFromAuxRuns(runs) {
  const cases = [];
  const responses = {};
  for (const [index, run] of (Array.isArray(runs) ? runs : []).entries()) {
    if (!run || typeof run.rawText !== 'string' || !run.rawText.trim()) continue;
    const id = String(run.runId || `aux-run-${index}`);
    const expected = expectedFromRun(run);
    const allowedTaskIds = [...new Set([
      run.priorTaskId, run.taskId, expected.taskId,
    ].filter(Boolean))];
    cases.push({
      id,
      systemPrompt: run.systemPrompt || '',
      prompt: run.prompt || '',
      fallbackTaskId: run.priorTaskId || run.taskId || null,
      allowedTaskIds,
      expected,
    });
    responses[id] = run.rawText;
  }
  return { cases, responses };
}

module.exports = {
  corpusFromAuxRuns,
  createFakeAuxModel,
  expectedFromRun,
  runHistoryBacktest,
};
