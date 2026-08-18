'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  buildTaskRunContext,
  isTaskRunWrapperText,
  stableTaskRunId,
} = require('../src/task-run-context');

test('stableTaskRunId is replay-stable and separates follow-up admissions', () => {
  const first = stableTaskRunId('task-42', 'create:client-key');
  assert.equal(first, stableTaskRunId('task-42', 'create:client-key'));
  assert.notEqual(first, stableTaskRunId('task-42', 'followup:client-key'));
  assert.notEqual(first, stableTaskRunId('task-43', 'create:client-key'));
  assert.match(first, /^tr_[a-f0-9]{32}$/);
  assert.throws(() => stableTaskRunId('', 'key'), /taskId/);
  assert.throws(() => stableTaskRunId('task-42', ''), /clientKey/);
});

test('context output is deterministic and sorts messages chronologically', () => {
  const input = {
    task: {
      id: 'task-42',
      title: '实现临时任务运行池',
      summary: '每个任务运行都使用新的 CLI 上下文。',
      status: 'active',
    },
    messages: [
      { id: 'm3', role: 'assistant', ts: 30, text: '第三条：给出设计结论。' },
      { id: 'm1', role: 'user', ts: 10, text: '第一条：提出需求。' },
      { id: 'm2', role: 'assistant', ts: 20, text: '第二条：确认边界。' },
    ],
    currentText: '现在开始实现纯上下文模块。',
  };

  const first = buildTaskRunContext(input);
  const second = buildTaskRunContext({
    ...input,
    task: { status: 'active', summary: input.task.summary, title: input.task.title, id: input.task.id },
    messages: [input.messages[1], input.messages[2], input.messages[0]],
  });

  assert.deepEqual(second, first);
  assert.ok(first.text.indexOf('第一条') < first.text.indexOf('第二条'));
  assert.ok(first.text.indexOf('第二条') < first.text.indexOf('第三条'));
  assert.match(first.text, /当前要求[：:]\n现在开始实现纯上下文模块。/);
  assert.match(first.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.manifest.messageCount, 3);
});

test('history keeps the most recent entries within budget while current request is never truncated', () => {
  const currentText = `必须完整保留的当前要求：${'当前'.repeat(70)}：结束标记`;
  const result = buildTaskRunContext({
    task: { id: 'task-budget', title: '预算裁剪' },
    messages: [
      { id: 'old', role: 'user', ts: 1, text: `最旧消息-${'旧'.repeat(220)}` },
      { id: 'middle', role: 'assistant', ts: 2, text: `中间消息-${'中'.repeat(160)}` },
      { id: 'latest', role: 'user', ts: 3, text: `最近消息-${'新'.repeat(80)}` },
    ],
    currentText,
    maxChars: 500,
  });

  assert.match(result.text, /结束标记/);
  assert.match(result.text, /最近消息/);
  assert.doesNotMatch(result.text, /最旧消息/);
  assert.ok(result.text.length <= 500, `expected <= 500 chars, got ${result.text.length}`);
  assert.equal(result.manifest.history.included, 1);
  assert.equal(result.manifest.history.omitted, 2);
  assert.equal(result.manifest.history.truncated, true);
});

test('artifact manifest stores bounded metadata and content hashes, not artifact bodies', () => {
  const hugeBody = `构建产物正文-${'x'.repeat(20_000)}`;
  const result = buildTaskRunContext({
    task: { id: 'task-artifacts', title: '保留产物引用' },
    messages: [],
    artifacts: [{
      id: 'artifact-1',
      name: 'design.md',
      path: 'artifacts/design.md',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(hugeBody),
      content: hugeBody,
      hash: `sha256:${'0'.repeat(64)}`,
    }],
    currentText: '依据已有设计继续。',
  });

  assert.equal(result.manifest.artifacts.length, 1);
  assert.equal(
    result.manifest.artifacts[0].hash,
    `sha256:${crypto.createHash('sha256').update(hugeBody).digest('hex')}`,
    'artifact bodies take precedence over an untrusted supplied digest',
  );
  assert.equal(result.manifest.artifacts[0].name, 'design.md');
  assert.equal(Object.hasOwn(result.manifest.artifacts[0], 'content'), false);
  assert.equal(Object.hasOwn(result.manifest.artifacts[0], 'text'), false);
  assert.doesNotMatch(JSON.stringify(result), /构建产物正文/);
  assert.ok(JSON.stringify(result.manifest).length < 2_000);
});

test('secrets and native CLI session identities are removed from text and manifest', () => {
  const result = buildTaskRunContext({
    task: {
      id: 'task-secret',
      title: '脱敏任务',
      summary: 'Authorization: Custom task-secret-value',
      nativeSessionId: 'native-session-must-not-escape',
      cliSessionId: 'cli-session-must-not-escape',
      apiKey: 'task-api-key-must-not-escape',
    },
    messages: [
      {
        id: 'secret-message',
        role: 'user',
        ts: 1,
        text: 'api_key=message-secret-key token: message-secret-token password=hunter42',
        nativeSessionId: 'message-native-id',
      },
      {
        id: 'structured-secret-message',
        role: 'assistant',
        ts: 2,
        content: {
          textValue: '可保留内容',
          nativeSessionId: 'nested-native-id',
          cliSessionId: 'nested-cli-id',
        },
      },
    ],
    artifacts: [{
      id: 'secret-artifact',
      name: 'Authorization Bearer artifact-secret-token.txt',
      content: 'artifact-body-secret',
      cliSessionId: 'artifact-cli-id',
    }],
    currentText: '请使用 Bearer current-secret-token；ACCESS_TOKEN=current-access-secret 继续。\n'
      + '{"nativeSessionId":"raw-native-id","cliSessionId":"raw-cli-id"}',
  });
  const serialized = JSON.stringify(result);

  for (const forbidden of [
    'task-secret-value', 'native-session-must-not-escape', 'cli-session-must-not-escape',
    'task-api-key-must-not-escape', 'message-secret-key', 'message-secret-token',
    'hunter42', 'message-native-id', 'nested-native-id', 'nested-cli-id',
    'artifact-secret-token', 'artifact-cli-id', 'current-secret-token',
    'current-access-secret', 'raw-native-id', 'raw-cli-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must be redacted`);
  }
  assert.doesNotMatch(serialized, /nativeSessionId|cliSessionId/);
  assert.match(result.text, /\[已脱敏\]/);
});

test('a first run with no history does not render empty history or artifact sections', () => {
  const result = buildTaskRunContext({
    task: { id: 'task-first', title: '首轮任务' },
    messages: [],
    currentText: '执行首轮请求。',
  });

  assert.doesNotMatch(result.text, /历史对话/);
  assert.doesNotMatch(result.text, /相关产物/);
  assert.doesNotMatch(result.text, /暂无|（空）/);
  assert.equal(result.manifest.messageCount, 0);
  assert.deepEqual(result.manifest.artifacts, []);
});

test('content hash changes when the effective current requirement changes', () => {
  const base = {
    task: { id: 'task-hash', title: '哈希任务' },
    messages: [{ id: 'm1', role: 'user', ts: 1, text: '历史相同' }],
  };
  const first = buildTaskRunContext({ ...base, currentText: '要求 A' });
  const replay = buildTaskRunContext({ ...base, currentText: '要求 A' });
  const changed = buildTaskRunContext({ ...base, currentText: '要求 B' });

  assert.deepEqual(replay, first);
  assert.notEqual(changed.hash, first.hash);
  assert.notEqual(changed.manifest.currentTextHash, first.manifest.currentTextHash);
});

// The compiled context / Commander wrapper is transport-only. One shared
// predicate guards every consumer (ledger writer, board projection, next-turn
// compile input) so the scaffold can never leak into the conversation view.
test('isTaskRunWrapperText identifies every wrapper shape, never raw user text', () => {
  const wall = buildTaskRunContext({
    task: { id: 'task-42', title: '对比 omnigent 功能' },
    messages: [],
    currentText: '补充验收细节',
  }).text;
  assert.equal(isTaskRunWrapperText(wall), true, 'compiled context wall');
  const commander = [
    '【Commander 单向路由任务】',
    '这是宿主路由器直接投递的执行任务。请在当前 worker 会话完成，不要再次分发。',
    '',
    `【任务：对比 omnigent 功能】\n${wall}`,
  ].join('\n');
  assert.equal(isTaskRunWrapperText(commander), true, 'Commander-routed wrapper');
  assert.equal(isTaskRunWrapperText(`【任务：对比 omnigent 功能】\n补充验收细节`), true,
    'manual routed wrapper');
  assert.equal(isTaskRunWrapperText(`前缀说明\n${commander}`), true,
    'wrapper stays detected behind a goal-note prefix');

  assert.equal(isTaskRunWrapperText('从任务面板进入统一通道'), false, 'raw admission text');
  assert.equal(isTaskRunWrapperText('【任务进展】顺手记一下'), false,
    'lookalike user text is not a wrapper');
  assert.equal(isTaskRunWrapperText(''), false);
  assert.equal(isTaskRunWrapperText(null), false);
  assert.equal(isTaskRunWrapperText(undefined), false);
});
