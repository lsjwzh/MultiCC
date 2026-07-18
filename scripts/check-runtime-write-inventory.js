#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_FILE = path.join(ROOT, 'governance', 'runtime-write-inventory.json');
const CLASSIFICATIONS = new Set([
  'migration-required', 'external-owner', 'workspace-scoped', 'ephemeral', 'compatibility-read',
]);

const RISKY_ROOT_PATTERNS = [
  /path\.join\([^\n]*homedir\(\)[^\n]*['"]\.multicc['"]/,
  /\$HOME\/\.multicc\//,
  /path\.join\(__dirname,\s*['"](?:\.env|memories|scheduled_tasks\.json)['"]\)/,
];

function productionFiles(root = ROOT) {
  const output = childProcess.execFileSync('git', [
    'ls-files', '-z', 'server.js', 'src/**', 'plugins/**', 'scripts/**', 'skills/multicc-artifact/**',
  ], { cwd: root });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function riskyRootAnchors(root = ROOT) {
  const found = [];
  for (const file of productionFiles(root)) {
    let lines;
    try { lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/); }
    catch (_) { continue; }
    lines.forEach((line, index) => {
      if (RISKY_ROOT_PATTERNS.some(pattern => pattern.test(line))) {
        found.push({ file, line: index + 1, anchor: line.trim() });
      }
    });
  }
  return found;
}

function validateInventory(document, { root = ROOT } = {}) {
  const errors = [];
  const entries = document && Array.isArray(document.entries) ? document.entries : [];
  if (!document || document.version !== 1) errors.push('inventory.version must be 1');
  if (!entries.length) errors.push('inventory.entries must be non-empty');

  const ids = new Set();
  const anchors = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') { errors.push('inventory entry must be an object'); continue; }
    if (!entry.id || ids.has(entry.id)) errors.push(`invalid or duplicate inventory id: ${entry.id}`);
    ids.add(entry.id);
    if (!CLASSIFICATIONS.has(entry.classification)) errors.push(`${entry.id}: invalid classification`);
    if (!entry.owner || !entry.rationale || !entry.migrationStrategy) {
      errors.push(`${entry.id}: owner, rationale and migrationStrategy are required`);
    }
    if (!Array.isArray(entry.sources) || !entry.sources.length) {
      errors.push(`${entry.id}: sources must be non-empty`);
      continue;
    }
    for (const source of entry.sources) {
      const file = source && source.file;
      const anchor = source && source.anchor;
      const absolute = file && path.join(root, file);
      if (!file || !anchor || !fs.existsSync(absolute)) {
        errors.push(`${entry.id}: missing source ${file || '(none)'}`);
        continue;
      }
      const content = fs.readFileSync(absolute, 'utf8');
      if (!content.includes(anchor)) errors.push(`${entry.id}: stale anchor in ${file}`);
      anchors.add(`${file}:${anchor}`);
    }
  }

  for (const risk of riskyRootAnchors(root)) {
    if (!anchors.has(`${risk.file}:${risk.anchor}`)) {
      errors.push(`unclassified risky runtime root: ${risk.file}:${risk.line}`);
    }
  }
  return errors;
}

function main() {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const errors = validateInventory(inventory);
  if (errors.length) {
    console.error('Runtime write inventory validation failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Runtime write inventory OK (${inventory.entries.length} governed item(s))`);
}

if (require.main === module) main();

module.exports = { CLASSIFICATIONS, RISKY_ROOT_PATTERNS, productionFiles, riskyRootAnchors, validateInventory };
