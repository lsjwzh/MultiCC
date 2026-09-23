'use strict';

/**
 * 目录的 Git 提交树：旧管理台那一版（manage.html 里的 openGitTree 内联脚本 +
 * tests/test-manage-git-tree-commit-open.js）随整页删除退场，Web 上只剩 Air 目录详情里
 * 这一份（public/air.js 的 paintDirectoryGitLog / toggleCommitDetail，接口仍是
 * /api/git/log 与 /api/git/commit-diff）。
 *
 * 旧版那三条义务不能跟着旧页一起丢：
 *   ① 提交内容一律当文本渲染 —— 作者名、subject、refs 都来自仓库，是敌意输入；
 *   ② 能打开视图的行必须键盘可达（旧版靠 role+tabindex 补，Air 直接用真 button）；
 *   ③ 重复点同一行不会再发一次请求（diff 取回后缓存在 commit.__diff 上）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const air = fs.readFileSync(path.join(ROOT, 'public/air.js'), 'utf8');

function block(name) {
  const anchor = air.indexOf(`function ${name}(`);
  assert.ok(anchor > 0, `public/air.js should still define ${name}()`);
  const next = air.indexOf('\n  }', anchor);
  assert.ok(next > anchor, `${name}() must be readable as a block`);
  return air.slice(anchor, next);
}

test('the commit list renders repository text as text, never as markup', () => {
  const source = block('paintDirectoryGitLog');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML|document\.write/);
  // node(tag, text) 的第二个参数走 textContent（见 air.js 的 node 定义），提交的四个
  // 自由字段都必须经它 —— 直接拼进模板字符串再塞 DOM 就是旧版修掉的那个洞。
  for (const field of ['commit.subject', 'commit.author', 'commit.refs', 'commit.short']) {
    assert.ok(source.includes(field), `the commit row must render ${field}`);
  }
});

test('a commit row is a real button, so it opens by keyboard as well as by click', () => {
  const source = block('paintDirectoryGitLog');
  assert.match(source, /node\('button', null, 'directory-git-commit-head'\)/);
  assert.match(source, /head\.type = 'button'/);
  assert.match(source, /head\.setAttribute\('aria-expanded'/);
  assert.match(source, /head\.onclick = \(\) => void toggleCommitDetail\(commit\)/);
});

test('reopening a commit reuses the diff it already fetched', () => {
  const source = block('toggleCommitDetail');
  // 已展开的再点一次是收起，不是第二次请求。
  assert.match(source, /if \(directoryGitView\.openHash === commit\.hash\) \{[\s\S]*?return;/);
  // 取过的 diff 缓存在 commit 上；只有 undefined（从没取过）才会再发一次。
  assert.match(source, /if \(commit\.__diff === undefined\)/);
  assert.match(source, /api\(`\/api\/git\/commit-diff\?dirId=\$\{encodeURIComponent\(directoryId\)\}&hash=\$\{encodeURIComponent\(commit\.hash\)\}`\)/);
});

test('a failed log or diff is reported, not silently swallowed', () => {
  assert.match(air, /airGitLogFailed/);
  assert.match(air, /airGitDiffFailed/);
  assert.match(air, /airGitDiffTruncated/);
});
