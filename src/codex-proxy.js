'use strict';
// Codex Responses↔Chat 协议转换代理 — 端点层（模块 C）。
// 契约：docs/codex-proxy-contract.md
// 转换核心 src/codex-proxy-transform.js 由另一会话实现，这里只 require。

const { responsesToChat, chatStreamToResponses } = require('./codex-proxy-transform');
const { StringDecoder } = require('string_decoder');

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

/**
 * 在 express app 上挂载 codex 协议转换代理端点。
 *   POST /codex-proxy/:providerId/responses
 * @param {import('express').Express} app
 * @param {{ getProvider:(appType:string,id:string)=>any, getPort:()=>number }} opts
 */
function mountCodexProxy(app, { getProvider, getPort }) {
  app.post('/codex-proxy/:providerId/responses', async (req, res) => {
    const providerId = req.params.providerId;

    // ① 查 provider 配置
    const provider = getProvider('codex', providerId);
    if (!provider) {
      return res.status(404).json({ error: `codex provider not found: ${providerId}` });
    }
    const cfg = (provider.settingsConfig && typeof provider.settingsConfig === 'object')
      ? provider.settingsConfig
      : {};
    const proxyTarget = cfg.proxyTarget;
    if (!proxyTarget || !proxyTarget.baseUrl || !proxyTarget.apiKey) {
      return res.status(400).json({
        error: 'provider has no proxyTarget (baseUrl/apiKey) — not a proxied domestic provider',
      });
    }
    if (proxyTarget.mode === 'responses-compat') {
      return proxyResponsesCompat(req, res, proxyTarget);
    }

    // ② Responses body → Chat body
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

    // ③ fetch 真实 chat/completions（stream）
    let upstream;
    try {
      upstream = await fetch(proxyTarget.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${proxyTarget.apiKey}`,
        },
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

    // ④ Chat SSE → Responses SSE，逐行转发
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const converter = chatStreamToResponses(sse => {
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
  });
}

async function proxyResponsesCompat(req, res, proxyTarget) {
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
      upstream = await fetch(proxyTarget.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${proxyTarget.apiKey}`,
        },
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

module.exports = { mountCodexProxy };
