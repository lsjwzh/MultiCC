#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'governance', 'repository-artifact-baseline.json');
const LARGE_BINARY_BYTES = 1024 * 1024;

const RUNTIME_BASENAMES = new Set([
  'sessions.json', 'directories.json', 'scheduled_tasks.json', 'shares.json',
  'aux-config.json', 'goal-config.json', 'notes.json', 'push_subscriptions.json',
  'token_usage.json', 'token_daily.json', 'token_by_role.json', 'providers.json',
  'provider-defaults.json', 'voice_examples.json', 'whisper_vocab.json',
  'tunnel-config.json', 'orchestration.json',
]);

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function scanTrackedEntry(relativePath, buffer) {
  const normalized = relativePath.split(path.sep).join('/');
  const basename = path.posix.basename(normalized);
  const categories = new Set();
  const binary = isBinary(buffer);

  if (/\.apk$/i.test(normalized)) categories.add('tracked-apk');
  if (/(?:\.bak(?:\.|$)|\.orig$|\.rej$|~$)/i.test(basename)) categories.add('backup');
  if (RUNTIME_BASENAMES.has(basename) || /^(?:chat_history|events|logs|memories|\.journal)\//.test(normalized)) {
    categories.add('runtime-state');
  }
  if (normalized === '.arch-review-findings.json' || normalized === 'classify-test-cases.json' ||
      /(?:^|\/)(?:npm-)?audit(?:[-_.].*)?\.(?:json|txt|log)$/i.test(normalized)) {
    categories.add('raw-audit-dump');
  }
  if (/^(?:\.env(?:\..*)?|credentials?\.json|auth\.json|id_rsa|.*\.(?:pem|key))$/i.test(basename)) {
    categories.add('credential-file');
  }
  if (binary && buffer.length > LARGE_BINARY_BYTES) categories.add('large-binary');

  if (!binary) {
    const text = buffer.toString('utf8');
    if (HIGH_CONFIDENCE_SECRET_PATTERNS.some(pattern => pattern.test(text))) {
      categories.add('credential-content');
      if (/^(?:tests?|testdata|fixtures?)\//i.test(normalized) || /\/(?:fixtures?|testdata)\//i.test(normalized)) {
        categories.add('sensitive-fixture');
      }
    }
  }
  if (/^(?:tests?|testdata|fixtures?)\//i.test(normalized) && binary && buffer.length > 256 * 1024) {
    categories.add('sensitive-fixture');
  }
  return [...categories].sort();
}

function normalizeBaseline(value) {
  const accepted = new Set();
  for (const [category, paths] of Object.entries((value && value.accepted) || {})) {
    if (!Array.isArray(paths)) throw new TypeError(`baseline ${category} must be an array`);
    for (const file of paths) accepted.add(`${category}:${file}`);
  }
  return accepted;
}

function evaluatePolicy(entries, baseline) {
  const found = new Set();
  for (const entry of entries) {
    for (const category of scanTrackedEntry(entry.path, entry.buffer)) {
      found.add(`${category}:${entry.path}`);
    }
  }
  const accepted = normalizeBaseline(baseline);
  return {
    found,
    unexpected: [...found].filter(item => !accepted.has(item)).sort(),
    stale: [...accepted].filter(item => !found.has(item)).sort(),
  };
}

function trackedEntries(root = ROOT) {
  const output = childProcess.execFileSync('git', ['ls-files', '-z'], { cwd: root });
  const files = output.toString('utf8').split('\0').filter(Boolean);
  return files.map(relativePath => ({
    path: relativePath,
    buffer: fs.readFileSync(path.join(root, relativePath)),
  }));
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const result = evaluatePolicy(trackedEntries(), baseline);
  if (result.unexpected.length || result.stale.length) {
    if (result.unexpected.length) {
      console.error('Repository artifact policy rejected new tracked content:');
      for (const item of result.unexpected) console.error(`  + ${item}`);
    }
    if (result.stale.length) {
      console.error('Repository artifact baseline is stale; update it with the same reviewed migration:');
      for (const item of result.stale) console.error(`  - ${item}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Repository artifact governance OK (${result.found.size} reviewed baseline finding(s))`);
}

if (require.main === module) main();

module.exports = {
  HIGH_CONFIDENCE_SECRET_PATTERNS,
  LARGE_BINARY_BYTES,
  RUNTIME_BASENAMES,
  evaluatePolicy,
  isBinary,
  normalizeBaseline,
  scanTrackedEntry,
  trackedEntries,
};
