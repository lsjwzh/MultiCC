'use strict';

// ═══════════════════════════════════════════════════════════════════════
// tests/test-message-composer-golden.js
//
// Byte-equivalence regression gate for the unified message-builder refactor.
//
// Strategy: A/B direct comparison of TODAY's inline assembly vs the NEW
// composeMessage/renderPrompt/buildInvocation design.
//
//   "today" string  = re-derivation of server.js runChatTurn inline prepend
//                     chain and the former per-CLI argument rules.
//   "new"   string  = renderPrompt(composeMessage(...)) and
//                     adapter.buildInvocation().
//
// Iron rule under test: the args + payload emitted to every CLI must be
// byte-for-byte identical to today. Any drift (flag order, separator, model
// source, ultracode --settings, streaming --max-turns, ...) fails the gate.
//
// The legacy rules are re-derived below so deleting the duplicate runtime API
// does not weaken byte-level regression coverage.
// ═══════════════════════════════════════════════════════════════════════

const { composeMessage, renderPrompt } = require('../src/message-composer');
const { createClaudeAdapter } = require('../src/cli-adapters/claude');
const { createCodexAdapter } = require('../src/cli-adapters/codex');
const { createOpencodeAdapter } = require('../src/cli-adapters/opencode');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { failed++; console.error(`  ✗ FAIL: ${msg}`); return false; }
  passed++; return true;
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── Real-shaped stubs for the helpers injected via deps ─────────────────
// These mirror the tiny bodies of the server.js helpers (server.js:490-517,
// 8411-8430) so that effort/model resolution used by BOTH the "today" path
// and composeMessage stays consistent. Only helpers whose OUTPUT is observed
// by the gate are stubbed with sentinels (gateway/dispatch/goal/notes).

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const CODEX_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function normalizeEffort(v) {
  const s = (v == null ? '' : String(v)).trim().toLowerCase();
  if (!s) return null;
  return EFFORT_LEVELS.has(s) || CODEX_REASONING_LEVELS.has(s) ? s : undefined;
}
function cliEffortLevel(session) {
  const e = normalizeEffort(session && session.effort);
  if (!e) return null;
  return e === 'ultracode' ? 'xhigh' : e;
}
function codexReasoningLevel(session) {
  const e = normalizeEffort(session && session.effort);
  return e && CODEX_REASONING_LEVELS.has(e) ? e : null;
}
function codexReasoningConfigArg(session) {
  const lvl = codexReasoningLevel(session);
  return lvl ? `model_reasoning_effort="${lvl}"` : null;
}
function codexModelConfigArg(session) {
  const m = session && session.model ? String(session.model).trim() : '';
  return m ? `model="${m}"` : null;
}

// Stable sentinels for the layered prompt blocks. wrap-style for gateway
// preserves the byte identity buildGatewayPrompt('') + X === buildGatewayPrompt(X).
const GATEWAY_PREFIX = '<<GATEWAY-BLOCK>>\n\n';
const DISPATCH_BLOCK = '<<DISPATCH-CONTEXT>>\n';
const GOAL_BLOCK = '<<GOAL-LIMIT maxRounds=...>>\n\n';
const IMG_HINT = '<<MULTICC_IMG_HINT>>';
const ROLE_PROMPT = '<<ROLE: 你是一个严谨的翻译助手>>';
const ENV_CONSTRAINT = '<<env: CODEX_SANDBOX=0>>';
const STAY_ALIVE = '<<stay-alive: 不要退出>>';

function buildGatewayPrompt(userText) { return GATEWAY_PREFIX + userText; }
function buildDispatchContextPrompt(_sessionId) { return DISPATCH_BLOCK; }
function buildGoalLimitNote(_limits) { return GOAL_BLOCK; }

// notes store keyed by sessionName; pendingNotesFor reads + we can mutate.
const notesStore = {};
function pendingNotesFor(sessionId) { return notesStore[sessionId] || []; }
function saveNotes() { /* no-op for tests */ }
function appendEvent() {}
function workspaceBroadcast() {}
function chatBroadcast() {}

function makeDeps(overrides) {
  return Object.assign({
    resolveRolePrompt: (_p) => ROLE_PROMPT,
    multiccImgHint: IMG_HINT,
    buildGatewayPrompt,
    buildDispatchContextPrompt,
    buildGoalLimitNote,
    pendingNotesFor,
    saveNotes,
    appendEvent,
    workspaceBroadcast,
    chatBroadcast,
    normalizeEffort,
    cliEffortLevel,
  }, overrides || {});
}

// ─────────────────────────────────────────────────────────────────────────
// "Today" re-derivation: server.js runChatTurn inline promptText assembly
// (server.js:9035-9075). NOTE the em dash U+2014 in the notes header is
// copied verbatim from server.js:9038 -- composer.js currently emits an
// ASCII hyphen there, so the notes scenario flags that byte drift (the gate
// doing exactly its job).
// ─────────────────────────────────────────────────────────────────────────
function todayPrompt({ text, persisted, sessionName, goalLimits, bare }, deps) {
  if (bare) return text; // bare (continue/retry) skips layers + suffix
  let promptText = text;
  const pendingNotes = deps.pendingNotesFor(sessionName).slice(0, 10);
  if (pendingNotes.length) {
    let block = '[multicc 跨 agent 留言 — 来自同目录下的其他 agent]\n';
    for (const n of pendingNotes) block += `- 来自「${n.fromLabel}」：${n.body}\n`;
    block += '[留言结束]\n\n';
    if (block.length > 4000) block = block.slice(0, 4000) + '\n…(截断)\n\n';
    promptText = block + text;
  }
  if (persisted.type === 'gateway') {
    promptText = deps.buildGatewayPrompt(promptText);
  } else if (persisted.type !== 'aux') {
    const dc = deps.buildDispatchContextPrompt(sessionName);
    if (dc) promptText = dc + promptText;
  }
  if (goalLimits) {
    const note = deps.buildGoalLimitNote(goalLimits);
    if (note) promptText = note + promptText;
  }
  if (persisted.type !== 'aux' && deps.normalizeEffort(persisted.effort) === 'ultracode') {
    promptText = promptText + '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]';
  }
  return promptText;
}

function basePersisted(overrides) {
  return Object.assign({
    id: 's1',
    cli: 'claude',
    type: null,
    effort: 'ultracode',
    streaming: false,
    cliSessionId: 'ca88a4d8-1234-5678-9abc-def012345678',
    model: 'fable',
    dirId: 'dir-1',
  }, overrides || {});
}

// ═══════════════════════════════════════════════════════════════════════
// Suite 1: renderPrompt(composeMessage) === todayPrompt  (byte equality)
// ═══════════════════════════════════════════════════════════════════════
console.log('── Suite 1: promptText byte-equivalence (renderPrompt vs today) ──');

function promptEquivScenario(label, { persisted, opts, notes }) {
  const sessionName = 's1';
  if (notes) notesStore[sessionName] = notes; else delete notesStore[sessionName];
  const deps = makeDeps();
  const text = '帮我把这段代码翻译成中文';
  const env = composeMessage({ text, persisted, sessionName, opts, deps });
  const got = renderPrompt(env);
  const want = todayPrompt({ text, persisted, sessionName,
    goalLimits: opts && opts.goalLimits, bare: opts && opts.bare }, deps);
  const ok = assert(got === want, `${label}: renderPrompt must equal today's promptText byte-for-byte`);
  if (!ok) {
    console.error('    --- got ---'); console.error(JSON.stringify(got));
    console.error('    --- want ---'); console.error(JSON.stringify(want));
  }
}

// 1a: normal + ultracode (type=null, effort=ultracode, no notes/goal)
promptEquivScenario('1a normal+ultracode', {
  persisted: basePersisted({ type: null, effort: 'ultracode' }),
  opts: { isFirstTurn: true, mode: 'per-turn' },
});

// 1b: gateway session (type='gateway')
promptEquivScenario('1b gateway', {
  persisted: basePersisted({ type: 'gateway', effort: 'high' }),
  opts: { isFirstTurn: false, mode: 'per-turn' },
});

// 1c: with one pending cross-agent note
promptEquivScenario('1c +pendingNotes', {
  persisted: basePersisted({ type: null, effort: 'high' }),
  opts: { isFirstTurn: true, mode: 'per-turn' },
  notes: [{ fromLabel: 'worker-A', body: '已合并 PR #42，请同步' }],
});

// 1d: with goalLimits {maxRounds, maxBudget}
promptEquivScenario('1d +goalLimits', {
  persisted: basePersisted({ type: null, effort: 'high' }),
  opts: { isFirstTurn: true, mode: 'per-turn', goalLimits: { maxRounds: 5, maxBudget: '500k' } },
});

// 1e: bare=true (continue/retry) -> layers + suffix skipped, raw userText only
promptEquivScenario('1e bare=true', {
  persisted: basePersisted({ type: null, effort: 'ultracode' }),
  opts: { isFirstTurn: false, mode: 'per-turn', bare: true },
});

// 1f: aux session -> no dispatch layer, no ultracode suffix
promptEquivScenario('1f aux (no layers, no suffix)', {
  persisted: basePersisted({ type: 'aux', effort: 'ultracode' }),
  opts: { isFirstTurn: true, mode: 'per-turn' },
});

// 1g: streaming + ultracode -> prompt body still gets suffix (suffix is path-independent)
promptEquivScenario('1g streaming+ultracode', {
  persisted: basePersisted({ type: null, effort: 'ultracode', streaming: true }),
  opts: { isFirstTurn: true, mode: 'streaming' },
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 2: envelope structure invariants
// ═══════════════════════════════════════════════════════════════════════
console.log('── Suite 2: envelope structure ──');

(function suite2() {
  const deps = makeDeps();
  const env = composeMessage({
    text: 'hi', persisted: basePersisted(), sessionName: 's1',
    opts: { isFirstTurn: true, goalLimits: { maxRounds: 3 }, mode: 'per-turn',
      providerModel: 'fable', providerModels: ['fable'], skipDefaultModel: false,
      disallowedTools: ['Bash'] },
    deps,
  });
  assert(env.systemPrompt === `${IMG_HINT}\n\n${ROLE_PROMPT}`, 'systemPrompt = imgHint+\\n\\n+rolePrompt');
  assert(env.imgHint === IMG_HINT, 'imgHint carried as independent field');
  assert(env.rolePrompt === ROLE_PROMPT, 'rolePrompt carried as independent field');
  // layers sorted ascending by order: goal(10) < dispatch(20)
  const orders = env.contextLayers.map(l => l.order);
  assert(orders.length === 2 && orders[0] === 10 && orders[1] === 20, 'contextLayers sorted by order asc (goal<dispatch)');
  assert(env.spawnOpts.rawModel === 'fable', 'spawnOpts.rawModel = persisted.model (raw, not pre-parsed)');
  assert(env.spawnOpts.rawEffort === 'ultracode', 'spawnOpts.rawEffort = persisted.effort (raw)');
  assert(env.spawnOpts.ultracode === true, 'ultracode flag derived');
  assert(env.suffix !== '', 'ultracode => non-empty suffix');
  assert(env.historyHandle.isFirstTurn === true, 'historyHandle.isFirstTurn carried');
  assert(env.historyHandle.cliSessionId === 'ca88a4d8-1234-5678-9abc-def012345678', 'historyHandle.cliSessionId carried');
})();

// ═══════════════════════════════════════════════════════════════════════
// Suite 3: adapter.buildInvocation() byte-equivalence
// ═══════════════════════════════════════════════════════════════════════
console.log('── Suite 3: adapter.buildInvocation() byte-equivalence ──');

// Build real adapters with the same stub deps the server would inject.
const providersStub = {
  resolveSessionWireModel(model, o) {
    if (o && o.providerModel) return o.providerModel;
    if (o && o.skipDefaultModel) return model || null;
    return model || (o && o.defaultModel) || null;
  },
};
function claudeAdapterWith(disallowed) {
  return createClaudeAdapter({
    cmd: 'claude', args: [], chatDisallowedTools: disallowed || [],
    multiccImgHint: IMG_HINT, providers: providersStub,
    claudeDefaultModel: () => 'claude-default',
    cliEffortLevel, normalizeEffort,
    debugLogClaudeInvoke: () => {},
  });
}
const codexAdapter = createCodexAdapter({
  cmd: 'codex', args: [],
  codexReasoningConfigArg, codexModelConfigArg,
  envConstraint: ENV_CONSTRAINT, stayAlivePrompt: STAY_ALIVE,
  multiccImgHint: IMG_HINT,
});
const opencodeAdapter = createOpencodeAdapter({ cmd: 'opencode' });
const zcodeAdapter = createZcodeAdapter({ cmd: 'zcode' });

function todayBuildChatArgs(adapter, persisted, promptText, o) {
  if (adapter.name === 'claude') {
    const sysPrompt = o.rolePrompt ? `${IMG_HINT}\n\n${o.rolePrompt}` : IMG_HINT;
    const result = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--dangerously-skip-permissions',
      '--append-system-prompt', sysPrompt,
    ];
    const model = providersStub.resolveSessionWireModel(persisted.model, {
      providerModel: o.providerModel, providerModels: o.providerModels,
      skipDefaultModel: o.skipDefaultModel, defaultModel: 'claude-default',
    });
    if (model) result.push('--model', model);
    const effort = cliEffortLevel(persisted);
    if (effort) result.push('--effort', effort);
    if (normalizeEffort(persisted.effort) === 'ultracode') result.push('--settings', '{"ultracode":true}');
    if (o.disallowedTools.length) result.push('--disallowedTools', o.disallowedTools.join(','));
    if (o.maxTurns > 0) result.push('--max-turns', String(o.maxTurns));
    result.push(o.isFirstTurn ? '--session-id' : '--resume', persisted.cliSessionId, promptText);
    return result;
  }
  if (adapter.name === 'codex') {
    let payload = o.isFirstTurn
      ? `${IMG_HINT}\n\n${ENV_CONSTRAINT}\n\n[角色设定]\n${o.rolePrompt}\n[角色设定结束]\n\n${promptText}`
      : promptText;
    payload += `\n${STAY_ALIVE}`;
    const result = ['exec'];
    for (const arg of [codexReasoningConfigArg(persisted), codexModelConfigArg(persisted)].filter(Boolean)) {
      result.push('-c', arg);
    }
    if (!o.isFirstTurn) result.push('resume', persisted.cliSessionId);
    result.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', payload);
    return result;
  }
  const result = ['run', '--format', 'json', '--auto'];
  if (persisted.model) result.push('--model', persisted.model);
  if (!o.isFirstTurn && persisted.cliSessionId) result.push('--session', persisted.cliSessionId);
  else if (!o.isFirstTurn) result.push('--continue');
  const payload = o.isFirstTurn && o.rolePrompt
    ? `[角色设定]\n${o.rolePrompt}\n[角色设定结束]\n\n${promptText}`
    : promptText;
  result.push(payload);
  return result;
}

function shapeEquiv(label, { adapter, persisted, isFirstTurn, disallowedTools, maxTurns }) {
  const sessionName = 's1';
  delete notesStore[sessionName];
  const deps = makeDeps();
  const opts = {
    isFirstTurn, mode: 'per-turn',
    providerModel: 'fable-wire', providerModels: ['fable-wire'], skipDefaultModel: false,
    // maxTurns flows through the real channel: goalLimits.maxRounds (server.js:9064).
    goalLimits: maxTurns ? { maxRounds: maxTurns } : undefined,
    disallowedTools: disallowedTools || [],
  };
  const envelope = composeMessage({ text: '翻译这句话', persisted, sessionName, opts, deps });
  const promptText = renderPrompt(envelope);
  const todayArr = todayBuildChatArgs(adapter, persisted, promptText, {
    isFirstTurn,
    rolePrompt: envelope.rolePrompt,
    // Single source of truth: goal max turns is carried through the envelope.
    maxTurns: envelope.spawnOpts.maxTurns,
    skipDefaultModel: opts.skipDefaultModel,
    providerModel: opts.providerModel,
    providerModels: opts.providerModels,
    disallowedTools: disallowedTools || [],
  });
  if (typeof adapter.buildInvocation !== 'function') {
    assert(false, `${label}: adapter.buildInvocation not implemented`);
    return;
  }
  const { args, payload } = adapter.buildInvocation(envelope);
  const newArr = [...args, payload];
  const ok = assert(eq(newArr, todayArr), `${label}: invocation args + payload preserve legacy bytes`);
  if (!ok) {
    console.error('    --- new ---'); console.error(JSON.stringify(newArr));
    console.error('    --- today ---'); console.error(JSON.stringify(todayArr));
  }
}

// 3a: claude per-turn, first turn, ultracode (=> --settings + --effort xhigh)
shapeEquiv('3a claude per-turn first ultracode', {
  adapter: claudeAdapterWith(['Bash', 'WebFetch']),
  persisted: basePersisted({ cli: 'claude', type: null, effort: 'ultracode' }),
  isFirstTurn: true, disallowedTools: ['Bash', 'WebFetch'],
});

// 3b: claude per-turn, resume (subsequent) turn, non-ultracode + maxTurns
shapeEquiv('3b claude per-turn resume +maxTurns', {
  adapter: claudeAdapterWith([]),
  persisted: basePersisted({ cli: 'claude', type: null, effort: 'high' }),
  isFirstTurn: false, maxTurns: 5,
});

// 3c: codex first turn (systemBlock inlined + stayAlive)
shapeEquiv('3c codex first-turn', {
  adapter: codexAdapter,
  persisted: basePersisted({ cli: 'codex', type: null, effort: 'high', model: 'gpt-5' }),
  isFirstTurn: true,
});

// 3d: codex resume turn (no systemBlock, resume <id>)
shapeEquiv('3d codex resume', {
  adapter: codexAdapter,
  persisted: basePersisted({ cli: 'codex', type: null, effort: 'high', model: 'gpt-5' }),
  isFirstTurn: false,
});

// 3e: opencode first turn with rolePrompt (=> [角色设定] wrapper)
shapeEquiv('3e opencode first-turn', {
  adapter: opencodeAdapter,
  persisted: basePersisted({ cli: 'opencode', type: null, effort: 'high', model: 'opencode-1' }),
  isFirstTurn: true,
});

// 3f: opencode resume turn (=> --session <id>, no wrapper)
shapeEquiv('3f opencode resume', {
  adapter: opencodeAdapter,
  persisted: basePersisted({ cli: 'opencode', type: null, effort: 'high', model: 'opencode-1' }),
  isFirstTurn: false,
});

// 3g: zcode first turn
shapeEquiv('3g zcode first-turn', {
  adapter: zcodeAdapter,
  persisted: basePersisted({ cli: 'zcode', type: null, effort: 'high', model: 'z-1' }),
  isFirstTurn: true,
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 4: claude.buildInvocation(streaming) byte-equivalence
//
// The legacy streaming base args are re-derived below. The session handle
// (--session-id/--resume) is appended by chat-stream at spawn time and
// is explicitly OUT of scope for shape args. ultracode --settings and
// --max-turns are intentionally NOT added to streaming today (drift preserved
// per iron rule #3); shape(streaming) must match that drift exactly.
// ═══════════════════════════════════════════════════════════════════════
console.log('── Suite 4: claude.buildInvocation(streaming) byte-equivalence ──');

function todayStreamingBaseArgs(persisted, { sysPrompt, model, disallowedTools }) {
  // Replicates chat-stream.spawnProc prefix (minus sessionArgs) +
  // runChatTurnStreaming extraArgs (effort + disallowedTools), no prompt, no handle.
  const extraArgs = [];
  const effort = cliEffortLevel(persisted);
  if (effort) extraArgs.push('--effort', effort);
  if (disallowedTools && disallowedTools.length) {
    extraArgs.push('--disallowedTools', disallowedTools.join(','));
  }
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
    ...(model ? ['--model', model] : []),
    ...(sysPrompt ? ['--append-system-prompt', sysPrompt] : []),
    ...extraArgs,
  ];
}

(function suite4() {
  const sessionName = 's1';
  delete notesStore[sessionName];
  const deps = makeDeps();
  const disallowed = ['Bash'];
  const persisted = basePersisted({ cli: 'claude', type: null, effort: 'high', streaming: true });
  const opts = {
    isFirstTurn: true, mode: 'streaming',
    providerModel: 'fable-wire', providerModels: ['fable-wire'], skipDefaultModel: false,
    disallowedTools: disallowed,
  };
  const envelope = composeMessage({ text: '继续上一步', persisted, sessionName, opts, deps });

  // today payload (stdin) = the promptText runChatTurn assembled and passed in
  const todayPayload = todayPrompt({ text: '继续上一步', persisted, sessionName, bare: false }, deps);
  const todayModel = providersStub.resolveSessionWireModel(persisted.model, {
    providerModel: opts.providerModel, providerModels: opts.providerModels,
    skipDefaultModel: opts.skipDefaultModel, defaultModel: 'claude-default',
  });
  const todaySys = envelope.rolePrompt ? `${IMG_HINT}\n\n${envelope.rolePrompt}` : IMG_HINT;
  const todayArgs = todayStreamingBaseArgs(persisted, { sysPrompt: todaySys, model: todayModel, disallowedTools: disallowed });

  const adapter = claudeAdapterWith(disallowed);
  if (typeof adapter.buildInvocation !== 'function') {
    assert(false, '4a claude.buildInvocation(streaming): not implemented');
    return;
  }
  const { args, payload } = adapter.buildInvocation(envelope);
  const okArgs = assert(eq(args, todayArgs), '4a streaming: invocation.args === legacy base args (no handle, no --settings, no --max-turns)');
  if (!okArgs) {
    console.error('    --- shape.args ---'); console.error(JSON.stringify(args));
    console.error('    --- todayArgs  ---'); console.error(JSON.stringify(todayArgs));
  }
  const okPayload = assert(payload === todayPayload, '4b streaming: shape.payload === today promptText (stdin)');
  if (!okPayload) {
    console.error('    --- payload   ---'); console.error(JSON.stringify(payload));
    console.error('    --- todayPayload ---'); console.error(JSON.stringify(todayPayload));
  }
})();

// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL TESTS PASSED ✓');
