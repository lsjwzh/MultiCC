'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { atomicWriteJson } = require('../runtime-security');
const { createFcmTransport } = require('./fcm-transport');
const ID = /^[a-zA-Z0-9_-]{16,128}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const TOKEN = /^[a-zA-Z0-9_:\-]{20,4096}$/;
const validToken = value => typeof value === 'string' && TOKEN.test(value);
const MAX_AGE = 45 * 86400000;

function createFcmDevices({ file, transport = createFcmTransport(), write = atomicWriteJson, now = Date.now } = {}) {
  let devices = [];
  let storageError = false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.devices)) throw new Error('invalid');
    devices = data.devices.filter(d => validId(d.id) && validId(d.binding) && validToken(d.token) && Number.isFinite(d.updatedAt));
  } catch (e) { storageError = e.code !== 'ENOENT'; }
  function save(next) {
    if (storageError) throw new Error('FCM_STORAGE_UNAVAILABLE');
    write(file, { version: 1, devices: next }, { mode: 0o600 });
    devices = next;
  }
  function active() { return devices.filter(d => now() - d.updatedAt < MAX_AGE); }
  function status() { return { configured: !!transport.projectId, devices: active().length, storageAvailable: !storageError }; }
  function register(input) {
    const { id, binding, token, projectId } = input || {};
    if (!validId(id) || !validId(binding) || !validToken(token)) return { status: 400, error: 'INVALID_FCM_DEVICE' };
    if (!transport.projectId) return { status: 503, error: 'FCM_NOT_CONFIGURED' };
    if (projectId !== transport.projectId) return { status: 409, error: 'FCM_PROJECT_MISMATCH' };
    const next = active().filter(d => d.id !== id && d.token !== token);
    if (next.length >= 100) return { status: 409, error: 'FCM_DEVICE_LIMIT' };
    next.push({ id, binding, token, locale: input.locale === 'en' ? 'en' : 'zh', updatedAt: now() });
    save(next);
    return { status: 200, ok: true };
  }
  function remove({ id, binding } = {}) {
    if (!validId(id) || !validId(binding)) return { status: 400, error: 'INVALID_FCM_DEVICE' };
    save(devices.filter(d => d.id !== id || d.binding !== binding));
    return { status: 200, ok: true };
  }
  async function send(payload, targetId) {
    if (!transport.projectId || storageError) return { ok: false, accepted: 0, failed: 0, code: 'unavailable' };
    const targets = active().filter(d => !targetId || d.id === targetId);
    let accepted = 0;
    const stale = [];
    const eventId = randomUUID();
    // Bound fan-out to five in flight; one invalid device cannot stop others.
    for (let offset = 0; offset < targets.length; offset += 5) {
      await Promise.all(targets.slice(offset, offset + 5).map(async d => {
        try {
          const p = typeof payload === 'function' ? payload(d) : payload;
          const data = { binding: d.binding, eventId, sessionId: String(p.sessionId || '').slice(0, 160),
            title: String(p.title || 'MultiCC').slice(0, 120), body: String(p.body || '').slice(0, 600) };
          const result = await transport.send(d.token, data);
          if (result.ok) accepted++;
          if (result.code === 'unregistered') stale.push(d);
        } catch (_) {}
      }));
    }
    if (stale.length) {
      // Token refresh may have registered a replacement while sends were in flight.
      try { save(devices.filter(d => !stale.some(old => old.id === d.id && old.token === d.token && old.binding === d.binding))); } catch (_) {}
    }
    return { ok: targets.length > 0 && accepted === targets.length, accepted, failed: targets.length - accepted };
  }
  function mountRoutes(app, guard) {
    // Host global authentication protects all of these endpoints.
    app.get('/api/push/fcm', guard((_req, res) => res.json(status())));
    app.post('/api/push/fcm', guard((req, res) => { const r = register(req.body); return res.status(r.status).json(r); }));
    app.delete('/api/push/fcm', guard((req, res) => { const r = remove(req.body); return res.status(r.status).json(r); }));
    app.post('/api/push/fcm/test', guard(async (req, res) => {
      if (!validId(req.body?.id)) return res.status(400).json({ error: 'INVALID_FCM_DEVICE' });
      const result = await send({ title: 'MultiCC', body: 'FCM test' }, req.body.id);
      return res.status(result.ok ? 200 : 502).json(result);
    }));
  }
  return { status, register, remove, send, mountRoutes, hasEnabled: () => !!transport.projectId && !storageError && active().length > 0 };
}
module.exports = { createFcmDevices };
