'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const memo = require('../public/memo-controller');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'memo-controller.js'), 'utf8');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.selectionStart = 0;
    this.textContent = '';
    this.className = '';
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.onkeydown = null;
    this.focused = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  focus() {
    this.focused = true;
  }
}

function createDocument() {
  const ids = [
    'memo-modal', 'memo-text', 'memo-status', 'memo-title', 'memo-subtitle',
    'memo-picker', 'memo-picker-preview', 'memo-picker-list',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  return {
    elements,
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return new FakeElement(tag); },
  };
}

test('memo DTOs whitelist fields and directory sessions', () => {
  const document = memo.normalizeMemoDocument({
    text: '# safe', path: '/workspace/multicc.memo.md', exists: true, mtime: 42,
    token: 'drop', stack: 'drop', auth: { secret: 'drop' },
  });
  assert.deepEqual(document, {
    text: '# safe', path: '/workspace/multicc.memo.md', exists: true, mtime: 42,
  });
  assert.equal(document.token, undefined);
  assert.equal(Object.isFrozen(document), true);

  const sessions = memo.sessionsForDirectory([
    { id: 'chat-1', dirId: 'dir-1', label: 'Chat', kind: 'chat', type: '', active: true, token: 'drop' },
    { id: 'aux-1', dirId: 'dir-1', kind: 'chat', type: 'aux' },
    { id: 'task-1', dirId: 'dir-1', kind: 'task', type: '' },
    { id: 'chat-2', dirId: 'dir-2', kind: 'chat', type: '' },
  ], 'dir-1');
  assert.deepEqual(sessions, [{
    id: 'chat-1', dirId: 'dir-1', label: 'Chat', kind: 'chat', type: '', active: true,
  }]);
  assert.equal(sessions[0].token, undefined);
  assert.equal(Object.isFrozen(sessions[0]), true);
});

test('classic script exports a browser global without ESM or direct network access', () => {
  const window = {};
  vm.runInNewContext(SOURCE, { window }, { filename: 'memo-controller.js' });
  assert.equal(typeof window.MultiCCMemo.createController, 'function');
  assert.equal(typeof window.MultiCCMemo.normalizeMemoDocument, 'function');
  assert.doesNotMatch(SOURCE, /\b(?:import|export)\s/);
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(SOURCE, /tokenQS/);
});

test('line extraction preserves legacy markdown marker behavior', () => {
  const value = 'plain\n- [ ] send this task\n## heading\n3. numbered';
  assert.equal(memo.extractCurrentLine(value, value.indexOf('send')), 'send this task');
  assert.equal(memo.extractCurrentLine(value, value.indexOf('heading')), 'heading');
  assert.equal(memo.extractCurrentLine(value, value.indexOf('numbered')), 'numbered');
  assert.equal(memo.extractCurrentLine('', 0), '');
});

test('memo endpoints are same-origin paths with encoded identifiers and no query credentials', () => {
  assert.equal(memo.memoEndpoint('dir/one'), '/api/directories/dir%2Fone/memo');
  assert.equal(memo.memoEndpoint('dir/one', '/send'), '/api/directories/dir%2Fone/memo/send');
  assert.doesNotMatch(memo.memoEndpoint('dir?token=secret'), /[?&]token=/);
  assert.throws(() => memo.memoEndpoint(''), /directory id is required/);
  assert.throws(() => memo.memoEndpoint('dir-1', '?token=secret'), /unsupported memo endpoint/);
});

test('controller loads, saves and sends through the shared API client', async () => {
  const document = createDocument();
  const calls = [];
  const api = {
    async json(url, options) {
      calls.push({ url, options });
      if (!options) return {
        text: 'intro\n- [ ] ship the release\nlast',
        path: '/repo/multicc.memo.md',
        exists: true,
        mtime: 1,
        authToken: 'drop',
      };
      return options.method === 'POST' ? { ok: true, sentTo: 'chat-1', secret: 'drop' } : { mtime: 2 };
    },
    errorDisplay() { return { message: 'safe request failure' }; },
  };
  const controller = memo.createController({
    api,
    document,
    getDirectories: () => [{ id: 'dir/one', name: '<Fleet>' }],
    getSessions: () => [
      { id: 'chat-1', dirId: 'dir/one', label: '<Primary>', kind: 'chat', type: '', active: false, token: 'drop' },
      { id: 'aux-1', dirId: 'dir/one', kind: 'chat', type: 'aux' },
    ],
    getSessionStatus: () => ({ status: 'waiting', stderr: 'drop' }),
    now: () => ({ toLocaleTimeString: () => '12:34:56' }),
  });

  await controller.openMemo('dir/one');
  assert.deepEqual(calls[0], { url: '/api/directories/dir%2Fone/memo', options: undefined });
  assert.equal(document.elements['memo-title'].textContent, '📝 <Fleet> · 备忘');
  assert.equal(document.elements['memo-subtitle'].textContent, '/repo/multicc.memo.md');
  assert.equal(document.elements['memo-text'].focused, true);

  document.elements['memo-text'].value += '\nnew';
  await controller.memoSave();
  assert.deepEqual(calls[1], {
    url: '/api/directories/dir%2Fone/memo',
    options: { method: 'PUT', json: { text: 'intro\n- [ ] ship the release\nlast\nnew' } },
  });
  assert.equal(document.elements['memo-status'].textContent, '已保存 · 12:34:56');

  document.elements['memo-text'].selectionStart = document.elements['memo-text'].value.indexOf('ship');
  controller.memoSendCurrentLine();
  const list = document.elements['memo-picker-list'];
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children.map(child => child.textContent).join('|'), '<Primary>| chat-1|waiting');
  assert.equal(JSON.stringify(list.children).includes('drop'), false);
  await list.children[0].listeners.click();
  assert.deepEqual(calls[2], {
    url: '/api/directories/dir%2Fone/memo/send',
    options: { method: 'POST', json: { text: 'ship the release', sessionId: 'chat-1' } },
  });
  assert.equal(document.elements['memo-status'].textContent, '已发送到 chat-1 · 12:34:56');
});

test('controller ignores stale loads and displays only API-safe errors', async () => {
  const document = createDocument();
  let rejectRequest;
  const api = {
    json() { return new Promise((_, reject) => { rejectRequest = reject; }); },
    errorDisplay() { return { message: 'safe request failure' }; },
  };
  const controller = memo.createController({
    api,
    document,
    getDirectories: () => [{ id: 'dir-1', name: 'Fleet' }],
  });
  const pending = controller.openMemo('dir-1');
  controller.closeMemoModal();
  rejectRequest(new Error('Bearer secret-token at /Users/private/worktree'));
  await pending;
  assert.equal(document.elements['memo-subtitle'].textContent, '加载中…');
  assert.equal(JSON.stringify(document.elements).includes('secret-token'), false);

  const failedDocument = createDocument();
  const failed = memo.createController({
    api: {
      async json() { throw new Error('Bearer another-secret at /private/path'); },
      errorDisplay() { return { message: 'safe request failure' }; },
    },
    document: failedDocument,
    getDirectories: () => [{ id: 'dir-1', name: 'Fleet' }],
  });
  await failed.openMemo('dir-1');
  assert.equal(failedDocument.elements['memo-subtitle'].textContent, '加载失败：safe request failure');
  assert.equal(JSON.stringify(failedDocument.elements).includes('another-secret'), false);
});

test('manage loads the classic memo controller before page code and retains only UI glue', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.js'), 'utf8');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const api = html.indexOf('<script src="api-client.js"></script>');
  const controller = html.indexOf('<script src="memo-controller.js"></script>');
  const providers = html.indexOf('<script src="provider-catalog.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');
  assert.ok(auth > 0 && auth < api && api < controller && controller < providers && providers < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+memo-controller/i);

  const start = manage.indexOf('// ── Per-directory memo');
  const end = manage.indexOf('async function renameDirectory', start);
  const memoBlock = manage.slice(start, end);
  assert.match(memoBlock, /window\.MultiCCMemo\.createController/);
  assert.match(memoBlock, /getDirectories: \(\) => _cachedDirectories/);
  assert.match(memoBlock, /getSessions: \(\) => _cachedSessions/);
  assert.doesNotMatch(memoBlock, /\bfetch\s*\(/);
  assert.doesNotMatch(memoBlock, /tokenQS/);
  assert.doesNotMatch(memoBlock, /\.innerHTML\s*=/);
  assert.ok(memoBlock.split(/\r?\n/).length < 40, 'manage.js memo block should remain UI glue');
});
