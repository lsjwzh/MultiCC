'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'tests', 'test-tiers.json');
const packageJson = require(path.join(ROOT, 'package.json'));
const scripts = packageJson.scripts || {};
const NON_CORE_LANES = new Set(['cdp', 'device', 'live', 'smoke']);

function walk(relativeDir, files = []) {
  const absoluteDir = path.join(ROOT, relativeDir);
  if (!fs.existsSync(absoluteDir)) return files;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) walk(relative, files);
    else files.push(relative);
  }
  return files;
}

function directTestPaths(command) {
  return [...String(command || '').matchAll(/(?:^|\s)(tests\/[A-Za-z0-9_.\/-]+\.js)(?=\s|$)/g)]
    .map(match => match[1]);
}

function nestedScripts(command) {
  return [...String(command || '').matchAll(/npm run ([A-Za-z0-9:_-]+)/g)]
    .map(match => match[1]);
}

function expandScript(name, visiting = new Set()) {
  if (visiting.has(name)) return new Set();
  const next = new Set(visiting);
  next.add(name);
  const command = scripts[name] || '';
  const paths = new Set(directTestPaths(command));
  for (const nested of nestedScripts(command)) {
    for (const testPath of expandScript(nested, next)) paths.add(testPath);
  }
  return paths;
}

function discoverTests() {
  const nodeTests = walk('tests')
    .filter(file => /^test.*\.js$/.test(path.posix.basename(file)) || file === 'tests/smoke-core.js');
  const flutterTests = walk('app/test').filter(file => file.endsWith('_test.dart'));
  const deviceTests = walk('app/integration_test').filter(file => file.endsWith('_test.dart'));
  return [...nodeTests, ...flutterTests, ...deviceTests].sort((left, right) => left.localeCompare(right));
}

function fail(errors, message) {
  errors.push(message);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  console.error(`test tier manifest is unreadable: ${error.message}`);
  process.exit(1);
}

const errors = [];
const tiers = new Set(Object.keys(manifest.tiers || {}));
const lanes = new Set(Object.keys(manifest.lanes || {}));
if (manifest.schemaVersion !== 1) fail(errors, `unsupported schemaVersion ${manifest.schemaVersion}`);
if (![...['core', 'flow', 'other']].every(tier => tiers.has(tier))) {
  fail(errors, 'tiers must define core, flow, and other');
}
if (!Array.isArray(manifest.tests)) fail(errors, 'tests must be an array');

const entries = Array.isArray(manifest.tests) ? manifest.tests : [];
const byPath = new Map();
let previousPath = '';
for (const [index, entry] of entries.entries()) {
  const prefix = `tests[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(errors, `${prefix} must be an object`);
    continue;
  }
  if (typeof entry.path !== 'string' || !entry.path) {
    fail(errors, `${prefix}.path must be a non-empty string`);
    continue;
  }
  if (byPath.has(entry.path)) fail(errors, `${entry.path} appears more than once`);
  else byPath.set(entry.path, entry);
  if (previousPath && previousPath.localeCompare(entry.path) > 0) {
    fail(errors, `${entry.path} is out of order (manifest paths must stay sorted)`);
  }
  previousPath = entry.path;
  if (!tiers.has(entry.tier)) fail(errors, `${entry.path} has invalid tier ${entry.tier}`);
  if (!lanes.has(entry.lane)) fail(errors, `${entry.path} has invalid lane ${entry.lane}`);
  if (!fs.existsSync(path.join(ROOT, entry.path))) fail(errors, `${entry.path} does not exist`);

  if (entry.tier === 'core' && NON_CORE_LANES.has(entry.lane)) {
    fail(errors, `${entry.path} uses ${entry.lane}, which cannot be a core release mechanism lane`);
  }
  if (entry.tier === 'core' && entry.lane === 'flutter') {
    const source = fs.readFileSync(path.join(ROOT, entry.path), 'utf8');
    const hasWidgetTest = /\btestWidgets\s*\(/.test(source);
    const importsFlutterUi = /package:flutter\/(?:material|widgets)\.dart/.test(source);
    const importsAppUi = /\/(?:screens|widgets)\//.test(source);
    if (hasWidgetTest || importsFlutterUi || importsAppUi) {
      fail(errors, `${entry.path} is UI-related and cannot be classified as core`);
    }
  }

  if (entry.owner != null) {
    if (typeof entry.owner !== 'string' || !entry.owner.startsWith('npm:')) {
      fail(errors, `${entry.path} owner must use npm:<script>`);
    } else {
      const script = entry.owner.slice(4);
      if (!scripts[script]) fail(errors, `${entry.path} owner script ${script} does not exist`);
      else if (!expandScript(script).has(entry.path)) {
        fail(errors, `${entry.path} is not reachable from owner script ${script}`);
      }
    }
  }

  if (entry.entrypoints != null) {
    if (!Array.isArray(entry.entrypoints) || entry.entrypoints.some(value => typeof value !== 'string')) {
      fail(errors, `${entry.path} entrypoints must be a string array`);
    } else if (new Set(entry.entrypoints).size !== entry.entrypoints.length) {
      fail(errors, `${entry.path} has duplicate entrypoints`);
    }
  }

  if (entry.variants != null) {
    if (!Array.isArray(entry.variants) || entry.variants.length === 0) {
      fail(errors, `${entry.path} variants must be a non-empty array`);
    } else {
      const ids = new Set();
      for (const variant of entry.variants) {
        if (!variant || typeof variant.id !== 'string' || !variant.id) {
          fail(errors, `${entry.path} has a variant without an id`);
          continue;
        }
        if (ids.has(variant.id)) fail(errors, `${entry.path} repeats variant ${variant.id}`);
        ids.add(variant.id);
        if (!Array.isArray(variant.args) || variant.args.some(value => typeof value !== 'string')) {
          fail(errors, `${entry.path} variant ${variant.id} args must be a string array`);
        }
      }
    }
  }
}

const discovered = discoverTests();
const discoveredSet = new Set(discovered);
for (const testPath of discovered) {
  if (!byPath.has(testPath)) fail(errors, `${testPath} is not classified`);
}
for (const testPath of byPath.keys()) {
  if (!discoveredSet.has(testPath)) fail(errors, `${testPath} is stale or is not an executable test candidate`);
}

if (errors.length) {
  console.error(`test tier manifest failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const counts = {};
for (const entry of entries) {
  counts[entry.tier] = (counts[entry.tier] || 0) + 1;
  counts[`${entry.tier}/${entry.lane}`] = (counts[`${entry.tier}/${entry.lane}`] || 0) + 1;
}
const nodeEntries = entries.filter(entry => entry.path.startsWith('tests/'));
const unwired = nodeEntries.filter(entry => !entry.entrypoints?.length);
console.log(`test tiers OK: ${entries.length} classified (${discovered.length} discovered)`);
for (const tier of ['core', 'flow', 'other']) {
  const label = manifest.tiers[tier]?.label || tier;
  console.log(`- ${tier} / ${label}: ${counts[tier] || 0}`);
  for (const lane of [...lanes]) {
    const count = counts[`${tier}/${lane}`] || 0;
    if (count) console.log(`  - ${lane}: ${count}`);
  }
}
console.log(`- Node tests without a package/docker entrypoint: ${unwired.length}`);

if (process.argv.includes('--list')) {
  const requested = process.argv[process.argv.indexOf('--list') + 1];
  if (requested && !tiers.has(requested) && !lanes.has(requested)) {
    console.error(`unknown tier/lane for --list: ${requested}`);
    process.exit(2);
  }
  for (const entry of entries) {
    if (requested && entry.tier !== requested && entry.lane !== requested) continue;
    const wired = entry.entrypoints?.join(',') || '-';
    console.log(`${entry.tier}\t${entry.lane}\t${entry.path}\t${wired}`);
  }
}
