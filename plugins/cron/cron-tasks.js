// ── Scheduled tasks (定时任务) ──
//
// multicc-native recurring tasks. Every schedule owns one canonical Air task.
// A firing enters that task through the task-shell receipt protocol, so repeated
// runs share one task history/workspace and a busy task queues normally. Cron
// never creates an unbound compatibility Chat session.
//
// Decoupled from server.js via init(deps): the host injects task-shell ports so
// this module never requires server.js back.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createPaths } = require('../../src/paths');
const { atomicWriteJson } = require('../../src/runtime-security');

const STORE = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).scheduledTasksFile;
const LEGACY_STORE = path.join(__dirname, 'scheduled_tasks.json');

let tasks = [];
let deps = null;       // { directories, createTask, getTask, sendTaskMessage, resolveTaskId, taskSummary, clis }
let timer = null;
let migration = null;
const bindingFlights = new Map();

function load() {
  const source = !fs.existsSync(STORE) && fs.existsSync(LEGACY_STORE) ? LEGACY_STORE : STORE;
  try { tasks = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch { tasks = []; }
  if (!Array.isArray(tasks)) tasks = [];
  // Copy forward once but leave the legacy file untouched for rollback.
  if (source === LEGACY_STORE) save();
}
function save() {
  try { atomicWriteJson(STORE, tasks); }
  catch (e) { console.error('[multicc/cron] save failed:', e.message); }
}
function uid() {
  return 'cron_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ── Cron (5-field: minute hour day-of-month month day-of-week) ──
const CRON_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
function parseField(field, min, max) {
  // returns a Set of allowed ints, or null on parse error
  const out = new Set();
  for (const partRaw of String(field).split(',')) {
    const part = partRaw.trim();
    if (!part) return null;
    let step = 1, range = part;
    const slash = part.split('/');
    if (slash.length === 2) { range = slash[0]; step = parseInt(slash[1], 10); if (!(step > 0)) return null; }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-'); lo = parseInt(a, 10); hi = parseInt(b, 10);
    } else { lo = hi = parseInt(range, 10); }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function cronParse(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], CRON_BOUNDS[i][0], CRON_BOUNDS[i][1]);
    if (!s) return null;
    sets.push(s);
  }
  return sets;
}
function cronValidate(expr) { return !!cronParse(expr); }
function cronMatch(sets, date) {
  // day-of-month and day-of-week are OR'd when both are restricted (cron convention)
  const dom = sets[2], dowSet = sets[4];
  const domRestricted = dom.size !== 31;
  const dowRestricted = dowSet.size !== 7;
  const minOk = sets[0].has(date.getMinutes());
  const hourOk = sets[1].has(date.getHours());
  const monOk = sets[3].has(date.getMonth() + 1);
  if (!(minOk && hourOk && monOk)) return false;
  const domOk = dom.has(date.getDate());
  const dowOk = dowSet.has(date.getDay());
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}
function cronNext(expr, from) {
  const sets = cronParse(expr);
  if (!sets) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 1440; i++) {     // scan up to ~1 year, break on first match
    if (cronMatch(sets, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ── Fixed Air task binding + firing ──
function taskClientMsgId(...parts) {
  return parts.join(':').replace(/[^\w.:-]/g, '_').slice(0, 160);
}

async function taskEntry(taskId) {
  if (!deps.getTask) return null;
  const entry = await deps.getTask(taskId);
  if (!entry?.task?.id || entry.readOnly) {
    const error = new Error(entry?.readOnly ? '固定任务已归档或只读' : '固定任务不存在');
    error.code = entry?.readOnly ? 'task_read_only' : 'task_not_found';
    throw error;
  }
  return entry;
}

// A schedule must never rotate its own identity. When the bound task can no
// longer receive work we stop firing, record the break and tell the user once;
// rotation only happens through the explicit POST /api/cron/:id/rebind action.
const BINDING_BREAK_CODES = new Set(['task_read_only', 'task_not_found', 'task_archived', 'task_owner_missing']);

function markBindingBroken(task, error) {
  task.taskBindingError = error?.message || error?.code || '固定任务绑定失败';
  task.taskBindingBrokenAt = task.taskBindingBrokenAt || Date.now();
  const fingerprint = task.taskId || 'unbound';
  if (task.taskBindingNotifiedFor === fingerprint) return;
  task.taskBindingNotifiedFor = fingerprint;
  try {
    const dir = deps.directories?.get?.(task.dirId);
    deps.notifyBroken?.({
      id: task.id, name: task.name, taskId: task.taskId || null, dirId: task.dirId,
      sessionId: task.taskSessionId || null, dirName: dir?.name || null,
      code: error?.code || 'task_binding_broken', error: task.taskBindingError,
      message: `定时规则「${task.name}」已停止：固定 Air 任务不可写（${task.taskBindingError}），请在定时中心重新绑定。`,
    });
  } catch (_) { /* notification is best effort; the break itself is already durable */ }
}

function clearBindingBreak(task) {
  task.taskBindingError = '';
  task.taskBindingBrokenAt = null;
  task.taskBindingNotifiedFor = null;
}

async function ensureTaskInner(task) {
  if (deps.ready) await deps.ready;
  const dir = deps.directories.get(task.dirId);
  if (!dir) throw Object.assign(new Error('目标目录不存在'), { code: 'directory_missing' });

  // New-format schedules never silently rotate identity. If the user removed
  // or archived their fixed task, surface that fact and let them decide.
  if (task.taskId) {
    // Builds that first introduced taskId could race the startup task-first
    // migration and create an empty task before the latest legacy execution
    // became adoptable. One versioned repair pass prefers that preserved,
    // writable history; after the pass identity is immutable again.
    if (task.taskBindingVersion !== 1 && task.lastSessionId && deps.resolveTaskId) {
      const preservedTaskId = deps.resolveTaskId(task.lastSessionId);
      if (preservedTaskId && preservedTaskId !== task.taskId) {
        try {
          const preserved = await taskEntry(preservedTaskId);
          task.taskId = preservedTaskId;
          task.taskSessionId = preserved?.sessionId || task.lastSessionId;
        } catch (_) { /* archived/missing history does not replace the fixed task */ }
      }
    }
    const entry = await taskEntry(task.taskId);
    task.taskSessionId = entry?.sessionId || task.taskSessionId || null;
    task.taskBindingVersion = 1;
    clearBindingBreak(task);
    return { taskId: task.taskId, sessionId: task.taskSessionId, entry };
  }

  // One-time migration: adopt the Air task that already owns the legacy cron
  // session. This preserves all existing history instead of starting over.
  if (task.lastSessionId && deps.resolveTaskId) {
    const migratedTaskId = deps.resolveTaskId(task.lastSessionId);
    if (migratedTaskId) {
      try {
        const entry = await taskEntry(migratedTaskId);
        task.taskId = migratedTaskId;
        task.taskSessionId = entry?.sessionId || task.lastSessionId;
        task.taskBindingVersion = 1;
        clearBindingBreak(task);
        save();
        return { taskId: task.taskId, sessionId: task.taskSessionId, entry, migrated: true };
      } catch (_) {
        // A deleted/orphaned legacy task must not poison the schedule forever;
        // create one new canonical task during this migration only.
      }
    }
  }

  if (typeof deps.createTask !== 'function') {
    throw Object.assign(new Error('Air 任务服务尚未就绪'), { code: 'task_service_unavailable' });
  }
  const created = await deps.createTask({
    dirId: task.dirId,
    title: task.name,
    cli: task.cli || 'claude',
    clientMsgId: taskClientMsgId('cron-task', task.id),
  });
  if (!created?.ok || !created.taskId) {
    throw Object.assign(new Error(created?.error || created?.code || '创建固定任务失败'), { code: created?.code || 'task_create_failed' });
  }
  task.taskId = created.taskId;
  task.taskSessionId = created.sessionId || null;
  task.taskBindingVersion = 1;
  clearBindingBreak(task);
  save();
  return { taskId: task.taskId, sessionId: task.taskSessionId, entry: created, created: true };
}

async function ensureTask(task) {
  if (bindingFlights.has(task.id)) return bindingFlights.get(task.id);
  const operation = ensureTaskInner(task);
  bindingFlights.set(task.id, operation);
  try { return await operation; }
  finally { bindingFlights.delete(task.id); }
}

// Explicit repair for a schedule whose fixed task was archived or deleted.
// GitHub-style identity immutability: nothing rotates the binding implicitly.
async function rebindTask(task, { force = false, reason = 'manual' } = {}) {
  if (typeof deps.createTask !== 'function') {
    throw Object.assign(new Error('Air 任务服务尚未就绪'), { code: 'task_service_unavailable' });
  }
  const previousTaskId = task.taskId || null;
  if (previousTaskId && !force) {
    try {
      await taskEntry(previousTaskId);
      return { ok: false, code: 'binding_healthy', taskId: previousTaskId, previousTaskId };
    } catch (error) {
      if (!BINDING_BREAK_CODES.has(error?.code)) throw error;
    }
  }
  const created = await deps.createTask({
    dirId: task.dirId,
    title: task.name,
    cli: task.cli || 'claude',
    clientMsgId: taskClientMsgId('cron-rebind', task.id, previousTaskId || 'unbound'),
  });
  if (!created?.ok || !created.taskId) {
    throw Object.assign(new Error(created?.error || created?.code || '重建固定任务失败'), { code: created?.code || 'task_create_failed' });
  }
  task.taskRebindHistory = [...(task.taskRebindHistory || []),
    { from: previousTaskId, to: created.taskId, at: Date.now(), reason }].slice(-10);
  task.taskId = created.taskId;
  task.taskSessionId = created.sessionId || null;
  task.lastSessionId = task.taskSessionId;
  task.taskBindingVersion = 1;
  clearBindingBreak(task);
  save();
  return { ok: true, taskId: task.taskId, sessionId: task.taskSessionId, previousTaskId };
}

async function migrateTasks() {
  if (!deps?.createTask || !deps?.getTask) return { migrated: 0, errors: [] };
  let migrated = 0;
  const errors = [];
  for (const task of tasks) {
    try {
      const before = task.taskId;
      await ensureTask(task);
      if (!before && task.taskId) migrated++;
    } catch (error) {
      markBindingBroken(task, error);
      errors.push({ id: task.id, code: error.code || 'task_binding_failed', error: task.taskBindingError });
    }
  }
  save();
  return { migrated, errors };
}

async function fireTask(task, reason, deliveryKey = null) {
  const attemptedAt = Date.now();
  let binding = null;
  let result = null;
  try {
    if (typeof deps.sendTaskMessage !== 'function') throw Object.assign(new Error('Air 任务入口尚未就绪'), { code: 'task_service_unavailable' });
    binding = await ensureTask(task);
    const key = deliveryKey || (reason === 'manual' ? randomUUID() : String(attemptedAt));
    result = await deps.sendTaskMessage(binding.taskId, task.prompt, {
      clientMsgId: taskClientMsgId('cron-run', task.id, reason, key),
      source: 'cron',
      taskText: task.name,
    });
    if (!result?.ok) throw Object.assign(new Error(result?.error || result?.code || '任务入队失败'), { code: result?.code || 'task_delivery_failed' });
    task.lastError = '';
    clearBindingBreak(task);
    task.lastStatus = result.decision === 'queued' ? 'queued' : 'ok';
    task.lastReceiptId = result.receiptId || null;
    task.lastDecision = result.decision || 'continue';
  } catch (error) {
    task.lastStatus = 'error';
    task.lastError = error.message || error.code || '任务入队失败';
    // The fixed task is gone/archived: never spawn a replacement on our own,
    // surface it once and let the explicit rebind action rotate the identity.
    if (!task.taskId) task.taskBindingError = task.lastError;
    else if (BINDING_BREAK_CODES.has(error?.code)) markBindingBroken(task, error);
  }
  task.lastRunAt = attemptedAt;
  if (binding?.sessionId || result?.sessionId) {
    task.taskSessionId = result?.sessionId || binding.sessionId;
    // Kept as a compatibility read field for old API clients; execution is no
    // longer addressed through this session ID.
    task.lastSessionId = task.taskSessionId;
  }
  task.runCount = (task.runCount || 0) + 1;
  save();
  const ok = result?.ok === true;
  console.log(`[multicc/cron] fired ${task.id} (${task.name}) [${reason}] → Air task ${task.taskId || 'unbound'}, ${ok ? task.lastStatus : task.lastError}`);
  return { ok, taskId: task.taskId || null, sessionId: task.taskSessionId || null,
    receiptId: result?.receiptId || null, decision: result?.decision || null, error: ok ? null : task.lastError };
}

async function tick() {
  if (migration) await migration;
  const now = new Date();
  const key = `${now.getFullYear()}${now.getMonth()}${now.getDate()}${now.getHours()}${now.getMinutes()}`;
  for (const task of tasks) {
    if (!task.enabled) continue;
    const sets = cronParse(task.cron);
    if (!sets) continue;
    if (task._tickKey === key) continue;       // already fired this minute
    if (cronMatch(sets, now)) {
      task._tickKey = key;
      await fireTask(task, 'schedule', key);
    }
  }
}

// ── Serialisation for the API (adds computed fields) ──
function toView(task) {
  const dir = deps && deps.directories.get(task.dirId);
  const summary = task.taskId && deps?.taskSummary ? deps.taskSummary(task.taskId) : null;
  return {
    id: task.id, name: task.name, dirId: task.dirId,
    dirName: dir ? dir.name : '(已删除)',
    cli: summary?.runtime?.cli || task.cli || 'claude',
    provider: summary?.runtime?.provider || null,
    model: summary?.runtime?.model || null,
    effort: summary?.runtime?.effort || null,
    prompt: task.prompt, cron: task.cron, enabled: !!task.enabled,
    createdBy: task.createdBy || 'user', createdAt: task.createdAt,
    lastRunAt: task.lastRunAt || null, lastStatus: task.lastStatus || null,
    lastError: task.lastError || '', lastSessionId: task.taskSessionId || task.lastSessionId || null,
    taskId: task.taskId || null,
    taskTitle: summary?.title || task.name,
    taskStatus: summary?.status || (task.taskId ? 'unknown' : 'binding'),
    taskReadOnly: summary?.readOnly === true,
    taskBindingError: task.taskBindingError || '',
    taskBindingBroken: !!task.taskBindingError,
    taskBindingBrokenAt: task.taskBindingBrokenAt || null,
    taskRebindHistory: Array.isArray(task.taskRebindHistory) ? task.taskRebindHistory : [],
    taskUrl: task.taskId ? `/air?task=${encodeURIComponent(task.taskId)}&dir=${encodeURIComponent(task.dirId)}` : null,
    lastReceiptId: task.lastReceiptId || null,
    lastDecision: task.lastDecision || null,
    runCount: task.runCount || 0,
    nextRunAt: task.enabled ? cronNext(task.cron, new Date()) : null,
  };
}

function sanitizeIncoming(body, existing) {
  const t = existing || {};
  const out = {};
  if (body.name !== undefined) out.name = String(body.name).trim().slice(0, 80);
  if (body.dirId !== undefined) out.dirId = String(body.dirId);
  // allow targeting by directory path too (agents know their cwd, not the dirId)
  if (!out.dirId && body.dirPath) {
    const abs = path.resolve(String(body.dirPath));
    for (const d of deps.directories.values()) { if (path.resolve(d.path) === abs) { out.dirId = d.id; break; } }
  }
  if (body.cli !== undefined) out.cli = String(body.cli || '').trim().slice(0, 40) || 'claude';
  if (body.prompt !== undefined) out.prompt = String(body.prompt);
  if (body.cron !== undefined) out.cron = String(body.cron).trim();
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.createdBy !== undefined) out.createdBy = String(body.createdBy).slice(0, 80);
  return { ...t, ...out };
}

function validate(t) {
  if (!t.name) return '任务名不能为空';
  if (!t.dirId || !deps.directories.get(t.dirId)) return '目标目录无效';
  if (deps.clis?.length && !deps.clis.includes(t.cli || 'claude')) return 'CLI 无效';
  if (!t.prompt || !t.prompt.trim()) return 'prompt 不能为空';
  if (!cronValidate(t.cron || '')) return 'cron 表达式无效（需 5 段：分 时 日 月 周）';
  return null;
}

// ── HTTP routes ──
function mount(app) {
  app.get('/api/cron', (req, res, next) => Promise.resolve().then(async () => {
    await migrateTasks();
    res.json(tasks.map(toView));
  }).catch(next));

  app.post('/api/cron', (req, res, next) => Promise.resolve().then(async () => {
    const t = sanitizeIncoming(req.body || {});
    if (t.enabled === undefined) t.enabled = true;
    if (!t.cli) t.cli = 'claude';
    const err = validate(t);
    if (err) return res.status(400).json({ error: err });
    t.id = uid();
    t.createdAt = new Date().toISOString();
    if (!t.createdBy) t.createdBy = 'user';
    await ensureTask(t);
    tasks.push(t);
    save();
    console.log(`[multicc/cron] created task ${t.id} (${t.name}) by ${t.createdBy}, cron="${t.cron}"`);
    res.json(toView(t));
  }).catch(next));

  app.patch('/api/cron/:id', (req, res) => {
    const idx = tasks.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'task not found' });
    const current = tasks[idx];
    if (current.taskId && req.body?.dirId !== undefined && String(req.body.dirId) !== current.dirId) {
      return res.status(409).json({ error: '固定任务的工作目录不能修改；请新建另一条定时任务' });
    }
    if (current.taskId && req.body?.cli !== undefined && String(req.body.cli) !== (current.cli || 'claude')) {
      return res.status(409).json({ error: '请打开固定 Air 任务修改 CLI / Provider' });
    }
    const merged = sanitizeIncoming(req.body || {}, current);
    const err = validate(merged);
    if (err) return res.status(400).json({ error: err });
    merged._tickKey = null;                 // schedule may have changed → allow re-fire
    tasks[idx] = merged;
    save();
    res.json(toView(merged));
  });

  app.delete('/api/cron/:id', (req, res) => {
    const idx = tasks.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'task not found' });
    const [removed] = tasks.splice(idx, 1);
    save();
    console.log(`[multicc/cron] deleted task ${removed.id} (${removed.name})`);
    res.json({ ok: true });
  });

  app.post('/api/cron/:id/rebind', (req, res, next) => Promise.resolve().then(async () => {
    const task = tasks.find(x => x.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const result = await rebindTask(task, { force: req.body?.force === true, reason: req.body?.reason || 'manual' });
    if (!result.ok) return res.status(409).json({ error: result.code || 'rebind_failed', taskId: result.taskId || null });
    console.log(`[multicc/cron] rebound ${task.id} (${task.name}) → Air task ${result.taskId} (was ${result.previousTaskId || 'unbound'})`);
    res.json({ ...result, task: toView(task) });
  }).catch(next));

  app.post('/api/cron/:id/run', (req, res, next) => Promise.resolve().then(async () => {
    const task = tasks.find(x => x.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const r = await fireTask(task, 'manual');
    res.json({ ok: r.ok, taskId: r.taskId, sessionId: r.sessionId,
      receiptId: r.receiptId, decision: r.decision, error: r.error });
  }).catch(next));
}

function init(injected) {
  deps = injected;
  load();
  migration = migrateTasks().catch(error => {
    console.error('[multicc/cron] Air task migration failed:', error.message);
    return { migrated: 0, errors: [{ error: error.message }] };
  });
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  timer = setInterval(tick, 30000);
  if (timer.unref) timer.unref();
  console.log(`[multicc/cron] scheduler started, ${tasks.length} task(s) loaded`);
}

// Idempotent lifecycle hook for graceful shutdown. Loaded tasks and injected
// dependencies stay in memory so init() can restart scheduling later.
function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { init, stop, mount, cronValidate, cronNext, _fireTask: fireTask,
  _ensureTask: ensureTask, _rebindTask: rebindTask, _migrateTasks: migrateTasks };
