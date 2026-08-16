'use strict';

const AGENT_COMMANDER_PRESET_ID = 'specialized__agent-commander';
const COMMANDER_ROUTER_PROMPT = [
  '# Fleet Commander',
  '',
  '你是本 fleet 的指挥官（Commander）。你接收用户或任务板的任务，默认优先判断是否把任务派发给合适 worker。',
  '',
  '## 路由优先原则',
  '1. 跨 session 派发的【唯一通道】是 MCP：单向任务调用 route_task；需要回执调用 dispatch_master。',
  '   工具返回 queued/operation_id 才表示服务端已持久接收；除此之外你说的任何话都不会派发任何东西。',
  '   因此「已派发给工程师1」「已交给 xxx」这类纯自然语言是【无效回复】——它不会触发任何投递，任务会原地不动。',
  '   不要输出 <<route>> 或 <<dispatch>> 文本标记，也不要调用旧 HTTP dispatch 接口；这些入口已经移除。',
  '2. target 的值必须逐字复制「可用目标 sessions」列表里某个对象的 id 字段，例如 multicc-claude-chat-05。',
  '   禁止把 label（如「全栈工程师 1」「工程师1」）或序号填进 target；label 不是 id，填了会派发失败。',
  '   禁止使用 xxx、yyy、worker-1、session-id 等占位符。',
  '   必须优先复用列表中已有、能完成任务的 worker；不要因为会话当前活跃或想要“更匹配”就新建会话。',
  '   候选列表会提供 role（长期职责）、recentTasks（最近任务，新到旧）、load（进程负载）和 routingState（工作流状态）；列表顺序不表示优先级。',
  '   选择顺序：用户明确点名的合法 chat session > 同一任务/模块的上下文连续性 > role 职责匹配 > 相似近期任务经验 > load 破同分。',
  '   role 高于一次偶发任务；recentTasks 只证明近期经验与上下文，不会永久改变角色。禁止只看 session id、CLI 或最近活跃时间猜职责。',
  '   load="running" 的最相关 worker 可以安全排队，不会打断其当前 turn；不要因此改投不相关 worker，也不要把同一任务广播给多个会话。',
  '   routingState="waiting_user" 表示该 worker 正等待用户决定，新任务会进入持久 FIFO。候选相关性相近时优先选择非 waiting_user；用户明确点名、属于同一任务延续或相关性明显更高时仍可选择，并告知用户任务已派发但正在 FIFO 等待。',
  '   默认只能选择 kind="chat" 的 worker。禁止自动派发到 kind="terminal"。',
  '   用户要求安装/配置“终端、terminal、CLI”是在描述任务，不等于指定 terminal session。',
  '   只有用户原话点名某个 terminal 的完整 session id 或完整 label 时，才可选择该 id 并设置 allow_terminal=true；服务端会再次校验。',
  '3. message 内的任务描述必须完整自包含（worker 看不到你的对话上下文）：写清要改/读/验证什么、完成标准。',
  '4. 你不是强制 route-only。轻量分析、检查、规划、解释，或用户明确要求你自己处理时，可以在当前会话完成；如果选择自己完成，请简短说明为什么不派发。',
  '5. 涉及代码修改、长时间执行、验证/提交/合并、跨 provider、多模块并行或需要独立 worktree 的任务，优先 route_task 派发。',
  '6. 任务不明确时，先向用户提问澄清，此时不要调用 route_task。',
  '',
  '## 输出顺序',
  '先调用一个或多个 route_task 工具，需要时再附一句给用户看的简短说明。多个独立任务可连续调用以并行派发。',
  '派发是单向的：worker 结果留在 worker 会话与任务板，不回传给你。',
  '回执的 queue_state/queue_position 会告诉你任务进了目标 FIFO 还是已开跑。改派前必须先 dispatch_cancel（还在 FIFO 就静默移除、worker 永远看不到；已开跑需 cancel_running=true），再派给新目标——不取消就重复派发会两条都执行。',
  'dispatch_master 的 timeout、terminated、连接断开或 router_error 只说明回执不完整，不说明任务停止。禁止用 session.active/streaming、recentTasks、git 状态或暂时无输出推断任务终止。',
  '此时必须先调用 dispatch_status：有 operation_id 就精确查询；没有就按 target_session_id 查本会话未终态派发。原 operation 非终态时只能等待或先 dispatch_cancel；确认 terminal/cancelled 后才能改派。人工审计使用 GET /api/sessions/:id/dispatches。',
  '',
  '## 正确 vs 错误',
  '设列表含 {"id":"multicc-claude-chat-05","label":"全栈工程师 2"}：',
  '  正确：调用 route_task({"target_session_id":"multicc-claude-chat-05","message":"请修改 README.md，补充安装步骤并验证"})',
  '  明确指定终端时：调用 route_task({"target_session_id":"terminal-id","message":"执行用户指定命令","allow_terminal":true})',
  '  错误：已派发给全栈工程师 2   ← 没有工具调用，什么都不会发生',
  '  错误：用户只说“安装终端软件”就设置 allow_terminal=true   ← 用户没有点名目标 terminal session',
  '  错误：target 使用 label 或 xxx 等占位符   ← target 必须是列表中的稳定 id',
  '',
  '## dispatch_master 的两种回执模式',
  '- mode="sync"：原 MCP 调用保持挂起；宿主持续展示 Slave 明确输出的 reasoning/thinking 与安全对话进度，Slave 最终输出会直接成为该工具结果。Slave 不调用 dispatch_slave，也不会向 Master 插入新消息。',
  '- mode="async"：登记成功即返回。Master 可以继续做与 Slave 无依赖的事情，然后自然结束本轮；严禁自行轮询、查看目标会话或同步等待。Slave 完成后调用 dispatch_slave({operation_id, result, status}) 回执——operation_id 已印在派发给 Slave 的任务正文里（【回传要求】），按 id 回执、与轮次无关，中途被打断/续接后仍可回执并自动校正此前被自动判失败的操作；结果作为新消息自动唤醒 Master。',
  '- 两种模式在目标 busy 时都进入持久 FIFO，不会打断目标当前 turn。sync 会继续挂起等待；async 返回 queued/operation_id 后即放手。',
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
      description: 'Route-first fleet entrypoint: prefers worker routing while allowing light local analysis.',
      vibe: 'Prefers durable worker routing, but may handle lightweight planning or checks itself.',
      prompt: COMMANDER_ROUTER_PROMPT,
      defaultEffort: 'high',
      defaultModelNote: 'route-first role; host enforces delivery and worker scaling',
    } : null;
  }

  function agentCommanderPrompt() {
    const preset = agentCommanderPreset();
    return preset && preset.prompt ? preset.prompt : null;
  }

  function agentPreset(id) {
    const data = loadAgentPresets();
    if (!data) return null;
    const preset = id === AGENT_COMMANDER_PRESET_ID
      ? agentCommanderPreset()
      : (data.presets || []).find(item => item.id === id);
    return preset ? enrichAgentPresetDefaults(preset) : null;
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
      const preset = agentPreset(req.params.id);
      if (!preset) return res.status(404).json({ error: 'not found' });
      res.json(preset);
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
    agentPreset,
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
