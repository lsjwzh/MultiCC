#!/usr/bin/env node
'use strict';

// A deterministic protocol fixture, deliberately incapable of tools/network use.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

if (!process.argv.includes('exec')) {
  console.log('codex-cli 0.0.0-multicc-lab');
} else {
  const prompt = process.argv.at(-1) || '';
  const sessionId = process.env.MULTICC_SESSION_ID || 'standalone';
  const emit = value => console.log(JSON.stringify(value));
  // Put the marker on the final user line; historical markers must not re-hold.
  const lines = prompt.split('\n').map(s => s.trim());
  const marker = lines.filter(s => /^LAB_(?:WAIT|FAIL)(?:\s|$)/.test(s)).at(-1) || '';
  const seconds = marker.startsWith('LAB_WAIT') ? Math.min(120, Math.max(1, Number(marker.split(/\s+/)[1]) || 20)) : 0;
  const data = process.env.MULTICC_DATA_DIR;
  if (data) {
    fs.mkdirSync(data, { recursive: true });
    fs.appendFileSync(path.join(data, 'fake-cli-invocations.jsonl'), JSON.stringify({
      sessionId, cwd: process.cwd(), at: new Date().toISOString(), delaySeconds: seconds,
      promptHash: createHash('sha256').update(prompt).digest('hex'),
    }) + '\n');
  }
  emit({ type: 'thread.started', thread_id: 'lab-' + sessionId });
  setTimeout(() => {
    if (marker === 'LAB_FAIL') {
      emit({ type: 'error', message: 'Intentional Docker lab CLI failure' });
      process.exitCode = 1;
      return;
    }
    emit({ type: 'item.completed', item: { type: 'agent_message', text:
      `Docker 测试任务已完成。\n\n执行会话：${sessionId}\n\n这是模拟 CLI 的固定响应，未调用真实模型。` } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } });
  }, seconds * 1000);
}
