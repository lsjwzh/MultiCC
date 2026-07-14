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
  const body = { model, input: prompt };
  if (systemPrompt) body.instructions = systemPrompt;
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
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: request.headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(httpError(res.statusCode, data)));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          resolve(request.parse(parsed));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(JSON.stringify(request.body));
    req.end();
  });
}

module.exports = { buildAuxHttpRequest, executeAuxHttp };
