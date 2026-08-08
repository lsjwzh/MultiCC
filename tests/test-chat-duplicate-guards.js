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
