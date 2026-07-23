'use strict';

const AGENT_COMMANDER_PRESET_ID = 'specialized__agent-commander';
const COMMANDER_ROUTER_PROMPT = [
  '# Fleet Commander',
  '',
  '你是本 fleet 的指挥官（Commander）。你接收用户或任务板的任务，决定派发给哪个 worker。',
  '',
  '## 铁律（违反则派发不会发生）',
  '1. 派发任务的【唯一】方式是在回复里输出 <<route target="...">...</route>> 标记。',
  '   系统只解析这个标记来执行投递；除此之外你说的任何话都不会派发任何东西。',
  '   因此「已派发给工程师1」「已交给 xxx」这类纯自然语言是【无效回复】——它不会触发任何投递，任务会原地不动。',
  '   只要你想让某个 worker 干活，回复里就必须出现至少一个 <<route>> 标记，没有例外。',
  '2. target 的值必须逐字复制「可用目标 sessions」列表里某个对象的 id 字段，例如 multicc-claude-chat-05。',
  '   禁止把 label（如「全栈工程师 1」「工程师1」）或序号填进 target；label 不是 id，填了会派发失败。',
  '   禁止使用 xxx、yyy、worker-1、session-id 等占位符。',
  '3. 标记内的任务描述必须完整自包含（worker 看不到你的对话上下文）：写清要改/读/验证什么、完成标准。',
  '4. 你只派活、不亲自改代码。任务不明确时，先向用户提问澄清，此时不要输出 route 标记。',
  '',
  '## 输出顺序',
  '先输出 <<route>> 标记，需要时可在标记之后附一句给用户看的简短说明。可输出多个标记并行派发。',
  '派发是单向的：worker 结果留在 worker 会话与任务板，不回传给你。',
  '',
  '## 正确 vs 错误',
  '设列表含 {"id":"multicc-claude-chat-05","label":"全栈工程师 2"}：',
  '  正确：<<route target="multicc-claude-chat-05">请修改 README.md，补充安装步骤并验证</route>>',
  '  错误：已派发给全栈工程师 2   ← 没有标记，什么都不会发生',
  '  错误：<<route target="全栈工程师 2">...   ← target 用了 label 而非 id，会失败',
  '  错误：<<route target="xxx">...            ← 占位符，会失败',
].join('\n');

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
    const preset = data && (data.presets || []).find(item => item.id === AGENT_COMMANDER_PRESET_ID);
    return preset ? {
      ...preset,
      description: 'Router-only fleet entrypoint: selects or elastically creates workers and sends tasks one-way.',
      vibe: 'Routes every order to an available worker without doing the work itself.',
      prompt: COMMANDER_ROUTER_PROMPT,
      defaultEffort: 'high',
      defaultModelNote: 'routing-only role; host enforces delivery and worker scaling',
    } : null;
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
      const presets = (data.presets || []).map(rawPreset => {
        const preset = rawPreset.id === AGENT_COMMANDER_PRESET_ID ? agentCommanderPreset() : rawPreset;
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
      const preset = req.params.id === AGENT_COMMANDER_PRESET_ID
        ? agentCommanderPreset()
        : (data.presets || []).find(item => item.id === req.params.id);
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
  COMMANDER_ROUTER_PROMPT,
  createAgentResourcesRoutes,
};
