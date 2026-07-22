'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const safeMarkdown = require('../public/safe-markdown');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'safe-markdown.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
const VIEW = fs.readFileSync(path.join(ROOT, 'public', 'chat-history-view.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
const ATTACK = '<img src=x onerror=alert(1)> [x](javascript:alert(2)) <svg><script>alert(3)</script></svg>';

test('missing sanitizer fails closed to escaped plain text without invoking marked', () => {
  let parseCalls = 0;
  const rendered = safeMarkdown.render(ATTACK, {
    marked: { parse() { parseCalls += 1; return ATTACK; } },
  });
  assert.equal(parseCalls, 0);
  assert.doesNotMatch(rendered, /<img|<svg|<script/i);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /javascript:/);
});

test('sanitizer receives strict HTML-only policy before any result reaches the host', () => {
  let receivedHtml = null;
  let receivedConfig = null;
  const rendered = safeMarkdown.render('attack', {
    marked: { parse: () => ATTACK },
    DOMPurify: {
      sanitize(html, config) {
        receivedHtml = html;
        receivedConfig = config;
        return '<p>safe</p>';
      },
    },
  });
  assert.equal(receivedHtml, ATTACK);
  assert.equal(rendered, '<p>safe</p>');
  assert.equal(receivedConfig.USE_PROFILES.html, true);
  for (const tag of ['svg', 'math', 'style', 'form', 'iframe', 'object', 'embed']) {
    assert.ok(receivedConfig.FORBID_TAGS.includes(tag), `must forbid ${tag}`);
  }
  assert.equal(receivedConfig.ALLOW_UNKNOWN_PROTOCOLS, false);
  assert.equal(receivedConfig.ALLOW_DATA_ATTR, false);
  assert.equal(receivedConfig.ALLOWED_URI_REGEXP.test('javascript:alert(1)'), false);
  assert.equal(receivedConfig.ALLOWED_URI_REGEXP.test('data:text/html,alert(1)'), false);
  assert.equal(receivedConfig.ALLOWED_URI_REGEXP.test('blob:https://example.test/id'), false);
  assert.equal(receivedConfig.ALLOWED_URI_REGEXP.test('https://example.test/image.png'), true);
  assert.equal(receivedConfig.ALLOWED_URI_REGEXP.test('/api/files?path=safe.png'), true);
});

test('parser or sanitizer exceptions also degrade to escaped source', () => {
  const rendered = safeMarkdown.render(ATTACK, {
    marked: { parse: () => ATTACK },
    DOMPurify: { sanitize() { throw new Error('unavailable'); } },
  });
  assert.doesNotMatch(rendered, /<img|<svg|<script/i);
  assert.match(rendered, /&lt;svg&gt;/);
});

test('classic VM export never returns raw malicious marked output when purifier is unavailable', () => {
  const window = { marked: { parse: () => ATTACK } };
  vm.runInNewContext(SOURCE, { window, globalThis: window }, { filename: 'safe-markdown.js' });
  const rendered = window.MultiCCSafeMarkdown.render(ATTACK);
  assert.doesNotMatch(rendered, /<img|<svg|<script/i);
  assert.match(rendered, /&lt;img/);
});

test('chat loads purifier and the shared boundary before host rendering', () => {
  const purify = 'vendor/dompurify/purify.min.js';
  const marked = 'marked@12.0.1/marked.min.js';
  const boundary = '<script src="safe-markdown.js"></script>';
  const host = '<script src="chat.js"></script>';
  assert.ok(HTML.indexOf(purify) > 0);
  assert.ok(HTML.indexOf(purify) < HTML.indexOf(marked));
  assert.ok(HTML.indexOf(marked) < HTML.indexOf(boundary));
  assert.ok(HTML.indexOf(boundary) < HTML.indexOf(host));
  assert.match(CHAT, /safeMarkdown: window\.MultiCCSafeMarkdown/);
  assert.doesNotMatch(CHAT, /marked\.parse\(/,
    'real-time, initial replay and pagination must share the safe renderer');
  assert.match(VIEW, /const safeHtml = safeMarkdown\.render\(text\)/);
  assert.equal((VIEW.match(/\.innerHTML\s*=/g) || []).length, 1);
  assert.doesNotMatch(HTML, /cdn\.jsdelivr\.net\/npm\/dompurify/i);
});

// The Commander dispatch receipt (src/routes/task-board.js) folds the user's
// trigger message into <details><summary>…<pre><code>escaped</code></pre>. That
// only stays visible if the sanitizer keeps those structural tags — guard it so
// a future FORBID_TAGS tweak can't silently strip the fold.
test('sanitizer keeps the tags the dispatch-receipt fold depends on', () => {
  for (const tag of ['details', 'summary', 'pre', 'code', 'blockquote']) {
    assert.ok(!safeMarkdown.SANITIZE_CONFIG.FORBID_TAGS.includes(tag), `must not forbid ${tag}`);
  }
  assert.equal(safeMarkdown.SANITIZE_CONFIG.USE_PROFILES.html, true);
});

test('escapeHtml neutralizes fold-breaking and script payloads verbatim', () => {
  assert.equal(safeMarkdown.escapeHtml('</details>'), '&lt;/details&gt;');
  assert.equal(safeMarkdown.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(safeMarkdown.escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(safeMarkdown.escapeHtml('让工程师改 README'), '让工程师改 README');   // CJK/plain untouched
});
