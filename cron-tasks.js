// ── Scheduled tasks (定时任务) ──
//
// multicc-native recurring tasks. When a task fires it sends the task's prompt
// to its dedicated chat session in the target directory, reusing that session
// across cycles so context carries over — i.e. "到点叫醒同一个 agent 继续干". A
// fresh session is created only on the first run or if the session was deleted.
// Tasks are created by the user (in /manage) or by an agent (POST /api/cron from
// localhost). All managed centrally in the /manage panel.
//
// Decoupled from server.js via init(deps): the host injects { directories,
// createSessionRecord, runChatTurn, sessionExists } so this module never
// requires server.js back.

const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, 'scheduled_tasks.json');

let tasks = [];
let deps = null;       // { directories, createSessionRecord, runChatTurn, sessionExists }
let timer = null;

function load() {
  try { tasks = JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { tasks = []; }
  if (!Array.isArray(tasks)) tasks = [];
}
function save() {
  try { fs.writeFileSync(STORE, JSON.stringify(tasks, null, 2)); }
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

// ── Firing ──
function fireTask(task, reason) {
  const dir = deps.directories.get(task.dirId);
  if (!dir) {
    task.lastRunAt = Date.now(); task.lastStatus = 'error';
    task.lastError = '目标目录不存在'; save();
    console.warn(`[multicc/cron] task ${task.id} (${task.name}): directory ${task.dirId} missing`);
    return { ok: false, error: '目标目录不存在' };
  }
  // Reuse the task's session across cycles so the conversation context (and
  // for claude, the cliSessionId) carries over from run to run. Only spin up a
  // fresh session when the task has never run, or its session was deleted.
  let sessionId = null;
  let reused = false;
  if (task.lastSessionId && deps.sessionExists && deps.sessionExists(task.lastSessionId)) {
    sessionId = task.lastSessionId;
    reused = true;
  } else {
    let r;
    try {
      r = deps.createSessionRecord({ dir, cli: task.cli || 'claude', kind: 'chat', label: `⏰ ${task.name}` });
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      task.lastRunAt = Date.now(); task.lastStatus = 'error';
      task.lastError = (r && r.error) || '创建会话失败'; save();
      return { ok: false, error: task.lastError };
    }
    sessionId = r.id;
  }
  let started = false;
  try { started = deps.runChatTurn(sessionId, task.prompt, {}); } catch (e) { task.lastError = e.message; }
  task.lastRunAt = Date.now();
  task.lastSessionId = sessionId;
  task.runCount = (task.runCount || 0) + 1;
  task.lastStatus = started ? 'ok' : 'spawn-failed';
  if (started) task.lastError = '';
  save();
  console.log(`[multicc/cron] fired task ${task.id} (${task.name}) [${reason}] → session ${sessionId} (${reused ? 'reused' : 'new'}), started=${started}`);
  return { ok: started, sessionId };
}

function tick() {
  const now = new Date();
  const key = `${now.getFullYear()}${now.getMonth()}${now.getDate()}${now.getHours()}${now.getMinutes()}`;
  for (const task of tasks) {
    if (!task.enabled) continue;
    const sets = cronParse(task.cron);
    if (!sets) continue;
    if (task._tickKey === key) continue;       // already fired this minute
    if (cronMatch(sets, now)) {
      task._tickKey = key;
      fireTask(task, 'schedule');
    }
  }
}

// ── Serialisation for the API (adds computed fields) ──
function toView(task) {
  const dir = deps && deps.directories.get(task.dirId);
  return {
    id: task.id, name: task.name, dirId: task.dirId,
    dirName: dir ? dir.name : '(已删除)',
    cli: task.cli || 'claude',
    prompt: task.prompt, cron: task.cron, enabled: !!task.enabled,
    createdBy: task.createdBy || 'user', createdAt: task.createdAt,
    lastRunAt: task.lastRunAt || null, lastStatus: task.lastStatus || null,
    lastError: task.lastError || '', lastSessionId: task.lastSessionId || null,
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
  if (body.cli !== undefined) out.cli = (body.cli === 'codex') ? 'codex' : 'claude';
  if (body.prompt !== undefined) out.prompt = String(body.prompt);
  if (body.cron !== undefined) out.cron = String(body.cron).trim();
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.createdBy !== undefined) out.createdBy = String(body.createdBy).slice(0, 80);
  return { ...t, ...out };
}

function validate(t) {
  if (!t.name) return '任务名不能为空';
  if (!t.dirId || !deps.directories.get(t.dirId)) return '目标目录无效';
  if (!t.prompt || !t.prompt.trim()) return 'prompt 不能为空';
  if (!cronValidate(t.cron || '')) return 'cron 表达式无效（需 5 段：分 时 日 月 周）';
  return null;
}

// ── HTTP routes ──
function mount(app) {
  app.get('/api/cron', (req, res) => {
    res.json(tasks.map(toView));
  });

  app.post('/api/cron', (req, res) => {
    const t = sanitizeIncoming(req.body || {});
    if (t.enabled === undefined) t.enabled = true;
    if (!t.cli) t.cli = 'claude';
    const err = validate(t);
    if (err) return res.status(400).json({ error: err });
    t.id = uid();
    t.createdAt = new Date().toISOString();
    if (!t.createdBy) t.createdBy = 'user';
    tasks.push(t);
    save();
    console.log(`[multicc/cron] created task ${t.id} (${t.name}) by ${t.createdBy}, cron="${t.cron}"`);
    res.json(toView(t));
  });

  app.patch('/api/cron/:id', (req, res) => {
    const idx = tasks.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'task not found' });
    const merged = sanitizeIncoming(req.body || {}, tasks[idx]);
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

  app.post('/api/cron/:id/run', (req, res) => {
    const task = tasks.find(x => x.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const r = fireTask(task, 'manual');
    res.json({ ok: r.ok, sessionId: r.sessionId, error: r.error });
  });
}

function init(injected) {
  deps = injected;
  load();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 30000);
  console.log(`[multicc/cron] scheduler started, ${tasks.length} task(s) loaded`);
}

module.exports = { init, mount, cronValidate, cronNext, _fireTask: fireTask };
