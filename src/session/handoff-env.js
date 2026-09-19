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
  // dropped something.
  function readScopeFiles(dir) {
    const out = { files: {}, skipped: [] };
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return out; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
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

  // Put a bundle's memory scopes back on disk. `shared` lands in the target
  // project's shared folder (existing files win — the local team's knowledge
  // is never overwritten by an import); the narrower scopes fold into the new
  // session's private folder with a prefix so readMemoryFolder surfaces them
  // on the next context build. The `session` scope is deliberately ignored
  // here — v2 bundles still carry it as the flat memoryFiles payload, and the
  // import route restores that path directly.
  function restoreMemoryScopes(scopes, { sessionDir, sharedDir }) {
    const report = {};
    for (const [scope, payload] of Object.entries(scopes || {})) {
      if (scope === 'session') {
        report.session = { written: [], skipped: [], note: 'restored via the memoryFiles payload' };
        continue;
      }
      const entry = { written: [], skipped: [] };
      const prefix = scope === 'shared' ? '' : (MEMORY_SCOPE_PREFIX[scope] || `${scope}-`);
      const targetDir = scope === 'shared' ? sharedDir : sessionDir;
      for (const [rawName, content] of Object.entries((payload && payload.files) || {})) {
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
          fs.writeFileSync(dest, String(content), 'utf8');
          entry.written.push(name);
        } catch (e) {
          entry.skipped.push({ name, reason: e.message });
        }
      }
      report[scope] = entry;
    }
    return report;
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
    lines.push('# HANDOFF.md — 会话环境移植说明');
    lines.push('');
    lines.push(`> 由 multicc session bundle v${(payload && payload.v) || '?'} 导出于 ${(payload && payload.exportedAt) || '未知时间'}；`);
    lines.push(`> 源会话「${meta.label || meta.id}」（${meta.cli || 'claude'}，模型 ${meta.model || '默认'}）。`);
    lines.push('');
    lines.push('## 来源仓库 / 分支');
    lines.push(`- 项目目录名：${ctx.dirName || meta.dirId || '未知'}（源机器路径：${ctx.dirPath || '未知'}）`);
    lines.push(`- 源远端：${ctx.repoRemote || '（无 origin 或未导出）'} — 目标机器需已有同仓库的目录登记`);
    lines.push(`- 源分支：${meta.branch || '未知'}（基分支：${ctx.baseBranch || '未知'}）`);
    if (gitNote) lines.push(`- git 恢复说明：${gitNote}`);
    lines.push('');
    lines.push('## 模型 / Provider');
    lines.push(`- 源 Provider：${ctx.providerName || meta.providerId || '默认登录'}（本机凭据不随包传播，见 .handoff-provider.json）`);
    if (Array.isArray(ctx.envKeys) && ctx.envKeys.length) {
      lines.push(`- 依赖的环境变量（仅名称）：${ctx.envKeys.join(', ')}`);
    }
    lines.push('');
    lines.push('## 项目指令文件');
    const docs = ctx.projectDocs || {};
    const docNames = Object.keys(docs);
    if (docNames.length) {
      for (const name of docNames) lines.push(`- ${name}（已随包携带，内容见 bundle；如目标仓库缺失可从 bundle 恢复）`);
    } else {
      lines.push('- （源工作树没有 CLAUDE.md / AGENTS.md）');
    }
    lines.push('');
    lines.push('## 记忆恢复情况');
    for (const [scope, entry] of Object.entries(memoryReport || {})) {
      const written = (entry.written || []).slice(0, 8).join('、');
      lines.push(`- ${scope}：写入 ${entry.written.length} 个文件${written ? `（${written}${entry.written.length > 8 ? '…' : ''}）` : ''}` +
        (entry.skipped.length ? `，跳过 ${entry.skipped.length} 个（${entry.skipped.map(s => s.name).slice(0, 5).join('、')}…）` : ''));
    }
    lines.push('');
    lines.push('## 技能安装情况');
    if (Array.isArray(skillResults) && skillResults.length) {
      for (const r of skillResults) lines.push(`- ${r.name}：${r.status}${r.note ? `（${r.note}）` : ''}`);
      lines.push('- 抄送到了 ~/.agents/skills，由 skill-sync 分发到各 CLI 的 skills 目录。');
    } else {
      lines.push('- 本 bundle 未携带技能（或未检测到被引用的技能）。');
    }
    lines.push('');
    lines.push('## 对话引用的文件（图片 / 附件）');
    if (Array.isArray(assetMapping) && assetMapping.length) {
      lines.push('对话里引用的本地文件已随包带来，历史消息中的路径已重写为下列新位置：');
      for (const m of assetMapping.slice(0, 20)) lines.push(`- ${m.from} → ${m.to}`);
      if (assetMapping.length > 20) lines.push(`- …共 ${assetMapping.length} 个`);
      lines.push('- 注意：临时目录会随系统清理，长期需要的文件请转移到项目目录或会话记忆。');
    } else {
      lines.push('- 未携带（对话未引用本地文件，或引用的临时文件已被源机器清理）。');
    }
    lines.push('');
    lines.push('## 后续构建上下文的建议');
    lines.push('1. 先读本文件所在文件夹里的记忆文件（含 task-/cli-/machine- 前缀的移植文件）。');
    lines.push('2. 用 `git log <基分支>..HEAD` 了解本会话已完成的增量；未合入的成果在本会话的 worktree 分支上。');
    lines.push('3. 缺失的项目指令文件（上方列表）可向源机器索取或从 bundle 的 contextDeps.projectDocs 恢复。');
    lines.push('4. 涉及 Provider 凭据时参考 .handoff-provider.json 的来源信息，手动接到本机已配置的 provider。');
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
