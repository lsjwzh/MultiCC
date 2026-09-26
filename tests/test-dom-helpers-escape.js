'use strict';

// 一份转义表，一个来源。
//
// 浏览器里的 XSS 从来不是「忘记转义」那么直白，而是「转了一半」：只替换 & < > 的副本
// 落在属性位置上（`data-rel="${esc(x)}"`）等于没转 —— 双引号能自己结束属性；用
// textContent→innerHTML 拼出来的副本连引号都不认；typeof 守卫的 else 分支把原文吐回去
// 更彻底。这些都是「读代码看不出来」的：调用点在别处，属性还是双引号，静态看很干净。
//
// 所以这道锁不检查「有没有调用 esc」，而是直接抓住 public/ 里每一个逃逸函数的定义：
//   ① 定义必须登记在下面的 REGISTRY 里 —— 新写一个副本、或把副本删掉换成委托，都要
//      回来改这里，禁止悄悄多出一份；
//   ② 每个定义都要真的跑一遍：抽出来的函数体在 vm 里执行，喂 `&<>"'`，输出必须五个
//      都转义。委托型的（= escapeHtml）在装了 shared/dom-helpers.js 的沙箱里跑，
//      自包含型的（模块自带副本）在空沙箱里跑 —— 后者正是「不依赖页面加载顺序」的意思；
//   ③ 委托型的必须真的能被加载：定义所在的页面要在它之前加载 shared/dom-helpers.js，
//      否则页面一开就是 ReferenceError（读代码同样看不出来）；
//   ④ 自包含型的必须在 shared/dom-helpers.js 的注释里被点名（那份注释就是允许清单）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED_REL = 'shared/dom-helpers.js';
const SHARED_PATH = path.join(PUBLIC, SHARED_REL);
const SHARED_TAG = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*shared\/dom-helpers\.js[^"']*["']/;

// 会被当成「转义函数」的名字。
const ESCAPE_NAMES = ['escapeHtml', 'escapeAttr', 'escapeAttribute', 'htmlEscape', 'escHtml', 'escH', 'esc'];
// 五个字符的规范输出。顺序固定：先 & 就不会把后生成的实体再转一遍。
const RAW = '&<>"\'';
const ESCAPED = '&amp;&lt;&gt;&quot;&#39;';

// path → [{ name, mode, reason }]
//   delegate      调用 shared/dom-helpers.js 那份（页面必须先加载它）
//   self-contained 模块自带一份完整实现（Node-requireable / 不依赖页面顺序）
//   fallback      两份都要：有全局就用全局，没有也必须自己转全五个（不许吐原文）
//   alias         指向别的模块的转义函数（model.escapeHtml 这种）
const REGISTRY = {
  'public/shared/dom-helpers.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: 'canonical: 这一份就是规范实现，其它页面加载的就是它' },
  ],
  'public/safe-markdown.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: 'node:test 可 require 的渲染边界，不能依赖页面顺序' },
  ],
  'public/status-presentation.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: '状态字典是共享模块，manage/Air/App 都按它渲染' },
  ],
  'public/task-board-ui.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: '任务板行渲染器，被 meta.html 与测试单独加载' },
  ],
  'public/chat-usage-readout.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: '用量读数渲染器，独立于 chat.js 加载' },
  ],
  'public/tour.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: '引导层每步文案来自服务端，独立渲染' },
  ],
  'public/memory-model.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: 'memory-model 是 Air 记忆面板的模块边界，memory-graph / memory-controller 都拿它这一份' },
  ],
  'public/task-graph.js': [
    { name: 'escapeHtml', mode: 'self-contained', reason: '图谱渲染 IIFE，自带一份以免依赖页面顺序' },
  ],
  'public/docs-registry.js': [
    { name: 'esc', mode: 'self-contained', reason: '按模块被引用（tests/test-docs-registry.js），不靠页面全局' },
  ],
  'public/air-tunnel.js': [
    { name: 'esc', mode: 'self-contained', reason: '自包含 IIFE，Air 之外的隧道页也单独加载' },
  ],
  'public/air-bridges.js': [
    { name: 'esc', mode: 'self-contained', reason: '自包含 IIFE，不依赖页面顺序' },
  ],
  'public/air-provider-advanced.js': [
    { name: 'esc', mode: 'self-contained', reason: '自包含 IIFE，且兼任页面缺失 dom-helpers.js 时补 window.escapeHtml 的实现' },
  ],
  'public/chat.js': [
    { name: 'escHtml', mode: 'delegate', reason: 'chat.html 在 chat.js 之前加载 shared/dom-helpers.js' },
  ],
  'public/chat-handoff.js': [
    { name: 'esc', mode: 'delegate', reason: '交接包弹窗，chat.html 在它之前加载 shared/dom-helpers.js' },
  ],
  'public/dashboard.js': [
    { name: 'esc', mode: 'delegate', reason: 'dashboard.html 加载了 shared/dom-helpers.js' },
  ],
  'public/share.html': [
    { name: 'esc', mode: 'delegate', reason: 'inline 脚本前的 <script src="/shared/dom-helpers.js">' },
  ],
  'public/meta.html': [
    { name: 'esc', mode: 'delegate', reason: 'inline 脚本前的 <script src="shared/dom-helpers.js">' },
  ],
  'public/manage-official-accounts.js': [
    { name: 'esc', mode: 'fallback', reason: 'Air 有 dom-helpers.js 就用它；单独加载（单元测试 / 旧页）时自己转全五个，绝不吐原文' },
  ],
  'public/memory-graph.js': [
    { name: 'escapeHtml', mode: 'alias', reason: 'model.escapeHtml —— 指向 memory-model.js 那一份' },
  ],
  'public/memory-controller.js': [
    { name: 'escapeHtml', mode: 'alias', reason: 'model.escapeHtml —— 指向 memory-model.js 那一份' },
  ],
};

// ── 扫描 ────────────────────────────────────────────────────────
function walkPublic(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPublic(absolute, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(absolute);
  }
  return out;
}

function readPublic(absolute) { return fs.readFileSync(absolute, 'utf8'); }

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipComment(src, start) {
  if (src[start + 1] === '/') {
    const newline = src.indexOf('\n', start);
    return newline < 0 ? src.length : newline + 1;
  }
  const end = src.indexOf('*/', start + 2);
  return end < 0 ? src.length : end + 2;
}

// 正则字面量也要整段跳过：/[&<>"']/ 里的引号不是字符串开头。这里的前一位判定是
// 「表达式位置才算正则」的老办法 —— 转义函数里够用，且比当除法误判安全得多。
const REGEX_LEAD = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);
function regexEnd(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return start + 1; // 不是正则（正则不能跨行）
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i + 1;
    i += 1;
  }
  return src.length;
}

function skipAtom(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') return skipString(src, i);
  if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) return skipComment(src, i);
  if (ch === '/') {
    let previous = i - 1;
    while (previous >= 0 && /\s/.test(src[previous])) previous -= 1;
    if (previous < 0 || REGEX_LEAD.has(src[previous])) return regexEnd(src, i);
  }
  return -1;
}

// 花括号配平，字符串 / 注释 / 正则跳过。
function blockEnd(src, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const skipped = skipAtom(src, i);
    if (skipped >= 0) { i = skipped; continue; }
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  throw new Error(`unbalanced braces at offset ${openIndex}`);
}

// 表达式体（箭头函数 / 别名）的结尾：深度 0 的第一个分号。
function statementEnd(src, from) {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const skipped = skipAtom(src, i);
    if (skipped >= 0) { i = skipped; continue; }
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return i;
    i += 1;
  }
  return src.length - 1;
}

function classifyAssignment(src, rhsStart) {
  const head = src.slice(rhsStart, rhsStart + 120);
  if (/^function\b/.test(head)) return 'function';
  if (/^\(/.test(head)) return 'expression';
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(head)) return 'expression';
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*;/.test(head)) return 'alias';
  return null; // 调用/字面量 —— 是用点，不是定义
}

// 每个定义抽出「可单独求值」的源码片段。
function scanDefinitions(src) {
  const found = [];
  for (const match of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!ESCAPE_NAMES.includes(match[1])) continue;
    const open = src.indexOf('{', match.index);
    if (open < 0) continue;
    found.push({ name: match[1], kind: 'function', start: match.index, source: src.slice(match.index, blockEnd(src, open) + 1) });
  }
  for (const match of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    if (!ESCAPE_NAMES.includes(match[1])) continue;
    const rhsStart = match.index + match[0].length;
    const kind = classifyAssignment(src, rhsStart);
    if (!kind) continue;
    const start = kind === 'function' ? src.indexOf('function', rhsStart) : match.index;
    const end = kind === 'function'
      ? blockEnd(src, src.indexOf('{', src.indexOf('(', src.indexOf('function', rhsStart)) + 1))
      : statementEnd(src, rhsStart);
    found.push({ name: match[1], kind: kind === 'alias' ? 'alias' : 'expression', start: match.index, source: src.slice(start, end + 1) });
  }
  return found.sort((left, right) => left.start - right.start);
}

const scanned = (() => {
  const byFile = new Map();
  for (const absolute of walkPublic(PUBLIC)) {
    const definitions = scanDefinitions(readPublic(absolute));
    if (definitions.length) byFile.set(absolute.replace(ROOT + path.sep, '').split(path.sep).join('/'), definitions);
  }
  return byFile;
})();

function registryFor(relative) { return REGISTRY[relative] || []; }

function modesFor(relative, name) {
  const entry = registryFor(relative).find(item => item.name === name);
  return entry ? (entry.mode === 'fallback' ? ['delegate', 'self-contained'] : [entry.mode]) : [];
}

// ── 求值 ────────────────────────────────────────────────────────
const canonical = require(SHARED_PATH).escapeHtml;

function evaluate(source, name, mode) {
  const sandbox = {};
  if (mode === 'delegate') sandbox.escapeHtml = canonical;
  // model.escapeHtml 这类别名：给一个任何属性都返回规范实现的替身，验证别名确实指向函数。
  if (mode === 'alias') sandbox.model = new Proxy({}, { get: () => canonical });
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: `${name}.snippet.js`, timeout: 2000 });
  return vm.runInContext(name, context, { timeout: 2000 });
}

// ── ① 登记表与扫描结果必须一一对应 ───────────────────────────────
test('every escape function in public/ is registered, and every registration exists', () => {
  const unregistered = [];
  for (const [relative, definitions] of scanned) {
    for (const definition of definitions) {
      if (!registryFor(relative).some(item => item.name === definition.name)) {
        unregistered.push(`${relative}: ${definition.name}`);
      }
    }
  }
  assert.deepEqual(unregistered, [],
    '新的转义副本（或改了名字的定义）要登记进 REGISTRY：要么委托 shared/dom-helpers.js，要么写清为什么自包含');

  const stale = [];
  for (const [relative, entries] of Object.entries(REGISTRY)) {
    for (const entry of entries) {
      const file = path.join(ROOT, relative);
      if (!fs.existsSync(file)) { stale.push(`${relative}: 文件不存在`); continue; }
      if (!(scanned.get(relative) || []).some(definition => definition.name === entry.name)) {
        stale.push(`${relative}: ${entry.name}`);
      }
    }
  }
  assert.deepEqual(stale, [], '登记表里的条目已经不在文件里了 —— 删掉这条，别让清单漂着');
});

// ── ② 每一个副本都真的转全五个字符 ──────────────────────────────
for (const [relative, definitions] of scanned) {
  for (const definition of definitions) {
    for (const mode of modesFor(relative, definition.name)) {
      test(`${relative} ${definition.name} escapes all five characters (${mode})`, () => {
        const fn = evaluate(definition.source, definition.name, mode);
        assert.equal(typeof fn, 'function', `${definition.name} 应该能被单独求值成一个函数`);
        assert.equal(fn(RAW), ESCAPED,
          mode === 'self-contained'
            ? '自包含副本必须自己转全 & < > " \'（空沙箱里跑，不允许依赖页面全局）'
            : '委托型必须真的转全五个；带上 shared/dom-helpers.js 后仍漏字符说明它没在委托');
      });
    }
  }
}

// ── ③ 委托型的页面顺序：helper 必须加载在定义/消费者之前 ────────
// 消费者脚本的 <script src> 匹配：basename 前必须是引号或斜杠，否则 chat.js 会
// 命中 wechat.js 这种「名字里带 chat.js」的邻居。
function consumerTagPattern(relative) {
  const basename = path.basename(relative).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["'](?:[^"']*/)?${basename}(?:\\?[^"']*)?["']`);
}

test('delegating files load shared/dom-helpers.js before they use it', () => {
  const problems = [];
  for (const [relative, entries] of Object.entries(REGISTRY)) {
    if (!entries.some(entry => entry.mode === 'delegate' || entry.mode === 'fallback')) continue;
    const definitions = (scanned.get(relative) || []).filter(definition =>
      entries.some(entry => entry.name === definition.name)
      && modesFor(relative, definition.name).includes('delegate'));
    if (!definitions.length) continue;
    // 定义在页面里就查那一页；定义在 .js 里就查所有加载它的页面 —— 漏一页就是那页白屏。
    const pages = relative.endsWith('.html')
      ? [relative]
      : walkPublic(PUBLIC)
        .map(file => file.replace(ROOT + path.sep, '').split(path.sep).join('/'))
        .filter(file => file.endsWith('.html') && consumerTagPattern(relative).test(readPublic(path.join(ROOT, file))));
    if (!pages.length) { problems.push(`${relative}: 没有任何页面加载它`); continue; }
    for (const page of pages) {
      const html = readPublic(path.join(ROOT, page));
      const helperTag = SHARED_TAG.exec(html);
      if (!helperTag) {
        problems.push(`${page} 加载了 ${relative} 却没加载 ${SHARED_REL} —— 页面一开就 ReferenceError`);
        continue;
      }
      const consumer = relative.endsWith('.html')
        ? definitions[0].start
        : consumerTagPattern(relative).exec(html).index;
      if (helperTag.index > consumer) {
        problems.push(`${page}: ${SHARED_REL} 排在 ${relative} 之后 —— 页面一开就 ReferenceError`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// ── ④ 自包含型的允许清单写在 shared/dom-helpers.js 注释里 ────────
test('self-contained copies are named in the shared helper header', () => {
  const header = fs.readFileSync(SHARED_PATH, 'utf8').split('(function attachMultiCCDomHelpers')[0];
  const missing = [];
  for (const [relative, entries] of Object.entries(REGISTRY)) {
    if (relative === `public/${SHARED_REL}`) continue;
    for (const entry of entries) {
      if (entry.mode !== 'self-contained') continue;
      const basename = path.basename(relative).replace(/\.(js|html)$/, '');
      if (!header.includes(basename)) missing.push(`${relative} (${entry.reason})`);
    }
  }
  assert.deepEqual(missing, [],
    'shared/dom-helpers.js 头注释就是允许清单 —— 新增自包含副本要连它一起改');
});

// ── ⑤ 别名要指向一个已登记的规范名 ──────────────────────────────
test('alias copies point at a registered escape name', () => {
  const problems = [];
  for (const [relative, definitions] of scanned) {
    for (const definition of definitions) {
      if (!modesFor(relative, definition.name).includes('alias')) continue;
      const target = definition.source.slice(definition.source.indexOf('=') + 1).replace(/;$/, '').trim();
      const tail = target.split('.').pop();
      if (!ESCAPE_NAMES.includes(tail)) problems.push(`${relative}: ${definition.name} = ${target}（不是转义函数名）`);
      const owners = Object.entries(REGISTRY)
        .filter(([file, entries]) => file !== relative && entries.some(entry => entry.name === tail && entry.mode === 'self-contained'))
        .map(([file]) => file);
      if (!owners.length) problems.push(`${relative}: ${definition.name} = ${target} 指向的 ${tail} 不在允许清单里`);
    }
  }
  assert.deepEqual(problems, []);
});

// ── ⑥ 规范实现本身的契约 ────────────────────────────────────────
test('the canonical helper escapes five characters and renders null as empty', () => {
  assert.equal(canonical(RAW), ESCAPED);
  assert.equal(canonical(null), '');
  assert.equal(canonical(undefined), '');
  assert.equal(canonical(0), '0');
  assert.equal(canonical('&amp;'), '&amp;amp;', '已转义的实体不再二次转义（只认原文的 &）');
});
