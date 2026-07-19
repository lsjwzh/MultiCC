'use strict';

const { createSessionQueryService, createWorkspaceService } = require('../session');

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`[session-admin] ${name} must be a function`);
}

function assertMapLike(value, name) {
  if (!value || typeof value.get !== 'function') {
    throw new TypeError(`[session-admin] ${name} must expose get()`);
  }
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[session-admin] dependencies are required');
  for (const name of ['records', 'terminalSessions', 'chatSessions', 'directories']) {
    assertMapLike(deps[name], name);
  }
  if (typeof deps.records.values !== 'function') {
    throw new TypeError('[session-admin] records must expose values()');
  }
  if (typeof deps.directories.values !== 'function') {
    throw new TypeError('[session-admin] directories must expose values()');
  }
  for (const name of [
    'cwdForSession', 'chatLastActivity', 'effectiveSessionModel', 'effectiveSessionEffort',
    'serializeSubagent', 'mergeStateCached', 'cliStateSummary', 'cliHandoffSummary',
    'cliAvailabilitySummary', 'getInvalidSession', 'getWorkspaceStatus',
    'getSessionSummary', 'getTaskState', 'pendingNotesFor', 'getAuxRuntime',
    'loadChatHistory', 'isInjectedOrJunkGoal', 'buildClassifySystemPrompt',
    'buildClassifyConversation', 'parseClassifyResult', 'dispatchStateAction',
    'runClassifyNow', 'createErrorDto', 'requestContext', 'withApiMeta',
  ]) assertFunction(deps[name], name);
  return deps;
}

function assistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text || ''))
    .join(' ');
}

function latestAssistant(history, minLength = 20) {
  const source = Array.isArray(history) ? history : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!message || message.role !== 'assistant'
        || (typeof message.content !== 'string' && !Array.isArray(message.content))) continue;
    const text = assistantText(message);
    if (text.length >= minLength) return { text, ts: message.ts || null };
  }
  return { text: '', ts: null };
}

function latestStringAssistant(history, minLength = 20) {
  const source = Array.isArray(history) ? history : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (message?.role !== 'assistant' || typeof message.content !== 'string') continue;
    if (message.content.length >= minLength) return message.content;
  }
  return '';
}

function createSessionAdminRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);

  const sessionQuery = createSessionQueryService({
    records: {
      list: () => deps.records.values(),
      get: id => deps.records.get(id),
    },
    runtime: {
      read: (id, record) => {
        const terminal = deps.terminalSessions.get(id);
        const chat = deps.chatSessions.get(id);
        const kind = record.kind || 'terminal';
        const isChat = kind === 'chat';
        const chatActive = !!chat && (chat.clients.size > 0 || chat.isStreaming);
        const chatActivity = isChat ? deps.chatLastActivity(id, chat) : null;
        return {
          cwd: isChat ? deps.cwdForSession(record) : (terminal ? terminal.cwd : record.cwd),
          sessionCwd: deps.cwdForSession(record),
          createdAt: terminal ? terminal.createdAt : record.createdAt,
          terminalActive: !!terminal,
          terminalLastActivity: terminal ? terminal.lastActivity : null,
          terminalClients: terminal ? terminal.clients.size : 0,
          chatActive,
          chatLastActivity: chatActivity,
          chatClients: chat ? chat.clients.size : 0,
          effectiveModel: deps.effectiveSessionModel(record),
          effectiveEffort: deps.effectiveSessionEffort(record),
          subagent: deps.serializeSubagent(record.subagent),
          lastActivity: isChat ? chatActivity : (terminal ? terminal.lastActivity : null),
          clients: isChat ? (chat ? chat.clients.size : 0) : (terminal ? terminal.clients.size : 0),
          active: isChat ? chatActive : !!terminal,
          mergeState: record.dirId
            ? deps.mergeStateCached(deps.directories.get(record.dirId), record)
            : null,
        };
      },
    },
  });

  const sessionWorkspace = createWorkspaceService({
    sessionQuery,
    directories: {
      list: () => deps.directories.values(),
      get: id => deps.directories.get(id),
    },
    workspaceFacts: {
      read: id => {
        const status = deps.getWorkspaceStatus(id) || {
          status: 'idle', lastActivity: 0, runStartedAt: null, runEndedAt: null,
        };
        const summary = deps.getSessionSummary(id) || null;
        const task = deps.getTaskState(deps.records.get(id));
        return {
          ...status,
          currentFile: status.currentFile || null,
          pendingNotes: deps.pendingNotesFor(id).length,
          summary: summary?.summary || null,
          summaryAt: summary?.ts || null,
          classifyState: task.classifyState || null,
          goal: task.goal || '',
          phase: task.phase || 'idle',
        };
      },
    },
  });

  function legacySessionListPresenter({ record, runtime }) {
    const useChatRuntime = record.kind === 'chat' || !runtime.terminalActive;
    return {
      id: record.id,
      dirId: record.dirId || null,
      cli: record.cli || 'claude',
      kind: record.kind || 'terminal',
      cliSessionId: record.cliSessionId || null,
      label: record.label || null,
      model: record.model || null,
      effectiveModel: runtime.effectiveModel,
      effort: record.effort || null,
      effectiveEffort: runtime.effectiveEffort,
      agent: record.agent || null,
      rolePrompt: record.rolePrompt || null,
      provider: record.provider || null,
      subagent: runtime.subagent,
      autoCommit: !!record.autoCommit,
      autoDispatch: !!record.autoDispatch,
      cliStates: deps.cliStateSummary(record),
      pendingCliHandoff: deps.cliHandoffSummary(record),
      cwd: runtime.sessionCwd,
      createdAt: record.createdAt,
      mergeState: runtime.mergeState,
      lastActivity: record.kind === 'chat'
        ? runtime.chatLastActivity
        : runtime.terminalLastActivity,
      clients: useChatRuntime ? runtime.chatClients : runtime.terminalClients,
      active: useChatRuntime ? runtime.chatActive : true,
    };
  }

  function legacyDirectorySessionPresenter({ record, runtime }) {
    const useTerminalRuntime = record.kind === 'terminal';
    return {
      id: record.id,
      dirId: record.dirId,
      cli: record.cli,
      kind: record.kind,
      cliSessionId: record.cliSessionId || null,
      label: record.label || null,
      model: record.model || null,
      effort: record.effort || null,
      effectiveEffort: runtime.effectiveEffort,
      agent: record.agent || null,
      rolePrompt: record.rolePrompt || null,
      provider: record.provider || null,
      subagent: runtime.subagent,
      cliStates: deps.cliStateSummary(record),
      pendingCliHandoff: deps.cliHandoffSummary(record),
      createdAt: record.createdAt,
      branch: record.branch || null,
      worktreePath: record.worktreePath || null,
      invalid: deps.getInvalidSession(record.id) || null,
      mergeState: runtime.mergeState,
      lastActivity: record.kind === 'chat'
        ? runtime.chatLastActivity
        : runtime.terminalLastActivity,
      active: useTerminalRuntime ? runtime.terminalActive : runtime.chatActive,
      clients: useTerminalRuntime ? runtime.terminalClients : runtime.chatClients,
    };
  }

  function dashboardSessionPresenter({ record, runtime }) {
    const task = deps.getTaskState(record);
    return {
      id: record.id,
      label: record.label || null,
      cli: record.cli || 'claude',
      kind: record.kind || 'terminal',
      active: !!runtime.active,
      createdAt: record.createdAt || null,
      lastActivity: runtime.lastActivity,
      classifyState: task.classifyState || null,
      goal: task.goal || '',
      phase: task.phase || 'idle',
    };
  }

  function legacyWorkspacePresenter({ session, facts }) {
    const record = session.record;
    const runtime = session.runtime;
    return {
      id: record.id,
      label: record.label || null,
      cli: record.cli || 'claude',
      kind: record.kind || 'terminal',
      branch: record.branch || null,
      invalid: deps.getInvalidSession(record.id) || null,
      status: facts.status,
      currentFile: facts.currentFile || null,
      lastActivity: facts.lastActivity,
      runStartedAt: facts.runStartedAt || null,
      runEndedAt: facts.runEndedAt || null,
      clients: runtime.clients || 0,
      pendingNotes: facts.pendingNotes,
      mergeState: runtime.mergeState,
      summary: facts.summary || null,
      summaryTs: facts.summaryAt || null,
      classifyState: facts.classifyState || null,
      goal: facts.goal || '',
      phase: facts.phase || 'idle',
    };
  }

  function legacySessionDetailPresenter({ record, runtime }) {
    const cli = record.cli || 'claude';
    const isClaudeChat = cli !== 'codex' && cli !== 'opencode' && cli !== 'zcode'
      && record.kind !== 'terminal';
    return {
      id: record.id,
      cwd: runtime.cwd,
      createdAt: runtime.createdAt,
      lastActivity: runtime.lastActivity,
      clients: runtime.clients || 0,
      active: !!runtime.active,
      mergeState: runtime.mergeState,
      cli,
      model: record.model || null,
      effectiveModel: runtime.effectiveModel,
      effort: record.effort || null,
      effectiveEffort: runtime.effectiveEffort,
      agent: record.agent || null,
      rolePrompt: record.rolePrompt || null,
      memory: record.memory || null,
      provider: record.provider || null,
      subagent: runtime.subagent,
      cliStates: deps.cliStateSummary(record),
      cliAvailability: deps.cliAvailabilitySummary(),
      pendingCliHandoff: deps.cliHandoffSummary(record),
      streaming: isClaudeChat,
      autoContinue: record.autoContinue !== false,
      autoCommit: !!record.autoCommit,
      autoDispatch: !!record.autoDispatch,
    };
  }

  function workspaceContractView(snapshot) {
    return {
      directory: snapshot.directory,
      sessions: snapshot.sessions.map(entry => {
        const {
          status, statusUpdatedAt, runStartedAt, runEndedAt, pendingNotes,
          summary, summaryAt, classifyState, goal, phase, ...session
        } = entry;
        return {
          session, status, statusUpdatedAt, runStartedAt, runEndedAt,
          pendingNotes, summary, summaryAt, classifyState, goal, phase,
        };
      }),
      count: snapshot.count,
    };
  }

  function v1Error(req, res, status, message, code) {
    return res.status(status).json(deps.createErrorDto({
      ...deps.requestContext(req, res), message, code,
    }));
  }

  function auxRuntime() {
    const runtime = deps.getAuxRuntime();
    if (!runtime || !runtime.queue) throw new Error('[session-admin] aux runtime unavailable');
    return runtime;
  }

  function enqueueClassification(sessionId, record, reply) {
    const queue = auxRuntime().queue;
    const task = deps.getTaskState(record);
    const cleanPrior = deps.isInjectedOrJunkGoal(task.goal) ? '' : (task.goal || '');
    queue.enqueue({
      type: 'intent_classify',
      systemPrompt: deps.buildClassifySystemPrompt(cleanPrior),
      prompt: deps.buildClassifyConversation(sessionId, reply),
      meta: { sid: sessionId, manual: true },
    }).then(result => {
      if (result.cancelled) return;
      const parsed = deps.parseClassifyResult(result.text);
      const chat = deps.chatSessions.get(sessionId);
      const persistedId = deps.records.get(sessionId)?.id || sessionId;
      deps.dispatchStateAction(parsed, {
        sessionName: sessionId,
        sessionId: persistedId,
        cs: chat,
        isTerminal: false,
      });
    }).catch(error => {
      if (error && error.cancelled) return;
    });
  }

  function classificationReply(sessionId) {
    try {
      return latestStringAssistant(deps.loadChatHistory(sessionId), 20);
    } catch (_) {
      // Preserve the legacy admin contract: an unreadable history behaves like
      // an empty one for a single request and cannot abort a bulk reclassify pass.
      return '';
    }
  }

  function workspaceSnapshot(dirId) {
    const snapshot = sessionWorkspace.snapshot(dirId, { presenter: legacyWorkspacePresenter });
    return snapshot ? snapshot.sessions : [];
  }

  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
      throw new TypeError('[session-admin] Express app is required');
    }

    app.get('/api/v1/sessions', (req, res) => {
      const list = sessionQuery.list();
      res.json(deps.withApiMeta(
        { sessions: list, count: list.length },
        deps.requestContext(req, res),
      ));
    });

    app.get('/api/v1/sessions/:id', (req, res) => {
      const session = sessionQuery.get(req.params.id);
      if (!session) return v1Error(req, res, 404, 'session not found', 'session_not_found');
      return res.json(deps.withApiMeta({ session }, deps.requestContext(req, res)));
    });

    app.get('/api/v1/directories/:id/workspace', (req, res) => {
      const snapshot = sessionWorkspace.snapshot(req.params.id);
      if (!snapshot) return v1Error(req, res, 404, 'directory not found', 'directory_not_found');
      return res.json(deps.withApiMeta(
        { workspace: workspaceContractView(snapshot) },
        deps.requestContext(req, res),
      ));
    });

    app.get('/api/sessions', (req, res) => {
      const list = sessionQuery.list({ presenter: legacySessionListPresenter });
      const aux = auxRuntime();
      const record = deps.records.get(aux.id);
      if (record) {
        list.unshift({
          id: aux.id,
          cwd: record.cwd,
          createdAt: record.createdAt,
          lastActivity: aux.queue.lastTaskTime ? new Date(aux.queue.lastTaskTime) : null,
          clients: aux.queue.clients.size,
          active: aux.queue.processing,
          type: 'aux',
          label: record.label || 'AI Assistant',
          auxStatus: aux.queue.getStatus(),
        });
      }
      res.json(list);
    });

    app.get('/api/dashboard/sessions', (req, res) => {
      const { kind, active: activeParam } = req.query;
      const filterActive = activeParam === undefined ? null : activeParam === 'true';
      const list = sessionQuery.list({
        filter: record => !kind || (record.kind || 'terminal') === kind,
        presenter: dashboardSessionPresenter,
      }).filter(session => filterActive === null || session.active === filterActive);
      res.json({ sessions: list, count: list.length });
    });

    app.get('/api/dashboard/stats', (req, res) => {
      const all = sessionQuery.listContexts();
      let active = 0;
      const byCli = {};
      const byKind = {};
      for (const { record, runtime } of all) {
        const cli = record.cli || 'claude';
        const kind = record.kind || 'terminal';
        byCli[cli] = (byCli[cli] || 0) + 1;
        byKind[kind] = (byKind[kind] || 0) + 1;
        if (runtime.active) active += 1;
      }
      res.json({ total: all.length, active, byCli, byKind });
    });

    app.post('/api/sessions/:id/reclassify', (req, res) => {
      const record = deps.records.get(req.params.id);
      if (!record) return res.status(404).json({ error: 'session not found' });
      if (record.type === 'aux' || record.type === 'gateway') {
        return res.status(400).json({ error: 'not a chat session' });
      }
      const queue = auxRuntime().queue;
      if (queue.isUnhealthy()) return res.status(503).json({ error: 'aux 服务不可用，无法重判' });
      const task = deps.getTaskState(record);
      const force = String(req.query.force).toLowerCase() === 'true';
      if ((task.classifyState === 'D' || task.classifyState === 'W') && !force) {
        return res.json({
          ok: true,
          skipped: true,
          classifyState: task.classifyState,
          note: `会话状态为 ${task.classifyState}，跳过重判（需用户发新消息触发，或 ?force=true 强制）`,
        });
      }
      const reply = classificationReply(req.params.id);
      if (reply.length < 20) {
        return res.status(400).json({ error: 'no assistant reply to classify against' });
      }
      enqueueClassification(req.params.id, record, reply);
      return res.json({ ok: true, note: 'reclassify enqueued; 状态更新会通过 WS 异步到达' });
    });

    app.post('/api/reclassify-all', (req, res) => {
      const queue = auxRuntime().queue;
      if (queue.isUnhealthy()) return res.status(503).json({ error: 'aux 服务不可用，无法重判' });
      const onlyJunk = req.body?.onlyJunk !== false;
      const ids = [];
      for (const [sessionId, record] of deps.records) {
        if (!record || record.type === 'aux' || record.type === 'gateway') continue;
        const task = deps.getTaskState(record);
        if (task.classifyState === 'D' || task.classifyState === 'W') continue;
        if (onlyJunk && !deps.isInjectedOrJunkGoal(task.goal)) continue;
        const reply = classificationReply(sessionId);
        if (reply.length < 20) continue;
        enqueueClassification(sessionId, record, reply);
        ids.push(sessionId);
      }
      return res.json({ ok: true, count: ids.length, ids, onlyJunk });
    });

    app.get('/api/directories/:id/sessions', (req, res) => {
      const directory = deps.directories.get(req.params.id);
      if (!directory) return res.status(404).json({ error: 'directory not found' });
      const sessions = sessionQuery.list({
        dirId: directory.id,
        includeHidden: true,
        presenter: legacyDirectorySessionPresenter,
      });
      return res.json({ directory, sessions });
    });

    app.get('/api/directories/:id/workspace', (req, res) => {
      const directory = deps.directories.get(req.params.id);
      if (!directory) return res.status(404).json({ error: 'directory not found' });
      return res.json({ directory, sessions: workspaceSnapshot(directory.id) });
    });

    app.get('/api/sessions/:id', (req, res) => {
      const detail = sessionQuery.get(req.params.id, {
        includeHidden: true,
        presenter: legacySessionDetailPresenter,
      });
      if (!detail) return res.status(404).json({ error: 'Session not found' });
      return res.json(detail);
    });

    app.post('/api/debug/classify/:id', (req, res) => {
      const sessionName = req.params.id;
      const record = deps.records.get(sessionName);
      if (!record) return res.status(404).json({ error: 'session not found' });
      const history = deps.loadChatHistory(sessionName);
      if (!history.length) return res.status(400).json({ error: 'no history' });
      const latest = latestAssistant(history, 0);
      if (!latest.text || latest.text.length < 20) {
        return res.status(400).json({ error: 'no valid assistant text', len: latest.text.length });
      }
      const chat = deps.chatSessions.get(sessionName);
      if (!chat) return res.status(400).json({ error: 'session not active' });
      const task = deps.getTaskState(record);
      const force = String(req.query.force).toLowerCase() === 'true';
      if ((task.classifyState === 'D' || task.classifyState === 'W') && !force) {
        return res.status(409).json({
          error: `session is ${task.classifyState}; use ?force=true to override`,
          classifyState: task.classifyState,
        });
      }
      chat.currentAssistantText = latest.text;
      const unhealthy = auxRuntime().queue.isUnhealthy();
      deps.runClassifyNow(chat, sessionName);
      const tail = latest.text.slice(-1500);
      return res.json({
        ok: true,
        sessionName,
        triggered: !unhealthy,
        tailPreview: tail.slice(-300).replace(/\n/g, ' '),
        note: unhealthy
          ? 'aux unhealthy — classify suppressed (⑦ gate), no RESULT will be logged'
          : 'classify enqueued — check server logs for classify RESULT',
      });
    });

    app.get('/api/debug/classify-test-cases', (req, res) => {
      const cases = [];
      for (const [sessionId, record] of deps.records) {
        if (!record || record.type === 'aux' || record.type === 'gateway' || record.kind !== 'chat') continue;
        const latest = latestAssistant(deps.loadChatHistory(sessionId), 0);
        if (!latest.text || latest.text.length < 40) continue;
        const tail = latest.text.slice(-1500);
        const task = record.taskState || {};
        cases.push({
          sessionId,
          label: record.label || '',
          classifyState: task.classifyState || null,
          goal: task.goal || '',
          summary: record.summary || '',
          lastAssistantTail300: tail.slice(-300),
          lastAssistantFullTail: tail,
          lastActivity: record.lastActivity || null,
          lastTs: latest.ts ? new Date(latest.ts).toISOString() : null,
        });
      }
      cases.sort((left, right) => (right.lastTs || '').localeCompare(left.lastTs || ''));
      return res.json({ count: cases.length, cases });
    });
  }

  return Object.freeze({
    mountRoutes,
    sessionQuery,
    sessionWorkspace,
    workspaceSnapshot,
  });
}

module.exports = {
  assistantText,
  latestAssistant,
  latestStringAssistant,
  createSessionAdminRuntime,
};
