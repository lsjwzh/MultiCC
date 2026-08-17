'use strict';

const crypto = require('node:crypto');

const DEFAULT_MAX_CHARS = 12_000;
const MAX_TASK_ID_CHARS = 200;
const MAX_TASK_TITLE_CHARS = 240;
const REDACTED = '[已脱敏]';

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function stableTaskRunId(taskId, clientKey) {
  const normalizedTaskId = String(taskId == null ? '' : taskId).trim();
  const normalizedClientKey = String(clientKey == null ? '' : clientKey).trim();
  if (!normalizedTaskId) throw new TypeError('taskId must be a non-empty string');
  if (!normalizedClientKey) throw new TypeError('clientKey must be a non-empty string');
  const material = JSON.stringify([normalizedTaskId, normalizedClientKey]);
  return `tr_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return JSON.stringify({ type: 'Buffer', data: value.toString('base64') });
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function redactText(value) {
  let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');

  // Native provider session identities must never cross a TaskRun boundary.
  text = text.replace(
    /(["']?)(?:nativeSessionId|cliSessionId)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;，；}]+)/gi,
    '[已脱敏会话标识]',
  );
  text = text.replace(/\b(?:nativeSessionId|cliSessionId)\b/gi, '[已脱敏会话字段]');

  // HTTP authorization schemes and common standalone provider credentials.
  text = text.replace(/\bAuthorization\s*:\s*[^\n]+/gi, `Authorization: ${REDACTED}`);
  text = text.replace(
    /\bAuthorization\s*[:=]?\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{3,}/gi,
    `Authorization: ${REDACTED}`,
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{3,}/gi, `Bearer ${REDACTED}`);
  text = text.replace(/\bBasic\s+[A-Za-z0-9+/=]{6,}/gi, `Basic ${REDACTED}`);
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{12,})\b/g, REDACTED);

  // JSON, dotenv, headers and prose-style key/value credentials.
  const secretKey = '(?:authorization|api[ _-]*key|access[ _-]*token|refresh[ _-]*token|auth[ _-]*token|password|passwd|client[ _-]*secret|secret|token)';
  const secretValue = '(?:"[^"\\n]*"|\'[^\'\\n]*\'|[^\\s,;，；}]+)';
  text = text.replace(
    new RegExp(`(["']?)(${secretKey})\\1\\s*[:=]\\s*${secretValue}`, 'gi'),
    (_match, _quote, key) => `${key}=${REDACTED}`,
  );
  return text;
}

function truncate(value, maxChars) {
  const text = String(value == null ? '' : value);
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1)}…`;
}

function normalizeString(value, maxChars = Infinity) {
  return truncate(redactText(value).trim(), maxChars);
}

function secretKeyName(key) {
  const compact = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return compact === 'authorization'
    || compact === 'nativesessionid'
    || compact === 'clisessionid'
    || compact.includes('apikey')
    || compact.includes('accesstoken')
    || compact.includes('refreshtoken')
    || compact.includes('authtoken')
    || compact.includes('password')
    || compact.includes('passwd')
    || compact.includes('clientsecret')
    || compact === 'secret'
    || compact === 'token';
}

function forbiddenSessionKeyName(key) {
  const compact = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return compact === 'nativesessionid' || compact === 'clisessionid';
}

function sanitizeStructured(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (Buffer.isBuffer(value)) return `[二进制内容 ${value.length} 字节]`;
  if (typeof value !== 'object') return redactText(String(value));
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => sanitizeStructured(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (forbiddenSessionKeyName(key)) continue;
    result[key] = secretKeyName(key) ? REDACTED : sanitizeStructured(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function contentToText(value) {
  if (typeof value === 'string') return normalizeString(value);
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return normalizeString(item);
      if (item && typeof item.text === 'string') return normalizeString(item.text);
      if (item && typeof item.content === 'string') return normalizeString(item.content);
      return stableStringify(sanitizeStructured(item));
    }).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return normalizeString(value.text);
    return stableStringify(sanitizeStructured(value));
  }
  return normalizeString(value);
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return ['user', 'assistant', 'system', 'tool'].includes(role) ? role : 'unknown';
}

function roleLabel(role) {
  return {
    user: '用户',
    assistant: '助手',
    system: '系统',
    tool: '工具',
    unknown: '消息',
  }[role];
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const source = message && typeof message === 'object' ? message : { text: message };
    const text = contentToText(source.text ?? source.content ?? source.body);
    const role = normalizeRole(source.role);
    const ts = normalizeTimestamp(source.ts ?? source.timestamp ?? source.createdAt);
    const id = normalizeString(source.id ?? source.messageId ?? '', 200);
    return {
      id,
      role,
      ts,
      text,
      hash: digest(text),
    };
  }).filter(message => message.text).sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    const idOrder = compareStrings(left.id, right.id);
    if (idOrder !== 0) return idOrder;
    const roleOrder = compareStrings(left.role, right.role);
    if (roleOrder !== 0) return roleOrder;
    return compareStrings(left.hash, right.hash);
  });
}

function artifactContent(artifact) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  for (const key of ['content', 'body', 'text', 'data', 'bytes']) {
    if (artifact[key] !== undefined) return artifact[key];
  }
  return null;
}

function artifactDigest(artifact) {
  const content = artifactContent(artifact);
  if (Buffer.isBuffer(content)) return digest(content);
  if (typeof content === 'string') return digest(content);
  if (content != null) return digest(stableStringify(sanitizeStructured(content)));
  const supplied = artifact && typeof artifact === 'object'
    ? String(artifact.hash || artifact.sha256 || '').trim().toLowerCase()
    : '';
  if (/^(?:sha256:)?[a-f0-9]{64}$/.test(supplied)) {
    return supplied.startsWith('sha256:') ? supplied : `sha256:${supplied}`;
  }
  const source = artifact && typeof artifact === 'object' ? artifact : { value: artifact };
  const reference = {
    id: normalizeString(source.id ?? '', 200),
    name: normalizeString(source.name ?? source.label ?? '', 240),
    path: normalizeString(source.path ?? source.uri ?? '', 500),
    size: Number.isFinite(Number(source.size)) ? Math.max(0, Number(source.size)) : null,
  };
  return digest(stableStringify(reference));
}

function artifactSize(artifact, content) {
  const supplied = Number(artifact && typeof artifact === 'object' ? artifact.size : NaN);
  if (Number.isFinite(supplied) && supplied >= 0) return supplied;
  if (Buffer.isBuffer(content)) return content.length;
  if (typeof content === 'string') return Buffer.byteLength(content);
  return null;
}

function normalizeArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => {
    const source = artifact && typeof artifact === 'object' ? artifact : { name: artifact };
    const content = artifactContent(source);
    const ref = {
      id: normalizeString(source.id ?? source.artifactId ?? '', 200),
      name: normalizeString(source.name ?? source.label ?? '未命名产物', 240),
      hash: artifactDigest(source),
    };
    const mimeType = normalizeString(source.mimeType ?? source.type ?? '', 120);
    const size = artifactSize(source, content);
    if (mimeType) ref.mimeType = mimeType;
    if (size != null) ref.size = size;
    return ref;
  }).sort((left, right) => {
    const idOrder = compareStrings(left.id, right.id);
    if (idOrder !== 0) return idOrder;
    const nameOrder = compareStrings(left.name, right.name);
    if (nameOrder !== 0) return nameOrder;
    return compareStrings(left.hash, right.hash);
  });
}

function renderMessage(message, text = message.text) {
  const indented = text.replace(/\n/g, '\n  ');
  return `- ${roleLabel(message.role)}：${indented}`;
}

function renderHistory(messages, budget) {
  const empty = {
    text: '',
    included: [],
    omitted: messages.length,
    truncated: messages.length > 0,
  };
  if (!messages.length || budget < 24) return empty;
  const heading = '历史对话（按时间，较早内容可能省略）：';
  const render = (selected, omitted) => {
    const lines = [heading];
    if (omitted > 0) lines.push(`- …已省略 ${omitted} 条较早消息`);
    lines.push(...selected.map(item => renderMessage(item.message, item.text)));
    return lines.join('\n');
  };

  let included = [];
  let omitted = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = [{ message: messages[index], text: messages[index].text, partial: false }, ...included];
    const candidateText = render(candidate, index);
    if (candidateText.length > budget) break;
    included = candidate;
    omitted = index;
  }

  if (!included.length) {
    const latest = messages[messages.length - 1];
    omitted = messages.length - 1;
    const shell = render([{ message: latest, text: '', partial: true }], omitted);
    const available = budget - shell.length;
    if (available < 12) return empty;
    included = [{ message: latest, text: truncate(latest.text, available), partial: true }];
  }

  return {
    text: render(included, omitted),
    included,
    omitted,
    truncated: omitted > 0 || included.some(item => item.partial),
  };
}

function renderArtifacts(artifacts, budget) {
  if (!artifacts.length || budget < 40) return { text: '', displayed: 0 };
  const heading = '相关产物（仅列引用，不包含正文）：';
  const lines = [heading];
  let displayed = 0;
  for (const artifact of artifacts) {
    const size = artifact.size == null ? '' : `，${artifact.size} 字节`;
    const line = `- ${artifact.name}（${artifact.hash}${size}）`;
    const omitted = artifacts.length - displayed - 1;
    const suffix = omitted > 0 ? `\n- …另有 ${omitted} 个产物引用` : '';
    if (`${lines.join('\n')}\n${line}${suffix}`.length > budget) break;
    lines.push(line);
    displayed += 1;
  }
  if (!displayed) return { text: '', displayed: 0 };
  const omitted = artifacts.length - displayed;
  if (omitted > 0) lines.push(`- …另有 ${omitted} 个产物引用`);
  return { text: lines.join('\n'), displayed };
}

function normalizeVersion(version) {
  if (version == null || version === '') return 1;
  if (typeof version === 'number' && Number.isFinite(version)) return version;
  return normalizeString(version, 40) || 1;
}

function normalizeBudget(maxChars) {
  const numeric = Number(maxChars);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : DEFAULT_MAX_CHARS;
}

function buildTaskRunContext({
  task,
  messages,
  artifacts = [],
  currentText,
  maxChars = DEFAULT_MAX_CHARS,
  version = 1,
} = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task must be an object');
  const taskId = normalizeString(task.id ?? task.taskId ?? '', MAX_TASK_ID_CHARS);
  const title = normalizeString(task.title ?? task.name ?? '未命名任务', MAX_TASK_TITLE_CHARS);
  if (!taskId) throw new TypeError('task.id must be a non-empty string');
  const normalizedCurrent = normalizeString(currentText);
  if (!normalizedCurrent) throw new TypeError('currentText must be a non-empty string');

  const normalizedVersion = normalizeVersion(version);
  const budget = normalizeBudget(maxChars);
  const normalizedMessages = normalizeMessages(messages);
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const status = normalizeString(task.status ?? '', 40);
  const summary = normalizeString(task.summary ?? task.description ?? '', 4_000);
  const areas = Array.isArray(task.areas)
    ? [...new Set(task.areas.map(area => normalizeString(area, 100)).filter(Boolean))].sort()
    : [];

  const header = `[MultiCC 任务运行上下文 v${normalizedVersion}]`;
  const essentialTaskLines = [`任务：${title}`, `任务 ID：${taskId}`];
  if (status) essentialTaskLines.push(`状态：${status}`);
  let taskSection = essentialTaskLines.join('\n');
  const currentSection = `当前要求：\n${normalizedCurrent}`;
  const essentialText = [header, taskSection, currentSection].join('\n\n');
  let remaining = Math.max(0, budget - essentialText.length);

  const optionalTaskLines = [];
  if (summary && remaining > 16) {
    const allowance = Math.min(1_600, Math.floor(remaining * 0.3));
    if (allowance > 8) optionalTaskLines.push(`摘要：${truncate(summary, allowance - 3)}`);
  }
  if (areas.length && remaining > 16) {
    const allowance = Math.min(500, Math.floor(remaining * 0.1));
    if (allowance > 8) optionalTaskLines.push(`领域：${truncate(areas.join('、'), allowance - 3)}`);
  }
  if (optionalTaskLines.length) taskSection += `\n${optionalTaskLines.join('\n')}`;

  let baseSections = [header, taskSection, currentSection];
  let baseLength = baseSections.join('\n\n').length;
  remaining = Math.max(0, budget - baseLength);
  const artifactBudget = Math.min(2_000, Math.floor(remaining * 0.28));
  const artifactSection = renderArtifacts(normalizedArtifacts, artifactBudget);
  if (artifactSection.text) {
    baseSections = [header, taskSection, artifactSection.text, currentSection];
    baseLength = baseSections.join('\n\n').length;
  }

  const historyBudget = Math.max(0, budget - baseLength - 2);
  const history = renderHistory(normalizedMessages, historyBudget);
  const sections = [header, taskSection];
  if (history.text) sections.push(history.text);
  if (artifactSection.text) sections.push(artifactSection.text);
  sections.push(currentSection);
  const text = sections.join('\n\n');

  const manifest = {
    schema: 'multicc.task-run-context',
    version: normalizedVersion,
    maxChars: budget,
    task: {
      id: taskId,
      title,
      summaryHash: summary ? digest(summary) : null,
    },
    messageCount: normalizedMessages.length,
    history: {
      included: history.included.length,
      omitted: history.omitted,
      truncated: history.truncated,
      refs: history.included.map(item => ({
        id: item.message.id,
        role: item.message.role,
        ts: item.message.ts,
        hash: item.message.hash,
        partial: item.partial,
      })),
    },
    artifacts: normalizedArtifacts,
    artifactDisplayCount: artifactSection.displayed,
    currentTextHash: digest(normalizedCurrent),
  };
  return {
    text,
    manifest,
    hash: digest(stableStringify({ manifest, text })),
  };
}

module.exports = {
  buildTaskRunContext,
  stableTaskRunId,
};
