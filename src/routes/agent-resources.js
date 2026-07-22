'use strict';

const AGENT_COMMANDER_PRESET_ID = 'specialized__agent-commander';

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[agent-resources] dependencies are required');
  if (!deps.fs || !deps.presetsFile) throw new TypeError('[agent-resources] preset storage is required');
  if (!deps.providers || typeof deps.providers.listProviders !== 'function') {
    throw new TypeError('[agent-resources] providers.listProviders is required');
  }
  if (!deps.providerRouter || typeof deps.providerRouter.getProviderSummary !== 'function') {
    throw new TypeError('[agent-resources] providerRouter.getProviderSummary is required');
  }
  for (const name of ['listInstalledSkills', 'listClaudeHistory', 'removeClaudeHistorySession']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[agent-resources] ${name} is required`);
  }
  return deps;
}

function createAgentResourcesRoutes(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const now = deps.now || Date.now;
  let presetsCache = null;
  let presetsError = null;
  let mounted = false;

  function loadAgentPresets() {
    if (presetsCache || presetsError) return presetsCache;
    try {
      presetsCache = JSON.parse(deps.fs.readFileSync(deps.presetsFile, 'utf8'));
    } catch (error) {
      presetsError = error;
      presetsCache = null;
    }
    return presetsCache;
  }

  function resolveAgentPresetProviderId(preset) {
    const cli = preset && preset.defaultCli === 'claude' ? 'claude' : 'codex';
    const key = String((preset && preset.defaultProviderKey) || '').toLowerCase();
    const model = String((preset && preset.defaultModel) || '').trim();
    const list = deps.providers.listProviders(cli);
    if (key === 'openai-codex') {
      const byName = list.find(provider => /openai|codex\s*官方|官方/i.test(provider.name || ''));
      if (byName) return byName.id;
      const byModel = list.find(provider => (provider.modelOptions || []).includes('gpt-5.5')
        || (provider.modelOptions || []).some(item => /^gpt-/i.test(item)));
      return byModel ? byModel.id : null;
    }
    if (key === 'xf-maas-coding') {
      const byModel = list.find(provider => model && (provider.modelOptions || []).includes(model));
      if (byModel) return byModel.id;
      const byName = list.find(provider => /讯飞|xf|maas/i.test(provider.name || ''));
      return byName ? byName.id : null;
    }
    return null;
  }

  function enrichAgentPresetDefaults(preset) {
    if (!preset || typeof preset !== 'object') return preset;
    const defaultProviderId = resolveAgentPresetProviderId(preset);
    const cli = preset.defaultCli === 'claude' ? 'claude' : 'codex';
    const summary = defaultProviderId
      ? deps.providerRouter.getProviderSummary(cli, defaultProviderId)
      : null;
    const defaultProviderName = defaultProviderId
      ? ((summary && summary.name) || defaultProviderId)
      : null;
    return { ...preset, defaultProviderId, defaultProviderName };
  }

  function agentCommanderPreset() {
    const data = loadAgentPresets();
    return data && (data.presets || []).find(preset => preset.id === AGENT_COMMANDER_PRESET_ID) || null;
  }

  function agentCommanderPrompt() {
    const preset = agentCommanderPreset();
    return preset && preset.prompt ? preset.prompt : null;
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.delete !== 'function') {
      throw new TypeError('[agent-resources] Express-compatible app is required');
    }
    if (mounted) throw new Error('[agent-resources] routes already mounted');
    mounted = true;

    app.get('/api/agent-resources/skills', (req, res) => {
      const skills = deps.listInstalledSkills();
      res.json({
        skills,
        counts: {
          claude: skills.filter(skill => skill.provider === 'claude').length,
          codex: skills.filter(skill => skill.provider === 'codex').length,
        },
      });
    });

    app.get('/api/agent-presets', (req, res) => {
      const data = loadAgentPresets();
      if (!data) return res.status(500).json({ error: 'agent presets unavailable' });
      const presets = (data.presets || []).map(preset => {
        const { prompt, ...metadata } = enrichAgentPresetDefaults(preset);
        return metadata;
      });
      res.json({
        source: data.source,
        version: data.version,
        generatedAt: data.generatedAt,
        categories: data.categories || [],
        featured: data.featured || [],
        presets,
      });
    });

    app.get('/api/agent-presets/:id', (req, res) => {
      const data = loadAgentPresets();
      if (!data) return res.status(500).json({ error: 'agent presets unavailable' });
      const preset = (data.presets || []).find(item => item.id === req.params.id);
      if (!preset) return res.status(404).json({ error: 'not found' });
      res.json(enrichAgentPresetDefaults(preset));
    });

    app.get('/api/agent-resources/claude-sessions', (req, res) => {
      const sessions = deps.listClaudeHistory();
      res.json({
        sessions,
        count: sessions.length,
        totalSize: sessions.reduce((sum, session) => sum + session.size, 0),
        protectedCount: sessions.filter(session => session.linked).length,
      });
    });

    app.delete('/api/agent-resources/claude-sessions/:project/:id', (req, res) => {
      try {
        const result = deps.removeClaudeHistorySession(req.params.project, req.params.id);
        if (!result.ok) {
          return res.status(result.error.includes('protected') ? 409 : 404).json({ error: result.error });
        }
        res.json(result);
      } catch (error) {
        if (typeof deps.reportError === 'function') {
          try { deps.reportError(error, { operation: 'claude_history_delete' }); } catch (_) {}
        }
        res.status(500).json({ error: 'history delete failed' });
      }
    });

    app.delete('/api/agent-resources/claude-sessions', (req, res) => {
      const olderThanDays = Number(req.query.olderThanDays);
      if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
        return res.status(400).json({ error: 'olderThanDays must be at least 1' });
      }
      const cutoff = now() - olderThanDays * 86400 * 1000;
      let deleted = 0;
      let freed = 0;
      for (const session of deps.listClaudeHistory()) {
        const updatedAt = new Date(session.updatedAt).getTime();
        if (session.linked || !Number.isFinite(updatedAt) || updatedAt >= cutoff) continue;
        try {
          const result = deps.removeClaudeHistorySession(session.project, session.id);
          if (result.ok) {
            deleted += 1;
            freed += result.freed;
          }
        } catch (_) {}
      }
      res.json({ ok: true, deleted, freed });
    });
  }

  return Object.freeze({
    agentCommanderPreset,
    agentCommanderPrompt,
    mountRoutes,
  });
}

module.exports = {
  AGENT_COMMANDER_PRESET_ID,
  createAgentResourcesRoutes,
};
