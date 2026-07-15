'use strict';
// Codex Responses↔Chat 协议转换代理 — 端点层（模块 C）。
// 契约：docs/codex-proxy-contract.md
// 转换核心 src/codex-proxy-transform.js 由另一会话实现，这里只 require。

const { responsesToChat, chatStreamToResponses } = require('./codex-proxy-transform');
const { StringDecoder } = require('string_decoder');
const TOML = require('@iarna/toml');

let compatRequestSeq = 0;
const COMPAT_BUSY_RETRY_MAX = 5;
const COMPAT_BUSY_RETRY_DELAYS_MS = [250, 600, 1200, 2200];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientXfBusy(message) {
  return /EngineInternalError:1105|system is busy|try again later|code:\s*10012/i.test(String(message || ''));
}

function setSseHeaders(res) {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function parseSettingsConfig(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function appendEndpoint(baseUrl, endpoint) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith(endpoint) ? clean : clean + endpoint;
}

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const totalInput = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const cached = Number(
    (usage.input_tokens_details && usage.input_tokens_details.cached_tokens)
    || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || usage.cached_input_tokens
    || 0
  );
  const result = {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0),
    cacheWrite: 0,
    cacheRead: Math.max(0, cached),
  };
  return result.inputTokens + result.outputTokens + result.cacheRead > 0 ? result : null;
}

function newResponsesUsageTee(contentType = '') {
  return {
    contentType,
    isSSE: /text\/event-stream/i.test(contentType),
    buffer: '',
    usage: null,
  };
}

function captureResponsesObject(tee, value) {
  if (!value || typeof value !== 'object') return;
  const usage = (value.response && value.response.usage) || value.usage;
  const normalized = normalizeResponsesUsage(usage);
  if (normalized) tee.usage = normalized;
}

function feedResponsesUsage(tee, chunk) {
  const text = typeof chunk === 'string'
    ? chunk
    : (chunk ? Buffer.from(chunk).toString('utf8') : '');
  tee.buffer += text;
  if (!tee.isSSE) return;
  let nl;
  while ((nl = tee.buffer.indexOf('\n')) >= 0) {
    const line = tee.buffer.slice(0, nl).replace(/\r$/, '');
    tee.buffer = tee.buffer.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { captureResponsesObject(tee, JSON.parse(payload)); } catch (_) {}
  }
}

function finalizeResponsesUsage(tee) {
  if (!tee.isSSE && tee.buffer) {
    try { captureResponsesObject(tee, JSON.parse(tee.buffer)); } catch (_) {}
  } else if (tee.isSSE && tee.buffer.trim().startsWith('data:')) {
    try { captureResponsesObject(tee, JSON.parse(tee.buffer.trim().slice(5).trim())); } catch (_) {}
  }
  return tee.usage;
}

function resolveProviderTarget(provider) {
  const cfg = parseSettingsConfig(provider && provider.settingsConfig);
  const auth = cfg.auth || {};
  const proxyTarget = cfg.proxyTarget;
  if (proxyTarget && proxyTarget.baseUrl) {
    return {
      mode: proxyTarget.mode || 'chat-to-responses',
      url: proxyTarget.baseUrl,
      apiKey: proxyTarget.apiKey || auth.OPENAI_API_KEY || '',
    };
  }

  let config;
  try { config = TOML.parse(cfg.config || ''); } catch (error) {
    return { error: `invalid provider config.toml: ${error.message}` };
  }
  const providerName = config.model_provider;
  const providerConfig = providerName && config.model_providers && config.model_providers[providerName];
  const baseUrl = providerConfig && providerConfig.base_url;
  if (!baseUrl) return { error: 'provider has no callable base_url' };
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/codex-proxy\//i.test(baseUrl)) {
    return { error: 'provider base_url points back to codex-proxy without a real upstream target' };
  }

  const wireApi = String(providerConfig.wire_api || 'responses').toLowerCase();
  const isChat = wireApi === 'chat' || wireApi === 'chat_completions';
  let mode = isChat ? 'chat-to-responses' : 'direct-responses';
  try {
    if (!isChat && new URL(baseUrl).hostname === 'maas-coding-api.cn-huabei-1.xf-yun.com') {
      mode = 'responses-compat';
    }
  } catch (_) {}
  const accessToken = auth.tokens && auth.tokens.access_token;
  return {
    mode,
    url: appendEndpoint(baseUrl, isChat ? '/chat/completions' : '/responses'),
    apiKey: auth.OPENAI_API_KEY || accessToken || '',
  };
}

function upstreamHeaders(incoming, apiKey) {
  const headers = { ...incoming };
  for (const key of [
    'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'accept-encoding', 'authorization',
  ]) delete headers[key];
  headers['content-type'] = 'application/json';
  headers.accept = 'text/event-stream';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function reportUsage(context, usage, isStream) {
  if (!usage || !context || !context.sessionId || typeof context.onUsage !== 'function') return;
  try {
    context.onUsage({
      sessionId: context.sessionId,
      role: context.role,
      providerId: context.providerId,
      providerName: context.providerName,
      model: context.model,
      isStream,
      usage,
    });
  } catch (error) {
    console.warn(`[codex-proxy] usage callback failed: ${error.message}`);
  }
}

/**
 * 在 express app 上挂载 codex 协议转换代理端点。
 *   POST /codex-proxy/:providerId/responses
 * @param {import('express').Express} app
 * @param {{ getProvider:(appType:string,id:string)=>any, getPort?:()=>number, onUsage?:(info:any)=>void }} opts
 */
function mountCodexProxy(app, { getProvider, onUsage }) {
  async function handle(req, res, { providerId, sessionId = '', role = 'main' }) {
    if (role !== 'main' && role !== 'sub') {
      return res.status(400).json({ error: `invalid codex proxy role: ${role}` });
    }
    const provider = getProvider('codex', providerId);
    if (!provider) return res.status(404).json({ error: `codex provider not found: ${providerId}` });
    const target = resolveProviderTarget(provider);
    if (target.error) return res.status(400).json({ error: target.error });
    if (!target.apiKey) return res.status(400).json({ error: 'provider has no HTTP credential' });
    const context = {
      providerId,
      providerName: provider.name || providerId,
      sessionId,
      role,
      model: String((req.body && req.body.model) || ''),
      onUsage,
    };
    if (target.mode === 'responses-compat') return proxyResponsesCompat(req, res, target, context);
    if (target.mode === 'direct-responses') return proxyResponsesDirect(req, res, target, context);

    let chatBody;
    try {
      chatBody = responsesToChat(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'responsesToChat failed: ' + e.message });
    }
    if (!chatBody || typeof chatBody !== 'object') {
      return res.status(400).json({ error: 'responsesToChat returned non-object' });
    }
    chatBody.stream = true;

    let upstream;
    try {
      upstream = await fetch(target.url, {
        method: 'POST',
        headers: upstreamHeaders(req.headers, target.apiKey),
        body: JSON.stringify(chatBody),
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      sendFailed(res, `fetch upstream failed: ${msg}`);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      sendFailed(res, `upstream ${upstream.status}: ${String(detail).slice(0, 500)}`);
      return;
    }

    setSseHeaders(res);
    const usageTee = newResponsesUsageTee('text/event-stream');

    const converter = chatStreamToResponses(sse => {
      feedResponsesUsage(usageTee, sse);
      try { res.write(sse); } catch (_) {}
    });

    const reader = upstream.body.getReader();
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let clientClosed = false;
    const markClientClosed = () => {
      if (res.writableEnded) return;
      clientClosed = true;
    };
    req.on('aborted', markClientClosed);
    res.on('close', markClientClosed);

    try {
      while (!clientClosed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.write(value);
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try { converter.pushLine(line); } catch (_) {}
        }
      }
      const tail = decoder.end();
      if (tail) buffer += tail;
      if (buffer.length) {
        try { converter.pushLine(buffer); } catch (_) {}
        buffer = '';
      }
      try { converter.end(); } catch (_) {}
      reportUsage(context, finalizeResponsesUsage(usageTee), true);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      try {
        res.write(`event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { message: 'stream error: ' + msg } },
        })}\n\n`);
      } catch (_) {}
    } finally {
      try { res.end(); } catch (_) {}
    }
  }

  app.post('/codex-proxy/:providerId/:sessionId/:role/responses', (req, res) => handle(req, res, {
    providerId: req.params.providerId,
    sessionId: req.params.sessionId,
    role: req.params.role,
  }));
  // Backward-compatible endpoint for already-materialized provider homes. It has
  // no session/role context, so it forwards correctly but does not bill by role.
  app.post('/codex-proxy/:providerId/responses', (req, res) => handle(req, res, {
    providerId: req.params.providerId,
  }));
}

async function proxyResponsesDirect(req, res, target, context) {
  const body = { ...(req.body || {}), stream: req.body && req.body.stream !== false };
  let upstream;
  try {
    upstream = await fetch(target.url, {
      method: 'POST',
      headers: upstreamHeaders(req.headers, target.apiKey),
      body: JSON.stringify(body),
    });
  } catch (error) {
    return sendFailed(res, `fetch upstream failed: ${error.message}`);
  }
  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try { detail = await upstream.text(); } catch (_) {}
    return sendFailed(res, `upstream ${upstream.status}: ${String(detail).slice(0, 500)}`);
  }

  const contentType = upstream.headers.get('content-type') || 'text/event-stream';
  if (/text\/event-stream/i.test(contentType)) setSseHeaders(res);
  else res.setHeader('content-type', contentType);
  const tee = newResponsesUsageTee(contentType);
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feedResponsesUsage(tee, value);
      res.write(value);
    }
    reportUsage(context, finalizeResponsesUsage(tee), tee.isSSE);
  } catch (error) {
    if (!res.writableEnded) sendFailed(res, `stream error: ${error.message}`);
    return;
  }
  try { res.end(); } catch (_) {}
}

async function proxyResponsesCompat(req, res, target, context) {
  const body = { ...(req.body || {}), stream: true };
  const reqId = `xf-${(++compatRequestSeq).toString(36)}`;
  const startedAt = Date.now();
  console.log(`[codex-proxy] [${reqId}] responses-compat start ${JSON.stringify({
    model: body.model || null,
    inputItems: Array.isArray(body.input) ? body.input.length : null,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    hasPreviousResponseId: !!body.previous_response_id,
    reasoningEffort: body.reasoning && body.reasoning.effort || null,
  })}`);

  let clientClosed = false;
  let currentAborter = null;
  const markClientClosed = (reason) => {
    if (res.writableEnded) return;
    clientClosed = true;
    try { if (currentAborter) currentAborter.abort(); } catch (_) {}
    console.log(`[codex-proxy] [${reqId}] client closed ${reason || 'unknown'}`);
  };
  req.on('aborted', () => markClientClosed('req_aborted'));
  res.on('close', () => markClientClosed('res_close'));

  setSseHeaders(res);

  for (let attempt = 1; attempt <= COMPAT_BUSY_RETRY_MAX; attempt++) {
    const stats = {
      attempt,
      events: 0,
      lines: 0,
      bytes: 0,
      deltas: 0,
      outputDone: 0,
      completedEvents: 0,
      failedEvents: 0,
      injectedCompleted: false,
      upstreamDone: false,
      stopAfterTerminalEvent: false,
      clientClosed: false,
      clientClosedReason: '',
      readError: '',
      failedMessage: '',
      busyRetry: false,
    };
    let upstream;
    const aborter = new AbortController();
    currentAborter = aborter;
    try {
      upstream = await fetch(target.url, {
        method: 'POST',
        headers: upstreamHeaders(req.headers, target.apiKey),
        body: JSON.stringify(body),
        signal: aborter.signal,
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      sendFailed(res, `fetch upstream failed: ${msg}`);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      sendFailed(res, `upstream ${upstream.status}: ${String(detail).slice(0, 500)}`);
      return;
    }

    let completed = false;
    let failed = false;
    let responseMeta = null;
    let usage = null;
    const outputItems = [];
    let currentEvent = '';
    let currentData = [];
    let committed = false;
    let sawOutput = false;
    let retryBusy = false;
    let stopAfterTerminalEvent = false;
    const pendingWrites = [];

    const writeOut = (text) => {
      if (clientClosed) return;
      if (committed) {
        try { res.write(text); } catch (_) {}
      } else {
        pendingWrites.push(text);
      }
    };
    const commit = () => {
      if (committed || clientClosed) return;
      committed = true;
      for (const text of pendingWrites.splice(0)) {
        try { res.write(text); } catch (_) {}
      }
    };

    function trackSseLine(rawLine) {
      const line = String(rawLine || '').replace(/\r$/, '');
      stats.lines++;
      if (!line.trim()) {
        finishTrackedEvent();
        return;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        return;
      }
      if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trimStart());
      }
    }

    function finishTrackedEvent() {
      if (!currentEvent && currentData.length === 0) return;
      const payload = currentData.join('\n');
      let obj = null;
      if (payload && payload !== '[DONE]') {
        try { obj = JSON.parse(payload); } catch (_) {}
      }
      const typ = currentEvent || (obj && obj.type) || '';
      if (typ) stats.events++;
      if (/^response\.(output_|content_part|function_call|reasoning)/.test(typ)) {
        sawOutput = true;
      }
      if (typ === 'response.output_text.delta') stats.deltas++;
      if (typ === 'response.output_text.done') stats.outputDone++;
      if (typ === 'response.completed') { completed = true; stats.completedEvents++; }
      if (typ === 'response.failed' || typ === 'error') {
        failed = true;
        stats.failedEvents++;
        const msg = obj && obj.response && obj.response.error && obj.response.error.message
          ? obj.response.error.message
          : obj && obj.error && obj.error.message
            ? obj.error.message
            : '';
        if (msg && !stats.failedMessage) stats.failedMessage = String(msg).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***').slice(0, 300);
      }
      if (obj && obj.response && typeof obj.response === 'object') {
        responseMeta = { ...(responseMeta || {}), ...obj.response };
        if (obj.response.usage) usage = obj.response.usage;
        if (Array.isArray(obj.response.output)) {
          obj.response.output.forEach((item, idx) => { outputItems[idx] = item; });
        }
      }
      if (obj && obj.item && /^response\.output_item\.(added|done)$/.test(typ)) {
        const idx = Number.isInteger(obj.output_index) ? obj.output_index : outputItems.length;
        outputItems[idx] = obj.item;
      }
      if (sawOutput || completed) {
        commit();
      }
      if (failed) {
        if (!committed && !sawOutput && isTransientXfBusy(stats.failedMessage) && attempt < COMPAT_BUSY_RETRY_MAX) {
          retryBusy = true;
          stats.busyRetry = true;
        } else {
          commit();
        }
      }
      currentEvent = '';
      currentData = [];
    }

    const reader = upstream.body.getReader();
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    try {
      while (!clientClosed) {
        const { done, value } = await reader.read();
        if (done) { stats.upstreamDone = true; break; }
        stats.bytes += value.byteLength;
        buffer += decoder.write(value);
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          trackSseLine(line);
          writeOut(line + '\n');
          if (retryBusy) break;
          if (completed || failed) {
            stopAfterTerminalEvent = true;
            stats.stopAfterTerminalEvent = true;
            break;
          }
        }
        if (retryBusy || stopAfterTerminalEvent) break;
      }
      if (retryBusy || stopAfterTerminalEvent) {
        try { await reader.cancel(); } catch (_) {}
      } else {
        const tail = decoder.end();
        if (tail) buffer += tail;
        if (buffer.length) {
          trackSseLine(buffer);
          writeOut(buffer);
          buffer = '';
        }
      }
      finishTrackedEvent();
      if (retryBusy) {
        console.warn(`[codex-proxy] [${reqId}] upstream busy; retrying attempt ${attempt + 1}/${COMPAT_BUSY_RETRY_MAX}: ${stats.failedMessage}`);
        const delay = COMPAT_BUSY_RETRY_DELAYS_MS[Math.min(attempt - 1, COMPAT_BUSY_RETRY_DELAYS_MS.length - 1)] || 1000;
        await sleep(delay);
        continue;
      }
      if (!clientClosed && !completed && !failed) {
        commit();
        const response = {
          ...(responseMeta || {}),
          id: (responseMeta && responseMeta.id) || `resp_multicc_${Date.now().toString(36)}`,
          object: 'response',
          status: 'completed',
          output: outputItems.filter(Boolean),
        };
        if (usage) response.usage = usage;
        try {
          stats.injectedCompleted = true;
          res.write(`\n\nevent: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response,
          })}\n\n`);
        } catch (_) {}
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      stats.readError = msg;
      if (!clientClosed) {
        commit();
        try {
          res.write(`\n\nevent: response.failed\ndata: ${JSON.stringify({
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'stream error: ' + msg } },
          })}\n\n`);
        } catch (_) {}
      }
    } finally {
      currentAborter = null;
      stats.clientClosed = clientClosed;
      console.log(`[codex-proxy] [${reqId}] responses-compat attempt ${attempt} end ${JSON.stringify({
        durMs: Date.now() - startedAt,
        ...stats,
        completed,
        failed,
      })}`);
    }

    reportUsage(context, normalizeResponsesUsage(usage), true);
    try { res.end(); } catch (_) {}
    return;
  }

  try { res.end(); } catch (_) {}
}

function sendFailed(res, message) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
  }
  res.write(`event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: { status: 'failed', error: { message } },
  })}\n\n`);
  try { res.end(); } catch (_) {}
}

module.exports = {
  mountCodexProxy,
  normalizeResponsesUsage,
  resolveProviderTarget,
};
