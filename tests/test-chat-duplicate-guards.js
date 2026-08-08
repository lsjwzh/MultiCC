'use strict';

/**
 * test-chat-duplicate-guards.js — chat 前端重复气泡守卫回归
 *
 * 复现并锁定「当前页面出现重复消息、刷新后消失」这类 bug 的修复：
 * 用最小假 DOM 驱动真实的 chat-event-controller / chat-history-store /
 * chat-history-view，回放 WS 事件序列，断言 DOM 中不出现重复 assistant 气泡。
 *
 * 覆盖的重复路径（修复见 chat-history-view.js / chat-event-controller.js）：
 *  S2  result 后迟到/回放的全量快照新建第二个气泡
 *  S4  result 后、commit 前重连，历史页含已完成消息而本地气泡无 id
 *  S5  codex 同一 assistant 帧被投递两次导致文本自我翻倍
 *  S7  重连把直播气泡升级为 interim id，最终 commit 换正式 id 再追加一份
 *  S6（todo）🔇 nudge 重试产生内容相同的持久化双胞胎——需在落库层做
 *      supersede 去重，属于另一类 bug（刷新后也可见），待后续任务修复。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createRig, scanDuplicates, SCENARIOS } = require(
  path.join(__dirname, '..', 'scripts', 'chat-dup-harness.js'),
);

for (const scenario of SCENARIOS) {
  const isKnownDup = scenario.name.startsWith('S6');
  const runner = isKnownDup ? test.todo : test;
  runner(`重复气泡场景 ${scenario.name}`, (t) => {
    const rig = createRig(scenario.cli || 'claude');
    rig.feed(scenario.events(rig));
    const { findings } = scanDuplicates(rig.messagesEl);
    if (isKnownDup) {
      // 已知遗留：持久化双胞胎需落库层 supersede；转绿后把本场景改为 test()。
      assert.ok(findings.length > 0, 'S6 已修复？请把本场景从 todo 转为正式断言');
      return;
    }
    assert.deepEqual(findings, [], `场景复现了重复气泡：\n${findings.join('\n')}`);
  });
}

// stream_start 契约回归（commit 714acf1）：adapter CLI（opencode 等）没有
// message_start 透传，server 改在回合开始广播 stream_start。注意这两个用例
// 不进 SCENARIOS 循环——跨两轮产出两个同文气泡是【正确行为】，
// scanDuplicates 会把同文当重复误报。
const { streamStart, assistantSnapshot, result } = require(
  path.join(__dirname, '..', 'scripts', 'chat-dup-harness.js'),
).helpers;

test('stream_start 契约：opencode 连续两轮相同回复各得一个完整气泡', () => {
  const T = '构建已完成，APK 产物已同步到仓库的 public 目录，可以直接下载安装。';
  const rig = createRig('opencode');
  rig.feed([
    streamStart(), assistantSnapshot(T), result(),
    streamStart(), assistantSnapshot(T), result(),
  ]);
  const bubbles = rig.messagesEl.querySelectorAll('.msg.assistant');
  assert.equal(bubbles.length, 2, `期望 2 个 assistant 气泡，实际 ${bubbles.length}（第二轮快照被 S2 守卫误杀？）`);
  for (const [i, b] of bubbles.entries()) {
    assert.ok(b.textContent.includes(T), `气泡 ${i + 1} 缺完整回复文本：「${b.textContent}」`);
  }
});

test('stream_start 重置直播状态（isStreaming=true、lastFinishedText 清空）', () => {
  const T = '这是一段用于验证回合收尾状态的回复文本，长度足够触发守卫。';
  const rig = createRig('opencode');
  rig.feed([streamStart(), assistantSnapshot(T), result()]);
  assert.ok(rig.state.lastFinishedText, 'result 后 lastFinishedText 应记住已完结文本');
  rig.feed([streamStart()]);
  assert.equal(rig.state.isStreaming, true, 'stream_start 必须把回合标记为 streaming');
  assert.equal(rig.state.lastFinishedText, '', 'stream_start 必须清空 lastFinishedText');
  // 旧契约（无 stream_start）下，第二轮同文快照会因 !isStreaming && text===lastFinishedText
  // 被 S2 守卫跳过、气泡消失——这正是 714acf1 修复前的症状，此处不做硬断言。
});
