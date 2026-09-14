'use strict';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-memory] dependencies are required');
  if (!deps.fs || !deps.path) throw new TypeError('[session-memory] filesystem dependencies are required');
  if (!deps.records || typeof deps.records.get !== 'function') {
    throw new TypeError('[session-memory] records.get is required');
  }
  const folder = deps.folderMemory;
  for (const name of [
    'ensureDirs', 'sessionDir', 'sharedDir', 'primaryFileName', 'listFiles',
    'safeFileName', 'scopeDir', 'curatedLimit', 'safeSegment',
  ]) {
    if (!folder || typeof folder[name] !== 'function') {
      throw new TypeError(`[session-memory] folderMemory.${name} is required`);
    }
  }
  for (const name of [
    'getMemoryEntries', 'scanMemoryContent', 'atomicWriteMemoryFile',
    'applyCuratedMemoryAction', 'appendEvent', 'workspaceBroadcast',
    'directoriesKeys',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[session-memory] ${name} is required`);
  }
  return deps;
}

function mountSessionMemoryRoutes(app, rawDeps) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function'
      || typeof app.delete !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[session-memory] Express app is required');
  }
  const deps = assertDependencies(rawDeps);
  const folder = deps.folderMemory;

  // scope 白名单：own/shared 是历史值；machine/cli/task/skill 是五层扩展。
  const CURATED_SCOPES = ['own', 'shared', 'machine', 'cli', 'task', 'skill'];
  const SCOPE_LABELS = {
    own: '私有', shared: '公共', machine: '机器全局', cli: 'CLI', task: '任务', skill: '技能',
  };

  function resolveCuratedScope(persisted, body) {
    const requested = String(body?.scope || 'own').trim().toLowerCase();
    if (!CURATED_SCOPES.includes(requested)) {
      return { error: `invalid scope (must be one of ${CURATED_SCOPES.join('/')})` };
    }
    const extra = {};
    if (requested === 'task') {
      // 默认挂到 classify 维护的当前任务；也允许显式传 taskId 指定历史任务。
      const explicit = folder.safeSegment(body?.taskId);
      const current = persisted.taskState && persisted.taskState.taskId;
      extra.taskId = explicit || (folder.safeSegment(current) ? current : null);
      if (!extra.taskId) return { error: 'task scope requires a current bound task or an explicit taskId' };
    }
    if (requested === 'skill') {
      const skill = folder.safeSegment(body?.skill);
      if (!skill) return { error: 'skill scope requires a skill name (safe word characters only)' };
      extra.skill = skill;
    }
    const dir = folder.scopeDir(persisted, requested, extra);
    if (!dir) return { error: `scope ${requested} resolves to no directory on this session` };
    return { scope: requested, dir, extra };
  }

  app.get('/api/sessions/:id/memory', (req, res) => {
    const persisted = deps.records.get(req.params.id);
    if (!persisted) return res.status(404).json({ error: 'session not found' });
    folder.ensureDirs(persisted);
    const own = folder.sessionDir(persisted);
    const shared = folder.sharedDir(persisted.dirId);
    return res.json({
      own: {
        dir: own,
        primary: folder.primaryFileName(persisted.cli),
        files: folder.listFiles(own),
      },
      shared: { dir: shared, files: folder.listFiles(shared) },
      machine: { dir: folder.machineDir(), files: folder.listFiles(folder.machineDir()) },
      cli: { dir: folder.cliDir(persisted.cli), files: folder.cliDir(persisted.cli) ? folder.listFiles(folder.cliDir(persisted.cli)) : [] },
      task: (() => {
        const taskId = persisted.taskState && persisted.taskState.taskId;
        const dir = taskId ? folder.taskDir(persisted.dirId, taskId) : null;
        return { taskId: taskId || null, dir, files: dir ? folder.listFiles(dir) : [] };
      })(),
      legacy: deps.getMemoryEntries(persisted),
    });
  });

  app.put('/api/sessions/:id/memory', (req, res) => {
    const persisted = deps.records.get(req.params.id);
    if (!persisted) return res.status(404).json({ error: 'session not found' });
    const { scope, name, content } = req.body || {};
    const selectedScope = scope === 'shared' ? 'shared' : 'own';
    const fileName = folder.safeFileName(name);
    if (!fileName) {
      return res.status(400).json({ error: 'invalid file name (must be a plain *.md name)' });
    }
    const body = String(content == null ? '' : content);
    if (body.length > 40000) {
      return res.status(400).json({ error: 'content too long (max 40000)' });
    }
    const threat = deps.scanMemoryContent(body);
    if (threat) return res.status(400).json({ error: `memory write blocked: ${threat}` });
    folder.ensureDirs(persisted);
    const dir = folder.scopeDir(persisted, selectedScope);
    try {
      deps.atomicWriteMemoryFile(deps.path.join(dir, fileName), body);
    } catch (error) {
      return res.status(500).json({ error: `write failed: ${error.message}` });
    }
    if (persisted.dirId) {
      deps.workspaceBroadcast(persisted.dirId, {
        type: 'memory', sessionId: persisted.id, scope: selectedScope,
      });
    }
    return res.json({ ok: true, files: folder.listFiles(dir) });
  });

  app.delete('/api/sessions/:id/memory', (req, res) => {
    const persisted = deps.records.get(req.params.id);
    if (!persisted) return res.status(404).json({ error: 'session not found' });
    const { scope, name } = req.body || {};
    const selectedScope = scope === 'shared' ? 'shared' : 'own';
    const fileName = folder.safeFileName(name);
    if (!fileName) return res.status(400).json({ error: 'invalid file name' });
    const dir = folder.scopeDir(persisted, selectedScope);
    try {
      deps.fs.unlinkSync(deps.path.join(dir, fileName));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return res.status(500).json({ error: `delete failed: ${error.message}` });
      }
    }
    if (persisted.dirId) {
      deps.workspaceBroadcast(persisted.dirId, {
        type: 'memory', sessionId: persisted.id, scope: selectedScope,
      });
    }
    return res.json({ ok: true, files: folder.listFiles(dir) });
  });

  app.post('/api/sessions/:id/memory/action', (req, res) => {
    const persisted = deps.records.get(req.params.id);
    if (!persisted) return res.status(404).json({ error: 'session not found' });
    if (persisted.type === 'aux' || persisted.type === 'gateway') {
      return res.status(400).json({ error: 'system sessions do not have curated memory' });
    }
    folder.ensureDirs(persisted);
    const resolved = resolveCuratedScope(persisted, req.body);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const scope = resolved.scope;
    const result = deps.applyCuratedMemoryAction({
      dir: resolved.dir,
      action: String(req.body?.action || '').trim().toLowerCase(),
      content: req.body?.content,
      oldText: req.body?.oldText,
      charLimit: folder.curatedLimit(scope),
    });
    if (!result.ok) return res.status(400).json(result);
    deps.appendEvent(
      persisted.dirId,
      'memory_updated',
      `${SCOPE_LABELS[scope] || scope}记忆：${result.message}`,
      persisted.id,
    );
    // 机器全局/CLI 层属于所有目录：向全部注册目录广播，让各工作区都能刷新视图。
    if (scope === 'machine' || scope === 'cli') {
      for (const dirId of deps.directoriesKeys()) {
        deps.workspaceBroadcast(dirId, { type: 'memory', sessionId: persisted.id, scope });
      }
    } else {
      deps.workspaceBroadcast(persisted.dirId, {
        type: 'memory', sessionId: persisted.id, scope,
      });
    }
    return res.json(result);
  });
}

module.exports = { assertDependencies, mountSessionMemoryRoutes };
