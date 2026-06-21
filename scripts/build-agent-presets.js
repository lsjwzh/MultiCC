#!/usr/bin/env node
'use strict';

// Build public/agent-presets.json from the open-source agency-agents repo.
// Source: github.com/msitarzewski/agency-agents (MIT). 232+ role .md files,
// grouped by "division" folders. Each .md has YAML frontmatter (name,
// description, color, emoji, vibe) wrapped in `---`, followed by the system
// prompt body.
//
// CommonJS, no extra deps. We parse frontmatter with a tiny hand-rolled parser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO_URL = 'https://github.com/msitarzewski/agency-agents.git';
const OUT_PATH = path.join(__dirname, '..', 'public', 'agent-presets.json');

// Top-level folders that are NOT role divisions.
const SKIP_DIRS = new Set([
  'scripts', 'integrations', 'examples', 'strategy', '.git', '.github',
  'node_modules', 'docs', 'assets', '.idea', '.vscode',
]);

function log(...args) { console.log('[build-agent-presets]', ...args); }

// Recursively collect *.md files under a directory (skipping README).
function collectMd(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectMd(full));
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      if (ent.name.toLowerCase() === 'readme.md') continue;
      out.push(full);
    }
  }
  return out;
}

// Minimal frontmatter parser: returns { meta, body }.
function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  // Must start with a `---` line.
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!fmMatch) {
    return { meta: {}, body: text.trim() };
  }
  const block = fmMatch[1];
  const body = text.slice(fmMatch[0].length).trim();
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return { meta, body };
}

function labelize(key) {
  return key
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-agents-'));
  log('temp dir:', tmpRoot);

  let commit = 'unknown';
  try {
    log('cloning', REPO_URL, '...');
    execSync(`git clone --depth 1 ${REPO_URL} ${JSON.stringify(tmpRoot)}`, {
      stdio: 'inherit',
    });
    commit = execSync('git rev-parse --short HEAD', { cwd: tmpRoot })
      .toString().trim();
    log('cloned at commit', commit);

    // Enumerate top-level division folders.
    const topEntries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    const divisions = topEntries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map(e => e.name)
      .sort();
    log('divisions:', divisions.join(', '));

    const presets = [];
    const categoryCounts = {};

    for (const division of divisions) {
      const divDir = path.join(tmpRoot, division);
      const mdFiles = collectMd(divDir);
      let added = 0;
      for (const file of mdFiles) {
        const raw = fs.readFileSync(file, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const baseName = path.basename(file, path.extname(file));
        const id = `${division}__${baseName}`;
        const name = (meta.name && meta.name.trim()) || labelize(baseName);
        presets.push({
          id,
          name,
          description: meta.description || '',
          category: division,
          color: meta.color || '',
          emoji: meta.emoji || '',
          vibe: meta.vibe || '',
          prompt: body,
        });
        added++;
      }
      if (added > 0) categoryCounts[division] = added;
      log(`  ${division}: ${added} presets`);
    }

    // Guard against accidental duplicate ids.
    const seen = new Set();
    for (const p of presets) {
      if (seen.has(p.id)) log('WARNING duplicate id:', p.id);
      seen.add(p.id);
    }

    const categories = Object.keys(categoryCounts).sort().map(key => ({
      key,
      label: labelize(key),
      count: categoryCounts[key],
    }));

    // Featured: fuzzy-match common roles by name, optionally preferring a category.
    const featuredWanted = [
      { patterns: [/frontend\s*developer/i] },
      { patterns: [/backend\s*architect/i] },
      { patterns: [/ui\s*designer/i, /ux/i], category: 'design' },
      { patterns: [/qa/i, /test/i], category: 'testing' },
      { patterns: [/security/i] },
      { patterns: [/product\s*manager/i] },
      { patterns: [/devops/i] },
      { patterns: [/technical\s*writer/i, /\bdocs?\b/i] },
    ];
    const featured = [];
    const usedIds = new Set();
    for (const { patterns, category } of featuredWanted) {
      const hit = (p) => !usedIds.has(p.id) && patterns.some(re => re.test(p.name));
      // Prefer a match inside the wanted category, then fall back to any category.
      const match = (category && presets.find(p => p.category === category && hit(p)))
        || presets.find(hit);
      if (match) {
        featured.push(match.id);
        usedIds.add(match.id);
      }
    }
    // Pad up to 8 with leading presets if matches fell short.
    for (const p of presets) {
      if (featured.length >= 8) break;
      if (!usedIds.has(p.id)) {
        featured.push(p.id);
        usedIds.add(p.id);
      }
    }
    const featuredFinal = featured.slice(0, 8);

    const output = {
      source: 'github.com/msitarzewski/agency-agents',
      version: commit,
      generatedAt: new Date().toISOString(),
      categories,
      featured: featuredFinal,
      presets,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
    log('wrote', OUT_PATH);
    log('STATS: presets =', presets.length, '| categories =', categories.length);
    log('featured:', featuredFinal.join(', '));
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      log('cleaned temp dir');
    } catch (e) {
      log('cleanup failed:', e.message);
    }
  }
}

main();
