'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A fake `zcode.cjs app-server` speaking the subset of the ZCode protocol the
// bridge drives (session/create|resume, session/subscribe, session/send,
// session/stop, v4/command). Every client request is appended to
// FAKE_ZCODE_LOG as one JSON line, tagged with the engine pid.
//
// The prompt picks the behavior:
//   "bg…"   — starts a background task (session.updated running, pid = this
//             engine), answers, then FAKE_ZCODE_BG_MS later completes the task
//             and wakes itself with an inputSource=background_task turn that
//             answers "woke".
//   "slow…" — streams one delta and never completes until stopped.
//   other   — answers "echo:<prompt>".
const SOURCE = String.raw`'use strict';
const fs = require('node:fs');
if (process.argv[2] !== 'app-server') process.exit(2);
const log = process.env.FAKE_ZCODE_LOG;
const bgMs = Number(process.env.FAKE_ZCODE_BG_MS || 400);
let sid = null, seq = 10, turnNo = 0, running = null;
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
const ev = (type, payload) => out({ method: 'session/event', params: { sessionId: sid, seq: ++seq, type, payload } });
function turn(text, extra) {
  const n = ++turnNo;
  ev('turn.started', { turnNumber: n, ...(extra || {}) });
  ev('model.streaming', { kind: 'text_delta', delta: text, assistantMessageId: 'a' + n });
  ev('turn.completed', { resultType: 'success', response: text, usage: { inputTokens: 2, outputTokens: 1 } });
}
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, method: m.method, params: m.params }) + '\n');
  if (m.method === 'session/create') {
    sid = 'sess_fake_' + process.pid;
    return out({ id: m.id, result: { session: { sessionId: sid } } });
  }
  if (m.method === 'session/resume') {
    sid = m.params.sessionId;
    return out({ id: m.id, result: { session: { sessionId: sid } } });
  }
  if (m.method === 'session/subscribe') return out({ id: m.id, result: { eventSeq: seq } });
  if (m.method === 'session/stop') return out({ id: m.id, result: {} });
  if (m.method === 'v4/command') {
    out({ id: m.id, result: {} });
    if (running) { running = null; ev('turn.completed', { resultType: 'cancelled' }); }
    return;
  }
  if (m.method !== 'session/send') return out({ id: m.id, result: {} });
  out({ id: m.id, result: { accepted: true, sessionId: sid } });
  const text = String(m.params.content);
  if (text.startsWith('slow')) {
    running = ++turnNo;
    ev('turn.started', { turnNumber: running });
    ev('model.streaming', { kind: 'text_delta', delta: 'working', assistantMessageId: 's' });
    return;
  }
  if (!text.startsWith('bg')) return turn('echo:' + text);
  ev('session.updated', { taskId: 'exec_1', taskKind: 'bash', status: 'running', pid: process.pid });
  turn('started background');
  setTimeout(() => {
    ev('session.updated', { taskId: 'exec_1', taskKind: 'bash', status: 'completed', pid: process.pid });
    turn('woke', { inputSource: 'background_task', inputVisibility: 'model-only' });
  }, bgMs);
});
`;

function writeFakeZcodeAppServer(root) {
  const engine = path.join(root, 'zcode.cjs');
  fs.writeFileSync(engine, SOURCE);
  return engine;
}

module.exports = { writeFakeZcodeAppServer };
