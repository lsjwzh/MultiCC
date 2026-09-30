'use strict';

// Classify vocabulary + parsing (pure, extracted verbatim from server.js).
// Single source of truth for: parsing the classifier's 3-line text output
// into {state, goal, phase, background, error}; the per-state display map
// (CLASSIFY_DISPLAY) and phase labels (PHASE_LABELS); and the classifier
// system prompt. No I/O and no host state -- deterministic given its inputs.

const { apiErrorSignaturesQuoted } = require('../chat/api-error-policy');

// Normalize the shared goal/phase/state classifier response.
function parseClassifyResult(text) {
  // DeepSeek thinking-block guard: strip everything before the marker.
  let clean = String(text || '');
  const thinkEnd = clean.indexOf('<｜end▁of▁thinking｜>');
  if (thinkEnd !== -1) clean = clean.slice(thinkEnd + '<｜end▁of▁thinking｜>'.length);
  clean = clean.replace(/<\/?think>/g, '').replace(/^[\s\n]*/, '');

  const lines = clean.trim().split('\n').map(l => l.trim()).filter(Boolean);

  // Goal (line 1). Cap at 60 chars; strip leading labels the model may emit.
  const goal = (lines[0] || '')
    .replace(/^(第1行[:：]|目标[:：]|goal[:：]?)\s*/i, '')
    .slice(0, 60);

  // Phase (line 2). Chinese codes preferred, English synonyms tolerated.
  const phaseRaw = (lines[1] || '')
    .replace(/^(第2行[:：]|阶段[:：]|phase[:：]?)\s*/i, '')
    .trim();
  // Normalize phase: the classify prompt outputs either Chinese or English;
  // normalise to the canonical English key used by PHASE_LABELS.
  const phase = PHASE_LABELS[phaseRaw]
    ? phaseRaw                                         // already an English key
    : Object.entries(PHASE_LABELS).find(([, v]) => v === phaseRaw)?.[0]  // Chinese → key
    || PHASE_LABELS[phaseRaw.toLowerCase()]            // case-insensitive
    || Object.entries(PHASE_LABELS).find(([, v]) => v === phaseRaw.toLowerCase())?.[0]
    || null;

  // State (line 3). Single letter: D/W/B/E/P. The letter IS the state — single
  // source of truth. C is RETIRED (collapsed to W here); unknown → W (safe
  // default, NEVER completed). No word+flags intermediate: downstream reads the
  // letter directly via classifyDisplay() / the helpers in CLASSIFY_DISPLAY.
  const stateRaw = (lines[2] || '')
    .toUpperCase()
    .replace(/^(第3行[:：]|状态[:：]|state[:：]?)\s*/i, '')
    .trim();
  const first = stateRaw.slice(0, 1);

  let state;
  if (first === 'P') state = 'P';
  else if (first === 'D') state = 'D';
  else if (first === 'E') state = 'E';
  else if (first === 'B') state = 'B';
  // C retired → W (see CLASSIFY_DISPLAY.C note). W and unknown both → W.
  else state = 'W';   // W, C, or unparseable — safe default, never D

  // Garbage filter for goal — block model regurgitation of system prompts,
  // classify-template phrases, API errors, and other non-task noise.
  let goalOk = goal.length >= 2 && goal.length <= 80;
  if (goalOk) {
    const _g = goal.toLowerCase();
    const _garbage =
      /api\s*error|insufficient\s*balance|自动恢复|异常中断|claude exited|status[_= ]?5\d\d|\b40[0-9]\b|\b50[0-9]\b|(<.parameter>)/i.test(_g)
      || (/\berror\b/.test(_g) && goal.length < 12)
      || /^(第[123]行|当前.*任务.*目标|任务状态分析|对话主动权|闭环任务|判断当前)/.test(goal);
    if (_garbage) goalOk = false;
  }
  const finalGoal = goalOk ? goal : '';

  return { state, goal: finalGoal, phase };
}

// ── Unified classify display map ────────────────────────────────────────────
// Single source of truth for how each classify-state LETTER (D/C/W/B/E/P)
// renders across ALL channels: classify bar, push notification, voice/TTS,
// toast, card status. Every display path MUST read from here — no inline maps.
const CLASSIFY_DISPLAY = {
  D: {  // Succeeded — this turn executed successfully (terminal turn outcome)
    label: '执行成功',
    pushType: 'succeeded', pushTitle: '执行成功',
    voiceText: '本轮执行成功', ding: 'succeeded',
    cardStatus: 'succeeded', barTint: 'succeeded',
  },
  C: {  // Continue — RETIRED. parseClassifyResult collapses C→W, so no new C is
        // ever produced. Retained ONLY so a legacy persisted 'C' (older taskState /
        // classifyHistory) still renders without falling through classifyDisplay's
        // W fallback; the periodic scan re-judges any live C into W within one pass.
    label: '继续中',
    pushType: null, pushTitle: null,
    voiceText: null, ding: null,
    cardStatus: 'running', barTint: 'running',
  },
  W: {  // Wait on user
    label: '等待用户',
    pushType: 'waiting', pushTitle: '等待操作',
    voiceText: '等待你的操作', ding: 'waiting',
    cardStatus: 'waiting', barTint: 'waiting',
  },
  B: {  // Wait on background task (terminal only; chat prompt no longer emits B)
    label: '后台等待',
    // Own wording, NOT W's borrowed '等待操作': nothing is waiting on the user
    // while a background job runs, so telling them to act is the same lie the
    // card used to tell. src/push/notification-copy.js reads this (as it reads
    // every other letter's pushTitle), so the lock screen and the card agree.
    pushType: 'waiting', pushTitle: '后台等待',
    voiceText: '等待后台任务', ding: 'waiting',
    // Its own run state, NOT `waiting`. `waiting` means "the user must answer";
    // a turn idling on a background job has nothing to ask, so folding B into it
    // made every Air card and session row say 「等待回答」 about work the user
    // cannot act on. Both projections read one value, like E's below.
    cardStatus: 'background', barTint: 'background',
  },
  E: {  // Abnormal end — API error, or an explicit user/watchdog cancellation
    label: 'API 异常',
    pushType: 'error', pushTitle: '出现异常',
    voiceText: 'API 异常中断，等待重试中', ding: 'error',
    // cardStatus MUST equal barTint's fault semantics: E used to render as
    // `waiting` on cards and `error` on the bar, so one terminal fact showed up
    // as ⏸️ in the session list and ❌ in the chat bar — the exact "internal
    // error / external something-else" split the cancel path was blamed for.
    // Both projections now read one value.
    cardStatus: 'error', barTint: 'error',
  },
  P: {  // Processing — mid-turn only
    label: '处理中',
    pushType: null, pushTitle: null,
    voiceText: null, ding: null,
    cardStatus: 'running', barTint: 'running',
  },
  G: {  // Goal achieved — a D whose goalStateForClassify() sub-state is
        // 'achieved'. state-machine.js persists this LETTER instead of D so a
        // future filter can key on the letter directly (grouping/secondary
        // judgement), not just the goalState metadata field. Icon/tone/priority
        // stay identical to D on purpose — only the badge word differs.
    label: '达成目标',
    pushType: 'succeeded', pushTitle: '执行成功',
    voiceText: '本轮执行成功', ding: 'succeeded',
    cardStatus: 'succeeded', barTint: 'succeeded',
  },
  N: {  // Need interaction — a D whose goalStateForClassify() sub-state is
        // 'interact'. Same reasoning as G above; kept out of the 'A' name
        // because task-context-host.js's dead `classifyState === 'A'` branch
        // and its accompanying test (test-task-board.js) already claim that
        // letter for a retired, unrelated meaning.
    label: '需要交互',
    pushType: 'succeeded', pushTitle: '执行成功',
    voiceText: '本轮执行成功', ding: 'succeeded',
    cardStatus: 'succeeded', barTint: 'succeeded',
  },
};

// Phase labels — centralized, used by both classify-in-progress path and
// dispatchStateAction. Formerly repeated inline at L7008 and L7902.
const PHASE_LABELS = {
  planning: '规划中', implementing: '实现中', verifying: '验证中',
  wrapping: '收尾中', done: '已完成',
};

// ── 「执行成功」的三个子状态（展示层，2026-09-29）────────────────────────────
//
// D 说的是**这一轮**正常收尾，不是「这件事做完了」：线上 2218 条 D 判定里只有 1293
// 条带着 phase=已完成，其余分别停在 实现中/验证中/收尾中/规划中。用户要的是把 ✅
// 那一格再分三档（图标不变，仍是 ✅）：
//
//   达成目标（achieved）— 有目标，且当前任务的所有要求都做完了
//   需要交互（interact）— 有目标，但还得用户再推一把才走得下去
//   执行成功（没有子状态）— 压根没有目标（纯招呼/系统消息），没什么可"达成"的
//
// 判定只读 classify 已经产出的两个字段（goal、phase），不新增模型输出、不看自然
// 语言：phase 的语义本来就是「把当前任务所有要求都做完了才判已完成」，与「目标达成」
// 是同一件事的两种说法，另起一问只会得到两个偶尔互相矛盾的答案。
//
// 字母不是 D 时没有子状态 —— 那时卡片显示的是 W/B/E 自己的词，这三档只挂在 ✅ 上。
const GOAL_STATES = Object.freeze({ achieved: 'achieved', interact: 'interact' });

/** 这一轮判定的「执行成功」子状态：achieved / interact / null（没有子状态）。 */
function goalStateForClassify(result) {
  if (!isTerminalLetter(result?.state)) return null;
  const goal = String(result?.goal || '').trim();
  // '—' / '-' 是提示词约定的「没有任务」占位符（同 parseClassifyResult 的垃圾过滤）。
  if (!goal || goal === '—' || goal === '-') return null;
  return result?.phase === 'done' ? GOAL_STATES.achieved : GOAL_STATES.interact;
}

/** 这个值是不是一个已知的子状态？（读回来的旧记录 / 客户端传来的值都要过这一关） */
function isGoalState(value) {
  return value === GOAL_STATES.achieved || value === GOAL_STATES.interact;
}

// The renderable turn run-state vocabulary. ONE server-side list: every
// run-state producer (session-work-host.getRunState, task-board aggregation,
// workspace status) emits only these, and each classify letter's `cardStatus`
// above is one of them. task-board.normalize builds its TASK_RUN_STATES set
// from this, so the two can never drift apart.
const TURN_RUN_STATES = Object.freeze([
  'queued', 'running', 'waiting', 'background', 'succeeded', 'error', 'idle',
]);

// The subset of TURN_RUN_STATES that means "a run is still open": executing,
// queued, waiting for the user, or parked on a background job. `background`
// counts — that turn is idle only because a job it started is still out there,
// so nothing about the task has settled. This is the ONE list behind every
// "may I touch this task?" guard: deleting/relocating
// (task-board/lifecycle-host.js), and the stop affordance
// the UIs draw (public/status-presentation.js canStopRunState, mirrored in
// app/lib/utils/status_presentation.dart). Three hand-kept copies of this array
// is how the app's ⏹ went missing for a queued or background task.
const OPEN_RUN_STATES = Object.freeze(['queued', 'running', 'waiting', 'background']);

/** Is this run state one whose run is still open (and therefore stoppable)? */
function isOpenRunState(state) { return OPEN_RUN_STATES.includes(state); }

// The live classify letters: every value this system can persist as a turn's
// classifyState. parseClassifyResult itself can only ever return P/D/W/B/E —
// G and N are never raw model output, they are what state-machine.js persists
// IN PLACE OF D once it reads D's goalState sub-state (achieved/interact). A
// recovered/replayed schedule can carry G or N just as easily as D, so the
// membership set has to know them too, or scheduler.js's recovery guards
// (`CLASSIFY_STATES.has(classifyState) ? classifyState : 'D'`) would silently
// downgrade a recovered G/N back to plain D. This is one set here rather than
// the `new Set(['P','D','W','B','E'])` that session-work/scheduler.js and
// workspace/runtime.js each used to declare by hand. C is deliberately absent
// (it is retired and collapses to W); the predicates below still tolerate a
// legacy persisted 'C' wherever one is read back from an older snapshot.
const CLASSIFY_STATES = new Set(['P', 'D', 'W', 'B', 'E', 'G', 'N']);

// Helpers
function classifyDisplay(cls) { return CLASSIFY_DISPLAY[cls] || CLASSIFY_DISPLAY['W']; }
/** classify letter (D/C/W/B/E/P) → its canonical turn run state. */
function runStateForClassify(cls) { return classifyDisplay(cls).cardStatus; }
function phaseLabel(ph) { return PHASE_LABELS[ph] || ''; }

// Semantic predicates over the classify LETTER — the single source for "what
// does this state mean for my subsystem?". Downstream code MUST use these
// instead of inline `=== 'D'` / `=== 'W'` checks, so the meaning lives here and
// a re-lettered vocabulary (B's split from `waiting` is the latest) cannot leave
// one subsystem reading the old meaning. tests/test-classify-vocab.js fails the
// build on a fresh inline letter comparison outside this file.
//
// The letters answer three independent questions:
//   Who is acting?      P/C a turn is in flight · W the user · B a background job
//   Did a turn end?     D cleanly · E in a fault or an explicit cancel
//   May I move it on?   D/W settle it · P/W/B mean something is still outstanding
//
// One-line meanings (each predicate is exactly one decision):
//   isProcessingLetter:  P (or the retired C) — a turn is in flight right now.
//   isWaitForUserLetter: W — the turn ended and only the user can move it on.
//   isBackgroundLetter:  B — the turn ended parked on a background job/callback.
//   isTerminalLetter:    D/G/N — the current turn executed successfully
//                        (terminal); G/N are D's two goalState sub-letters.
//   isAbnormalLetter:    E — the turn ended in a fault or an explicit cancel.
//   isSettledLetter:     D or W — won't change without new user input; safe to
//                        skip for re-classify/push (the user is in charge).
//   isParkedLetter:      W or B — the turn ended and is waiting on something
//                        outside the scheduler (the user, or a background job):
//                        nothing is running, nothing is being asked of us.
//   isOutcomeLetter:     D or E — the turn reached a definite outcome (success
//                        or fault), as opposed to P still running and W/B parked.
function isProcessingLetter(cls) { return cls === 'P' || cls === 'C'; }
function isWaitForUserLetter(cls) { return cls === 'W'; }
function isBackgroundLetter(cls) { return cls === 'B'; }
function isTerminalLetter(cls) { return cls === 'D' || cls === 'G' || cls === 'N'; }
function isAbnormalLetter(cls) { return cls === 'E'; }
function isSettledLetter(cls) { return isTerminalLetter(cls) || isWaitForUserLetter(cls); }
function isParkedLetter(cls) { return isWaitForUserLetter(cls) || isBackgroundLetter(cls); }
function isOutcomeLetter(cls) { return isTerminalLetter(cls) || isAbnormalLetter(cls); }

// Scheduler events carry this explicit outcome alongside the classify letter.
// Consumers may project it onto runtime UI, but MUST NOT reinterpret
// `succeeded` as TaskBoard lifecycle `done`; only a user action changes
// task.status to done.
const CLASSIFY_TURN_OUTCOME = Object.freeze({
  D: 'succeeded',
  G: 'succeeded',
  N: 'succeeded',
  C: 'running',
  W: 'waiting_user',
  B: 'waiting_background',
  E: 'failed',
  P: 'running',
});

function turnOutcomeForClassify(cls) {
  return CLASSIFY_TURN_OUTCOME[cls] || 'waiting_user';
}

// Structured tool evidence is authoritative for "waiting on user". The Aux
// classifier still owns goal/phase and remains the legacy fallback when no
// signal exists, but it cannot override an unresolved explicit request.
function applyUserInputEvidence(result, pendingUserInput) {
  if (!pendingUserInput || pendingUserInput.resolved === true) return result;
  return {
    ...result,
    state: 'W',
    evidence: 'request_user_input',
  };
}

// Build the classify system prompt (instructions only, no data).
function buildClassifySystemPrompt(priorGoal) {
  return `你是任务状态分析器。你需要判断【当前】闭环任务的状态。请严格按以下步骤思考，最后只输出三行结果。

【背景】一个会话里可能先后讨论过多个不同任务（任务A做完后用户又提了任务B）。你只关心【最后一个任务】，不要被前面已结束的旧任务干扰。

【步骤1·分组】在脑内把对话记录按任务切分成若干段：每当用户提出一个全新的、与上文不同的需求时，就开启一个新段。连续围绕同一需求的几轮对话属于同一段。系统注入消息（🔇开头、"检测到任务""[自动恢复""继续："开头）不是新任务，归入当前段；而且它们是系统自动发出的、【不代表真人用户在催促或推动继续】——判定第3行 D/W 时必须忽略这些注入消息的"推进"含义，只依据真人用户的真实意图判断。

【步骤2·定位】找出最后一条消息所属的段，那就是"当前任务"。前面已结束的段全部忽略--哪怕它们判定结果是"已完成"，也不代表当前状态。

【步骤3·判定】只对"当前任务"这一段判定，输出三行：

先读进度与状态：把当前任务段里用户提出的每条要求逐条列出、回记录里找落点（进度），再看清眼下卡在谁身上（状态：助手还在做 / 已正常收尾 / 在等用户拿主意或回答 / 在等后台任务或回调 / 被 API 异常截断）。第2行的阶段就是这份读数的结论，不要只看最后一句。

第1行：当前任务的目标 —— 一句话说清"要做成什么"，必须可验证。
       写法：动词 + 对象（必要时带范围），如"把登录页改成暗色主题""给目录卡片加 git 状态行""修复 /api/classify 的 500"。
       · 这一段里用户提了多个并列要求时，目标要全部覆盖（用"、"并列，如"换 logo、修页脚链接"），不要只写最后一条。
       · 只写做完后的可观察结果，不写过程或手段（"分析一下""看看代码""继续""优化下"都不能当目标）。
       · 自检：只看这个目标，能不能一眼判断做没做完？不能就改写成能判断的说法。
       语言跟随对话语言：中文用中文（≤20 汉字）；英文用英文（≤10 words, e.g. "Fix login page styling"）。
       严格忽略招呼、反问、确认、推进类消息（如"hi""你好""如何了""做到哪了""继续""好了吗" / "hi", "how is it going", "continue"）--这些不是任务目标。
       已有目标「${priorGoal || '无'}」，如仍围绕同一任务请保持一致（可以更具体，但不要变成另一件事）。
       如果当前任务段没有任何具体任务（纯招呼/闲聊/系统消息），输出「-」。

第2行：当前任务的阶段，必须原样输出以下五个中文词之一（无论对话语言）：
       规划中 / 实现中 / 验证中 / 收尾中 / 已完成
       判断方法：先把第1行覆盖的要求逐条列出来，再回记录里找每条的落点。
       · 只要还有一条没有落地（没做、做了一半、只说要做什么、结果没验证过）→ 不能判「已完成」，按进度选 规划中/实现中/验证中/收尾中。
       · 只有每条要求都有可验证的结果、且没有遗留的下一步 → 才判「已完成」。
       下列情况都不算「已完成」：助手只是口头说"已完成/搞定了"而记录里看不到结果；助手把问题抛回给用户；收尾了但仍有没做的部分；只是这一轮对话结束了。
       换句话说：「已完成」= 目标达成，是唯一表示"这件事做完了"的阶段；其余四个阶段都表示"还没做完"。
       AI 在等用户回复时不应判为「已完成」；最新用户消息如果提出了新的具体需求，即使 AI 还没开始做，也应判「规划中」而非「已完成」。

第3行：仅一个字母，判断【当前任务段】接下来该谁行动：
       D = 本轮执行成功（助手完成了本轮要求，正常收尾、没有反问、也不需要再继续；这只描述 turn outcome，不代表任务板任务已完成）
       W = 等用户（本轮助手已停下，主动权在用户手里）：助手在反问/征求意见/让用户做选择；或用户表达了犹豫；或任务还没全部做完但助手这一轮已结束——本系统不会自动替用户续接，未完成的部分一律等用户明确指示再继续，所以都判 W
       E = API 异常中断（助手回复末尾含 ${apiErrorSignaturesQuoted()} 等故障信息，回答被截断而非正常完成）
       P = AI 还在处理中（回复为空、或明显话没说完，还没到判断的时候）

关键区分 D vs W：
  · 助手已把本轮要求做完、正常收尾、没有后续动作 → D（执行成功；任务板仍由用户手动标记完成）
  · 任务还没全部做完、但助手这一轮已经停下（在反问、阶段性停顿、或等用户指示）→ W（交回用户；系统不自动续接）
  · 最新一条是用户的推进消息、AI 还没回应 → 判 P（还在处理），不要判 D
判断时看当前任务段的整体走向，不是看最后一句有没有问号。回复为空/话没说完判 P。API故障截断判 E。

第3行与第2行各答各的，不要互相迁就：第3行只说"这一轮谁行动"（D/W/P/E），
这件事到底做没做完由第2行说（「已完成」= 达成目标，其余 = 还没做完、后面还得有人接着干）。
所以 D + 非「已完成」是正常组合（这一轮正常收尾，但目标还没达成，等用户再推一把）。

判 W 的典型信号（出现其一即判 W，即使任务整体还没做完）：
  · 助手在回复末尾向用户提出"需要用户拿主意/做决定"的请求——二选一、"要不要我做X"、"先做哪个"、"请指定优先级/范围"、"要我现在就动手吗"、"等你确认后再做"。
  · 拿不准该判什么时，判 W（宁可等用户，也不要自作主张替用户继续）。

⚠️ 若对话明显还在进行中（最后是助手消息且话没说完、或助手正在执行操作），第3行直接判 P，不要硬猜。
⚠️ 只有真正做完当前任务才判 D；AI 在等用户回复、或任务还没收尾，都不能判 D。

只输出这三行结果。不要输出分组过程、不要加序号、解释、引号、空行。`;
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
  isGoalState,
  GOAL_STATES,
  CLASSIFY_DISPLAY,
  CLASSIFY_STATES,
  CLASSIFY_TURN_OUTCOME,
  TURN_RUN_STATES,
  OPEN_RUN_STATES,
  isOpenRunState,
  PHASE_LABELS,
};
