'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createMemoryBrowserRoutes,
  estimateMemTokens,
} = require('../src/routes/memory-browser');

function createApp() {
  const routes = [];
  const handlers = new Map();
  const app = { routes, handlers };
  for (const method of ['get', 'put', 'delete']) {
    app[method] = (routePath, handler) => {
      const key = `${method.toUpperCase()} ${routePath}`;
      routes.push(key);
      handlers.set(key, handler);
    };
  }
  return app;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    jsonCalls: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.jsonCalls++;
      return this;
    },
  };
}

async function invoke(app, method, routePath, request = {}) {
  const handler = app.handlers.get(`${method} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${routePath}`);
  const response = createResponse();
  await handler({ query: {}, body: {}, params: {}, ...request }, response);
  assert.equal(response.jsonCalls, 1, `${method} ${routePath} must respond once`);
  return response;
}

function tempStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-memory-browser-'));
}

function write(root, rel, content) {
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function createHarness(root, overrides = {}) {
  const broadcasts = [];
  let clock = 1000;
  const deps = {
    fs,
    path,
    memoryStoreRoot: root,
    directories: new Map([
      ['project-a', { id: 'project-a', name: 'Project A', path: '/projects/a' }],
      ['project-b', { id: 'project-b', name: 'Project B', path: '/projects/b' }],
    ]),
    persistedSessions: new Map([
      ['session-a', { id: 'session-a', label: 'Session Alpha', cli: 'codex' }],
    ]),
    workspaceBroadcast(dirId, event) {
      broadcasts.push({ dirId, event });
    },
    now() {
      clock += 7;
      return clock;
    },
    ...overrides,
  };
  const app = createApp();
  const runtime = createMemoryBrowserRoutes(deps);
  runtime.mountRoutes(app);
  return { app, runtime, deps, broadcasts };
}

test('memory browser mounts the complete legacy route surface', () => {
  const root = tempStore();
  try {
    const { app } = createHarness(root);
    assert.deepEqual(app.routes, [
      'GET /api/memory/graph',
      'GET /api/memory/tree',
      'GET /api/memory/file',
      'PUT /api/memory/file',
      'DELETE /api/memory/file',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory graph preserves wikilinks, resolution priority, missing nodes, and metadata', async () => {
  const root = tempStore();
  try {
    write(root, 'project-a/_shared/index.md', [
      '---',
      'title: Shared Index',
      'description: Project memory overview',
      'metadata:',
      '  type: reference',
      '---',
      '# Ignored heading',
      '',
      'See [[Session Note]] and [[Missing Node]] plus [[Missing Node|again]].',
    ].join('\n'));
    write(root, 'project-a/sessions/session-a/Session Note.md', [
      '# Session Note',
      '',
      'A durable note for this session.',
    ].join('\n'));
    write(root, 'project-b/_shared/Session Note.md', '# Wrong Project\n\nMust not resolve cross-project.');

    const { app } = createHarness(root);
    const response = await invoke(app, 'GET', '/api/memory/graph', {
      query: { dirId: 'project-a' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.meta.dirId, 'project-a');
    assert.equal(response.body.meta.nodeCount, 3);
    assert.equal(response.body.meta.edgeCount, 2);
    assert.equal(response.body.meta.maxNodes, 600);
    assert.equal(response.body.meta.truncated, false);
    assert.equal(response.body.meta.durationMs, 7);
    assert.deepEqual(response.body.meta.projects, [
      { dirId: 'project-a', name: 'Project A', count: 2 },
    ]);

    const index = response.body.nodes.find((node) => node.slug === 'index');
    const note = response.body.nodes.find((node) => node.slug === 'Session Note' && !node.missing);
    const missing = response.body.nodes.find((node) => node.slug === 'Missing Node');
    assert.ok(index);
    assert.equal(index.title, 'Shared Index');
    assert.equal(index.summary, 'Project memory overview');
    assert.equal(index.type, 'reference');
    assert.equal(index.scope, 'shared');
    assert.equal(index.rel, 'project-a/_shared/index.md');
    assert.ok(index.tokens > 0);
    assert.ok(note);
    assert.equal(note.sessionId, 'session-a');
    assert.equal(note.dirId, 'project-a');
    assert.ok(missing);
    assert.equal(missing.missing, true);
    assert.equal(missing.path, null);
    assert.equal(missing.type, 'missing');

    const noteEdge = response.body.edges.find((edge) => edge.target === note.id);
    const missingEdge = response.body.edges.find((edge) => edge.target === missing.id);
    assert.deepEqual(noteEdge, {
      source: index.id,
      target: note.id,
      type: 'reference',
      strength: 1,
    });
    assert.deepEqual(missingEdge, {
      source: index.id,
      target: missing.id,
      type: 'reference',
      strength: 2,
    });
    assert.equal(index.degree, 2);
    assert.equal(note.degree, 1);
    assert.equal(missing.degree, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory tree preserves DTOs and enforces one global file cap', async () => {
  const root = tempStore();
  try {
    write(root, 'project-a/_shared/a.md', '# A\n\nalpha');
    write(root, 'project-a/_shared/b.md', '# B\n\nbeta');
    write(root, 'project-a/sessions/session-a/c.md', '# C\n\ngamma');

    const { app } = createHarness(root, { maxTreeFiles: 2 });
    const response = await invoke(app, 'GET', '/api/memory/tree');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.root, root);
    assert.deepEqual(response.body.meta, {
      projectCount: 1,
      sessionCount: 1,
      fileCount: 2,
      tokenTotal: estimateMemTokens('# A\n\nalpha') + estimateMemTokens('# B\n\nbeta'),
      truncated: true,
      maxFiles: 2,
      durationMs: 7,
    });

    const project = response.body.projects[0];
    assert.equal(project.dirId, 'project-a');
    assert.equal(project.name, 'Project A');
    assert.equal(project.dirPath, '/projects/a');
    assert.equal(project.fileCount, 2);
    assert.equal(project.shared.rel, 'project-a/_shared');
    assert.deepEqual(project.shared.files.map((entry) => entry.name), ['a.md', 'b.md']);
    assert.equal(project.shared.files[0].title, 'A');
    assert.equal(project.shared.files[0].rel, 'project-a/_shared/a.md');
    assert.equal(project.shared.files[0].path, path.join(root, 'project-a/_shared/a.md'));
    assert.match(project.shared.files[0].mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(project.sessions[0], {
      sessionId: 'session-a',
      label: 'Session Alpha',
      cli: 'codex',
      live: true,
      dir: path.join(root, 'project-a/sessions/session-a'),
      rel: 'project-a/sessions/session-a',
      tokens: 0,
      files: [],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic file editor reads, atomically writes, broadcasts, and idempotently deletes', async () => {
  const root = tempStore();
  try {
    const rel = 'project-a/_shared/MEMORY.md';
    const target = write(root, rel, '# Before\n\nold');
    const atomicCalls = [];
    const harness = createHarness(root, {
      atomicWriteText(file, content, options) {
        atomicCalls.push({ file, content, options });
        fs.writeFileSync(file, content);
      },
    });

    let response = await invoke(harness.app, 'GET', '/api/memory/file', {
      query: { rel },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.rel, rel);
    assert.equal(response.body.path, target);
    assert.equal(response.body.name, 'MEMORY.md');
    assert.equal(response.body.content, '# Before\n\nold');
    assert.equal(response.body.size, Buffer.byteLength('# Before\n\nold'));
    assert.match(response.body.mtime, /^\d{4}-\d{2}-\d{2}T/);

    const next = '# After\n\n新的记忆';
    response = await invoke(harness.app, 'PUT', '/api/memory/file', {
      body: { rel, content: next },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      rel,
      path: target,
      size: Buffer.byteLength(next),
      tokens: estimateMemTokens(next),
      mtime: fs.statSync(target).mtime.toISOString(),
    });
    assert.equal(fs.readFileSync(target, 'utf8'), next);
    assert.deepEqual(atomicCalls, [{
      file: target,
      content: next,
      options: { mode: 0o600, dirMode: 0o700 },
    }]);
    assert.deepEqual(harness.broadcasts[0], {
      dirId: 'project-a',
      event: { type: 'memory', rel, scope: 'shared' },
    });

    response = await invoke(harness.app, 'DELETE', '/api/memory/file', {
      body: { rel },
    });
    assert.deepEqual(response.body, { ok: true });
    assert.equal(fs.existsSync(target), false);
    assert.equal(harness.broadcasts.length, 2);

    response = await invoke(harness.app, 'DELETE', '/api/memory/file', {
      query: { rel },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(harness.broadcasts.length, 3);

    response = await invoke(harness.app, 'GET', '/api/memory/file', {
      query: { rel },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'file not found' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fallback file writer uses same-directory atomic replace with private mode', async () => {
  const root = tempStore();
  try {
    fs.mkdirSync(path.join(root, 'project-a/_shared'), { recursive: true });
    const rel = 'project-a/_shared/new.md';
    const { app } = createHarness(root);
    const response = await invoke(app, 'PUT', '/api/memory/file', {
      body: { rel, content: '# Atomic\n\nwritten' },
    });
    assert.equal(response.statusCode, 200);
    const target = path.join(root, rel);
    assert.equal(fs.readFileSync(target, 'utf8'), '# Atomic\n\nwritten');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.tmp.')),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file paths reject traversal, invalid shapes, and symbolic-link escapes', async () => {
  const root = tempStore();
  const outside = tempStore();
  try {
    fs.mkdirSync(path.join(root, 'project-a/_shared'), { recursive: true });
    fs.mkdirSync(path.join(root, 'project-a/sessions'), { recursive: true });
    const externalFile = write(outside, 'secret.md', '# External\n\nunchanged');
    const fileLink = path.join(root, 'project-a/_shared/escape.md');
    const directoryLink = path.join(root, 'project-a/sessions/escape');
    fs.symlinkSync(externalFile, fileLink);
    fs.symlinkSync(outside, directoryLink);
    const { app } = createHarness(root);

    for (const rel of [
      '../escape.md',
      'project-a/../escape.md',
      'project-a\\_shared\\escape.md',
      '/absolute.md',
      'project-a/_shared/not-text.txt',
      'project-a//_shared/empty.md',
    ]) {
      const response = await invoke(app, 'GET', '/api/memory/file', { query: { rel } });
      assert.equal(response.statusCode, 400, rel);
    }

    let response = await invoke(app, 'GET', '/api/memory/file', {
      query: { rel: 'project-a/_shared/escape.md' },
    });
    assert.equal(response.statusCode, 400);
    response = await invoke(app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/_shared/escape.md', content: '# overwrite' },
    });
    assert.equal(response.statusCode, 400);
    response = await invoke(app, 'DELETE', '/api/memory/file', {
      body: { rel: 'project-a/_shared/escape.md' },
    });
    assert.equal(response.statusCode, 400);
    response = await invoke(app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/sessions/escape/new.md', content: '# escape' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(fs.readFileSync(externalFile, 'utf8'), '# External\n\nunchanged');
    assert.equal(fs.existsSync(path.join(outside, 'new.md')), false);

    response = await invoke(app, 'GET', '/api/memory/graph');
    assert.equal(response.body.nodes.some((node) => node.file === 'escape.md'), false);
    response = await invoke(app, 'GET', '/api/memory/tree');
    const files = response.body.projects.flatMap((project) => [
      ...project.shared.files,
      ...project.sessions.flatMap((session) => session.files),
    ]);
    assert.equal(files.some((entry) => entry.name === 'escape.md'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('file editor validation and failures preserve status while redacting paths and secrets', async () => {
  const root = tempStore();
  try {
    fs.mkdirSync(path.join(root, 'project-a/_shared'), { recursive: true });
    let harness = createHarness(root, {
      atomicWriteText() {
        throw new Error('/Users/alice/.multicc/memories token=top-secret');
      },
    });

    let response = await invoke(harness.app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/_shared/private.md', content: '# private' },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'write failed' });
    assert.doesNotMatch(JSON.stringify(response.body), /alice|top-secret|\/Users/);

    response = await invoke(harness.app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/missing/private.md', content: '# private' },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: 'parent folder does not exist' });

    response = await invoke(harness.app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/_shared/private.md', content: 123 },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: 'content (string) required' });

    response = await invoke(harness.app, 'PUT', '/api/memory/file', {
      body: { rel: 'project-a/_shared/private.md', content: 'x'.repeat(200001) },
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.body, { error: 'content too long (max 200000 chars)' });

    const target = write(root, 'project-a/_shared/read-error.md', '# readable');
    const failingFs = Object.create(fs);
    failingFs.readFileSync = (file, ...args) => {
      if (file === target) throw new Error('Authorization: Bearer super-secret /private/data');
      return fs.readFileSync(file, ...args);
    };
    harness = createHarness(root, { fs: failingFs });
    response = await invoke(harness.app, 'GET', '/api/memory/file', {
      query: { rel: 'project-a/_shared/read-error.md' },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'read failed' });
    assert.doesNotMatch(JSON.stringify(response.body), /super-secret|private\/data/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 五层扩展（P1）：全局层/任务/技能进图谱与树 ────────────────────────────

test('five-tier graph includes machine/cli/task/skill nodes and cross-tier edges', async t => {
  const root = tempStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '_machine/user-profile.md', '# 用户画像\n用户是跨境卖家。参见 [[claude-pitfalls]]');
  write(root, '_cli/claude/claude-pitfalls.md', '# claude 坑\nuv env 陷阱。');
  write(root, 'project-a/_shared/MEMORY.md', '# 项目公共\n全局事实见 [[user-profile]]。');
  write(root, 'project-a/tasks/tsk_1/decisions.md', '# 决策\n用 SQLite 存任务图。');
  write(root, 'project-a/skills/lark-doc/usage.md', '# lark-doc 用法\n先 auth。');
  write(root, 'project-a/sessions/session-a/CLAUDE.md', '# 会话\n私有。');
  const h = createHarness(root);
  const response = await invoke(h.app, 'GET', '/api/memory/graph', { query: {} });
  const nodes = response.body.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const machine = nodes.find(n => n.scope === 'machine' && n.slug === 'user-profile');
  const cli = nodes.find(n => n.scope === 'cli' && n.slug === 'claude-pitfalls');
  const task = nodes.find(n => n.scope === 'task' && n.slug === 'decisions');
  const skill = nodes.find(n => n.scope === 'skill' && n.slug === 'usage');
  assert.ok(machine && cli && task && skill, 'all new tiers produce nodes');
  assert.equal(machine.dirId, '_machine');
  assert.equal(cli.dirId, '_cli/claude');
  assert.equal(task.sub, 'tsk_1');
  assert.equal(skill.sub, 'lark-doc');
  // 跨层边：project-a 的 shared → machine（wikilink 命中全局层而不是悬空）。
  const sharedNode = nodes.find(n => n.scope === 'shared' && n.slug === 'MEMORY');
  const machineEdge = response.body.edges.find(e =>
    e.source === sharedNode.id && e.target === machine.id);
  assert.ok(machineEdge, 'shared→machine cross-tier edge resolves');
  // machine → cli 也成为边（而不是 missing 节点）。
  const cliEdge = response.body.edges.find(e => e.source === machine.id && e.target === cli.id);
  assert.ok(cliEdge, 'machine→cli cross-tier edge resolves');
  // 不再为可解析到全局层的引用生成 missing 节点。
  assert.equal(nodes.some(n => n.missing && n.slug === 'user-profile'), false);
  // 两个 MEMORY.md（shared 与 task 的 MEMORY 若重名）不撞 id。
  write(root, 'project-a/tasks/tsk_2/MEMORY.md', '# 另一任务的 MEMORY\n内容。');
  const again = await invoke(h.app, 'GET', '/api/memory/graph', { query: {} });
  const ids = again.body.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'node ids stay unique across subs');
});

test('five-tier tree exposes machine/clis/skills/tasks sections', async t => {
  const root = tempStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '_machine/MEMORY.md', '# 全局\n用户身份。');
  write(root, '_cli/codex/MEMORY.md', '# codex\nrollout 全量重放。');
  write(root, 'project-a/_shared/MEMORY.md', '# 公共\n事实。');
  write(root, 'project-a/tasks/tsk_1/decisions.md', '# 决策\nSQLite。');
  write(root, 'project-a/skills/lark-doc/usage.md', '# 用法\nauth。');
  const h = createHarness(root);
  const response = await invoke(h.app, 'GET', '/api/memory/tree');
  const body = response.body;
  assert.equal(body.machine.files.length, 1);
  assert.equal(body.machine.rel, '_machine');
  assert.equal(body.clis.length, 1);
  assert.equal(body.clis[0].cli, 'codex');
  const project = body.projects.find(p => p.dirId === 'project-a');
  assert.equal(project.tasks.length, 1);
  assert.equal(project.tasks[0].taskId, 'tsk_1');
  assert.equal(project.skills.length, 1);
  assert.equal(project.skills[0].skill, 'lark-doc');
  // 全局层文件计入总量。
  assert.ok(body.meta.fileCount >= 5);
  // _machine/_cli 不会被当作项目列出。
  assert.equal(body.projects.some(p => p.dirId === '_machine' || p.dirId === '_cli'), false);
});

test('global-tier file writes broadcast to every registered directory', async t => {
  const root = tempStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '_machine/MEMORY.md', 'x');
  write(root, '_cli/claude/MEMORY.md', 'y');
  write(root, 'project-a/_shared/MEMORY.md', 'z');
  const h = createHarness(root);
  await invoke(h.app, 'PUT', '/api/memory/file', {
    body: { rel: '_machine/MEMORY.md', content: '# 更新的全局记忆\n' },
  });
  const targets = h.broadcasts.filter(b => b.event.scope === 'machine').map(b => b.dirId).sort();
  assert.deepEqual(targets, ['project-a', 'project-b'], 'machine writes fan out to all directories');
  await invoke(h.app, 'PUT', '/api/memory/file', {
    body: { rel: '_cli/claude/MEMORY.md', content: '# claude 记忆\n' },
  });
  assert.ok(h.broadcasts.some(b => b.event.scope === 'cli' && b.dirId === 'project-b'));
  await invoke(h.app, 'PUT', '/api/memory/file', {
    body: { rel: 'project-a/_shared/MEMORY.md', content: '# 项目\n' },
  });
  const sharedTargets = h.broadcasts.filter(b => b.event.scope === 'shared').map(b => b.dirId);
  assert.deepEqual(sharedTargets, ['project-a'], 'project writes stay scoped');
});
