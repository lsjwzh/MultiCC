'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const DEFAULT_TRIGGER_PROMPT =
  '【multicc 自动触发】请使用 multicc-trigger skill 执行检查流程：查看当前 git 改动（git status/diff），' +
  '提醒我该提交或该补/跑测试的地方；简短汇报即可，不要擅自修改代码或提交。';

const TRIGGER_TYPES = Object.freeze(['post-turn', 'file-change', 'schedule']);
const WATCH_IGNORED = /(^|[\/\\])(\.git|node_modules|\.multicc-worktrees|\.DS_Store)([\/\\]|$)/;

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('trigger dependencies are required');
  const functions = [
    'saveBestEffort',
    'cwdForSession',
    'appendEvent',
    'chatBroadcast',
  ];
  for (const name of functions) {
    if (typeof deps[name] !== 'function') throw new TypeError(`trigger dependency missing: ${name}`);
  }
  if (!deps.crypto || typeof deps.crypto.randomUUID !== 'function') {
    throw new TypeError('trigger dependency missing: crypto.randomUUID');
  }
  if (!deps.cron || typeof deps.cron.validate !== 'function' || typeof deps.cron.schedule !== 'function') {
    throw new TypeError('trigger dependency missing: cron');
  }
  if (!deps.chokidar || typeof deps.chokidar.watch !== 'function') {
    throw new TypeError('trigger dependency missing: chokidar.watch');
  }
  if (!deps.fs || typeof deps.fs.existsSync !== 'function') {
    throw new TypeError('trigger dependency missing: fs.existsSync');
  }
  if (!deps.path || typeof deps.path.relative !== 'function' || !deps.path.sep) {
    throw new TypeError('trigger dependency missing: path');
  }
  if (!deps.bus || typeof deps.bus.on !== 'function' || typeof deps.bus.emit !== 'function') {
    throw new TypeError('trigger dependency missing: bus');
  }
  if (!(deps.persistedSessions instanceof Map) || !(deps.chatSessions instanceof Map)) {
    throw new TypeError('trigger session Maps are required');
  }
  if (!deps.sessionPersistence || typeof deps.sessionPersistence.mutate !== 'function') {
    throw new TypeError('trigger dependency missing: sessionPersistence.mutate');
  }
  return deps;
}

function assertApp(app) {
  for (const method of ['get', 'post', 'put', 'delete']) {
    if (!app || typeof app[method] !== 'function') throw new TypeError(`Express app.${method} is required`);
  }
}

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function createSessionTriggers(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const timers = deps.timers || {};
  const setTimeoutFn = typeof timers.setTimeout === 'function' ? timers.setTimeout : setTimeout;
  const clearTimeoutFn = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.logger || console;

  const watchers = new Map();
  const watcherDebouncers = new Map();
  const cronTasks = new Map();
  const deferredFires = new Map();
  const pendingClosures = new Set();
  const globCache = new Map();
  let started = false;
  let routesMounted = false;

  function safeError(error, fallback = 'trigger runtime failed') {
    return sanitizePublicText(error && error.message, fallback);
  }

  function warn(event, fields = {}) {
    const safeFields = { ...fields };
    if (safeFields.error) safeFields.error = safeError({ message: String(safeFields.error) });
    try {
      if (typeof logger.warn === 'function') logger.warn(event, safeFields);
    } catch (_) {}
  }

  function triggerLabel(trigger) {
    if (trigger.type === 'file-change') return `文件变更 ${(trigger.paths || []).join(',')}`;
    if (trigger.type === 'schedule') return `定时 ${trigger.cron}`;
    return '每轮结束';
  }

  function validateTrigger(body = {}) {
    const type = String(body.type || '');
    if (!TRIGGER_TYPES.includes(type)) return { error: 'invalid type' };
    const trigger = {
      id: body.id || deps.crypto.randomUUID(),
      type,
      enabled: body.enabled !== false,
      prompt: body.prompt != null ? String(body.prompt).slice(0, 4000) : '',
      cooldownMs: clampInt(body.cooldownMs, 0, 86400000, type === 'post-turn' ? 30000 : 0),
      mode: 'inject',
      createdAt: body.createdAt || new Date(now()).toISOString(),
    };
    if (type === 'file-change') {
      let paths = body.paths;
      if (typeof paths === 'string') paths = [paths];
      if (!Array.isArray(paths) || !paths.length) return { error: 'file-change requires paths[]' };
      trigger.paths = paths.map(String).slice(0, 20);
      trigger.debounceMs = clampInt(body.debounceMs, 500, 60000, 3000);
    }
    if (type === 'schedule') {
      if (!body.cron || !deps.cron.validate(String(body.cron))) {
        return { error: 'invalid cron expression' };
      }
      trigger.cron = String(body.cron);
    }
    return { trigger };
  }

  function globToRegex(glob) {
    let expression = '';
    for (let index = 0; index < glob.length; index += 1) {
      const character = glob[index];
      if (character === '*') {
        if (glob[index + 1] === '*') {
          expression += '.*';
          index += 1;
          if (glob[index + 1] === '/') index += 1;
        } else {
          expression += '[^/]*';
        }
      } else if (character === '?') {
        expression += '[^/]';
      } else if ('.+^${}()|[]\\'.includes(character)) {
        expression += `\\${character}`;
      } else {
        expression += character;
      }
    }
    return new RegExp(`^${expression}$`);
  }

  function matchGlob(relativePath, glob) {
    let regex = globCache.get(glob);
    if (!regex) {
      regex = globToRegex(glob);
      globCache.set(glob, regex);
    }
    return regex.test(relativePath);
  }

  function matchAnyGlob(relativePath, globs) {
    return Array.isArray(globs) && globs.some((glob) => matchGlob(relativePath, glob));
  }

  function clearDeferredForSession(sessionId) {
    const prefix = `${sessionId}:`;
    for (const [key, timer] of deferredFires) {
      if (!key.startsWith(prefix)) continue;
      clearTimeoutFn(timer);
      deferredFires.delete(key);
    }
  }

  function fireTrigger(sessionId, trigger, reason, options = {}) {
    const persisted = deps.persistedSessions.get(sessionId);
    if (!persisted || !trigger) return false;
    // A watcher/cron/deferred callback may outlive an edit or deletion. Require
    // the trigger to still exist, and use its latest live definition for all
    // background fires so stale prompts or disabled rules cannot run.
    const live = (persisted.triggers || []).find((candidate) => candidate.id === trigger.id);
    if (!live) return false;
    const effective = options.persistence === 'required' ? trigger : live;
    if (!effective.enabled) return false;
    const firedAt = now();
    const cooldownMs = effective.cooldownMs || 0;
    if (cooldownMs > 0 && live.lastFiredAt && firedAt - live.lastFiredAt < cooldownMs) return false;

    const chat = deps.chatSessions.get(sessionId);
    if (chat && chat.isStreaming) {
      const key = `${sessionId}:${effective.id}`;
      if (!deferredFires.has(key)) {
        const timer = setTimeoutFn(() => {
          deferredFires.delete(key);
          try {
            fireTrigger(sessionId, effective, reason, options);
          } catch (error) {
            warn('trigger_deferred_fire_failed', {
              sessionId,
              triggerId: effective.id,
              error: safeError(error),
            });
          }
        }, 6000);
        deferredFires.set(key, timer);
      }
      return false;
    }

    if (options.persistence === 'required') {
      deps.sessionPersistence.mutate('http.test-session-trigger', () => { live.lastFiredAt = firedAt; });
    } else {
      live.lastFiredAt = firedAt;
      deps.saveBestEffort(`runtime.trigger-fired.${reason || 'unknown'}`);
    }

    const prompt = effective.prompt && effective.prompt.trim() || DEFAULT_TRIGGER_PROMPT;
    deps.appendEvent(persisted.dirId, 'trigger_fired', `${triggerLabel(effective)} · ${reason}`, sessionId);
    deps.chatBroadcast(sessionId, {
      type: 'system',
      subtype: 'trigger_fired',
      trigger: triggerLabel(effective),
      reason,
    });
    deps.bus.emit('chat:run', sessionId, prompt, { originTrigger: true });
    return true;
  }

  function firePostTurnTriggers(sessionId, chat, completion) {
    if (!completion || completion.resultDurable !== true) return 0;
    if (completion.lineage && completion.lineage.kind === 'trigger') return 0;
    const persisted = deps.persistedSessions.get(sessionId);
    if (!persisted || !Array.isArray(persisted.triggers)) return 0;
    let fired = 0;
    for (const trigger of persisted.triggers) {
      if (trigger.enabled && trigger.type === 'post-turn'
          && fireTrigger(sessionId, trigger, 'post-turn')) fired += 1;
    }
    return fired;
  }

  function safeBackgroundFire(sessionId, trigger, reason) {
    try {
      return fireTrigger(sessionId, trigger, reason);
    } catch (error) {
      warn('trigger_background_fire_failed', {
        sessionId,
        triggerId: trigger && trigger.id,
        error: safeError(error),
      });
      return false;
    }
  }

  function rememberClosure(value) {
    if (!value || typeof value.then !== 'function') return;
    const closure = Promise.resolve(value).catch((error) => {
      warn('trigger_watcher_close_failed', { error: safeError(error) });
    }).finally(() => pendingClosures.delete(closure));
    pendingClosures.add(closure);
  }

  function buildFileWatcher(sessionId, persisted) {
    const triggers = (persisted.triggers || []).filter((trigger) => trigger.enabled && trigger.type === 'file-change');
    if (!triggers.length) return null;
    let root;
    try {
      root = persisted.worktreePath || deps.cwdForSession(persisted);
      if (!root || !deps.fs.existsSync(root)) return null;
    } catch (error) {
      warn('trigger_watch_root_failed', { sessionId, error: safeError(error) });
      return null;
    }

    let watcher;
    try {
      watcher = deps.chokidar.watch(root, {
        ignoreInitial: true,
        persistent: true,
        depth: 20,
        ignored: (candidate) => WATCH_IGNORED.test(candidate),
      });
    } catch (error) {
      warn('trigger_watch_failed', { sessionId, error: safeError(error) });
      return null;
    }

    const debouncers = new Map();
    watcherDebouncers.set(sessionId, debouncers);
    const onChange = (fullPath) => {
      let relativePath;
      try {
        relativePath = deps.path.relative(root, fullPath).split(deps.path.sep).join('/');
      } catch (error) {
        warn('trigger_watch_event_failed', { sessionId, error: safeError(error) });
        return;
      }
      for (const trigger of triggers) {
        if (!matchAnyGlob(relativePath, trigger.paths)) continue;
        if (debouncers.has(trigger.id)) clearTimeoutFn(debouncers.get(trigger.id));
        const timer = setTimeoutFn(() => {
          debouncers.delete(trigger.id);
          safeBackgroundFire(sessionId, trigger, `file:${relativePath}`);
        }, trigger.debounceMs || 3000);
        debouncers.set(trigger.id, timer);
      }
    };
    watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    watcher.on('error', (error) => {
      warn('trigger_watch_error', { sessionId, error: safeError(error) });
    });
    watchers.set(sessionId, watcher);
    return watcher;
  }

  function buildCronTasks(sessionId, persisted) {
    const triggers = (persisted.triggers || []).filter((trigger) => (
      trigger.enabled && trigger.type === 'schedule' && trigger.cron
    ));
    const tasks = [];
    for (const trigger of triggers) {
      if (!deps.cron.validate(trigger.cron)) continue;
      try {
        tasks.push(deps.cron.schedule(trigger.cron, () => {
          safeBackgroundFire(sessionId, trigger, 'schedule');
        }));
      } catch (error) {
        warn('trigger_cron_failed', {
          sessionId,
          cron: trigger.cron,
          error: safeError(error),
        });
      }
    }
    if (tasks.length) cronTasks.set(sessionId, tasks);
    return tasks;
  }

  function teardownSession(sessionId) {
    clearDeferredForSession(sessionId);
    const debouncers = watcherDebouncers.get(sessionId);
    if (debouncers) {
      for (const timer of debouncers.values()) clearTimeoutFn(timer);
      debouncers.clear();
      watcherDebouncers.delete(sessionId);
    }

    const watcher = watchers.get(sessionId);
    if (watcher) {
      watchers.delete(sessionId);
      try {
        if (typeof watcher.removeAllListeners === 'function') watcher.removeAllListeners();
        if (typeof watcher.close === 'function') rememberClosure(watcher.close());
      } catch (error) {
        warn('trigger_watcher_close_failed', { sessionId, error: safeError(error) });
      }
    }

    const tasks = cronTasks.get(sessionId);
    if (tasks) {
      for (const task of tasks) {
        try { if (task && typeof task.stop === 'function') task.stop(); }
        catch (error) { warn('trigger_cron_stop_failed', { sessionId, error: safeError(error) }); }
      }
      cronTasks.delete(sessionId);
    }
  }

  function reconcileSession(sessionId) {
    teardownSession(sessionId);
    // A late CRUD request must never re-arm process-owned resources once the
    // shutdown coordinator has stopped this runtime.
    if (!started) return false;
    const persisted = deps.persistedSessions.get(sessionId);
    if (!persisted) return false;
    buildFileWatcher(sessionId, persisted);
    buildCronTasks(sessionId, persisted);
    return true;
  }

  function reconcileAll() {
    let count = 0;
    for (const [sessionId, persisted] of deps.persistedSessions) {
      if (!Array.isArray(persisted.triggers) || !persisted.triggers.length) continue;
      reconcileSession(sessionId);
      count += 1;
    }
    if (count && typeof logger.info === 'function') {
      try { logger.info('triggers_armed', { sessions: count }); } catch (_) {}
    }
    return count;
  }

  function mountRoutes(app) {
    assertApp(app);
    if (routesMounted) throw new Error('trigger routes already mounted');
    routesMounted = true;

    app.get('/api/sessions/:id/triggers', (req, res) => {
      const session = deps.persistedSessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      return res.json({ triggers: session.triggers || [] });
    });

    app.post('/api/sessions/:id/triggers', (req, res) => {
      const session = deps.persistedSessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const validation = validateTrigger(req.body || {});
      if (validation.error) return res.status(400).json({ error: validation.error });
      deps.sessionPersistence.mutate('http.create-session-trigger', () => {
        if (!Array.isArray(session.triggers)) session.triggers = [];
        session.triggers.push(validation.trigger);
      });
      reconcileSession(session.id);
      deps.appendEvent(session.dirId, 'trigger_added', triggerLabel(validation.trigger), session.id);
      return res.json(validation.trigger);
    });

    app.put('/api/sessions/:id/triggers/:tid', (req, res) => {
      const session = deps.persistedSessions.get(req.params.id);
      if (!session || !Array.isArray(session.triggers)) return res.status(404).json({ error: 'not found' });
      const index = session.triggers.findIndex((trigger) => trigger.id === req.params.tid);
      if (index < 0) return res.status(404).json({ error: 'trigger not found' });
      const validation = validateTrigger({ ...session.triggers[index], ...req.body, id: req.params.tid });
      if (validation.error) return res.status(400).json({ error: validation.error });
      deps.sessionPersistence.mutate('http.update-session-trigger', () => {
        validation.trigger.lastFiredAt = session.triggers[index].lastFiredAt;
        session.triggers[index] = validation.trigger;
      });
      reconcileSession(session.id);
      return res.json(validation.trigger);
    });

    app.delete('/api/sessions/:id/triggers/:tid', (req, res) => {
      const session = deps.persistedSessions.get(req.params.id);
      if (!session || !Array.isArray(session.triggers)) return res.status(404).json({ error: 'not found' });
      const next = session.triggers.filter((trigger) => trigger.id !== req.params.tid);
      if (next.length === session.triggers.length) return res.status(404).json({ error: 'trigger not found' });
      deps.sessionPersistence.mutate('http.delete-session-trigger', () => { session.triggers = next; });
      reconcileSession(session.id);
      return res.json({ ok: true });
    });

    app.post('/api/sessions/:id/triggers/:tid/test', (req, res) => {
      const session = deps.persistedSessions.get(req.params.id);
      if (!session || !Array.isArray(session.triggers)) return res.status(404).json({ error: 'not found' });
      const trigger = session.triggers.find((candidate) => candidate.id === req.params.tid);
      if (!trigger) return res.status(404).json({ error: 'trigger not found' });
      fireTrigger(session.id, { ...trigger, enabled: true, cooldownMs: 0 }, 'manual-test', {
        persistence: 'required',
      });
      return res.json({ ok: true });
    });

    return app;
  }

  function onTurnComplete(sessionId, chat, completion) {
    try {
      firePostTurnTriggers(sessionId, chat, completion);
    } catch (error) {
      warn('trigger_post_turn_failed', { sessionId, error: safeError(error) });
    }
  }

  function start() {
    if (started) return false;
    started = true;
    deps.bus.on('chat:turn-complete', onTurnComplete);
    reconcileAll();
    return true;
  }

  async function stop() {
    if (started) {
      if (typeof deps.bus.off === 'function') deps.bus.off('chat:turn-complete', onTurnComplete);
      else if (typeof deps.bus.removeListener === 'function') {
        deps.bus.removeListener('chat:turn-complete', onTurnComplete);
      }
      started = false;
    }
    const sessionIds = new Set([
      ...watchers.keys(),
      ...cronTasks.keys(),
      ...watcherDebouncers.keys(),
      ...[...deferredFires.keys()].map((key) => key.split(':')[0]),
    ]);
    for (const sessionId of sessionIds) teardownSession(sessionId);
    if (pendingClosures.size) await Promise.allSettled([...pendingClosures]);
  }

  function status() {
    return Object.freeze({
      started,
      watchers: watchers.size,
      cronTasks: [...cronTasks.values()].reduce((sum, tasks) => sum + tasks.length, 0),
      debouncers: [...watcherDebouncers.values()].reduce((sum, items) => sum + items.size, 0),
      deferred: deferredFires.size,
      pendingClosures: pendingClosures.size,
    });
  }

  return Object.freeze({
    mountRoutes,
    start,
    stop,
    status,
    validateTrigger,
    triggerLabel,
    globToRegex,
    matchGlob,
    matchAnyGlob,
    fireTrigger,
    firePostTurnTriggers,
    reconcileSession,
    reconcileAll,
    teardownSession,
  });
}

module.exports = {
  DEFAULT_TRIGGER_PROMPT,
  TRIGGER_TYPES,
  createSessionTriggers,
};
