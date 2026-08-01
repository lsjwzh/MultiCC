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

function defaultModelForPreset(preset) {
  const id = String(preset.id || '').toLowerCase();
  const cat = String(preset.category || '').toLowerCase();
  const name = String(preset.name || '').toLowerCase();
  const desc = String(preset.description || '').toLowerCase();
  const text = [id, cat, name, desc].join(' ');
  const has = (re) => re.test(text);
  const openai = (model = 'gpt-5.5', effort = 'xhigh', note = 'high-judgment or high-risk role') => ({
    defaultCli: 'codex',
    defaultProviderKey: 'openai-codex',
    defaultModel: model,
    defaultEffort: effort,
    defaultModelNote: note,
  });
  const xf = (model, effort = 'xhigh', note = 'provider-routed specialist role') => ({
    defaultCli: 'codex',
    defaultProviderKey: 'xf-maas-coding',
    defaultModel: model,
    defaultEffort: effort,
    defaultModelNote: note,
  });

  if (id === 'specialized__agent-commander') {
    return openai('gpt-5.5', 'xhigh', 'fleet commander; needs strongest planning, routing and QA judgment');
  }
  if (has(/security|appsec|privacy|compliance|legal|law|healthcare|medical|hospital|patient|tax|investment|financial|finance|cfo|chief financial|loan|billing|government|classified|cryptographic|incident|sre|reliability|production|accessibility|reality checker|evidence collector|model qa|smart contract|solidity|civil engineer|structural/)) {
    return openai('gpt-5.5', 'xhigh', 'high-risk domain; prefer GPT for judgment and final correctness');
  }
  if (cat === 'academic') return xf('xopglm52', 'xhigh', 'research and writing role');
  if (cat === 'finance') return openai('gpt-5.5', 'xhigh', 'finance role; prefer strongest judgment');
  if (cat === 'marketing' || cat === 'paid-media' || cat === 'sales') {
    return xf('xopglm52', 'xhigh', 'business writing and outreach role');
  }
  if (cat === 'product' || cat === 'project-management') {
    return openai('gpt-5.5', 'xhigh', 'product/project role; planning and tradeoff quality matter');
  }
  if (cat === 'design') {
    if (has(/ui designer|ux architect|ux researcher|persona walkthrough/)) {
      return openai('gpt-5.4', 'high', 'design judgment role; use GPT balanced high reasoning');
    }
    return xf('xopglm52', 'xhigh', 'visual/brand creative role');
  }
  if (cat === 'engineering') {
    if (has(/technical writer|prompt engineer|email intelligence|codebase onboarding/)) {
      return xf('xopglm52', 'xhigh', 'documentation/research-oriented engineering support');
    }
    if (has(/code reviewer|minimal change|backend architect|software architect|database optimizer|multi-agent systems architect/)) {
      return openai('gpt-5.5', 'xhigh', 'engineering review/architecture role; needs conservative judgment');
    }
    return xf('xopdeepseekv4pro', 'xhigh', 'coding implementation role; DeepSeek V4 Pro is the default code worker');
  }
  if (cat === 'testing') {
    if (has(/api|performance|test results|tool evaluator|workflow optimizer/)) {
      return xf('xopdeepseekv4pro', 'xhigh', 'technical QA execution role');
    }
    return openai('gpt-5.5', 'xhigh', 'QA judgment role; needs strict evidence and risk assessment');
  }
  if (cat === 'game-development') {
    if (has(/engineer|developer|scripter|shader|addon|multiplayer|unity|unreal|godot|roblox|blender|audio/)) {
      return xf('xopdeepseekv4pro', 'xhigh', 'game technical implementation role');
    }
    return xf('xopglm52', 'xhigh', 'game design/narrative role');
  }
  if (cat === 'gis' || cat === 'spatial-computing') {
    if (has(/engineer|developer|data|pipeline|gis|arcgis|qgis|spatial|geospatial|mapping/)) {
      return xf('xopdeepseekv4pro', 'xhigh', 'spatial/GIS technical role');
    }
    return xf('xopglm52', 'xhigh', 'spatial planning/research role');
  }
  if (cat === 'support') {
    if (has(/legal|compliance|finance|infrastructure/)) {
      return openai('gpt-5.5', 'xhigh', 'support role with risk/compliance impact');
    }
    return xf('xopglm52', 'xhigh', 'support writing and operations role');
  }
  if (cat === 'specialized') {
    if (has(/data extraction|data consolidation|report distribution|identity graph|lsp|index|mcp builder|document generator|salesforce/)) {
      return xf('xopdeepseekv4pro', 'xhigh', 'technical specialized role');
    }
    if (has(/translator|customer|hospitality|retail|hr|recruitment|study abroad|personal growth|grant writer|training|developer advocate|cultural|french|korean|zk steward|language/)) {
      return xf('xopglm52', 'xhigh', 'communication/research specialized role');
    }
    if (has(/architect|architecture|chief of staff|strategy|strategist|operations manager|workflow architect|business model|pricing analyst|ma integration|m&a|change management|organizational psychologist|supply chain/)) {
      return openai('gpt-5.5', 'xhigh', 'specialized advisory role; default to strongest judgment');
    }
    return xf('xopglm52', 'xhigh', 'general specialized role');
  }
  if (has(/architect|architecture|commander|strategy|strategist|business model/)) {
    return openai('gpt-5.5', 'xhigh', 'cross-system planning and decision quality matter most');
  }
  return xf('xopglm52', 'xhigh', 'general role default');
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
        const preset = {
          id,
          name,
          description: meta.description || '',
          category: division,
          color: meta.color || '',
          emoji: meta.emoji || '',
          vibe: meta.vibe || '',
          prompt: body,
        };
        presets.push({ ...preset, ...defaultModelForPreset(preset) });
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
