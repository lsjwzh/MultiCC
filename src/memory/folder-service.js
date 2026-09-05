'use strict';

const { DOCS_REGISTRY_RULE_MARKER, ensureBuiltinSharedMemory } = require('./builtin-rules');

// Per-session injection caps (chars of folder content surfaced into each
// session's system prompt). These are the per-session CONTEXT COST dials —
// raising them bloats every session's prompt. Keep modest.
const SESSION_MEM_CAP = 5000;
const SHARED_MEM_CAP = 4000;
// Curated STORE caps: the total size of the atomic add/replace/remove
// short-fact store (MEMORY.md via the /memory/action API). Independent of the
// injection caps above — a large store is cheap on disk; only SESSION/SHARED
// _MEM_CAP of it surfaces per session (readMemoryFolder truncates with a
// 节选 marker). Raised from 2200 → 128k so a project can grow a real shared
// knowledge base without hitting "memory would exceed limit" on every add.
const CURATED_MEM_CAP_128K = 128 * 1024; // 131072 chars
const SESSION_CURATED_MEM_CAP = CURATED_MEM_CAP_128K;
const SHARED_CURATED_MEM_CAP = CURATED_MEM_CAP_128K;

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[folder-memory] dependencies are required');
  if (!deps.fs || !deps.path || !deps.memoryStoreRoot) {
    throw new TypeError('[folder-memory] filesystem dependencies are required');
  }
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('[folder-memory] directories.get is required');
  }
  for (const name of ['readMemoryFolder', 'getMemoryEntries']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[folder-memory] ${name} is required`);
  }
  return deps;
}

function createFolderMemoryService(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const { fs, path } = deps;

  function sessionDir(persisted) {
    return path.join(
      deps.memoryStoreRoot,
      String(persisted.dirId),
      'sessions',
      String(persisted.id),
    );
  }

  function sharedDir(dirId) {
    return path.join(deps.memoryStoreRoot, String(dirId), '_shared');
  }

  function ensureShared(dirId) {
    try {
      return ensureBuiltinSharedMemory(sharedDir(dirId));
    } catch (error) {
      (deps.logger || console).warn(`[multicc/memory] shared seed ${dirId} failed: ${error.message}`);
      return false; // Retry at the next startup/session; never block a chat.
    }
  }

  function primaryFileName(cli) {
    return cli === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  }

  function writeAutoFile(persisted, entries) {
    if (!persisted || !persisted.dirId || !persisted.id) return;
    try {
      const dir = sessionDir(persisted);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '_auto.md');
      if (!entries || !entries.length) {
        try { fs.unlinkSync(file); } catch (_) {}
        return;
      }
      const body = entries.map(entry => `- [${entry.type}] ${entry.text}`).join('\n');
      fs.writeFileSync(file,
`# 自动提炼记忆（辅助 AI 从周期复盘或被清理的历史中提炼；本文件会被自动覆盖，想长期保留请另写 .md）

${body}
`);
    } catch (_) {
      // Folder memory is best-effort and must never block a chat turn.
    }
  }

  function ensureDirs(persisted) {
    const own = sessionDir(persisted);
    const shared = sharedDir(persisted.dirId);
    try {
      fs.mkdirSync(own, { recursive: true });
      fs.mkdirSync(shared, { recursive: true });
      ensureShared(persisted.dirId);
      const primary = path.join(own, primaryFileName(persisted.cli));
      if (!fs.existsSync(primary)) {
        fs.writeFileSync(primary,
`# 本会话私有记忆

> 「${persisted.label || persisted.id}」会话专属的长期记忆，只有本会话读得到。
> 把值得长期记住的东西写进本文件夹的 .md（决定 / 踩过的坑 / 进行中的任务 / 用户偏好）。
> 想让本项目所有会话都看到的，写到公共记忆文件夹（见注入提示里的路径）。

（暂无内容）
`);
      }
      const readme = path.join(shared, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
`# 公共记忆（本项目所有会话共享）

> 这里的内容会在本目录下原生 CLI 会话启动/重建时进入上下文快照。放跨会话复用的项目知识、约定、稳定事实。
> 一事一文件、精炼；临时/私有的东西请写进各自会话的私有记忆文件夹，不要放这里。
`);
      }
      const auto = path.join(own, '_auto.md');
      if (!fs.existsSync(auto)) {
        const legacy = deps.getMemoryEntries(persisted);
        if (legacy && legacy.length) writeAutoFile(persisted, legacy);
      }
    } catch (_) {
      // Seed creation is best-effort for existing installations.
    }
    return { own, shared };
  }

  function buildBlock(persisted) {
    if (!persisted || !persisted.dirId || !persisted.id) return null;
    if (persisted.type === 'aux' || persisted.type === 'gateway') return null;
    const { own, shared } = ensureDirs(persisted);
    const ownText = deps.readMemoryFolder(own, SESSION_MEM_CAP, {
      primaryNames: [primaryFileName(persisted.cli), 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md'],
    });
    const sharedText = deps.readMemoryFolder(shared, SHARED_MEM_CAP, {
      primaryNames: ['MEMORY.md'],
      priorityEntryMarkers: [DOCS_REGISTRY_RULE_MARKER],
    });
    return (
`[记忆库｜原生会话快照] 你有一个持久记忆文件夹（存在 multicc 数据区，不在本仓库、不进 git）。以下正文会在原生 CLI 会话启动/重建时形成快照；会话中写入会立即落盘并由工具结果确认，但不会改写已经运行中的系统提示词。
· 私有记忆（仅本会话可见）文件夹：${own}
· 公共记忆（本项目所有会话共享）文件夹：${shared}
· 保存短小、稳定的事实时，优先调用受控记忆接口（原子写入、去重、容量与安全检查）：
  curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action" -H 'Content-Type: application/json' -d '{"action":"add","scope":"own","content":"要记住的事实"}'
  action 可为 add / replace / remove；replace/remove 另传 oldText。跨会话项目事实用 scope=shared。较长的专题笔记仍可直接 Write/Edit 为独立 .md 文件。

【私有记忆】
${ownText || '（空）'}

【公共记忆】
${sharedText || '（空）'}
[记忆库结束]`
    );
  }

  function listFiles(dir) {
    let files;
    try {
      files = fs.readdirSync(dir)
        .filter(file => file.toLowerCase().endsWith('.md'))
        .sort();
    } catch (_) {
      return [];
    }
    return files.map(name => {
      let content = '';
      try { content = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) {}
      return { name, content };
    });
  }

  function safeFileName(name) {
    const value = String(name || '').trim();
    if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) return null;
    if (!/^[\w.\- 一-龥]+\.md$/i.test(value)) return null;
    return value;
  }

  function scopeDir(persisted, scope) {
    return scope === 'shared' ? sharedDir(persisted.dirId) : sessionDir(persisted);
  }

  function curatedLimit(scope) {
    return scope === 'shared' ? SHARED_CURATED_MEM_CAP : SESSION_CURATED_MEM_CAP;
  }

  function resolveRolePrompt(persisted) {
    if (!persisted) return null;
    let base = persisted.rolePrompt;
    if (!base) {
      const directory = persisted.dirId ? deps.directories.get(persisted.dirId) : null;
      base = (directory && directory.rolePrompt) || null;
    }
    const parts = [];
    if (base) parts.push(base);
    const folderBlock = buildBlock(persisted);
    if (folderBlock) parts.push(folderBlock);
    return parts.length ? parts.join('\n\n') : null;
  }

  // Upgrade every registered project, including ones without an active session.
  for (const dirId of deps.directories.keys()) ensureShared(dirId);

  return Object.freeze({
    buildBlock,
    curatedLimit,
    ensureDirs,
    ensureShared,
    listFiles,
    primaryFileName,
    resolveRolePrompt,
    safeFileName,
    scopeDir,
    sessionDir,
    sharedDir,
    writeAutoFile,
  });
}

module.exports = {
  SESSION_MEM_CAP,
  SHARED_MEM_CAP,
  SESSION_CURATED_MEM_CAP,
  SHARED_CURATED_MEM_CAP,
  createFolderMemoryService,
};
