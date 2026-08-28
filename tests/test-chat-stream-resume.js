'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-stream-resume-'));
const argLog = path.join(tmp, 'args.jsonl');
let disposed = 0;
const fakeCli = [
  "const fs=require('fs')",
  "const argv=process.argv.slice(1)",
  "fs.appendFileSync(process.env.ARG_LOG, JSON.stringify(argv)+'\\n')",
  "const missing=process.env.MISSING_ON_RESUME==='1'&&argv.includes('--resume')",
  "const missingAfterOutput=process.env.MISSING_AFTER_OUTPUT==='1'&&argv.includes('--resume')",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); const line=buf.slice(0,i); buf=buf.slice(i+1)",
  "    const input=JSON.parse(line); const receivedText=input.message.content[0].text",
  "    if(missingAfterOutput)process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'already emitted'}]}})+'\\n')",
  "    const result=(missing||missingAfterOutput)?{type:'result',subtype:'error_during_execution',is_error:true,num_turns:0,duration_api_ms:0,errors:['No conversation found with session ID: missing-id']}:{type:'result',subtype:'success',is_error:false,result:'ok',receivedText}",
  "    process.stdout.write(JSON.stringify(result)+'\\n')",
  "  }",
  "})",
  "process.stdin.on('end',()=>process.exit(0))",
].join(';');

async function run(name, sessionId, resume, options = {}) {
  const events = [];
  const captured = [];
  const recoveries = [];
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId,
    baseArgs: ['-e', fakeCli, '--'],
    env: { ...process.env, ARG_LOG: argLog, ...options.env },
    resume,
    onNewSessionId: id => captured.push(id),
    onResumeTargetMissing: info => {
      recoveries.push(info);
      return options.recoveryText ? { text: options.recoveryText } : undefined;
    },
    onDispose: () => { disposed += 1; },
  });
  await stream.send(name, 'probe', event => events.push(event));
  stream.close(name);
  return { events, captured, recoveries };
}

(async () => {
  await run('fresh-stream', 'fresh-id', false);
  await run('resumed-stream', 'resume-id', true);
  const recovered = await run('missing-resume-stream', 'missing-id', true, {
    env: { MISSING_ON_RESUME: '1' },
    recoveryText: 'checkpoint + original probe',
  });
  const unsafe = await run('missing-after-output-stream', 'unsafe-id', true, {
    env: { MISSING_AFTER_OUTPUT: '1' },
  });

  const rows = fs.readFileSync(argLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows[0], ['--session-id', 'fresh-id']);
  assert.deepStrictEqual(rows[1], ['--resume', 'resume-id']);
  assert.deepStrictEqual(rows[2], ['--resume', 'missing-id']);
  assert.strictEqual(rows[3][0], '--session-id');
  assert.notStrictEqual(rows[3][1], 'missing-id');
  assert.deepStrictEqual(recovered.captured, [rows[3][1]],
    'the replacement id must be persisted before the fresh spawn');
  assert.strictEqual(recovered.recoveries.length, 1,
    'a missing resume target is recovered exactly once');
  assert.strictEqual(recovered.recoveries[0].previousSessionId, 'missing-id');
  assert.strictEqual(recovered.recoveries[0].sessionId, rows[3][1]);
  assert.strictEqual(recovered.events.length, 1,
    'the local resume error must not leak into provider/API error handling');
  assert.strictEqual(recovered.events[0].subtype, 'success');
  assert.strictEqual(recovered.events[0].receivedText, 'checkpoint + original probe',
    'the fresh process must receive the recovery checkpoint payload');
  assert.deepStrictEqual(rows[4], ['--resume', 'unsafe-id']);
  assert.strictEqual(rows.length, 5,
    'a resume error after visible output must not spawn a replay process');
  assert.deepStrictEqual(unsafe.captured, []);
  assert.deepStrictEqual(unsafe.recoveries, []);
  assert.strictEqual(unsafe.events[0].type, 'assistant');
  assert.strictEqual(unsafe.events[1].is_error, true);
  assert.strictEqual(stream.status('fresh-stream'), null);
  assert.strictEqual(stream.status('resumed-stream'), null);
  assert.strictEqual(stream.status('missing-resume-stream'), null);
  assert.strictEqual(stream.status('missing-after-output-stream'), null);
  assert.strictEqual(disposed, 4);
  console.log('chat-stream fresh/resume argument tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close('fresh-stream');
  stream.close('resumed-stream');
  stream.close('missing-resume-stream');
  stream.close('missing-after-output-stream');
  fs.rmSync(tmp, { recursive: true, force: true });
});
