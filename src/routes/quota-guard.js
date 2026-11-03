'use strict';

// Quota guard settings API.
//
// GET /api/settings/quota-guard — the thresholds actually in force, the values
//   saved on disk, and which keys an environment variable is overriding.
// PUT /api/settings/quota-guard — validate, write quota-guard.json atomically,
//   and answer with the new effective configuration.
//
// The guard itself (src/quota/quota-guard.js) re-reads the file at most once
// every 5 seconds, so a save needs neither a restart nor any runtime plumbing:
// the next check() already sees it. Nothing here touches the cache or the
// running gate, which is why this route is safe to mount before the runtimes
// that consult the guard are built.
//
// The effective configuration is defaults ⋃ file ⋃ environment, the same order
// of precedence the guard uses. GET therefore reports `envOverrides`: a form
// whose saved value silently loses to an environment variable would look
// broken, so the UI has to be able to say which keys are being overridden.

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS, envConfig, normalizeConfig, readingAgeOf } = require('../quota/quota-guard');

const PERCENT_KEYS = Object.freeze(['fiveHourPercent', 'weeklyPercent', 'monthlyPercent']);
const SCOPES = Object.freeze(['official', 'all']);
const BODY_KEYS = Object.freeze([...PERCENT_KEYS, 'enabled', 'scope', 'maxReadingAgeMs']);

function percentInput(value) {
  if (value == null || value === '') return { error: '必须是 1–100 的数字' };
  const number = Number(value);
  if (!Number.isFinite(number)) return { error: '必须是 1–100 的数字' };
  // 0 would hold every request the moment the account had any reading at all,
  // and is far more likely a half-filled form than an intention; disabling the
  // guard is the explicit way to say that.
  if (number < 1 || number > 100) return { error: '必须在 1–100 之间' };
  return { value: number };
}

// How old a blocking reading may get before the gate releases for a re-read.
// Rejected rather than clamped: below a minute every request would re-ask
// upstream, and "5" is a half-typed form, not an intention.
function readingAgeInput(value) {
  const parsed = readingAgeOf(value);
  if (parsed == null) return { error: '必须是 60000–604800000 之间的毫秒数' };
  return { value: parsed };
}

// The file is the only place these settings live, and a half-written one would
// silently fall back to defaults (the guard treats unreadable as "no file
// config"). tmp + rename keeps readers on either the old or the new bytes.
function writeAtomic(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { /* parent is the data root */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function readSaved(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    // Missing, unreadable or malformed: the guard's own reader behaves the same
    // way, so the API must report the same "nothing saved" state.
    return {};
  }
}

function mountQuotaGuardRoutes(app, { file, env = process.env } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function') {
    throw new TypeError('[quota-guard-routes] an express app is required');
  }
  if (!file) throw new TypeError('[quota-guard-routes] config file path is required');

  function view() {
    const saved = readSaved(file);
    const overrides = envConfig(env);
    const effective = normalizeConfig({ ...DEFAULTS, ...saved, ...overrides });
    return {
      ok: true,
      config: { ...effective },
      saved,
      defaults: { ...DEFAULTS },
      envOverrides: Object.keys(overrides),
      filePath: file,
    };
  }

  app.get('/api/settings/quota-guard', (req, res) => {
    res.json(view());
  });

  app.put('/api/settings/quota-guard', (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const next = { ...readSaved(file) };
    for (const key of PERCENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const parsed = percentInput(body[key]);
      if (parsed.error) return res.status(400).json({ ok: false, error: `${key}: ${parsed.error}` });
      next[key] = parsed.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      if (typeof body.enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled: 必须是布尔值' });
      }
      next.enabled = body.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'scope')) {
      const scope = String(body.scope || '').trim().toLowerCase();
      if (!SCOPES.includes(scope)) {
        return res.status(400).json({ ok: false, error: 'scope: 只能是 official 或 all' });
      }
      next.scope = scope;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'maxReadingAgeMs')) {
      const parsed = readingAgeInput(body.maxReadingAgeMs);
      if (parsed.error) return res.status(400).json({ ok: false, error: `maxReadingAgeMs: ${parsed.error}` });
      next.maxReadingAgeMs = parsed.value;
    }
    if (!BODY_KEYS.some(key => Object.prototype.hasOwnProperty.call(body, key))) {
      return res.status(400).json({ ok: false, error: '没有可保存的设置' });
    }
    try {
      writeAtomic(file, next);
    } catch (error) {
      return res.status(500).json({ ok: false, error: `写入失败：${error.message}` });
    }
    res.json(view());
  });
}

module.exports = { mountQuotaGuardRoutes, percentInput, readingAgeInput, readSaved, writeAtomic };
