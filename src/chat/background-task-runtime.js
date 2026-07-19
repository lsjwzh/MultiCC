'use strict';

// Session-scoped runtime for Claude Code Monitor / run_in_background events.
// All host effects are injected so this module can be exercised without
// starting a process, touching disk, or loading server.js.

const DEFAULT_PROGRESS_THROTTLE_MS = 5000;
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAIN_TOOL_USE_CAP = 2000;
const DEFAULT_OUTPUT_CAP = 2000;

function requiredFunction(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw new TypeError(`createBackgroundTaskRuntime: ${name} is required`);
  }
  return deps[name];
}

function createBackgroundTaskRuntime(deps = {}) {
  const broadcast = requiredFunction(deps, 'broadcast');
  const observeTask = requiredFunction(deps, 'observeTask');
  const noteBgResultInjected = requiredFunction(deps, 'noteBgResultInjected');
  const injectSystemMsg = requiredFunction(deps, 'injectSystemMsg');
  const createCoalescer = requiredFunction(deps, 'createCoalescer');
  const buildNudge = requiredFunction(deps, 'buildNudge');
  const classifyCompletion = requiredFunction(deps, 'classifyCompletion');
  const spawn = requiredFunction(deps, 'spawn');
  const readFile = requiredFunction(deps, 'readFile');
  const realpath = requiredFunction(deps, 'realpath');
  const tmpdir = requiredFunction(deps, 'tmpdir');
  const getuid = requiredFunction(deps, 'getuid');
  const setTimer = requiredFunction(deps, 'setTimer');
  const clearTimer = requiredFunction(deps, 'clearTimer');
  const now = requiredFunction(deps, 'now');
  const logger = deps.logger || {};
  const progressThrottleMs = positiveNumber(deps.progressThrottleMs, DEFAULT_PROGRESS_THROTTLE_MS);
  const dedupTtlMs = positiveNumber(deps.dedupTtlMs, DEFAULT_DEDUP_TTL_MS);
  const mainToolUseCap = positiveNumber(deps.mainToolUseCap, DEFAULT_MAIN_TOOL_USE_CAP);
  const outputCap = positiveNumber(deps.outputCap, DEFAULT_OUTPUT_CAP);

  // Each bookkeeping structure is session-scoped. Besides preventing task-id
  // collisions, this lets stopSession deterministically release every resource.
  const shadows = new Map();
  const taskOutputAwaiting = new Map();
  const syncBashTasks = new Map();
  const subagentTasks = new Map();
  const mainToolUses = new Map();
  const knownSessions = new Set();

  const schedule = (fn, ms) => {
    const timer = setTimer(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  const coalescer = createCoalescer({
    windowMs: deps.completionWindowMs,
    setTimer: schedule,
    clearTimer,
    onFlush(sessionName, items) {
      const bgTaskIds = items.map(item => item.taskId).filter(Boolean);
      const bgToolUseIds = items.map(item => item.toolUseId).filter(Boolean);
      const origin = (bgTaskIds.length || bgToolUseIds.length)
        ? { bgTaskIds, bgToolUseIds }
        : {};
      try {
        injectSystemMsg(sessionName, buildNudge(items), 0, origin);
      } catch (error) {
        log('warn', 'background task completion injection failed', error);
      }
    },
  });

  function log(level, message, error) {
    const sink = logger && logger[level];
    if (typeof sink !== 'function') return;
    const code = error && /^[A-Z0-9_]{1,64}$/.test(String(error.code || ''))
      ? String(error.code)
      : '';
    const suffix = code ? ` [${code}]` : '';
    try { sink.call(logger, `${message}${suffix}`); } catch (_) {}
  }

  function nested(map, sessionName, create = false) {
    let value = map.get(sessionName);
    if (!value && create) {
      value = new Map();
      map.set(sessionName, value);
    }
    return value;
  }

  function tagTimed(map, sessionName, taskId) {
    if (!sessionName || !taskId) return false;
    knownSessions.add(sessionName);
    const entries = nested(map, sessionName, true);
    const timestamp = now();
    pruneTimed(entries, timestamp);
    entries.set(String(taskId), { at: timestamp });
    return true;
  }

  function hasTimed(map, sessionName, taskId) {
    if (!sessionName || !taskId) return false;
    const entries = nested(map, sessionName);
    if (!entries) return false;
    const key = String(taskId);
    const value = entries.get(key);
    if (!value) return false;
    if (now() - value.at > dedupTtlMs) {
      entries.delete(key);
      if (entries.size === 0) map.delete(sessionName);
      return false;
    }
    return true;
  }

  function consumeTimed(map, sessionName, taskId) {
    const entries = nested(map, sessionName);
    if (!entries || !taskId) return false;
    const deleted = entries.delete(String(taskId));
    if (entries.size === 0) map.delete(sessionName);
    return deleted;
  }

  function pruneTimed(entries, timestamp) {
    for (const [key, value] of entries) {
      if (timestamp - value.at > dedupTtlMs) entries.delete(key);
    }
  }

  function recordMainToolUseId(sessionName, id) {
    if (!sessionName || !id) return false;
    knownSessions.add(sessionName);
    let record = mainToolUses.get(sessionName);
    if (!record) {
      record = { set: new Set(), order: [] };
      mainToolUses.set(sessionName, record);
    }
    const key = String(id);
    if (record.set.has(key)) return false;
    record.set.add(key);
    record.order.push(key);
    while (record.order.length > mainToolUseCap) {
      record.set.delete(record.order.shift());
    }
    return true;
  }

  function isMainToolUseId(sessionName, id) {
    const record = mainToolUses.get(sessionName);
    return !!(record && id && record.set.has(String(id)));
  }

  function markTaskOutputAwaiting(sessionName, input) {
    if (!input || input.block !== true || !input.task_id) return false;
    return tagTimed(taskOutputAwaiting, sessionName, input.task_id);
  }

  function monitorOutputFilePath(sessionId, taskId, cwd) {
    if (!taskId) return null;
    try {
      const tmpReal = realpath(tmpdir());
      const encoded = realpath(cwd || '.').replace(/[\/.]/g, '-');
      return `${tmpReal}/claude-${getuid()}/${encoded}/${sessionId || ''}/tasks/${taskId}.output`;
    } catch (error) {
      log('warn', 'background task output path unavailable', error);
      return null;
    }
  }

  function safeDescription(value, fallback = '后台任务仍在执行') {
    const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return (text || fallback).slice(0, 240);
  }

  function startShadow(sessionName, taskId, outputFile, description) {
    if (!sessionName || !taskId || !outputFile) return false;
    const sessionShadows = nested(shadows, sessionName, true);
    if (sessionShadows.has(String(taskId))) return false;
    let tail;
    try {
      tail = spawn('tail', ['-n', '+1', '-F', outputFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      log('warn', 'background task monitor could not start', error);
      if (sessionShadows.size === 0) shadows.delete(sessionName);
      return false;
    }
    if (!tail || !tail.stdout || typeof tail.stdout.on !== 'function' || typeof tail.on !== 'function') {
      log('warn', 'background task monitor returned an invalid process');
      if (sessionShadows.size === 0) shadows.delete(sessionName);
      return false;
    }
    knownSessions.add(sessionName);
    const shadow = { tail, lastProgressAt: Number.NEGATIVE_INFINITY };
    sessionShadows.set(String(taskId), shadow);
    tail.stdout.on('data', chunk => {
      // The raw tail line is only an activity signal. It is never sent to the
      // browser, logs, or task ledger from this callback.
      if (!String(chunk || '').trim()) return;
      const timestamp = now();
      if (timestamp - shadow.lastProgressAt < progressThrottleMs) return;
      shadow.lastProgressAt = timestamp;
      broadcast(sessionName, {
        type: 'monitor_progress',
        task_id: taskId,
        description: safeDescription(description),
        background: true,
      });
    });
    tail.on('error', error => log('warn', 'background task monitor error', error));
    return true;
  }

  function stopShadow(sessionName, taskId) {
    const sessionShadows = nested(shadows, sessionName);
    if (!sessionShadows || !taskId) return false;
    const key = String(taskId);
    const shadow = sessionShadows.get(key);
    if (!shadow) return false;
    try { shadow.tail.kill(); } catch (_) {}
    sessionShadows.delete(key);
    if (sessionShadows.size === 0) shadows.delete(sessionName);
    return true;
  }

  function observe(observation, label) {
    try {
      Promise.resolve(observeTask(observation)).catch(error => log('warn', `${label} failed`, error));
    } catch (error) {
      log('warn', `${label} failed`, error);
    }
  }

  function statusForProgress(value) {
    const status = String(value || 'running').toLowerCase();
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'error') return 'failed';
    if (['cancelled', 'canceled', 'stopped', 'interrupted'].includes(status)) return 'interrupted';
    return 'running';
  }

  function statusForCompletion(value) {
    const status = String(value || 'completed').toLowerCase();
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'error') return 'failed';
    return 'interrupted';
  }

  function outputSnippet(outputFile) {
    if (!outputFile) return '';
    try {
      const value = readFile(outputFile, 'utf8');
      if (value && typeof value.then === 'function') {
        log('warn', 'background task readFile must be synchronous');
        return '';
      }
      const output = String(value || '');
      return output.length > outputCap ? output.slice(-outputCap) : output;
    } catch (_) {
      return '';
    }
  }

  function handleStarted(sessionName, chatState, event) {
    const taskId = event.task_id;
    if (!taskId) return { handled: false };
    const tools = Array.isArray(chatState && chatState.currentToolCalls)
      ? chatState.currentToolCalls
      : [];
    const tool = tools.find(item => item && item.id === event.tool_use_id);
    const command = (tool && tool.input && tool.input.command) || '';
    const sync = !!(tool && tool.name === 'Bash' && !(tool.input && tool.input.run_in_background));
    const subagent = !!(event.tool_use_id && !tool);
    if (sync) tagTimed(syncBashTasks, sessionName, taskId);
    if (subagent) tagTimed(subagentTasks, sessionName, taskId);
    const outputFile = monitorOutputFilePath(event.session_id || '', taskId, chatState && chatState.cwd);
    observe({
      sessionId: sessionName,
      taskId,
      status: 'running',
      detail: {
        kind: sync ? 'sync-bash' : subagent ? 'agent-task' : 'background-task',
        description: event.description || '',
        toolUseId: event.tool_use_id || null,
        outputFile,
      },
    }, `task ledger start ${taskId}`);
    broadcast(sessionName, {
      type: 'monitor_started',
      task_id: taskId,
      description: event.description || '',
      command,
      background: !sync,
    });
    startShadow(sessionName, taskId, outputFile, event.description || '');
    return { handled: true, kind: sync ? 'sync-bash' : subagent ? 'agent-task' : 'background-task' };
  }

  function handleProgress(sessionName, event) {
    const taskId = event.task_id;
    if (!taskId) return { handled: false };
    const status = statusForProgress(event.status);
    observe({
      sessionId: sessionName,
      taskId,
      status,
      detail: {
        description: event.description || event.summary || '',
        toolUseId: event.tool_use_id || null,
        lastOutput: event.output || event.content || event.summary || '',
        error: event.error || null,
      },
    }, `task ledger update ${taskId}`);
    broadcast(sessionName, {
      type: 'monitor_progress',
      task_id: taskId,
      description: safeDescription(event.description || event.summary),
      status,
      background: !hasTimed(syncBashTasks, sessionName, taskId),
    });
    return { handled: true, status };
  }

  function handleCompletion(sessionName, chatState, event) {
    const taskId = event.task_id;
    stopShadow(sessionName, taskId);
    const outputFile = event.output_file || (taskId && event.session_id
      ? monitorOutputFilePath(event.session_id, taskId, chatState && chatState.cwd)
      : null);
    const snippet = outputSnippet(outputFile);
    const ledgerStatus = statusForCompletion(event.status);
    observe({
      sessionId: sessionName,
      taskId,
      status: ledgerStatus,
      detail: {
        description: event.description || event.summary || '',
        toolUseId: event.tool_use_id || null,
        outputFile,
        lastOutput: snippet,
        error: event.error || (ledgerStatus === 'failed' ? event.summary || 'task failed' : null),
      },
    }, `task ledger finish ${taskId}`);
    const sync = hasTimed(syncBashTasks, sessionName, taskId);
    broadcast(sessionName, {
      type: 'monitor_done',
      task_id: taskId,
      status: event.status,
      summary: event.summary || '',
      output: snippet,
      background: !sync,
    });
    if (!chatState) return { handled: true, decision: 'none' };
    const subagent = hasTimed(subagentTasks, sessionName, taskId);
    const sidechainByToolUse = !!(event.tool_use_id && !isMainToolUseId(sessionName, event.tool_use_id));
    const decision = classifyCompletion({
      awaitingTaskOutput: hasTimed(taskOutputAwaiting, sessionName, taskId),
      sync,
      subagent,
      sidechainByToolUse,
    });
    if (!decision || !['suppress', 'inject'].includes(decision.action)) {
      log('warn', 'background task classifier returned an invalid decision');
      return { handled: true, decision: 'invalid' };
    }
    if (decision.action === 'suppress') {
      if (decision.reason === 'taskoutput') consumeTimed(taskOutputAwaiting, sessionName, taskId);
      else if (decision.reason === 'sync-bash') consumeTimed(syncBashTasks, sessionName, taskId);
      else if (decision.reason === 'sidechain') consumeTimed(subagentTasks, sessionName, taskId);
      return { handled: true, decision: decision.reason };
    }
    const item = {
      desc: event.description || event.summary || '后台任务',
      status: event.status || 'completed',
      snippet,
      taskId: taskId || null,
      toolUseId: event.tool_use_id || null,
    };
    try {
      noteBgResultInjected(sessionName);
      knownSessions.add(sessionName);
      coalescer.add(sessionName, item);
    } catch (error) {
      log('warn', 'background task completion buffering failed', error);
      return { handled: true, decision: 'failed' };
    }
    return { handled: true, decision: 'inject' };
  }

  function handleEvent(sessionName, chatState, event) {
    if (!sessionName || !event || typeof event !== 'object') return { handled: false };
    knownSessions.add(sessionName);
    if (event.subtype === 'task_started') return handleStarted(sessionName, chatState, event);
    if (event.subtype === 'task_progress' || event.subtype === 'task_updated') {
      return handleProgress(sessionName, event);
    }
    if (event.subtype === 'task_notification') return handleCompletion(sessionName, chatState, event);
    if (event.subtype === 'background_tasks_changed') {
      broadcast(sessionName, { type: 'background_tasks', tasks: event.tasks || [] });
      return { handled: true };
    }
    return { handled: false };
  }

  function stopSession(sessionName) {
    if (!sessionName) return 0;
    let killed = 0;
    const sessionShadows = shadows.get(sessionName);
    if (sessionShadows) {
      for (const taskId of [...sessionShadows.keys()]) {
        if (stopShadow(sessionName, taskId)) killed += 1;
      }
    }
    coalescer.cancel(sessionName);
    taskOutputAwaiting.delete(sessionName);
    syncBashTasks.delete(sessionName);
    subagentTasks.delete(sessionName);
    mainToolUses.delete(sessionName);
    knownSessions.delete(sessionName);
    return killed;
  }

  function stopAll() {
    const sessions = new Set([
      ...knownSessions,
      ...shadows.keys(),
      ...taskOutputAwaiting.keys(),
      ...syncBashTasks.keys(),
      ...subagentTasks.keys(),
      ...mainToolUses.keys(),
    ]);
    let killed = 0;
    for (const sessionName of sessions) killed += stopSession(sessionName);
    return killed;
  }

  return Object.freeze({
    handleEvent,
    recordMainToolUseId,
    markTaskOutputAwaiting,
    stopSession,
    stopAll,
  });
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = Object.freeze({ createBackgroundTaskRuntime });
