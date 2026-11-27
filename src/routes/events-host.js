'use strict';

// 宿主端口：events 簇的 15 条公开路由已由 Rust 前门独占
// （src/events/routes.js 的 8 条、src/triggers/index.js 的 5 条、
// src/annotation-live.js 的 2 条）。路径匹配、参数解码、query/body 读取、
// publicSessionAccessGuard 的 404、OPTIONS Allow、校验决策树、DTO 键序与错误信封
// 见 native/gateway/src/app/event_routes.rs 与 native/core/src/event_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   hub / engine          事件环形缓冲、emit、规则表与 event-rules.json 持久化
//   persistedSessions     会话 Map；trigger 的增删改与 lastFiredAt 落盘
//   fireTrigger           手动 /test 真正跑一次（注入、广播、持久化）
//   reconcileSession      重建 watcher / cron
//   appendEvent           trigger_added / trigger_fired 事件
//   cron.validate         定时表达式校验（只能在这个进程里做）
//   channelRegistry        渠道接收人核对（插件注册表）
//   annotation-live       annotation-live.json 热加载、JS 正则匹配、remote-screen
//                          内置处理器与 HTTP webhook 转发（8s 超时）
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const channelRegistry = require('../plugins/channel-registry');
const { isLocalRequest } = require('../native/binding').requestLocality;

const HOST_PATH = '/api/__host/events';

/** Marker meaning "this op is not part of the cluster" -> 400 unknown operation. */
const UNKNOWN = Symbol('unknown');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function createEventsRuntime(rawDeps = {}) {
  const deps = rawDeps;
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const randomUUID = deps.randomUUID || require('crypto').randomUUID;
  const checkTarget = typeof deps.checkChannelTarget === 'function'
    ? deps.checkChannelTarget
    : (plugin, target) => channelRegistry.checkTarget(plugin, target);
  const annotation = deps.annotation || require('../annotation-live');

  function identity() {
    return { id: randomUUID(), createdAt: new Date(now()).toISOString() };
  }

  function invoke(body) {
    switch (body.op) {
      case 'identity':
        return identity();

      case 'rules-state':
        return { count: deps.engine.listGlobal().length, ...identity() };

      case 'rules-list':
        return deps.engine.listGlobal();

      case 'rules-add': {
        const rule = asObject(body.rule);
        deps.engine.insertGlobal(rule);
        return { rule };
      }

      case 'rules-get': {
        const rule = deps.engine.findGlobal(String(body.id || ''));
        return rule ? { found: true, rule } : { found: false, rule: null };
      }

      case 'rules-replace': {
        const replaced = deps.engine.replaceGlobal(String(body.id || ''), asObject(body.rule));
        return { found: !!replaced };
      }

      case 'rules-remove':
        return { removed: deps.engine.removeGlobal(String(body.id || '')) };

      case 'check-channels': {
        const rule = asObject(body.rule);
        for (const action of channelActions(rule)) {
          const problem = checkTarget(action.plugin, action.target);
          if (problem) return { problem };
        }
        return { problem: null };
      }

      case 'cron-validate':
        return { valid: deps.cron.validate(String(body.expression == null ? '' : body.expression)) };

      case 'recent':
        return {
          events: deps.hub.recent(body.limit),
          runs: deps.engine.recentResults(),
          chains: deps.engine.pendingChains(),
        };

      case 'list-all':
        return deps.engine.listAll();

      case 'emit': {
        const input = asObject(body.event);
        const event = deps.hub.emit(
          input.type,
          input.sessionId == null ? null : input.sessionId,
          { goal: input.goal, goalState: input.goalState },
          { origin: 'manual-test' },
        );
        return { eventId: event && event.eventId };
      }

      case 'trigger-add': {
        const session = deps.persistedSessions.get(String(body.id || ''));
        if (!session) return { missing: true };
        const trigger = asObject(body.trigger);
        deps.sessionPersistence.mutate('http.create-session-trigger', () => {
          if (!Array.isArray(session.triggers)) session.triggers = [];
          session.triggers.push(trigger);
        });
        deps.triggerRuntime.reconcileSession(session.id);
        deps.appendEvent(session.dirId, 'trigger_added', String(body.label || ''), session.id);
        return { missing: false };
      }

      case 'trigger-replace': {
        const session = deps.persistedSessions.get(String(body.id || ''));
        if (!session || !Array.isArray(session.triggers)) return { error: 'not found' };
        const tid = String(body.tid || '');
        const index = session.triggers.findIndex(trigger => trigger.id === tid);
        if (index < 0) return { error: 'trigger not found' };
        const trigger = asObject(body.trigger);
        deps.sessionPersistence.mutate('http.update-session-trigger', () => {
          session.triggers[index] = trigger;
        });
        deps.triggerRuntime.reconcileSession(session.id);
        return { ok: true };
      }

      case 'trigger-delete': {
        const session = deps.persistedSessions.get(String(body.id || ''));
        if (!session || !Array.isArray(session.triggers)) return { error: 'not found' };
        const tid = String(body.tid || '');
        const next = session.triggers.filter(trigger => trigger.id !== tid);
        if (next.length === session.triggers.length) return { error: 'trigger not found' };
        deps.sessionPersistence.mutate('http.delete-session-trigger', () => { session.triggers = next; });
        deps.triggerRuntime.reconcileSession(session.id);
        return { ok: true };
      }

      case 'trigger-test': {
        const session = deps.persistedSessions.get(String(body.id || ''));
        if (!session) return { error: 'not found' };
        deps.triggerRuntime.fireTrigger(session.id, asObject(body.trigger), 'manual-test', {
          persistence: 'required',
        });
        return { ok: true };
      }

      case 'annotation-get':
        return { config: annotation.CONFIG, targets: annotation.loadTargets() };

      case 'annotation-relay':
        return annotation.relay(asObject(body.payload));

      default:
        return UNKNOWN;
    }
  }

  function channelActions(rule) {
    const actions = [];
    if (rule.action && rule.action.kind === 'channel') actions.push(rule.action);
    if (Array.isArray(rule.then)) {
      for (const step of rule.then) if (step && step.kind === 'channel') actions.push(step);
    }
    return actions;
  }

  async function handle(body) {
    return invoke(asObject(body));
  }

  function mount(app) {
    app.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      const isLocal = typeof deps.isLocal === 'function' ? deps.isLocal : isLocalRequest;
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = asObject(req.body);
      return Promise.resolve()
        .then(() => invoke(body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            // 500 会被前门翻译成 rust_backend_unavailable（见 docs/gateway.md §9）。
            logger?.error?.('[events-host] operation failed', body.op, error);
            return res.status(500).json({ error: 'host operation failed' });
          },
        );
    });
  }

  return { handle, mount };
}

function mountEventsHostRoute(app, options = {}) {
  createEventsRuntime(options).mount(app);
}

module.exports = { HOST_PATH, createEventsRuntime, mountEventsHostRoute };
