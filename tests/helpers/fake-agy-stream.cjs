#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log((process.env.AGY_TEST_OLD || process.argv[1].endsWith('.old.cjs')) ? '--output-format stream-json' : '--input-format    text, stream-json');
  process.exit(0);
}
const flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : '';
const log = flag('--test-log') || process.env.AGY_TEST_LOG;
const id = flag('--conversation') || '模拟会话';
const record = item => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...item }) + '\n');
const emit = (event, fields) => console.log(JSON.stringify({ event, conversation_id: id, [event]: fields }));
record({ argv, cwd: process.cwd(), env: process.env.MULTICC_DIR_ID });
if (process.env.AGY_TEST_BAD_HELP && argv.includes('--input-format')) {
  console.error('flag provided but not defined: -input-format');
  process.exit(2);
}
let turns = 0;
function run(content) {
  record({ content });
  turns++;
  if (turns === 1) emit('init', { model: flag('--model') || '默认模型' });
  if (content.includes('等待取消')) return;
  if (content.includes('无输出崩溃')) process.exit(17);
  if (content.includes('持续工具')) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    record({ tool: child.pid });
    return;
  }
  if (content.includes('先调用工具')) emit('step_update', { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file' });
  if (content.includes('先输出文本')) emit('step_update', { conversation_id: id, step_type: 'agent_response', state: 'ACTIVE', text_delta: '已输出' });
  if ((flag('--effort') || content.includes('持续拒绝')) && content.includes('强度拒绝')) {
    const error = '--effort is not supported for model m';
    if (content.includes('纯诊断')) {
      console.error(error);
      process.exit(1);
    }
    emit('result', { status: 'ERROR', error });
    return;
  }
  emit('step_update', { conversation_id: id, step_type: 'agent_response', state: 'DONE', step_index: turns,
    usage: { input_tokens: 11, output_tokens: 2 } });
  emit('result', { conversation_id: id, status: 'SUCCESS', response: '好', num_turns: turns,
    usage: { input_tokens: turns * 11, output_tokens: turns * 2 } });
}

if (argv.includes('-p')) run(flag('-p'));
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.event !== 'user' || typeof msg.message?.content !== 'string') process.exit(2);
  run(msg.message.content);
});
