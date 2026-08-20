'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { toSessionDto } = require('../src/session-dto');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('public session DTO exposes only safe hibernation lifecycle fields', () => {
  const dto = toSessionDto({
    id: 'bound-1', kind: 'chat', workspaceState: 'hibernated',
    lastWorkAt: '2026-08-01T00:00:00.000Z', hibernatedAt: '2026-08-08T00:00:00.000Z',
    workspaceStateUpdatedAt: '2026-08-08T00:00:01.000Z',
    workspaceStateErrorCode: 'hibernate_branch_missing',
    worktreePath: '/secret/repo', branch: 'multicc/bound-1', hibernateSnapshot: 'abc123',
  });
  assert.equal(dto.workspaceState, 'hibernated');
  assert.equal(dto.lastWorkAt, '2026-08-01T00:00:00.000Z');
  assert.equal(dto.hibernatedAt, '2026-08-08T00:00:00.000Z');
  assert.equal('worktreePath' in dto, false);
  assert.equal('branch' in dto, false);
  assert.equal('hibernateSnapshot' in dto, false);
  assert.equal('workspaceStateErrorCode' in dto, false, 'internal failure codes are not public DTO data');
});

test('host composition gates every real ingress and keeps view paths passive', () => {
  const server = read('server.js');
  const engine = read('src/chat/turn-engine.js');
  const cron = read('plugins/cron/cron-tasks.js');
  const board = read('src/routes/task-board.js');
  assert.match(server, /reconcileStartup\(\).*initWorktrees/s);
  assert.match(engine, /getSessionHibernation/);
  assert.match(engine, /sessionHibernation\.admit/);
  assert.match(engine, /assertAwake/);
  assert.match(server, /acquireDelivery/);
  assert.match(cron, /admitChatWork/);
  assert.doesNotMatch(cron, /deps\.runChatTurn\(/);
  assert.match(board, /workspaceState/);
  const view = board.slice(board.indexOf('async function handleChatSession'), board.indexOf('async function handleCancelRun'));
  assert.doesNotMatch(view, /ensureAwake|thaw/i, 'opening a task chat must not thaw it');
});

test('management task board renders hibernated state without manual controls', () => {
  const ui = read('public/manage-taskboard.js');
  assert.match(ui, /workspaceState/);
  assert.match(ui, /已休眠/);
  assert.doesNotMatch(ui, /manualThaw|hibernateButton|手动休眠/);
});

test('hibernation tests are explicitly registered in deterministic scripts', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const all = Object.values(scripts).join(' ');
  for (const file of [
    'tests/test-session-hibernation.js',
    'tests/test-session-hibernation-git.js',
    'tests/test-session-hibernation-contract.js',
  ]) assert.match(all, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

