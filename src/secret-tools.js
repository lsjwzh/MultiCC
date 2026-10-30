'use strict';

// Host-side "use a secret without seeing it" tools.
//
// The model names vault entries; this module resolves the values, uses them,
// and scrubs every byte it returns. The router tool runtime never touches a
// value: it receives this module through dependency injection.
//
//   run_with_secrets          run a shell command with the named entries as env
//   http_request_with_secret  send one HTTP request, {{secret:NAME}} substituted
//
// Redaction is exact-match (the value plus its base64 / base64url / URL / JSON
// escaped forms). It stops accidents, not a caller that transforms the value
// before printing it (rev, hex, split, ...).

const fs = require('fs');
const { spawn } = require('child_process');
const secretAudit = require('./secret-audit');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const STRIPPED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'MULTICC_'];

const MAX_SECRETS = 16;
const MAX_COMMAND_LENGTH = 16 * 1024;
const RUN_DEFAULT_TIMEOUT_S = 120;
const RUN_MAX_TIMEOUT_S = 600;
const RUN_COLLECT_CAP = 2 * 1024 * 1024; // raw bytes kept per stream before redaction
const RUN_RETURN_CAP = 128 * 1024; // characters returned per stream after redaction
const KILL_GRACE_MS = 2000;

const HTTP_DEFAULT_TIMEOUT_S = 60;
const HTTP_MAX_TIMEOUT_S = 120;
const HTTP_COLLECT_CAP = 2 * 1024 * 1024;
const HTTP_RETURN_CAP = 256 * 1024;
const HTTP_MAX_BODY = 1024 * 1024;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HTTP_FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TEXTUAL_TYPE_RE = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|x-ndjson))/i;

class SecretToolError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'SecretToolError';
    this.code = code;
    this.statusCode = statusCode;
    this.secretToolError = true;
  }
}

function reject(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new SecretToolError('invalid_arguments', `${key} is not accepted by this tool`);
  }
}

function intInRange(value, field, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SecretToolError('invalid_arguments', `${field} must be an integer in ${min}..${max}`);
  }
  return value;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One pass over the text so a marker can never be re-matched by a short secret.
function createRedactor(secrets) {
  const forms = new Map();
  const add = (form, name) => {
    if (form && !forms.has(form)) forms.set(form, name);
  };
  for (const { name, value } of secrets) {
    add(value, name);
    if (value.length < 6) continue; // derived forms of tiny values would shred output
    const buffer = Buffer.from(value, 'utf8');
    add(buffer.toString('base64'), name);
    add(buffer.toString('base64url'), name);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) add(encoded, name);
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) add(jsonEscaped, name);
  }
  const ordered = [...forms.keys()].sort((a, b) => b.length - a.length);
  const maxLength = ordered.length ? ordered[0].length : 0;
  const pattern = ordered.length ? new RegExp(ordered.map(escapeRegExp).join('|'), 'g') : null;
  const redact = text => {
    const input = String(text == null ? '' : text);
    return pattern ? input.replace(pattern, match => `[REDACTED:${forms.get(match)}]`) : input;
  };
  return { redact, maxLength };
}

// Collect a stream with a hard cap. When the cap cuts the text, also drop the
// last (longest secret - 1) chars: they could be the prefix of a secret.
function createCollector(cap) {
  let text = '';
  let capped = false;
  return {
    push(chunk) {
      if (capped) return;
      text += chunk;
      if (text.length > cap) {
        text = text.slice(0, cap);
        capped = true;
      }
    },
    isCapped: () => capped,
    finish(redactor) {
      const raw = capped && redactor.maxLength > 1 ? text.slice(0, -(redactor.maxLength - 1)) : text;
      return { text: redactor.redact(raw), capped };
    },
  };
}

function clip(text, limit) {
  return text.length > limit ? { text: text.slice(0, limit), clipped: true } : { text, clipped: false };
}

function sanitizedEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (STRIPPED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

function createSecretTools({
  vault,
  resolveSessionCwd = () => null,
  fetchImpl = (...a) => fetch(...a),
  spawnImpl = spawn,
  baseEnv = () => process.env,
} = {}) {
  if (!vault || typeof vault.reveal !== 'function') {
    throw new TypeError('[secret-tools] vault with reveal() is required');
  }

  function resolveSecrets(names) {
    const resolved = [];
    const missing = [];
    for (const name of names) {
      const found = vault.reveal(name);
      const value = found?.entry?.value;
      if (typeof value !== 'string' || value === '') missing.push(name);
      else resolved.push({ name, value });
    }
    if (missing.length) {
      throw new SecretToolError(
        'unknown_secret',
        `vault has no usable entry named: ${missing.join(', ')}. Call list_secrets for the available names.`,
        404,
      );
    }
    return resolved;
  }

  async function runWithSecrets(context, args = {}, options = {}) {
    reject(args, new Set(['secrets', 'command', 'timeout_seconds']));
    if (!Array.isArray(args.secrets) || args.secrets.length < 1 || args.secrets.length > MAX_SECRETS) {
      throw new SecretToolError('invalid_arguments', `secrets must be an array of 1-${MAX_SECRETS} entry names`);
    }
    const names = [...new Set(args.secrets)];
    for (const name of names) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new SecretToolError(
          'invalid_arguments',
          'each secret name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*, max 64); rename legacy entries in the vault first',
        );
      }
    }
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > MAX_COMMAND_LENGTH) {
      throw new SecretToolError('invalid_arguments', `command must be a non-empty string up to ${MAX_COMMAND_LENGTH} characters`);
    }
    const timeoutS = intInRange(args.timeout_seconds, 'timeout_seconds', 1, RUN_MAX_TIMEOUT_S, RUN_DEFAULT_TIMEOUT_S);
    const cwd = resolveSessionCwd(context?.sessionId);
    if (!cwd || !fs.existsSync(cwd)) {
      throw new SecretToolError('cwd_unavailable', 'the session working directory could not be resolved', 409);
    }
    const secrets = resolveSecrets(names);
    const { redact, maxLength } = createRedactor(secrets);
    const redactor = { redact, maxLength };
    const env = sanitizedEnv(baseEnv());
    for (const { name, value } of secrets) env[name] = value;
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

    const startedAt = Date.now();
    return new Promise((resolve, reject2) => {
      const out = createCollector(RUN_COLLECT_CAP);
      const err = createCollector(RUN_COLLECT_CAP);
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killTimer = null;
      let child;
      try {
        child = spawnImpl(shell, ['-c', args.command], {
          cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        });
      } catch (error) {
        reject2(new SecretToolError('spawn_failed', redact(error.message), 500));
        return;
      }
      const killGroup = signal => {
        try { process.kill(-child.pid, signal); } catch (_) {
          try { child.kill(signal); } catch (__) { /* already gone */ }
        }
      };
      const stop = () => {
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutS * 1000);
      const onAbort = () => { aborted = true; stop(); };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener?.('abort', onAbort);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => out.push(chunk));
      child.stderr.on('data', chunk => err.push(chunk));
      child.on('error', error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject2(new SecretToolError('spawn_failed', redact(error.message), 500));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        killGroup('SIGKILL'); // sweep stragglers the command left in its group
        const stdout = out.finish(redactor);
        const stderr = err.finish(redactor);
        const shownOut = clip(stdout.text, RUN_RETURN_CAP);
        const shownErr = clip(stderr.text, RUN_RETURN_CAP);
        resolve({
          ok: true,
          exit_code: code,
          signal: signal || null,
          timed_out: timedOut,
          aborted,
          duration_ms: Date.now() - startedAt,
          stdout: shownOut.text,
          stderr: shownErr.text,
          truncated: {
            stdout: stdout.capped || shownOut.clipped,
            stderr: stderr.capped || shownErr.clipped,
          },
          secrets_used: names,
          note: 'Secret values are replaced by [REDACTED:NAME]. Redaction is exact-match only.',
        });
      });
    });
  }

  function substitute(template, values, transform) {
    return String(template).replace(PLACEHOLDER_RE, (_, name) => transform(values.get(name)));
  }

  function collectPlaceholders(parts) {
    const names = new Set();
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      for (const match of part.matchAll(PLACEHOLDER_RE)) names.add(match[1]);
    }
    return [...names];
  }

  function mapStrings(node, fn) {
    if (typeof node === 'string') return fn(node);
    if (Array.isArray(node)) return node.map(item => mapStrings(item, fn));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(node)) out[key] = mapStrings(value, fn);
      return out;
    }
    return node;
  }

  function jsonStrings(node, acc = []) {
    if (typeof node === 'string') acc.push(node);
    else if (Array.isArray(node)) node.forEach(item => jsonStrings(item, acc));
    else if (node && typeof node === 'object') Object.values(node).forEach(item => jsonStrings(item, acc));
    return acc;
  }

  async function readBody(response, cap) {
    const collector = createCollector(cap);
    if (!response.body) return collector;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(decoder.decode(value, { stream: true }));
      if (collector.isCapped()) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return collector;
  }

  async function httpRequestWithSecret(context, args = {}, options = {}) {
    reject(args, new Set(['method', 'url', 'headers', 'body', 'json', 'timeout_seconds']));
    const method = String(args.method || 'GET').toUpperCase();
    if (!HTTP_METHODS.has(method)) {
      throw new SecretToolError('invalid_arguments', `method must be one of ${[...HTTP_METHODS].join(', ')}`);
    }
    if (typeof args.url !== 'string' || !args.url) throw new SecretToolError('invalid_arguments', 'url is required');
    if (args.body !== undefined && args.json !== undefined) {
      throw new SecretToolError('invalid_arguments', 'pass either body or json, not both');
    }
    if (args.body !== undefined && (typeof args.body !== 'string' || args.body.length > HTTP_MAX_BODY)) {
      throw new SecretToolError('invalid_arguments', `body must be a string up to ${HTTP_MAX_BODY} characters`);
    }
    if (args.json !== undefined && (args.json === null || typeof args.json !== 'object')) {
      throw new SecretToolError('invalid_arguments', 'json must be an object or array');
    }
    if (args.headers !== undefined
        && (args.headers === null || typeof args.headers !== 'object' || Array.isArray(args.headers))) {
      throw new SecretToolError('invalid_arguments', 'headers must be an object of strings');
    }
    const headerTemplates = Object.entries(args.headers || {});
    for (const [key, value] of headerTemplates) {
      if (!HEADER_NAME_RE.test(key) || typeof value !== 'string') {
        throw new SecretToolError('invalid_arguments', `invalid header ${key}`);
      }
      if (HTTP_FORBIDDEN_HEADERS.has(key.toLowerCase())) {
        throw new SecretToolError('invalid_arguments', `header ${key} is managed by the host`);
      }
    }
    const timeoutS = intInRange(args.timeout_seconds, 'timeout_seconds', 1, HTTP_MAX_TIMEOUT_S, HTTP_DEFAULT_TIMEOUT_S);

    const authorityMatch = /^(https?):\/\/([^/?#]*)(.*)$/is.exec(args.url);
    if (!authorityMatch) throw new SecretToolError('invalid_arguments', 'url must start with https:// (or http:// for loopback)');
    if (authorityMatch[2].includes('{{')) {
      throw new SecretToolError('invalid_arguments', 'a secret placeholder is not allowed in the url host');
    }

    const names = collectPlaceholders([
      args.url, args.body, ...headerTemplates.map(([, value]) => value), ...jsonStrings(args.json),
    ]);
    if (!names.length) {
      throw new SecretToolError(
        'no_secret_placeholder',
        'use {{secret:NAME}} in a header value, the url, the body or the json; this tool only exists to send a vault secret',
      );
    }
    if (names.length > MAX_SECRETS) throw new SecretToolError('invalid_arguments', 'too many secret placeholders');
    const secrets = resolveSecrets(names);
    const values = new Map(secrets.map(({ name, value }) => [name, value]));
    const redactor = createRedactor(secrets);

    const finalUrl = substitute(args.url, values, encodeURIComponent);
    let parsed;
    try { parsed = new URL(finalUrl); } catch (_) {
      throw new SecretToolError('invalid_arguments', 'url is not valid');
    }
    if (parsed.username || parsed.password) {
      throw new SecretToolError('invalid_arguments', 'credentials in the url are not allowed; use a header');
    }
    if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new SecretToolError('invalid_arguments', 'plain http is only allowed for loopback hosts');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SecretToolError('invalid_arguments', 'url must be http(s)');
    }

    const headers = {};
    for (const [key, value] of headerTemplates) {
      const substituted = substitute(value, values, v => v);
      if (/[\r\n\0]/.test(substituted)) {
        throw new SecretToolError('invalid_arguments', `header ${key} resolves to a value with control characters`);
      }
      headers[key] = substituted;
    }
    let body;
    if (args.json !== undefined) {
      body = JSON.stringify(mapStrings(args.json, s => substitute(s, values, v => v)));
      if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    } else if (args.body !== undefined) {
      body = substitute(args.body, values, v => v);
    }
    if (body !== undefined && (method === 'GET')) {
      throw new SecretToolError('invalid_arguments', 'GET cannot carry a body');
    }

    const timeoutSignal = AbortSignal.timeout(timeoutS * 1000);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const startedAt = Date.now();
    let response;
    try {
      // redirect: 'manual' — never replay an Authorization header to a new host.
      response = await fetchImpl(parsed.toString(), { method, headers, body, redirect: 'manual', signal });
    } catch (error) {
      const timedOut = timeoutSignal.aborted;
      throw new SecretToolError(
        timedOut ? 'http_timeout' : 'http_request_failed',
        redactor.redact(timedOut ? `no response within ${timeoutS}s` : `${error.message}${error.cause?.message ? `: ${error.cause.message}` : ''}`),
        502,
      );
    }

    const responseHeaders = {};
    for (const [key, value] of response.headers.entries()) responseHeaders[key] = redactor.redact(value);
    const contentType = response.headers.get('content-type') || '';
    const result = {
      ok: true,
      status: response.status,
      status_text: response.statusText || '',
      host: parsed.host,
      duration_ms: Date.now() - startedAt,
      headers: responseHeaders,
      secrets_used: names,
    };
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      result.note = 'Redirect not followed (secrets are never replayed to another URL). Call again with the Location target if intended.';
    }
    if (TEXTUAL_TYPE_RE.test(contentType) || (!contentType && response.status !== 204)) {
      const collector = await readBody(response, HTTP_COLLECT_CAP);
      const finished = collector.finish(redactor);
      const shown = clip(finished.text, HTTP_RETURN_CAP);
      result.body = shown.text;
      result.truncated = finished.capped || shown.clipped;
    } else {
      await response.body?.cancel?.().catch(() => {});
      result.body = '';
      result.body_omitted = `non-text content-type "${contentType || 'unknown'}"`;
    }
    return result;
  }

  const namesForHttp = args => collectPlaceholders([
    args?.url, args?.body, ...Object.values(args?.headers || {}), ...jsonStrings(args?.json),
  ]);
  return {
    namesForHttp,
    runWithSecrets: async (context, args, options) => secretAudit.call('run_with_secrets', { source: 'mcp', ...context },
      args?.secrets, () => runWithSecrets(context, args, options)),
    httpRequestWithSecret: async (context, args, options) => secretAudit.call('http_request_with_secret', { source: 'mcp', ...context },
      namesForHttp(args),
      () => httpRequestWithSecret(context, args, options)),
  };
}

module.exports = {
  createSecretTools,
  createRedactor,
  createCollector,
  SecretToolError,
  PLACEHOLDER_RE,
};
