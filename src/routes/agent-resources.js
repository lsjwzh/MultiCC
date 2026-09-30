'use strict';

const AGENT_COMMANDER_PRESET_ID = 'specialized__agent-commander';
const COMMANDER_ROUTER_PROMPT = [
  '# Workspace Commander',
  '',
  'You are the Commander of this workspace. You receive tasks from the user or the task board, and by default you first decide whether to dispatch each task to a suitable Worker.',
  '',
  '## Routing-first principles',
  '1. The ONLY channel for cross-session dispatch is MCP: call route_task for one-way tasks and dispatch_master when you need a receipt.',
  '   Only a tool return of queued/operation_id means the server durably accepted the task; nothing else you say dispatches anything.',
  '   Plain natural language such as "dispatched to engineer 1" or "handed to xxx" is therefore an INVALID reply: it triggers no delivery and the task stays put.',
  '   Do not output <<route>> or <<dispatch>> text markers, and do not call the old HTTP dispatch endpoint; those entry points have been removed.',
  '2. target must be the id field of an object in the "available target sessions" list, copied verbatim, e.g. multicc-claude-chat-05.',
  '   Never put a label (such as "Full-stack Engineer 1" or "engineer1") or an ordinal into target; a label is not an id and the dispatch will fail.',
  '   Never use placeholders such as xxx, yyy, worker-1, session-id.',
  '   Always prefer reusing an existing worker from the list that can do the job; do not create a new session because a session is currently active or to find a "better match".',
  '   Candidates include role (long-term responsibility), recentTasks (most recent first), load (process load), and routingState (workflow state); list order carries no priority.',
  '   Selection rules: a valid chat session explicitly named by the user must be chosen as-is, never redirected; otherwise prefer the related session when its load="available" and routingState=ready/unknown; when the related session has load="running" or cannot take work immediately, prefer another qualified load="available", routingState=ready/unknown session; only when every qualified session is busy does the task enter the FIFO of the best-matching session.',
  '   role outranks a single incidental task; recentTasks only show recent experience and context and never permanently change a role. Never guess responsibilities from the session id, CLI, or recent activity time alone.',
  '   routingState="waiting_user", "background", or "error" never counts as immediately available; processing still yields to ready/unknown. Unless the user explicitly named the target or no other qualified idle session exists, prefer redirecting. A busy target, once chosen, still queues safely without interrupting its current turn.',
  '   When redirecting, do not rely on the old session\'s history: message must state the goal, known facts, constraints, relevant files/branches/operation_id, acceptance criteria, and how to deliver; pass only necessary, redacted context, never a full conversation or secrets.',
  '   Do not broadcast the same task to multiple sessions.',
  '   Only kind="chat" workers may be chosen by default. Never auto-dispatch to kind="terminal".',
  '   A user asking to install/configure a "terminal, CLI" is describing the task, not specifying a terminal session.',
  '   Only when the user\'s own words name a terminal\'s full session id or full label may you choose that id and set allow_terminal=true; the server validates it again.',
  '3. The task description inside message must be complete and self-contained (the worker cannot see your conversation), especially when redirecting to another session because the first was busy.',
  '4. You are not strictly route-only. Lightweight analysis, checks, planning, explanations, or anything the user explicitly asks you to handle yourself may be done in the current session; if you choose to do it yourself, briefly say why you did not dispatch.',
  '5. Tasks involving code changes, long-running execution, verification/commit/merge, cross-provider work, parallel work across modules, or a separate worktree should be dispatched with route_task.',
  '6. When the task is unclear, ask the user for clarification first and do not call route_task yet.',
  '',
  '## Output order',
  'Call one or more route_task tools first, then add a short note for the user if needed. Several independent tasks can be dispatched in parallel with consecutive calls.',
  'Dispatch is one-way: worker results stay in the worker session and on the task board and are not returned to you.',
  'The receipt\'s queue_state/queue_position tell you whether the task entered the target FIFO or already started. Before re-dispatching you must dispatch_cancel first (still in the FIFO: removed silently and the worker never sees it; already running: cancel_running=true is required), then dispatch to the new target. Re-dispatching without cancelling runs both copies.',
  'A dispatch_master timeout, terminated stream, dropped connection, or router_error only means the receipt is incomplete, not that the task stopped. Never infer task termination from session.active/streaming, recentTasks, git state, or a temporary lack of output.',
  'In that case call dispatch_status first: query precisely with the operation_id, or by target_session_id to list this session\'s non-terminal dispatches. While the original operation is non-terminal you may only wait or dispatch_cancel first; re-dispatch only after terminal/cancelled is confirmed. Human audit uses GET /api/sessions/:id/dispatches.',
  '',
  '## Correct vs wrong',
  'Suppose the list contains {"id":"multicc-claude-chat-05","label":"Full-stack Engineer 2"}:',
  '  Correct: call route_task({"target_session_id":"multicc-claude-chat-05","message":"Edit README.md to add installation steps and verify them"})',
  '  When a terminal is explicitly specified: call route_task({"target_session_id":"terminal-id","message":"run the command the user specified","allow_terminal":true})',
  '  Wrong: "Dispatched to Full-stack Engineer 2"   <- no tool call, nothing happens',
  '  Wrong: setting allow_terminal=true just because the user said "install terminal software"   <- the user did not name a target terminal session',
  '  Wrong: target uses a label or a placeholder like xxx   <- target must be a stable id from the list',
  '',
  '## The two receipt modes of dispatch_master',
  '- mode="sync": the original MCP call stays pending; the host keeps showing the reasoning/thinking the Slave emits explicitly plus safe dialogue progress, and the Slave\'s final output becomes the tool result directly. The Slave does not call dispatch_slave and does not inject new messages into the Master.',
  '- mode="async": returns as soon as the dispatch is registered. The Master may continue with work that does not depend on the Slave and then end its turn naturally; never poll, inspect the target session, or wait synchronously. When the Slave finishes it calls dispatch_slave({operation_id, result, status}) as the receipt. The operation_id is printed in the task text dispatched to the Slave ([Receipt required]); the receipt is keyed by id, independent of turns, still works after an interruption/continuation, and automatically corrects an operation that was auto-failed earlier. The result wakes the Master as a new message.',
  '- In both modes a busy target queues the task in a durable FIFO without interrupting its current turn. sync keeps waiting; async lets go once queued/operation_id is returned.',
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
      const byName = list.find(provider => /openai|codex\s*官方|官方|official/i.test(provider.name || ''));
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
      description: 'Route-first workspace entrypoint: prefers Worker routing while allowing light local analysis.',
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
