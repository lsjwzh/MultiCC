'use strict';

// Differential run for the 30 orchestration and unattended routes retired from
// src/routes/{aux-goal,aux-runs,orchestration}.js and src/unattended/routes.js
// and now answered by native/gateway/src/app/orchestration_routes.rs (rules in
// native/core/src/orchestration_routes.rs):
//
//   GET      /api/aux/{status,health,history}   POST /api/aux/{enqueue,cancel}
//   GET|POST /api/aux/config   /api/settings/goal       POST /api/goal/precheck
//   GET      /api/sessions/:id/aux-runs[/:runId]
//   GET|POST /api/sessions/:id/unattended
//   POST|GET /api/sessions/:id/scheduled-messages
//   DELETE   /api/sessions/:id/scheduled-messages/:messageId
//   GET      /api/sessions/:id/{tasks,dispatches,queue}
//   POST     /api/sessions/:id/{user-input/dismiss,queue/action}
//   GET      /api/v1/sessions/:id/waits
//
//   node docs/rust-migration/differential/orchestration-routes.js <repo> <gateway> [addon]
//
// The Node side mounts the frozen retired modules (tests/helpers/
// legacy-orchestration-routes/, `git show HEAD:<file>`, all 16 orchestration
// routes together, behind the real public-session guard) over one scripted
// world (.../world.js). The Rust front door calls its host port
// (/api/__host/orchestration); the stub child mounts the live
// src/routes/orchestration-host.js over the same world. The comparison covers
// path matching, parameter decoding, the
// query subset, the Idempotency-Key header, the automatic OPTIONS union, the
// guard in both envelopes, and -- the easiest thing to get wrong --
// `GET /api/v1/sessions/:id/waits` (ours) against `GET /api/sessions/:id/waits`
// (the distinct unprefixed projection).
//
// Every case is compared byte for byte (status, body, ETag, headers). On top of
// that the run compares the *side effects*: the ordered list of calls each
// world received (scheduler, Aux model, supervisor, turn engine, ...) and the
// two config files the Aux/goal routes write. A coverage guard fails the run if
// a branch the migration depends on was never exercised.
const fs = require('fs');
const path = require('path');
const { main, waitForFixture } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-orch-1' };
const J = { ...L, 'Content-Type': 'application/json' };

let workPath = '';
let oracleWorld = null;
let upstreamText = '';
const problems = [];
const pending = [];

function writeControl(patch) {
  fs.writeFileSync(path.join(workPath, 'control.json'), JSON.stringify(patch || {}));
}

// Every case rewrites the control file first, so one case's flipped fact never
// leaks into the next.
function add(name, request, hooks = {}) {
  const control = hooks.control || {};
  pending.push([name, request, { ...hooks, before: async () => writeControl(control) }]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const del = (url, headers = L) => ({ method: 'DELETE', url, headers });
  const post = (url, body, headers = J) => ({
    method: 'POST', url, headers, body: typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body),
  });
  const idem = key => ({ ...J, 'Idempotency-Key': key });

  // ── aux queue ───────────────────────────────────────────────────────────
  add('aux status idle', () => get('/api/aux/status'));
  add('aux status HEAD', () => head('/api/aux/status'));
  add('aux status with a trailing slash', () => get('/api/aux/status/'));
  add('aux status with mixed case', () => get('/api/Aux/Status'));
  add('aux health', () => get('/api/aux/health'));
  add('aux history before any task', () => get('/api/aux/history'));
  add('aux enqueue without a prompt', () => post('/api/aux/enqueue', {}));
  add('aux enqueue with no body at all', () => ({ method: 'POST', url: '/api/aux/enqueue', headers: L }));
  add('aux enqueue with a text body', () => post('/api/aux/enqueue', 'prompt=x', { ...L, 'Content-Type': 'text/plain' }));
  add('aux enqueue with a malformed body', () => post('/api/aux/enqueue', '{bad'));
  // The Aux queue resolves its HTTP target from this config: select a usable
  // provider before the first task runs.
  add('aux config selects a usable provider first', () => post('/api/aux/config', { protocol: 'anthropic', providerId: 'official' }));
  add('aux enqueue runs the model', () => post('/api/aux/enqueue', { id: 'task-a', type: 'manual', prompt: 'hello aux', meta: { from: 'diff' } }));
  add('aux enqueue trims a valid id', () => post('/api/aux/enqueue', { id: '  task-b  ', prompt: 'second' }));
  add('aux enqueue failure is sanitized', () => post('/api/aux/enqueue', { id: 'task-f', prompt: 'FAILPLEASE now' }));
  add('aux enqueue while shutting down', () => post('/api/aux/enqueue', { id: 'task-s', prompt: 'late' }), { control: { shuttingDown: true } });
  add('aux health after a failure', () => get('/api/aux/health'));
  add('aux history after tasks', () => get('/api/aux/history?limit=3'));
  add('aux history with a junk limit', () => get('/api/aux/history?limit=abc'));
  add('aux status after tasks', () => get('/api/aux/status'));
  add('aux cancel without an id', () => post('/api/aux/cancel', {}));
  add('aux cancel an unknown task', () => post('/api/aux/cancel', { id: 'nope' }));
  add('aux cancel with a numeric id', () => post('/api/aux/cancel', { id: 7 }));

  // ── aux config ──────────────────────────────────────────────────────────
  add('aux config catalog', () => get('/api/aux/config'));
  add('aux config catalog with the quota cache down', () => get('/api/aux/config'), { control: { limitCacheDown: true } });
  add('aux config catalog without CLI availability', () => get('/api/aux/config'), { control: { cliAvailabilityNull: true } });
  add('aux config rejects a missing protocol', () => post('/api/aux/config', { providerId: 'official' }));
  add('aux config rejects a bad protocol', () => post('/api/aux/config', { protocol: 'gemini', providerId: 'official' }));
  add('aux config rejects a missing provider', () => post('/api/aux/config', { protocol: 'anthropic' }));
  add('aux config rejects an unavailable provider', () => post('/api/aux/config', { protocol: 'anthropic', providerId: 'broken' }));
  add('aux config rejects a provider without a model', () => post('/api/aux/config', { protocol: 'anthropic', providerId: 'nomodel' }));
  add('aux config accepts an explicit model', () => post('/api/aux/config', { protocol: 'anthropic', providerId: 'nomodel', model: ' custom-1 ' }));
  add('aux config takes the provider default model', () => post('/api/aux/config', { protocol: 'Anthropic', providerId: 'official' }));
  add('aux config switches to the openai protocol', () => post('/api/aux/config', { protocol: 'openai', providerId: 'codex-official' }));
  add('aux config catalog after the changes', () => get('/api/aux/config'));
  add('aux config HEAD', () => head('/api/aux/config'));

  // ── goal settings and precheck ──────────────────────────────────────────
  add('goal settings', () => get('/api/settings/goal'));
  add('goal settings update', () => post('/api/settings/goal', { dimensions: { measurable: false }, minScore: 150 }));
  add('goal settings with an empty body', () => post('/api/settings/goal', {}));
  add('goal settings with a junk minScore', () => post('/api/settings/goal', { minScore: 'abc' }));
  add('goal settings after the updates', () => get('/api/settings/goal'));
  add('goal precheck without a task', () => post('/api/goal/precheck', { task: '   ' }));
  add('goal precheck passes', () => post('/api/goal/precheck', { task: '修好登录' }));
  add('goal precheck against a stricter threshold', () => post('/api/goal/precheck', { task: '修好登录', minScore: 95, dimensions: { measurable: true } }));
  add('goal precheck failure is sanitized', () => post('/api/goal/precheck', { task: 'FAILPLEASE' }));

  // ── aux run log ─────────────────────────────────────────────────────────
  add('aux runs list', () => get('/api/sessions/s1/aux-runs'));
  add('aux runs with a limit', () => get('/api/sessions/s1/aux-runs?limit=2'));
  add('aux runs by message', () => get('/api/sessions/s1/aux-runs?messageId=m2'));
  add('aux runs by task', () => get('/api/sessions/s1/aux-runs?taskId=t1'));
  add('aux runs message beats task', () => get('/api/sessions/s1/aux-runs?messageId=m1&taskId=t2'));
  add('aux runs junk limit', () => get('/api/sessions/s1/aux-runs?limit=abc'));
  add('aux runs huge limit', () => get('/api/sessions/s1/aux-runs?limit=999'));
  add('aux runs repeated limit', () => get('/api/sessions/s1/aux-runs?limit=1&limit=2'));
  add('aux runs array message id', () => get('/api/sessions/s1/aux-runs?messageId[]=m2'));
  add('aux runs object task id', () => get('/api/sessions/s1/aux-runs?taskId[k]=t1'));
  add('aux runs unknown session', () => get('/api/sessions/ghost/aux-runs'));
  add('aux runs internal slot', () => get('/api/sessions/internal1/aux-runs'));
  add('aux run by id', () => get('/api/sessions/s1/aux-runs/r2'));
  add('aux run unknown run', () => get('/api/sessions/s1/aux-runs/nope'));
  add('aux run unknown session', () => get('/api/sessions/ghost/aux-runs/r1'));
  add('aux run internal slot', () => get('/api/sessions/internal1/aux-runs/r1'));
  add('aux run with an encoded id', () => get('/api/sessions/s%31/aux-runs/r%31'));

  // ── unattended ──────────────────────────────────────────────────────────
  add('unattended read of a supervised session', () => get('/api/sessions/s1/unattended'));
  add('unattended read of an idle session', () => get('/api/sessions/s2/unattended'));
  add('unattended read of an unknown session', () => get('/api/sessions/ghost/unattended'));
  add('unattended read of an internal slot', () => get('/api/sessions/internal1/unattended'));
  add('unattended read without a supervisor', () => get('/api/sessions/s1/unattended'), { control: { unattendedDown: true } });
  add('unattended write without a supervisor', () => post('/api/sessions/s1/unattended', { action: 'stop' }), { control: { unattendedDown: true } });
  add('unattended start', () => post('/api/sessions/s2/unattended', { action: 'start', goal: '发版', maxDurationMinutes: 30 }));
  add('unattended start that the supervisor refuses', () => post('/api/sessions/s1/unattended', { action: 'start', goal: 'FAIL' }));
  add('unattended start refused without a code', () => post('/api/sessions/s1/unattended', { action: 'start', goal: 'NOCODE' }));
  add('unattended update', () => post('/api/sessions/s2/unattended', { action: 'update', maxDurationMinutes: 45 }));
  add('unattended update of an idle session', () => post('/api/sessions/worker1/unattended', { action: 'update' }));
  add('unattended stop', () => post('/api/sessions/s2/unattended', { action: 'stop' }));
  add('unattended stop of an idle session', () => post('/api/sessions/worker1/unattended', { action: 'stop' }));
  add('unattended resume', () => post('/api/sessions/s1/unattended', { action: 'resume', note: 'go on' }));
  add('unattended clear', () => post('/api/sessions/s2/unattended', { action: 'clear' }));
  add('unattended unknown action', () => post('/api/sessions/s1/unattended', { action: 'explode' }));
  add('unattended without a body', () => ({ method: 'POST', url: '/api/sessions/s1/unattended', headers: L }));
  add('unattended array body', () => post('/api/sessions/s1/unattended', []));
  add('unattended on an aux session', () => post('/api/sessions/aux1/unattended', { action: 'stop' }));
  add('unattended on a gateway session', () => post('/api/sessions/gw1/unattended', { action: 'stop' }));
  add('unattended write to an unknown session', () => post('/api/sessions/ghost/unattended', { action: 'stop' }));
  add('unattended write to an internal slot', () => post('/api/sessions/internal1/unattended', { action: 'stop' }));

  // ── scheduled messages ──────────────────────────────────────────────────
  add('scheduled message created', () => post('/api/sessions/s1/scheduled-messages', { message: '稍后提醒', delaySeconds: 30 }, idem('idem-sched-1')));
  add('scheduled message duplicate', () => post('/api/sessions/s1/scheduled-messages', { message: 'DUP' }));
  add('scheduled message text alias', () => post('/api/sessions/s1/scheduled-messages', { text: 'via text', delaySec: 5 }));
  add('scheduled message client id', () => post('/api/sessions/s1/scheduled-messages', { message: 'with cid', clientScheduleId: 'cid-9' }));
  add('scheduled message without text', () => post('/api/sessions/s1/scheduled-messages', {}));
  add('scheduled message runtime error with status', () => post('/api/sessions/s1/scheduled-messages', { message: 'BOOM' }));
  add('scheduled message plain runtime error', () => post('/api/sessions/s1/scheduled-messages', { message: 'RAW' }));
  add('scheduled message for an unknown session', () => post('/api/sessions/ghost/scheduled-messages', { message: 'x' }));
  add('scheduled message for an internal slot', () => post('/api/sessions/internal1/scheduled-messages', { message: 'x' }));
  add('scheduled messages list', () => get('/api/sessions/s1/scheduled-messages'));
  add('scheduled messages list failure', () => get('/api/sessions/s2/scheduled-messages'));
  add('scheduled messages list of an unknown session', () => get('/api/sessions/ghost/scheduled-messages'));
  add('scheduled messages list of an internal slot', () => get('/api/sessions/internal1/scheduled-messages'));
  add('scheduled message cancel', () => del('/api/sessions/s1/scheduled-messages/sm-0'));
  add('scheduled message cancel already delivered', () => del('/api/sessions/s1/scheduled-messages/sm-done'));
  add('scheduled message cancel unknown', () => del('/api/sessions/s1/scheduled-messages/sm-zzz'));
  add('scheduled message cancel without a code', () => del('/api/sessions/s1/scheduled-messages/sm-nocode'));
  add('scheduled message cancel throws', () => del('/api/sessions/s1/scheduled-messages/explode'));
  add('scheduled message cancel with an encoded id', () => del('/api/sessions/s1/scheduled-messages/m%2Fx'));
  add('scheduled message cancel unknown session', () => del('/api/sessions/ghost/scheduled-messages/sm-0'));
  add('scheduled message cancel internal slot', () => del('/api/sessions/internal1/scheduled-messages/sm-0'));

  // ── observed tasks ──────────────────────────────────────────────────────
  add('tasks list', () => get('/api/sessions/s1/tasks'));
  add('tasks with a comma list', () => get('/api/sessions/s1/tasks?taskIds=a,b'));
  add('tasks with repeated ids', () => get('/api/sessions/s1/tasks?taskIds=a&taskIds=b'));
  add('tasks with bracket ids', () => get('/api/sessions/s1/tasks?taskIds[]=a&taskIds[]=b'));
  add('tasks with an object', () => get('/api/sessions/s1/tasks?taskIds[k]=v'));
  add('tasks with an empty list', () => get('/api/sessions/s1/tasks?taskIds='));
  add('tasks activity failure', () => get('/api/sessions/s1/tasks?taskIds=explode'));
  add('tasks failure with a status', () => get('/api/sessions/s2/tasks'));
  add('tasks plain failure', () => get('/api/sessions/worker1/tasks'));
  add('tasks of an unknown session', () => get('/api/sessions/ghost/tasks'));
  add('tasks of an internal slot', () => get('/api/sessions/internal1/tasks'));

  // ── dispatches ──────────────────────────────────────────────────────────
  add('dispatches default', () => get('/api/sessions/s1/dispatches'));
  add('dispatches HEAD', () => head('/api/sessions/s1/dispatches'));
  add('dispatches as owner', () => get('/api/sessions/s1/dispatches?relation=owner'));
  add('dispatches as target', () => get('/api/sessions/worker1/dispatches?relation=target'));
  add('dispatches with a bad relation', () => get('/api/sessions/s1/dispatches?relation=bogus'));
  add('dispatches with an array relation', () => get('/api/sessions/s1/dispatches?relation=owner&relation=target'));
  add('dispatches including terminal rows', () => get('/api/sessions/s1/dispatches?activeOnly=false'));
  add('dispatches activeOnly as an array', () => get('/api/sessions/s1/dispatches?activeOnly[]=false'));
  add('dispatches with a recent terminal tail', () => get('/api/sessions/s1/dispatches?activeOnly=false&recentTerminalLimit=2'));
  add('dispatches with a zero terminal tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit=0'));
  add('dispatches terminal tail with active only', () => get('/api/sessions/s1/dispatches?recentTerminalLimit=1'));
  add('dispatches with a too large tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit=21'));
  add('dispatches with a non numeric tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit=abc'));
  add('dispatches with a negative tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit=-1'));
  add('dispatches with an empty tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit='));
  add('dispatches with an array tail', () => get('/api/sessions/s1/dispatches?recentTerminalLimit[]=3'));
  add('dispatches whose scheduler is down', () => get('/api/sessions/s2/dispatches?activeOnly=false'));
  add('dispatches of an unknown session', () => get('/api/sessions/ghost/dispatches'));
  add('dispatches of an internal slot', () => get('/api/sessions/internal1/dispatches'));

  // ── user input dismiss ──────────────────────────────────────────────────
  add('user input dismissed', () => post('/api/sessions/s1/user-input/dismiss', { requestId: '  req-1  ' }));
  add('user input dismiss without an id', () => post('/api/sessions/s1/user-input/dismiss', {}));
  add('user input dismiss with a blank id', () => post('/api/sessions/s1/user-input/dismiss', { requestId: '   ' }));
  add('user input dismiss with a numeric id', () => post('/api/sessions/s1/user-input/dismiss', { requestId: 5 }));
  add('user input dismiss with a long id', () => post('/api/sessions/s1/user-input/dismiss', { requestId: 'x'.repeat(161) }));
  add('user input dismiss at the length limit', () => post('/api/sessions/s1/user-input/dismiss', { requestId: 'y'.repeat(160) }));
  add('user input dismiss that is no longer pending', () => post('/api/sessions/s1/user-input/dismiss', { requestId: 'gone' }));
  add('user input dismiss that throws', () => post('/api/sessions/s1/user-input/dismiss', { requestId: 'boom' }));
  add('user input dismiss for an unknown session', () => post('/api/sessions/ghost/user-input/dismiss', { requestId: 'r' }));
  add('user input dismiss for an internal slot', () => post('/api/sessions/internal1/user-input/dismiss', { requestId: 'r' }));

  // ── queue ───────────────────────────────────────────────────────────────
  add('queue of a busy target', () => get('/api/sessions/worker1/queue'));
  add('queue with queued rows', () => get('/api/sessions/s1/queue'));
  add('queue HEAD', () => head('/api/sessions/s1/queue'));
  add('queue failure', () => get('/api/sessions/s2/queue'));
  add('queue of an unknown session', () => get('/api/sessions/ghost/queue'));
  add('queue of an internal slot', () => get('/api/sessions/internal1/queue'));
  add('queue with a trailing slash', () => get('/api/sessions/s1/queue/'));
  add('queue action with an invalid action', () => post('/api/sessions/s1/queue/action', { action: 'explode', confirm: true }));
  add('queue action without an action', () => post('/api/sessions/s1/queue/action', { confirm: true }));
  add('queue action without confirmation', () => post('/api/sessions/s1/queue/action', { action: 'retry' }));
  add('queue action with a string confirmation', () => post('/api/sessions/s1/queue/action', { action: 'retry', confirm: 'true' }));
  add('queue action retry', () => post('/api/sessions/s1/queue/action', { action: 'retry', confirm: true, reason: 'again', text: 'T' }, idem('idem-retry')));
  add('queue action resume with a body key', () => post('/api/sessions/s1/queue/action', { action: 'resume', confirm: true, idempotencyKey: 'body-key' }));
  add('queue action skip', () => post('/api/sessions/s1/queue/action', { action: ' skip ', confirm: true }));
  add('queue action resolve without an active task', () => post('/api/sessions/s1/queue/action', { action: 'resolve', confirm: true, reason: 'none' }));
  add('queue action resolve that is refused', () => post('/api/sessions/s1/queue/action', { action: 'resolve', confirm: true, reason: 'blocked' }));
  add('queue action cancel', () => post('/api/sessions/s1/queue/action', { action: 'cancel', confirm: true, reason: '用户点了取消' }, idem('idem-cancel')));
  add('queue action cancel with defaults', () => post('/api/sessions/s1/queue/action', { action: 'cancel', confirm: true, operationId: 'op-body' }));
  add('queue action cancel of a missing session turn', () => post('/api/sessions/s1/queue/action', { action: 'cancel', confirm: true, reason: 'nosession' }));
  add('queue action cancel that did not take', () => post('/api/sessions/s1/queue/action', { action: 'cancel', confirm: true, reason: 'stuck' }));
  add('queue action cancel that throws', () => post('/api/sessions/s1/queue/action', { action: 'cancel', confirm: true, reason: 'throw' }));
  add('queue action cancel_queued', () => post('/api/sessions/s1/queue/action', { action: 'cancel_queued', confirm: true, entryId: 'e-q1', reason: 'no longer needed' }));
  add('queue action cancel_queued of a missing entry', () => post('/api/sessions/s1/queue/action', { action: 'cancel_queued', confirm: true, entryId: 'missing' }));
  add('queue action cancel_queued of a locked entry', () => post('/api/sessions/s1/queue/action', { action: 'cancel_queued', confirm: true, entryId: 'locked' }));
  add('queue action reorder_queued', () => post('/api/sessions/s1/queue/action', { action: 'reorder_queued', confirm: true, entryId: 'e-q2', toIndex: 0 }));
  add('queue action reorder_queued by direction', () => post('/api/sessions/s1/queue/action', { action: 'reorder_queued', confirm: true, entryId: 'e-q2', direction: 'up' }));
  add('queue action reorder_queued of a missing entry', () => post('/api/sessions/s1/queue/action', { action: 'reorder_queued', confirm: true, entryId: 'missing' }));
  add('queue action reorder_queued of a locked entry', () => post('/api/sessions/s1/queue/action', { action: 'reorder_queued', confirm: true, entryId: 'locked' }));
  add('queue action edit_queued', () => post('/api/sessions/s1/queue/action', { action: 'edit_queued', confirm: true, entryId: 'e-q1', text: '改后的正文' }));
  add('queue action edit_queued without text', () => post('/api/sessions/s1/queue/action', { action: 'edit_queued', confirm: true, entryId: 'e-q1', text: '' }));
  add('queue action edit_queued of a missing entry', () => post('/api/sessions/s1/queue/action', { action: 'edit_queued', confirm: true, entryId: 'missing', text: 'x' }));
  add('queue action edit_queued of a locked entry', () => post('/api/sessions/s1/queue/action', { action: 'edit_queued', confirm: true, entryId: 'locked', text: 'x' }));
  // The slot never frees: every tick and re-read keeps the entry queued, so the
  // route retries, escalates to unstick and reports the hold.
  add('queue action insert_queued that stays held', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'e-held' }), { control: { queueHeld: true } });
  add('queue action insert_queued', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'e-held' }));
  add('queue action insert_queued already delivered', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'e-delivered' }));
  add('queue action insert_queued dead-lettered', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'e-dead' }));
  add('queue action insert_queued cancelled', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'e-cancelled' }));
  add('queue action insert_queued of a missing entry', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'missing' }));
  add('queue action insert_queued of a locked entry', () => post('/api/sessions/s1/queue/action', { action: 'insert_queued', confirm: true, entryId: 'locked' }));
  add('queue action for an unknown session', () => post('/api/sessions/ghost/queue/action', { action: 'retry', confirm: true }));
  add('queue action for an internal slot', () => post('/api/sessions/internal1/queue/action', { action: 'cancel', confirm: true }));
  add('queue action with a malformed body', () => post('/api/sessions/s1/queue/action', '{bad'));

  // ── v1 waits against the distinct unprefixed listing ───────────────────
  add('v1 waits of a session', () => get('/api/v1/sessions/s1/waits'));
  add('v1 waits HEAD', () => head('/api/v1/sessions/s1/waits'));
  add('v1 waits with an unrenderable wait', () => get('/api/v1/sessions/worker1/waits'));
  add('v1 waits runtime failure', () => get('/api/v1/sessions/s2/waits'));
  add('v1 waits of an unknown session', () => get('/api/v1/sessions/ghost/waits'));
  add('v1 waits of an internal slot', () => get('/api/v1/sessions/internal1/waits'));
  add('v1 waits with an encoded id', () => get('/api/v1/sessions/s%31/waits'));
  add('v1 waits with mixed case', () => get('/api/V1/Sessions/s1/Waits'));
  add('legacy waits of a session via front door', () => get('/api/sessions/s1/waits'));
  add('legacy waits HEAD via front door', () => head('/api/sessions/s1/waits'));
  add('legacy waits of an unknown session via front door', () => get('/api/sessions/ghost/waits'));
  add('legacy waits runtime failure via front door', () => get('/api/sessions/s2/waits'));
  add('legacy waits of an internal slot is still guarded', () => get('/api/sessions/internal1/waits'));

  // ── wait registration, resolution, cancellation and detached tasks ─────
  add('wait registration via front door', () => post('/api/sessions/s1/wait', { mode: 'delay', delaySec: 1 }));
  add('wait resolve with a bad token via front door', () => post('/api/wait/w-new/resolve?token=wrong', { data: 1 }));
  add('wait resolve with a good token via front door', () => post('/api/wait/w-new/resolve?token=tok-wait', { data: 1 }));
  add('wait resolve token header', () => post('/api/wait/w-new/resolve', { data: { value: 2 } }, { ...J, 'X-Wait-Token': 'tok-wait' }));
  add('wait resolve token body', () => post('/api/wait/w-new/resolve', { token: 'tok-wait', value: 3 }));
  add('wait resolve query precedes header and body', () => post('/api/wait/w-new/resolve?token=wrong', { token: 'tok-wait', data: null }, { ...J, 'X-Wait-Token': 'tok-wait' }));
  add('wait resolve of an unknown wait via front door', () => post('/api/wait/w-missing/resolve?token=x', {}));
  add('wait cancel via front door', () => del('/api/wait/w1'));
  add('wait cancel falls back to legacy injector', () => del('/api/wait/lw1'));
  add('wait cancel of an unknown wait via front door', () => del('/api/wait/nope'));
  add('run detached via front door', () => post('/api/sessions/s1/run-detached', { command: 'echo hi' }));
  add('run detached without a command via front door', () => post('/api/sessions/s1/run-detached', {}));
  add('detached list via front door', () => get('/api/sessions/s1/detached'));
  add('detached task via front door', () => get('/api/detached/job-1'));
  add('detached unknown task via front door', () => get('/api/detached/nope'));
  add('wait registration unknown session', () => post('/api/sessions/ghost/wait', {}));
  add('wait registration internal slot', () => post('/api/sessions/internal1/wait', {}));
  add('detached start internal slot', () => post('/api/sessions/internal1/run-detached', { command: 'echo hi' }));
  add('detached list internal slot', () => get('/api/sessions/internal1/detached'));
  add('wait resolve malformed id', () => post('/api/wait/%zz/resolve', {}));

  // ── decoding ────────────────────────────────────────────────────────────
  add('queue with a bad escape in the id', () => get('/api/sessions/%zz/queue'));
  add('queue action with a bad escape in the id', () => post('/api/sessions/%zz/queue/action', { action: 'retry', confirm: true }));
  add('v1 waits with a bad escape in the id', () => get('/api/v1/sessions/%E0%A4%A/waits'));
  add('scheduled message cancel with a bad escape', () => del('/api/sessions/s1/scheduled-messages/%zz'));
  add('aux run with a bad escape in the run id', () => get('/api/sessions/s1/aux-runs/%zz'));
  add('queue OPTIONS with a bad escape in the id', () => options('/api/sessions/%zz/queue'));

  // ── automatic OPTIONS, measured against the retired Express stack ───────
  for (const [name, url] of [
    ['aux status', '/api/aux/status'], ['aux health', '/api/aux/health'], ['aux history', '/api/aux/history'],
    ['aux enqueue', '/api/aux/enqueue'], ['aux cancel', '/api/aux/cancel'], ['aux config', '/api/aux/config'],
    ['goal settings', '/api/settings/goal'], ['goal precheck', '/api/goal/precheck'],
    ['aux runs', '/api/sessions/s1/aux-runs'], ['aux run', '/api/sessions/s1/aux-runs/r1'],
    ['unattended', '/api/sessions/s1/unattended'], ['scheduled messages', '/api/sessions/s1/scheduled-messages'],
    ['scheduled message', '/api/sessions/s1/scheduled-messages/m1'], ['tasks', '/api/sessions/s1/tasks'],
    ['dispatches', '/api/sessions/s1/dispatches'], ['user input dismiss', '/api/sessions/s1/user-input/dismiss'],
    ['queue', '/api/sessions/s1/queue'], ['queue action', '/api/sessions/s1/queue/action'],
    ['v1 waits', '/api/v1/sessions/s1/waits'], ['legacy waits', '/api/sessions/s1/waits'],
    ['legacy wait', '/api/sessions/s1/wait'], ['legacy detached', '/api/sessions/s1/detached'],
    ['legacy run detached', '/api/sessions/s1/run-detached'],
    ['wait resolve', '/api/wait/w1/resolve'], ['wait cancel', '/api/wait/w1'],
    ['detached task', '/api/detached/job-1'],
  ]) add(`OPTIONS ${name}`, () => options(url));
  add('OPTIONS queue for an internal slot', () => options('/api/sessions/internal1/queue'));
  add('OPTIONS v1 waits for an internal slot', () => options('/api/v1/sessions/internal1/waits'));
  add('OPTIONS scheduled messages for an unknown session', () => options('/api/sessions/ghost/scheduled-messages'));

  // ── the one documented difference ───────────────────────────────────────
  // The front door cannot reach its host: Rust answers 503, Express has no
  // equivalent and answers the ordinary 200.
  add('aux status with the host unreachable', () => get('/api/aux/status?down=1'), {
    control: { suppressCalls: true },
    expectedDifference: {
      node: view => view.status === 200,
      rust: view => view.status === 503 && view.body.includes('rust_backend_unavailable'),
    },
  });
  add('queue with the host unreachable', () => get('/api/sessions/s1/queue?down=1'), {
    control: { suppressCalls: true },
    expectedDifference: {
      node: view => view.status === 200,
      rust: view => view.status === 503 && view.body.includes('rust_backend_unavailable'),
    },
  });

  // ── last: a precheck the model never answers (holds an Aux slot forever) ─
  add('goal precheck that times out', () => post('/api/goal/precheck', { task: 'HANGFOREVER' }));
  // The stuck precheck got a random task id on each side.
  add('aux status with a stuck slot', () => get('/api/aux/status'), {
    normalize: view => ({
      ...view,
      headers: { ...view.headers, etag: undefined },
      body: view.body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
    }),
  });
  return pending;
}

// ── the oracle ──────────────────────────────────────────────────────────────

function mountOracle(app, { repo, work }) {
  workPath = work;
  writeControl({});
  const { createWorld, mountFrozen, FROZEN_NOW } = require(path.join(repo, 'tests/helpers/legacy-orchestration-routes/world'));
  const frozen = require(path.join(repo, 'tests/helpers/legacy-orchestration-routes'));
  Date.now = () => FROZEN_NOW;
  oracleWorld = createWorld({
    dir: path.join(work, 'oracle-state'),
    controlFile: path.join(work, 'control.json'),
  });
  mountFrozen(app, frozen, oracleWorld);
  upstreamText = upstreamSource(repo);
}

// ── the gateway's stub child ────────────────────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const { createWorld, FROZEN_NOW } = require(path.join(REPO, 'tests/helpers/legacy-orchestration-routes/world'));
Date.now = () => FROZEN_NOW;

const work = process.env.ORCH_ROOT;
const express = require(require.resolve('express', { paths: [REPO] }));
const { requestIdMiddleware, safeErrorHandler } = require(path.join(REPO, 'src/http-errors'));
const { jsonCompression } = require(path.join(REPO, 'src/http/json-compression'));
const { createPublicSessionAccessGuard } = require(path.join(REPO, 'src/native/runtime')).getNative().sessionPublicAccessApi();
const { createAuxRunRoutes, createOrchestrationHost } = require(path.join(REPO, 'src/routes/orchestration-host'));
const { mountUnattendedRoutes } = require(path.join(REPO, 'src/unattended/routes'));
const { mountAuxGoalRoutes } = require(path.join(REPO, 'src/routes/aux-goal'));
const { createOrchestrationRoutes } = require(path.join(REPO, 'src/routes/orchestration'));

const world = createWorld({
  dir: path.join(work, 'rust-state'),
  controlFile: path.join(work, 'control.json'),
  callsFile: path.join(work, 'rust-calls.jsonl'),
});

const quiet = { warn() {}, info() {}, error() {} };
const app = express();
app.use(requestIdMiddleware, jsonCompression);
// server.js mounts the public-session guard long before express.json.
const guard = createPublicSessionAccessGuard({
  records: world.records,
  v1NotFound: (req, res) => world.orchestrationDeps.v1Error(req, res, 404, 'session not found', 'session_not_found'),
});
app.use('/api/sessions/:id', guard);
app.use('/api/v1/sessions/:id', guard);
app.use(express.json({ limit: '50mb' }));
app.post('/api/__host/session-admin', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const record = world.records.get(id) || null;
  const text = JSON.stringify({
    record: record ? { id } : null,
    internal: !!(record && record.taskExecutionSlot === true),
    taskStateWritable: true,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
});

// The four retired modules mount only on the host port's capture app.
const host = createOrchestrationHost({ express });
mountUnattendedRoutes(host.app, world.unattendedDeps);
mountAuxGoalRoutes(host.app, world.auxDeps);
createAuxRunRoutes({ records: world.records, getLog: () => world.auxRunLog }).mountRoutes(host.app);
const orchestration = createOrchestrationRoutes(world.orchestrationDeps);
orchestration.mountHostRoutes(host.app);
host.mountRoute(app);
app.get('/__health', (_req, res) => res.type('text/plain').send('ok'));
// Express answers OPTIONS itself once nothing else did: let it through.
app.use((req, res, next) => (req.method === 'OPTIONS' ? next() : res.status(404).end('forwarded')));
app.use(safeErrorHandler(quiet));

// The host-port POST is answered by a real Express request, so body-parser reads
// a real stream. One request (?down=1) is dropped before it is answered.
const inner = http.createServer(app);
inner.listen(0, '127.0.0.1', () => {
  const innerPort = inner.address().port;
  const forward = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/api/__host/orchestration' && req.method === 'POST') {
        let input = {};
        try { input = JSON.parse(body.toString('utf8') || '{}'); } catch (_) {}
        if (String(input.originalUrl || '').includes('down=1')) { req.socket.destroy(); return; }
      }
      const upstream = http.request({
        host: '127.0.0.1', port: innerPort, method: req.method, path: req.url,
        headers: { ...req.headers, 'content-length': String(body.length) },
      }, reply => {
        res.writeHead(reply.statusCode || 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { try { res.destroy(); } catch (_) {} });
      upstream.end(body);
    });
  };
  const server = http.createServer(forward);
  const listener = net.createServer({ pauseOnConnect: true }, socket => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      const marker = buffered.indexOf('\\r\\n');
      if (marker < 0) return;
      socket.removeListener('data', onData);
      socket.pause();
      const rest = buffered.subarray(marker + 2);
      if (rest.length) socket.unshift(rest);
      server.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
    socket.resume();
  });
  listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
});
`;
}

// ── verdict ─────────────────────────────────────────────────────────────────

function finalize(views) {
  const byName = new Map(views.map(view => [view.name, view]));
  fs.writeFileSync(path.join(workPath, 'views.json'), JSON.stringify(views, null, 2));
  const both = (name, fn) => {
    const view = byName.get(name);
    if (!view) { problems.push(`${name}: missing from the corpus`); return; }
    for (const side of ['node', 'rust']) fn(view[side], side, name);
  };
  const expect = (name, status, needle) => both(name, (answer, side) => {
    if (answer.status !== status) problems.push(`${name}: ${side} answered ${answer.status}, expected ${status} (${answer.body.slice(0, 160)})`);
    if (needle && !answer.body.includes(needle)) problems.push(`${name}: ${side} body lacks ${needle} (${answer.body.slice(0, 160)})`);
  });
  const expectAllow = (name, allow) => both(name, (answer, side) => {
    if (answer.status !== 200) problems.push(`${name}: ${side} answered ${answer.status}`);
    if (answer.headers.allow !== allow) problems.push(`${name}: ${side} Allow ${answer.headers.allow}, expected ${allow}`);
  });

  // A silently failing world would let both sides fail identically.
  for (const view of views) {
    for (const side of ['node', 'rust']) {
      if (/unexpected |is not a function|Cannot read|TypeError|ReferenceError/.test(view[side].body)) {
        problems.push(`${view.name}: ${side} hit a harness error (${view[side].body.slice(0, 200)})`);
      }
    }
  }

  // The facts every branch hangs on. A world that failed silently would let both
  // sides answer the same wrong thing, so the load-bearing answers are pinned.
  expect('aux status idle', 200, '"processing":false');
  expect('aux enqueue without a prompt', 400, 'prompt required');
  expect('aux enqueue with a malformed body', 400, '"code":"request_error"');
  expect('aux enqueue runs the model', 200, '"result":"echo:hello aux","taskId":"task-a"');
  expect('aux enqueue trims a valid id', 200, '"taskId":"task-b"');
  expect('aux enqueue failure is sanitized', 200, '"error":"aux failed","taskId":"task-f"');
  expect('aux enqueue while shutting down', 200, 'server is shutting down');
  expect('aux health after a failure', 200, '"unhealthy":true');
  expect('aux cancel without an id', 400, 'id required');
  expect('aux config rejects a bad protocol', 400, 'protocol 必须是 anthropic 或 openai');
  expect('aux config rejects an unavailable provider', 400, 'Provider 不支持 anthropic HTTP 调用');
  expect('aux config rejects a provider without a model', 400, '请选择模型');
  expect('aux config accepts an explicit model', 200, '"model":"custom-1"');
  expect('aux config switches to the openai protocol', 200, '"wireApi":"responses"');
  expect('aux config catalog after the changes', 200, '"providerId":"codex-official"');
  expect('goal settings update', 200, '"minScore":100');
  expect('goal precheck without a task', 400, 'task required');
  expect('goal precheck passes', 200, '"verdict":"ok","score":90');
  expect('goal precheck against a stricter threshold', 200, '符合度 90 低于设定阈值 95');
  expect('goal precheck failure is sanitized', 200, '"error":"aux failed"');
  expect('goal precheck that times out', 200, 'AUX_TIMEOUT');
  expect('aux status with a stuck slot', 200, '"processing":true');
  expect('aux runs by message', 200, '"runId":"r2"');
  expect('aux runs message beats task', 200, '"runId":"r1"');
  expect('aux run unknown run', 404, 'aux run not found');
  expect('aux run internal slot', 404, '"error":"session not found"');
  expect('unattended read without a supervisor', 501, 'unattended_unavailable');
  expect('unattended read of an unknown session', 404, 'session_not_found');
  expect('unattended start', 200, '"maxDurationMinutes":30');
  expect('unattended start that the supervisor refuses', 409, '"error":"already_running"');
  expect('unattended start refused without a code', 409, 'unattended_failed');
  expect('unattended unknown action', 400, 'bad_action');
  expect('unattended on an aux session', 400, 'not_a_chat_session');
  expect('unattended write to an internal slot', 404, '"error":"session not found"');
  expect('scheduled message created', 201, '"duplicate":false');
  expect('scheduled message duplicate', 200, '"duplicate":true');
  expect('scheduled message without text', 400, 'invalid_scheduled_message');
  expect('scheduled message runtime error with status', 429, 'scheduler_busy');
  expect('scheduled message for an unknown session', 404, '"code":"session_not_found"');
  expect('scheduled messages list failure', 500, 'scheduled_message_list_failed');
  expect('scheduled message cancel already delivered', 409, 'already_delivered');
  expect('scheduled message cancel unknown', 404, 'not_found');
  expect('scheduled message cancel without a code', 409, 'scheduled message cannot be cancelled');
  expect('scheduled message cancel throws', 400, 'scheduled_message_cancel_failed');
  expect('tasks with repeated ids', 200, '"received":["a","b"]');
  expect('tasks with a comma list', 200, '"received":"a,b"');
  expect('tasks failure with a status', 503, 'task index offline');
  expect('dispatches default', 200, '"authoritative":"durable_operation_plus_target_fifo"');
  expect('dispatches with a bad relation', 400, 'invalid relation');
  expect('dispatches with a recent terminal tail', 200, '"recentTerminalLimit":2');
  expect('dispatches with a too large tail', 400, 'recentTerminalLimit must be an integer between 0 and 20');
  expect('dispatches with an empty tail', 400, 'recentTerminalLimit must be an integer');
  expect('user input dismissed', 200, '"requestId":"req-1"');
  expect('user input dismiss with a long id', 400, 'request_id_required');
  expect('user input dismiss that is no longer pending', 409, 'not_pending');
  expect('user input dismiss that throws', 500, 'dismiss exploded');
  expect('user input dismiss for an unknown session', 404, '"error":"session_not_found"');
  expect('queue failure', 500, 'scheduler offline');
  expect('queue action with an invalid action', 400, 'invalid_action');
  expect('queue action without confirmation', 409, 'confirmation_required');
  expect('queue action retry', 200, '"idempotencyKey":"idem-retry"');
  expect('queue action resume with a body key', 200, '"idempotencyKey":"body-key"');
  expect('queue action resolve without an active task', 404, 'no_active_task');
  expect('queue action cancel', 200, '"operationId":"idem-cancel"');
  expect('queue action cancel of a missing session turn', 404, 'session_not_found');
  expect('queue action cancel that did not take', 409, 'cancel_failed');
  expect('queue action cancel that throws', 400, 'cancel exploded');
  expect('queue action cancel_queued of a missing entry', 404, 'queued_entry_not_found');
  expect('queue action reorder_queued by direction', 200, '"direction":"up"');
  expect('queue action edit_queued without text', 400, 'queued_entry_text_required');
  expect('queue action insert_queued that stays held', 200, '"unstick"');
  expect('queue action insert_queued dead-lettered', 409, 'queue_delivery_failed');
  expect('v1 waits of a session', 200, '"apiVersion":"v1"');
  expect('v1 waits with an unrenderable wait', 500, 'wait_list_failed');
  expect('v1 waits runtime failure', 500, 'wait_list_failed');
  expect('v1 waits of an unknown session', 404, '"code":"session_not_found","apiVersion":"v1"');
  expect('v1 waits of an internal slot', 404, '"code":"session_not_found","apiVersion":"v1"');
  expect('legacy waits of a session via front door', 200, '"legacyWaits"');
  expect('legacy waits runtime failure via front door', 500, 'wait store offline');
  expect('wait registration via front door', 200, '"callbackUrl":"http://localhost/api/wait/w-new/resolve?token=tok-wait"');
  expect('wait resolve with a bad token via front door', 403, 'bad token');
  expect('run detached via front door', 200, '"executionKind":"detached_process"');
  expect('detached task via front door', 200, '"operationId":"op-d1"');
  expect('queue OPTIONS with a bad escape in the id', 400, '"code":"request_error"');

  // The automatic OPTIONS union, measured against the retired Express stack.
  const allows = {
    'OPTIONS aux status': 'GET,HEAD', 'OPTIONS aux health': 'GET,HEAD', 'OPTIONS aux history': 'GET,HEAD',
    'OPTIONS aux enqueue': 'POST', 'OPTIONS aux cancel': 'POST', 'OPTIONS aux config': 'GET,HEAD,POST',
    'OPTIONS goal settings': 'GET,HEAD,POST', 'OPTIONS goal precheck': 'POST',
    'OPTIONS aux runs': 'GET,HEAD', 'OPTIONS aux run': 'GET,HEAD', 'OPTIONS unattended': 'GET,HEAD,POST',
    'OPTIONS scheduled messages': 'POST,GET,HEAD', 'OPTIONS scheduled message': 'DELETE',
    'OPTIONS tasks': 'GET,HEAD', 'OPTIONS dispatches': 'GET,HEAD', 'OPTIONS user input dismiss': 'POST',
    'OPTIONS queue': 'GET,HEAD', 'OPTIONS queue action': 'POST', 'OPTIONS v1 waits': 'GET,HEAD',
    // The formerly excluded paths are also claimed by the front door.
    'OPTIONS legacy waits': 'GET,HEAD', 'OPTIONS legacy wait': 'POST',
    'OPTIONS legacy detached': 'GET,HEAD', 'OPTIONS legacy run detached': 'POST',
    'OPTIONS wait resolve': 'POST', 'OPTIONS wait cancel': 'DELETE', 'OPTIONS detached task': 'GET,HEAD',
    'OPTIONS scheduled messages for an unknown session': 'POST,GET,HEAD',
  };
  for (const [name, allow] of Object.entries(allows)) expectAllow(name, allow);
  expect('OPTIONS queue for an internal slot', 404, '"error":"session not found"');
  expect('OPTIONS v1 waits for an internal slot', 404, '"code":"session_not_found","apiVersion":"v1"');

  // Desensitization canaries: planted secrets must never reach a response.
  const { CANARIES } = require(path.join(path.dirname(path.dirname(path.dirname(__dirname))), 'tests/helpers/legacy-orchestration-routes/world'));
  for (const view of views) {
    for (const side of ['node', 'rust']) {
      for (const canary of CANARIES) {
        if (view[side].body.includes(canary)) problems.push(`${view.name}: ${side} leaked the canary ${canary}`);
      }
    }
  }

  // Side effects: the ordered calls each world received.
  const childFile = path.join(workPath, 'rust-calls.jsonl');
  let childCalls = [];
  try {
    childCalls = fs.readFileSync(childFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (_) { /* nothing recorded */ }
  const oracleCalls = oracleWorld.calls;
  fs.writeFileSync(path.join(workPath, 'oracle-calls.jsonl'), oracleCalls.map(call => JSON.stringify(call)).join('\n') + '\n');
  const sameCalls = JSON.stringify(oracleCalls) === JSON.stringify(childCalls);
  if (!sameCalls) {
    const limit = Math.max(oracleCalls.length, childCalls.length);
    for (let index = 0; index < limit; index += 1) {
      if (JSON.stringify(oracleCalls[index]) !== JSON.stringify(childCalls[index])) {
        problems.push(`side-effect call #${index} differs: oracle ${JSON.stringify(oracleCalls[index])} vs child ${JSON.stringify(childCalls[index])}`);
        break;
      }
    }
  }
  const names = new Set(oracleCalls.map(call => call.name));
  for (const wanted of [
    'scheduleMessage', 'cancelScheduledMessage', 'listScheduledMessages', 'operations.listReferences',
    'operations.listTasks', 'operations.taskActivity', 'sessionScheduler.status', 'sessionScheduler.resolve',
    'sessionScheduler.cancelQueued', 'sessionScheduler.reorderQueued', 'sessionScheduler.editQueued',
    'sessionScheduler.insertQueued', 'tick', 'cancelActiveTurn', 'unstickBlocked', 'dismissUserInput',
    'unattended.start', 'unattended.update', 'unattended.stop', 'unattended.resume', 'unattended.clear',
    'executeAuxHttp', 'auxRunLog.byAnchor', 'auxRunLog.byTask', 'outbox.get',
  ]) {
    if (!names.has(wanted)) problems.push(`coverage: the world never saw ${wanted}`);
  }

  // The two config files the Aux and goal routes write.
  for (const file of ['aux-config.json', 'goal-config.json']) {
    const read = dir => {
      try { return fs.readFileSync(path.join(workPath, dir, file), 'utf8'); } catch (_) { return null; }
    };
    const oracleText = read('oracle-state');
    const childText = read('rust-state');
    if (oracleText === null) problems.push(`coverage: the oracle never wrote ${file}`);
    if (oracleText !== childText) problems.push(`${file} differs: oracle ${oracleText} vs child ${childText}`);
  }

  // Coverage guard: every route, both guard envelopes, the v1/legacy split and
  // the 503 branch must have been exercised with the status that proves it.
  const status = (name, side = 'node') => (byName.get(name) ? byName.get(name)[side].status : null);
  const exercised = {
    'aux status idle': 200, 'aux health': 200, 'aux history after tasks': 200, 'aux enqueue runs the model': 200,
    'aux cancel an unknown task': 200, 'aux config catalog': 200, 'aux config takes the provider default model': 200,
    'goal settings': 200, 'goal settings update': 200, 'goal precheck passes': 200,
    'aux runs list': 200, 'aux run by id': 200, 'unattended read of a supervised session': 200,
    'unattended start': 200, 'scheduled message created': 201, 'scheduled messages list': 200,
    'scheduled message cancel': 200, 'tasks list': 200, 'dispatches default': 200,
    'user input dismissed': 200, 'queue with queued rows': 200, 'queue action retry': 200,
    'v1 waits of a session': 200,
    // Branches the migration depends on.
    'v1 waits of an internal slot': 404, 'legacy waits of an internal slot is still guarded': 404,
    'queue of an internal slot': 404, 'queue action for an internal slot': 404,
    'aux runs internal slot': 404, 'aux run internal slot': 404, 'unattended read of an internal slot': 404,
    'unattended write to an internal slot': 404, 'scheduled message for an internal slot': 404,
    'scheduled messages list of an internal slot': 404, 'scheduled message cancel internal slot': 404,
    'tasks of an internal slot': 404, 'dispatches of an internal slot': 404,
    'user input dismiss for an internal slot': 404, 'v1 waits of an unknown session': 404,
    'queue with a bad escape in the id': 400, 'goal precheck that times out': 200,
  };
  for (const [name, want] of Object.entries(exercised)) {
    if (status(name) !== want) problems.push(`coverage: ${name} was not exercised (node status ${status(name)}, wanted ${want})`);
  }
  const internalCases = views.filter(view => /internal slot|internal1/.test(view.name) || view.name.startsWith('OPTIONS') && /internal/.test(view.name));
  if (internalCases.length < 14) problems.push(`coverage: only ${internalCases.length} internal-slot cases`);
  if (!views.some(view => view.rust.status === 503 && view.rust.body.includes('rust_backend_unavailable'))) {
    problems.push('coverage: the 503 rust_backend_unavailable branch was never exercised');
  }
  const queueActions = new Set(views.filter(view => view.name.startsWith('queue action')).map(view => view.name));
  if (queueActions.size < 30) problems.push(`coverage: only ${queueActions.size} queue action cases`);
  // The v1 projection answered by the front door and the legacy listing answered
  // by Node must be different documents on both sides.
  const v1 = byName.get('v1 waits of a session');
  const legacy = byName.get('legacy waits of a session via front door');
  if (v1 && legacy && v1.rust.body === legacy.rust.body) problems.push('coverage: v1 and legacy waits answered the same body');

  if (!problems.length) {
    console.log(`[orchestration-routes] ${views.length} cases compared; ${oracleCalls.length} side-effect calls identical; canaries hold`);
  }
  for (const problem of problems) console.log(`[orchestration-routes] ${problem}`);
  if (problems.length) {
    const file = path.join(workPath, 'coverage-problems.json');
    fs.writeFileSync(file, JSON.stringify(problems, null, 2));
    return { ok: false, details: file };
  }
  return { ok: true, details: path.join(workPath, 'result.json') };
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'orchestration-routes',
  ready: waitForFixture,
  mount: mountOracle,
  get upstream() { return upstreamText; },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: path.join(work, 'gw-data'),
    ORCH_ROOT: work,
  }),
  corpus,
  finalize({ views }) {
    return finalize(views);
  },
});
