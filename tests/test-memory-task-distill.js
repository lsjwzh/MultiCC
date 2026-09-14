'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const {
  cleanMemoryCandidate,
  mergeAutoSection,
  similar,
  createTaskMemoryDistiller,
  AUTO_SECTION,
} = require('../src/memory/task-distill');
const {
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
} = require('../src/classify/task-attribution');

// ── cleanMemoryCandidate ───────────────────────────────────────────────────

test('cleanMemoryCandidate normalizes, clips and rejects placeholders', () => {
  assert.equal(cleanMemoryCandidate('  记住：\n接口  /x 已   固化  '), '记住：接口 /x 已 固化');
  assert.equal(cleanMemoryCandidate(null), null);
  assert.equal(cleanMemoryCandidate('null'), null);
  assert.equal(cleanMemoryCandidate('无'), null);
  assert.equal(cleanMemoryCandidate('短'), null);
  const clipped = cleanMemoryCandidate('长'.repeat(400));
  assert.equal(clipped.length, 240);
  assert.ok(clipped.endsWith('…'));
});

// ── mergeAutoSection：追加 / 去重替换 / 容量 / 手工区隔离 ───────────────────

test('mergeAutoSection appends into a fresh file', () => {
  const merged = mergeAutoSection('', '[aux] 首条结论');
  assert.match(merged.content, new RegExp(AUTO_SECTION));
  assert.match(merged.content, /- \[aux\] 首条结论/);
  assert.equal(merged.replaced, false);
});

test('mergeAutoSection replaces a similar line instead of appending', () => {
  const first = mergeAutoSection('', '[aux] 任务图谱 API 已上线，路由 /api/task-graph');
  const second = mergeAutoSection(first.content, '[aux] 任务图谱 API 已上线，路由是 /api/task-graph');
  assert.equal(second.replaced, true);
  const lines = second.content.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /路由是/);
});

test('mergeAutoSection never touches manual content or other sections', () => {
  const manual = '# 任务记忆\n\n## 人工笔记\n- 这行是手工写的，谁都不许改\n';
  const merged = mergeAutoSection(manual, '[aux] 上下文注入走一次性提示层');
  assert.match(merged.content, /- 这行是手工写的，谁都不许改/);
  assert.doesNotMatch(merged.content, /## 人工笔记\n- \[aux\]/);
  const again = mergeAutoSection(merged.content, '[aux] refill 路径要计入 estimated_tokens');
  assert.match(again.content, /一次性提示层/);
  assert.match(again.content, /estimated_tokens/);
  assert.match(again.content, /- 这行是手工写的，谁都不许改/);
});

test('mergeAutoSection drops the oldest auto lines beyond capacity', () => {
  const notes = [
    '路由把 board 卡与 shell 持久任务按 taskId 合并',
    '渲染器用黄金角螺旋铺初始位置',
    '边分红橙青灰四种颜色区分类型',
    'provisional 节点画成半透明',
    '壳画成旋转四十五度的方块',
    '节点弹窗可以直达 Air 任务页',
    '交付回执走 evidence 钩子',
  ];
  let content = '';
  for (const note of notes.slice(0, 6)) content = mergeAutoSection(content, `[aux] ${note}`).content;
  const squeezed = mergeAutoSection(content, `[aux] ${notes[6]}`, { maxAutoLines: 3 });
  const lines = squeezed.content.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /壳画成旋转四十五度的方块/);
  assert.match(lines[1], /节点弹窗可以直达 Air 任务页/);
  assert.match(lines[2], /交付回执走 evidence 钩子/);
});

test('similar uses containment and bigram jaccard', () => {
  assert.equal(similar('接口已固定为 /api/x', '接口已固定为 /api/x'), true);
  assert.equal(similar('任务图谱 API 已上线', 'API 已上线（任务图谱）'), true);
  assert.equal(similar('完全不同的一句话甲', '另一句毫无交集的内容乙'), false);
});

// ── distiller：真实文件系统（tmp） ─────────────────────────────────────────

function distillerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-distill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = new Map();
  const distiller = createTaskMemoryDistiller({
    fs, path,
    taskDir: (dirId, taskId) => path.join(root, String(dirId), 'tasks', String(taskId)),
    listFiles: dir => {
      const file = path.join(dir, 'MEMORY.md');
      if (!fs.existsSync(file)) return [];
      return [{ name: 'MEMORY.md', content: fs.readFileSync(file, 'utf8') }];
    },
    logger: { warn() {} },
  });
  return { root, distiller, wrote: (dirId, taskId) => fs.readFileSync(path.join(root, dirId, 'tasks', taskId, 'MEMORY.md'), 'utf8') };
}

test('distiller writes, dedupes and skips invalid input on the real fs', t => {
  const { distiller, wrote } = distillerFixture(t);
  assert.equal(distiller.record({ dirId: 'd1', taskId: 'tsk_a', text: '结论：任务图谱上下文按邻接注入' }), true);
  assert.equal(distiller.record({ dirId: 'd1', taskId: 'tsk_a', text: '结论：任务图谱上下文按邻接注入（更新表述）' }), true);
  assert.equal(distiller.record({ dirId: 'd1', taskId: 'tsk_a', text: '无' }), false);
  assert.equal(distiller.record({ dirId: null, taskId: 'tsk_a', text: '有 dir 才能写' }), false);
  const content = wrote('d1', 'tsk_a');
  const lines = content.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 1, '相似候选去重后只剩一条');
  assert.match(lines[0], /更新表述/);
  assert.match(content, new RegExp(AUTO_SECTION));
});

// ── 归因 aux：memory_candidate 与 relation=same 弱分组 ──────────────────────

test('parseTaskAttribution extracts memory_candidate and allows same+relatedTaskId', () => {
  const parsed = parseTaskAttribution('```json\n{"taskName":"任务图谱","phase":"implementing","relation":"same","taskId":"tsk_a","relatedTaskId":"tsk_b","memory_candidate":"图谱上下文注入走 taskContextSeed 一次性提示层"}\n```', {
    fallbackTaskId: 'tsk_a',
    allowedTaskIds: ['tsk_a', 'tsk_b'],
  });
  assert.equal(parsed.relation, 'same');
  assert.equal(parsed.taskId, 'tsk_a');
  assert.equal(parsed.relatedTaskId, 'tsk_b', 'relation=same 也允许 relatedTaskId 形成弱分组');
  assert.equal(parsed.memoryCandidate, '图谱上下文注入走 taskContextSeed 一次性提示层');

  // 指向自己 → 拒绝。
  const self = parseTaskAttribution('{"relation":"same","taskId":"tsk_a","relatedTaskId":"tsk_a","taskName":"x任务"}', {
    fallbackTaskId: 'tsk_a', allowedTaskIds: ['tsk_a'],
  });
  assert.equal(self.relatedTaskId, null);

  // 不在允许列表 → 拒绝；占位 memory_candidate → null。
  const outside = parseTaskAttribution('{"relation":"same","taskId":"tsk_a","relatedTaskId":"tsk_ghost","taskName":"x任务","memory_candidate":"无"}', {
    fallbackTaskId: 'tsk_a', allowedTaskIds: ['tsk_a'],
  });
  assert.equal(outside.relatedTaskId, null);
  assert.equal(outside.memoryCandidate, null);

  // 旧行数格式回放不带 memory_candidate。
  const legacy = parseTaskAttribution('目标：旧任务\n阶段：实现中', { fallbackTaskId: 'tsk_a' });
  assert.equal(legacy.memoryCandidate, null);
});

test('attribution system prompt asks for memory_candidate', () => {
  const prompt = buildTaskAttributionSystemPrompt({ recentTasks: [], currentTaskId: null });
  assert.match(prompt, /memory_candidate/);
  assert.match(prompt, /relation=same 时也可填 relatedTaskId/);
});

// ── evidence：交付回执 published 后触发蒸馏钩子 ─────────────────────────────

test('evidence published hook fires with the correlated task binding', async t => {
  const { createTaskShellStore } = require('../src/task-shell/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-evidence-hook-'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = createTaskShellStore(path.join(dir, 'store.sqlite'));

  // 一个最小的真实 git 仓库：published 的核验需要真的 rev-parse/status。
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = async (...args) => (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
  await git('init', '-q');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  await git('add', '.');
  await git('commit', '-qm', 'init');
  await git('branch', '-M', 'main');
  const head = await git('rev-parse', 'HEAD');

  const events = [];
  const { createDeliveryEvidence } = require('../src/task-routing/evidence');
  const evidence = createDeliveryEvidence(store, {
    capture: async () => ({ revision: 'code_x', head, repoId: 'repo_x', dirty: false }),
    now: () => 1234,
    onIntegrationPublished: payload => events.push(payload),
  });
  evidence.begin({ sessionId: 's1', turnId: 'run1', taskId: 'tsk_a', workspaceId: 'w', workspacePath: repo, baseRef: 'refs/heads/main' });
  evidence.attempt('run1', 'att1');
  await evidence.finalize('run1', { attemptId: 'att1', outcome: 'succeeded', resultDurable: true, usageDurable: true, pendingInput: false });

  // 与 repo-actor 一致：非 raw 输出去掉尾换行，否则 rev-parse 比对必挂。
  const execGit = async (cwd, args) => (await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 64 })).stdout.trim();
  const hooks = evidence.hooks('s1');
  await hooks.prepared({
    operationId: 'op_1', worktreePath: repo, dirPath: repo,
    baseRef: 'refs/heads/main', sourceHead: head, integrationHead: head,
  }, execGit);
  const result = await hooks.published('op_1', execGit);
  assert.equal(result.state, 'published');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 's1');
  assert.equal(events[0].taskId, 'tsk_a');
  assert.equal(events[0].operationId, 'op_1');
  assert.equal(events[0].baseRef, 'refs/heads/main');
});
