#!/usr/bin/env node
'use strict';

// Run with node --expose-internals to use the parser shipped with the Node
// release being audited, without adding a runtime dependency or loading app code.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire, isBuiltin } = require('node:module');
const { parse } = require('internal/deps/acorn/acorn/dist/acorn');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const reachableTsv = process.argv[2] === '--reachable-tsv';
const output = process.argv[reachableTsv ? 3 : 2];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
}).split('\0').filter(file => /\.[cm]?js$/.test(file) && fs.existsSync(path.join(root, file)));
const productionSources = files.filter(file => file.startsWith('src/')).sort();
const toolEntries = new Map([
  ['scripts/task-workspace-inventory.js', '工作区运维脚本'],
  ['scripts/backtest-task-attribution.js', '归属离线回测'],
]);
const runtimeFiles = files.filter(file => file.startsWith('src/') || file === 'server.js' ||
  toolEntries.has(file) || file === 'ecosystem.config.js' || file === 'scripts/start-gateway.js' ||
  (file.startsWith('plugins/') && !/\/(?:test|tests|ui|extension)\//.test(file))).sort();
const visited = new Map();
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const listing = (values) => [...values].sort().map(value => '`' + value.replaceAll('|', '\\|').replaceAll('`', "'") + '`').join(', ') || '—';

function scan(file) {
  const filename = path.join(root, file);
  const source = fs.readFileSync(filename, 'utf8');
  const resolve = createRequire(filename).resolve;
  const local = new Set(), packages = new Set(), builtins = new Set(), dynamic = new Set();
  const scriptPaths = new Set();
  const loaders = new Set(['require']);
  const add = (arg, node, loader) => {
    const name = arg?.type === 'Literal' ? arg.value :
      arg?.type === 'TemplateLiteral' && !arg.expressions.length ? arg.quasis[0].value.cooked : undefined;
    if (typeof name !== 'string') {
      dynamic.add(String(node.loc.start.line) + ' ' + source.slice(node.start, node.end).split('\n')[0].slice(0, 100));
    } else if (isBuiltin(name)) builtins.add(name.replace(/^node:/, ''));
    else if (!name.startsWith('.')) packages.add(packageName(name));
    else if (loader && loader !== 'require') dynamic.add(node.loc.start.line + ' ' + source.slice(node.start, node.end));
    else {
      try { local.add(path.relative(root, resolve(name)).split(path.sep).join('/')); }
      catch { dynamic.add(String(node.loc.start.line) + ' unresolved ' + name); }
    }
  };
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: file.endsWith('.mjs') ? 'module' : 'script',
    allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
        node.init?.type === 'CallExpression') {
      const factory = node.init.callee;
      if (factory.name === 'createRequire' || factory.property?.name === 'createRequire') loaders.add(node.id.name);
    }
    if (node.type === 'CallExpression') {
      const fn = node.callee;
      if (loaders.has(fn.name)) add(node.arguments[0], node, fn.name);
      else if (fn.type === 'MemberExpression') {
        const owner = fn.object.name;
        if (loaders.has(owner) && fn.property.name === 'resolve') add(node.arguments[0], node, owner);
        else if (owner === 'module' && fn.property.name === 'require') add(node.arguments[0], node);
        // Child processes, worker_threads and CLI extensions receive paths as
        // data. Record literal paths separately from module imports.
        else if (owner === 'path' && ['join', 'resolve'].includes(fn.property.name) &&
            node.arguments[0]?.name === '__dirname' && node.arguments.length > 1 &&
            node.arguments.slice(1).every(arg => arg.type === 'Literal' && typeof arg.value === 'string')) {
          const candidate = path.resolve(path.dirname(filename), ...node.arguments.slice(1).map(arg => arg.value));
          if (/\.[cm]?js$/.test(candidate) && fs.existsSync(candidate)) {
            scriptPaths.add(path.relative(root, candidate).split(path.sep).join('/'));
          }
        }
      }
    } else if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration' ||
        (node.type.startsWith('Export') && node.source)) add(node.source, node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child?.type) walk(child);
    }
  }
  walk(ast);
  return { local, packages, builtins, dynamic, scriptPaths };
}
for (const file of runtimeFiles) visited.set(file, scan(file));

function closure(entry, includeScriptPaths = false) {
  const reached = new Set();
  function visit(file) {
    if (reached.has(file)) return;
    reached.add(file);
    const scan = visited.get(file);
    if (!scan) return;
    for (const dependency of scan.local) visit(dependency);
    if (includeScriptPaths) for (const script of scan.scriptPaths) visit(script);
  }
  visit(entry);
  return reached;
}
const fromServer = closure('server.js');
const fromServerPaths = closure('server.js', true);
// Use the same AST edges as the module report. A final unterminated line is
// still a physical line; an empty file has zero lines.
if (reachableTsv) {
  const callers = new Map([...fromServerPaths]
    .filter(file => file === 'server.js' || /^(?:src|plugins)\/.*\.[cm]?js$/.test(file))
    .sort().map(file => [file, new Set()]));
  for (const caller of fromServerPaths) {
    const edges = visited.get(caller);
    if (!edges) continue;
    for (const target of [...edges.local, ...edges.scriptPaths]) callers.get(target)?.add(caller);
  }
  const rows = ['文件\t物理行数\t可达调用方'];
  for (const [file, imports] of callers) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = source.split('\n').length - Number(!source || source.endsWith('\n'));
    rows.push([file, lines, [...imports].sort().join(',') || '—'].join('\t'));
  }
  const result = rows.join('\n') + '\n';
  if (output) fs.writeFileSync(output, result);
  else process.stdout.write(result);
  return;
}
const toolReach = [...toolEntries].map(([file, label]) => [label, closure(file, true)]);
const pluginReach = new Set(runtimeFiles.filter(file => file.startsWith('plugins/')).flatMap(file => [...closure(file, true)]));
const dependencies = Object.entries(manifest.dependencies || {}).sort(([a], [b]) => a.localeCompare(b));
const lanes = Object.fromEntries(['js', 'cjs', 'mjs'].map(ext =>
  [ext, productionSources.filter(file => file.endsWith('.' + ext)).length]));
const note = [
  '# Node 后端模块与运行依赖', '',
  '默认生产服务使用 Cargo 构建的网关。部署目录中的后端 JavaScript 和 Node 运行依赖计数见[生产清单](remaining-node-checklist.md)。下表统计显式兼容宿主及其工具。', '',
  '运行 `node --expose-internals scripts/inventory-node-backend.js docs/rust-migration/node-module-dependencies.md` 重建。',
  '统计工作树中 Git 跟踪和未忽略的新文件。下表逐项列出 src 中的模块，含薄桥和离线工具。入口栏标示从 server.js 递归追踪字面量 import、require、require.resolve 及其 createRequire 别名的结果。脚本路径列另列 path.join/resolve(__dirname, 字面量) 指向的文件，包含 worker 与子进程。条件分支按可能加载计；运行时注入依赖仍需结合具体部署核验。动态表达式附行号。', '',
  '当前 src 中有 ' + lanes.js + ' 个 .js、' + lanes.cjs + ' 个 .cjs、' + lanes.mjs + ' 个 .mjs。根包有 ' + dependencies.length + ' 个直接运行依赖。', '',
  '## 根包运行依赖', '',
  '兼容宿主打包路径与根 npm 包独立。下表只统计根包 dependencies。开发依赖与桌面包中的宿主仍应分别审计。', '',
  '兼容宿主的 Claude 引擎由 `@anthropic-ai/claude-agent-sdk` 的平台可选包提供二进制，解析入口为 `native/core/src/claude_models.rs`。CPR 的传递依赖（包括 `@iarna/toml`）保留在 package-lock.json 中。', '',
  '| 包 | 声明版本 | 直接引用（server.js、src、启动入口、生产插件） |', '|---|---|---|',
  ...dependencies.map(([name, version]) => '| ' + listing([name]) + ' | ' + listing([version]) + ' | ' +
    listing(runtimeFiles.filter(file => visited.get(file).packages.has(name))) + ' |'),
  '', '## src 模块', '',
  '| 文件 | 入口 | 本地直接依赖 | 本地脚本路径 | Node 内置模块 | 外部包 | 动态或未解析 |', '|---|---|---|---|---|---|---|',
  ...productionSources.map(file => {
    const { local, builtins, packages, dynamic, scriptPaths } = visited.get(file);
    const tool = toolReach.find(([, reach]) => reach.has(file));
    const entry = fromServer.has(file) ? 'server.js' : fromServerPaths.has(file) ? '宿主脚本路径' :
      pluginReach.has(file) ? '插件' : tool ? tool[0] : '未从已知入口静态到达';
    return '| ' + [listing([file]), entry, listing(local), listing(scriptPaths), listing(builtins), listing(packages), listing(dynamic)].join(' | ') + ' |';
  }), '',
];
if (output) fs.writeFileSync(output, note.join('\n'));
else process.stdout.write(note.join('\n'));
