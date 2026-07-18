'use strict';

// Whitelisted Memory DTOs and the only network boundary for the Memory UI.
// Loaded as a classic script immediately after api-client.js.
(function initMemoryModel(root) {
  if (!root) return;

  const api = root.MultiCCApi;
  const MAX_GRAPH_NODES = 600;
  const MAX_GRAPH_EDGES = 4000;
  const MAX_TREE_FILES = 2000;
  const MAX_FILE_CONTENT = 200000;

  function stringValue(value, max) {
    const text = typeof value === 'string' ? value : '';
    return text.length > max ? text.slice(0, max) : text;
  }
  function numberValue(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(max, Math.max(min, n));
  }
  function booleanValue(value) { return value === true; }
  function arrayValue(value, max) { return Array.isArray(value) ? value.slice(0, max) : []; }

  function normalizeGraphNode(node) {
    const src = node && typeof node === 'object' ? node : {};
    return {
      id: stringValue(src.id, 1000),
      slug: stringValue(src.slug, 500),
      file: stringValue(src.file, 500),
      title: stringValue(src.title, 1000),
      summary: stringValue(src.summary, 4000),
      type: stringValue(src.type, 80),
      scope: stringValue(src.scope, 80),
      sessionId: src.sessionId == null ? null : stringValue(src.sessionId, 500),
      dirId: stringValue(src.dirId, 500),
      size: numberValue(src.size, 0, Number.MAX_SAFE_INTEGER),
      path: src.path == null ? null : stringValue(src.path, 4000),
      rel: src.rel == null ? null : stringValue(src.rel, 2000),
      tokens: numberValue(src.tokens, 0, Number.MAX_SAFE_INTEGER),
      degree: numberValue(src.degree, 0, Number.MAX_SAFE_INTEGER),
      missing: booleanValue(src.missing),
    };
  }
  function normalizeGraphEdge(edge) {
    const src = edge && typeof edge === 'object' ? edge : {};
    return {
      source: stringValue(src.source, 1000),
      target: stringValue(src.target, 1000),
      type: stringValue(src.type, 80),
      strength: numberValue(src.strength, 0, 1000000),
    };
  }
  function normalizeProjectSummary(project) {
    const src = project && typeof project === 'object' ? project : {};
    return {
      dirId: stringValue(src.dirId, 500),
      name: stringValue(src.name, 1000),
      count: numberValue(src.count, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  function normalizeGraphPayload(payload) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const meta = src.meta && typeof src.meta === 'object' ? src.meta : {};
    return {
      nodes: arrayValue(src.nodes, MAX_GRAPH_NODES).map(normalizeGraphNode).filter(node => node.id),
      edges: arrayValue(src.edges, MAX_GRAPH_EDGES).map(normalizeGraphEdge)
        .filter(edge => edge.source && edge.target),
      meta: {
        dirId: stringValue(meta.dirId, 500) || 'all',
        projects: arrayValue(meta.projects, 1000).map(normalizeProjectSummary).filter(project => project.dirId),
        nodeCount: numberValue(meta.nodeCount, 0, Number.MAX_SAFE_INTEGER),
        edgeCount: numberValue(meta.edgeCount, 0, Number.MAX_SAFE_INTEGER),
        truncated: booleanValue(meta.truncated),
        maxNodes: numberValue(meta.maxNodes, 0, MAX_GRAPH_NODES),
        durationMs: numberValue(meta.durationMs, 0, 3600000),
      },
    };
  }

  function normalizeTreeFile(file) {
    const src = file && typeof file === 'object' ? file : {};
    return {
      name: stringValue(src.name, 500),
      rel: stringValue(src.rel, 2000),
      path: stringValue(src.path, 4000),
      size: numberValue(src.size, 0, Number.MAX_SAFE_INTEGER),
      tokens: numberValue(src.tokens, 0, Number.MAX_SAFE_INTEGER),
      title: stringValue(src.title, 1000),
      mtime: src.mtime == null ? null : stringValue(src.mtime, 100),
    };
  }
  function normalizeFiles(value, budget) {
    const limit = Math.max(0, Math.min(MAX_TREE_FILES, budget.remaining));
    const files = arrayValue(value, limit).map(normalizeTreeFile).filter(file => file.rel && file.name);
    budget.remaining -= files.length;
    return files;
  }
  function normalizeTreeGroup(group, budget) {
    const src = group && typeof group === 'object' ? group : {};
    return {
      rel: stringValue(src.rel, 2000),
      tokens: numberValue(src.tokens, 0, Number.MAX_SAFE_INTEGER),
      files: normalizeFiles(src.files, budget),
    };
  }
  function normalizeTreeSession(session, budget) {
    const src = session && typeof session === 'object' ? session : {};
    const group = normalizeTreeGroup(src, budget);
    return {
      sessionId: stringValue(src.sessionId, 500),
      label: stringValue(src.label, 1000),
      cli: src.cli == null ? null : stringValue(src.cli, 80),
      live: booleanValue(src.live),
      rel: group.rel,
      tokens: group.tokens,
      files: group.files,
    };
  }
  function normalizeTreeProject(project, budget) {
    const src = project && typeof project === 'object' ? project : {};
    return {
      dirId: stringValue(src.dirId, 500),
      name: stringValue(src.name, 1000),
      tokens: numberValue(src.tokens, 0, Number.MAX_SAFE_INTEGER),
      fileCount: numberValue(src.fileCount, 0, MAX_TREE_FILES),
      shared: normalizeTreeGroup(src.shared, budget),
      sessions: arrayValue(src.sessions, 2000).map(session => normalizeTreeSession(session, budget)),
    };
  }
  function normalizeTreePayload(payload) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const meta = src.meta && typeof src.meta === 'object' ? src.meta : {};
    const budget = { remaining: MAX_TREE_FILES };
    return {
      projects: arrayValue(src.projects, 1000).map(project => normalizeTreeProject(project, budget)).filter(project => project.dirId),
      meta: {
        projectCount: numberValue(meta.projectCount, 0, 1000),
        sessionCount: numberValue(meta.sessionCount, 0, Number.MAX_SAFE_INTEGER),
        fileCount: numberValue(meta.fileCount, 0, MAX_TREE_FILES),
        tokenTotal: numberValue(meta.tokenTotal, 0, Number.MAX_SAFE_INTEGER),
        truncated: booleanValue(meta.truncated),
        maxFiles: numberValue(meta.maxFiles, 0, MAX_TREE_FILES),
        durationMs: numberValue(meta.durationMs, 0, 3600000),
      },
    };
  }
  function normalizeFilePayload(payload) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const rawContent = typeof src.content === 'string' ? src.content : '';
    const reportedLength = numberValue(src.originalLength, 0, Number.MAX_SAFE_INTEGER);
    const originalLength = Math.max(rawContent.length, reportedLength);
    const contentTruncated = booleanValue(src.contentTruncated) || originalLength > MAX_FILE_CONTENT;
    return {
      rel: stringValue(src.rel, 2000),
      path: stringValue(src.path, 4000),
      name: stringValue(src.name, 500),
      // Keep a bounded preview for rendering, but never hide the fact that the
      // source was larger. The controller treats this payload as read-only so
      // the preview can never overwrite the complete file.
      content: rawContent.slice(0, MAX_FILE_CONTENT),
      originalLength,
      contentTruncated,
      readOnly: booleanValue(src.readOnly) || contentTruncated,
      size: numberValue(src.size, 0, Number.MAX_SAFE_INTEGER),
      tokens: numberValue(src.tokens, 0, Number.MAX_SAFE_INTEGER),
      mtime: src.mtime == null ? null : stringValue(src.mtime, 100),
      ok: src.ok === true,
    };
  }
  function apiMessage(error) {
    if (!api || typeof api.errorDisplay !== 'function') return '请求失败';
    return api.errorDisplay(error).message || '请求失败';
  }
  function apiJson(url, options) {
    if (!api || typeof api.json !== 'function') {
      return Promise.reject(new Error('Memory API client is unavailable'));
    }
    return api.json(url, options);
  }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function loadGraph() {
    return normalizeGraphPayload(await apiJson('/api/memory/graph'));
  }
  async function loadTree() {
    return normalizeTreePayload(await apiJson('/api/memory/tree'));
  }
  async function loadFile(rel) {
    return normalizeFilePayload(await apiJson('/api/memory/file?rel=' + encodeURIComponent(rel)));
  }
  async function saveFile(rel, content) {
    const text = String(content == null ? '' : content);
    if (text.length > MAX_FILE_CONTENT) {
      const error = new Error(`内容超过可安全编辑上限（${MAX_FILE_CONTENT} 字符）`);
      error.code = 'MEMORY_CONTENT_TOO_LARGE';
      error.safeMessage = error.message;
      throw error;
    }
    return normalizeFilePayload(await apiJson('/api/memory/file', {
      method: 'PUT', json: { rel, content: text },
    }));
  }
  async function deleteFile(rel) {
    const result = await apiJson('/api/memory/file', { method: 'DELETE', json: { rel } });
    return { ok: !!(result && result.ok) };
  }

  root.MultiCCMemoryModel = Object.freeze({
    normalizeGraphPayload,
    normalizeTreePayload,
    normalizeFilePayload,
    loadGraph,
    loadTree,
    loadFile,
    saveFile,
    deleteFile,
    errorMessage: apiMessage,
    escapeHtml,
    formatSize,
    MAX_FILE_CONTENT,
  });
})(typeof window !== 'undefined' ? window : null);
