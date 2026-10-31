'use strict';

// Event rule schema: validation, normalization and filter matching. Pure.
// A rule = which events (`on`) + optional `filter` + one `action`, optionally
// followed by a chain (`then`) of further actions the engine runs in order.
// The same shape is used for session-level triggers (type:'event') and for
// global rules; only the storage differs.

const { isKnownPattern } = require('./catalog');

const ACTION_KINDS = Object.freeze(['inject-prompt', 'webhook', 'notify', 'channel']);
const CHANNEL_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHANNEL_TARGET_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_PATTERNS = 10;
const MAX_FILTER_IDS = 50;
const MIN_INJECT_COOLDOWN_MS = 10000;
const MAX_CHAIN_STEPS = 9; // follow-up steps after the first action

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function textField(value, max) {
  return value == null ? '' : String(value).slice(0, max);
}

function idList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(String).filter((item) => /^[A-Za-z0-9._:-]{1,128}$/.test(item)).slice(0, MAX_FILTER_IDS);
}

// Webhook URL syntax check. Private/loopback rejection happens at send time
// (after DNS resolution) in actions.js; this only rejects obviously bad input.
function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch (_) { return 'invalid webhook url'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'webhook url must be http(s)';
  if (url.username || url.password) return 'webhook url must not embed credentials';
  return null;
}

function validateAction(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'action is required' };
  const kind = String(raw.kind || '');
  if (!ACTION_KINDS.includes(kind)) return { error: `unknown action kind (${ACTION_KINDS.join('|')})` };
  const action = { kind };
  if (kind === 'inject-prompt') {
    action.prompt = textField(raw.prompt, 4000);
    if (raw.targetSessionId) {
      const [target] = idList(raw.targetSessionId);
      if (!target) return { error: 'invalid targetSessionId' };
      action.targetSessionId = target;
    }
    // Create a fresh chat session per firing instead of reusing one. dirId / cli
    // may be empty: the runtime then follows the session that raised the event.
    if (raw.newSession) {
      if (action.targetSessionId) return { error: 'targetSessionId and newSession are mutually exclusive' };
      const spec = raw.newSession && typeof raw.newSession === 'object' ? raw.newSession : {};
      const [dirId] = idList(spec.dirId);
      if (spec.dirId && !dirId) return { error: 'invalid newSession.dirId' };
      const cli = String(spec.cli || '');
      if (cli && !/^[a-z][a-z0-9-]{0,31}$/.test(cli)) return { error: 'invalid newSession.cli' };
      action.newSession = { dirId: dirId || '', cli, title: textField(spec.title, 120).trim() };
    }
  } else if (kind === 'webhook') {
    const problem = validateWebhookUrl(raw.url);
    if (problem) return { error: problem };
    action.url = String(raw.url).slice(0, 2000);
    action.includeConclusion = raw.includeConclusion === true;
    if (raw.secretName != null && raw.secretName !== '') {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(raw.secretName))) return { error: 'invalid secretName' };
      action.secretName = String(raw.secretName);
    }
  } else if (kind === 'channel') {
    // 「发到渠道」（design 10.4）：插件 id + 插件里的接收人编号，可选文案（留空由插件排版）。
    // 接收人在不在只在保存时查（channelProblem），这里只看形状：规则文件加载时不能因为
    // 接收人删了就把规则丢掉，要留着标红。
    const plugin = String(raw.plugin || '');
    const target = String(raw.target || '');
    if (!CHANNEL_PLUGIN_ID.test(plugin) || !CHANNEL_TARGET_ID.test(target)) return { error: 'invalid channel action' };
    action.plugin = plugin;
    action.target = target;
    action.message = textField(raw.message, 400);
  } else {
    action.message = textField(raw.message, 400);
  }
  return { action };
}

// The channel actions of a rule (main action and chain steps).
function channelActions(rule) {
  return [rule && rule.action, ...(rule && Array.isArray(rule.then) ? rule.then : [])]
    .filter((action) => action && action.kind === 'channel');
}

// Save-time check of every channel action: `check(plugin, target)` answers an
// error string or null (src/plugins/channel-registry.js checkTarget).
function channelProblem(rule, check) {
  for (const action of channelActions(rule)) {
    const problem = check(action.plugin, action.target);
    if (problem) return problem;
  }
  return null;
}

// body: raw request/object. Returns { rule } or { error }.
function validateEventRule(body = {}, { idFactory, nowIso, scope = 'global' } = {}) {
  const on = (Array.isArray(body.on) ? body.on : (body.on ? [body.on] : [])).map(String);
  if (!on.length || on.length > MAX_PATTERNS) return { error: `on requires 1-${MAX_PATTERNS} event patterns` };
  const unknown = on.find((pattern) => !isKnownPattern(pattern));
  if (unknown) return { error: `unknown event pattern: ${unknown.slice(0, 60)}` };
  const validated = validateAction(body.action);
  if (validated.error) return { error: validated.error };

  const steps = body.then == null ? [] : (Array.isArray(body.then) ? body.then : [body.then]);
  if (steps.length > MAX_CHAIN_STEPS) return { error: `then allows at most ${MAX_CHAIN_STEPS} steps` };
  const then = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = validateAction(steps[index]);
    if (step.error) return { error: `then[${index}]: ${step.error}` };
    then.push(step.action);
  }

  const filter = {};
  const source = body.filter && typeof body.filter === 'object' ? body.filter : {};
  const sessionIds = idList(source.sessionIds);
  const dirIds = idList(source.dirIds);
  if (sessionIds.length) filter.sessionIds = sessionIds;
  if (dirIds.length) filter.dirIds = dirIds;
  if (source.goalState === 'achieved' || source.goalState === 'interact') filter.goalState = source.goalState;
  if (typeof source.cancelled === 'boolean') filter.cancelled = source.cancelled;

  const injecting = validated.action.kind === 'inject-prompt';
  const rule = {
    id: body.id || idFactory(),
    type: 'event',
    scope,
    name: textField(body.name, 80),
    enabled: body.enabled !== false,
    // One-shot hook: the engine disables it after the first successful firing
    // (the whole `then` chain, when there is one) and stamps `firedAt`, so a
    // forgotten hook cannot keep spawning work. Persistent is the default.
    once: body.once === true,
    on,
    filter,
    action: validated.action,
    then,
    cooldownMs: Math.max(
      injecting ? MIN_INJECT_COOLDOWN_MS : 0,
      clampInt(body.cooldownMs, 0, 86400000, injecting ? 60000 : 0),
    ),
    mode: 'inject',
    createdAt: body.createdAt || nowIso(),
  };
  return { rule };
}

function matchesFilter(rule, event) {
  const filter = rule.filter || {};
  if (filter.sessionIds && !filter.sessionIds.includes(event.sessionId)) return false;
  if (filter.dirIds && !filter.dirIds.includes(event.dirId)) return false;
  if (filter.goalState && event.data.goalState !== filter.goalState) return false;
  if (typeof filter.cancelled === 'boolean' && Boolean(event.data.cancelled) !== filter.cancelled) return false;
  return true;
}

module.exports = { ACTION_KINDS, MIN_INJECT_COOLDOWN_MS, MAX_CHAIN_STEPS, validateEventRule, validateAction, validateWebhookUrl, matchesFilter, channelActions, channelProblem };
