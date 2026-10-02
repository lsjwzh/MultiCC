'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { atomicWriteJson } = require('../runtime-security');

class BarkDeviceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function normalizeBarkUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s•]/u.test(value.trim())) {
    throw new BarkDeviceError('invalid_bark_address');
  }
  let url;
  try { url = new URL(value.trim()); } catch (_) { throw new BarkDeviceError('invalid_bark_address'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new BarkDeviceError('invalid_bark_address');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.length || /^(YOUR_KEY|yourkey)$/i.test(segments[0])) throw new BarkDeviceError('invalid_bark_address');
  // Bark's official app may copy a whole example message URL. Retain only its
  // device key. Self-hosted reverse proxies may need their path prefix.
  url.pathname = '/' + (url.hostname === 'api.day.app' ? segments[0] : segments.join('/'));
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function deviceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) {
    throw new BarkDeviceError('invalid_device_name');
  }
  return value.trim();
}

// Resolves only after the Bark server has acknowledged the request. This is
// server acceptance, not evidence that an iPhone displayed the notification.
function deliverBark(url, title, body, link) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(url);
      target.pathname = target.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
      target.searchParams.set('group', 'multicc');
      target.searchParams.set('url', link || '');
    } catch (_) { resolve({ ok: false, error: 'invalid_bark_address' }); return; }
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { finish({ ok: false, error: 'timeout' }); request?.destroy(); }, 8000);
    let request;
    try {
      request = (target.protocol === 'https:' ? https : http).get(target, response => {
        let data = '';
        response.on('data', chunk => {
          data += chunk.toString();
          if (data.length > 65536) { finish({ ok: false, error: 'invalid_response' }); request.destroy(); }
        });
        response.on('error', () => finish({ ok: false, error: 'network_error' }));
        response.on('end', () => {
          let code;
          try { code = JSON.parse(data).code; } catch (_) { /* rejected below */ }
          const ok = response.statusCode >= 200 && response.statusCode < 300 && code === 200;
          finish({ ok, ...(ok ? {} : { error: 'bark_rejected' }) });
        });
      });
      request.on('error', () => finish({ ok: false, error: 'network_error' }));
    } catch (_) { finish({ ok: false, error: 'network_error' }); }
  });
}

function createBarkDevices({ file, getLegacyUrl = () => '', write = atomicWriteJson, deliver = deliverBark }) {
  let state;
  const health = new Map();
  function read() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.devices) || parsed.devices.length > 20 ||
          !parsed.legacy || typeof parsed.legacy !== 'object' ||
          parsed.devices.some(d => typeof d.id !== 'string' || d.id === 'legacy' ||
            typeof d.enabled !== 'boolean' || normalizeBarkUrl(d.url) !== d.url || deviceName(d.name) !== d.name) ||
          new Set(parsed.devices.map(d => d.id)).size !== parsed.devices.length) throw new Error('schema');
      state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new BarkDeviceError('bark_storage_unavailable', 503);
      state = { version: 1, devices: [], legacy: {} };
    }
    return state;
  }
  function commit(next) {
    try { write(file, next); } catch (_) { throw new BarkDeviceError('bark_storage_unavailable', 503); }
    state = next;
  }
  function entries() {
    const current = read();
    const legacy = getLegacyUrl();
    return [
      ...(legacy && !current.legacy.removed ? [{
        id: 'legacy', name: current.legacy.name || '原有手机', url: legacy,
        enabled: current.legacy.enabled !== false, legacy: true,
      }] : []),
      ...current.devices,
    ];
  }
  function list() {
    return entries().map(({ id, name, enabled, legacy, url }) => {
      let origin = '';
      try { origin = new URL(url).origin; } catch (_) { /* legacy invalid config */ }
      return { id, name, enabled, legacy: !!legacy, origin, ...health.get(id) };
    });
  }
  function add(input) {
    const url = normalizeBarkUrl(input.url);
    const name = deviceName(input.name);
    if (entries().some(d => { try { return normalizeBarkUrl(d.url) === url; } catch (_) { return false; } })) {
      throw new BarkDeviceError('device_already_added', 409);
    }
    if (entries().length >= 20) throw new BarkDeviceError('device_limit_reached');
    const device = { id: crypto.randomUUID(), name, url, enabled: true };
    commit({ ...read(), devices: [...read().devices, device] });
    return device.id;
  }
  function update(id, patch) {
    if (!entries().some(d => d.id === id)) throw new BarkDeviceError('device_not_found', 404);
    const changes = {};
    if (Object.hasOwn(patch, 'name')) changes.name = deviceName(patch.name);
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') throw new BarkDeviceError('invalid_enabled');
      changes.enabled = patch.enabled;
    }
    const current = read();
    commit(id === 'legacy' ? { ...current, legacy: { ...current.legacy, ...changes } } : {
      ...current, devices: current.devices.map(d => d.id === id ? { ...d, ...changes } : d),
    });
  }
  function remove(id) {
    if (!entries().some(d => d.id === id)) throw new BarkDeviceError('device_not_found', 404);
    const current = read();
    commit(id === 'legacy' ? { ...current, legacy: { ...current.legacy, removed: true } } : {
      ...current, devices: current.devices.filter(d => d.id !== id),
    });
    health.delete(id);
  }
  async function send(title, body, link, id) {
    const targets = entries().filter(d => id ? d.id === id : d.enabled);
    if (id && !targets.length) throw new BarkDeviceError('device_not_found', 404);
    // Deduplicate a legacy URL and a newly configured destination too.
    const seen = new Set();
    const results = await Promise.all(targets.filter(d => {
      let key = d.url;
      try { key = normalizeBarkUrl(d.url); } catch (_) { /* invalid legacy destination */ }
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(async d => {
      let result;
      try { result = await deliver(normalizeBarkUrl(d.url), title, body, link); }
      catch (_) { result = { ok: false, error: 'delivery_error' }; }
      health.set(d.id, { lastSendTime: Date.now(), lastSuccess: result.ok, lastError: result.error || '' });
      return { id: d.id, ...result };
    }));
    return { ok: results.length > 0 && results.every(r => r.ok), accepted: results.filter(r => r.ok).length, results };
  }
  return { list, add, update, remove, send, hasEnabled: () => entries().some(d => d.enabled) };
}

function mountBarkDeviceRoutes(app, devices, route) {
  const handle = fn => route(async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (!(error instanceof BarkDeviceError)) throw error;
      res.status(error.status).json({ error: error.code });
    }
  });
  app.get('/api/push/bark-devices', handle(async (_req, res) => res.json({ devices: devices.list() })));
  app.post('/api/push/bark-devices', handle(async (req, res) => {
    const input = req.body || {};
    if (input.action === 'add') {
      const id = devices.add(input);
      return res.json({ ok: true, id, devices: devices.list() });
    }
    if (input.action === 'update') devices.update(input.id, input);
    else if (input.action === 'remove') devices.remove(input.id);
    else if (input.action === 'test') {
      if (typeof input.id !== 'string' || !input.id) throw new BarkDeviceError('device_not_found', 404);
      const result = await devices.send('MultiCC 测试提醒', '收到这条通知，说明这台手机可以接收 MultiCC 提醒。', '', input.id);
      return res.status(result.ok ? 200 : 502).json({ ...result, ...(result.ok ? {} : { error: 'bark_test_failed' }) });
    } else throw new BarkDeviceError('invalid_action');
    return res.json({ ok: true, devices: devices.list() });
  }));
}

module.exports = { createBarkDevices, mountBarkDeviceRoutes, normalizeBarkUrl, deliverBark, BarkDeviceError };
