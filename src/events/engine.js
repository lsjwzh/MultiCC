'use strict';

// Event rule engine: subscribes to the hub and runs matching rules.
// Rule sources: global rules (own JSON file) + session triggers of type:'event'
// (persisted.triggers). Guards: cooldown, fan-out cap, depth cap, and a
// self-inject latch so a turn the engine caused cannot re-trigger inject.
//
// Chains: a rule may list follow-up actions (`then`). They run in order; a
// step that injected a prompt parks the chain on its target session until that
// session's next terminal event — task.finished runs the next step with the new
// event (so the step's conclusion flows into the next prompt), failed /
// waiting_user stop the chain, waiting_background keeps waiting.
// - A terminal event that only follows the user's own turns (turn.completed
//   lineage `user`/`dispatch`, no `trigger` turn yet) is not the step's and is
//   ignored; with no lineage seen at all the event is trusted as before.
// - A next step whose session is busy waits for that session's next
//   task.finished instead of failing.
// Parked chains are persisted next to the global rules so a restart resumes them.

const { matchesAny } = require('./catalog');
const { ACTIONS } = require('./actions');
const { validateEventRule, matchesFilter, channelActions, channelProblem } = require('./rules');
const channelRegistry = require('../plugins/channel-registry');

const MAX_FANOUT = 20;
const MAX_DEPTH = 2;
const MAX_GLOBAL_RULES = 100;
const TERMINAL = new Set(['task.finished', 'task.failed', 'task.waiting_user', 'task.waiting_background']);
const CHAIN_ADVANCE = 'task.finished';
const CHAIN_STOP = new Set(['task.failed', 'task.waiting_user']);
const CHAIN_STEP_TIMEOUT_MS = 6 * 3600 * 1000;
const MAX_PENDING_CHAINS = 200;

function createEventRuleEngine(deps) {
  const { hub, persistedSessions, saveBestEffort } = deps;
  if (!hub || typeof hub.subscribe !== 'function') throw new TypeError('event engine dependency missing: hub');
  if (!(persistedSessions instanceof Map)) throw new TypeError('event engine dependency missing: persistedSessions');
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.logger || console;
  const idFactory = deps.idFactory || (() => require('crypto').randomUUID());
  const actionCtx = {
    now,
    notify: deps.notify || (() => false),
    injectPrompt: deps.injectPrompt || (() => false),
    createSession: deps.createSession || (async () => { throw new Error('no session factory'); }),
    sessionInfo: deps.sessionInfo || (() => null),
    resolveSecret: deps.resolveSecret || (() => null),
    lookup: deps.lookup || (async () => []),
    httpPost: deps.httpPost || (async () => { throw Object.assign(new Error('no transport'), { code: 'NO_TRANSPORT' }); }),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    allowPrivateWebhooks: deps.allowPrivateWebhooks === true,
    deliverChannel: deps.deliverChannel || ((plugin, payload) => channelRegistry.deliver(plugin, payload)),
  };
  const checkChannelTarget = deps.checkChannelTarget || channelRegistry.checkTarget;

  let globalRules = [];
  const lastFired = new Map();   // ruleId[:sessionId] -> ts
  const selfInjected = new Map(); // sessionId -> ruleId that injected
  const chains = new Map();      // sessionId -> { ruleId, owner, index, since } parked chain
  const results = [];            // bounded recent run log
  let unsubscribe = null;

  let loadFailed = false;

  function load() {
    loadFailed = false;
    chains.clear();
    try {
      const data = deps.store ? deps.store.read() : null;
      globalRules = Array.isArray(data && data.rules) ? data.rules : [];
      for (const chain of Array.isArray(data && data.chains) ? data.chains : []) {
        if (!chain || typeof chain.sessionId !== 'string' || typeof chain.ruleId !== 'string'
          || !Number.isInteger(chain.index) || chain.index < 1) continue;
        const { sessionId, ...rest } = chain;
        chains.set(sessionId, { awaiting: 'turn', sawTrigger: false, sawOther: false, since: now(), ...rest });
      }
    } catch (_) { globalRules = []; loadFailed = true; }
  }

  function persist() {
    if (!deps.store) return;
    const pending = [...chains].map(([sessionId, chain]) => ({ sessionId, ...chain }));
    deps.store.write({ version: 1, rules: globalRules, chains: pending });
  }

  // Chain bookkeeping must never clobber a rules file that failed to load.
  function persistChains() {
    if (loadFailed) return;
    try { persist(); }
    catch (error) {
      try { logger.warn && logger.warn('event_chain_persist_failed', { error: String(error && error.message || error).slice(0, 120) }); } catch (_) {}
    }
  }

  function record(entry) {
    results.push({ ts: now(), ...entry });
    if (results.length > 100) results.shift();
  }

  function ruleLabel(rule) {
    const name = String(rule.name || '').trim();
    if (name) return name;
    return `${(rule.on || []).join(', ')} → ${(rule.action && rule.action.kind) || 'action'}`;
  }

  // A one-shot rule consumes itself: `enabled` goes false and `firedAt` is
  // stamped, so the UI can show "fired · closed" instead of the rule silently
  // vanishing. It stays in the list and can be re-armed by enabling it again.
  // The user also gets one push, because a hook they forgot existed is exactly
  // the case this flag is for.
  function consume(rule, owner, event) {
    const at = now();
    if (!owner) {
      const live = globalRules.find((candidate) => candidate.id === rule.id);
      if (!live || !live.enabled) return false;
      live.enabled = false;
      live.firedAt = at;
      persist();
    } else {
      const persisted = persistedSessions.get(owner);
      const live = persisted && Array.isArray(persisted.triggers)
        ? persisted.triggers.find((candidate) => candidate.id === rule.id) : null;
      if (!live || !live.enabled) return false;
      live.enabled = false;
      live.firedAt = at;
      if (saveBestEffort) saveBestEffort('runtime.event-rule-consumed');
    }
    // A notify action already told the user; don't push the same news twice.
    if (!rule.action || rule.action.kind !== 'notify') {
      try {
        actionCtx.notify((event && event.sessionId) || owner || 'events', 'succeeded',
          `一次性钩子已触发并自动关闭：${ruleLabel(rule)}`);
      } catch (_) { /* a failed push must never undo the consumption */ }
    }
    return true;
  }

  function rulesFor(event) {
    const out = globalRules.filter((rule) => rule.enabled).map((rule) => ({ rule, owner: null }));
    const persisted = event.sessionId ? persistedSessions.get(event.sessionId) : null;
    if (persisted && Array.isArray(persisted.triggers)) {
      for (const trigger of persisted.triggers) {
        if (trigger.enabled && trigger.type === 'event') out.push({ rule: trigger, owner: event.sessionId });
      }
    }
    return out;
  }

  function wants(rule, event) {
    if (event.type === 'trigger.fired') return rule.on.includes('trigger.fired');
    return matchesAny(rule.on, event.type);
  }

  // The live definition of a rule, so a chain edited, disabled or deleted
  // mid-way follows the edit instead of a stale snapshot.
  function liveRule(ruleId, owner) {
    if (!owner) return globalRules.find((rule) => rule.id === ruleId) || null;
    const persisted = persistedSessions.get(owner);
    return (persisted && Array.isArray(persisted.triggers) && persisted.triggers.find((rule) => rule.id === ruleId)) || null;
  }

  // awaiting: 'turn' = the injected step is running; 'inject' = the next step
  // could not be injected yet (session busy) and retries on the next finish.
  function park(sessionId, rule, owner, index, awaiting = 'turn', dryRun = false) {
    const previous = chains.get(sessionId);
    if (previous && (previous.ruleId !== rule.id || previous.index !== index)) {
      record({ ruleId: previous.ruleId, step: previous.index + 1, ok: false, error: 'chain superseded' });
    }
    chains.delete(sessionId);
    chains.set(sessionId, { ruleId: rule.id, owner, index, since: now(), awaiting, sawTrigger: false, sawOther: false, dryRun: dryRun === true });
    while (chains.size > MAX_PENDING_CHAINS) {
      const [oldest, chain] = chains.entries().next().value;
      chains.delete(oldest);
      record({ ruleId: chain.ruleId, step: chain.index + 1, ok: false, error: 'chain dropped (too many pending)' });
    }
    persistChains();
  }

  function sweepChains() {
    const at = now();
    let changed = false;
    for (const [sessionId, chain] of chains) {
      if (at - chain.since < CHAIN_STEP_TIMEOUT_MS) continue;
      chains.delete(sessionId);
      changed = true;
      record({ ruleId: chain.ruleId, step: chain.index + 1, ok: false, error: 'chain timed out' });
      const timedOut = liveRule(chain.ruleId, chain.owner);
      if (timedOut && timedOut.once && chain.dryRun !== true) consume(timedOut, chain.owner, null);
    }
    if (changed) persistChains();
  }

  // step 0 = rule.action, step n = rule.then[n - 1].
  // dryRun follows the firing that started the chain: a manual test (`/api/events/test`)
  // must never burn a one-shot rule.
  async function execute(event, rule, owner, step = 0, dryRun = false) {
    const dry = dryRun === true || event.origin === 'manual-test';
    const then = Array.isArray(rule.then) ? rule.then : [];
    const action = step === 0 ? rule.action : then[step - 1];
    const total = 1 + then.length;
    const progress = total > 1 ? { step: step + 1, steps: total } : {};
    const run = ACTIONS[action.kind];
    const label = `${rule.id}:${action.kind}`;
    let outcome;
    try {
      outcome = await run(event, step === 0 ? rule : { ...rule, action }, actionCtx);
    } catch (error) {
      record({ ruleId: rule.id, kind: action.kind, eventType: event.type, ok: false, error: 'action threw', ...progress });
      try { logger.warn && logger.warn('event_rule_action_failed', { ruleId: rule.id, error: String(error && error.message || error).slice(0, 120) }); } catch (_) {}
      return { ok: false };
    }
    if (step > 0 && action.kind === 'inject-prompt' && outcome.error === 'target_busy') {
      // The session is still busy (e.g. a message the user queued): try again
      // when it next finishes instead of breaking the chain.
      record({ ruleId: rule.id, kind: action.kind, eventType: event.type, ok: false, error: 'chain waiting: target busy', ...progress });
      park(outcome.target || event.sessionId, rule, owner, step, 'inject');
      return outcome;
    }
    record({
      ruleId: rule.id, kind: action.kind, eventType: event.type, ok: outcome.ok, error: outcome.error || null,
      ...(outcome.deliveryId != null ? { deliveryId: outcome.deliveryId } : {}), ...progress,
    });
    if (action.kind === 'inject-prompt' && outcome.ok) selfInjected.set(outcome.target, rule.id);
    hub.emit('trigger.fired', event.sessionId, {
      ruleId: rule.id, actionKind: action.kind, ok: outcome.ok, cause: event.type, ...progress,
    }, { depth: event.depth + 1, origin: label });
    if (outcome.ok && step + 1 < total) {
      // An injected prompt is still running: wait for its turn to end. Any other
      // action is already done, so the next step runs on the same event.
      if (action.kind === 'inject-prompt') park(outcome.target, rule, owner, step + 1, 'turn', dry);
      else await execute(event, rule, owner, step + 1, dry);
    } else if (outcome.ok && rule.once && !dry) {
      // Last step succeeded: a one-shot rule is spent. A failed action stays
      // armed on purpose — the user asked for it to run, not to half-run.
      consume(rule, owner, event);
    }
    return outcome;
  }

  // A parked chain sees its session's terminal event. Returns true when the
  // event belonged to a chain (so other inject rules must stay quiet).
  function advanceChain(event) {
    const chain = event.sessionId ? chains.get(event.sessionId) : null;
    if (!chain) return false;
    if (event.type === 'turn.completed') {
      if (chain.awaiting !== 'turn') return false;
      if (event.data.lineageKind === 'trigger') chain.sawTrigger = true;
      else chain.sawOther = true;
      persistChains();
      return false;
    }
    if (!TERMINAL.has(event.type)) return false;
    // Only the user's own turns have finished so far: the step is still queued.
    if (chain.awaiting === 'turn' && chain.sawOther && !chain.sawTrigger) return false;
    if (chain.awaiting === 'inject' && event.type !== CHAIN_ADVANCE) return false;
    if (event.type !== CHAIN_ADVANCE && !CHAIN_STOP.has(event.type)) return true;
    chains.delete(event.sessionId);
    persistChains();
    const stopped = { ruleId: chain.ruleId, eventType: event.type, step: chain.index + 1, ok: false };
    const rule = liveRule(chain.ruleId, chain.owner);
    if (CHAIN_STOP.has(event.type)) {
      record({ ...stopped, error: `chain stopped: ${event.type}` });
      // The first step did run: a one-shot chain is spent even when a later
      // step stops on a failure or on the user. Leaving it armed would re-fire
      // the whole chain on the next event.
      if (rule && rule.once && chain.dryRun !== true) consume(rule, chain.owner, event);
      return true;
    }
    if (!rule || !rule.enabled || !Array.isArray(rule.then) || chain.index > rule.then.length) {
      record({ ...stopped, error: 'chain cancelled (rule changed)' });
      return true;
    }
    execute(event, rule, chain.owner, chain.index, chain.dryRun === true);
    return true;
  }

  function onEvent(event) {
    if (event.depth >= MAX_DEPTH) return;
    sweepChains();
    // A terminal event of a turn this engine started must not re-run inject.
    let suppressInject = advanceChain(event);
    if (event.sessionId && TERMINAL.has(event.type) && selfInjected.has(event.sessionId)) {
      selfInjected.delete(event.sessionId);
      suppressInject = true;
    }
    let count = 0;
    for (const { rule, owner } of rulesFor(event)) {
      if (!wants(rule, event) || !matchesFilter(rule, event)) continue;
      if (owner && rule.filter && rule.filter.sessionIds && !rule.filter.sessionIds.includes(owner)) continue;
      if (suppressInject && rule.action.kind === 'inject-prompt') continue;
      const key = owner ? `${rule.id}:${owner}` : rule.id;
      const at = now();
      if (rule.cooldownMs > 0 && lastFired.has(key) && at - lastFired.get(key) < rule.cooldownMs) continue;
      if (++count > MAX_FANOUT) { record({ ruleId: rule.id, eventType: event.type, ok: false, error: 'fanout cap' }); break; }
      lastFired.set(key, at);
      if (owner) {
        const persisted = persistedSessions.get(owner);
        const live = persisted && persisted.triggers && persisted.triggers.find((item) => item.id === rule.id);
        if (live) { live.lastFiredAt = at; if (saveBestEffort) saveBestEffort('runtime.event-rule-fired'); }
      } else {
        rule.lastFiredAt = at;
      }
      execute(event, rule, owner);
    }
  }

  // 哪些钩子在用渠道（/api/channels 的 inUse：插件停了还有钩子指望它，Air 要出横幅）。
  function channelUsage() {
    const out = [];
    const add = (rule, owner) => {
      if (!rule || !rule.enabled) return;
      for (const action of channelActions(rule)) out.push({ plugin: action.plugin, target: action.target, kind: 'hook', source: rule.id, owner });
    };
    for (const rule of globalRules) add(rule, null);
    for (const [sessionId, persisted] of persistedSessions) {
      for (const trigger of Array.isArray(persisted && persisted.triggers) ? persisted.triggers : []) {
        if (trigger.type === 'event') add(trigger, sessionId);
      }
    }
    return out;
  }
  let stopUsage = null;

  function start() {
    if (unsubscribe) return false;
    load();
    unsubscribe = hub.subscribe(onEvent);
    if (!stopUsage) stopUsage = channelRegistry.addUsageSource(channelUsage);
    return true;
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (stopUsage) { stopUsage(); stopUsage = null; }
    lastFired.clear();
    selfInjected.clear();
    chains.clear();
  }

  function addGlobal(body) {
    if (globalRules.length >= MAX_GLOBAL_RULES) return { error: 'too many global rules' };
    const validation = validateEventRule(body, { idFactory, nowIso: () => new Date(now()).toISOString(), scope: 'global' });
    if (validation.error) return validation;
    const channelError = channelProblem(validation.rule, checkChannelTarget);
    if (channelError) return { error: channelError };
    globalRules.push(validation.rule);
    persist();
    return validation;
  }

  function updateGlobal(id, body) {
    const index = globalRules.findIndex((rule) => rule.id === id);
    if (index < 0) return { error: 'not found', status: 404 };
    const validation = validateEventRule({ ...globalRules[index], ...body, id }, {
      idFactory, nowIso: () => globalRules[index].createdAt, scope: 'global',
    });
    if (validation.error) return validation;
    const channelError = channelProblem(validation.rule, checkChannelTarget);
    if (channelError) return { error: channelError };
    validation.rule.lastFiredAt = globalRules[index].lastFiredAt;
    // firedAt records that a one-shot rule was already spent; an edit must not
    // erase that history (re-enabling is what re-arms the rule).
    if (globalRules[index].firedAt) validation.rule.firedAt = globalRules[index].firedAt;
    globalRules[index] = validation.rule;
    persist();
    return validation;
  }

  function removeGlobal(id) {
    const next = globalRules.filter((rule) => rule.id !== id);
    if (next.length === globalRules.length) return false;
    globalRules = next;
    persist();
    return true;
  }

  return Object.freeze({
    start, stop, load, addGlobal, updateGlobal, removeGlobal,
    listGlobal: () => globalRules.map((rule) => ({ ...rule })),
    // Every event rule (global + all sessions) with its last run, for the UI list.
    listAll() {
      const lastRun = new Map();
      for (const run of results) lastRun.set(run.ruleId, run);
      const view = (rule, owner, label) => ({
        scope: owner ? 'session' : 'global', sessionId: owner || null, sessionLabel: label || null,
        rule: { ...rule }, lastRun: lastRun.get(rule.id) || null,
      });
      const items = globalRules.map((rule) => view(rule, null, null));
      for (const [id, persisted] of persistedSessions) {
        if (!Array.isArray(persisted.triggers)) continue;
        for (const trigger of persisted.triggers) {
          if (trigger.type === 'event') items.push(view(trigger, id, persisted.label || id));
        }
      }
      return items;
    },
    recentResults: () => results.slice(),
    pendingChains: () => [...chains].map(([sessionId, chain]) => ({ sessionId, ...chain })),
    // exposed for tests / manual-test route
    handle: onEvent,
    forgetSession: (sessionId) => { selfInjected.delete(sessionId); if (chains.delete(sessionId)) persistChains(); },
  });
}

module.exports = { createEventRuleEngine, MAX_FANOUT, MAX_DEPTH, CHAIN_STEP_TIMEOUT_MS };
