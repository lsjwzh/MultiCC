'use strict';

const { proxyRequestKind } = require('./proxy-outcome');
const { performance } = require('node:perf_hooks');

const { createModelStreamProgress } = require('./model-stream-progress');
const { scheduleRequestTimer } = require('../native/request-timer');
const { getNative } = require('../native/runtime');

// 每个已准入的模型请求独占计时器；请求结束即撤销，不计本地工具时间。
const RESPONSE_STALLED_BEFORE_RESPONSE = 'response_stalled_before_response';
const STREAM_IDLE_TIMEOUT = 'stream_idle_timeout';
const MODEL_REQUEST_DEADLINE = 'model_request_deadline';
const MODEL_CONNECT_TIMEOUT = 'model_connect_timeout';
const PROXY_STALL_CODES = Object.freeze([
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  MODEL_REQUEST_DEADLINE,
  MODEL_CONNECT_TIMEOUT,
]);

const PROXY_STALL_CODE_SET = new Set(PROXY_STALL_CODES);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function isProxyStallCode(value) {
  return PROXY_STALL_CODE_SET.has(clean(value).toLowerCase());
}

function stallCodeFor(progressed) {
  return progressed ? STREAM_IDLE_TIMEOUT : RESPONSE_STALLED_BEFORE_RESPONSE;
}

function stallBody(code, timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
  return JSON.stringify({
    error: {
      type: 'upstream_stalled',
      code,
      message: code === MODEL_REQUEST_DEADLINE ? 'model request budget exhausted'
        : `upstream made no progress for ${seconds}s`,
    },
  });
}

// Retire a stalled downstream response.
//
// The socket is destroyed even when a 504 is written first, and that is not an
// accident: both provider proxies release the upstream request only when they
// see a client that walked away without finishing (`res.writableEnded` false).
// A polite `res.end()` would therefore leave the dead upstream socket open —
// exactly the resource this watchdog exists to give back — and would make the
// proxy's own `res.writeHead` throw when the provider finally answers. The
// explicit content-length makes the 504 a complete message for the CLI without
// the terminating chunk, so the client still reads a real HTTP error.
function terminateStalledResponse(res, { code, timeoutMs = 0, progressed = false } = {}) {
  if (!res) return false;
  const destroy = () => {
    if (typeof res.destroy === 'function') {
      res.destroy();
      return true;
    }
    if (typeof res.end === 'function') {
      res.end();
      return true;
    }
    return false;
  };
  if (!progressed) {
    const body = stallBody(code, timeoutMs);
    try {
      if (typeof res.writeHead === 'function') {
        res.writeHead(504, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          // The Anthropic SDK retries 4xx/5xx; this route has been proved dead.
          'x-should-retry': 'false',
        });
      }
      if (typeof res.write === 'function') res.write(body);
      else if (typeof res.end === 'function') res.end(body);
    } catch (_) {}
  }
  return destroy();
}

// 一个物理请求一个看门狗；重试继承同一请求链的绝对截止时间。
function createProxyStallWatch(options = {}) {
  const protocol = clean(options.protocol).toLowerCase();
  const res = options.res;
  const observe = options.observation;
  const requestKind = options.requestKind || proxyRequestKind(protocol, options.req);
  const injectedClock = typeof options.setTimeout === 'function' || typeof options.clearTimeout === 'function';
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout
    : injectedClock ? setTimeout : scheduleRequestTimer;
  const unschedule = typeof options.clearTimeout === 'function' ? options.clearTimeout
    : injectedClock ? clearTimeout : handle => handle.cancel();
  const onStall = typeof options.onStall === 'function' ? options.onStall : null;
  const now = options.now || Date.now;
  let readProgress = null;
  const state = new (getNative().RustRequestWatch)();
  let nativeProgress = false;
  let nativeWatch = null;
  let idleAt = 0;
  let deadlineDue = 0;
  let deadlineTimeoutMs = 0;
  let deadlineTimer = null;
  let timer = null;

  function disarm() {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  }

  function rearm() {
    disarm();
    if (state.finished() || state.idleMs() <= 0) return;
    idleAt = performance.now() + effectiveDelay(state.idleMs());
    timer = schedule(onTimeout, state.idleMs());
    // A watchdog can never be the reason the process stays alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function noteProgress() {
    if (nativeWatch && !nativeWatch.noteStreamProgress()) {
      const code = nativeWatch.streamTimeoutCode();
      if (code) nativeStreamTimeout(code, nativeWatch.streamProgressed());
      return;
    }
    if (!state.progress()) return;
    // 有效事件只重置空闲预算，不延长绝对截止时间。
    if (!nativeWatch && timer !== null) rearm();
  }

  function finish() {
    if (!state.finish()) return;
    disarm();
    if (deadlineTimer !== null) unschedule(deadlineTimer);
    deadlineTimer = null;
    if (nativeWatch) nativeWatch.stopStreamWatch();
    nativeWatch = null;
  }

  function hasSentHeaders() {
    return state.progressed() || res?.headersSent === true;
  }

  function onTimeout(forcedCode, timeoutMs = state.idleMs()) {
    if (state.finished()) return;
    const progressed = state.progressed();
    const code = forcedCode || stallCodeFor(progressed);
    const detail = {
      code,
      timeoutMs,
      progressed,
      protocol,
      requestKind,
      sessionId: clean(options.sessionId) || null,
      providerId: clean(options.providerId) || null,
      role: clean(options.role) || null,
    };
    // 1. Settle FIRST. The teardown below closes the socket, which the host
    //    observes as DOWNSTREAM_DISCONNECT — a weaker cause that must never
    //    overwrite host-observed silence. It also carries the stall into the
    //    attempt runtime, which refuses to re-dial this route.
    try { observe.settle({ status: 'error', errorCode: code }); } catch (_) {}
    if (onStall) { try { onStall(detail); } catch (_) {} }
    // 2. Retire the route.
    finish();
    try { terminateStalledResponse(res, { code, timeoutMs, progressed: hasSentHeaders() }); } catch (_) {}
    return detail;
  }

  function arm(attempt) {
    if (state.armed() || state.finished()) return false;
    if (requestKind !== 'inference' || !res || !observe
        || typeof observe.settle !== 'function') return false;
    const budget = Number(attempt && attempt.stallTimeoutMs);
    const total = Number(attempt && attempt.requestTimeoutMs);
    if (!state.accepts(budget, total)) return false;
    const connect = Number(attempt.connectTimeoutMs) || 0;
    const startedAt = total > 0 ? Number(now()) : 0;
    const requestedDeadline = total > 0 ? Number(attempt.requestDeadlineAt) : 0;
    if (!state.arm(budget, total, connect, requestedDeadline, startedAt)) return false;
    if (total > 0) {
      deadlineTimeoutMs = total;
      const delay = Math.max(1, state.deadlineAt() - now());
      deadlineDue = performance.now() + effectiveDelay(delay);
      deadlineTimer = schedule(() => onTimeout(MODEL_REQUEST_DEADLINE, total), delay);
      deadlineTimer?.unref?.();
    }
    const write = res.write;
    if (typeof write === 'function') {
      res.write = function stallWatchProgress(...args) {
        if (!nativeProgress && args[0] != null && (readProgress ||= createModelStreamProgress())(args[0])) noteProgress();
        return write.apply(this, args);
      };
    }
    const end = res.end;
    if (typeof end === 'function') {
      res.end = function stallWatchEnd(...args) {
        finish();
        return end.apply(this, args);
      };
    }
    if (typeof res.once === 'function') {
      res.once('finish', finish);
      res.once('close', finishOnDisconnect);
      res.once('error', finishOnDisconnect);
    }
    rearm();
    return true;
  }

  function isolateRetryBudget() {
    // Claude 路由可能先查主供应商，再解析出子供应商；子请求不能继承主请求的重试余额。
    if (!state.isolateRetryBudget()) return;
    if (deadlineTimer !== null) unschedule(deadlineTimer);
    deadlineTimeoutMs = state.idleMs();
    const delay = Math.max(1, state.deadlineAt() - now());
    deadlineDue = performance.now() + effectiveDelay(delay);
    deadlineTimer = schedule(() => onTimeout(MODEL_REQUEST_DEADLINE), delay);
    deadlineTimer?.unref?.();
  }

  function dispose() { finish(); }

  function effectiveDelay(value) {
    const delay = Number(value);
    return Number.isFinite(delay) && delay > 0 && delay <= 2_147_483_647 ? Math.max(1, Math.trunc(delay)) : 1;
  }

  function nativeStreamTimeout(code, progressed) {
    if (!nativeWatch || state.finished()) return;
    if (progressed) state.progress();
    onTimeout(code, code === MODEL_REQUEST_DEADLINE ? deadlineTimeoutMs : state.idleMs());
  }

  function handleNativeDisconnect() {
    if (!nativeWatch || state.finished()) return false;
    const watch = nativeWatch;
    const code = watch.abort();
    if (!code) return false;
    nativeStreamTimeout(code, watch.streamProgressed());
    return true;
  }

  function finishOnDisconnect() {
    if (!handleNativeDisconnect()) finish();
  }

  return Object.freeze({
    arm,
    noteProgress,
    isolateRetryBudget,
    dispose,
    isArmed: () => state.armed(),
    timeoutMs: () => state.idleMs(),
    progressed: () => state.progressed(),
    deadlineAt: () => state.deadlineAt() ?? null,
    connectTimeout: () => { if (state.armed() && !state.finished()) onTimeout(MODEL_CONNECT_TIMEOUT, state.connectMs()); },
    nativeStreamTimeout,
    handleNativeDisconnect,
    useNativeProgress: exchange => {
      if (!state.armed() || state.finished()) return false;
      nativeProgress = true;
      // Fake clocks retain the original scheduler; production transfers both
      // active timers with their remaining budgets into the Rust exchange.
      if (!injectedClock && typeof exchange?.startStreamWatch === 'function') {
        const current = performance.now();
        const idle = timer !== null ? effectiveDelay(state.idleMs()) : 0;
        const idleRemaining = idle ? effectiveDelay(Math.max(1, idleAt - current)) : 0;
        const deadlineRemaining = deadlineTimer !== null
          ? effectiveDelay(Math.max(1, deadlineDue - current)) : 0;
        exchange.startStreamWatch(idle, idleRemaining, deadlineRemaining, state.progressed(), raw => {
          try {
            const detail = JSON.parse(raw);
            nativeStreamTimeout(detail.code, detail.progressed === true);
          } catch (_) { /* A malformed native notification never ends the response. */ }
        });
        nativeWatch = exchange;
        disarm();
        if (deadlineTimer !== null) unschedule(deadlineTimer);
        deadlineTimer = null;
      }
      return true;
    },
  });
}

module.exports = {
  MODEL_REQUEST_DEADLINE,
  MODEL_CONNECT_TIMEOUT,
  PROXY_STALL_CODES,
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  createProxyStallWatch,
  isProxyStallCode,
  stallCodeFor,
  terminateStalledResponse,
};
