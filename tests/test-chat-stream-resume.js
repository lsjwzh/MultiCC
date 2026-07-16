'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-stream-resume-'));
const argLog = path.join(tmp, 'args.jsonl');
const fakeCli = [
  "const fs=require('fs')",
  "fs.appendFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(1))+'\\n')",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); buf=buf.slice(i+1)",
  "    process.stdout.write(JSON.stringify({type:'result', result:'ok'})+'\\n')",
  "  }",
  "})",
].join(';');

async function run(name, sessionId, resume) {
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId,
    baseArgs: ['-e', fakeCli, '--'],
    env: { ...process.env, ARG_LOG: argLog },
    resume,
  });
  await stream.send(name, 'probe', () => {});
  stream.close(name);
}

(async () => {
  await run('fresh-stream', 'fresh-id', false);
  await run('resumed-stream', 'resume-id', true);

  const rows = fs.readFileSync(argLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows[0], ['--session-id', 'fresh-id']);
  assert.deepStrictEqual(rows[1], ['--resume', 'resume-id']);
  assert.strictEqual(stream.status('fresh-stream'), null);
  assert.strictEqual(stream.status('resumed-stream'), null);
  console.log('chat-stream fresh/resume argument tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close('fresh-stream');
  stream.close('resumed-stream');
  fs.rmSync(tmp, { recursive: true, force: true });
});
