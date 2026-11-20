'use strict';

// Equivalence regression for the CLIENT-VISIBLE /ws/chat contract.
//
// Re-runs the conformance capture (real gateway + Node server + fake Claude CLI
// on an isolated data root, docs/rust-migration/differential/capture-chat-ws-conformance.js)
// against the CURRENT code and compares what a browser or the app observes with
// the golden frozen from the Node-terminated implementation: upgrade status,
// frame order and key sets, the exact small frames and the close code/reason.
//
// This is the oracle for moving the /ws/chat upgrade, admission and connection
// ownership into the Rust front door. The golden is never rewritten here; the
// harness is pointed at a temp file. A genuine contract change regenerates the
// golden deliberately, in its own commit.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'docs/rust-migration/differential/capture-chat-ws-conformance.js');
const GOLDEN = path.join(ROOT, 'docs/rust-migration/differential/chat-ws-conformance-golden.json');

const byName = scenarios => Object.fromEntries(scenarios.map(s => [s.name, s]));

test('the /ws/chat contract a client observes matches the frozen Node-terminated behaviour', { timeout: 480_000 }, t => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-ws-conformance-')), 'fresh.json');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [HARNESS, '--out', out, '--compare-shell-bytes'], {
    cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 450_000,
  });
  assert.equal(run.status, 0, `capture failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /任务壳和队列帧逐字节对拍通过，共 13 个场景/);

  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(fresh.scenarios.map(s => s.name), golden.scenarios.map(s => s.name), 'scenario set');
  const got = byName(fresh.scenarios);
  for (const want of golden.scenarios) {
    assert.deepEqual(got[want.name], want, `${want.name}: client-visible behaviour changed`);
  }

  // Facts the contract depends on, asserted against the fresh capture directly
  // so a careless golden regeneration cannot weaken them.
  for (const name of Object.keys(got).filter(n => n.startsWith('deny-'))) {
    assert.equal(got[name].upgrade, 101, `${name}: refusal happens after the upgrade, as a close frame`);
    assert.deepEqual(got[name].close, { code: 4003, reason: 'Forbidden' }, `${name}: close code and reason`);
    assert.equal(got[name].closedBy, 'server', `${name}: the server ends it`);
    assert.deepEqual(got[name].sequence, [], `${name}: no frame reaches a refused client`);
  }
  for (const name of ['admit-local-no-credentials', 'admit-external-legacy-token', 'admit-external-ticket',
    'share-view-ignores-user-message', 'share-operate-routes-user-message', 'ping-pong']) {
    assert.equal(got[name].sequence[0].type, 'system/init', `${name}: the connect burst opens with system init`);
    assert.equal(got[name].closedBy, 'client', `${name}: an admitted socket stays open until the client leaves`);
  }
  assert.deepEqual(got['ping-pong'].exact, [{ type: 'pong', apiVersion: 'v1' }], 'heartbeat reply');
  assert.deepEqual(got['share-view-ignores-user-message'].exact, [{ type: 'pong', apiVersion: 'v1' }],
    'a view-only share is answered to ping but never routes the user message');
  assert.equal(got['session-missing'].exact[0].code, 'session_not_found');
  assert.equal(got['session-missing'].close.code, 1005, 'a missing session ends with a status-less close');
  assert.deepEqual(got['turn-complete'].sequence.map(k => k.type).filter(type => !type.startsWith('@')),
    ['task_shell_routed', 'stream_start', 'stream_event', 'assistant', 'result', 'result/success', 'stream_end'],
    'a whole turn, in order');
});
