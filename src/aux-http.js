'use strict';

const http = require('http');
const https = require('https');

function anthropicCodec({ model, prompt, systemPrompt }) {
  const body = {
    model,
    max_tokens: 128000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
  return {
    body,
    headers: {
      'anthropic-version': '2023-06-01',
    },
    parse(parsed) {
      return Array.isArray(parsed.content)
        ? parsed.content.filter(block => block.type === 'text').map(block => block.text || '').join(' ')
        : '';
    },
  };
}

function responsesCodec({ model, prompt, systemPrompt }) {
  const body = {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    instructions: systemPrompt || '',
    stream: true,
  };
  return {
    body,
    headers: {},
    parse(parsed) {
      if (parsed.output_text) return parsed.output_text;
      if (!Array.isArray(parsed.output)) return '';
      return parsed.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(item => item.type === 'output_text' || item.type === 'text')
        .map(item => item.text || '')
        .join('');
    },
  };
}

function chatCompletionsCodec({ model, prompt, systemPrompt }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  return {
    body: { model, max_tokens: 128000, messages },
    headers: {},
    parse(parsed) {
      const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message
        ? parsed.choices[0].message.content
        : '';
      if (typeof content === 'string') return content;
      return Array.isArray(content) ? content.map(item => item.text || '').join('') : '';
    },
  };
}

const CODECS = {
  messages: anthropicCodec,
  responses: responsesCodec,
  chat_completions: chatCompletionsCodec,
};

function buildAuxHttpRequest(target, input) {
  const createCodec = CODECS[target && target.wireApi];
  if (!createCodec) throw new Error(`不支持的 Aux wire API：${target && target.wireApi}`);
  const codec = createCodec(input);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${target.apiKey}`,
    ...codec.headers,
  };
  if (target.wireApi === 'messages') headers['x-api-key'] = target.apiKey;
  return { ...codec, headers };
}

function httpError(statusCode, data) {
  let message = `HTTP ${statusCode}`;
  try {
    const parsed = JSON.parse(data);
    return (parsed.error && (parsed.error.message || JSON.stringify(parsed.error)))
      || parsed.message
      || message;
  } catch (_) {
    return `${message}: ${String(data).slice(0, 200).replace(/\n/g, ' ')}`;
  }
}

function executeAuxHttp({ target, model, prompt, systemPrompt, timeoutMs }) {
  if (!model) return Promise.reject(new Error('Aux Provider 没有可用模型'));
  let url;
  try {
    url = new URL(target.url);
  } catch (_) {
    return Promise.reject(new Error(`Aux Provider URL 无效：${target.url || ''}`));
  }

  let request;
  try {
    request = buildAuxHttpRequest(target, { model, prompt, systemPrompt });
  } catch (error) {
    return Promise.reject(error);
  }
  const isHttps = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: request.headers,
    }, (res) => {
      let data = '', bytes = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) {
          const error = new Error('Aux response exceeds size limit');
          finish(error); req.destroy(error); return;
        }
        data += chunk;
      });
      res.on('error', error => finish(error));
      res.on('aborted', () => finish(new Error('Aux response disconnected before completion')));
      res.on('end', () => {
        if (res.statusCode >= 400) return finish(new Error(httpError(res.statusCode, data)));
        try {
          const parsed = target.wireApi === 'responses' && String(res.headers['content-type'] || '').includes('text/event-stream')
            ? parseResponsesStream(data) : JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          if (parsed.status === 'failed' || parsed.status === 'incomplete') throw new Error(`Aux response ${parsed.status}`);
          finish(null, request.parse(parsed));
        } catch (error) { finish(error); }
      });
    });
    req.on('error', error => finish(error));
    timer = setTimeout(() => {
      const error = new Error('timeout');
      finish(error);
      req.destroy(error);
    }, timeoutMs || 120000);
    req.end(JSON.stringify(request.body));
  });
}

function parseResponsesStream(data) {
  let completed;
  for (const event of data.replace(/\r\n/g, '\n').split('\n\n')) {
    const payload = event.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    const value = JSON.parse(payload);
    if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) {
      const error = value.response?.error || value.error;
      throw new Error(error?.message || value.message || `Aux ${value.type}`);
    }
    if (value.type === 'response.completed') completed = value.response;
  }
  if (!completed) throw new Error('Aux Responses stream disconnected before completion');
  return completed;
}

module.exports = { buildAuxHttpRequest, executeAuxHttp, parseResponsesStream };
