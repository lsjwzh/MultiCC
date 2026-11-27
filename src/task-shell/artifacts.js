'use strict';

const { extractArtifactReferences } = require('../native/binding').artifactReference;

// The transcript is the historical authority. The registry adds titles and
// publications made before an assistant's final reply. Never sweep a shell's
// other tasks or inherited context into the current task's output list.
function collectTaskArtifacts(entry, registry, exists = () => null) {
  const taskId = entry.task.id, items = new Map();
  const urlOf = ref => `/artifacts/${ref.artifactId}/${ref.relativePath || 'index.html'}`;
  const rows = registry.filter(row => row.kind !== 'service' && typeof row.url === 'string' && row.url.startsWith('/artifacts/'));
  const metadata = new Map(), retained = new Set();
  for (const row of rows) {
    const ref = extractArtifactReferences(row.url)[0];
    if (ref) {
      metadata.set(urlOf(ref), row);
      if (row.permanent || row.retained) retained.add(ref.artifactId);
    }
  }
  function add(ref, ts) {
    const url = urlOf(ref), row = metadata.get(url), previous = items.get(url);
    const date = new Date(Number(ts));
    const createdAt = row?.createdAt || (Number(ts) > 0 && !Number.isNaN(+date) ? date.toISOString() : null);
    const item = { registryId: row?.id || null, pinned: row?.pinned === true, permanent: row?.permanent === true, retained: retained.has(ref.artifactId), url: row?.url || url, artifactId: ref.artifactId, title: row?.title || ref.relativePath || ref.artifactId,
      kind: row?.kind || (/\.html?$/i.test(url) ? 'page' : 'file'), createdAt,
      expired: exists(ref.artifactId, ref.relativePath || 'index.html') === false };
    if (!previous || String(createdAt || '') > String(previous.createdAt || '')) items.set(url, item);
  }
  for (const message of entry.messages || []) {
    if (message.inherited || message.role !== 'assistant' || (message.taskId && message.taskId !== taskId)) continue;
    // Tool inputs can contain example links; only their successful output is
    // evidence of a publication. Content links are retained even if unregistered.
    const results = (Array.isArray(message.tools) ? message.tools : []).filter(t => t && !t.is_error && !t.isError).map(t => t.result);
    for (const ref of extractArtifactReferences([message.content, ...results])) add(ref, message.ts);
  }
  for (const row of rows) {
    // Older publications lack taskId. Only a dedicated task execution ID is
    // unambiguous; a reused source session ID is not task ownership evidence.
    const legacyOwner = !row.taskId && entry.sessionId === `task-${taskId.replace(/^tsk_/, '')}` && row.sessionId === entry.sessionId;
    if (row.taskId !== taskId && !legacyOwner) continue;
    for (const ref of extractArtifactReferences(row.url)) add(ref);
  }
  return { taskId, sessionId: entry.sessionId, title: entry.task.title, items: [...items.values()].sort((a, b) =>
    (b.permanent ? 2 : b.pinned ? 1 : 0) - (a.permanent ? 2 : a.pinned ? 1 : 0) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.url.localeCompare(b.url)) };
}

function artifactFileExists(artifactId, relativePath) {
  const fs = require('node:fs'), path = require('node:path');
  return require('../native/binding').artifacts.servedRoots().some(root => {
    try { return fs.statSync(path.join(root, artifactId, relativePath)).isFile(); } catch (_) { return false; }
  });
}

// 产物采集要整份解析任务转录（百毫秒级同步 CPU），而两个消费端是 5s/15s 的轮询，且
// web/App/聊天帧常常同时盯着同一个任务。同一任务：进行中的采集合并成一个；完成后的
// 短窗口内直接复用同一份结果。窗口必须盖过最短轮询周期（5s 抖动后约 4.25s 起），否则
// 每一轮都过期重算 —— 多页同开时全局 ~1s 一次请求流，每次都整份重扫转录会把事件循环
// 轮番钉住。取 8s：相邻两轮共享一份，新产物最多迟一轮轮询可见。失败不落缓存。
function createArtifactsMemo(artifacts, { memoMs = 8000, maxEntries = 64 } = {}) {
  const memo = new Map();
  return taskId => {
    const hit = memo.get(taskId);
    if (hit && Date.now() - hit.at < memoMs) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = Promise.resolve(artifacts(taskId)).then(result => {
      entry.at = Date.now(); // TTL 从采集完成时刻起算
      return result;
    }, error => {
      memo.delete(taskId);
      throw error;
    });
    memo.set(taskId, entry);
    if (memo.size > maxEntries) for (const key of memo.keys()) { memo.delete(key); if (memo.size <= maxEntries) break; }
    return entry.promise;
  };
}

module.exports = { collectTaskArtifacts, artifactFileExists, createArtifactsMemo };
