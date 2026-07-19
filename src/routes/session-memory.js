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
    'safeFileName', 'scopeDir', 'curatedLimit',
  ]) {
    if (!folder || typeof folder[name] !== 'function') {
      throw new TypeError(`[session-memory] folderMemory.${name} is required`);
    }
  }
  for (const name of [
    'getMemoryEntries', 'scanMemoryContent', 'atomicWriteMemoryFile',
    'applyCuratedMemoryAction', 'appendEvent', 'workspaceBroadcast',
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
    const scope = req.body?.scope === 'shared' ? 'shared' : 'own';
    const result = deps.applyCuratedMemoryAction({
      dir: folder.scopeDir(persisted, scope),
      action: String(req.body?.action || '').trim().toLowerCase(),
      content: req.body?.content,
      oldText: req.body?.oldText,
      charLimit: folder.curatedLimit(scope),
    });
    if (!result.ok) return res.status(400).json(result);
    deps.appendEvent(
      persisted.dirId,
      'memory_updated',
      `${scope === 'shared' ? '公共' : '私有'}记忆：${result.message}`,
      persisted.id,
    );
    deps.workspaceBroadcast(persisted.dirId, {
      type: 'memory', sessionId: persisted.id, scope,
    });
    return res.json(result);
  });
}

module.exports = { assertDependencies, mountSessionMemoryRoutes };
