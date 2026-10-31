'use strict';

// Action registry for event rules. Each action is (event, rule, ctx) => Promise.
// ctx carries injected effects so the module stays testable and side-effect free.

const crypto = require('crypto');
const net = require('net');
const { renderInjection } = require('./envelope');
const channelRegistry = require('../plugins/channel-registry');

const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_ATTEMPTS = 3;
const MAX_BODY_BYTES = 16 * 1024;

const NOTIFY_TYPE = Object.freeze({
  'task.failed': 'error',
  'task.achieved': 'succeeded',
  'task.finished': 'succeeded',
  'task.needs_interaction': 'waiting',
  'task.waiting_user': 'waiting',
  'task.waiting_background': 'waiting',
});

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

// Webhook body: whitelisted event fields only (no paths, no stderr, no env).
// conclusion/summary are opt-in per rule (includeConclusion) so a full reply
// never leaves the machine by accident.
function webhookBody(event, includeConclusion = false) {
  return JSON.stringify({
    eventId: event.eventId,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    sessionId: event.sessionId,
    dirId: event.dirId,
    data: {
      taskId: event.data.taskId || null,
      goal: String(event.data.goal || '').slice(0, 120),
      phase: event.data.phase || null,
      classifyState: event.data.classifyState || null,
      goalState: event.data.goalState || null,
      from: event.data.from || null,
      to: event.data.to || null,
      source: event.data.source || null,
      cancelled: event.data.cancelled === true,
      errorCategory: event.data.errorCategory || null,
      ...(includeConclusion ? { conclusion: event.data.conclusion || '', summary: event.data.summary || '' } : {}),
    },
  }).slice(0, MAX_BODY_BYTES);
}

function sign(secret, body, timestamp) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function checkWebhookTarget(url, ctx) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ctx.allowPrivateWebhooks) return null;
  if (net.isIP(host)) return isPrivateAddress(host) ? 'private address blocked' : null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'private address blocked';
  const addresses = await ctx.lookup(host);
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address || entry))) {
    return 'private address blocked';
  }
  return null;
}

async function runWebhook(event, rule, ctx) {
  const action = rule.action;
  const url = new URL(action.url);
  const blocked = await checkWebhookTarget(url, ctx);
  if (blocked) return { ok: false, error: blocked };
  const body = webhookBody(event, action.includeConclusion === true);
  const timestamp = String(Math.floor(ctx.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'X-Multicc-Event': event.type,
    'X-Multicc-Event-Id': event.eventId,
    'X-Multicc-Timestamp': timestamp,
  };
  if (action.secretName) {
    const secret = ctx.resolveSecret(action.secretName, { sessionId: event.sessionId });
    if (!secret) return { ok: false, error: 'webhook secret not found' };
    headers['X-Multicc-Signature'] = sign(secret, body, timestamp);
  }
  let lastError = 'webhook failed';
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt += 1) {
    try {
      const status = await ctx.httpPost(url, headers, body, WEBHOOK_TIMEOUT_MS);
      if (status >= 200 && status < 300) return { ok: true, status, attempt };
      lastError = `http ${status}`;
      if (status >= 400 && status < 500 && status !== 429) break;
    } catch (error) {
      lastError = String(error && error.code || 'request failed').slice(0, 40);
    }
    if (attempt < WEBHOOK_ATTEMPTS) await ctx.sleep(500 * attempt);
  }
  return { ok: false, error: lastError };
}

async function runNotify(event, rule, ctx) {
  const type = NOTIFY_TYPE[event.type] || 'waiting';
  const goal = String(event.data.goal || '').slice(0, 80);
  const message = rule.action.message || `${event.type}${goal ? ` · ${goal}` : ''}`;
  const options = {};
  if (event.data.classifyState) options.classifyState = event.data.classifyState;
  if (event.data.goalState) options.goalState = event.data.goalState;
  const result = ctx.notify(event.sessionId || 'events', type, message, options);
  return { ok: result !== false };
}

// 「发到渠道」（design 10.4）：把事件转成 deliver 交给插件入队；插件回了投递编号就算这一
// 步成功，最终发送结果在插件的发送记录里。去重键与推送订阅一致（任务 + 类别），同一件事
// 同时命中推送订阅和钩子时，同一个接收人只收一条。
async function runChannel(event, rule, ctx) {
  const action = rule.action;
  const occurredAt = typeof event.ts === 'number' ? event.ts : (Date.parse(event.ts) || ctx.now());
  const payload = channelRegistry.delivery({
    target: action.target,
    source: `hook:${rule.id}`,
    sessionId: event.sessionId,
    category: channelRegistry.categoryOfEvent(event.type),
    summary: action.message || String(event.data.goal || ''),
    occurredAt,
  });
  const result = await ctx.deliverChannel(action.plugin, payload);
  if (result && result.ok) return { ok: true, deliveryId: result.deliveryId ?? null };
  return { ok: false, error: String((result && result.error) || 'channel delivery failed').slice(0, 200) };
}

// Each firing gets its own chat task/session. The clientMsgId is derived from the
// event so a retried delivery of the same event cannot create a second one.
async function createTargetSession(event, rule, ctx) {
  const spec = rule.action.newSession;
  const source = event.sessionId ? ctx.sessionInfo(event.sessionId) : null;
  const dirId = spec.dirId || (source && source.dirId) || event.dirId || '';
  if (!dirId) return { error: 'no workspace for the new session' };
  const title = spec.title || rule.name || String(event.data.goal || '').slice(0, 60) || 'Hook';
  const created = await ctx.createSession({
    dirId, title: title.slice(0, 120), cli: spec.cli || (source && source.cli) || 'claude',
    clientMsgId: `hook:${event.eventId}:${rule.id}`.replace(/[^\w.:-]/g, '_').slice(0, 160),
  });
  return created && created.sessionId ? { sessionId: created.sessionId } : { error: 'session create failed' };
}

async function runInject(event, rule, ctx) {
  let target = rule.action.targetSessionId || event.sessionId;
  if (rule.action.newSession) {
    const made = await createTargetSession(event, rule, ctx);
    if (made.error) return { ok: false, error: made.error };
    target = made.sessionId;
  }
  if (!target) return { ok: false, error: 'no target session' };
  const prompt = renderInjection(event, rule.action.prompt);
  // injectPrompt answers true/false (busy or missing) or the admission result
  // { ok, code }: a refused admission must show up as a failed run, not ok.
  const result = await ctx.injectPrompt(target, prompt);
  if (result === true || (result && result.ok === true)) return { ok: true, target, created: Boolean(rule.action.newSession) };
  return { ok: false, target, error: (result && result.code) || 'target busy or missing' };
}

const ACTIONS = Object.freeze({
  'inject-prompt': runInject,
  webhook: runWebhook,
  notify: runNotify,
  channel: runChannel,
});

module.exports = { ACTIONS, isPrivateAddress, webhookBody, sign, NOTIFY_TYPE };
