'use strict';

// Classify vocabulary + parsing (pure, extracted verbatim from server.js).
// Single source of truth for: parsing the classifier's 3-line text output
// into {state, goal, phase, background, error}; the per-state display map
// (CLASSIFY_DISPLAY) and phase labels (PHASE_LABELS); and the classifier
// system prompt. No I/O and no host state -- deterministic given its inputs.

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
  D: {  // Done — task genuinely finished (terminal)
    label: '已完成',
    pushType: 'completed', pushTitle: '完成',
    voiceText: '任务已完成', ding: 'completed',
    cardStatus: 'completed', barTint: 'completed',
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
    pushType: 'waiting', pushTitle: '等待操作',
    voiceText: '等待后台任务', ding: 'waiting',
    cardStatus: 'waiting', barTint: 'waiting',
  },
  E: {  // API error — truncated reply
    label: 'API 异常',
    pushType: 'error', pushTitle: '出现异常',
    voiceText: 'API 异常中断，等待重试中', ding: 'error',
    cardStatus: 'waiting', barTint: 'error',
  },
  P: {  // Processing — mid-turn only
    label: '处理中',
    pushType: null, pushTitle: null,
    voiceText: null, ding: null,
    cardStatus: 'running', barTint: 'running',
  },
};

// Phase labels — centralized, used by both classify-in-progress path and
// dispatchStateAction. Formerly repeated inline at L7008 and L7902.
const PHASE_LABELS = {
  planning: '规划中', implementing: '实现中', verifying: '验证中',
  wrapping: '收尾中', done: '已完成',
};

// Helpers
function classifyDisplay(cls) { return CLASSIFY_DISPLAY[cls] || CLASSIFY_DISPLAY['W']; }
function phaseLabel(ph) { return PHASE_LABELS[ph] || ''; }

// Semantic predicates over the classify LETTER — the single source for "what
// does this state mean for my subsystem?". Downstream code MUST use these
// instead of inline `=== 'D'` / `=== 'W'` checks, so the meaning lives here.
//   isTerminalLetter: D — task genuinely finished (the only terminal state).
//   isSettledLetter:  D or W — won't change without new user input; safe to skip
//                     for re-classify/push (the user is in charge either way).
function isTerminalLetter(cls) { return cls === 'D'; }
function isSettledLetter(cls) { return cls === 'D' || cls === 'W'; }

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

第1行：当前任务的目标，用一个简短的名词性短语。
       语言跟随对话语言：中文用中文（≤20 汉字，如"memo图片更换""给目录卡片加 git 状态行"）；英文用英文（≤10 words, e.g. "Fix login page styling"）。
       严格忽略招呼、反问、确认、推进类消息（如"hi""你好""如何了""做到哪了""继续""好了吗" / "hi", "how is it going", "continue"）--这些不是任务目标。
       已有目标「${priorGoal || '无'}」，如仍围绕同一任务请保持一致。
       如果当前任务段没有任何具体任务（纯招呼/闲聊/系统消息），输出「-」。

第2行：当前任务的阶段，必须原样输出以下五个中文词之一（无论对话语言）：
       规划中 / 实现中 / 验证中 / 收尾中 / 已完成
       AI 在等用户回复时不应判为「已完成」；只有把当前任务所有要求都做完了才判「已完成」。
       最新用户消息如果提出了新的具体需求，即使 AI 还没开始做，也应判「规划中」而非「已完成」。

第3行：仅一个字母，判断【当前任务段】接下来该谁行动：
       D = 任务已完成（助手把当前任务的所有要求都做完了，正常收尾、没有反问、也不需要再继续；用户可以验收）
       W = 等用户（本轮助手已停下，主动权在用户手里）：助手在反问/征求意见/让用户做选择；或用户表达了犹豫；或任务还没全部做完但助手这一轮已结束——本系统不会自动替用户续接，未完成的部分一律等用户明确指示再继续，所以都判 W
       E = API 异常中断（助手回复末尾含 "API Error"、"503"、"Connection closed"、"Overloaded"、"Internal server error"、"The system is busy" 等故障信息，回答被截断而非正常完成）
       P = AI 还在处理中（回复为空、或明显话没说完，还没到判断的时候）

关键区分 D vs W：
  · 助手已把任务所有要求做完、正常收尾、没有后续动作 → D（完成，用户可验收）
  · 任务还没全部做完、但助手这一轮已经停下（在反问、阶段性停顿、或等用户指示）→ W（交回用户；系统不自动续接）
  · 最新一条是用户的推进消息、AI 还没回应 → 判 P（还在处理），不要判 D
判断时看当前任务段的整体走向，不是看最后一句有没有问号。回复为空/话没说完判 P。API故障截断判 E。

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
  phaseLabel,
  applyUserInputEvidence,
  isTerminalLetter,
  isSettledLetter,
  CLASSIFY_DISPLAY,
  PHASE_LABELS,
};
