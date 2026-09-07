// Agent resources domain — enumerate installed skills (Claude/Codex) and browse
// Claude Code's on-disk session history. Pure filesystem reads; no domain owns
// mutable state here.
//
// It needs read access to two core Maps (directories, persistedSessions) to know
// which project roots to scan and which Claude sessions are linked. It reads them
// from the shared state registry at call time (never destructured), so the live
// references are always current.
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state/container');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SKILL_FILE = 'SKILL.md';

function readFileSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function skillMetadata(filePath, provider, source) {
  let text = '';
  try { text = readFileSlice(filePath, 0, 64 * 1024); } catch (_) {}
  const frontmatter = text.startsWith('---') ? (text.split(/^---\s*$/m)[1] || '') : '';
  const title = (frontmatter.match(/^name:\s*(.+)$/m)?.[1] || path.basename(path.dirname(filePath)))
    .trim().replace(/^['"]|['"]$/g, '');
  const description = (frontmatter.match(/^description:\s*(.+)$/m)?.[1] || '')
    .trim().replace(/^['"]|['"]$/g, '');
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (_) {}
  return {
    provider, source, name: title, description,
    path: filePath,
    updatedAt: stat?.mtime?.toISOString() || null,
  };
}

function scanSkillRoot(root, provider, source, maxDepth, out, seen) {
  if (!root || !fs.existsSync(root)) return;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === SKILL_FILE) {
        let key = full;
        try { key = fs.realpathSync(full); } catch (_) {}
        if (!seen.has(key)) {
          seen.add(key);
          out.push(skillMetadata(full, provider, source));
        }
      } else if (entry.isDirectory() && depth < maxDepth && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
}

function listInstalledSkills() {
  const skills = [];
  const seen = new Set();
  const home = os.homedir();
  scanSkillRoot(path.join(home, '.claude', 'skills'), 'claude', 'global', 3, skills, seen);
  scanSkillRoot(path.join(home, '.claude', 'plugins', 'cache'), 'claude', 'plugin', 8, skills, seen);
  scanSkillRoot(path.join(home, '.codex', 'skills'), 'codex', 'global', 4, skills, seen);
  scanSkillRoot(path.join(home, '.agents', 'skills'), 'codex', 'shared', 3, skills, seen);

  const projectRoots = new Set();
  projectRoots.add(process.cwd());
  projectRoots.add(path.join(__dirname, '..'));
  for (const d of state.directories.values()) if (d.path) projectRoots.add(d.path);
  for (const s of state.persistedSessions.values()) if (s.worktreePath) projectRoots.add(s.worktreePath);
  for (const root of projectRoots) {
    scanSkillRoot(path.join(root, '.claude', 'skills'), 'claude', 'project', 3, skills, seen);
    scanSkillRoot(path.join(root, '.codex', 'skills'), 'codex', 'project', 3, skills, seen);
    scanSkillRoot(path.join(root, '.agents', 'skills'), 'codex', 'project', 3, skills, seen);
  }

  return skills.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

function claudeLinkedSessionIds() {
  return new Set([...state.persistedSessions.values()]
    .filter(s => (s.cli || 'claude') === 'claude' && s.cliSessionId)
    .map(s => s.cliSessionId));
}

function claudeSessionSummary(filePath, linkedIds) {
  const stat = fs.statSync(filePath);
  const id = path.basename(filePath, '.jsonl');
  const head = readFileSlice(filePath, 0, Math.min(stat.size, 192 * 1024));
  const tailStart = Math.max(0, stat.size - 128 * 1024);
  const tail = readFileSlice(filePath, tailStart, Math.min(stat.size, 128 * 1024));
  let cwd = '';
  let title = '';
  let preview = '';
  let lastPrompt = '';
  for (const line of `${head}\n${tail}`.split('\n')) {
    if (!line.startsWith('{')) continue;
    let item;
    try { item = JSON.parse(line); } catch (_) { continue; }
    if (!cwd && item.cwd) cwd = item.cwd;
    if (item.type === 'ai-title' && item.aiTitle) title = item.aiTitle;
    if (item.type === 'last-prompt' && item.lastPrompt) lastPrompt = item.lastPrompt;
    if (!preview && item.type === 'user') {
      const content = item.message?.content;
      preview = typeof content === 'string' ? content : '';
    }
  }
  return {
    id, project: path.basename(path.dirname(filePath)), cwd,
    title: title || lastPrompt || preview.slice(0, 160) || '(untitled)',
    preview: lastPrompt || preview.slice(0, 240),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    linked: linkedIds.has(id),
  };
}

function listClaudeHistory() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const linkedIds = claudeLinkedSessionIds();
  const list = [];
  let projects = [];
  try { projects = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }); } catch (_) { return []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, project.name);
    let files = [];
    try { files = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const file of files) {
      if (!file.isFile() || !/^[0-9a-f-]+\.jsonl$/i.test(file.name)) continue;
      try { list.push(claudeSessionSummary(path.join(projectDir, file.name), linkedIds)); } catch (_) {}
    }
  }
  return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function claudeHistoryFile(project, id) {
  if (!/^[^/\\]+$/.test(project) || !/^[0-9a-f-]+$/i.test(id)) return null;
  const candidate = path.resolve(CLAUDE_PROJECTS_DIR, project, `${id}.jsonl`);
  const root = path.resolve(CLAUDE_PROJECTS_DIR) + path.sep;
  return candidate.startsWith(root) ? candidate : null;
}

function removeClaudeHistorySession(project, id) {
  const filePath = claudeHistoryFile(project, id);
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Claude session not found' };
  if (claudeLinkedSessionIds().has(id)) return { ok: false, error: 'Session is linked to MultiCC and is protected' };
  const stat = fs.statSync(filePath);
  fs.unlinkSync(filePath);
  for (const extra of [
    path.join(path.dirname(filePath), id),
    path.join(CLAUDE_HOME, 'tasks', id),
    path.join(CLAUDE_HOME, 'session-env', id),
  ]) {
    try { fs.rmSync(extra, { recursive: true, force: true }); } catch (_) {}
  }
  return { ok: true, freed: stat.size };
}

module.exports = {
  listInstalledSkills,
  listClaudeHistory,
  claudeHistoryFile,
  removeClaudeHistorySession,
};
