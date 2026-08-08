#!/usr/bin/env node
'use strict';
/**
 * diagnose-chat-duplicate.js — 前端重复消息诊断工具（交互版）
 *
 * 加载真实前端模块（chat-event-controller / chat-history-store /
 * chat-history-view），在最小假 DOM 上回放各种 WS 事件序列（重连竞态、
 * 回放帧、nudge 重试……），每个场景结束后扫描 DOM 判定是否出现重复气泡。
 * 回归断言版在 tests/test-chat-duplicate-guards.js；本脚本用于人工排查时
 * 打印每个场景的 DOM 快照与判定细节。
 *
 * 运行：node scripts/diagnose-chat-duplicate.js [--verbose]
 */

const VERBOSE = process.argv.includes('--verbose');
const { createRig, scanDuplicates, SCENARIOS } = require('./chat-dup-harness');

let dupCount = 0;
console.log('═'.repeat(72));
console.log('chat 重复消息诊断 · 加载真实模块：chat-event-controller + history-store + history-view');
console.log('═'.repeat(72));
for (const scenario of SCENARIOS) {
  const rig = createRig(scenario.cli || 'claude');
  try {
    rig.feed(scenario.events(rig));
  } catch (error) {
    console.log(`\n✗ ${scenario.name}\n  运行异常: ${error.stack.split('\n').slice(0, 3).join(' | ')}`);
    dupCount += 1;
    continue;
  }
  const { findings, bubbles } = scanDuplicates(rig.messagesEl);
  const verdict = findings.length ? 'DUPLICATE' : 'CLEAN';
  if (findings.length) dupCount += 1;
  console.log(`\n${verdict === 'CLEAN' ? '✓' : '✗'} [${verdict}] ${scenario.name}`);
  console.log(`  DOM：${bubbles.map(b => `${b.kind}${b.msgId ? '#' + b.msgId : ''}(${b.text.length}字)`).join(' → ') || '（空）'}`);
  for (const f of findings) console.log(`  ⚠ ${f}`);
  if (VERBOSE) {
    for (const b of bubbles) console.log(`    · ${b.kind}#${b.msgId || '-'} 「${b.text.slice(0, 60)}」`);
  }
}
console.log('\n' + '═'.repeat(72));
console.log(dupCount
  ? `${dupCount} 个场景出现重复（含已知遗留场景）`
  : '所有场景均未出现重复');
