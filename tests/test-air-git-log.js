'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const air = fs.readFileSync(path.join(root, 'public/air.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/air.html'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'public/git-manager.js'), 'utf8');

test('directory Git card opens a separate manager instead of expanding history inline', () => {
  assert.match(air, /MultiCCGitManager\?\.open\(\{ dirId: directoryId, api, t \}\)/);
  assert.doesNotMatch(html, /id="directory-git-list"/);
  assert.match(html, /<script src="git-manager\.js"><\/script>/);
});

test('manager fetches commits, then files, then the selected file patch', () => {
  assert.match(manager, /url\('log'/);
  assert.match(manager, /url\('commit-files'/);
  assert.match(manager, /url\('commit-diff'/);
  assert.match(manager, /&file=\$\{encodeURIComponent\(file\.path\)\}/);
  assert.match(manager, /state\.fileCache\.set/);
  assert.match(manager, /state\.diffCache\.set/);
});

test('repository text is never treated as markup and each row is keyboard accessible', () => {
  assert.doesNotMatch(manager, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.match(manager, /result\.textContent = text/);
  assert.match(manager, /row = element\('button'/);
  for (const field of ['commit.subject', 'commit.author', 'commit.refs', 'file.path']) {
    assert.ok(manager.includes(field), field);
  }
});
