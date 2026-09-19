'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../task-shell/context');
const { relevance } = require('../context/selection');
const { scanMemoryContent } = require('../memory-store');
const { BUILTIN_RULES, DOCS_REGISTRY_RULE, DOCS_REGISTRY_RULE_MARKER, SECRET_VAULT_RULE, SECRET_VAULT_RULE_MARKER } = require('./builtin-rules');
const BUILTIN_MARKERS = BUILTIN_RULES.map(({ marker }) => marker);

// Read only the caller's scopes. Never follow symlinks into another scope.
function safeFiles(root, folder, diagnostics) {
  if (!folder) return [];
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (error) {
    if (error.code !== 'ENOENT') diagnostics.push({ path: root, reason: error.message });
    return [];
  }
  const relative = path.relative(root, folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];
  try {
    let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return [];
    }
    if (!fs.realpathSync(folder).startsWith(realRoot + path.sep)) return [];
    return fs.readdirSync(folder).filter(name => /\.md$/i.test(name)).sort().flatMap(name => {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      if (!stat.isFile()) return [];
      if (stat.size > 1024 * 1024) { diagnostics.push({ path: file, reason: 'file_too_large' }); return []; }
      return [{ file, name, text: fs.readFileSync(file, 'utf8') }];
    });
  } catch (error) {
    if (error.code !== 'ENOENT') diagnostics.push({ path: folder, reason: error.message });
    return [];
  }
}
function chunks(text) {
  // Curated facts are delimited by §; other documents use paragraphs/list items.
  return text.split(/\n§\n|\n\s*\n|\n(?=- \[)/).map(s => s.trim()).filter(s => s && !/^#+[^\n]*$/.test(s)
    && !s.includes('（暂无内容）'));
}
function retrieveMemory(root, folders, persisted, query) {
  const diagnostics = [], inventory = [];
  const taskId = persisted.taskBoundTaskId || persisted.taskState?.taskId;
  const scopes = [
    ['machine', folders.machineDir()], ['cli', folders.cliDir(persisted.cli)],
    ['shared', folders.sharedDir(persisted.dirId)], ['task', folders.taskDir(persisted.dirId, taskId)],
    ['own', folders.sessionDir(persisted)],
  ];
  const skillsRoot = path.join(root, String(persisted.dirId), 'skills');
  try {
    if (!fs.lstatSync(skillsRoot).isSymbolicLink()) for (const dir of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (dir.isDirectory() && folders.safeSegment(dir.name)) scopes.push(['skill', folders.skillDir(persisted.dirId, dir.name), dir.name]);
    }
  } catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ path: skillsRoot, reason: error.message }); }
  for (const [scope, folder, skill] of scopes) {
    for (const { file, name, text } of safeFiles(root, folder, diagnostics)) {
      chunks(text).forEach((excerpt, index) => {
        if (BUILTIN_MARKERS.some(marker => excerpt.includes(marker))) return; // Dedicated immutable built-ins below.
        if (scanMemoryContent(excerpt)) { diagnostics.push({ path: file, reason: 'unsafe_content' }); return; }
        const relative = path.relative(root, file), id = `memory:${relative}#${index}`;
        const match = relevance(query, `${skill || ''} ${name} ${excerpt}`);
        const pinned = scope !== 'skill' && /\[(?:规则|rule|preference|feedback)\]|【.*(?:强制|必须).*】/i.test(excerpt);
        inventory.push({ id, version: hash(excerpt), mode: `memory:${scope}`, kind: 'memory', scope, skill,
          path: relative, taskId: scope === 'task' ? taskId : null, taskName: `${scope} · ${relative}`,
          excerpt, dedupeText: excerpt, priority: pinned ? 900 : (scope === 'task' ? 400 : 100) + Math.min(match, 30) * 12,
          reason: pinned ? 'rule' : match ? 'query' : scope === 'task' ? 'current_task' : 'scope_default',
          selected: pinned || match > 0 || (scope !== 'skill' && /^(MEMORY|AGENTS|CLAUDE)\.md$/i.test(name)) || scope === 'task',
          links: [...excerpt.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1]),
        });
      });
    }
  }
  // One-hop wiki links only within the already authorized scope inventory.
  const seeds = inventory.filter(s => s.selected && s.reason === 'query').sort((a, b) => b.priority - a.priority).slice(0, 8);
  for (const seed of seeds) for (const link of seed.links.slice(0, 8)) {
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(seed.path), link.replace(/\.md$/i, '') + '.md'));
    for (const neighbor of inventory.filter(s => s.path === local).slice(0, 4)) {
      if (!neighbor.selected) Object.assign(neighbor, { selected: true, reason: 'wikilink', via: seed.id, priority: 150 });
    }
  }
  inventory.unshift({ id: 'builtin:docs-registry', version: hash(DOCS_REGISTRY_RULE), mode: 'memory:builtin',
    kind: 'memory', scope: 'builtin', taskName: 'MultiCC · 文档与服务登记', excerpt: DOCS_REGISTRY_RULE,
    priority: 1000, selected: true, reason: 'builtin', atomic: true });
  inventory.unshift({ id: 'builtin:secret-vault', version: hash(SECRET_VAULT_RULE), mode: 'memory:builtin',
    kind: 'memory', scope: 'builtin', taskName: 'MultiCC · 敏感信息保险箱', excerpt: SECRET_VAULT_RULE,
    priority: 1000, selected: true, reason: 'builtin', atomic: true });
  return { inventory, candidates: inventory.filter(s => s.selected), diagnostics };
}
module.exports = { retrieveMemory, chunks, safeFiles };
