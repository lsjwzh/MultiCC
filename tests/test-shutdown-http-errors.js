'use strict';
// Unit tests for src/shutdown.js and src/http-errors.js.

const { createShutdownCoordinator } = require('../src/shutdown');
const { requestIdMiddleware, safeErrorHandler, asyncHandler, safeError, makeRequestId } = require('../src/http-errors');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

function fakeLogger() {
  const rec = { log: [], warn: [], error: [] };
  return {
    rec,
    log: (m) => rec.log.push(String(m)),
    warn: (m) => rec.warn.push(String(m)),
    error: (m) => rec.error.push(String(m)),
  };
}

(async () => {
  // ── coordinator: happy path ordering ──────────────────────────────
  {
    const order = [];
    let now = 0;
    const c = createShutdownCoordinator({
      logger: fakeLogger(),
      now: () => now,
      exit: (code) => order.push(`exit:${code}`),
    });
    c.onCheckpoint(() => order.push('checkpoint'));
    c.onDrain(async () => { order.push('drain-start'); await Promise.resolve(); order.push('drain-end'); });
    c.onClose(() => order.push('close-1'));
    c.onClose(async () => { order.push('close-2'); });
    ok(c.ready() === true && !c.isShuttingDown(), 'coordinator: ready before shutdown');
    await c.shutdown({ reason: 'test', graceMs: 100, exitCode: 0 });
    ok(order.join('→') === 'checkpoint→drain-start→drain-end→close-1→close-2→exit:0',
      'coordinator: order = checkpoint → drain → close (registration order) → exit');
    ok(!c.ready() && c.isShuttingDown(), 'coordinator: ready() false after shutdown');
  }

  // ── coordinator: drain timeout still runs closers ─────────────────
  {
    const order = [];
    const c = createShutdownCoordinator({
      logger: fakeLogger(),
      exit: () => order.push('exit'),
    });
    c.onDrain(() => new Promise(() => {}));   // never resolves
    c.onClose(() => order.push('closer'));
    await c.shutdown({ reason: 'timeout-test', graceMs: 30 });
    ok(order[0] === 'closer' && order[1] === 'exit', 'coordinator: drain timeout → closers + exit still run');
  }

  // ── coordinator: closer errors don't abort the chain ──────────────
  {
    const rec = fakeLogger();
    const order = [];
    const c = createShutdownCoordinator({ logger: rec, exit: () => order.push('exit') });
    c.onClose(() => { throw new Error('boom'); });
    c.onClose(() => order.push('after-boom'));
    await c.shutdown({ reason: 'err-test', graceMs: 30 });
    ok(order.join(',') === 'after-boom,exit', 'coordinator: closer error logged, chain continues');
    ok(rec.rec.error.some(m => /boom/.test(m)), 'coordinator: closer error surfaces in logger');
  }

  // ── coordinator: idempotent shutdown ─────────────────────────────
  {
    let exits = 0;
    const c = createShutdownCoordinator({ logger: fakeLogger(), exit: () => { exits++; } });
    let n = 0;
    c.onCheckpoint(() => { n++; });
    await c.shutdown({ reason: 'first', graceMs: 10 });
    await c.shutdown({ reason: 'second', graceMs: 10 });
    ok(n === 1 && exits === 1, 'coordinator: second shutdown call is a no-op');
  }

  // ── http-errors: makeRequestId shape ──────────────────────────────
  {
    const id = makeRequestId();
    ok(/^[0-9a-f]{8}$/.test(id), 'makeRequestId returns 8 hex chars');
  }

  // ── http-errors: middleware stamps req.id + header ────────────────
  {
    const req = {};
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, locals: {} };
    let called = false;
    requestIdMiddleware(req, res, () => { called = true; });
    ok(called && typeof req.id === 'string' && req.id.length === 8, 'middleware assigns req.id');
    ok(res.locals.requestId === req.id, 'middleware mirrors id on res.locals');
    ok(headers['X-Multicc-Request-Id'] === req.id, 'middleware sets response header');
  }

  // ── http-errors: safeErrorHandler redacts stack, echoes requestId ─
  {
    const logger = fakeLogger();
    const handler = safeErrorHandler(logger);
    let sent, status;
    const req = { id: 'rid1234', method: 'GET', originalUrl: '/api/x' };
    const res = {
      headersSent: false,
      locals: { requestId: 'rid1234' },
      status(s) { status = s; return this; },
      json(b) { sent = b; return this; },
    };
    const err = new Error('secret /Users/z/.env parse failed');
    err.stack = 'Error: secret\n    at leaked.js:1:1';
    handler(err, req, res, () => {});
    ok(status === 500, 'error handler: 500 default');
    ok(sent && sent.error === 'internal_error' && sent.requestId === 'rid1234',
      'error handler: body only exposes generic error + requestId');
    ok(!JSON.stringify(sent).includes('.env') && !JSON.stringify(sent).includes('leaked.js'),
      'error handler: secret / stack never leak into body');
    ok(logger.rec.error.some(m => /rid1234/.test(m) && /leaked\.js/.test(m)),
      'error handler: full detail lands in logger with the id');
  }

  // ── http-errors: safeError preserves opt-in messages ─────────────
  {
    const handler = safeErrorHandler(fakeLogger());
    let sent, status;
    const req = { id: 'rid5678', method: 'POST', originalUrl: '/api/y' };
    const res = {
      headersSent: false,
      locals: { requestId: 'rid5678' },
      status(s) { status = s; return this; },
      json(b) { sent = b; return this; },
    };
    handler(safeError(400, 'name and path required', 'invalid'), req, res, () => {});
    ok(status === 400 && sent.error === 'name and path required' && sent.code === 'invalid',
      'safeError: opt-in message + code passes through');
  }

  // ── http-errors: asyncHandler forwards rejection ─────────────────
  {
    const wrapped = asyncHandler(async () => { throw new Error('boom'); });
    await new Promise((resolve) => {
      wrapped({}, {}, (err) => {
        ok(err && err.message === 'boom', 'asyncHandler forwards rejection to next()');
        resolve();
      });
    });
  }

  console.log(`\n== shutdown + http-errors unit: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
