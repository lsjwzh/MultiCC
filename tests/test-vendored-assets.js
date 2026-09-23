'use strict';

// 「页面自己带全部依赖」这条不变的锁。
//
// Air / chat / 任务壳 / 终端页原来把 marked、highlight.js、xterm 放在 cdn.jsdelivr.net 上。
// 代价不是「少个语法高亮」：同步的 <script src> 会停住 HTML 解析，CDN 一旦挂住（被墙、假
// IP、对方抖动），页面就一直白屏 —— 实测 readyState 永远是 loading、document.body 都没有，
// 打开耗时等于 CDN 超时（≈30s）；而那个 highlight 地址本来就是 404，既拿不到也不能缓存，
// 每次进页面都要重新撞一遍。外链因此全部收进 public/vendor/。
//
// 这一条守三件事，都是「读代码看不出来」的：
//   ① 送出去的 HTML/CSS 里不再有任何第三方资源地址（<a href> 那种导航链接不算 ——
//      它是给人点的，不是依赖）；
//   ② 页面点名的本地资源真的在仓库里 —— 改路径时漏掉文件同样是白屏；
//   ③ 收进来的第三方文件与记录的官方字节一致 —— 「库更新了就更新到本地」这个流程里，
//      升级 = 重新下载 + 更新这里的指纹，不同步指纹就说明这份文件已经不是记录的那一份。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 会自己去网络上取东西的标签；<a> 不在其中（导航链接不是依赖）。
const ASSET_TAG = /<(?:script|link|img|iframe|source|video|audio|embed|object|track)\b[^>]*>/gi;
const ASSET_ATTR = /\b(?:src|href|srcset|poster)\s*=\s*["']([^"']*)["']/gi;
// CSS 里的取用点：@import 与 url()。字体、图标以前都是从这类地方出去的。
const CSS_REF = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
// http(s):// 与协议相对地址 //host/...；data: 不算（内联在文档里，不出网）。
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
// 只对「看起来是个文件」的引用做存在性检查：/api/... 之类的路由、目录页地址不在此列。
const FILE_REF = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|json|map|mp3|wav|webm|mp4|wasm)(?:\?|#|$)/i;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}

const SERVED = walk(PUBLIC_DIR).filter(file => /\.(html|css)$/i.test(file));

// 一份 HTML/CSS 里所有会触发网络请求的引用地址（顺序无关）。
function assetRefs(file) {
  const text = fs.readFileSync(file, 'utf8');
  const refs = [];
  if (/\.html$/i.test(file)) {
    for (const tag of text.match(ASSET_TAG) || []) {
      // 这几类 link 只是给爬虫/预解析看的，不取资源。
      if (/^<link\b[^>]*\brel\s*=\s*["']?(?:canonical|alternate|dns-prefetch)["']?/i.test(tag)) continue;
      for (const match of tag.matchAll(ASSET_ATTR)) refs.push(match[1]);
    }
  } else {
    for (const match of text.matchAll(CSS_REF)) refs.push(match[1] || match[2] || match[3]);
  }
  return refs.map(value => String(value).trim()).filter(Boolean);
}

// 页面里 <base href> 会改相对地址的解析基准（chat.html 就写了 <base href="/">，
// 它被 /share/<token> 之类的深层地址加载时，靠这一条才找得到根下的资源）。
function resolveRef(file, value) {
  const clean = value.split(/[?#]/)[0];
  if (clean.startsWith('/')) return path.join(PUBLIC_DIR, clean);
  const base = (fs.readFileSync(file, 'utf8').match(/<base\b[^>]*href\s*=\s*["']([^"']+)["']/i) || [])[1];
  if (base && base.startsWith('/')) return path.join(PUBLIC_DIR, base.replace(/\/+$/, ''), clean);
  return path.resolve(path.dirname(file), clean);
}

test('served pages and stylesheets reference no third-party asset host', () => {
  const offenders = [];
  for (const file of SERVED) {
    for (const ref of assetRefs(file)) {
      if (ref.startsWith('#') || /^data:/i.test(ref)) continue;
      if (EXTERNAL.test(ref)) offenders.push(`${path.relative(PUBLIC_DIR, file)}: ${ref}`);
    }
  }
  assert.deepEqual(offenders, [],
    '页面必须自己带依赖（第三方资源放 public/vendor/ 并在 README.md 里记来源与指纹）');
});

test('every asset the pages ask for exists in the repository', () => {
  const missing = [];
  let checked = 0;
  for (const file of SERVED) {
    for (const ref of assetRefs(file)) {
      if (ref.startsWith('#') || /^(?:data|mailto|tel|javascript):/i.test(ref)) continue;
      if (EXTERNAL.test(ref) || !FILE_REF.test(ref)) continue;
      checked += 1;
      if (!fs.existsSync(resolveRef(file, ref))) missing.push(`${path.relative(PUBLIC_DIR, file)}: ${ref}`);
    }
  }
  assert.ok(checked > 100, `这条锁要真的扫到东西（现在只数到 ${checked} 个引用）`);
  assert.deepEqual(missing, [], '页面点名的资源必须真的在仓库里 —— 路径写错和 CDN 打不开一样是白屏');
});

// 收进 public/vendor/ 的第三方文件：官方字节的指纹 + 许可证 + 来源说明。
// 升级到新版本时重新下载，然后把这里的版本号、指纹和 README.md 一起改掉。
const VENDORED = [
  { name: 'dompurify', version: '3.2.6', license: 'Apache-2.0', files: {
    'purify.min.js': '89e1fa7647cb495370d3a997ace4387f5d15d9f4c5af12352c53daa400956287',
    'purify.min.js.map': '7b84044ac434c25404177624d4a1d54e8b2078386339e11bc46db8f97ad7c1ad',
    LICENSE: '1b02e03c3fb4f87d476c128f0eb9def1f5a1709d28b180465228bd41574623b7',
  } },
  { name: 'marked', version: '12.0.1', license: 'MIT', files: {
    'marked.min.js': 'cb4cf2efefd2b1f602bf2f27d594fc0a26340d2661b60cddfcaac7a7b9261886',
    'LICENSE.md': '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c',
  } },
  // highlight.js 的浏览器包只在官方 cdn-release 仓库里发（npm 上的 @highlightjs/cdn-release
  // 取不到），所以路径是 jsdelivr 的 /gh/highlightjs/cdn-release@11.9.0/build/ 那一支。
  { name: 'highlight.js', version: '11.9.0', license: 'BSD-3-Clause', files: {
    'highlight.min.js': '837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846',
    'github-dark.min.css': '9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019',
    LICENSE: '6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490',
  } },
  { name: 'xterm', version: '5.3.0', license: 'MIT', files: {
    'xterm.js': 'f0aea0f75f48559013ae6643c2479dd737d26da42d5524e6d2b70915ae6523c7',
    'xterm.css': '832f3f2c603b43ad4351ff04970150cc7a873014276db126a6065c6dd81e4872',
    LICENSE: 'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd',
  } },
  { name: 'xterm-addon-fit', version: '0.8.0', license: 'MIT', files: {
    'xterm-addon-fit.js': '10f3194c5f17c1786fb7d5db865c1ec8539b6736a318063fd38bdaaf7c46848f',
    LICENSE: 'e256f01188af527e4d06d21d06fbf785ae9c50d4b328bf03cbe0ba7f0aa4228f',
  } },
  { name: 'xterm-addon-web-links', version: '0.9.0', license: 'MIT', files: {
    'xterm-addon-web-links.js': 'd67624ab0e89e1d2ee27b64cc6e9283f4ce206d7343429d87d95370b0c971824',
    LICENSE: '689ceb10716bd7a87a804c14951d7c2b818cbd60aab83d540902470ce3b13444',
  } },
];

test('vendored libraries match the recorded upstream bytes and carry provenance', () => {
  for (const library of VENDORED) {
    const directory = path.join(PUBLIC_DIR, 'vendor', library.name);
    assert.ok(fs.existsSync(directory), `public/vendor/${library.name} 要在仓库里`);
    for (const [file, expected] of Object.entries(library.files)) {
      const target = path.join(directory, file);
      assert.ok(fs.existsSync(target), `缺文件：public/vendor/${library.name}/${file}`);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      assert.equal(actual, expected,
        `public/vendor/${library.name}/${file} 与记录的官方字节不一致 —— 换版本要连指纹一起改`);
    }
    const readme = path.join(directory, 'README.md');
    assert.ok(fs.existsSync(readme), `public/vendor/${library.name}/README.md 要说明来源（升级时照着它重新下载）`);
    const provenance = fs.readFileSync(readme, 'utf8');
    assert.match(provenance, new RegExp(`\\b${library.version.replace(/\./g, '\\.')}\\b`),
      `README.md 要写明版本 ${library.version}`);
    assert.match(provenance, new RegExp(`\\b${library.license}\\b`), `README.md 要写明许可证 ${library.license}`);
    assert.match(provenance, /npm|cdn-release|jsdelivr/i, 'README.md 要写明上游来源');
  }
});
