'use strict';

// 通知渠道的登记处（docs/notification-channel-plugin-design.md 10.1–10.5）。
//
// 三方都在同一个进程里、启动顺序各不相同：常驻插件宿主（src/plugins/channel-host.js）
// 起来后把自己登记在这里；推送的插件渠道订阅（src/push/channel-subscriptions.js）和钩子的
// 「发到渠道」（src/events/actions.js）从这里拿宿主投递；推送运行时登记「这个任务现在
// 怎样」的查询，给插件的发送前复核（/api/channels/recheck）和投递里的任务名用。用登记处
// 就不必在 server.js 里把它们一个个串起来（server.js 守着字节预算）。
//
// 这里没有任何具体渠道（微信……）的代码，也不保存投递：队列、重试、发送记录都在插件里。

const { isBackgroundLetter } = require('../classify/vocab');

const CATEGORIES = Object.freeze(['done', 'question', 'background', 'error']);
const DEFAULT_CATEGORIES = Object.freeze(['error', 'question']);
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TARGET_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SUMMARY_MAX = 300;

let host = null;
let taskLookup = null;
const usageSources = new Set();

function register(next) {
  host = next || null;
}

function current() {
  return host;
}

// 推送运行时提供：sessionId → { label, project, classifyState } 或 null（任务不在了）。
function setTaskLookup(fn) {
  taskLookup = typeof fn === 'function' ? fn : null;
}

function taskOf(sessionId) {
  if (!taskLookup || !sessionId) return null;
  try { return taskLookup(String(sessionId)) || null; } catch (_) { return null; }
}

// 谁在用渠道：推送订阅、钩子各登记一个函数，返回 [{ plugin, target, source }]。
// /api/channels 的 inUse 和 Air 横幅（插件停了但还有人指望它）靠这个。
function addUsageSource(fn) {
  if (typeof fn !== 'function') return () => {};
  usageSources.add(fn);
  return () => usageSources.delete(fn);
}

function usage() {
  const out = [];
  for (const fn of usageSources) {
    try { for (const item of fn() || []) if (item && item.plugin) out.push(item); } catch (_) {}
  }
  return out;
}

// 保存订阅或钩子时核对：插件声明了渠道、在运行、接收人在它的接收人簿里。返回错误文字或 null。
function checkTarget(plugin, target) {
  if (!PLUGIN_ID.test(String(plugin || '')) || !TARGET_ID.test(String(target || ''))) return 'invalid channel action';
  if (!host || typeof host.checkTarget !== 'function') return 'channel plugin not running';
  return host.checkTarget(plugin, target);
}

// 事件 → 渠道类别。推送用（type, 分类字母），钩子用事件类型。认不出的返回 null（不投递）。
function categoryOfPush(type, classifyState) {
  if (type === 'succeeded') return 'done';
  if (type === 'error') return 'error';
  if (type === 'waiting') return isBackgroundLetter(classifyState) ? 'background' : 'question';
  return null;
}

const EVENT_CATEGORY = Object.freeze({
  'task.failed': 'error',
  'task.waiting_user': 'question',
  'task.needs_interaction': 'question',
  'task.waiting_background': 'background',
  'task.finished': 'done',
  'task.achieved': 'done',
});

function categoryOfEvent(type) {
  return EVENT_CATEGORY[type] || 'info';
}

function projectName(cwd) {
  const text = String(cwd || '').replace(/\/+$/, '');
  if (!text) return '';
  // 工作树在 <项目>/.multicc-worktrees/<任务>/ 下：项目名是工作树上面那一级。
  const root = text.split('/.multicc-worktrees/')[0];
  return root.slice(root.lastIndexOf('/') + 1);
}

// 拼一条 deliver（方案 10.1 的字段表）。去重键 = 任务 + 类别：同一件事从推送订阅和钩子
// 同时到同一个接收人，插件按它并成一条；插件只在这条还在排队时去重，发出去之后的新情况
// 照常入队（重复出错由插件的出错抑制管）。
function delivery({ target, source, sessionId, category, summary, occurredAt }) {
  const task = taskOf(sessionId);
  const text = String(summary || '').replace(/^\[Chat\]\s*/, '').replace(/\s+/g, ' ').trim();
  return {
    target: String(target),
    source: String(source || 'unknown').slice(0, 80),
    sessionId: sessionId ? String(sessionId) : '',
    taskName: task ? String(task.label || '').slice(0, 80) : '',
    project: task ? String(task.project || '').slice(0, 80) : '',
    category,
    summary: (text || (task && task.label) || category).slice(0, SUMMARY_MAX),
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.now(),
    dedupKey: sessionId && category !== 'test' && category !== 'info' ? `${sessionId}:${category}` : null,
  };
}

// 交给插件入队。插件只回「已入队」和投递编号，不等发送结果（方案 10.1）。
async function deliver(plugin, payload) {
  if (!host || typeof host.deliver !== 'function') return { ok: false, error: 'channel plugin not running', down: true };
  return host.deliver(plugin, payload);
}

// 发送前复核（方案 10.5 第 5 步）：这件事的问题还在不在。完成、测试这类不是「问题」，
// 一直算在；任务已经删了算不在；其余看任务现在的分类字母是否还是当时那个。
const CATEGORY_LETTER = Object.freeze({ error: 'E', question: 'W', background: 'B' });

function stillActive(sessionId, category) {
  const letter = CATEGORY_LETTER[category];
  if (!letter || !sessionId) return true;
  const task = taskOf(sessionId);
  if (!task) return taskLookup ? false : true;
  return task.classifyState === letter;
}

function reset() {
  host = null;
  taskLookup = null;
  usageSources.clear();
}

module.exports = {
  CATEGORIES, DEFAULT_CATEGORIES, PLUGIN_ID, TARGET_ID,
  register, current, setTaskLookup, taskOf, addUsageSource, usage, checkTarget,
  categoryOfPush, categoryOfEvent, projectName, delivery, deliver, stillActive, reset,
};
