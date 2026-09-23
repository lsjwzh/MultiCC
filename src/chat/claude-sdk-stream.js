'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isMainResult } = require('../cli-adapters/result-completion');
const { managedRoute, createRouteRelay } = require('./claude-sdk-route');
const { fingerprint, processOptions } = require('./claude-sdk-config');
const { createMonitorAdmission, isMonitorHandoffResult } = require('./monitor-admission');

function messageQueue() {
  const messages = [];
  let wake, closed = false;
  return {
    push(message) { if (closed) throw new Error('SDK input closed'); messages.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (messages.length) yield messages.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

const cancelled = () => Object.assign(new Error('cancelled'), { code: 'SDK_INTERRUPTED' });
const alive = run => !!(run?.proc && run.proc.exitCode === null && run.proc.signalCode === null);
const safe = (fn, ...args) => { try { fn?.(...args); } catch (_) {} };

// One SDK Query and one input iterator per native conversation. Host send()
// promises end at main result boundaries; the iterator and child stay alive.
function createSdkStream({ loadSdk = () => import('@anthropic-ai/claude-agent-sdk'), spawnProcess = spawn } = {}) {
  const sessions = new Map();
  const closing = new Map();
  function hasBackground(s) { return !!s.cfg.isBackgroundActive?.(); }
  function clearIdle(s) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  function armIdle(s) {
    clearIdle(s);
    if (s.disposed || s.current || !s.run) return;
    s.idleTimer = setTimeout(() => {
      if (hasBackground(s)) { armIdle(s); return; }
      void stop(s).catch(() => {});
    }, s.cfg.idleMs ?? 600000);
    s.idleTimer.unref?.();
  }

  function settle(s, item, error, result) {
    if (s.current !== item) return;
    clearTimeout(item.cancelTimer);
    s.current = null;
    if (error) item.reject(error); else item.resolve(result);
    armIdle(s);
    setImmediate(() => pump(s));
  }

  async function stop(s) {
    if (s.stopping) return s.stopping;
    const run = s.run;
    if (!run) return;
    s.run = null; // fence buffered events before closing the transport
    clearIdle(s);
    s.stopping = (async () => {
      await run.initialized;
      run.input.close();
      safe(() => run.query?.close());
      const proc = run.proc;
      let killer;
      if (alive(run)) {
        safe(() => proc.kill('SIGTERM'));
        killer = setTimeout(() => safe(() => proc.kill('SIGKILL')), 1500);
      }
      try {
        // A same-UUID resume must wait for the *actual* old process exit.
        if (run.exited) await run.exited;
        await run.relay?.close();
      } finally {
        clearTimeout(killer);
        safe(run.dispose);
        safe(s.cfg.onDispose);
        safe(s.cfg.onExit);
      }
    })();
    try { await s.stopping; } finally { s.stopping = null; }
  }

  async function consume(s, run) {
    let failure;
    try {
      for await (const event of run.query) {
        if (s.run !== run || s.disposed) break;
        const item = s.current;
        if (event.type === 'system' && event.subtype === 'init') {
          if (event.session_id && event.session_id !== s.cfg.sessionId) throw new Error('SDK native session identity changed');
          s.started = true;
        }
        if (event.type === 'system' && /^(task_started|task_progress|task_updated|task_notification|background_tasks_changed)$/.test(event.subtype || '')) {
          safe(s.cfg.onBackgroundEvent, event);
          armIdle(s);
        }
        if (isMonitorHandoffResult(event)) continue;
        if (!item || !item.sent || item.finishing) continue;
        if (!item.firstByte) { item.firstByte = true; safe(item.onTiming, 'firstByte'); }
        if (!item.cancelled) safe(item.onEvent, event);
        if (isMainResult(event)) {
          s.started = true;
          item.finishing = true;
          // Drain proxy producers and the interrupt acknowledgement before
          // handing another user message to this query.
          void (async () => {
            try {
              await item.interrupt;
              await run.relay?.drain();
              if (s.run === run) settle(s, item, item.cancelled ? cancelled() : null, event);
            } catch (error) { await stop(s); settle(s, item, error); }
          })();
        }
      }
      failure = new Error('Claude Agent SDK stream ended before the next turn');
    } catch (error) { failure = error; }
    if (s.run !== run) return;
    if (run.stderr?.trim()) {
      failure = Object.assign(new Error(`${failure.message}\n${run.stderr.trim()}`), { code: failure.code });
    }
    await stop(s);
    if (s.current) settle(s, s.current, failure);
  }

  async function start(s) {
    const sdk = await loadSdk();
    if (s.disposed || s.current?.cancelled) throw cancelled();
    const cfg = s.cfg;
    try {
      await cfg.beforeSpawn?.({ sessionId: cfg.sessionId });
      if (s.disposed || s.current?.cancelled) throw cancelled();
    } catch (error) { safe(cfg.onDispose); throw error; }
    const run = { input: messageQueue(), proc: null, query: null, relay: null };
    run.initialized = new Promise(resolve => { run.ready = resolve; });
    s.run = run;
    try {
      if (managedRoute(cfg.env)) {
        run.relay = await createRouteRelay();
        run.relay.bind(cfg.env);
        run.routeUrl = cfg.env.ANTHROPIC_BASE_URL;
        run.routeToken = cfg.env.ANTHROPIC_AUTH_TOKEN;
      }
      if (s.disposed || s.current?.cancelled) throw cancelled();
      const materialized = processOptions(cfg, s.started, run.relay?.env);
      run.dispose = materialized.dispose;
      run.fingerprint = fingerprint(cfg);
      run.model = cfg.sdkOptions.model;
      const options = { ...materialized.options,
        ...(cfg.onBackgroundEvent ? { hooks: { UserPromptSubmit: [{ hooks: [createMonitorAdmission(
          event => s.cfg.onBackgroundEvent(event), prompt => s.current?.text === prompt,
        )] }] } } : {}),
        spawnClaudeCodeProcess({ command, args, ...opts }) {
          if (s.disposed || s.run !== run) throw cancelled();
          const proc = spawnProcess(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          run.proc = proc;
          run.exited = new Promise(resolve => {
            proc.once('exit', resolve);
            proc.once('error', () => { if (!proc.pid) resolve(); });
          });
          // Custom spawn bypasses the SDK's default stderr reader.
          proc.stderr?.on('data', data => { run.stderr = ((run.stderr || '') + data).slice(-4000); });
          return proc;
        },
      };
      run.query = sdk.query({ prompt: run.input, options });
      // Consume continuously, including background events after a result.
      void consume(s, run);
      return run;
    } catch (error) { run.ready(); await stop(s); throw error; }
    finally { run.ready(); }
  }

  async function pump(s) {
    if (s.pumping || s.current || s.disposed) return;
    s.pumping = true;
    try {
      await s.stopping;
      if (s.disposed) return;
      if (!s.queue.length) {
        if (s.recycleRequested && !hasBackground(s)) { await stop(s); s.recycleRequested = false; }
        return;
      }
      const item = s.current = s.queue.shift();
      clearIdle(s);
      try {
        // Capture per-turn configuration when send() was called, not whenever
        // a later ensure() happened while this turn was waiting in the queue.
        if (s.cfg.sessionId !== item.cfg.sessionId) s.started = item.cfg.resume === true;
        s.cfg = item.cfg;
        if (s.run?.proc && !alive(s.run)) await stop(s);
        const routeChanged = s.run?.relay && (s.run.routeUrl !== s.cfg.env.ANTHROPIC_BASE_URL
          || s.run.routeToken !== s.cfg.env.ANTHROPIC_AUTH_TOKEN);
        const changed = s.run && s.run.fingerprint !== fingerprint(s.cfg);
        if ((routeChanged || changed || s.recycleRequested) && hasBackground(s)) {
          throw Object.assign(new Error('SDK background work still owns the process'), { code: 'SDK_BACKGROUND_ACTIVE' });
        }
        if (changed || s.recycleRequested) {
          await stop(s); s.recycleRequested = false;
        }
        const run = s.run || await start(s);
        if (s.disposed || item.cancelled) throw cancelled();
        if (run.relay) {
          await run.relay.drain(); run.relay.bind(s.cfg.env);
          run.routeUrl = s.cfg.env.ANTHROPIC_BASE_URL;
          run.routeToken = s.cfg.env.ANTHROPIC_AUTH_TOKEN;
        }
        if (run.model !== s.cfg.sdkOptions.model) {
          await run.query.setModel(s.cfg.sdkOptions.model);
          run.model = s.cfg.sdkOptions.model;
        }
        if (s.disposed || item.cancelled) throw cancelled();
        safe(item.onTiming, 'spawned');
        item.sent = true;
        run.input.push({ type: 'user', session_id: s.cfg.sessionId,
          uuid: randomUUID(), parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: item.text }] } });
        safe(item.onTiming, 'sent');
      } catch (error) {
        if (error.code !== 'SDK_BACKGROUND_ACTIVE') await stop(s);
        settle(s, item, error);
      }
    } finally {
      s.pumping = false;
      if (!s.disposed && !s.current && s.queue.length) setImmediate(() => pump(s));
    }
  }

  function ensure(name, cfg) {
    let s = sessions.get(name);
    if (!s) {
      s = { cfg, nextCfg: cfg, started: cfg.resume === true, queue: [], current: null,
        run: null, disposed: false, recycling: false };
      sessions.set(name, s);
    } else s.nextCfg = cfg;
    return s;
  }
  function send(name, text, onEvent, opts = {}) {
    const s = sessions.get(name);
    if (!s || s.disposed) return Promise.reject(new Error('SDK stream session not ensured'));
    return new Promise((resolve, reject) => {
      s.queue.push({ text, onEvent, onTiming: opts.onTiming, resolve, reject, cfg: s.nextCfg });
      // Join a previous close even when the host has already created a new
      // runtime entry for the same logical session.
      Promise.resolve(closing.get(name)).then(() => pump(s), reject);
    });
  }
  function cancel(name) {
    const s = sessions.get(name);
    if (!s) return;
    for (const item of s.queue.splice(0)) item.reject(cancelled());
    const item = s.current;
    if (!item || item.cancelled) return;
    item.cancelled = true;
    const run = s.run;
    item.cancelTimer = setTimeout(() => {
      void stop(s).then(() => settle(s, item, cancelled()));
    }, s.cfg.interruptTimeoutMs ?? 3000);
    if (run?.query && item.sent && !item.finishing) {
      item.interrupt = run.query.interrupt({ cancelQueued: true });
      item.interrupt.catch(() => { void stop(s).then(() => settle(s, item, cancelled())); });
    }
  }
  function close(name) {
    const s = sessions.get(name);
    if (!s) return closing.get(name) || Promise.resolve();
    s.disposed = true;
    sessions.delete(name);
    clearIdle(s);
    for (const item of s.queue.splice(0)) item.reject(cancelled());
    const done = (async () => {
      await stop(s);
      if (s.current) settle(s, s.current, cancelled());
    })();
    closing.set(name, done);
    done.finally(() => { if (closing.get(name) === done) closing.delete(name); }).catch(() => {});
    return done;
  }
  async function waitForClose(name, { timeoutMs = 5000 } = {}) {
    const done = closing.get(name) || Promise.resolve();
    const hadProcess = closing.has(name);
    let timer;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('SDK process did not exit before cleanup deadline'),
          { code: 'CHAT_STREAM_CLOSE_TIMEOUT' })), timeoutMs);
      })]);
      return { closed: true, hadProcess };
    } finally { clearTimeout(timer); }
  }
  function closeAndWait(name, opts) {
    close(name);
    return waitForClose(name, opts);
  }
  function status(name) {
    const s = sessions.get(name);
    if (!s) return null;
    return { alive: alive(s.run), busy: !!s.current || !!s.stopping || s.pumping,
      queued: s.queue.length, started: s.started, pid: s.run?.proc?.pid || null,
      backgroundActive: hasBackground(s),
      recycling: !!s.stopping, recycleRequested: !!s.recycleRequested, backend: 'sdk' };
  }
  function recycle(name) {
    const s = sessions.get(name);
    if (!s) return { ok: false, applied: 'unknown-session' };
    if (!s.run) return { ok: true, applied: 'not-running' };
    s.recycleRequested = true;
    if (s.current || s.pumping || s.stopping) return { ok: true, applied: 'deferred-boundary' };
    if (hasBackground(s)) return { ok: true, applied: 'deferred-background' };
    void pump(s);
    return { ok: true, applied: 'now' };
  }
  return { ensure, send, inject: send, cancel, close, closeAndWait, waitForClose, status, recycle,
    isAlive: name => alive(sessions.get(name)?.run), isClosing: name => closing.has(name) };
}

module.exports = { createSdkStream };
