'use strict';

const { DOCS_REGISTRY_RULE_MARKER, ensureBuiltinSharedMemory } = require('./builtin-rules');

// Per-session injection caps (chars of folder content surfaced into each
// session's system prompt). These are the per-session CONTEXT COST dials —
// raising them bloats every session's prompt. Keep modest.
// 五层瀑布（宽→窄）：机器全局 → CLI 特有 → 目录公共 → 任务 → 会话私有。
// 窄层信息密度更高，所以会话/公共层预算保持最大；全局层最严，避免一台机器的
// 通用偏好吃掉每个会话的上下文。
const SESSION_MEM_CAP = 5000;
const SHARED_MEM_CAP = 4000;
const TASK_MEM_CAP = 2000;
const CLI_MEM_CAP = 1200;
const MACHINE_MEM_CAP = 2000;
// Curated STORE caps: the total size of the atomic add/replace/remove
// short-fact store (MEMORY.md via the /memory/action API). Independent of the
// injection caps above — a large store is cheap on disk; only the layer's
// _MEM_CAP of it surfaces per session (readMemoryFolder truncates with a
// 节选 marker). Raised from 2200 → 128k so a project can grow a real shared
// knowledge base without hitting "memory would exceed limit" on every add.
// 机器全局层最严（32k）：它注入到本机所有会话，写入门槛应该高。
const CURATED_MEM_CAP_128K = 128 * 1024; // 131072 chars
const CURATED_MEM_CAP_64K = 64 * 1024;
const CURATED_MEM_CAP_32K = 32 * 1024;
const SESSION_CURATED_MEM_CAP = CURATED_MEM_CAP_128K;
const SHARED_CURATED_MEM_CAP = CURATED_MEM_CAP_128K;
const TASK_CURATED_MEM_CAP = CURATED_MEM_CAP_64K;
const SKILL_CURATED_MEM_CAP = CURATED_MEM_CAP_32K;
const CLI_CURATED_MEM_CAP = CURATED_MEM_CAP_32K;
const MACHINE_CURATED_MEM_CAP = CURATED_MEM_CAP_32K;

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

  // 层级目录段名只允许安全字符（cli 名、技能名、任务 ID 都走这里）。
  function safeSegment(value) {
    const v = String(value || '').trim();
    if (!v || v === '.' || v === '..' || v.includes('/') || v.includes('\\') || v.includes('\0')) return null;
    if (!/^[\w.\-]+$/.test(v)) return null;
    return v;
  }

  // ① 机器全局层：跨目录、跨项目仍然成立的事实（用户身份、全局偏好、硬件环境）。
  function machineDir() {
    return path.join(deps.memoryStoreRoot, '_machine');
  }

  // ② CLI 特有层：claude / codex / zcode 等 CLI 各自的行为差异与坑。
  function cliDir(cli) {
    const segment = safeSegment(cli);
    if (!segment) return null;
    return path.join(deps.memoryStoreRoot, '_cli', segment);
  }

  // ⑤ 任务层：单个任务的目标、决策与交付总结（taskId 形如 tsk_xxx）。
  function taskDir(dirId, taskId) {
    const dir = safeSegment(dirId);
    const task = safeSegment(taskId);
    if (!dir || !task) return null;
    return path.join(deps.memoryStoreRoot, dir, 'tasks', task);
  }

  // 技能层：目录 × 技能 的使用经验（按需注入，不进系统提示瀑布）。
  function skillDir(dirId, skillName) {
    const dir = safeSegment(dirId);
    const skill = safeSegment(skillName);
    if (!dir || !skill) return null;
    return path.join(deps.memoryStoreRoot, dir, 'skills', skill);
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
      // 全局层与 CLI 层：只建目录不种默认文件——层级用法已在 buildBlock 指令里说明，
      // 空层不应靠种子 README 白白消耗每个会话的注入预算。
      fs.mkdirSync(machineDir(), { recursive: true });
      const cliFolder = cliDir(persisted.cli);
      if (cliFolder) fs.mkdirSync(cliFolder, { recursive: true });
      const currentTaskId = persisted.taskState && persisted.taskState.taskId;
      const taskFolder = currentTaskId ? taskDir(persisted.dirId, currentTaskId) : null;
      if (taskFolder) fs.mkdirSync(taskFolder, { recursive: true });
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
    // 瀑布的宽层：机器全局与 CLI 特有。空层不注入段落（省 token）。
    const machineText = deps.readMemoryFolder(machineDir(), MACHINE_MEM_CAP, {
      primaryNames: ['MEMORY.md'],
    });
    const cliFolder = cliDir(persisted.cli);
    const cliText = cliFolder
      ? deps.readMemoryFolder(cliFolder, CLI_MEM_CAP, { primaryNames: ['MEMORY.md'] })
      : '';
    // 任务层：classify 通道在 persisted.taskState.taskId 上维护当前任务。
    const currentTaskId = persisted.taskState && persisted.taskState.taskId;
    const taskFolder = currentTaskId ? taskDir(persisted.dirId, currentTaskId) : null;
    const taskText = taskFolder
      ? deps.readMemoryFolder(taskFolder, TASK_MEM_CAP, { primaryNames: ['MEMORY.md'] })
      : '';

    const sections = [];
    const tier = (heading, text) => {
      if (text && text.trim()) sections.push(`【${heading}】\n${text}`);
    };
    tier('机器全局记忆（本机所有会话共享）', machineText);
    tier(`CLI 记忆（${persisted.cli}）`, cliText);
    tier('任务记忆', taskText);
    tier('私有记忆', ownText || '（空）');
    tier('公共记忆', sharedText || '（空）');

    return (
`[记忆库｜原生会话快照] 你有一个持久记忆文件夹（存在 multicc 数据区，不在本仓库、不进 git）。以下正文会在原生 CLI 会话启动/重建时形成快照；会话中写入会立即落盘并由工具结果确认，但不会改写已经运行中的系统提示词。
· 私有记忆（仅本会话可见）文件夹：${own}
· 公共记忆（本项目所有会话共享）文件夹：${shared}
· 机器全局（本机所有会话）文件夹：${machineDir()}
· CLI 特有（${persisted.cli}）文件夹：${cliFolder || '（无效 cli 名）'}
· 任务级（当前任务 ${currentTaskId || '无'}）文件夹：${taskFolder || '（无绑定任务）'}
· 技能记忆根目录：${path.join(deps.memoryStoreRoot, String(persisted.dirId), 'skills')}（按需 Read，不自动注入）
· 保存短小、稳定的事实时，优先调用受控记忆接口（原子写入、去重、容量与安全检查）：
  curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action" -H 'Content-Type: application/json' -d '{"action":"add","scope":"own","content":"要记住的事实"}'
  action 可为 add / replace / remove；replace/remove 另传 oldText。
  scope 分层：own=本会话 / shared=本项目 / task=当前任务（自动定位，也可传 taskId 指定）/ machine=本机全局（门槛最高）/ cli=当前 CLI 特有 / skill=技能记忆（另传 skill=<技能名>）。较长的专题笔记仍可直接 Write/Edit 为独立 .md 文件。

${sections.join('\n\n')}
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

  // scope → 目标目录。own/shared 是历史值；machine/cli/task/skill 是五层扩展。
  // task 需要 taskId（默认取 classify 维护的当前任务）；skill 需要 skill 名。
  function scopeDir(persisted, scope, extra) {
    const opts = extra || {};
    switch (scope) {
      case 'shared': return sharedDir(persisted.dirId);
      case 'machine': return machineDir();
      case 'cli': return cliDir(opts.cli || persisted.cli);
      case 'task': {
        const taskId = opts.taskId
          || (persisted.taskState && persisted.taskState.taskId)
          || opts.fallbackTaskId;
        return taskId ? taskDir(persisted.dirId, taskId) : null;
      }
      case 'skill': {
        const skill = opts.skill;
        return skill ? skillDir(persisted.dirId, skill) : null;
      }
      default: return sessionDir(persisted);
    }
  }

  function curatedLimit(scope) {
    switch (scope) {
      case 'shared': return SHARED_CURATED_MEM_CAP;
      case 'machine': return MACHINE_CURATED_MEM_CAP;
      case 'cli': return CLI_CURATED_MEM_CAP;
      case 'task': return TASK_CURATED_MEM_CAP;
      case 'skill': return SKILL_CURATED_MEM_CAP;
      default: return SESSION_CURATED_MEM_CAP;
    }
  }

  function resolveRolePrompt(persisted, { managed = false } = {}) {
    if (!persisted) return null;
    let base = persisted.rolePrompt;
    if (!base) {
      const directory = persisted.dirId ? deps.directories.get(persisted.dirId) : null;
      base = (directory && directory.rolePrompt) || null;
    }
    const parts = [];
    if (base) parts.push(base);
    const folderBlock = managed ? null : buildBlock(persisted);
    if (folderBlock) parts.push(folderBlock);
    return parts.length ? parts.join('\n\n') : null;
  }

  // Upgrade every registered project, including ones without an active session.
  for (const dirId of deps.directories.keys()) ensureShared(dirId);

  return Object.freeze({
    retrieve(persisted, query) {
      ensureDirs(persisted);
      return require('./retrieval').retrieveMemory(deps.memoryStoreRoot,
        { machineDir, cliDir, sharedDir, taskDir, sessionDir, skillDir, safeSegment }, persisted, query);
    },
    guidance(persisted) {
      return `记忆文件位于 ${deps.memoryStoreRoot}，作用域：_machine、_cli/${persisted.cli}、${persisted.dirId}/_shared、${persisted.dirId}/tasks/${persisted.taskBoundTaskId || persisted.taskState?.taskId}、${persisted.dirId}/sessions/${persisted.id}、${persisted.dirId}/skills。只按需读取已授权作用域。保存稳定事实用 POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action，JSON {"action":"add","scope":"own|shared|task|skill|machine|cli","content":"事实"}；replace/remove 使用 oldText，skill 使用 skill 参数。`;
    },
    buildBlock,
    cliDir,
    curatedLimit,
    ensureDirs,
    ensureShared,
    listFiles,
    machineDir,
    primaryFileName,
    resolveRolePrompt,
    safeFileName,
    safeSegment,
    scopeDir,
    sessionDir,
    sharedDir,
    skillDir,
    taskDir,
    writeAutoFile,
  });
}

module.exports = {
  SESSION_MEM_CAP,
  SHARED_MEM_CAP,
  TASK_MEM_CAP,
  CLI_MEM_CAP,
  MACHINE_MEM_CAP,
  SESSION_CURATED_MEM_CAP,
  SHARED_CURATED_MEM_CAP,
  TASK_CURATED_MEM_CAP,
  SKILL_CURATED_MEM_CAP,
  CLI_CURATED_MEM_CAP,
  MACHINE_CURATED_MEM_CAP,
  createFolderMemoryService,
};
