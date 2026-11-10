'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../task-shell/context');
const { relevance, minRelevance } = require('../context/selection');
const { scanMemoryContent } = require('../memory-store');
const { BUILTIN_RULES, DOCS_REGISTRY_RULE, SECRET_VAULT_RULE, SHARED_FILES_RULE } = require('./builtin-rules');
const BUILTIN_MARKERS = BUILTIN_RULES.flatMap(({ marker, legacyMarkers }) => [marker, ...legacyMarkers]);
// A seeded rule spans several paragraphs and chunks() splits on blank lines, so
// only its first paragraph carries the marker. Drop whole § entries that open
// with a built-in marker (current or legacy Chinese wording) so the remaining
// paragraphs do not resurface as ordinary memory next to the dedicated copy.
function builtinChunks(text) {
  const owned = new Set();
  for (const entry of text.split(/\n§\n/)) {
    if (entry.split(/\r?\n/).some(line => BUILTIN_MARKERS.some(m => line.trimStart().startsWith(m)))) {
      for (const chunk of chunks(entry)) owned.add(chunk);
    }
  }
  return owned;
}
// These CLIs receive the host system prompt (src/chat/host-prompts.js), which
// already carries [Secrets safety rules] and [Shared files]; injecting those
// rules again would bill the same instructions twice on every call. Other lanes
// have no host system prompt, so the managed context remains their only copy.
const MAX_QUERY_HITS = 8;
const SYSTEM_PROMPT_SECRET_RULE_CLIS = new Set(['claude', 'codex', 'codex-exp', 'codebuddy', 'qoder', 'pi']);
// Persisted sessions may still carry the retired claude-exp id; it runs on the
// same claude adapter (and therefore the same host system prompt).
const RETIRED_CLI_ALIASES = { 'claude-exp': 'claude' };

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
  const threshold = minRelevance(query);
  for (const [scope, folder, skill] of scopes) {
    for (const { file, name, text } of safeFiles(root, folder, diagnostics)) {
      const builtin = builtinChunks(text);
      chunks(text).forEach((excerpt, index) => {
        if (builtin.has(excerpt) || BUILTIN_MARKERS.some(marker => excerpt.includes(marker))) return; // Dedicated built-ins below.
        if (scanMemoryContent(excerpt)) { diagnostics.push({ path: file, reason: 'unsafe_content' }); return; }
        const relative = path.relative(root, file), id = `memory:${relative}#${index}`;
        const score = relevance(query, `${skill || ''} ${name} ${excerpt}`), match = score >= threshold ? score : 0;
        const pinned = scope !== 'skill' && /\[(?:规则|rule|preference|feedback)\]|【.*(?:强制|必须).*】/i.test(excerpt);
        const indexed = scope !== 'skill' && scope !== 'machine' && /^(MEMORY|AGENTS|CLAUDE)\.md$/i.test(name);
        inventory.push({ id, version: hash(excerpt), mode: `memory:${scope}`, kind: 'memory', scope, skill,
          path: relative, taskId: scope === 'task' ? taskId : null, taskName: `${scope} · ${relative}`,
          excerpt, dedupeText: excerpt, priority: pinned ? 900 : (scope === 'task' ? 400 : 100) + Math.min(match, 30) * 12,
          reason: pinned ? 'rule' : match ? 'query' : scope === 'task' ? 'current_task' : 'scope_default',
          // Machine-wide facts (other projects' tooling, host quirks) join only
          // when the turn points at them; rules there stay pinned above.
          selected: pinned || match > 0 || indexed || scope === 'task', indexed,
          links: [...excerpt.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1]),
        });
      });
    }
  }
  // A common word ("继续", "重启") overlaps dozens of facts without singling any
  // out; keep only the strongest query hits so one vague turn cannot pull a
  // whole budget of loosely related memory. Overflow falls back to whatever
  // would have selected it without the query.
  const queryHits = inventory.filter(s => s.reason === 'query').sort((a, b) => b.priority - a.priority);
  for (const hit of queryHits.slice(MAX_QUERY_HITS)) {
    hit.reason = hit.scope === 'task' ? 'current_task' : 'scope_default';
    hit.selected = hit.indexed || hit.scope === 'task';
  }
  // One-hop wiki links only within the already authorized scope inventory.
  const seeds = inventory.filter(s => s.selected && s.reason === 'query').sort((a, b) => b.priority - a.priority).slice(0, 8);
  for (const seed of seeds) for (const link of seed.links.slice(0, 8)) {
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(seed.path), link.replace(/\.md$/i, '') + '.md'));
    for (const neighbor of inventory.filter(s => s.path === local).slice(0, 4)) {
      if (!neighbor.selected) Object.assign(neighbor, { selected: true, reason: 'wikilink', via: seed.id, priority: 150 });
    }
  }
  const builtins = [['builtin:docs-registry', 'MultiCC · 文档与服务登记', DOCS_REGISTRY_RULE]];
  if (!SYSTEM_PROMPT_SECRET_RULE_CLIS.has(RETIRED_CLI_ALIASES[persisted.cli] || persisted.cli)) builtins.push(
    ['builtin:secret-vault', 'MultiCC · 敏感信息保险箱', SECRET_VAULT_RULE],
    ['builtin:shared-files', 'MultiCC · 共享文件约定', SHARED_FILES_RULE]);
  for (const [id, taskName, rule] of builtins.reverse()) inventory.unshift({ id, version: hash(rule), mode: 'memory:builtin',
    kind: 'memory', scope: 'builtin', taskName, excerpt: rule, priority: 1000, selected: true, reason: 'builtin', atomic: true });
  return { inventory, candidates: inventory.filter(s => s.selected), diagnostics };
}
module.exports = { retrieveMemory, chunks, safeFiles, SYSTEM_PROMPT_SECRET_RULE_CLIS };
