'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_VISIBLE,
  buildSessionUrl,
  normalizeDispatches,
  navigationCandidates,
  navigationSessionId,
} = require('../public/chat-dispatch-activity');

test('web dispatch activity dedups and orders live work before fresh terminal history', () => {
  const rows = normalizeDispatches([
    { operationId: 'done-old', terminal: true, status: 'completed', completedAt: 10 },
    { operationId: 'live-old', terminal: false, status: 'running', queueState: 'running', updatedAt: 2 },
    { operationId: 'done-new', terminal: true, status: 'failed', completedAt: 20 },
    { operationId: 'live-new', terminal: false, status: 'admitted', queueState: 'queued', updatedAt: 5 },
    { operationId: 'live-new', terminal: false, status: 'admitted', queueState: 'queued', updatedAt: 99 },
    { status: 'running' },
  ]);
  assert.deepEqual(rows.map(row => row.operationId), [
    'live-old', 'live-new', 'done-new', 'done-old',
  ]);
  assert.equal(MAX_VISIBLE, 5);
});

test('web dispatch activity navigates to execution chat, owner, or nowhere for self', () => {
  const outgoing = {
    relation: 'owner', executionSessionId: 'worker-gw-chat', targetSessionId: 'worker-terminal',
  };
  assert.deepEqual(navigationCandidates(outgoing), ['worker-gw-chat', 'worker-terminal']);
  assert.equal(navigationSessionId(outgoing), 'worker-gw-chat');
  assert.equal(navigationSessionId(outgoing, new Set(['worker-terminal'])), 'worker-terminal');
  assert.equal(navigationSessionId({ relation: 'target', ownerSessionId: 'commander' }), 'commander');
  assert.equal(navigationSessionId({ relation: 'self', ownerSessionId: 'same' }), '');
});

test('web dispatch jump starts from a clean same-directory chat URL', () => {
  const url = new URL(buildSessionUrl(
    'https://example.test/ui/chat.html?session=old&token=secret&message=m1#debug',
    'worker-gw-chat',
  ));
  assert.equal(url.origin, 'https://example.test');
  assert.equal(url.pathname, '/ui/chat.html');
  assert.equal(url.search, '?session=worker-gw-chat');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.has('message'), false);
});

test('web dispatch activity uses bounded record query and text-only DOM rendering', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'chat-dispatch-activity.js'),
    'utf8',
  );
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');
  assert.match(source, /activeOnly=false&relation=both&recentTerminalLimit=5/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /textContent\s*=/);
  assert.match(html, /id="dispatch-activity-fab"/);
  assert.match(html, /src="chat-dispatch-activity\.js"/);
  assert.match(html, /href="chat-dispatch-activity\.css"/);
});
