'use strict';

// Composition for the event system: hub + rule engine + routes, wired to the
// real host effects (fs store, http transport, dns, secrets vault, push, chat).
// server.js only calls createEventsHost(...) once and start()/stop().

const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { atomicWriteJson } = require('../runtime-security');
const { createEventHub } = require('./hub');
const { createEventRuleEngine } = require('./engine');
const { mountEventRoutes } = require('./routes');
const { conclusionFromHistory } = require('./envelope');

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error; // corrupt/unreadable: fail closed, do not overwrite with empty rules
  }
}

function postJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

function createEventsHost(deps) {
  const { bus, app, persistedSessions, chatSessions, saveBestEffort, rulesFile, logger } = deps;
  const hub = createEventHub({
    bus, logger,
    dirIdOf: (id) => (persistedSessions.get(id) || {}).dirId,
    conclusionOf: (id) => (deps.loadChatHistory ? conclusionFromHistory(deps.loadChatHistory(id)) : ''),
  });
  const engine = createEventRuleEngine({
    hub, persistedSessions, saveBestEffort, logger,
    store: { read: () => readJsonFile(rulesFile), write: (value) => atomicWriteJson(rulesFile, value) },
    notify: (...args) => deps.notify(...args),
    resolveSecret: (name, context) => { const result = deps.secretsVault.reveal(name, { ...context, source: 'event_webhook' }); return result && result.entry ? result.entry.value : null; },
    lookup: (host) => dns.promises.lookup(host, { all: true }),
    httpPost: postJson,
    allowPrivateWebhooks: process.env.MULTICC_EVENT_WEBHOOK_ALLOW_PRIVATE === '1',
    createSession: (input) => deps.createChatTask(input),
    sessionInfo: (id) => { const record = persistedSessions.get(id); return record ? { dirId: record.dirId, cli: record.cli } : null; },
    injectPrompt: async (sessionId, prompt) => {
      const chat = chatSessions.get(sessionId);
      if (!persistedSessions.has(sessionId)) return { ok: false, code: 'target_missing' };
      if (chat && chat.isStreaming) return { ok: false, code: 'target_busy' };
      if (!deps.admit) { bus.emit('chat:run', sessionId, prompt, { originTrigger: true }); return true; }
      // Await the admission so the run log records what really happened —
      // fire-and-forget logged ok even when every gate refused the prompt.
      try { return await deps.admit(sessionId, prompt, { originTrigger: true }) || { ok: false, code: 'not_admitted' }; }
      catch (error) {
        if (logger && logger.warn) logger.warn('event_inject_admission_failed', { sessionId, error: String(error && error.message || error).slice(0, 120) });
        return { ok: false, code: 'admission_failed' };
      }
    },
  });
  if (app) mountEventRoutes(app, { hub, engine });
  return Object.freeze({
    hub, engine,
    start() { hub.start(); engine.start(); },
    async stop() { engine.stop(); hub.stop(); },
    forgetSession(id) { hub.forgetSession(id); engine.forgetSession(id); },
  });
}

module.exports = { createEventsHost, readJsonFile };
