'use strict';

// 插件渠道订阅（docs/notification-channel-plugin-design.md 10.3）：推送设置里「插件渠道」
// 一栏，按接收人勾收哪几类。保存在推送层自己的文件里（与 bark-devices.json 同目录），只存
// 插件 id 和接收人编号——微信里的名称只在插件里，改名只改插件一处（11.2）。
//
// 推送运行时的 notify() 在现有四路之后调 dispatch()：按订阅把事情交给插件入队，不等结果。
// 现有渠道一直收全部类别；插件渠道只收勾了的类别，新订阅默认只勾「出错了」「在等你回答」。

const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('../runtime-security');
const registry = require('../plugins/channel-registry');

const MAX_SUBSCRIPTIONS = 50;

class ChannelSubscriptionError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; }
}

const CHECK_CODES = Object.freeze({
  'unknown channel plugin': 'unknownPlugin',
  'unknown channel target': 'unknownTarget',
  'channel plugin not running': 'pluginDown',
  'invalid channel action': 'invalid',
});

function normalizeCategories(value) {
  if (value == null) return registry.CATEGORIES.filter(category => registry.DEFAULT_CATEGORIES.includes(category));
  if (!Array.isArray(value)) throw new ChannelSubscriptionError('invalid', 'categories must be a list');
  const picked = registry.CATEGORIES.filter(category => value.includes(category));
  if (value.some(category => !registry.CATEGORIES.includes(category))) {
    throw new ChannelSubscriptionError('invalid', `categories must be among ${registry.CATEGORIES.join(', ')}`);
  }
  return picked;
}

function createChannelSubscriptions({ file, now = Date.now, idFactory, logger = console, checkTarget = registry.checkTarget, deliver = registry.deliver } = {}) {
  if (!file) throw new TypeError('[channel-subscriptions] file is required');
  const makeId = idFactory || (() => `chs_${crypto.randomBytes(5).toString('hex')}`);
  let list = [];
  let loadFailed = false;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      list = (Array.isArray(raw && raw.subscriptions) ? raw.subscriptions : []).filter(item => item
        && registry.PLUGIN_ID.test(String(item.plugin)) && registry.TARGET_ID.test(String(item.target)) && typeof item.id === 'string')
        .map(item => ({
          id: item.id, plugin: item.plugin, target: item.target,
          categories: registry.CATEGORIES.filter(category => Array.isArray(item.categories) && item.categories.includes(category)),
          enabled: item.enabled !== false, createdAt: item.createdAt || null, updatedAt: item.updatedAt || null,
        }));
    } catch (error) {
      if (error && error.code === 'ENOENT') { list = []; return; }
      // 读不了或坏了：不用空表覆盖它，改动一律拒绝，等人看（同钩子规则文件）。
      loadFailed = true;
      list = [];
      try { logger.warn('[multicc/push] channel subscriptions unreadable', error && error.message); } catch (_) {}
    }
  }

  function save(next) {
    if (loadFailed) throw new ChannelSubscriptionError('unreadable', '插件渠道订阅文件读不了，先修好或删掉它', 500);
    atomicWriteJson(file, { version: 1, subscriptions: next });
    list = next;
  }

  function view() {
    return list.map(item => ({ ...item, categories: [...item.categories] }));
  }

  // 新加的（或换了插件/接收人的）订阅要核对接收人还在；原样保留的不核对，插件暂时停了
  // 也能照常改别的订阅。
  function validate(raw, previous) {
    if (!raw || typeof raw !== 'object') throw new ChannelSubscriptionError('invalid', 'subscription must be an object');
    const plugin = String(raw.plugin || '');
    const target = String(raw.target || '');
    if (!registry.PLUGIN_ID.test(plugin) || !registry.TARGET_ID.test(target)) throw new ChannelSubscriptionError('invalid', 'invalid plugin or target');
    const categories = normalizeCategories(raw.categories);
    const enabled = raw.enabled !== false;
    const same = previous && previous.plugin === plugin && previous.target === target;
    if (!same) {
      const problem = checkTarget(plugin, target);
      if (problem) throw new ChannelSubscriptionError(CHECK_CODES[problem] || 'invalid', problem);
    }
    const at = new Date(now()).toISOString();
    return {
      id: previous ? previous.id : makeId(), plugin, target, categories, enabled,
      createdAt: previous ? previous.createdAt : at, updatedAt: at,
    };
  }

  // 整表替换（推送设置一次保存）。
  function replace(items) {
    if (!Array.isArray(items) || items.length > MAX_SUBSCRIPTIONS) {
      throw new ChannelSubscriptionError('invalid', `subscriptions must be a list of at most ${MAX_SUBSCRIPTIONS}`);
    }
    const seen = new Set();
    const next = items.map(raw => {
      const previous = raw && raw.id ? list.find(item => item.id === raw.id) : null;
      const row = validate(raw, previous);
      const key = `${row.plugin}\n${row.target}`;
      if (seen.has(key)) throw new ChannelSubscriptionError('duplicate', '同一个接收人只能有一条订阅');
      seen.add(key);
      return row;
    });
    save(next);
    return view();
  }

  // 按插件 + 接收人增改一条（插件面板的「快速接入」）。
  function upsert(raw) {
    const previous = raw ? list.find(item => item.plugin === raw.plugin && item.target === raw.target) : null;
    if (!previous && list.length >= MAX_SUBSCRIPTIONS) throw new ChannelSubscriptionError('invalid', `at most ${MAX_SUBSCRIPTIONS} subscriptions`);
    const row = validate({ ...(previous || {}), ...raw }, previous);
    save(previous ? list.map(item => (item.id === previous.id ? row : item)) : [...list, row]);
    return view();
  }

  function remove(id) {
    const next = list.filter(item => item.id !== id);
    if (next.length === list.length) throw new ChannelSubscriptionError('notFound', '没有这条订阅', 404);
    save(next);
    return view();
  }

  function hasEnabled() {
    return list.some(item => item.enabled && item.categories.length > 0);
  }

  // notify() 的插件渠道一路：按订阅交给插件入队，返回各条的回执（测试与日志用）。
  async function dispatch({ sessionId, category, summary, occurredAt }) {
    const wanted = list.filter(item => item.enabled && item.categories.includes(category));
    return Promise.all(wanted.map(async item => {
      const payload = registry.delivery({ target: item.target, source: `push:${item.id}`, sessionId, category, summary, occurredAt });
      const result = await deliver(item.plugin, payload);
      if (!result || !result.ok) {
        try { logger.warn(`[multicc/push] plugin channel ${item.plugin} refused delivery: ${result && result.error}`); } catch (_) {}
      }
      return { subscription: item.id, ...(result || { ok: false }) };
    }));
  }

  // 推送设置的「测试」：发一条测试消息，走插件完整的发送流程（会被插件合并、推迟）。
  async function test({ plugin, target }) {
    if (!registry.PLUGIN_ID.test(String(plugin || '')) || !registry.TARGET_ID.test(String(target || ''))) {
      throw new ChannelSubscriptionError('invalid', 'invalid plugin or target');
    }
    const payload = registry.delivery({ target, source: 'push:test', sessionId: '', category: 'test', summary: 'MultiCC 推送设置里的测试消息' });
    const result = await deliver(plugin, payload);
    if (!result || !result.ok) {
      throw new ChannelSubscriptionError(result && result.down ? 'pluginDown' : 'refused', (result && result.error) || 'delivery failed', result && result.down ? 503 : 400);
    }
    return { ok: true, receipt: result.receipt || null };
  }

  load();
  const stopUsage = registry.addUsageSource(() => list
    .filter(item => item.enabled)
    .map(item => ({ plugin: item.plugin, target: item.target, kind: 'push', source: item.id })));

  return { list: view, replace, upsert, remove, hasEnabled, dispatch, test, reload: load, stop: stopUsage };
}

// 路由挂在推送运行时的 mountRoutes 里（同一套 route() 守卫）。otherChannels 给「只开了
// 插件渠道」的提示用：插件自身故障只能靠别的渠道报（方案 6.4）。
function mountChannelSubscriptionRoutes(app, store, route, otherChannels) {
  const payload = () => ({
    subscriptions: store.list(),
    categories: [...registry.CATEGORIES],
    defaults: [...registry.DEFAULT_CATEGORIES],
    otherChannels: otherChannels(),
  });
  const handle = work => route(async (req, res) => {
    try {
      await work(req);
      return res.json(payload());
    } catch (error) {
      if (!(error instanceof ChannelSubscriptionError)) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
  });
  app.get('/api/push/channel-subscriptions', handle(async () => {}));
  app.put('/api/push/channel-subscriptions', handle(async req => store.replace(req.body && req.body.subscriptions)));
  app.post('/api/push/channel-subscriptions', handle(async req => store.upsert(req.body || {})));
  app.delete('/api/push/channel-subscriptions/:id', handle(async req => store.remove(String(req.params.id))));
  app.post('/api/push/test-channel', route(async (req, res) => {
    try {
      return res.json(await store.test(req.body || {}));
    } catch (error) {
      if (!(error instanceof ChannelSubscriptionError)) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
  }));
}

module.exports = { createChannelSubscriptions, mountChannelSubscriptionRoutes, ChannelSubscriptionError, MAX_SUBSCRIPTIONS };
