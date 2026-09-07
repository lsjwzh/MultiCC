#!/usr/bin/env node
'use strict';
// One-shot directory regroup helper for the P2 migration. NOT a permanent
// repo tool — delete after the regroup lands.
// Usage: node scripts/tmp-move-group.js <mapping.json>
// mapping.json: { "src/wait-service.js": "src/wait/service.js", ... }
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const mapping = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Candidate files whose require() calls we rewrite: all tracked + untracked js/json at repo root scopes.
function listJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.dart_tool' || e.name === 'build') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, acc);
    else if (/\.(js|mjs|cjs|json|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const files = [...listJs(path.join(root, 'src')), ...listJs(path.join(root, 'tests')), ...listJs(path.join(root, 'scripts')),
  ...listJs(path.join(root, 'plugins')), ...listJs(path.join(root, 'desktop')), ...listJs(path.join(root, 'vendor')),
  path.join(root, 'server.js'), path.join(root, 'package.json')].filter(p => fs.existsSync(p));

function relSpec(fromFile, targetNoExt) {
  const rel = path.relative(path.dirname(fromFile), path.join(root, targetNoExt));
  const norm = rel.split(path.sep).join('/');
  return norm.startsWith('.') ? norm : './' + norm;
}

// Pre-compute spec rewrites per referencing file.
const rewrites = new Map(); // file -> Map(oldSpec -> newSpec)
const stripExt = p => p.replace(/\.js$/, '');
for (const [oldNoExt, newNoExt] of Object.entries(Object.fromEntries(
  Object.entries(mapping).map(([k, v]) => [stripExt(k), stripExt(v)])
))) {
  for (const f of files) {
    const oldSpec = relSpec(f, oldNoExt);
    const newSpec = relSpec(f, newNoExt);
    let m = rewrites.get(f);
    if (!m) { m = new Map(); rewrites.set(f, m); }
    m.set(oldSpec, newSpec);
    // Also cover the explicit .js-suffixed require form (require('../src/x.js')).
    if (oldNoExt.endsWith('/index')) continue;
    m.set(oldSpec + '.js', newSpec + '.js');
  }
}

let total = 0;
for (const [f, specMap] of rewrites) {
  let src = fs.readFileSync(f, 'utf8');
  let changed = false;
  for (const [oldSpec, newSpec] of specMap) {
    const esc = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // require('spec') / require("spec") only.
    const re = new RegExp(`require\\((['"])${esc}\\1\\)`, 'g');
    if (re.test(src)) { src = src.replace(re, `require($1${newSpec}$1)`); changed = true; }
  }
  if (changed) { fs.writeFileSync(f, src); total++; }
}

for (const [from, to] of Object.entries(mapping)) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'inherit' });
}

// Rewrite the moved files' own outbound relative requires: resolve each spec
// against the OLD location, map through the move table, re-express relative to
// the NEW location.
const absMap = new Map(Object.entries(mapping).map(([k, v]) => [path.join(root, k), path.join(root, v)]));
function resolveModule(baseDir, spec) {
  const p = path.resolve(baseDir, spec);
  for (const cand of [p, `${p}.js`, path.join(p, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}
let selfFixed = 0;
for (const [from, to] of Object.entries(mapping)) {
  const file = path.join(root, to);
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  src = src.replace(/require\((['"])(\.[^'"]*)\1\)/g, (whole, q, spec) => {
    const target = resolveModule(path.dirname(path.join(root, from)), spec);
    if (!target) return whole;
    const mapped = absMap.get(target) || target;
    let rel = path.relative(path.dirname(file), mapped).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    rel = rel.replace(/\.js$/, '');
    return `require(${q}${rel}${q})`;
  });
  if (src !== before) { fs.writeFileSync(file, src); selfFixed++; }
}

console.log(`moved ${Object.keys(mapping).length} files, rewrote requires in ${total} files, fixed outbound requires in ${selfFixed} moved files`);
