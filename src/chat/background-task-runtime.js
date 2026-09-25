'use strict';

const { redactProviderRouteCapability } = require('../observability');

// Session-scoped runtime for Claude Code Monitor / run_in_background events.
// All host effects are injected so this module can be exercised without
// starting a process, touching disk, or loading server.js.

const DEFAULT_PROGRESS_THROTTLE_MS = 5000;
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;
// Liveness marks (sync Bash / sub-agent / Monitor) must survive until the task
// completes: a ten-minute sync command is still sync when its completion lands,
// so these expire on a day-long leak guard instead of the short dedup window.
const DEFAULT_LIVENESS_TTL_MS = 24 * 60 * 60 * 1000;
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
  const deliverSystem = requiredFunction(deps, 'deliverSystem');
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
  const livenessTtlMs = positiveNumber(deps.livenessTtlMs, DEFAULT_LIVENESS_TTL_MS);
  const mainToolUseCap = positiveNumber(deps.mainToolUseCap, DEFAULT_MAIN_TOOL_USE_CAP);
  const outputCap = positiveNumber(deps.outputCap, DEFAULT_OUTPUT_CAP);

  // Each bookkeeping structure is session-scoped. Besides preventing task-id
  // collisions, this lets stopSession deterministically release every resource.
  const shadows = new Map();
  const timedStore = ttl => ({ map: new Map(), ttl });
  const taskOutputAwaiting = timedStore(dedupTtlMs);
  const syncBashTasks = timedStore(livenessTtlMs);
  const subagentTasks = timedStore(livenessTtlMs);
  const monitorTasks = timedStore(livenessTtlMs);
  // Monitor processes are retained separately from writer shadows: an idle
  // watch must not pin its originating execution lease. Terminal entries stay
  // briefly so the hook can identify notifications arriving after the bookend.
  const monitorWatches = new Map();
  const monitorEvents = timedStore(dedupTtlMs);
  // Native task ids outlive the tool event that created them. Keep the owning
  // MultiCC turn so a completion can distinguish "the originating turn is
  // still consuming this tool" from "the turn already ended; wake it again".
  const taskOrigins = new Map();
  // Main-thread background tasks (run_in_background Bash / Agent) whose result
  // the host delivers itself. A resident CLI also wakes the model with its own
  // native notification query; the UserPromptSubmit hook consults this map so
  // exactly one of the two reaches the model. `delivered` flips once the host
  // queued (or deliberately suppressed) the result.
  const ownedTasks = new Map();
  // One-shot note for the next turn: background tasks stopped by "insert now".
  const stoppedNotes = new Map();
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
        deliverSystem(sessionName, buildNudge(items), origin);
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

  function tagTimed(store, sessionName, taskId) {
    if (!sessionName || !taskId) return false;
    knownSessions.add(sessionName);
    const entries = nested(store.map, sessionName, true);
    const timestamp = now();
    pruneTimed(entries, timestamp, store.ttl);
    entries.set(String(taskId), { at: timestamp });
    return true;
  }

  function hasTimed(store, sessionName, taskId) {
    if (!sessionName || !taskId) return false;
    const entries = nested(store.map, sessionName);
    if (!entries) return false;
    const key = String(taskId);
    const value = entries.get(key);
    if (!value) return false;
    if (now() - value.at > store.ttl) {
      entries.delete(key);
      if (entries.size === 0) store.map.delete(sessionName);
      return false;
    }
    return true;
  }

  function consumeTimed(store, sessionName, taskId) {
    const entries = nested(store.map, sessionName);
    if (!entries || !taskId) return false;
    const deleted = entries.delete(String(taskId));
    if (entries.size === 0) store.map.delete(sessionName);
    return deleted;
  }

  function pruneTimed(entries, timestamp, ttl) {
    for (const [key, value] of entries) {
      if (timestamp - value.at > ttl) entries.delete(key);
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

  function recordTaskOrigin(sessionName, taskId, chatState, toolUseId) {
    const turnId = String(chatState && chatState._activeTurn && chatState._activeTurn.turnId || '').trim();
    if (!sessionName || !taskId || !turnId) return null;
    knownSessions.add(sessionName);
    const entries = nested(taskOrigins, sessionName, true);
    const origin = { turnId, toolUseId: toolUseId ? String(toolUseId) : null };
    entries.set(String(taskId), origin);
    return origin;
  }

  function consumeTaskOrigin(sessionName, taskId) {
    const entries = nested(taskOrigins, sessionName);
    if (!entries || !taskId) return null;
    const key = String(taskId);
    const origin = entries.get(key) || null;
    entries.delete(key);
    if (entries.size === 0) taskOrigins.delete(sessionName);
    return origin;
  }

  function ownTask(sessionName, taskId, origin) {
    const entries = nested(ownedTasks, sessionName, true);
    const timestamp = now();
    for (const [key, value] of entries) if (timestamp - value.at > livenessTtlMs) entries.delete(key);
    entries.set(String(taskId), { at: timestamp, delivered: false, originTurnId: origin && origin.turnId || null });
  }

  function ownedTask(sessionName, taskId) {
    const value = taskId && nested(ownedTasks, sessionName)?.get(String(taskId));
    return value && now() - value.at <= livenessTtlMs ? value : null;
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
    // `description` is retained so a live-task snapshot (listActiveBackgroundTasks)
    // and the reap path can label the task without re-reading the ledger.
    const shadow = { tail, lastProgressAt: Number.NEGATIVE_INFINITY, description: description || '' };
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

  // A shadow that survives past its turn (i.e. is NOT a synchronous foreground
  // Bash, which completes before the turn's `result`) represents genuine
  // background work still in flight. The idle-reclaim guard uses this so a warm
  // process is never killed out from under a running background task.
  function isBackgroundShadow(sessionName, taskId) {
    return !hasTimed(syncBashTasks, sessionName, taskId);
  }

  function hasLiveBackgroundTasks(sessionName) {
    const sessionShadows = shadows.get(sessionName);
    if (!sessionShadows || sessionShadows.size === 0) return false;
    for (const taskId of sessionShadows.keys()) {
      if (isBackgroundShadow(sessionName, taskId)) return true;
    }
    return false;
  }

  function hasProcessBackgroundTasks(sessionName) {
    return hasLiveBackgroundTasks(sessionName)
      || [...(monitorWatches.get(sessionName)?.values() || [])].some(watch => watch.live
        // A completion bookend can precede the native prompt hook. Give that
        // already-finished task a bounded drain window, preserving its last
        // notification without imposing any deadline on running work.
        || (!watch.terminalHandled && now() - watch.endedAt < 5000));
  }

  // Longest silence among this session's live background shadows. Any tail line
  // counts as activity and a shadow that never printed reports Infinity, so a
  // task that is still reporting progress can never be mistaken for a hung one.
  // The workspace escalation reads this: a lease pinned by background work is
  // only escalated once that work has stopped saying anything at all.
  function backgroundSilenceMs(sessionName, at = now()) {
    const sessionShadows = shadows.get(sessionName);
    if (!sessionShadows || sessionShadows.size === 0) return 0;
    let longest = 0;
    for (const taskId of sessionShadows.keys()) {
      if (!isBackgroundShadow(sessionName, taskId)) continue;
      longest = Math.max(longest, at - sessionShadows.get(taskId).lastProgressAt);
    }
    return longest;
  }

  // Authoritative live-task snapshot for a (re)connecting client: the current
  // set of background tasks the server still believes are running. The frontend
  // reconciles its danmaku against this to settle any spinner whose terminal
  // `monitor_done` was lost in transit.
  function listActiveBackgroundTasks(sessionName) {
    const sessionShadows = shadows.get(sessionName);
    const out = [...(monitorWatches.get(sessionName) || [])].filter(([, watch]) => watch.live)
      .map(([id, watch]) => ({ id, task_id: id, description: safeDescription(watch.description) }));
    for (const [taskId, shadow] of sessionShadows || []) {
      if (!isBackgroundShadow(sessionName, taskId)) continue;
      out.push({ id: taskId, task_id: taskId, description: safeDescription(shadow.description) });
    }
    return out;
  }

  // Safety net for the case the completion event can never arrive: the host
  // process died (crash, cancel, restart) while tasks
  // were still open. For each surviving shadow we stop the tail, mark the ledger
  // `interrupted`, and broadcast a synthetic `monitor_done(interrupted)` so the
  // UI settles instead of spinning until the 180s stale timer. Idempotent: a
  // second call finds no shadows and returns 0.
  function reapSessionShadows(sessionName, opts = {}) {
    const sessionShadows = shadows.get(sessionName);
    const watches = monitorWatches.get(sessionName);
    const ids = new Set([...(sessionShadows?.keys() || []),
      ...[...(watches || [])].filter(([, watch]) => watch.live).map(([id]) => id)]);
    const reason = String(opts.reason || 'process_exit');
    let reaped = 0;
    for (const taskId of ids) {
      const background = isBackgroundShadow(sessionName, taskId);
      const description = sessionShadows?.get(taskId)?.description || watches?.get(taskId)?.description || '';
      if (watches?.has(taskId)) Object.assign(watches.get(taskId), { live: false, endedAt: now(), terminalHandled: true });
      stopShadow(sessionName, taskId);
      const origin = consumeTaskOrigin(sessionName, taskId);
      observe({
        sessionId: sessionName,
        taskId,
        status: 'interrupted',
        detail: {
          description,
          reason,
          originTurnId: origin && origin.turnId || null,
          error: `background task interrupted (${reason})`,
        },
      }, `task ledger reap ${taskId}`);
      broadcast(sessionName, {
        type: 'monitor_done',
        task_id: taskId,
        status: 'interrupted',
        summary: safeDescription(description, '后台任务已中断'),
        background,
      });
      reaped += 1;
    }
    return reaped;
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
      const output = redactProviderRouteCapability(String(value || ''));
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
    const monitor = !!(tool && tool.name === 'Monitor');
    const persistentMonitor = monitor && tool.input && tool.input.persistent === true;
    const subagent = !!(event.tool_use_id && !tool);
    const origin = recordTaskOrigin(sessionName, taskId, chatState, event.tool_use_id);
    if (sync) tagTimed(syncBashTasks, sessionName, taskId);
    if (monitor) {
      tagTimed(monitorTasks, sessionName, taskId);
      const watches = nested(monitorWatches, sessionName, true);
      for (const [id, watch] of watches) if (!watch.live && now() - watch.endedAt > dedupTtlMs) watches.delete(id);
      watches.set(String(taskId), { live: true, description: event.description || '', toolUseId: event.tool_use_id });
    }
    if (subagent) tagTimed(subagentTasks, sessionName, taskId);
    if (!sync && !monitor && !subagent) ownTask(sessionName, taskId, origin);
    const outputFile = monitorOutputFilePath(event.session_id || '', taskId, chatState && chatState.cwd);
    observe({
      sessionId: sessionName,
      taskId,
      status: 'running',
      detail: {
        kind: sync ? 'sync-bash' : persistentMonitor ? 'monitor-persistent' : monitor ? 'monitor' : subagent ? 'agent-task' : 'background-task',
        description: event.description || '',
        toolUseId: event.tool_use_id || null,
        originTurnId: origin && origin.turnId || null,
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
    if (!monitor) startShadow(sessionName, taskId, outputFile, event.description || '');
    return { handled: true, kind: sync ? 'sync-bash' : persistentMonitor ? 'monitor-persistent' : monitor ? 'monitor' : subagent ? 'agent-task' : 'background-task' };
  }

  function handleProgress(sessionName, event) {
    const taskId = event.task_id;
    if (!taskId) return { handled: false };
    const status = statusForProgress(event.status || event.patch?.status);
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

  function turnAlreadyHasResult(chatState, toolUseId, origin) {
    if (!toolUseId) return false;
    const tools = Array.isArray(chatState && chatState.currentToolCalls)
      ? chatState.currentToolCalls
      : [];
    const tool = tools.find(item => item && item.id === toolUseId);
    if (!tool || typeof tool.result !== 'string') return false;
    if (tool.name === 'Bash' && tool.input && tool.input.run_in_background) {
      const activeTurnId = String(chatState && chatState._activeTurn && chatState._activeTurn.turnId || '').trim();
      return !!(
        chatState && chatState.isStreaming === true
        && origin && origin.turnId
        && activeTurnId === origin.turnId
      );
    }
    return true;
  }

  function handleCompletion(sessionName, chatState, event) {
    const taskId = event.task_id;
    const watch = monitorWatches.get(sessionName)?.get(String(taskId));
    if (watch) Object.assign(watch, { live: false, endedAt: now() });
    stopShadow(sessionName, taskId);
    const origin = consumeTaskOrigin(sessionName, taskId);
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
        originTurnId: origin && origin.turnId || null,
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
    const monitor = !!watch || hasTimed(monitorTasks, sessionName, taskId);
    const sidechainByToolUse = !watch && !!(event.tool_use_id && !isMainToolUseId(sessionName, event.tool_use_id));
    const decision = classifyCompletion({
      awaitingTaskOutput: hasTimed(taskOutputAwaiting, sessionName, taskId),
      sync,
      subagent,
      sidechainByToolUse,
      monitor,
    });
    if (!decision || !['suppress', 'inject'].includes(decision.action)) {
      log('warn', 'background task classifier returned an invalid decision');
      return { handled: true, decision: 'invalid' };
    }
    const owned = !watch && ownedTask(sessionName, taskId);
    if (decision.action === 'suppress') {
      if (owned) owned.delivered = true;
      if (decision.reason === 'taskoutput') consumeTimed(taskOutputAwaiting, sessionName, taskId);
      else if (decision.reason === 'sync-bash') consumeTimed(syncBashTasks, sessionName, taskId);
      else if (decision.reason === 'sidechain') consumeTimed(subagentTasks, sessionName, taskId);
      else if (decision.reason === 'monitor') {
        consumeTimed(monitorTasks, sessionName, taskId);
        // The terminal bookend includes an authoritative output file. Queue it
        // here as well: native TaskStop/exit paths may suppress the prompt hook.
        // A live turn already knows (its own TaskStop, or the CLI hands the
        // event over in-turn); if not, the CLI's idle hook still reports it.
        if (watch && !watch.terminalQueued && chatState?.isStreaming !== true) {
          watch.terminalQueued = true;
          noteBgResultInjected(sessionName);
          coalescer.add(sessionName, { kind: 'monitor', desc: event.summary || watch.description,
            status: event.status || 'completed', snippet, taskId, toolUseId: watch.toolUseId });
        }
      }
      return { handled: true, decision: decision.reason };
    }
    if (turnAlreadyHasResult(chatState, event.tool_use_id, origin)) {
      return { handled: true, decision: 'turn-result' };
    }
    // The native notification query won the race and was already admitted.
    if (owned && owned.delivered) return { handled: true, decision: 'native-prompt' };
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
      if (owned) owned.delivered = true;
    } catch (error) {
      log('warn', 'background task completion buffering failed', error);
      return { handled: true, decision: 'failed' };
    }
    return { handled: true, decision: 'inject' };
  }

  // A native notification query for a main-thread background task. The host
  // owns delivery, so the native query is always swallowed: either the host
  // already queued this result (duplicate), or the hook arrived first and the
  // host queues it now. The one exception is a completion the originating turn
  // is still streaming through — the CLI hands that over in-turn.
  function handleTaskPrompt(sessionName, chatState, event) {
    const owned = ownedTask(sessionName, event.task_id);
    if (!owned) return { handled: false };
    const activeTurnId = String(chatState && chatState._activeTurn && chatState._activeTurn.turnId || '').trim();
    if (!owned.delivered && owned.originTurnId && chatState && chatState.isStreaming === true
        && activeTurnId === owned.originTurnId) return { handled: false };
    if (event.probe) return { handled: true, monitorOwned: true };
    if (owned.delivered) return { handled: true, monitorOwned: true, decision: 'duplicate' };
    owned.delivered = true;
    noteBgResultInjected(sessionName);
    coalescer.add(sessionName, { desc: event.summary || '后台任务', status: event.status || 'completed',
      snippet: outputSnippet(event.output_file), taskId: event.task_id, toolUseId: event.tool_use_id || null });
    return { handled: true, monitorOwned: true, decision: 'inject' };
  }

  // "Insert now" replaces the running work with the user's message: the
  // resident process is stopped and its background tasks die with it. Drop
  // completions still waiting in the coalescer (they would wake the session
  // right after the inserted turn) and leave the next turn a note so the model
  // does not wait on tasks that no longer exist.
  function stopForInsert(sessionName) {
    if (!sessionName) return 0;
    const tasks = listActiveBackgroundTasks(sessionName);
    coalescer.cancel(sessionName);
    for (const owned of nested(ownedTasks, sessionName)?.values() || []) owned.delivered = true;
    if (tasks.length) stoppedNotes.set(sessionName, tasks.map(task => `${task.task_id}: ${task.description}`));
    return tasks.length;
  }

  function takeStoppedNote(sessionName) {
    const tasks = stoppedNotes.get(sessionName);
    if (!tasks) return '';
    stoppedNotes.delete(sessionName);
    return `[Background tasks stopped] The user interrupted the previous turn with this message, which stopped these background tasks before they finished. Do not wait for their notifications; rerun one only if it is still needed.\n${tasks.map(line => `- ${line}`).join('\n')}\n\n`;
  }

  // The page's task row shows the Monitor's latest event line next to its
  // description; the full event still reaches only the model.
  function showMonitorEvent(sessionName, event, watch) {
    const lines = String(event.output || '').split('\n').map(line => line.trim()).filter(Boolean);
    const label = safeDescription(watch.description || event.summary, 'Monitor');
    broadcast(sessionName, { type: 'monitor_progress', task_id: event.task_id, background: true,
      description: safeDescription(lines.length ? `${label} · ${lines.at(-1)}` : label) });
  }

  function handleEvent(sessionName, chatState, event) {
    if (!sessionName || !event || typeof event !== 'object') return { handled: false };
    event = redactProviderRouteCapability(event);
    knownSessions.add(sessionName);
    if (event.subtype === 'monitor_prompt') {
      const watch = monitorWatches.get(sessionName)?.get(String(event.task_id));
      if (!watch) return handleTaskPrompt(sessionName, chatState, event);
      if (!watch.live && now() - watch.endedAt > dedupTtlMs) return { handled: false };
      // Monitor events stay inside the resident session. During a live turn
      // the CLI attaches them to that turn's next request, so leave them
      // native. Between turns they would start an unadmitted query: block
      // progress without queueing a 🔇 turn per event — only the terminal
      // bookend below continues the task.
      const inTurn = chatState?.isStreaming === true;
      // An in-turn batch is only ever probed (the hook then leaves it native);
      // an idle one is probed and then delivered — show each event once.
      if (!event.status && (inTurn || !event.probe)) showMonitorEvent(sessionName, event, watch);
      // Once the host has queued the terminal report, a native repeat (even
      // inside the turn that delivers it) is a duplicate.
      if (inTurn && !(event.status && watch.terminalQueued)) return { handled: false };
      if (event.probe) return { handled: true, monitorOwned: true };
      if (!event.status) return { handled: true, monitorOwned: true, decision: 'progress' };
      watch.terminalHandled = true;
      if (watch.terminalQueued) return { handled: true, monitorOwned: true, decision: 'duplicate' };
      watch.terminalQueued = true;
      if (event.event_id && hasTimed(monitorEvents, sessionName, event.event_id)) {
        return { handled: true, monitorOwned: true, decision: 'duplicate' };
      }
      const item = { kind: 'monitor', desc: event.summary || watch.description || 'Monitor',
        status: event.status, snippet: String(event.output || '').slice(0, outputCap),
        taskId: event.task_id, toolUseId: watch.toolUseId || null };
      noteBgResultInjected(sessionName);
      coalescer.add(sessionName, item);
      if (event.event_id) tagTimed(monitorEvents, sessionName, event.event_id);
      return { handled: true, monitorOwned: true, decision: 'inject' };
    }
    if (event.subtype === 'task_started') return handleStarted(sessionName, chatState, event);
    if (event.subtype === 'task_progress' || event.subtype === 'task_updated') {
      return handleProgress(sessionName, event);
    }
    if (event.subtype === 'task_notification') return handleCompletion(sessionName, chatState, event);
    if (event.subtype === 'background_tasks_changed') {
      const ids = new Set((event.tasks || []).map(task => String(task.task_id)));
      for (const [id, watch] of monitorWatches.get(sessionName) || []) {
        if (watch.live && !ids.has(id)) Object.assign(watch, { live: false, endedAt: now() });
      }
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
    taskOutputAwaiting.map.delete(sessionName);
    syncBashTasks.map.delete(sessionName);
    subagentTasks.map.delete(sessionName);
    monitorTasks.map.delete(sessionName);
    monitorWatches.delete(sessionName);
    monitorEvents.map.delete(sessionName);
    taskOrigins.delete(sessionName);
    ownedTasks.delete(sessionName);
    stoppedNotes.delete(sessionName);
    mainToolUses.delete(sessionName);
    knownSessions.delete(sessionName);
    return killed;
  }

  function stopAll() {
    const sessions = new Set([
      ...knownSessions,
      ...shadows.keys(),
      ...taskOutputAwaiting.map.keys(),
      ...syncBashTasks.map.keys(),
      ...subagentTasks.map.keys(),
      ...monitorTasks.map.keys(),
      ...taskOrigins.keys(),
      ...ownedTasks.keys(),
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
    hasLiveBackgroundTasks,
    hasProcessBackgroundTasks,
    backgroundSilenceMs,
    listActiveBackgroundTasks,
    reapSessionShadows,
    stopForInsert,
    takeStoppedNote,
    stopSession,
    stopAll,
  });
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = Object.freeze({ createBackgroundTaskRuntime });
