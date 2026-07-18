'use strict';

// Keep the retired WebCC brand out of runtime/source UI. The two upgrade
// guides are intentionally allow-listed because users still need the old
// persistence keys, package ids, and service names to migrate safely.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWED_MIGRATION_DOCS = new Set(['README.md', 'app/README.md']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.md',
  '.json', '.yml', '.yaml', '.toml', '.sh', '.zsh', '.xml', '.plist',
  '.gradle', '.properties', '.txt', '.env', '.example', '.svg',
]);
const RETIRED_BRAND = [
  /webcc/i,
  /web[\s_-]+cc/i,
  /web\s*<[^>\n]*>\s*cc/i,
  /com\.webcc/i,
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const hits = [];

for (const file of files) {
  if (ALLOWED_MIGRATION_DOCS.has(file)) continue;
  const absolute = path.join(ROOT, file);
  let bytes;
  try { bytes = fs.readFileSync(absolute); } catch (_) { continue; }
  const extension = path.extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').replaceAll('\0', '\\0').split('\n');
  lines.forEach((line, index) => {
    if (RETIRED_BRAND.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    })) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 240)}`);
  });
}

assert.deepStrictEqual(hits, [], `retired WebCC branding remains:\n${hits.join('\n')}`);
console.log(`branding audit passed (${files.length} tracked files; migration docs allow-listed)`);
