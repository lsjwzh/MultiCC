'use strict';

const { proxyRequestKind } = require('./proxy-outcome');

// Host-side idle watchdog for one downstream inference response. The upstream
// proxy (cli-provider-router) never notices a provider that accepted the request
// and then sent nothing: it only aborts upstream when its own client walks away.
// Nothing errors, so nothing fails over either — the turn simply hangs until the
// operator cancels it. This watch is that missing terminal state: it fires only
// for Auto attempts (the caller arms it with the attempt's own budget), settles
// the host's proxy observation as a timeout BEFORE any teardown can be mistaken
// for a client disconnect, and then retires the physical route.
const RESPONSE_STALLED_BEFORE_RESPONSE = 'response_stalled_before_response';
const STREAM_IDLE_TIMEOUT = 'stream_idle_timeout';
const PROXY_STALL_CODES = Object.freeze([
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
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
      message: `upstream sent no data for ${seconds}s`,
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

// One watch per admitted downstream request. `arm(attempt)` installs it only for
// an inference request whose attempt carries a positive stall budget, so a
// non-Auto session's response object is never wrapped at all.
function createProxyStallWatch(options = {}) {
  const protocol = clean(options.protocol).toLowerCase();
  const res = options.res;
  const observe = options.observation;
  const requestKind = options.requestKind || proxyRequestKind(protocol, options.req);
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const unschedule = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onStall = typeof options.onStall === 'function' ? options.onStall : null;
  let timer = null;
  let limitMs = 0;
  let armed = false;
  let progressed = false;
  let finished = false;

  function disarm() {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  }

  function rearm() {
    disarm();
    if (finished || limitMs <= 0) return;
    timer = schedule(onTimeout, limitMs);
    // A watchdog can never be the reason the process stays alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function noteProgress() {
    if (finished) return;
    progressed = true;
    // Idle, not total: every downstream byte restarts the budget, so a long but
    // live stream is never retired — only silence is.
    if (timer !== null) rearm();
  }

  function finish() {
    if (finished) return;
    finished = true;
    disarm();
  }

  function hasSentHeaders() {
    return progressed || res?.headersSent === true;
  }

  function onTimeout() {
    timer = null;
    if (finished) return;
    const code = stallCodeFor(hasSentHeaders());
    const detail = {
      code,
      timeoutMs: limitMs,
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
    finished = true;
    disarm();
    try { terminateStalledResponse(res, { code, timeoutMs: limitMs, progressed }); } catch (_) {}
    return detail;
  }

  function arm(attempt) {
    if (armed || finished) return false;
    if (requestKind !== 'inference' || !res || !observe
        || typeof observe.settle !== 'function') return false;
    const budget = Number(attempt && attempt.stallTimeoutMs);
    if (!Number.isSafeInteger(budget) || budget <= 0) return false;
    armed = true;
    limitMs = budget;
    // Every downstream progress signal restarts the budget: headers, a body
    // chunk, or a flushed header block. Return values and `this` are preserved.
    for (const method of ['write', 'writeHead', 'flushHeaders']) {
      const original = res[method];
      if (typeof original !== 'function') continue;
      res[method] = function stallWatchProgress(...args) {
        noteProgress();
        return original.apply(this, args);
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
      res.once('close', finish);
      res.once('error', finish);
    }
    rearm();
    return true;
  }

  function dispose() {
    finished = true;
    disarm();
  }

  return Object.freeze({
    arm,
    dispose,
    isArmed: () => armed,
    timeoutMs: () => limitMs,
    progressed: () => progressed,
  });
}

module.exports = {
  PROXY_STALL_CODES,
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  createProxyStallWatch,
  isProxyStallCode,
  stallCodeFor,
  terminateStalledResponse,
};
