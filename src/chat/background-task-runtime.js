'use strict';

// Background-task turn-engine runtime — JavaScript facade.
//
// The behavior lives in native/addon/src/background_tasks.rs over the pure
// kernels in native/core/src/background/. This file only forwards host
// functions (ports), keeps one unref'd timer, and performs the asynchronous
// control-channel glue that cannot live in Rust (Promises). No bookkeeping
// state may return here — Node is frozen.

const { getNative } = require('../native/runtime');
const { safeText } = require('../cli-adapters/codex-background-events.cjs');
const { redactProviderRouteCapability } = require('../observability');

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
  const readFile = requiredFunction(deps, 'readFile');
  const realpath = requiredFunction(deps, 'realpath');
  const tmpdir = requiredFunction(deps, 'tmpdir');
  const getuid = requiredFunction(deps, 'getuid');
  const setTimer = requiredFunction(deps, 'setTimer');
  const clearTimer = requiredFunction(deps, 'clearTimer');
  const now = requiredFunction(deps, 'now');
  // Optional SDK control-channel surface (0.3.289): fetchTaskOutput resolves
  // { output, totalBytes, truncated } from the resident query, stopTask asks it
  // to terminate one task by id. Absent for every non-SDK lane.
  const fetchTaskOutput = typeof deps.fetchTaskOutput === 'function' ? deps.fetchTaskOutput : null;
  const stopTaskById = typeof deps.stopTask === 'function' ? deps.stopTask : null;
  const logger = deps.logger || {};
  const owner = new (getNative().RustBackgroundTasks)({
    progressThrottleMs: deps.progressThrottleMs,
    dedupTtlMs: deps.dedupTtlMs,
    livenessTtlMs: deps.livenessTtlMs,
    mainToolUseCap: deps.mainToolUseCap,
    outputCap: deps.outputCap,
    completionWindowMs: deps.completionWindowMs,
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

  // `observe` is fire-and-forget in the legacy runtime: sync throws and
  // rejections are logged, never surfaced to the event handler.
  function observe(observation, label) {
    try {
      Promise.resolve(observeTask(observation)).catch(error => log('warn', `${label} failed`, error));
    } catch (error) { log('warn', `${label} failed`, error); }
  }

  function deliverCompleted(sessionName, text, origin) {
    try { deliverSystem(sessionName, text, origin); }
    catch (error) { log('warn', 'background task completion injection failed', error); }
  }

  // The resident query's control channel is the authoritative output source.
  // The buffered item keeps its file-read fallback until (and if) this lands.
  function requestEnrich(sessionName, taskId, token, hasOwnResult) {
    if (!fetchTaskOutput || !taskId || hasOwnResult) return;
    void Promise.resolve()
      .then(() => fetchTaskOutput(sessionName, String(taskId)))
      .then(result => {
        const text = result && typeof result.output === 'string'
          ? redactProviderRouteCapability(result.output)
          : '';
        if (!text.trim()) return;
        owner.applyControlOutput(token, text, !!result.truncated);
        arm();
      })
      .catch(() => {});
  }

  function requestStopTask(sessionName, taskId) {
    if (!stopTaskById) return;
    void Promise.resolve(stopTaskById(sessionName, taskId)).catch(() => {});
  }

  const ports = {
    now: () => Number(now()),
    broadcast: (sessionName, frame) => broadcast(sessionName, frame),
    observe,
    noteBgResultInjected: sessionName => noteBgResultInjected(sessionName),
    deliverSystem: deliverCompleted,
    logWarn: (message, error) => log('warn', message, error),
    safeText,
    readFile,
    redactEvent: value => redactProviderRouteCapability(value),
    redactText: text => redactProviderRouteCapability(text),
    tmpdir: () => tmpdir(),
    realpath: path => realpath(path),
    getuid: () => getuid(),
    requestEnrich,
    requestStopTask,
  };

  // One unref'd timer for the whole owner: it wakes for the earliest coalescer
  // deadline or writer-shadow poll and re-arms after every mutation.
  let timer = null;
  function arm() {
    if (timer) { clearTimer(timer); timer = null; }
    let due;
    try { due = owner.nextDue(); } catch (error) { log('warn', 'background task timer failed', error); return; }
    if (due === null || due === undefined || !Number.isFinite(due)) return;
    const delay = Math.max(0, due - now());
    timer = setTimer(() => {
      timer = null;
      try { owner.tick(ports); } catch (error) { log('warn', 'background task timer failed', error); }
      arm();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function step(call) {
    const result = call();
    arm();
    return result;
  }

  return Object.freeze({
    handleEvent: (sessionName, chatState, event) =>
      step(() => owner.handleEvent(ports, sessionName, chatState, event)),
    recordMainToolUseId: (sessionName, id) => owner.recordMainToolUseId(sessionName, id),
    markTaskOutputAwaiting: (sessionName, input) => owner.markTaskOutputAwaiting(ports, sessionName, input),
    hasLiveBackgroundTasks: sessionName => owner.hasLiveBackgroundTasks(ports, sessionName),
    hasProcessBackgroundTasks: sessionName => owner.hasProcessBackgroundTasks(ports, sessionName),
    backgroundSilenceMs: (sessionName, at) =>
      owner.backgroundSilenceMs(ports, sessionName, at === undefined ? null : at),
    listActiveBackgroundTasks: sessionName => owner.listActiveBackgroundTasks(ports, sessionName),
    reapSessionShadows: (sessionName, opts) =>
      step(() => owner.reapSessionShadows(ports, sessionName, opts)),
    stopForInsert: sessionName => step(() => owner.stopForInsert(ports, sessionName)),
    takeStoppedNote: sessionName => owner.takeStoppedNote(sessionName),
    stopSession: sessionName => step(() => owner.stopSession(sessionName)),
    stopAll: () => step(() => owner.stopAll()),
  });
}

module.exports = Object.freeze({ createBackgroundTaskRuntime });
