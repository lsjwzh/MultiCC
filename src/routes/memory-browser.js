'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const MEM_GRAPH_MAX_NODES = 600;
const MEM_TREE_MAX_FILES = 2000;
const MEMORY_FILE_MAX_CHARS = 200000;
let atomicWriteCounter = 0;

function assertMemoryBrowserDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('memory browser route dependencies are required');
  }
  const fsMethods = [
    'existsSync',
    'readFileSync',
    'readdirSync',
    'realpathSync',
    'statSync',
    'unlinkSync',
  ];
  for (const name of fsMethods) {
    if (!deps.fs || typeof deps.fs[name] !== 'function') {
      throw new TypeError(`memory browser dependency missing: fs.${name}`);
    }
  }
  const pathMethods = ['basename', 'dirname', 'join', 'relative', 'resolve'];
  for (const name of pathMethods) {
    if (!deps.path || typeof deps.path[name] !== 'function') {
      throw new TypeError(`memory browser dependency missing: path.${name}`);
    }
  }
  if (typeof deps.memoryStoreRoot !== 'string' || !deps.memoryStoreRoot.trim()) {
    throw new TypeError('memory browser dependency missing: memoryStoreRoot');
  }
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('memory browser dependency missing: directories');
  }
  if (!deps.persistedSessions || typeof deps.persistedSessions.get !== 'function') {
    throw new TypeError('memory browser dependency missing: persistedSessions');
  }
  if (typeof deps.workspaceBroadcast !== 'function') {
    throw new TypeError('memory browser dependency missing: workspaceBroadcast');
  }
  if (typeof deps.now !== 'function') {
    throw new TypeError('memory browser dependency missing: now');
  }
  return deps;
}

function assertAppMethod(app, method) {
  if (!app || typeof app[method] !== 'function') {
    throw new TypeError(`Express app.${method} is required`);
  }
}

function publicFailure(prefix, error) {
  const fallback = `${prefix} failed`;
  const message = error && typeof error.message === 'string'
    ? `${fallback}: ${error.message}`
    : fallback;
  return sanitizePublicText(message, fallback);
}

function estimateMemTokens(value) {
  const text = String(value == null ? '' : value);
  if (!text.length) return 0;
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.round(cjk * 1.5 + other / 4));
}

function parseMemoryMarkdown(raw, slug) {
  let body = String(raw == null ? '' : raw);
  const frontmatter = {};
  const match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (match) {
    body = body.slice(match[0].length);
    let inMetadata = false;
    for (const line of match[1].split(/\r?\n/)) {
      const keyValue = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!keyValue) continue;
      const indent = keyValue[1].length;
      const key = keyValue[2];
      const value = keyValue[3].replace(/^["']|["']$/g, '').trim();
      if (key === 'metadata') {
        inMetadata = true;
        continue;
      }
      if (inMetadata && indent > 0) {
        if (key === 'type') frontmatter.metadataType = value;
        continue;
      }
      inMetadata = false;
      if (key === 'name') frontmatter.name = value;
      else if (key === 'title') frontmatter.title = value;
      else if (key === 'description') frontmatter.description = value;
      else if (key === 'type') frontmatter.type = value;
    }
    if (frontmatter.metadataType) frontmatter.type = frontmatter.metadataType;
  }

  let title = frontmatter.title || '';
  if (!title) {
    const heading = /^\s*#\s+(.+?)\s*$/m.exec(body);
    if (heading) title = heading[1].trim();
  }
  if (!title) title = String(slug || '').replace(/[-_]+/g, ' ').trim() || slug;
  title = title.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');

  let summary = frontmatter.description || '';
  if (!summary) {
    for (let paragraph of body.split(/\r?\n{2,}/)) {
      paragraph = paragraph.trim();
      if (!paragraph || /^#/.test(paragraph)) continue;
      const cleaned = paragraph
        .replace(/^>\s?/gm, '')
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
        .replace(/`{1,3}/g, '')
        .replace(/[*_]{1,3}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        summary = cleaned;
        break;
      }
    }
  }
  if (summary.length > 240) summary = `${summary.slice(0, 237)}…`;

  const links = {};
  const linkPattern = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let link;
  while ((link = linkPattern.exec(body))) {
    const target = link[1].trim().replace(/\.md$/i, '');
    if (target) links[target] = (links[target] || 0) + 1;
  }
  return {
    title,
    summary,
    type: (frontmatter.type || '').toLowerCase(),
    links,
  };
}

function memNodeKind(fileName, frontmatterType) {
  if (frontmatterType) return frontmatterType;
  const base = String(fileName).toLowerCase();
  if (base === '_auto.md') return 'auto';
  if (['claude.md', 'agents.md', 'readme.md', 'memory.md'].includes(base)) return 'index';
  return 'note';
}

function createMemoryBrowserRoutes(rawDeps) {
  const deps = assertMemoryBrowserDeps(rawDeps);
  const fs = deps.fs;
  const path = deps.path;
  const root = path.resolve(deps.memoryStoreRoot);
  const maxGraphNodes = Number.isInteger(deps.maxGraphNodes) && deps.maxGraphNodes > 0
    ? deps.maxGraphNodes
    : MEM_GRAPH_MAX_NODES;
  const maxTreeFiles = Number.isInteger(deps.maxTreeFiles) && deps.maxTreeFiles > 0
    ? deps.maxTreeFiles
    : MEM_TREE_MAX_FILES;

  function isInside(base, candidate) {
    return candidate === base || candidate.startsWith(base + path.sep);
  }

  function realRoot() {
    try {
      if (!fs.existsSync(root)) return null;
      return fs.realpathSync(root);
    } catch (_) {
      return null;
    }
  }

  function validateExistingAncestor(candidate, storeRealRoot) {
    let cursor = candidate;
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor || !isInside(root, parent)) return false;
      cursor = parent;
    }
    try {
      return isInside(storeRealRoot, fs.realpathSync(cursor));
    } catch (_) {
      return false;
    }
  }

  function resolveMemoryFilePath(rel) {
    if (!rel || typeof rel !== 'string' || !/\.md$/i.test(rel)) return null;
    const segments = rel.split('/');
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')) {
        return null;
      }
    }
    const resolved = path.resolve(root, rel);
    if (!isInside(root, resolved) || resolved === root) return null;
    const storeRealRoot = realRoot();
    if (!storeRealRoot || !validateExistingAncestor(resolved, storeRealRoot)) return null;
    return resolved;
  }

  function safeScanDirectory(absDir) {
    const resolved = path.resolve(absDir);
    if (!isInside(root, resolved)) return false;
    const storeRealRoot = realRoot();
    if (!storeRealRoot || !fs.existsSync(resolved)) return false;
    try {
      return isInside(storeRealRoot, fs.realpathSync(resolved));
    } catch (_) {
      return false;
    }
  }

  function safeExistingFile(absFile) {
    const resolved = path.resolve(absFile);
    if (!isInside(root, resolved) || !fs.existsSync(resolved)) return false;
    const storeRealRoot = realRoot();
    if (!storeRealRoot) return false;
    try {
      return isInside(storeRealRoot, fs.realpathSync(resolved));
    } catch (_) {
      return false;
    }
  }

  function listStoreProjects() {
    try {
      if (!safeScanDirectory(root)) return [];
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (_) {
      return [];
    }
  }

  function buildMemoryGraph(dirIdFilter) {
    const nodes = [];
    const byId = new Map();
    const slugIndex = new Map();
    const pending = [];
    let truncated = false;

    const addNode = (node) => {
      nodes.push(node);
      byId.set(node.id, node);
      return node;
    };
    const indexSlug = (dirId, slug, id) => {
      if (!slugIndex.has(dirId)) slugIndex.set(dirId, new Map());
      const projectSlugs = slugIndex.get(dirId);
      if (!projectSlugs.has(slug)) projectSlugs.set(slug, []);
      projectSlugs.get(slug).push(id);
    };

    let projectIds = listStoreProjects();
    if (dirIdFilter && dirIdFilter !== 'all') {
      projectIds = projectIds.filter((id) => id === dirIdFilter);
    }
    const projects = [];

    const scanFolder = (absDir, meta) => {
      if (!safeScanDirectory(absDir)) return 0;
      let files;
      try {
        files = fs.readdirSync(absDir).filter((file) => file.toLowerCase().endsWith('.md'));
      } catch (_) {
        return 0;
      }
      let count = 0;
      for (const file of files) {
        if (nodes.length >= maxGraphNodes) {
          truncated = true;
          break;
        }
        const absFile = path.join(absDir, file);
        if (!safeExistingFile(absFile)) continue;
        let raw;
        try {
          raw = fs.readFileSync(absFile, 'utf8');
        } catch (_) {
          continue;
        }
        const slug = file.replace(/\.md$/i, '');
        const parsed = parseMemoryMarkdown(raw, slug);
        const id = `${meta.dirId}::${meta.scope}${meta.sessionId ? `:${meta.sessionId}` : ''}::${slug}`;
        addNode({
          id,
          slug,
          file,
          title: parsed.title,
          summary: parsed.summary || '（无摘要）',
          type: memNodeKind(file, parsed.type),
          scope: meta.scope,
          sessionId: meta.sessionId || null,
          dirId: meta.dirId,
          size: Buffer.byteLength(raw),
          path: absFile,
          rel: path.relative(root, absFile).split(path.sep).join('/'),
          tokens: estimateMemTokens(raw),
          missing: false,
        });
        indexSlug(meta.dirId, slug, id);
        for (const [target, linkCount] of Object.entries(parsed.links)) {
          pending.push({ fromId: id, dirId: meta.dirId, slug: target, count: linkCount });
        }
        count++;
      }
      return count;
    };

    for (const dirId of projectIds) {
      const projectRoot = path.join(root, dirId);
      scanFolder(path.join(projectRoot, '_shared'), { dirId, scope: 'shared' });

      const sessionsRoot = path.join(projectRoot, 'sessions');
      let sessionIds = [];
      try {
        if (safeScanDirectory(sessionsRoot)) {
          sessionIds = fs.readdirSync(sessionsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        }
      } catch (_) {}
      for (const sessionId of sessionIds) {
        scanFolder(path.join(sessionsRoot, sessionId), {
          dirId,
          scope: 'session',
          sessionId,
        });
      }

      const directory = deps.directories.get(dirId);
      const count = nodes.filter((node) => node.dirId === dirId).length;
      if (count > 0 || (directory && directory.name)) {
        projects.push({
          dirId,
          name: (directory && directory.name) || dirId.slice(0, 8),
          count,
        });
      }
    }

    const edgeMap = new Map();
    const missingByKey = new Map();
    const resolveTarget = (fromId, dirId, slug) => {
      const projectSlugs = slugIndex.get(dirId);
      const candidates = projectSlugs && projectSlugs.get(slug);
      if (!candidates || !candidates.length) return null;
      const from = byId.get(fromId);
      if (from && from.sessionId) {
        const sameSession = candidates.find((candidate) => {
          const node = byId.get(candidate);
          return node && node.sessionId === from.sessionId;
        });
        if (sameSession) return sameSession;
      }
      const shared = candidates.find((candidate) => {
        const node = byId.get(candidate);
        return node && node.scope === 'shared';
      });
      return shared || candidates[0];
    };

    for (const link of pending) {
      if (!byId.has(link.fromId)) continue;
      let targetId = resolveTarget(link.fromId, link.dirId, link.slug);
      if (!targetId) {
        const key = `${link.dirId}::${link.slug}`;
        if (missingByKey.has(key)) {
          targetId = missingByKey.get(key);
        } else if (nodes.length < maxGraphNodes) {
          targetId = `${link.dirId}::missing::${link.slug}`;
          addNode({
            id: targetId,
            slug: link.slug,
            file: `${link.slug}.md`,
            title: String(link.slug).replace(/[-_]+/g, ' '),
            summary: '（尚未创建的记忆 · 被引用但文件不存在）',
            type: 'missing',
            scope: 'missing',
            sessionId: null,
            dirId: link.dirId,
            size: 0,
            path: null,
            rel: null,
            tokens: 0,
            missing: true,
          });
          missingByKey.set(key, targetId);
        } else {
          truncated = true;
          continue;
        }
      }
      if (targetId === link.fromId) continue;
      const key = `${link.fromId}\u0000${targetId}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + link.count);
    }

    const edges = [];
    for (const [key, strength] of edgeMap) {
      const [source, target] = key.split('\u0000');
      edges.push({ source, target, type: 'reference', strength });
    }
    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    for (const node of nodes) node.degree = degree.get(node.id) || 0;

    projects.sort((a, b) => b.count - a.count);
    return { nodes, edges, projects, truncated };
  }

  function memTreeFileEntry(absDir, relDir, name) {
    try {
      const abs = path.join(absDir, name);
      if (!safeExistingFile(abs)) return null;
      const raw = fs.readFileSync(abs, 'utf8');
      let mtime = null;
      try {
        mtime = fs.statSync(abs).mtime.toISOString();
      } catch (_) {}
      const parsed = parseMemoryMarkdown(raw, name.replace(/\.md$/i, ''));
      return {
        name,
        rel: `${relDir}/${name}`,
        path: abs,
        size: Buffer.byteLength(raw),
        tokens: estimateMemTokens(raw),
        title: parsed.title || name.replace(/\.md$/i, ''),
        mtime,
      };
    } catch (_) {
      return null;
    }
  }

  function listMemTreeFiles(absDir, relDir, counter) {
    if (!safeScanDirectory(absDir)) return { files: [], tokens: 0 };
    let names;
    try {
      names = fs.readdirSync(absDir)
        .filter((file) => file.toLowerCase().endsWith('.md'))
        .sort();
    } catch (_) {
      return { files: [], tokens: 0 };
    }
    const files = [];
    let tokens = 0;
    for (const name of names) {
      if (counter.n >= maxTreeFiles) {
        counter.truncated = true;
        break;
      }
      const entry = memTreeFileEntry(absDir, relDir, name);
      if (!entry) continue;
      files.push(entry);
      tokens += entry.tokens;
      counter.n++;
    }
    return { files, tokens };
  }

  function buildMemoryTree() {
    const counter = { n: 0, truncated: false };
    const projects = [];
    let sessionCount = 0;

    for (const dirId of listStoreProjects()) {
      const projectRoot = path.join(root, dirId);
      const directory = deps.directories.get(dirId);
      const sharedResult = listMemTreeFiles(
        path.join(projectRoot, '_shared'),
        `${dirId}/_shared`,
        counter,
      );
      const shared = {
        dir: path.join(projectRoot, '_shared'),
        rel: `${dirId}/_shared`,
        tokens: sharedResult.tokens,
        files: sharedResult.files,
      };

      const sessions = [];
      const sessionsRoot = path.join(projectRoot, 'sessions');
      let sessionIds = [];
      try {
        if (safeScanDirectory(sessionsRoot)) {
          sessionIds = fs.readdirSync(sessionsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        }
      } catch (_) {}
      for (const sessionId of sessionIds) {
        const sessionResult = listMemTreeFiles(
          path.join(sessionsRoot, sessionId),
          `${dirId}/sessions/${sessionId}`,
          counter,
        );
        const persisted = deps.persistedSessions.get(sessionId);
        sessions.push({
          sessionId,
          label: persisted && persisted.label ? persisted.label : sessionId,
          cli: (persisted && persisted.cli) || null,
          live: Boolean(persisted),
          dir: path.join(sessionsRoot, sessionId),
          rel: `${dirId}/sessions/${sessionId}`,
          tokens: sessionResult.tokens,
          files: sessionResult.files,
        });
      }
      sessionCount += sessions.length;

      const projectTokens = shared.tokens + sessions.reduce((sum, session) => sum + session.tokens, 0);
      const fileCount = shared.files.length
        + sessions.reduce((sum, session) => sum + session.files.length, 0);
      if (fileCount === 0) continue;
      projects.push({
        dirId,
        name: (directory && directory.name) || dirId.slice(0, 8),
        dirPath: (directory && directory.path) || null,
        tokens: projectTokens,
        fileCount,
        shared,
        sessions,
      });
    }

    projects.sort((a, b) => b.tokens - a.tokens);
    const totals = projects.reduce((accumulator, project) => {
      accumulator.tokens += project.tokens;
      accumulator.files += project.fileCount;
      return accumulator;
    }, { tokens: 0, files: 0 });
    return {
      root,
      projects,
      meta: {
        projectCount: projects.length,
        sessionCount,
        fileCount: totals.files,
        tokenTotal: totals.tokens,
        truncated: counter.truncated,
        maxFiles: maxTreeFiles,
      },
    };
  }

  function fallbackAtomicWriteText(target, content) {
    const required = ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'];
    for (const method of required) {
      if (typeof fs[method] !== 'function') {
        throw new TypeError(`atomic memory write requires fs.${method}`);
      }
    }
    const temp = `${target}.tmp.${process.pid}.${deps.now()}.${atomicWriteCounter++}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temp, target);
      if (typeof fs.chmodSync === 'function') fs.chmodSync(target, 0o600);

      let directoryDescriptor;
      try {
        directoryDescriptor = fs.openSync(path.dirname(target), 'r');
        fs.fsyncSync(directoryDescriptor);
      } catch (error) {
        if (!error || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM'].includes(error.code)) throw error;
      } finally {
        if (directoryDescriptor !== undefined) {
          try { fs.closeSync(directoryDescriptor); } catch (_) {}
        }
      }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) {}
      }
    }
  }

  function writeMemoryFile(target, content) {
    if (typeof deps.atomicWriteText === 'function') {
      return deps.atomicWriteText(target, content, { mode: 0o600, dirMode: 0o700 });
    }
    return fallbackAtomicWriteText(target, content);
  }

  function broadcastMemoryChange(rel) {
    const dirId = String(rel).split('/')[0];
    if (!dirId) return;
    try {
      deps.workspaceBroadcast(dirId, {
        type: 'memory',
        rel,
        scope: String(rel).includes('/_shared/') ? 'shared' : 'own',
      });
    } catch (_) {}
  }

  function mountRoutes(app) {
    for (const method of ['get', 'put', 'delete']) assertAppMethod(app, method);

    app.get('/api/memory/graph', (req, res) => {
      const startedAt = deps.now();
      const dirId = req.query.dirId ? String(req.query.dirId) : 'all';
      let data;
      try {
        data = buildMemoryGraph(dirId);
      } catch (error) {
        return res.status(500).json({ error: publicFailure('graph build', error) });
      }
      return res.json({
        nodes: data.nodes,
        edges: data.edges,
        meta: {
          dirId,
          projects: data.projects,
          nodeCount: data.nodes.length,
          edgeCount: data.edges.length,
          truncated: data.truncated,
          maxNodes: maxGraphNodes,
          durationMs: deps.now() - startedAt,
        },
      });
    });

    app.get('/api/memory/tree', (req, res) => {
      const startedAt = deps.now();
      let data;
      try {
        data = buildMemoryTree();
      } catch (error) {
        return res.status(500).json({ error: publicFailure('tree build', error) });
      }
      data.meta.durationMs = deps.now() - startedAt;
      return res.json(data);
    });

    app.get('/api/memory/file', (req, res) => {
      const rel = req.query.rel ? String(req.query.rel) : '';
      const abs = resolveMemoryFilePath(rel);
      if (!abs) {
        return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
      }
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
      try {
        const content = fs.readFileSync(abs, 'utf8');
        let mtime = null;
        try { mtime = fs.statSync(abs).mtime.toISOString(); } catch (_) {}
        return res.json({
          rel,
          path: abs,
          name: path.basename(abs),
          content,
          size: Buffer.byteLength(content),
          tokens: estimateMemTokens(content),
          mtime,
        });
      } catch (error) {
        return res.status(500).json({ error: publicFailure('read', error) });
      }
    });

    app.put('/api/memory/file', (req, res) => {
      const body = req.body || {};
      const rel = body.rel;
      const content = body.content;
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content (string) required' });
      }
      if (content.length > MEMORY_FILE_MAX_CHARS) {
        return res.status(413).json({ error: 'content too long (max 200000 chars)' });
      }
      const abs = resolveMemoryFilePath(rel);
      if (!abs) {
        return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
      }
      if (!fs.existsSync(path.dirname(abs))) {
        return res.status(400).json({ error: 'parent folder does not exist' });
      }
      try {
        writeMemoryFile(abs, content);
        let mtime = null;
        try { mtime = fs.statSync(abs).mtime.toISOString(); } catch (_) {}
        broadcastMemoryChange(rel);
        return res.json({
          ok: true,
          rel,
          path: abs,
          size: Buffer.byteLength(content),
          tokens: estimateMemTokens(content),
          mtime,
        });
      } catch (error) {
        return res.status(500).json({ error: publicFailure('write', error) });
      }
    });

    app.delete('/api/memory/file', (req, res) => {
      const rel = (req.body && req.body.rel) || req.query.rel;
      const abs = resolveMemoryFilePath(rel);
      if (!abs) {
        return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
      }
      try {
        fs.unlinkSync(abs);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return res.status(500).json({ error: publicFailure('delete', error) });
        }
      }
      broadcastMemoryChange(rel);
      return res.json({ ok: true });
    });
  }

  return Object.freeze({
    buildMemoryGraph,
    buildMemoryTree,
    mountRoutes,
    resolveMemoryFilePath,
  });
}

function mountMemoryBrowserRoutes(app, deps) {
  const routes = createMemoryBrowserRoutes(deps);
  routes.mountRoutes(app);
  return routes;
}

module.exports = {
  MEM_GRAPH_MAX_NODES,
  MEM_TREE_MAX_FILES,
  MEMORY_FILE_MAX_CHARS,
  assertMemoryBrowserDeps,
  createMemoryBrowserRoutes,
  estimateMemTokens,
  memNodeKind,
  mountMemoryBrowserRoutes,
  parseMemoryMarkdown,
  publicFailure,
};
