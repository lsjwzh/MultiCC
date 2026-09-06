'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Deliberately container-only: cannot accidentally target the live host server.
assert.ok(fs.existsSync('/.dockerenv'), 'Run via docker compose exec lab');
assert.equal(process.env.MULTICC_DATA_DIR, '/var/lib/multicc/data');
const seed = JSON.parse(fs.readFileSync('/var/lib/multicc/data/lab-seed.json'));
const [a, b] = seed.shells.map(s => s.shellId);
const prefix = randomUUID();
async function api(route, body) {
  const response = await fetch('http://127.0.0.1:3000/api/task-shells/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${process.env.ACCESS_TOKEN}` }, signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
async function wait(check) {
  for (let i = 0; i < 200; i++) {
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Lab smoke wait timed out');
}
(async () => {
  let original;
  try {
    original = await api(`${a}/messages`, { text: 'LAB_WAIT 30', clientMsgId: prefix + '-first' });
    const active = await wait(async () => { const d = await api(`${a}/tasks/${original.taskId}`); return d.execution.busy && d.execution.turnId && d; });
    await api(`${b}/links`, { taskId: original.taskId });
    const input = { text: 'Independent Docker fork', clientMsgId: prefix + '-fork', taskId: original.taskId };
    const fork = await api(`${b}/messages`, input);
    assert.equal(fork.decision, 'fork'); assert.notEqual(fork.sessionId, original.sessionId);
    assert.deepEqual(await api(`${b}/messages`, input), fork);
    const completed = await wait(async () => {
      const d = await api(`${b}/tasks/${fork.taskId}`);
      return !d.execution.busy && d.messages.some(m => m.role === 'assistant') && d;
    });
    assert.equal(completed.task.parentTaskId, original.taskId);
    assert.equal(completed.snapshots.flatMap(s => s.messages).length, 0);
    await api(`${a}/messages`, { text: '', intent: 'cancel', taskId: original.taskId, turnId: active.execution.turnId, clientMsgId: prefix + '-cancel' });
    await wait(async () => !(await api(`${a}/tasks/${original.taskId}`)).execution.busy);
    const context = await api(`${b}/messages`, { text: 'Use completed context', contextTaskIds: [fork.taskId], clientMsgId: prefix + '-context' });
    const detail = await wait(async () => {
      const d = await api(`${b}/tasks/${context.taskId}`);
      return !d.execution.busy && d.messages.some(m => m.role === 'assistant') && d;
    });
    assert.equal(detail.task.parentTaskId, null);
    assert.equal(detail.snapshots[0].taskId, fork.taskId);
    assert.ok(detail.snapshots[0].messages.some(m => m.role === 'assistant'));
    console.log('PASS seeded Docker lab: two shells, busy fork, receipt replay, cancel, completed context');
  } finally {
    if (original) {
      const d = await api(`${a}/tasks/${original.taskId}`);
      if (d.execution.busy && d.execution.turnId) await api(`${a}/messages`, {
        text: '', intent: 'cancel', taskId: original.taskId, turnId: d.execution.turnId, clientMsgId: prefix + '-cleanup',
      });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
