'use strict';

// Classify vocabulary + parsing. The authoritative tables and every
// logic-bearing rule live in native/core/src/classify_vocab.rs:
// parsing the classifier's 3-line text output into {state, goal, phase}, the
// per-state display map, phase labels, the ✅ sub-state rules and the
// classifier system prompt. This module takes one catalogue snapshot at load,
// freezes it, and serves the table lookups locally; the logic calls cross the
// native boundary. Deterministic, no I/O, no host state. Pinned behaviours
// (retired C collapses to W, the UPPERCASE-phase label fallback, the
// reference-identity fast path below) are guarded by tests/test-classify-vocab.js.

const { getNative } = require('../native/runtime');
const { apiErrorSignaturesQuoted } = require('../chat/api-error-policy');

const native = getNative();

const CATALOG = JSON.parse(native.classifyVocabCatalog());

// ── Frozen tables (snapshot from Rust; the single source of truth) ──────────
const CLASSIFY_DISPLAY = CATALOG.classifyDisplay;
const PHASE_LABELS = CATALOG.phaseLabels;
const GOAL_STATES = Object.freeze(CATALOG.goalStates);
const TURN_RUN_STATES = Object.freeze(CATALOG.turnRunStates);
const OPEN_RUN_STATES = Object.freeze(CATALOG.openRunStates);
const CLASSIFY_STATES = new Set(CATALOG.classifyStates);
const CLASSIFY_TURN_OUTCOME = Object.freeze(CATALOG.classifyTurnOutcome);

// ── Logic calls (native) ────────────────────────────────────────────────────

/** Normalize the shared goal/phase/state classifier response. */
function parseClassifyResult(text) {
  return JSON.parse(native.parseClassifyResult(String(text ?? '')));
}

function request(op, input) {
  return JSON.parse(native.classifyVocabRequest(op, JSON.stringify(input)));
}

// Structured tool evidence is authoritative for "waiting on user". The Aux
// classifier still owns goal/phase and remains the legacy fallback when no
// signal exists, but it cannot override an unresolved explicit request.
// The untouched path returns the SAME reference it was given (callers and the
// golden tests rely on identity here); only the override crosses to Rust.
function applyUserInputEvidence(result, pendingUserInput) {
  if (!pendingUserInput || pendingUserInput.resolved === true) return result;
  return request('applyUserInputEvidence', { result, pendingUserInput });
}

/** 这一轮判定的「执行成功」子状态：achieved / interact / null（没有子状态）。 */
function goalStateForClassify(result) {
  return request('goalStateForClassify', { result: result ?? null });
}

/** 这个值是不是一个已知的子状态？（读回来的旧记录 / 客户端传来的值都要过这一关） */
function isGoalState(value) {
  return value === GOAL_STATES.achieved || value === GOAL_STATES.interact;
}

/**
 * 子状态裁定：模型在 classify 里直接推理的 goalState 优先（允许与 phase 不同——
 * 它问的是「目标成没成、要不要用户再推一把」，不是「推进到哪一步」）；没给或不
 * 认识的值回退 goalStateForClassify 的 phase 映射。非 D 一律 null。
 */
function resolveGoalState(state, modelValue, result) {
  return request('resolveGoalState', {
    state: state ?? null,
    modelValue: modelValue ?? null,
    result: result ?? null,
  });
}

// D 的二次分组键（派生值，不落盘）：老系统/老 App 只认 classifyState 本身
// （D/W/B/E/P，见下方 CLASSIFY_STATES），一旦看到 'D' 就照旧工作。新系统如果
// 需要按「达成目标 / 需要交互」二次分组（如"把需要交互的任务和等我回答的放一起"），
// 现算现用这个函数，不新增一个跟 goalState 表达同一件事的存储字段。
function classifyGroupKey(state, goalState) {
  return request('classifyGroupKey', { state: state ?? null, goalState: goalState ?? null });
}

// Build the classify system prompt (instructions only, no data). The API error
// signatures for the E-detection line still come from api-error-policy — that
// table moves when the error policy itself migrates.
function buildClassifySystemPrompt(priorGoal) {
  return request('buildSystemPrompt', {
    priorGoal: priorGoal ?? null,
    errorSignatures: apiErrorSignaturesQuoted(),
  }).prompt;
}

// ── Table lookups (local, snapshot-driven — nothing crosses per call) ───────

// Helpers
function classifyDisplay(cls) { return CLASSIFY_DISPLAY[cls] || CLASSIFY_DISPLAY['W']; }
/** classify letter (D/C/W/B/E/P) → its canonical turn run state. */
function runStateForClassify(cls) { return classifyDisplay(cls).cardStatus; }
function phaseLabel(ph) { return PHASE_LABELS[ph] || ''; }

// Semantic predicates over the classify LETTER — the single source for "what
// does this state mean for my subsystem?". Downstream code MUST use these
// instead of inline `=== 'D'` / `=== 'W'` checks (tests/test-classify-vocab.js
// fails the build on a fresh inline letter comparison outside this file).
// The letters answer three independent questions:
//   Who is acting?      P/C a turn is in flight · W the user · B a background job
//   Did a turn end?     D cleanly · E in a fault or an explicit cancel
//   May I move it on?   D/W settle it · P/W/B mean something is still outstanding
function isProcessingLetter(cls) { return cls === 'P' || cls === 'C'; }
function isWaitForUserLetter(cls) { return cls === 'W'; }
function isBackgroundLetter(cls) { return cls === 'B'; }
function isTerminalLetter(cls) { return cls === 'D'; }
function isAbnormalLetter(cls) { return cls === 'E'; }
function isSettledLetter(cls) { return isTerminalLetter(cls) || isWaitForUserLetter(cls); }
function isParkedLetter(cls) { return isWaitForUserLetter(cls) || isBackgroundLetter(cls); }
function isOutcomeLetter(cls) { return isTerminalLetter(cls) || isAbnormalLetter(cls); }

/** Is this run state one whose run is still open (and therefore stoppable)? */
function isOpenRunState(state) { return OPEN_RUN_STATES.includes(state); }

// Scheduler events carry this explicit outcome alongside the classify letter.
function turnOutcomeForClassify(cls) {
  return CLASSIFY_TURN_OUTCOME[cls] || 'waiting_user';
}

module.exports = {
  parseClassifyResult,
  buildClassifySystemPrompt,
  classifyDisplay,
  runStateForClassify,
  phaseLabel,
  applyUserInputEvidence,
  // Letter semantics — the only sanctioned way to ask what a letter means.
  isProcessingLetter,
  isWaitForUserLetter,
  isBackgroundLetter,
  isTerminalLetter,
  isAbnormalLetter,
  isSettledLetter,
  isParkedLetter,
  isOutcomeLetter,
  turnOutcomeForClassify,
  // 「执行成功」的三个子状态：判定 + 值域（展示层读它，不自己推）。
  goalStateForClassify,
  resolveGoalState,
  isGoalState,
  classifyGroupKey,
  GOAL_STATES,
  CLASSIFY_DISPLAY,
  CLASSIFY_STATES,
  CLASSIFY_TURN_OUTCOME,
  TURN_RUN_STATES,
  OPEN_RUN_STATES,
  isOpenRunState,
  PHASE_LABELS,
};
