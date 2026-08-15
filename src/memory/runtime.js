'use strict';

const SESSION_MEMORY_MAX = 8000;
const MEMORY_REVIEW_MAX_MESSAGES = 30;
const MEMORY_TYPES = Object.freeze(['decision', 'gotcha', 'preference', 'todo', 'fact']);
const MEMORY_EVICTION_ORDER = Object.freeze(['todo', 'fact', 'gotcha', 'decision', 'preference']);

function getMemoryEntries(persisted) {
  const memory = persisted?.memory;
  if (!memory) return [];
  if (Array.isArray(memory)) {
    return memory.filter(entry => entry && typeof entry.text === 'string' && entry.text.trim());
  }
  if (typeof memory === 'string' && memory.trim()) {
    return [{ type: 'fact', text: memory.trim(), ts: 0 }];
  }
  return [];
}

function normalizeManualMemory(value, options = {}) {
  const maxLength = options.maxLength ?? SESSION_MEMORY_MAX;
  const now = options.now || Date.now;
  if (value == null) return { entries: null };
  if (Array.isArray(value)) {
    const entries = value
      .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim())
      .map(entry => ({
        type: MEMORY_TYPES.includes(entry.type) ? entry.type : 'fact',
        text: entry.text.trim(),
        ts: entry.ts || now(),
      }));
    const total = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    return total > maxLength
      ? { error: `memory too long (max ${maxLength} chars)` }
      : { entries };
  }
  if (typeof value === 'string' && value.trim()) {
    return value.length > maxLength
      ? { error: `memory too long (max ${maxLength})` }
      : { entries: [{ type: 'fact', text: value.trim(), ts: 0 }] };
  }
  return { entries: null };
}

function memoryEvictionRank(type) {
  const index = MEMORY_EVICTION_ORDER.indexOf(type);
  return index === -1 ? MEMORY_EVICTION_ORDER.length : index;
}

function trimMemoryEntries(entries, maxLength = SESSION_MEMORY_MAX) {
  let totalLength = entries.reduce((sum, entry) => sum + (entry.text || '').length, 0);
  if (totalLength <= maxLength) return entries;
  const sorted = [...entries].sort((left, right) => {
    const rank = memoryEvictionRank(left.type) - memoryEvictionRank(right.type);
    return rank || (left.ts || 0) - (right.ts || 0);
  });
  let cut = 0;
  while (cut < sorted.length && totalLength > maxLength) {
    totalLength -= (sorted[cut].text || '').length;
    cut += 1;
  }
  return sorted.slice(cut);
}

function memorySimilarity(left, right) {
  const a = (left || '').trim().toLowerCase();
  const b = (right || '').trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 40 || b.length < 40) {
    return a.includes(b) || b.includes(a) ? 0.7 : 0;
  }
  const wordsA = new Set(a.split(/[\s,，。；;:：、（）()\[\]]+/).filter(Boolean));
  const wordsB = new Set(b.split(/[\s,，。；;:：、（）()\[\]]+/).filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection += 1;
  return intersection / (wordsA.size + wordsB.size - intersection);
}

function mergeMemoryEntries(prior, fresh) {
  const merged = [...prior];
  for (const entry of fresh) {
    let replaced = false;
    for (let index = 0; index < merged.length; index += 1) {
      if (memorySimilarity(entry.text, merged[index].text) > 0.6) {
        merged[index] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) merged.push(entry);
  }
  return merged;
}

function parseMemoryEntries(raw, options = {}) {
  const scanContent = options.scanContent || (() => false);
  const now = options.now || Date.now;
  let clean = String(raw || '').trim();
  if (!clean || clean === '-' || clean === '—') return [];
  clean = clean.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!clean || clean === '-' || clean === '—') return [];
  const entries = [];
  for (const line of clean.split('\n')) {
    const text = line.trim();
    if (!text || text === '-' || text === '—') continue;
    const match = text.match(/^\[(\w+)\]\s*(.*)$/);
    let type = match ? match[1].toLowerCase() : 'fact';
    const entryText = (match ? match[2] : text).trim();
    if (!MEMORY_TYPES.includes(type)) type = 'fact';
    if (entryText && !scanContent(entryText)) entries.push({ type, text: entryText, ts: now() });
  }
  return entries;
}

function resolveReviewInterval(value) {
  const raw = value == null ? '10' : value;
  return Math.max(0, parseInt(raw === '' ? '10' : raw, 10) || 0);
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[memory-runtime] dependencies are required');
  if (!deps.records || typeof deps.records.get !== 'function') {
    throw new TypeError('[memory-runtime] records.get is required');
  }
  if (!deps.auxQueue || typeof deps.auxQueue.enqueue !== 'function'
      || typeof deps.auxQueue.isUnhealthy !== 'function') {
    throw new TypeError('[memory-runtime] auxQueue is required');
  }
  for (const name of [
    'loadHistory', 'writeAutoFile', 'saveBestEffort', 'scanContent',
    'appendEvent', 'workspaceBroadcast',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`[memory-runtime] ${name} is required`);
  }
  return deps;
}

function createMemoryRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  // Optional by design: tests compose the runtime without the API error host.
  // When present, Aux transport failures (distill/review timeouts, ECONNRESET)
  // are routed through the centralized API error policy so they share the same
  // taxonomy, metrics and provider circuit as turn failures instead of only a
  // console warn line.
  const recordApiError = typeof deps.recordApiError === 'function' ? deps.recordApiError : null;

  function reportAuxFailure(error, sessionId, what) {
    if (!recordApiError) return;
    try {
      recordApiError(
        { source: 'aux_http', provider: 'aux', message: String(error && error.message || `${what} failed`) },
        { source: 'aux_http', provider: 'aux', sessionId },
      );
    } catch (_) {}
  }
  const reviewInterval = resolveReviewInterval(deps.reviewInterval);
  const reviewMaxMessages = deps.reviewMaxMessages ?? MEMORY_REVIEW_MAX_MESSAGES;
  const memoryMaxLength = deps.memoryMaxLength ?? SESSION_MEMORY_MAX;
  const reviewInFlight = new Map();
  const distillPending = new Map();

  function parseEntries(raw) {
    return parseMemoryEntries(raw, { scanContent: deps.scanContent, now });
  }

  function persistMergedMemory(sessionId, fresh, eventDetail) {
    if (!fresh.length) {
      return { updated: false, entries: getMemoryEntries(deps.records.get(sessionId)) };
    }
    const persisted = deps.records.get(sessionId);
    if (!persisted) return { updated: false, entries: [] };
    const merged = trimMemoryEntries(
      mergeMemoryEntries(getMemoryEntries(persisted), fresh),
      memoryMaxLength,
    );
    persisted.memory = merged;
    deps.writeAutoFile(persisted, merged);
    deps.saveBestEffort('runtime.memory-distill');
    const totalLen = merged.reduce((sum, entry) => sum + (entry.text || '').length, 0);
    deps.appendEvent(
      persisted.dirId,
      'memory_updated',
      `${eventDetail}（${merged.length} 条，${totalLen} 字）`,
      sessionId,
    );
    deps.workspaceBroadcast(persisted.dirId, { type: 'memory', sessionId });
    return { updated: true, entries: merged, totalLen };
  }

  function trackPendingDistill(sessionId, promise) {
    const tracked = Promise.resolve(promise)
      .catch(error => {
        logger.warn(`[multicc/memory] pending distill ${sessionId} failed: ${error.message}`);
        reportAuxFailure(error, sessionId, 'pending distill');
        return { updated: false, error: error.message };
      })
      .finally(() => {
        if (distillPending.get(sessionId) === tracked) distillPending.delete(sessionId);
      });
    distillPending.set(sessionId, tracked);
    return tracked;
  }

  function getPendingDistill(sessionId) {
    return distillPending.get(sessionId);
  }

  function distillHistoryIntoMemory(sessionId, messages) {
    const persisted = deps.records.get(sessionId);
    if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') {
      return Promise.resolve({ updated: false });
    }
    const text = (messages || [])
      .filter(message => message && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string' && message.content.trim())
      .map(message => `${message.role === 'user' ? '用户' : '助手'}: ${message.content.trim().slice(0, 2000)}`)
      .join('\n');
    if (text.length < 40) return Promise.resolve({ updated: false });
    const prior = getMemoryEntries(persisted);
    const prompt =
`你是会话记忆提炼器。下面是一段即将被清理/丢弃的对话。请只提炼出「值得长期记住的关键信息」，每条一行，格式为 \`[类型] 内容\`。

类型必须是以下 5 种之一：
- [decision] 确认过的技术决策或方案选择
- [gotcha] 踩过的坑、错误做法与对应的正确做法
- [preference] 用户明确表达的偏好或约束
- [todo] 尚未完成、需后续跟进的事项
- [fact] 关键的技术事实或项目状态

忽略普通的任务过程、寒暄、可重新获得的中间步骤。每条内容精炼（不超过 100 字），动词或名词开头。若这段对话没有任何值得长期记住的，只输出一个减号 "-"。

${prior.length ? `【已有的会话记忆条目（请与新内容合并去重：语义重复的条目只保留信息更完整的一条）】\n${prior.map(entry => `[${entry.type}] ${entry.text}`).join('\n')}\n\n` : ''}【待提炼的对话】
${text.slice(0, 12000)}

请直接输出合并后的所有记忆条目（每行一条），不要解释、不要加标题。`;
    if (deps.auxQueue.isUnhealthy()) {
      return Promise.resolve({ updated: false, skipped: 'aux unhealthy' });
    }
    return deps.auxQueue.enqueue({ type: 'memory_distill', prompt, meta: { sessionId } })
      .then(result => {
        const committed = persistMergedMemory(sessionId, parseEntries(result && result.text), '已提炼会话记忆');
        if (committed.updated) {
          logger.log(`[multicc/memory] distilled ${sessionId}: memory now ${committed.entries.length} entries / ${committed.totalLen} chars`);
        }
        return committed;
      })
      .catch(error => {
        logger.warn(`[multicc/memory] distill ${sessionId} failed: ${error.message}`);
        reportAuxFailure(error, sessionId, 'distill');
        return { updated: false, error: error.message };
      });
  }

  function reviewMessages(sessionId, persisted) {
    const history = deps.loadHistory(sessionId);
    let start = 0;
    if (persisted.memoryReviewCursorId) {
      const cursor = history.findIndex(message => message && message.id === persisted.memoryReviewCursorId);
      if (cursor >= 0) start = cursor + 1;
    }
    return history.slice(start)
      .filter(message => message && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string' && message.content.trim())
      .slice(-reviewMaxMessages);
  }

  function reviewConversationIntoMemory(sessionId) {
    if (reviewInFlight.has(sessionId)) return reviewInFlight.get(sessionId);
    const persisted = deps.records.get(sessionId);
    if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') {
      return Promise.resolve({ updated: false });
    }
    if (deps.auxQueue.isUnhealthy()) {
      return Promise.resolve({ updated: false, skipped: 'aux unhealthy' });
    }
    const messages = reviewMessages(sessionId, persisted);
    if (!messages.length) return Promise.resolve({ updated: false });
    const lastMessageId = messages[messages.length - 1].id || null;
    const transcript = messages.map(message =>
      `${message.role === 'user' ? '用户' : '助手'}: ${message.content.trim().slice(0, 1800)}`
    ).join('\n');
    const prompt =
`你是 MultiCC 的周期记忆复盘器。审查下面最近一段对话，只输出真正值得跨后续对话保留的稳定事实，每条一行，格式为 [类型] 内容。

允许类型：
- [preference] 用户明确且可复用的偏好、沟通方式、工作约束
- [gotcha] 反复可能踩到的环境或工具陷阱，以及正确做法
- [decision] 会长期影响后续工作的已确认方案或约定
- [fact] 稳定的项目/环境事实

不要保存任务进度、已完成工作日志、临时路径、一次性 TODO、普通过程或可轻易重新发现的知识。内容应是陈述性事实，不要写成命令。没有值得保存的内容时只输出 "-"。

【最近对话】
${transcript.slice(0, 12000)}

直接输出条目，不要标题或解释。`;

    const task = deps.auxQueue.enqueue({ type: 'memory_review', prompt, meta: { sessionId } })
      .then(result => {
        const committed = persistMergedMemory(sessionId, parseEntries(result && result.text), '周期记忆复盘');
        const current = deps.records.get(sessionId);
        if (current && lastMessageId) {
          current.memoryReviewCursorId = lastMessageId;
          current.memoryReviewAt = now();
          deps.saveBestEffort('runtime.memory-review-cursor');
        }
        return committed;
      })
      .catch(error => {
        const current = deps.records.get(sessionId);
        if (current) {
          current.memoryReviewTurnCount = Math.max(0, reviewInterval - 1);
          deps.saveBestEffort('runtime.memory-review-retry');
        }
        logger.warn(`[multicc/memory] periodic review ${sessionId} failed: ${error.message}`);
        reportAuxFailure(error, sessionId, 'memory review');
        return { updated: false, error: error.message };
      })
      .finally(() => reviewInFlight.delete(sessionId));
    reviewInFlight.set(sessionId, task);
    return task;
  }

  function maybeSchedulePeriodicMemoryReview(sessionId) {
    if (!reviewInterval) return;
    const persisted = deps.records.get(sessionId);
    if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway'
        || (persisted.kind && persisted.kind !== 'chat')) return;
    persisted.memoryReviewTurnCount = Math.max(0, Number(persisted.memoryReviewTurnCount) || 0) + 1;
    if (persisted.memoryReviewTurnCount < reviewInterval) {
      deps.saveBestEffort('runtime.memory-review-counter');
      return;
    }
    if (deps.auxQueue.isUnhealthy()) {
      persisted.memoryReviewTurnCount = Math.max(0, reviewInterval - 1);
      deps.saveBestEffort('runtime.memory-review-deferred');
      return;
    }
    persisted.memoryReviewTurnCount = 0;
    deps.saveBestEffort('runtime.memory-review-start');
    reviewConversationIntoMemory(sessionId);
  }

  return Object.freeze({
    distillHistoryIntoMemory,
    getPendingDistill,
    maybeSchedulePeriodicMemoryReview,
    reviewConversationIntoMemory,
    trackPendingDistill,
  });
}

module.exports = {
  SESSION_MEMORY_MAX,
  MEMORY_REVIEW_MAX_MESSAGES,
  MEMORY_TYPES,
  MEMORY_EVICTION_ORDER,
  createMemoryRuntime,
  getMemoryEntries,
  memorySimilarity,
  mergeMemoryEntries,
  normalizeManualMemory,
  parseMemoryEntries,
  resolveReviewInterval,
  trimMemoryEntries,
};
