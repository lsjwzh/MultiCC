'use strict';

// Deterministic regression suite built from a sanitized replica of a real
// production large-context workspace (~170KB shared memory store / 170-chunk
// MEMORY.md / 31 mid-body 【必须】 false-positive traps / 19 auto-distilled
// _auto.md preferences / 65KB conversation history / 35KB CLI switch handoff,
// modeled on a 9.18M-token turn diagnosis).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fixture: shellFixture } = require('./helpers/task-shell');
const { createFolderMemoryService } = require('../src/memory/folder-service');
const { readMemoryFolder } = require('../src/memory-store');
const { estimateTokens, verifySnapshot } = require('../src/native/binding').taskShellContext;
const { historySnapshot } = require('../src/task-shell/history-context');
const { boundedSnapshot, boundedHandoff } = require('../src/task-shell/context-plan');
const { prepareManagedContext } = require('../src/native/binding').managedContext;
const {
  createHostPrompts,
  buildSubagentProviderHint,
  buildPlanProgressPrompt,
} = require('../src/native/binding').getHostPrompts();

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'large-context-sanitized.json');
const DATA = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

function writeTree(baseDir, tree) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const [name, value] of Object.entries(tree)) {
    const target = path.join(baseDir, name);
    if (typeof value === 'string') {
      fs.writeFileSync(target, value, 'utf8');
    } else if (value && typeof value === 'object') {
      writeTree(target, value);
    }
  }
}

function hydrateLargeMemory(f, d) {
  const root = path.join(path.dirname(f.file), 'large-memory');
  const memory = createFolderMemoryService({
    fs,
    path,
    memoryStoreRoot: root,
    directories: new Map([['d1', {}]]),
    readMemoryFolder,
    getMemoryEntries: () => [],
  });
  const record = { ...f.records.get(d.sessionId), cli: 'claude', taskBoundTaskId: d.taskId };
  writeTree(memory.sharedDir('d1'), DATA.memoryFiles.shared);
  writeTree(memory.taskDir('d1', d.taskId), DATA.memoryFiles.task);
  writeTree(memory.sessionDir(record), DATA.memoryFiles.session);
  writeTree(memory.machineDir(), DATA.memoryFiles.machine);
  for (const [skillName, files] of Object.entries(DATA.memoryFiles.skills)) {
    writeTree(memory.skillDir('d1', skillName), files);
  }
  return { root, memory, record };
}

async function sendTurn(f, key, text, extra = {}) {
  f.statuses.clear();
  return f.runtime.send(f.a.id, { clientMsgId: key, text, ...extra });
}

function commitTurn(f, d, success = true) {
  f.runtime.contextSent(d.sessionId, d.receiptId, d.receiptId);
  f.runtime.contextComplete(d.sessionId, d.receiptId, d.receiptId, success);
}

test('sanitized large-context fixture preserves production scale while containing zero PII or secrets', () => {
  assert.equal(DATA.sanitized, true);
  assert.ok(DATA.counts.sharedMemoryChunks >= 170, 'fixture must preserve 170+ _shared/MEMORY.md chunks');
  assert.ok(DATA.counts.falsePositiveMidBodyTraps >= 30, 'fixture must include 30+ mid-body 【必须】/禁止 traps');
  assert.ok(DATA.counts.autoDistilledPreferences >= 18, 'fixture must include _auto.md preference flood trap');
  assert.ok(DATA.memoryFiles.shared['MEMORY.md'].length >= 55_000, '_shared/MEMORY.md must be production-scale');
  assert.ok(Buffer.byteLength(DATA.memoryFiles.shared['MEMORY.md'], 'utf8') >= 100_000, '_shared/MEMORY.md must exceed 100KB UTF-8');
  const sharedTotalBytes = Object.values(DATA.memoryFiles.shared).reduce((s, v) => s + Buffer.byteLength(v, 'utf8'), 0);
  assert.ok(sharedTotalBytes >= 135_000, `total _shared store must exceed 135KB, got ${sharedTotalBytes}`);
  const historyBytes = Buffer.byteLength(JSON.stringify(DATA.historyMessages), 'utf8');
  assert.ok(historyBytes >= 60_000, 'imported history must exceed 60KB');
  const handoffBytes = Buffer.byteLength(JSON.stringify(DATA.pendingCliHandoff), 'utf8');
  assert.ok(handoffBytes >= 30_000, 'CLI handoff must exceed 30KB');

  // Strict privacy & sanitization audit over the entire serialized fixture.
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const forbiddenPatterns = [
    [/\/Users\/[A-Za-z0-9._-]+/i, 'macOS home directory path'],
    [/C:\\\\Users\\\\[A-Za-z0-9._-]+/i, 'Windows home directory path'],
    [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/, 'Tailscale CGNAT IP'],
    [/\b(?:192\.168|10\.\d+)\.\d+\.\d+\b/, 'private RFC1918 IP'],
    [/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{16,})\b/, 'API secret token'],
    [/Authorization:\s*Bearer\s+\S{12,}/i, 'Bearer credential'],
  ];
  for (const [rx, label] of forbiddenPatterns) {
    assert.doesNotMatch(raw, rx, `sanitized fixture must not contain ${label}`);
  }
});

test('cold start on vague 9M-style turn stays within 4800 budget, keeps genuine rules + task memory, and blocks dumps/false pins', async t => {
  const f = shellFixture(t);
  const first = await sendTurn(f, 'cold-vague', DATA.queries.vague9MTurn);
  f.records.get(first.sessionId).cli = 'claude';
  const taskRow = f.store.get('task', first.taskId);
  f.store.set('task', first.taskId, { ...taskRow, ...DATA.task, id: first.taskId });
  const { memory } = hydrateLargeMemory(f, first);

  const plan = f.runtime.prepareContext(first.sessionId, {
    receiptId: first.receiptId,
    turnId: first.receiptId,
    text: DATA.queries.vague9MTurn,
    memory,
    isFirstTurn: true,
  });

  // Budget & size guards vs pre-optimization 8000-token / 19,515-char saturation.
  assert.equal(plan.budget.limit, 4800);
  assert.ok(plan.budget.used <= 4800, `expected used <= 4800, got ${plan.budget.used}`);
  assert.ok(estimateTokens(plan.text) <= 4800);
  assert.ok(
    plan.text.length < 11_500,
    `cold-start managed context (${plan.text.length} chars) must stay far below old 19,515-char saturation`,
  );

  // All 6 genuine project header rules must survive.
  const expectedRules = [
    /主服务重启【只能由用户手动触发】/,
    /任务绑定会话.*只能通过对应任务通道派发/,
    /删除旧 worktree 或清理磁盘缓存前/,
    /新建或修改项目内置技能时.*skills\/<name>\/SKILL\.md/,
    /产品配置严禁硬编码个人域名/,
    /项目后端默认使用 Rust/,
  ];
  for (const rx of expectedRules) {
    assert.match(plan.text, rx, `genuine project rule missing: ${rx}`);
  }

  // Builtin rules: claude gets docs-registry once, skips secret-vault & shared-files (in host prompt),
  // and legacy multi-paragraph continuations from _shared/MEMORY.md must never leak.
  const sourceIds = plan.sources.map(s => s.id);
  assert.ok(sourceIds.includes('builtin:docs-registry'));
  assert.ok(!sourceIds.includes('builtin:secret-vault'));
  assert.ok(!sourceIds.includes('builtin:shared-files'));
  assert.doesNotMatch(plan.text, /旧版续段说明/);
  assert.doesNotMatch(plan.text, /旧版补充说明/);

  // Mid-body 【必须】/禁止 traps must NOT auto-pin on cold start.
  assert.doesNotMatch(plan.text, /WsTicketClient/, 'mid-body 【必须】 gotcha must not auto-pin');
  assert.doesNotMatch(plan.text, /wait_for_user_answer 集成测试/, 'mid-body 【必须立刻】 verified note must not auto-pin');
  assert.doesNotMatch(plan.text, /busy_timeout >= 5000ms/, 'mid-body SQLite gotcha must not auto-pin');

  // Auto-distilled _auto.md preferences must NOT pin at priority 900 and starve current task memory.
  assert.equal(
    plan.sources.filter(s => s.path?.endsWith('/_auto.md') && s.reason === 'rule').length,
    0,
    '_auto.md must not auto-pin as priority-900 rule',
  );
  assert.ok(
    plan.sources.some(s => s.scope === 'task'),
    'current task MEMORY.md must survive cold-start budget instead of being starved by _auto.md',
  );

  // Unmatched _shared, machine, and skill entries must NOT cold-dump; 150+ should be omitted as not_relevant.
  const notRelevantCount = plan.omitted.filter(s => s.reason === 'not_relevant').length;
  assert.ok(notRelevantCount >= 180, `expected >= 180 not_relevant omissions on 170-chunk+ store, got ${notRelevantCount}`);
  assert.doesNotMatch(plan.text, /machine-probe-omega/, 'unmatched machine memory must not cold-dump');
  assert.doesNotMatch(plan.text, /skill-probe-sigma/, 'unmatched skill memory must not cold-dump');
  assert.doesNotMatch(plan.text, /即使技能目录内写有规则标签/, 'skill-scoped [规则] must never pin');

  // Compare directly against the pre-optimization 8000-token baseline: >= 40% reduction.
  const savingPct = 1 - plan.budget.used / DATA.baselineObserved.preOptManagedContextTokens;
  assert.ok(
    savingPct >= 0.38,
    `expected >= 38% managed-context token reduction vs 7999 baseline, got ${(savingPct * 100).toFixed(1)}%`,
  );
});

test('continuations emit zero redundant delta and recall omitted gotchas, wikilinks, _auto.md, machine & skill facts on demand', async t => {
  const f = shellFixture(t);
  const first = await sendTurn(f, 'cont-1', DATA.queries.vague9MTurn);
  f.records.get(first.sessionId).cli = 'claude';
  const taskRow = f.store.get('task', first.taskId);
  f.store.set('task', first.taskId, { ...taskRow, ...DATA.task, id: first.taskId });
  const { memory } = hydrateLargeMemory(f, first);

  const initial = f.runtime.prepareContext(first.sessionId, {
    receiptId: first.receiptId,
    turnId: first.receiptId,
    text: DATA.queries.vague9MTurn,
    memory,
    isFirstTurn: true,
  });
  assert.ok(initial.sources.length > 0);
  commitTurn(f, first);

  // Turn 2: unrelated short continuation -> empty delta, everything retained in ledger.
  const second = await sendTurn(f, 'cont-2', DATA.queries.unrelatedContinuation);
  const noopPlan = f.runtime.prepareContext(second.sessionId, {
    receiptId: second.receiptId,
    turnId: second.receiptId,
    text: DATA.queries.unrelatedContinuation,
    memory,
  });
  assert.equal(noopPlan.text, '', 'unchanged continuation must inject 0 bytes');
  assert.ok(noopPlan.retained.length >= 6, 'committed rules & task facts stay retained in ledger');
  commitTurn(f, second);

  // Turn 3a: query previously omitted mid-body 【必须】 gotcha.
  const thirdA = await sendTurn(f, 'cont-3a', DATA.queries.targetedGotcha);
  const gotchaPlan = f.runtime.prepareContext(thirdA.sessionId, {
    receiptId: thirdA.receiptId,
    turnId: thirdA.receiptId,
    text: DATA.queries.targetedGotcha,
    memory,
  });
  assert.match(gotchaPlan.text, /WsTicketClient/, 'targeted turn must recall omitted mid-body 【必须】 gotcha');
  // Already-committed project rules must NOT be re-sent in delta!
  assert.doesNotMatch(gotchaPlan.text, /项目后端默认使用 Rust/, 'already-sent rule must not be re-injected');
  assert.ok(estimateTokens(gotchaPlan.text) <= 4800);
  commitTurn(f, thirdA);

  // Turn 3b: query wikilinked topic -> pulls 1-hop [[proxy-subagent-routing]] neighbor doc on demand.
  const thirdB = await sendTurn(f, 'cont-3b', DATA.queries.targetedWikilink);
  const wikilinkPlan = f.runtime.prepareContext(thirdB.sessionId, {
    receiptId: thirdB.receiptId,
    turnId: thirdB.receiptId,
    text: DATA.queries.targetedWikilink,
    memory,
  });
  assert.match(
    wikilinkPlan.text,
    /Proxy Subagent Routing Specification|route key 编码包含 mainProvider/,
    'targeted turn must pull 1-hop [[proxy-subagent-routing]] neighbor',
  );
  assert.ok(
    wikilinkPlan.sources.some(s => s.reason === 'wikilink' || s.path?.endsWith('proxy-subagent-routing.md')),
    'wikilink target doc must surface on demand',
  );
  assert.doesNotMatch(wikilinkPlan.text, /项目后端默认使用 Rust/, 'already-sent rule must still stay deduped');
  assert.ok(estimateTokens(wikilinkPlan.text) <= 4800);
  commitTurn(f, thirdB);

  // Turn 4a/4b/4c: focused queries recall deferred _auto.md preference, machine fact, and skill fact on demand.
  for (const [key, query, expected, label] of [
    ['cont-4a', DATA.queries.targetedAuto, /auto-probe-zeta/, 'deferred _auto.md preference'],
    ['cont-4b', DATA.queries.targetedMachine, /machine-probe-omega/, 'deferred machine fact'],
    ['cont-4c', DATA.queries.targetedSkill, /skill-probe-sigma/, 'deferred skill fact'],
  ]) {
    const turn = await sendTurn(f, key, query);
    const plan = f.runtime.prepareContext(turn.sessionId, {
      receiptId: turn.receiptId,
      turnId: turn.receiptId,
      text: query,
      memory,
    });
    assert.match(plan.text, expected, `${label} must recall on query`);
    assert.doesNotMatch(plan.text, /项目后端默认使用 Rust/, 'committed project rules stay deduped across continuations');
    assert.ok(estimateTokens(plan.text) <= 4800);
    commitTurn(f, turn);
  }
});

test('oversized 65KB history snapshot and 35KB CLI switch handoff stay bounded, verifiable, idempotent, and refillable on demand', async t => {
  const f = shellFixture(t);
  const first = await sendTurn(f, 'snap-1', DATA.queries.vague9MTurn);
  f.records.get(first.sessionId).cli = 'claude';
  const { memory } = hydrateLargeMemory(f, first);

  // 1) Oversized 65KB history -> boundedSnapshot <= 1600 tokens, verifiable & preserves partial flag.
  const archived = DATA.historyMessages.map(m => ({ ...m, taskId: first.taskId, contextMessageId: `${first.sessionId}:${m.id}` }));
  f.histories.set(first.sessionId, archived);
  const rawSnapshot = historySnapshot(first.taskId, archived);
  const boundedSnap = boundedSnapshot(rawSnapshot);
  assert.equal(boundedSnap.truncated, true);
  assert.ok(estimateTokens(boundedSnap.text) <= 1600, `boundedSnapshot must stay <= 1600 tokens, got ${estimateTokens(boundedSnap.text)}`);
  const parsedSnap = JSON.parse(boundedSnap.text.split('\n')[1])[0];
  assert.equal(verifySnapshot(parsedSnap, parsedSnap.hash), true);
  const partialMsg = parsedSnap.messages.find(m => m.contextMessageId === `${first.sessionId}:a-18`);
  assert.ok(partialMsg, 'latest partial message should remain referenced in bounded snapshot');
  assert.equal(partialMsg.partial, true);
  assert.equal(partialMsg.truncated, true);

  // Verify lazy refillContext retrieves BOTH the truncated latest turn AND an early dropped turn
  // on demand without keeping 65KB in the prefix.
  const refilledLatest = f.runtime.refillContext(first.sessionId, {
    task_id: first.taskId,
    message_id: `${first.sessionId}:a-18`,
  });
  assert.equal(refilledLatest.page.found, true);
  const restoredLatest = JSON.parse(refilledLatest.page.message.evidenceExcerpt);
  assert.match(restoredLatest.content, /PARTIAL_REFILL_MARKER_ALPHA_9180K/);
  assert.match(restoredLatest.content, /END_MARKER_ALPHA_9180K/);

  const refilledEarly = f.runtime.refillContext(first.sessionId, {
    task_id: first.taskId,
    message_id: `${first.sessionId}:a-5`,
  });
  assert.equal(refilledEarly.page.found, true);
  const restoredEarly = JSON.parse(refilledEarly.page.message.evidenceExcerpt);
  assert.match(restoredEarly.content, /EARLY_DROPPED_REFILL_MARKER_T5/);
  assert.match(restoredEarly.content, /END_EARLY_T5/);

  // 2) Oversized 35KB Codex -> Claude CLI handoff -> boundedHandoff <= 1500 tokens + cold-retry idempotency.
  const boundedHo = boundedHandoff(DATA.pendingCliHandoff);
  assert.equal(boundedHo.truncated, true);
  assert.ok(estimateTokens(boundedHo.text) <= 1500, `boundedHandoff must stay <= 1500 tokens, got ${estimateTokens(boundedHo.text)}`);

  const record = f.records.get(first.sessionId);
  record.pendingCliHandoff = DATA.pendingCliHandoff;
  const host = {
    prepareTaskContext: f.runtime.prepareContext,
    taskContextSent: f.runtime.contextSent,
    taskContextComplete: f.runtime.contextComplete,
  };
  const managed = prepareManagedContext({
    host,
    memory,
    sessionName: first.sessionId,
    persisted: record,
    turn: { turnId: 'handoff-turn-1' },
    opts: { taskShellReceiptId: first.receiptId },
    text: DATA.queries.vague9MTurn,
    isFirstTurn: true,
  });
  const plan = f.store.get('receipt', first.receiptId).contextPlan;
  const handoffSource = plan.sources.find(s => s.reason === 'cli_switch');
  assert.ok(handoffSource, 'bounded CLI switch handoff must be included');
  assert.equal(handoffSource.truncated, true);
  assert.ok(plan.budget.used <= 4800, `handoff + rules must fit within 4800 tokens, got ${plan.budget.used}`);
  assert.match(plan.text, /项目后端默认使用 Rust/, 'genuine project rules must survive alongside bounded CLI handoff');

  const env = { contextLayers: [], userText: DATA.queries.vague9MTurn, suffix: '' };
  const retry1 = managed.attempt(env, { firstTurn: true, bareText: DATA.queries.vague9MTurn });
  const retry2 = managed.attempt(env, { firstTurn: true, bareText: DATA.queries.vague9MTurn });
  assert.equal(retry1.bareText, retry2.bareText, 'cold retry on large fixture must remain deterministic');
});

test('combined Turn-1 MultiCC-owned prefix (host prompts + subagent hint + plan + managed context) stays slim and enforces parallel batching', async t => {
  const f = shellFixture(t);
  const first = await sendTurn(f, 'total-prefix', DATA.queries.vague9MTurn);
  f.records.get(first.sessionId).cli = 'claude';
  const taskRow = f.store.get('task', first.taskId);
  f.store.set('task', first.taskId, { ...taskRow, ...DATA.task, id: first.taskId });
  const { memory } = hydrateLargeMemory(f, first);

  const plan = f.runtime.prepareContext(first.sessionId, {
    receiptId: first.receiptId,
    turnId: first.receiptId,
    text: DATA.queries.vague9MTurn,
    memory,
    isFirstTurn: true,
  });
  const hp = createHostPrompts({ PORT: '3456' }, { assistRoot: '/workspace/acme-hub/assist' });
  const subHint = buildSubagentProviderHint({ providerId: 'sub-fast', model: 'fast-model' });
  const planFull = buildPlanProgressPrompt({}, first.sessionId, { isFirstTurn: true });

  // Execution efficiency & parallel sub-agent delegation rules must be present.
  assert.match(hp.multiccImgHint, /\[Execution efficiency - batch calls & scope reads\]/);
  assert.match(hp.multiccImgHint, /parallel/i);
  assert.match(subHint, /parallel/i);
  assert.ok(hp.multiccImgHint.length < 7800, `multiccImgHint grew to ${hp.multiccImgHint.length}`);
  assert.ok(subHint.length < 1250, `subagentHint grew to ${subHint.length}`);
  assert.ok(planFull.length < 1050, `planFull grew to ${planFull.length}`);

  const totalPrefixChars = hp.multiccImgHint.length + subHint.length + planFull.length + plan.text.length;
  // Pre-optimization real baseline was 30,378 chars (without even counting planFull's 1,734 chars!).
  assert.ok(
    totalPrefixChars < 20_500,
    `combined Turn-1 prefix (${totalPrefixChars} chars) must stay far below 30,378-char pre-optimization baseline`,
  );
});

test('任务上下文的保留记录、截断标记及哈希与冻结实现一致', () => {
  const previous = require('./helpers/frozen-file-batch8/context-snapshot');
  for (const count of [0, 2, 9]) {
    const messages = Array.from({ length: count }, (_, i) => ({
      role: i === 0 ? 'user' : 'assistant', content: ('a中🙂' + i).repeat(180), tools: [],
    }));
    const snapshot = { taskId: 't', messages, omittedMessages: 2 };
    const handoff = { id: 'h', checkpoint: { task: { title: '计划'.repeat(160) },
      transcript: messages.map(m => ({ role: m.role, text: m.content })), git: { branch: 'b', commit: 'c' } } };
    for (const budget of [0, 30, 300, 1200, 30000]) {
      assert.deepEqual(boundedSnapshot(snapshot, budget), previous.boundedSnapshot(snapshot, budget));
      assert.deepEqual(boundedHandoff(handoff, budget), previous.boundedHandoff(handoff, budget));
    }
  }
});
