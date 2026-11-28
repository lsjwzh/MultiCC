'use strict';

const { randomUUID } = require('node:crypto');
const { isMainResult } = require('../native/binding').cliResultCompletion;
const { managedRoute, createRouteRelay } = require('../native/binding').claudeSdkRoute;
const { fingerprint, laneOptions } = require('../native/binding').claudeSdkConfig;
const { envDigest } = require('../secrets-vault');
const { createMonitorAdmission, isMonitorHandoffResult } = require('../native/binding').getMonitorAdmission();
const { createBackgroundHold, processStale } = require('./background-hold');
const { decideMissingResume } = require('../native/binding').missingResumeRecovery;
const { bundledClaudeCodeBinary } = require('../native/binding').cliCapability;
const { getWriterGroup, getNative } = require('../native/binding');

// Native lane events are pushed from a ThreadsafeFunction callback, i.e. on the
// JS thread but outside the consume-loop microtask; the queue keeps the old
// async-iterator shape so the conversation logic above it is unchanged.
function laneEvents() {
  const queue = [];
  let wake = null, ended = false;
  return {
    push(event) { if (ended) return; queue.push(event); const resume = wake; wake = null; resume?.(); },
    end() { ended = true; const resume = wake; wake = null; resume?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended) return;
        await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

const cancelled = () => Object.assign(new Error('cancelled'), { code: 'SDK_INTERRUPTED' });
const alive = run => !!run?.lane && run.lane.alive === true;
const safe = (fn, ...args) => { try { return fn?.(...args); } catch (_) {} };
// What counts as "this turn already reached the host" for the replay gate: only
// frames that carry this turn's output. A `system` init/hook/task frame is
// bookkeeping the host receives again from any replacement child — exactly as
// a normal process recycle re-delivers it — so it must not block a replay.
const carriesTurnOutput = event => /^(assistant|stream_event|user|result)$/.test(event?.type || '');
// How many stream-end healings (missing-resume rotation or session-id collision
// rotation) one user message may buy before the failure is surfaced.
const STREAM_END_RECOVERY_MAX = 2;
const safeTail = run => { try { return run.lane?.stderrTail?.() || run.stderr || ''; } catch (_) { return run.stderr || ''; } };
// Where the CLI puts a refusal notice: `errors[]`, `error` or `result`.
function resultNotice(event) {
  const parts = [];
  if (typeof event.result === 'string') parts.push(event.result);
  if (typeof event.error === 'string') parts.push(event.error);
  else if (event.error && typeof event.error.message === 'string') parts.push(event.error.message);
  if (Array.isArray(event.errors)) {
    for (const value of event.errors) if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

// One RustClaudeLane (one `claude` child) per native conversation. Host send()
// promises end at main result boundaries; the process stays alive between them.
function createSdkStream({ binary, binaryArgs = [], createLane = callback => new (getNative().RustClaudeLane)(callback) } = {}) {
  const sessions = new Map();
  const closing = new Map();
  // A napi ThreadsafeFunction does not hold the Node event loop open, but a
  // live RustClaudeLane must outlive an idle JS microtask queue. One ref'd
  // timer keeps the loop alive while any lane is running.
  let laneKeepAlive = null;
  let laneKeepAliveCount = 0;
  function acquireLaneKeepAlive() {
    laneKeepAliveCount += 1;
    if (!laneKeepAlive) laneKeepAlive = setInterval(() => {}, 1 << 30);
  }
  function releaseLaneKeepAlive() {
    laneKeepAliveCount = Math.max(0, laneKeepAliveCount - 1);
    if (!laneKeepAliveCount && laneKeepAlive) { clearInterval(laneKeepAlive); laneKeepAlive = null; }
  }
  function hasBackground(s) { return !!s.cfg.isBackgroundActive?.(); }
  // The facts one staleness comparison needs. The kernel side decides what
  // counts as drift (route/credentials, config, vault), so the pump and the
  // injectable predicate cannot drift apart. Route identity only exists for a
  // relay-bound process; without a relay both sides stay null and never differ.
  function runningProcessFacts(run) {
    return {
      routeUrl: run?.relay ? (run.routeUrl ?? null) : null,
      routeToken: run?.relay ? (run.routeToken ?? null) : null,
      fingerprint: run?.fingerprint ?? null,
      vaultDigest: run?.vaultDigest ?? null,
    };
  }
  function wantedProcessFacts(cfg) {
    const env = cfg?.env || {};
    return {
      routeUrl: env.ANTHROPIC_BASE_URL ?? null,
      routeToken: env.ANTHROPIC_AUTH_TOKEN ?? null,
      fingerprint: fingerprint(cfg),
      vaultDigest: envDigest(env),
    };
  }
  function stalenessOf(run, cfg) {
    const none = { routeChanged: false, configChanged: false, vaultStale: false, stale: false };
    if (!run) return none;
    const stale = processStale(runningProcessFacts(run), wantedProcessFacts(cfg));
    // A lane without a relay has no route identity. Configuration IO errors
    // propagate: callers must never interpret unreadable settings as freshness.
    if (!run.relay) stale.routeChanged = false;
    stale.stale = stale.routeChanged === true || stale.configChanged === true || stale.vaultStale === true;
    return stale;
  }
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
    item.hold?.dispose();
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
      safe(() => run.lane?.closeInput());
      let killer;
      if (alive(run)) {
        safe(() => run.lane.kill('SIGTERM'));
        killer = setTimeout(() => safe(() => run.lane.kill('SIGKILL')), 1500);
      }
      try {
        // A same-UUID resume must wait for the *actual* old process exit.
        if (run.exited) await run.exited;
        safe(() => run.events.end());
        await run.relay?.close();
      } finally {
        clearTimeout(killer);
        if (run.holdsKeepAlive) { run.holdsKeepAlive = false; releaseLaneKeepAlive(); }
        safe(run.dispose);
        safe(s.cfg.onDispose);
        safe(s.cfg.onExit);
      }
    })();
    try { await s.stopping; } finally { s.stopping = null; }
  }

  function finish(s, run, item, event) {
    s.started = true;
    item.finishing = true;
    // Drain proxy producers and the interrupt acknowledgement before
    // handing another user message to this query.
    void (async () => {
      try {
        // Native result callbacks can overtake sendUser's Promise callback.
        // Finalize only after the send pump releases ownership, so classify
        // cannot mistake this completed turn for a still-busy SDK stream.
        await item.pumpFinished;
        await item.interrupt;
        try { await run.relay?.drain(); } catch (error) {
          // Background agents still stream through the relay (hold cap reached).
          // The answer is complete; pump() drains again before binding the next
          // route, so do not kill the process and its background work here.
          if (error?.code !== 'SDK_ROUTE_BUSY' || !hasBackground(s) || item.cancelled) throw error;
        }
        if (s.run === run) settle(s, item, item.cancelled ? cancelled() : null, event);
      } catch (error) { await stop(s); settle(s, item, error); }
    })();
  }

  // A `--resume` whose transcript Claude no longer has answers with a RESULT,
  // not with a stream failure, so that result is the only evidence of it. The
  // kernel decides (is this the missing answer, was this spawn really a resume,
  // has anything been forwarded, is the attempt spent); this function performs
  // the IO: fence the failed run, persist the replacement id, hand the host its
  // checkpoint, and replay the SAME message on a NEW native session.
  //
  // Replay is safe only because forwardedEventCount === 0: the host received no
  // event of this turn, so running it again cannot duplicate output or tool side
  // effects. It must spawn with `resume: false` — a brand-new id has no
  // transcript yet, and `--resume <new id>` fails exactly like the turn being
  // recovered.
  async function rotateMissingResume(s, run, item, decision) {
    // Never stop a newer run: only the run that produced the answer may rotate.
    if (s.run !== run) return;
    item.resumeRecoveryAttempt = (item.resumeRecoveryAttempt || 0) + 1;
    const previousSessionId = s.cfg.sessionId;
    const nextSessionId = decision.nextSessionId;
    // stop() fences the run first: its buffered events, stderr tail and
    // streamError all belong to the turn that already ended, never to the replay.
    await stop(s);
    if (s.disposed || item.cancelled) {
      if (s.current === item) { s.current = null; item.reject(cancelled()); }
      return;
    }
    const cfg = item.cfg;
    cfg.sessionId = nextSessionId;
    cfg.resume = false;
    // ensure() may already have staged a different object for a later send; it
    // must not keep pointing at the transcript the CLI just disowned.
    if (s.nextCfg && s.nextCfg !== cfg) s.nextCfg.sessionId = nextSessionId;
    s.started = false; // the replacement child must be created, never resumed
    safe(cfg.onNewSessionId, nextSessionId);
    const recovery = safe(cfg.onResumeTargetMissing, { previousSessionId, sessionId: nextSessionId });
    const replacement = typeof recovery === 'string' ? recovery : recovery && recovery.text;
    if (typeof replacement === 'string' && replacement.trim()) item.text = replacement;
    item.firstByte = false; // the replay reports its own first byte
    item.sent = false; // ...and is not on the wire to the failed child any more
    item.epoch = (item.epoch || 0) + 1; // void any still-pending failure of the old run
    if (s.current === item) s.current = null;
    s.queue.unshift(item);
    console.warn('[multicc/claude-sdk-stream] resume target missing; rotating native session and retrying');
    setImmediate(() => pump(s));
  }

  async function consume(s, run) {
    let failure;
    try {
      for await (const event of run.events) {
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
        const live = item && item.sent && !item.finishing;
        // Self-wake queries of a held turn stream into it; their results stay internal.
        if (live && item.hold?.held && item.hold.observe(event)) continue;
        if (isMonitorHandoffResult(event)) continue;
        // The missing-resume answer is this turn's FIRST event, before anything
        // was forwarded, so decide here: ahead of the `live` gate (a `--resume`
        // spawn can report the dead target and exit before `item.sent` flips,
        // and dropping the event would lose the only heal), the timing callback
        // and every forward path. Only a result carries it, so ordinary stream
        // traffic never pays for a native round trip.
        if (item && !item.finishing && !item.cancelled && event.type === 'result') {
          const decision = decideMissingResume({ event,
            lastSpawnWasResume: s.cfg.resume === true,
            forwardedEventCount: item.eventCount || 0,
            attempt: item.resumeRecoveryAttempt || 0 });
          if (decision.action === 'rotate') { await rotateMissingResume(s, run, item, decision); return; }
          // A spawn collision ("Session ID … is already in use") is the CLI's
          // first and only word: nothing of this turn reached the host yet, so
          // rotating the native id and replaying cannot duplicate output. The
          // legacy lane heals the same stderr on exit; the SDK lane must heal
          // it here, before the refusal is forwarded and counted as output.
          if (event.is_error === true && (item.eventCount || 0) === 0
              && (item.resumeRecoveryAttempt || 0) < STREAM_END_RECOVERY_MAX
              && /already in use/i.test(resultNotice(event))) {
            console.warn('[multicc/claude-sdk-stream] native session id in use; rotating and replaying');
            await rotateMissingResume(s, run, item, { action: 'rotate', nextSessionId: randomUUID() });
            return;
          }
        }
        if (!live) continue;
        if (!item.firstByte) { item.firstByte = true; safe(item.onTiming, 'firstByte'); }
        if (isMainResult(event) && !item.cancelled) {
          s.started = true;
          item.hold ||= createBackgroundHold({ ...s.cfg.backgroundHold, hasBackground: () => hasBackground(s),
            // Visibility, not release (L2): the cap fires at most once per held
            // turn and the host writes one session notice.
            onCapReached: ms => safe(s.cfg.onHoldCap, ms),
            onBoundary: event => safe(item.onEvent, event),
            release: result => { if (s.run === run && s.current === item && !item.finishing) {
              safe(item.onEvent, result); finish(s, run, item, result);
            } } });
          if (item.hold.start(event)) continue;
        }
        // Count the output that actually reached the host: the replay-safety
        // gate reads it (see carriesTurnOutput).
        if (!item.cancelled) {
          safe(item.onEvent, event);
          if (carriesTurnOutput(event)) item.eventCount += 1;
        }
        if (isMainResult(event)) finish(s, run, item, event);
      }
      failure = run.streamError
        || new Error('Claude Agent SDK stream ended before the next turn');
    } catch (error) { failure = error; }
    if (s.run !== run) return;
    if (!run.stderr) run.stderr = safeTail(run);
    if (run.stderr?.trim()) {
      failure = Object.assign(new Error(`${failure.message}\n${run.stderr.trim()}`), { code: failure.code });
    }
    // A spawn the CLI refused ("Session ID … is already in use") or a missing
    // resume notice whose result event lost the race with the exit event ends
    // the stream with nothing forwarded: heal it exactly where the legacy lane
    // heals it on exit — rotate the native id and replay the same message.
    const stranded = s.current;
    if (stranded && !stranded.cancelled && (stranded.eventCount || 0) === 0
        && (stranded.resumeRecoveryAttempt || 0) < STREAM_END_RECOVERY_MAX) {
      const tail = (run.stderr || '').trim();
      if (tail) {
        const attempt = stranded.resumeRecoveryAttempt || 0;
        let decision = null;
        try {
          decision = decideMissingResume({ event: { type: 'result', is_error: true, errors: [tail] },
            lastSpawnWasResume: s.cfg.resume === true, forwardedEventCount: 0, attempt });
        } catch (_) { decision = null; }
        if (decision?.action === 'rotate') {
          await rotateMissingResume(s, run, stranded, decision);
          return;
        }
        if (/already in use/i.test(tail)) {
          console.warn('[multicc/claude-sdk-stream] native session id in use; rotating and replaying');
          await rotateMissingResume(s, run, stranded, { action: 'rotate', nextSessionId: randomUUID() });
          return;
        }
      }
    }
    await stop(s);
    if (s.current) settle(s, s.current, failure);
  }

  function dispatchLaneEvent(s, run, kind, a, b) {
    if (kind === 'message') {
      let event;
      try { event = JSON.parse(a); } catch (error) { run.streamError = error; run.events.end(); return; }
      run.events.push(event);
      return;
    }
    if (kind === 'hook_callback') {
      const requestId = a;
      let input = {};
      try { input = JSON.parse(b); } catch (_) {}
      void (async () => {
        let response = {};
        try {
          if (run.admission) {
            // The CLI hard-times out a hook after 30s and this goroutine, not
            // an abort signal, owns the answer: allow before that deadline so a
            // stalled host delivery can never wedge native input.
            let timer;
            const deadline = new Promise(resolve => {
              timer = setTimeout(() => resolve({}), s.cfg.hookTimeoutMs ?? 25000);
              timer.unref?.();
            });
            try { response = await Promise.race([run.admission(input), deadline]) ?? {}; }
            finally { clearTimeout(timer); }
          }
        } catch (error) {
          if (!run.cancelledHooks.has(requestId)) {
            safe(() => run.lane.respondControlError(requestId, String((error && error.message) || error)));
          }
          return;
        }
        if (run.cancelledHooks.has(requestId)) return;
        safe(() => run.lane.respondControl(requestId, JSON.stringify(response)));
      })();
      return;
    }
    if (kind === 'control_cancel') { run.cancelledHooks.add(a); return; }
    if (kind === 'error') {
      run.streamError = new Error(a || 'Claude Code protocol error');
      run.events.end();
      return;
    }
    if (kind === 'exit') {
      let meta = {};
      try { meta = JSON.parse(b); } catch (_) {}
      if (meta.stderrTail) run.stderr = meta.stderrTail;
      run.exitCode = a === '' ? null : Number(a);
      run.exitSignal = meta.signal ?? null;
      safe(() => run.resolveExit?.());
      run.events.end();
    }
  }

  async function start(s) {
    if (s.disposed || s.current?.cancelled) throw cancelled();
    const cfg = s.cfg;
    let writerToken = null;
    try {
      await cfg.beforeSpawn?.({ sessionId: cfg.sessionId });
      // Fail-closed writer registration, same contract as the process
      // backends: the lease exists before the lane does, and it is held until
      // the lane's whole process group is gone so the CLI's own background
      // children stay registered without any event reaching the host.
      writerToken = typeof cfg.acquireWriter === 'function' ? cfg.acquireWriter({ sessionId: cfg.sessionId }) : null;
      if (s.disposed || s.current?.cancelled) throw cancelled();
    } catch (error) {
      if (writerToken) { try { cfg.releaseWriter?.(writerToken); } catch (_) {} writerToken = null; }
      safe(cfg.onDispose); throw error;
    }
    const run = { events: laneEvents(), lane: null, relay: null, cancelledHooks: new Set() };
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
      const materialized = laneOptions(cfg, s.started, run.relay?.env);
      run.dispose = materialized.dispose;
      run.fingerprint = fingerprint(cfg);
      run.vaultDigest = envDigest(cfg.env);
      run.model = cfg.sdkOptions.model;
      // Which spawn contract this process serves (see background-hold): a
      // typed message may enter a held turn only while the live process is
      // still the one a fresh turn would spawn.
      run.contract = cfg.spawnContract ?? null;
      const command = binary || bundledClaudeCodeBinary();
      if (!command) throw new Error('Bundled Claude Code binary is not available');
      run.admission = cfg.onBackgroundEvent ? createMonitorAdmission(
        event => s.cfg.onBackgroundEvent(event), prompt => s.current?.text === prompt,
      ) : null;
      run.exited = new Promise(resolve => { run.resolveExit = resolve; });
      // The lease rides on the run and is released from THIS promise, not from
      // any guarded event handler: spawn failure, natural exit and stop() all
      // resolve it, and a park simply empties the slot beforehand.
      run.writerLeaseToken = writerToken || null;
      run.exited.then(() => {
        const token = run.writerLeaseToken;
        run.writerLeaseToken = null;
        if (!token) return;
        getWriterGroup().whenGroupEmpty(run.lane?.pid, () => { try { cfg.releaseWriter?.(token); } catch (_) {} });
      });
      // napi delivers the ThreadsafeFunction tuple as one JS argument.
      run.lane = createLane(payload => dispatchLaneEvent(s, run, ...payload));
      acquireLaneKeepAlive();
      run.holdsKeepAlive = true;
      const started = JSON.parse(await run.lane.start(JSON.stringify({
        ...materialized.config, binary: command, binaryArgs,
      })));
      run.argv = started.argv;
      if (writerToken && run.lane.pid) setImmediate(() => { try { cfg.annotateWriter?.(writerToken, run.lane.pid); } catch (_) {} });
      if (s.disposed || s.current?.cancelled) throw cancelled();
      // Consume continuously, including background events after a result.
      void consume(s, run);
      return run;
    } catch (error) {
      // No child means no exit event: release stop()'s await instead of
      // leaving the turn pending on a promise nothing will settle.
      run.ready();
      safe(() => run.resolveExit?.());
      await stop(s);
      throw error;
    } finally { run.ready(); }
  }

  async function pump(s) {
    if (s.pumping || s.current || s.disposed) return;
    s.pumping = true;
    let finishPump;
    try {
      await s.stopping;
      if (s.disposed) return;
      if (!s.queue.length) {
        if (s.recycleRequested && !hasBackground(s)) { await stop(s); s.recycleRequested = false; }
        return;
      }
      const item = s.current = s.queue.shift();
      // Which delivery of this message this pump owns. A missing-resume
      // rotation replaces the run while this pump may still be inside
      // sendUser, then re-queues the same item; its late failure belongs to the
      // dead run and must neither stop nor settle the replay.
      const epoch = item.epoch || 0;
      item.pumpFinished = new Promise(resolve => { finishPump = resolve; });
      clearIdle(s);
      try {
        // Capture per-turn configuration when send() was called, not whenever
        // a later ensure() happened while this turn was waiting in the queue.
        if (s.cfg.sessionId !== item.cfg.sessionId) s.started = item.cfg.resume === true;
        s.cfg = item.cfg;
        if (s.run?.lane && !alive(s.run)) await stop(s);
        // The same staleness comparison the injectable predicate makes, so the
        // pump and the predicate can never disagree about a live process.
        const { routeChanged, configChanged: changed, vaultStale } = stalenessOf(s.run, s.cfg);
        if ((routeChanged || changed || s.recycleRequested) && hasBackground(s)) {
          throw Object.assign(new Error('SDK background work still owns the process'), { code: 'SDK_BACKGROUND_ACTIVE' });
        }
        // Vault drift is not route drift: with background work owning the
        // process it waits for the next turn instead of refusing this one.
        if (changed || s.recycleRequested || (vaultStale && !hasBackground(s))) {
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
          await run.lane.setModel(s.cfg.sdkOptions.model);
          run.model = s.cfg.sdkOptions.model;
        }
        if (s.disposed || item.cancelled) throw cancelled();
        safe(item.onTiming, 'spawned');
        item.sent = true;
        await run.lane.sendUser(JSON.stringify({ type: 'user', session_id: s.cfg.sessionId,
          uuid: randomUUID(), parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: item.text }] } }));
        safe(item.onTiming, 'sent');
      } catch (error) {
        if ((item.epoch || 0) !== epoch) return;
        if (error.code !== 'SDK_BACKGROUND_ACTIVE') await stop(s);
        settle(s, item, error);
      }
    } finally {
      s.pumping = false;
      finishPump?.();
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
      s.queue.push({ text, onEvent, onTiming: opts.onTiming, resolve, reject, cfg: s.nextCfg,
        eventCount: 0, resumeRecoveryAttempt: 0, epoch: 0 });
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
    if (item.hold?.held) {
      // Preserve explicit outcomes for injected answers cut short by cancel.
      item.hold.interruptInjections();
      const result = item.hold.flush();
      void stop(s).then(() => settle(s, item, null, result));
      return;
    }
    item.cancelled = true;
    const run = s.run;
    item.cancelTimer = setTimeout(() => {
      void stop(s).then(() => settle(s, item, cancelled()));
    }, s.cfg.interruptTimeoutMs ?? 3000);
    if (run?.lane && item.sent && !item.finishing) {
      item.interrupt = run.lane.interrupt();
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
  // The resident lane's control channel is the authoritative source for a
  // background task's output and can stop one task precisely. Both surface
  // null/false when they cannot be served — stream closed, child gone, or a
  // CLI that does not answer the subtype — so every caller keeps its
  // file-read / process-kill fallback instead of guessing.
  async function getTaskOutput(name, taskId) {
    const run = sessions.get(name)?.run;
    const id = String(taskId || '');
    if (!run || !alive(run) || !id) return null;
    try {
      const response = JSON.parse(await run.lane.getTaskOutput(id));
      if (!response || typeof response !== 'object') return null;
      return { output: String(response.output ?? ''),
        totalBytes: Number(response.total_bytes) || 0,
        truncated: response.truncated === true };
    } catch (_) { return null; }
  }
  async function stopTask(name, taskId) {
    const run = sessions.get(name)?.run;
    const id = String(taskId || '');
    if (!run || !alive(run) || !id) return false;
    try { await run.lane.stopTask(id); return true; } catch (_) { return false; }
  }

  function status(name) {
    const s = sessions.get(name);
    if (!s) return null;
    return { alive: alive(s.run), busy: !!s.current || !!s.stopping || s.pumping,
      queued: s.queue.length, started: s.started, pid: s.run?.lane?.pid || null,
      backgroundActive: hasBackground(s),
      recycling: !!s.stopping, recycleRequested: !!s.recycleRequested, backend: 'native' };
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
  // Deliver a message the user typed INTO the held turn (the item's answer is
  // complete, its background work still runs): the next user line goes to the
  // same live lane the pump uses, and the hold counts the outstanding answer so
  // the turn cannot end before it lands.
  //
  // Exactly-once: the delivery identity is registered in Rust BEFORE the line is
  // written. `write` writes the line with the registered uuid, `append_only`
  // re-appends only the missing history row of a line already written once, and
  // `refuse` waits for a normal turn. A failed write aborts the registration.
  async function injectHeldTurn(name, text, identity) {
    const s = sessions.get(name);
    const item = s && s.current;
    const run = s && s.run;
    if (!item || !item.sent || item.finishing || item.cancelled || !alive(run)) {
      return { delivered: false, reason: 'no_held_turn' };
    }
    const hold = item.hold;
    if (!hold || !hold.held) return { delivered: false, reason: 'not_held' };
    const id = String(identity ?? '');
    const registration = hold.beginInjection(id, randomUUID());
    const action = registration?.action;
    if (action === 'refuse') return { delivered: false, reason: registration.reason || 'refused' };
    const acknowledgeHistory = () => hold.acknowledgeHistory(id, registration.uuid);
    if (action === 'append_only') return { delivered: true, appendOnly: true, identity: id, uuid: registration.uuid, acknowledgeHistory };
    if (action !== 'write') return { delivered: false, reason: 'refused' };
    try {
      await run.lane.sendUser(JSON.stringify({ type: 'user', session_id: s.cfg.sessionId,
        uuid: registration.uuid, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: String(text) }] } }));
      hold.confirmInjection(id, registration.uuid);
      return { delivered: true, identity: id, uuid: registration.uuid, acknowledgeHistory };
    } catch (_) {
      hold.abortInjection(id);
      return { delivered: false, reason: 'write_failed' };
    }
  }

  // Facts for the delivery predicate (held phase, liveness, spawn contract of
  // the running process and whether that process still matches what a fresh
  // turn would want). `attributable` says the lane reports which user message
  // each result answers — this one stamps a uuid on the injected line and the
  // SDK echoes it in `user_message_uuids`.
  function heldTurn(name, identity) {
    const s = sessions.get(name);
    const hold = s && s.current?.hold;
    return {
      held: !!hold?.held,
      historyPending: !!hold?.historyPending(String(identity ?? '')),
      historyWritten: !!hold?.historyWritten(String(identity ?? '')),
      alive: alive(s?.run),
      attributable: true,
      // Compare against the LATEST desired configuration: a queued turn whose
      // ensure already staged another provider/route/vault is a process change
      // too, so the typed message must wait instead of entering the old process.
      stale: s ? stalenessOf(s.run, s.nextCfg || s.cfg).stale === true : false,
      contract: s?.run?.contract ?? null,
    };
  }

  // Park/claim hooks for the stream router, same contract as the process
  // backends: park releases the warm lane's lease outright (a parked lane
  // cannot receive input), claim re-registers it before residency lets sends
  // through again.
  function releaseWriterLease(name) {
    const s = sessions.get(name);
    const run = s?.run;
    const token = run?.writerLeaseToken;
    if (!run || !token) return false;
    run.writerLeaseToken = null;
    try { s.cfg.releaseWriter?.(token); } catch (_) {}
    return true;
  }
  function acquireWriterLease(name) {
    const s = sessions.get(name);
    const run = s?.run;
    if (!s || !alive(run) || run.writerLeaseToken) return false;
    const token = typeof s.cfg.acquireWriter === 'function' ? s.cfg.acquireWriter({ sessionId: s.cfg.sessionId }) : null;
    if (!token) return false;
    run.writerLeaseToken = token;
    if (run.lane.pid) setImmediate(() => { try { s.cfg.annotateWriter?.(token, run.lane?.pid); } catch (_) {} });
    return true;
  }

  return { ensure, send, inject: send, cancel, close, closeAndWait, waitForClose, status, recycle,
    getTaskOutput, stopTask, injectHeldTurn, heldTurn, releaseWriterLease, acquireWriterLease,
    isAlive: name => alive(sessions.get(name)?.run), isClosing: name => closing.has(name) };
}

module.exports = { createSdkStream };
