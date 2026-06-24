'use strict';
// Codex Responses↔Chat 协议转换代理 — 端点层（模块 C）。
// 契约：docs/codex-proxy-contract.md
// 转换核心 src/codex-proxy-transform.js 由另一会话实现，这里只 require。

const { responsesToChat, chatStreamToResponses } = require('./codex-proxy-transform');
const { StringDecoder } = require('string_decoder');

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
    req.on('close', () => { clientClosed = true; });

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

function sendFailed(res, message) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.write(`event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: { status: 'failed', error: { message } },
  })}\n\n`);
  try { res.end(); } catch (_) {}
}

module.exports = { mountCodexProxy };
