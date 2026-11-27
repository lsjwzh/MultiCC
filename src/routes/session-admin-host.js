'use strict';

// 宿主端口：session-admin 的 13 条公开路由已由 Rust 前门独占。
// 路径匹配、参数解码、publicSessionAccessGuard 的两种 404 形态、DTO 字段顺序、
// 过滤/分页语义、错误信封与状态码决策树见 native/gateway/src/app/session_admin.rs
// 与 native/core/src/session_admin.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   records / directories  进程内的会话与目录 Map
//   readSessionRuntime     终端/聊天运行时快照（clients、isStreaming、mergeState）
//   sessionView            工作区事实（状态、摘要、classifyState、goal…）
//   getTaskState/setTaskState  classify 状态机读取与唯一的写入入口
//   dispatchStateAction    「标记执行成功」的 D 动作与广播
//   runClassifyNow         把回复塞进 chat 后触发一次重判
//   chat history           转录读取（本机可能抛错，映射成 failed 标志）
//   aux runtime            AI 助手的队列状态
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { GOAL_STATES } = require('../classify/vocab');
const { providerSelectionDto } = require('../providers/auto-provider-config');

const HOST_PATH = '/api/__host/session-admin';

/** Marker meaning "this op is not part of the cluster" -> 400 unknown operation. */
const UNKNOWN = Symbol('unknown');

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

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[session-admin-host] dependencies are required');
  }
  for (const name of ['records', 'directories', 'chatSessions']) {
    if (!deps[name] || typeof deps[name].get !== 'function') {
      throw new TypeError(`[session-admin-host] ${name} must expose get()`);
    }
  }
  for (const name of [
    'getTaskState', 'dispatchStateAction', 'runClassifyNow',
    'getInvalidSession', 'cliStateSummary', 'cliHandoffSummary',
    'cliAvailabilitySummary', 'sessionProviderBaseUrl', 'getAuxRuntime',
  ]) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[session-admin-host] dependency missing: ${name}`);
    }
  }
  if (typeof deps.viewChatHistory !== 'function' && typeof deps.loadChatHistory !== 'function') {
    throw new TypeError('[session-admin-host] dependency missing: viewChatHistory');
  }
  return deps;
}

/**
 * Mounts the internal listener the front door calls over PROXY v1 loopback.
 * `options.sessionView` / `options.readSessionRuntime` are the two runtime
 * ports the retired presenters used in-process.
 */
function mountSessionAdminHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[session-admin-host] Express-compatible app is required');
  }
  const deps = assertDependencies(options.deps);
  if (typeof options.sessionView !== 'function' || typeof options.readSessionRuntime !== 'function') {
    throw new TypeError('[session-admin-host] runtime ports are required');
  }
  const isLocal = options.isLocal || require('../native/binding').requestLocality.isLocalRequest;
  const sessionView = options.sessionView;
  const readSessionRuntime = options.readSessionRuntime;
  // Read-only admin views only need the transcript's current contents. Prefer
  // the uncopied runtime view when the host provides it; hosts that only pass
  // the cloning loader keep working.
  const viewChatHistory = typeof deps.viewChatHistory === 'function'
    ? deps.viewChatHistory : deps.loadChatHistory;

  function chat(id) {
    return deps.chatSessions.get(id) || null;
  }

  function runtimeDto(item) {
    return readSessionRuntime(item.record.id, item.record);
  }

  /** `classificationReply`: an unreadable history behaves like an empty one. */
  function classificationReply(id) {
    try {
      return latestStringAssistant(viewChatHistory(id), 20);
    } catch (_) {
      return '';
    }
  }

  function enqueueClassification(id, reply) {
    const target = chat(id);
    if (!target) return null;
    const previous = target.currentAssistantText;
    target.currentAssistantText = reply;
    try {
      // Legacy endpoint name retained. The action now replays task attribution
      // only; turn state remains owned by structured finalization rules.
      deps.runClassifyNow(target, id, { manual: true });
    } finally {
      target.currentAssistantText = previous;
    }
    return null;
  }

  function auxEntry() {
    const aux = deps.getAuxRuntime();
    if (!aux || !aux.queue) return { available: false };
    const record = deps.records.get(aux.id);
    if (!record) return { available: true, present: false };
    return {
      available: true,
      present: true,
      entry: {
        id: aux.id,
        cwd: record.cwd,
        createdAt: record.createdAt,
        lastActivity: aux.queue.lastTaskTime ? new Date(aux.queue.lastTaskTime) : null,
        clients: aux.queue.clients.size,
        active: aux.queue.processing,
        type: 'aux',
        label: record.label || 'AI Assistant',
        auxStatus: aux.queue.getStatus(),
      },
    };
  }

  function guardRecord(body) {
    const record = deps.records.get(String(body.id || '')) || null;
    const internal = !!(record && record.taskExecutionSlot === true);
    if (internal) {
      // Same denial log the retired `app.use` layer emitted.
      const logger = deps.logger || console;
      logger?.warn?.('internal_execution_slot_public_access_denied', {
        method: typeof body.method === 'string' ? body.method : null,
      });
    }
    return {
      record,
      internal,
      taskStateWritable: typeof deps.setTaskState === 'function',
    };
  }

  function taskState(body) {
    const record = deps.records.get(String(body.id || '')) || null;
    const task = deps.getTaskState(record) || {};
    return {
      classifyState: task.classifyState === undefined ? null : task.classifyState,
      goal: task.goal === undefined ? null : task.goal,
      phase: task.phase === undefined ? null : task.phase,
      goalState: task.goalState === undefined ? null : task.goalState,
    };
  }

  function readHistory(body) {
    const id = String(body.id || '');
    try {
      const history = viewChatHistory(id);
      return { failed: false, history: Array.isArray(history) ? history : [] };
    } catch (_) {
      // The retired handler let the loader's exception reach safeErrorHandler's
      // 500; Rust reproduces that status from this flag.
      return { failed: true };
    }
  }

  function dispatchState(body) {
    const id = String(body.id || '');
    deps.dispatchStateAction(
      { state: 'D', goal: body.goal || '', phase: body.phase || '' },
      { sessionName: id, sessionId: id, cs: chat(id), isTerminal: body.isTerminal === true },
    );
    return null;
  }

  function invoke(body) {
    switch (body.op) {
      case 'records':
        return [...deps.records];
      case 'list-dto':
        return (body.items || []).map(item => ({
          runtime: runtimeDto(item),
          providerSelection: providerSelectionDto(item.record.providerSelection),
          cliStates: deps.cliStateSummary(item.record),
          pendingCliHandoff: deps.cliHandoffSummary(item.record),
        }));
      case 'dir-dto':
        return (body.items || []).map(item => ({
          runtime: runtimeDto(item),
          providerSelection: providerSelectionDto(item.record.providerSelection),
          cliStates: deps.cliStateSummary(item.record),
          pendingCliHandoff: deps.cliHandoffSummary(item.record),
          invalid: deps.getInvalidSession(item.record.id) || null,
        }));
      case 'detail-dto': {
        const record = body.record || {};
        return {
          runtime: readSessionRuntime(record.id, record),
          providerSelection: providerSelectionDto(record.providerSelection),
          providerBaseUrl: deps.sessionProviderBaseUrl(record),
          cliStates: deps.cliStateSummary(record),
          cliAvailability: deps.cliAvailabilitySummary(),
          pendingCliHandoff: deps.cliHandoffSummary(record),
        };
      }
      case 'v1-dto':
        return (body.items || []).map(item => ({ runtime: runtimeDto(item) }));
      case 'workspace-dto':
        return (body.items || []).map(item => ({
          runtime: runtimeDto(item),
          facts: sessionView(item.record.id),
          invalid: deps.getInvalidSession(item.record.id) || null,
        }));
      case 'directory':
        return deps.directories.get(String(body.id || '')) || null;
      case 'record':
        return deps.records.get(String(body.id || '')) || null;
      case 'guard-record':
        return guardRecord(body);
      case 'task-state':
        return taskState(body);
      case 'aux-entry':
        return auxEntry();
      case 'history':
        return readHistory(body);
      case 'chat-flag': {
        const target = chat(String(body.id || ''));
        return { exists: !!target, streaming: !!(target && target.isStreaming) };
      }
      case 'reply':
        return classificationReply(String(body.id || ''));
      case 'enqueue':
        return enqueueClassification(String(body.id || ''), String(body.reply || ''));
      case 'dispatch-state':
        return dispatchState(body);
      case 'set-goal-achieved':
        deps.setTaskState(String(body.id || ''), {
          goalState: GOAL_STATES.achieved,
          goalStateManualAt: Date.now(),
        });
        return null;
      case 'run-classify': {
        const target = chat(String(body.id || ''));
        if (!target) return null;
        target.currentAssistantText = String(body.text || '');
        deps.runClassifyNow(target, String(body.id || ''));
        return null;
      }
      default:
        return UNKNOWN;
    }
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve()
      .then(() => invoke(body))
      .then(
        (value) => {
          if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
          return res.json(value === undefined ? null : value);
        },
        (error) => {
          // 500 会被前门翻译成 rust_backend_unavailable（见 docs/gateway.md §9）。
          const logger = deps.logger || console;
          logger?.error?.('[session-admin-host] operation failed', body.op, error);
          return res.status(500).json({ error: 'host operation failed' });
        },
      );
  });
}

module.exports = {
  HOST_PATH,
  assistantText,
  latestAssistant,
  latestStringAssistant,
  mountSessionAdminHostRoute,
};
