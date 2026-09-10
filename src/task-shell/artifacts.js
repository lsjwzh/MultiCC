'use strict';

const { extractArtifactReferences } = require('../artifact-reference');

// The transcript is the historical authority. The registry adds titles and
// publications made before an assistant's final reply. Never sweep a shell's
// other tasks or inherited context into the current task's output list.
function collectTaskArtifacts(entry, registry, exists = () => null) {
  const taskId = entry.task.id, items = new Map();
  const urlOf = ref => `/artifacts/${ref.artifactId}/${ref.relativePath || 'index.html'}`;
  const rows = registry.filter(row => row.kind !== 'service' && typeof row.url === 'string' && row.url.startsWith('/artifacts/'));
  const metadata = new Map();
  for (const row of rows) {
    const ref = extractArtifactReferences(row.url)[0];
    if (ref) metadata.set(urlOf(ref), row);
  }
  function add(ref, ts) {
    const url = urlOf(ref), row = metadata.get(url), previous = items.get(url);
    const date = new Date(Number(ts));
    const createdAt = row?.createdAt || (Number(ts) > 0 && !Number.isNaN(+date) ? date.toISOString() : null);
    const item = { url: row?.url || url, artifactId: ref.artifactId, title: row?.title || ref.relativePath || ref.artifactId,
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
  return { taskId, title: entry.task.title, items: [...items.values()].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.url.localeCompare(b.url)) };
}

function artifactFileExists(artifactId, relativePath) {
  const fs = require('node:fs'), path = require('node:path');
  return require('../artifacts').servedRoots().some(root => {
    try { return fs.statSync(path.join(root, artifactId, relativePath)).isFile(); } catch (_) { return false; }
  });
}

module.exports = { collectTaskArtifacts, artifactFileExists };
