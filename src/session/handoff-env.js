'use strict';

// Session execution-environment handoff — the collect/restore layer behind
// session bundle v2 (src/routes/session-bundle.js). A mature session is not
// just its chat history: it is the memory waterfall (private/shared/task/…),
// the skills it relied on, and the context dependencies (repo, branches,
// project instructions) a teammate needs to keep building on the result.
// This module keeps those concerns pure and injectable so the route stays a
// thin shell and tests never touch the real skills root or memory store.
//
// Size discipline: a handoff bundle rides inside a single encrypted JSON
// payload, so every collector is capped (per file, per skill folder, total
// skill count) and reports what it skipped instead of failing the export.

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_SKILL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SKILLS = 20;
// Chat attachments land in the OS temp dir as multicc_<ts>_<hex><ext> (the
// upload middleware's naming) and only their PATH travels inside message
// text — so a handoff bundle must carry the referenced bytes itself or the
// imported conversation shows dead paths. Capped tightly: this is about
// screenshots and small docs, not shipping datasets.
const DEFAULT_MAX_ASSET_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ASSET_TOTAL_BYTES = 20 * 1024 * 1024;
const ASSET_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
// Markdown / HTML image references to local-filesystem paths — the shape the
// chat UI rewrites through /api/download. Absolute-looking paths only; remote
// URLs and data: URIs stay where they are.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*(file:\/\/[^)\s]+|\/[^)\s]+)\s*(?:\"[^\"]*\")?\s*\)/g;
const IMG_SRC_RE = /<img[^>]+src=[\"']([^\"']+)[\"']/gi;
const LOCAL_PATH_RE = /^(?:file:\/\/|\/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)\/|[A-Za-z]:[\\/])/;
const MEMORY_SCOPE_PREFIX = Object.freeze({
  task: 'task-',
  cli: 'cli-',
  machine: 'machine-',
});

// The builtin shared-memory rule mentions `multicc-artifact` by name and ships
// with every install, so it must not count as the session "referencing" that
// skill — otherwise every default export drags the bundled skill along. The
// rule text is injected (src/session may not depend on the memory context).
const DEFAULT_BUILTIN_RULE_TEXT = '';

function createHandoffEnvService(rawDeps) {
  const deps = rawDeps || {};
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const maxFileBytes = deps.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const maxSkillBytes = deps.maxSkillBytes || DEFAULT_MAX_SKILL_BYTES;
  const maxSkills = deps.maxSkills || DEFAULT_MAX_SKILLS;
  const maxAssetFileBytes = deps.maxAssetFileBytes || DEFAULT_MAX_ASSET_FILE_BYTES;
  const maxAssetTotalBytes = deps.maxAssetTotalBytes || DEFAULT_MAX_ASSET_TOTAL_BYTES;
  const logger = deps.logger || console;
  const builtinRuleText = deps.builtinRuleText || DEFAULT_BUILTIN_RULE_TEXT;
  let assetCounter = 0;

  // Exported memory scope names a bundle may carry. `session` is the v1
  // memoryFiles payload kept for compatibility; the others are additions.
  function supportedScopes() {
    return ['session', 'shared', 'task', 'cli', 'machine'];
  }

  function scopeDirFor(folderMemory, persisted, scope) {
    switch (scope) {
      case 'session': return folderMemory.sessionDir(persisted);
      case 'shared': return folderMemory.sharedDir(persisted.dirId);
      case 'task': {
        const taskId = persisted.taskBoundTaskId
          || (persisted.taskState && persisted.taskState.taskId);
        return taskId ? folderMemory.taskDir(persisted.dirId, taskId) : null;
      }
      case 'cli': return folderMemory.cliDir(persisted.cli);
      case 'machine': return folderMemory.machineDir();
      default: return null;
    }
  }

  // Flat-file reader for a memory scope directory. Oversized files are
  // reported, never truncated silently — a teammate should know the export
  // dropped something. Dotfiles are skipped: memory content is markdown, and a
  // dotfile in a memory folder is machine bookkeeping (`.DS_Store`, and the
  // `.handoff-provider.json` older releases wrote next to the memory files).
  // Carrying one would hand the target a file it cannot see in any memory UI.
  function readScopeFiles(dir) {
    const out = { files: {}, skipped: [] };
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return out; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      let stat = null;
      try { stat = fs.statSync(abs); } catch (_) { continue; }
      if (stat.size > maxFileBytes) {
        out.skipped.push({ name: entry.name, reason: `file ${stat.size}B > ${maxFileBytes}B cap` });
        continue;
      }
      try { out.files[entry.name] = fs.readFileSync(abs, 'utf8'); }
      catch (e) { out.skipped.push({ name: entry.name, reason: e.message }); }
    }
    return out;
  }

  function collectMemoryScopes(folderMemory, persisted, scopeList) {
    const result = {};
    for (const scope of scopeList || []) {
      const dir = scopeDirFor(folderMemory, persisted, scope);
      result[scope] = dir
        ? { dir, ...readScopeFiles(dir) }
        : { dir: null, files: {}, skipped: [{ name: '*', reason: 'scope not resolvable for this session' }] };
    }
    return result;
  }

  // Flatten the corpus the skill detector scans: memory text plus recent chat
  // turns. JSON.stringify of the message slice is format-agnostic — history
  // DTOs evolve, and we only need substring evidence, not structure.
  function detectionCorpus(memoryScopes, messages) {
    const parts = [];
    for (const scope of Object.values(memoryScopes || {})) {
      for (const content of Object.values(scope.files || {})) parts.push(content);
    }
    if (Array.isArray(messages)) {
      const slice = messages.slice(-300);
      try { parts.push(JSON.stringify(slice).slice(0, 256 * 1024)); } catch (_) {}
    }
    const text = parts.join('\n');
    return builtinRuleText ? text.split(builtinRuleText).join(' ') : text;
  }

  // A skill name is only matchable when it is a safe single path segment.
  // Short names (<3 chars) and unsafe ones are ignored — they would match
  // ordinary prose and bloat the bundle with unrelated skills.
  function matchableSkillName(name) {
    const value = String(name || '').trim();
    if (value.length < 3 || value.length > 64) return null;
    if (!/^[\w.\-]+$/.test(value)) return null;
    return value;
  }

  function detectSkillReferences(corpus, installedSkills) {
    if (!corpus) return [];
    const found = new Set();
    for (const skill of installedSkills || []) {
      const name = matchableSkillName(skill && skill.name);
      if (!name || found.has(name)) continue;
      // Treat [-\w.] as name characters so `skill-maker` does not match inside
      // `skill-makers`; the lookarounds keep the match anchored on both ends.
      const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.\-]/g, ch => `\\${ch}`)}(?=$|[^A-Za-z0-9_.-])`);
      if (pattern.test(corpus)) found.add(name);
    }
    return [...found].sort();
  }

  function looksBinary(buffer) {
    if (buffer.includes(0)) return true;
    // Round-trip check: UTF-8 replacement chars mean the bytes are not text.
    return Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) !== 0;
  }

  // Recursive folder snapshot for one skill. Skips node_modules/.git/symlinks
  // and stops adding files once the byte cap is hit (still walks to count the
  // overflow so the note can say how much was left behind).
  function collectSkillFolder(skillDir) {
    const out = { files: [], bytes: 0, truncated: false };
    const walk = (dir, relPrefix) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
        const abs = path.join(dir, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(abs, rel); continue; }
        if (!entry.isFile()) continue;
        let stat = null;
        try { stat = fs.statSync(abs); } catch (_) { continue; }
        if (out.bytes + stat.size > maxSkillBytes) { out.truncated = true; continue; }
        let buffer;
        try { buffer = fs.readFileSync(abs); } catch (_) { continue; }
        const binary = looksBinary(buffer);
        out.files.push({
          rel,
          encoding: binary ? 'base64' : 'utf8',
          content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
        });
        out.bytes += stat.size;
      }
    };
    walk(skillDir, '');
    return out;
  }

  // Collect the folders for a resolved skill list (metadata from
  // listInstalledSkills: `path` points at the SKILL.md). Returns an array —
  // names can collide across roots, and the bundle should stay explicit
  // about which folder it carried.
  function collectSkillFolders(installedSkills, names) {
    const byName = new Map();
    for (const skill of installedSkills || []) {
      const name = matchableSkillName(skill && skill.name);
      if (!name || !skill.path) continue;
      if (!byName.has(name)) byName.set(name, skill);
    }
    const out = [];
    for (const name of (names || []).slice(0, maxSkills)) {
      const skill = byName.get(name);
      if (!skill) { out.push({ name, missing: true }); continue; }
      const folder = collectSkillFolder(path.dirname(skill.path));
      out.push({ name, source: skill.source || null, provider: skill.provider || null, ...folder });
    }
    return out;
  }

  function safeRelativePath(rel) {
    const value = String(rel || '');
    if (!value || value.includes('\\') || value.includes('\0')) return null;
    if (path.isAbsolute(value)) return null;
    const normalized = path.normalize(value);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return null;
    return normalized;
  }

  function safeMemoryFileName(name) {
    const value = String(name || '');
    if (!value || value.includes('/') || value.includes('\\') || value.includes('\0')) return null;
    if (value === '.' || value === '..' || value.startsWith('.')) return null;
    return value;
  }

  function skillFileMap(dir) {
    const map = new Map();
    const walk = (current, relPrefix) => {
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch (_) { return; }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
        const abs = path.join(current, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(abs, rel); continue; }
        if (!entry.isFile()) continue;
        let buffer;
        try { buffer = fs.readFileSync(abs); } catch (_) { continue; }
        const binary = looksBinary(buffer);
        map.set(rel, binary ? buffer.toString('base64') : buffer.toString('utf8'));
      }
    };
    walk(dir, '');
    return map;
  }

  // Install one bundled skill into the canonical shared skills root. An
  // identical skill already present is a no-op; a differing one lands under
  // `<name>-imported` so the teammate's existing skill is never clobbered.
  function restoreSkillFolder(skill, agentsSkillsDir) {
    const name = matchableSkillName(skill && skill.name);
    const files = (skill && Array.isArray(skill.files)) ? skill.files : [];
    if (!name) return { name: skill && skill.name, status: 'rejected', note: 'unsafe skill name' };
    if (!files.length) return { name, status: 'rejected', note: 'bundle contains no files' };
    const payloadMap = new Map();
    for (const file of files) {
      const rel = safeRelativePath(file.rel);
      if (!rel) return { name, status: 'rejected', note: `unsafe file path: ${file.rel}` };
      payloadMap.set(rel, { encoding: file.encoding === 'base64' ? 'base64' : 'utf8', content: String(file.content || '') });
    }
    if (!payloadMap.has('SKILL.md')) {
      return { name, status: 'rejected', note: 'bundle skill has no SKILL.md' };
    }
    const install = (targetName) => {
      const destDir = path.join(agentsSkillsDir, targetName);
      fs.mkdirSync(destDir, { recursive: true });
      for (const [rel, file] of payloadMap) {
        const dest = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(file.content, file.encoding));
      }
      return destDir;
    };
    const existingDir = path.join(agentsSkillsDir, name);
    if (fs.existsSync(path.join(existingDir, 'SKILL.md'))) {
      const existing = skillFileMap(existingDir);
      const identical = existing.size === payloadMap.size
        && [...payloadMap].every(([rel, file]) => existing.get(rel) === file.content);
      if (identical) return { name, status: 'identical', dir: existingDir, note: 'already installed' };
      const suffixes = [`-imported`];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = `${name}${suffixes[0]}${attempt ? `-${attempt}` : ''}`;
        if (!fs.existsSync(path.join(agentsSkillsDir, candidate, 'SKILL.md'))) {
          const dir = install(candidate);
          return { name, status: 'renamed', dir, note: `conflicts with local ${name}; installed as ${candidate}` };
        }
      }
      return { name, status: 'skipped', note: 'all import names occupied' };
    }
    const dir = install(name);
    return { name, status: 'installed', dir };
  }

  function restoreSkillFolders(skills, agentsSkillsDir) {
    const results = [];
    for (const skill of Array.isArray(skills) ? skills : []) {
      if (!skill || skill.missing) {
        results.push({ name: skill && skill.name, status: 'missing', note: 'skill was not found at export time' });
        continue;
      }
      try { results.push(restoreSkillFolder(skill, agentsSkillsDir)); }
      catch (e) {
        logger.warn(`[handoff-env] skill ${skill.name} restore failed: ${e.message}`);
        results.push({ name: skill.name, status: 'failed', note: e.message });
      }
    }
    return results;
  }

  // Memory text is injected into every session's context as trusted
  // instructions, and the machine/cli/shared scopes are read by sessions the
  // importer never chose. A file arriving there from another machine must not
  // be indistinguishable from one this machine wrote, so it carries a header.
  // A markdown comment: invisible when rendered, visible to anything reading
  // the raw text (which is what the context build does).
  function memoryProvenanceHeader(provenance, scope) {
    if (!provenance) return '';
    const when = provenance.exportedAt || 'unknown time';
    const who = provenance.label || provenance.sessionId || 'a source session';
    const cli = provenance.cli || 'unknown cli';
    return `<!-- multicc handoff: imported into the ${scope} memory scope from source session`
      + ` "${who}" (${cli}), exported ${when}. It came from another machine — verify before relying on it. -->\n`;
  }

  // Put a bundle's memory scopes back on disk, each into the scope it came
  // from: machine → this machine's global folder, cli → the source CLI's
  // folder, shared → the target project's shared folder, and the narrower
  // scopes (task, and anything else) → the imported session's private folder
  // with a prefix so readMemoryFolder still surfaces them. Demoting machine/cli
  // into one session's private folder would defeat the point of the handoff:
  // those layers ARE the execution environment, and only the session that
  // happened to receive the import could see them.
  //
  // Existing files always win, so a re-import is idempotent and local knowledge
  // is never clobbered. The `session` scope is deliberately ignored here — v2
  // bundles carry it as the flat memoryFiles payload, and the import route
  // restores that path directly.
  function restoreMemoryScopes(scopes, options = {}) {
    const { folderMemory, cli, sessionDir, sharedDir, provenance } = options;
    const report = {};
    for (const [scope, payload] of Object.entries(scopes || {})) {
      if (scope === 'session') {
        report.session = { written: [], skipped: [], note: 'restored via the memoryFiles payload' };
        continue;
      }
      const entry = { written: [], skipped: [] };
      const files = Object.entries((payload && payload.files) || {});
      const globalScope = scope === 'machine' || scope === 'cli' || scope === 'shared';
      let targetDir = null;
      let prefix = '';
      if (scope === 'machine') targetDir = (folderMemory && folderMemory.machineDir()) || null;
      else if (scope === 'cli') targetDir = (cli && folderMemory && folderMemory.cliDir(cli)) || null;
      else if (scope === 'shared') targetDir = sharedDir || null;
      else { targetDir = sessionDir || null; prefix = MEMORY_SCOPE_PREFIX[scope] || `${scope}-`; }
      if (!targetDir) {
        if (files.length) {
          entry.skipped.push({ name: '*', reason: globalScope
            ? `${scope} scope is not resolvable on this machine`
            : 'no session to fold this scope into' });
        }
        report[scope] = entry;
        continue;
      }
      const header = globalScope ? memoryProvenanceHeader(provenance, scope) : '';
      for (const [rawName, content] of files) {
        const base = safeMemoryFileName(rawName);
        if (!base) { entry.skipped.push({ name: rawName, reason: 'unsafe file name' }); continue; }
        const name = prefix + base;
        try {
          fs.mkdirSync(targetDir, { recursive: true });
          const dest = path.join(targetDir, name);
          if (fs.existsSync(dest)) {
            entry.skipped.push({ name, reason: 'already exists locally' });
            continue;
          }
          fs.writeFileSync(dest, header + String(content), 'utf8');
          entry.written.push(name);
        } catch (e) {
          entry.skipped.push({ name, reason: e.message });
        }
      }
      report[scope] = entry;
    }
    return report;
  }

  // Normalize a git remote to `host/owner/repo` so one repository is recognized
  // across transports: `git@github.com:a/b.git`, `ssh://git@github.com/a/b.git`
  // and `https://github.com/a/b.git` all name the same repo. Returns null for a
  // local path or anything without a recognizable host — "cannot tell", which
  // callers must not read as "different".
  function normalizeRepoRemote(remote) {
    const raw = String(remote || '').trim();
    if (!raw) return null;
    if (raw.startsWith('/') || raw.startsWith('.') || /^[a-z]:[\\/]/i.test(raw)) return null;
    let host = null;
    let rest = null;
    const url = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)(?::\d+)?\/(.*)$/i);
    const scp = url ? null : raw.match(/^(?:[^/@\s]*@)?([^:/\s]+):(.*)$/);
    if (url) { host = url[1]; rest = url[2]; }
    else if (scp) { host = scp[1]; rest = scp[2]; }
    if (!host || !rest) return null;
    const trimmed = rest.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!trimmed || trimmed.includes(' ')) return null;
    return `${host.toLowerCase()}/${trimmed.toLowerCase()}`;
  }

  // Whether the code layer is meaningful: true/false only when both sides name
  // a repository, null when either side has no origin to compare. Callers treat
  // null as "attempt it" — git is the final arbiter there, and an unrelated
  // history has no merge base, so the replay aborts and leaves a note instead
  // of touching the worktree.
  function sameRepository(sourceRemote, targetRemote) {
    const source = normalizeRepoRemote(sourceRemote);
    const target = normalizeRepoRemote(targetRemote);
    if (!source || !target) return null;
    return source === target;
  }

  // ── Chat-referenced assets ─────────────────────────────────────────────
  // Collect the local files a conversation references by path: user uploads
  // (the temp-dir multicc_* files whose paths the composer appends to the
  // outgoing text) and local image references in markdown/HTML. Only files
  // that still exist are carried; everything else is reported as skipped so
  // the export meta can say what was lost.
  function extractAssetPaths(messages, tmpDir) {
    const paths = new Set();
    const add = (value) => {
      const clean = String(value || '').replace(/^file:\/\//, '');
      if (clean) paths.add(clean);
    };
    // The upload middleware names files multicc_<ts>_<hex><ext> under the OS
    // temp dir; match that prefix wherever the temp dir lives on this machine.
    const uploadPrefix = path.join(String(tmpDir || os_tmpdirFallback()), 'multicc_');
    const uploadRe = new RegExp(`${escapeRegExp(uploadPrefix)}[\\w.-]+`, 'g');
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = message && typeof message.content === 'string' ? message.content : '';
      if (!content) continue;
      for (const match of content.matchAll(uploadRe)) add(match[0]);
      for (const match of content.matchAll(MD_IMAGE_RE)) {
        const target = match[1];
        if (LOCAL_PATH_RE.test(target)) add(target);
      }
      for (const match of content.matchAll(IMG_SRC_RE)) {
        const target = match[1];
        if (LOCAL_PATH_RE.test(target)) add(target);
      }
    }
    return [...paths];
  }

  function os_tmpdirFallback() {
    return require('node:os').tmpdir();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function collectMessageAssets(messages, { tmpDir } = {}) {
    const out = { files: [], skipped: [], totalBytes: 0, truncated: false };
    for (const absPath of extractAssetPaths(messages, tmpDir)) {
      let stat = null;
      try { stat = fs.statSync(absPath); } catch (_) {
        out.skipped.push({ path: absPath, reason: 'missing (temp files are cleaned up)' });
        continue;
      }
      if (!stat.isFile()) { out.skipped.push({ path: absPath, reason: 'not a regular file' }); continue; }
      // Markdown-referenced paths may point anywhere on disk; only carry
      // image types from that route. Upload-prefix files are unrestricted
      // (they already passed the upload policy on the way in).
      const isUpload = absPath.startsWith(path.join(String(tmpDir || os_tmpdirFallback()), 'multicc_'));
      const ext = path.extname(absPath).toLowerCase();
      if (!isUpload && !ASSET_IMAGE_EXTENSIONS.has(ext)) {
        out.skipped.push({ path: absPath, reason: 'non-image local reference' });
        continue;
      }
      if (stat.size > maxAssetFileBytes) {
        out.skipped.push({ path: absPath, reason: `file ${stat.size}B > ${maxAssetFileBytes}B cap` });
        continue;
      }
      if (out.totalBytes + stat.size > maxAssetTotalBytes) {
        out.truncated = true;
        out.skipped.push({ path: absPath, reason: 'total asset budget exceeded' });
        continue;
      }
      try {
        out.files.push({ path: absPath, name: path.basename(absPath),
                         size: stat.size, encoding: 'base64',
                         content: fs.readFileSync(absPath).toString('base64') });
        out.totalBytes += stat.size;
      } catch (e) {
        out.skipped.push({ path: absPath, reason: e.message });
      }
    }
    return out;
  }

  // Restore carried assets into the target machine's temp dir with the same
  // multicc_ prefix the upload middleware uses, and return the from→to path
  // mapping the import route rewrites message text with.
  function restoreMessageAssets(assets, { tmpDir } = {}) {
    const mapping = [];
    const target = String(tmpDir || os_tmpdirFallback());
    for (const asset of Array.isArray(assets && assets.files) ? assets.files : []) {
      try {
        const name = safeRelativePath(asset.name);
        if (!name) continue;
        const dest = path.join(target,
          `multicc_handoff_${Date.now().toString(36)}_${(assetCounter += 1)}_${name.replace(/[\\/]/g, '_')}`);
        fs.writeFileSync(dest, Buffer.from(String(asset.content || ''), 'base64'), { mode: 0o600, flag: 'wx' });
        mapping.push({ from: asset.path, to: dest });
      } catch (e) {
        logger.warn(`[handoff-env] asset ${asset.path} restore failed: ${e.message}`);
      }
    }
    return mapping;
  }

  function rewriteAssetPaths(text, mapping) {
    let value = text;
    for (const { from, to } of mapping || []) {
      if (from && to) value = value.split(from).join(to);
    }
    return value;
  }

  // The context-dependency manifest written into the imported session's
  // private memory folder: everything a fresh session (or a human) needs to
  // rebuild the working context on this machine.
  function renderHandoffDoc({ payload, memoryReport, skillResults, assetMapping, gitNote }) {
    const meta = (payload && payload.sessionMeta) || {};
    const ctx = (payload && payload.contextDeps) || {};
    const lines = [];
    lines.push('# HANDOFF.md - session environment handoff notes');
    lines.push('');
    lines.push(`> Exported by multicc session bundle v${(payload && payload.v) || '?'} at ${(payload && payload.exportedAt) || 'unknown time'};`);
    lines.push(`> source session "${meta.label || meta.id}" (${meta.cli || 'claude'}, model ${meta.model || 'default'}).`);
    lines.push('');
    lines.push('## Source repository / branch');
    lines.push(`- Project directory name: ${ctx.dirName || meta.dirId || 'unknown'} (path on the source machine: ${ctx.dirPath || 'unknown'})`);
    lines.push(`- Source remote: ${ctx.repoRemote || '(no origin, or not exported)'} - the code layer replays only onto the same repository; `
      + 'a directory with a different origin keeps its own history and the replay is skipped (see the Git recovery notes below)');
    lines.push(`- Source branch: ${meta.branch || 'unknown'} (base branch: ${ctx.baseBranch || 'unknown'})`);
    if (gitNote) lines.push(`- Git recovery notes: ${gitNote}`);
    lines.push('');
    lines.push('## Model / Provider');
    lines.push(`- Source model: ${meta.model || '(default)'} - carried in the bundle and written into the new session on import.`);
    lines.push('- Providers do not travel with the bundle: the source machine\'s provider selection, environment variables, and credentials are never carried; '
      + 'the target machine serves this handoff with its own provider. On import, targetProviderId may point at a provider configured on this machine; '
      + 'if omitted, this machine\'s default provider for the CLI is used.');
    lines.push('- If the source model does not exist on this machine\'s provider (the source machine may have used another vendor), '
      + 'change the session settings to a model available here instead of requesting a cross-provider model name.');
    lines.push('');
    lines.push('## Project instruction files');
    const docs = ctx.projectDocs || {};
    const docNames = Object.keys(docs);
    if (docNames.length) {
      for (const name of docNames) lines.push(`- ${name} (carried in the bundle; see the bundle for content and restore it if the target repository lacks it)`);
    } else {
      lines.push('- (the source working tree had no CLAUDE.md / AGENTS.md)');
    }
    lines.push('');
    lines.push('## Memory restore report');
    for (const [scope, entry] of Object.entries(memoryReport || {})) {
      const written = (entry.written || []).slice(0, 8).join(', ');
      lines.push(`- ${scope}: wrote ${entry.written.length} files${written ? ` (${written}${entry.written.length > 8 ? '...' : ''})` : ''}` +
        (entry.skipped.length ? `, skipped ${entry.skipped.length} (${entry.skipped.map(s => s.name).slice(0, 5).join(', ')}...)` : ''));
    }
    lines.push('');
    lines.push('## Skill installation report');
    if (Array.isArray(skillResults) && skillResults.length) {
      for (const r of skillResults) lines.push(`- ${r.name}: ${r.status}${r.note ? ` (${r.note})` : ''}`);
      lines.push('- Copied to ~/.agents/skills; skill-sync distributes them to each CLI\'s skills directory.');
    } else {
      lines.push('- This bundle carried no skills (or none of the referenced skills were detected).');
    }
    lines.push('');
    lines.push('## Files referenced by the conversation (images / attachments)');
    if (Array.isArray(assetMapping) && assetMapping.length) {
      lines.push('Local files referenced in the conversation came with the bundle; paths in the history were rewritten to the new locations below:');
      for (const m of assetMapping.slice(0, 20)) lines.push(`- ${m.from} -> ${m.to}`);
      if (assetMapping.length > 20) lines.push(`- ...${assetMapping.length} in total`);
      lines.push('- Note: temporary directories are cleaned by the system; move files you need long-term into the project directory or session memory.');
    } else {
      lines.push('- None carried (the conversation referenced no local files, or the referenced temporary files were already cleaned on the source machine).');
    }
    lines.push('');
    lines.push('## Suggested next steps to rebuild context');
    lines.push('1. Read the memory files in the folder containing this file first (narrow scopes such as task memory were folded in here with a prefix); '
      + 'machine-, CLI- and project-shared memory went back to their own global folders, where every session on this machine reads them.');
    lines.push('2. Use `git log <base branch>..HEAD` to see the increments this session completed; unmerged work lives on this session\'s worktree branch.');
    lines.push('3. Missing project instruction files (listed above) can be requested from the source machine or restored from contextDeps.projectDocs in the bundle.');
    lines.push('4. The provider is decided by this machine: the bundle carries no source provider configuration or credentials, and the imported copy is already attached to a local provider; '
      + 'use targetProviderId to point at a provider configured here when you need a specific one.');
    return lines.join('\n') + '\n';
  }

  return Object.freeze({
    supportedScopes,
    scopeDirFor,
    readScopeFiles,
    collectMemoryScopes,
    detectionCorpus,
    detectSkillReferences,
    matchableSkillName,
    collectSkillFolder,
    collectSkillFolders,
    collectMessageAssets,
    restoreMessageAssets,
    rewriteAssetPaths,
    extractAssetPaths,
    restoreSkillFolders,
    restoreMemoryScopes,
    normalizeRepoRemote,
    sameRepository,
    renderHandoffDoc,
    safeRelativePath,
    safeMemoryFileName,
  });
}

module.exports = {
  createHandoffEnvService,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SKILL_BYTES,
  DEFAULT_MAX_SKILLS,
  DEFAULT_MAX_ASSET_FILE_BYTES,
  DEFAULT_MAX_ASSET_TOTAL_BYTES,
};
