'use strict';
// Differential run for the twenty session-management routes retired from six
// files:
//
//   GET|HEAD|PUT|DELETE /api/sessions/:id/memory      (session-memory.js)
//   POST                 /api/sessions/:id/memory/action
//   GET|HEAD             /api/sessions/:id/bundle     (session-bundle.js)
//   POST                 /api/sessions/import
//   GET|HEAD             /api/sessions/:id/bundle.zip     (stays in Node)
//   POST                 /api/sessions/import-zip         (stays in Node)
//   DELETE               /api/sessions/:id            (session-lifecycle.js)
//   POST                 /api/sessions/:id/relocate
//   POST                 /api/sessions/:id/restart
//   POST                 /api/sessions/:id/restart-spawn
//   POST                 /api/sessions/:id/vendor-login-terminal (session-create.js)
//   PUT                  /api/directories/:id/role-workers/:presetId
//   POST                 /api/directories/:id/sessions
//   POST                 /api/sessions/:id/notes      (session-meta.js)
//   GET|HEAD             /api/sessions/:id/liveness
//   GET|HEAD             /api/sessions/:id/notes
//   PATCH                /api/sessions/:id            (session-profile.js)
//   POST                 /api/sessions/:id/fork
//
// now answered by native/gateway/src/app/session_routes.rs (rules in
// native/core/src/session_routes.rs). The two binary transports are *not*
// claimed by the front door and keep running in Node — this run proves they are
// forwarded untouched.
//
//   node docs/rust-migration/differential/session-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-session-routes.js) over the scripted world in
// tests/helpers/session-routes-scripted-world.js, behind the same public-session
// access guard server.js mounts on those paths. The Rust front door calls its
// host port (/api/__host/session-routes); the stub Node child mounts the real
// src/routes/session-routes-host.js composition over the same world, so both
// sides read one set of facts.
//
// Side effects are compared too: every semantic call the handlers make on the
// persistence journal, broadcasts, audit log, child processes and git/worktree
// ports is recorded in-process by the oracle and in an NDJSON file by the stub,
// then compared per case in finalize(). A route that answers the same bytes but
// forgets the write (or writes twice) fails.
//
// A coverage guard at the end fails the run unless the corpus actually reached
// the internal-execution-slot 404 (business and OPTIONS), the delete and the two
// restart side-effect sequences, and the two forwarded binary transports. The
// front-door 503 (host unreachable) cannot be produced with a live stub; it is
// pinned by native/gateway/tests/session_routes.rs and the guard reads that file
// to confirm the assertion is still there.
//
// The scripted world needs the Rust addon (the frozen profile module loads the
// core at require time). Export MULTICC_RUST_ADDON / MULTICC_RUST_PREBUILT_DIR
// before running, as with the other addon-backed differentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { main, send, TOKEN } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const T0 = 1700000000000;

let worldPath = '';
let effectsPath = '';
let repoPath = '';
let bag = null;
let upstreamText = '';
const nodeEffects = new Map();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ── scenarios ───────────────────────────────────────────────────────────────

function base(tag) {
  return {
    case: tag,
    records: [],
    directories: [{ id: 'd1', path: '/repo', name: 'Repo', baseBranch: 'main' }],
    sessions: {},
    chats: {},
    invalid: {},
    notes: [],
    files: {},
    answers: {},
  };
}

function record(id, extra = {}) {
  return {
    id, dirId: 'd1', cli: 'claude', kind: 'chat', type: 'chat',
    label: `Label ${id}`, cwd: `/repo/wt/${id}`, createdAt: T0, ...extra,
  };
}

function withRecord(tag, extra = {}, mutate) {
  const world = base(tag);
  world.records = [record(tag, extra)];
  if (mutate) mutate(world);
  return world;
}

function internalWorld(tag) {
  const world = base(tag);
  world.records = [record('slot', { taskExecutionSlot: true })];
  return world;
}

function text(n, ch = 'x') { return ch.repeat(n); }

// Forwarded (Node-served) replies relay status/body/ETag byte-identically, but
// the front door does not re-stamp its own per-hop instrumentation headers on a
// forwarded response. Those four headers are hop metadata, not the route's
// contract, so they are dropped from both sides for the two binary transports.
function dropHopHeaders(view) {
  for (const name of ['vary', 'x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id']) {
    delete view.headers[name];
  }
  return view;
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

let counter = 0;
const pending = [];
const tagsByName = new Map();

function useScenario(scenario) {
  return {
    before(side) {
      if (side.name === 'node') bag.apply(scenario);
      else fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone(bag.effects.calls));
    },
  };
}

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = (typeof buildScenario === 'function' ? buildScenario(tag) : buildScenario) || base(tag);
  scenario.case = tag;
  if (!scenario.answers) scenario.answers = {};
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) hooks[hook] = fn;
  tagsByName.set(name, tag);
  pending.push([name, () => buildRequest(tag), hooks]);
}

// ── corpus ──────────────────────────────────────────────────────────────────

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const post = (url, body = {}, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const put = (url, body = {}, headers = L) => ({
    method: 'PUT', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const patch = (url, body = {}, headers = L) => ({
    method: 'PATCH', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const del = (url, body, headers = L) => {
    if (body === undefined) return { method: 'DELETE', url, headers: { ...headers } };
    const payload = JSON.stringify(body);
    return {
      method: 'DELETE', url,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    };
  };

  // ── OPTIONS: Allow of every cluster-owned path ─────────────────────────
  add('OPTIONS memory unions every verb', () => options('/api/sessions/s1/memory'));
  add('OPTIONS memory action is POST only', () => options('/api/sessions/s1/memory/action'));
  add('OPTIONS bundle is a read', () => options('/api/sessions/s1/bundle'));
  // The literal also matches the app's `/api/sessions/:id` shape, so Express
  // unions every layer registered there: session-admin GET/HEAD, profile PATCH,
  // bundle POST, lifecycle DELETE.
  add('OPTIONS import unions the whole app', () => options('/api/sessions/import'));
  add('OPTIONS relocate is POST only', () => options('/api/sessions/s1/relocate'));
  add('OPTIONS restart is POST only', () => options('/api/sessions/s1/restart'));
  add('OPTIONS restart-spawn is POST only', () => options('/api/sessions/s1/restart-spawn'));
  add('OPTIONS vendor login is POST only', () => options('/api/sessions/s1/vendor-login-terminal'));
  add('OPTIONS notes unions POST then GET', () => options('/api/sessions/s1/notes'));
  add('OPTIONS liveness is a read', () => options('/api/sessions/s1/liveness'));
  add('OPTIONS fork is POST only', () => options('/api/sessions/s1/fork'));
  add('OPTIONS role workers is PUT only', () => options('/api/directories/d1/role-workers/p1'));
  add('OPTIONS directory sessions unions GET and POST', () => options('/api/directories/d1/sessions'));
  add('OPTIONS session shape unions GET HEAD PATCH DELETE', () => options('/api/sessions/s1'));
  add('OPTIONS forwarded bundle.zip', () => options('/api/sessions/s1/bundle.zip'), null, { normalize: dropHopHeaders });
  // Same literal/`:id` collision as `/api/sessions/import`; the POST itself is
  // forwarded to Node, but the preflight is the whole-app union.
  add('OPTIONS forwarded import-zip unions the whole app', () => options('/api/sessions/import-zip'), null, { normalize: dropHopHeaders });

  // ── internal execution slot: 404 before any handler, and before OPTIONS ─
  add('GET memory internal slot', () => get('/api/sessions/slot/memory'), internalWorld);
  add('PUT memory internal slot',
    () => put('/api/sessions/slot/memory', { name: 'a.md', content: 'x' }), internalWorld);
  add('POST memory action internal slot',
    () => post('/api/sessions/slot/memory/action', { scope: 'own', action: 'add', content: 'x' }), internalWorld);
  add('GET bundle internal slot', () => get('/api/sessions/slot/bundle?passphrase=secret1'), internalWorld);
  add('DELETE session internal slot', () => del('/api/sessions/slot'), internalWorld);
  add('PATCH session internal slot', () => patch('/api/sessions/slot', { label: 'x' }), internalWorld);
  add('POST notes internal slot',
    () => post('/api/sessions/slot/notes', { toSessionId: 'b', body: 'x' }), internalWorld);
  add('GET liveness internal slot', () => get('/api/sessions/slot/liveness'), internalWorld);
  add('POST fork internal slot', () => post('/api/sessions/slot/fork', {}), internalWorld);
  add('OPTIONS memory internal slot', () => options('/api/sessions/slot/memory'), internalWorld);

  // ── GET /api/sessions/:id/memory ───────────────────────────────────────
  add('memory read projects every scope',
    tag => get(`/api/sessions/${tag}/memory`),
    tag => withRecord(tag, { taskState: { taskId: 'tk-1' } }, (world) => {
      world.files = {
        [`/mem/session/${tag}/own`]: { 'CLAUDE.md': '# own', 'notes.md': 'n' },
        '/mem/shared/d1': { 'shared.md': 's' },
        '/mem/machine': { 'machine.md': 'm' },
        '/mem/cli/claude': { 'cli.md': 'c' },
        '/mem/task/d1/tk-1': { 'task.md': 't' },
      };
      world.memoryEntries = { [tag]: [{ type: 'fact', text: 'remembered', ts: 1 }] };
    }));
  add('memory read of an unknown session',
    () => get('/api/sessions/nope/memory'), tag => base(tag));
  add('memory read answers HEAD',
    tag => head(`/api/sessions/${tag}/memory`), tag => withRecord(tag));
  add('memory read rejects a malformed id escape',
    () => get('/api/sessions/%E0%A4%A/memory'), tag => base(tag));

  // ── PUT /api/sessions/:id/memory ───────────────────────────────────────
  add('memory write stores a plain markdown file',
    tag => put(`/api/sessions/${tag}/memory`, { scope: 'own', name: 'note.md', content: 'hello' }),
    tag => withRecord(tag));
  add('memory write into the shared scope',
    tag => put(`/api/sessions/${tag}/memory`, { scope: 'shared', name: 'team.md', content: 'x' }),
    tag => withRecord(tag));
  add('memory write rejects a traversal name',
    tag => put(`/api/sessions/${tag}/memory`, { scope: 'own', name: '../evil.md', content: 'x' }),
    tag => withRecord(tag));
  add('memory write rejects over-long content',
    tag => put(`/api/sessions/${tag}/memory`, { scope: 'own', name: 'big.md', content: text(40001) }),
    tag => withRecord(tag));
  add('memory write rejects a threat payload',
    tag => put(`/api/sessions/${tag}/memory`, { scope: 'own', name: 'x.md', content: 'THREAT here' }),
    tag => withRecord(tag));
  add('memory write of an unknown session',
    () => put('/api/sessions/nope/memory', { name: 'x.md', content: 'x' }), tag => base(tag));

  // ── DELETE /api/sessions/:id/memory ────────────────────────────────────
  add('memory delete removes an existing file',
    tag => del(`/api/sessions/${tag}/memory`, { scope: 'own', name: 'gone.md' }),
    tag => withRecord(tag, {}, (world) => { world.files = { [`/mem/session/${tag}/own`]: { 'gone.md': 'x' } }; }));
  add('memory delete tolerates a missing file',
    tag => del(`/api/sessions/${tag}/memory`, { scope: 'own', name: 'missing.md' }),
    tag => withRecord(tag));
  add('memory delete rejects a traversal name',
    tag => del(`/api/sessions/${tag}/memory`, { scope: 'own', name: '../x.md' }),
    tag => withRecord(tag));

  // ── POST /api/sessions/:id/memory/action ───────────────────────────────
  add('memory action appends a curated entry',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'own', action: 'add', content: 'fact' }),
    tag => withRecord(tag));
  add('memory action broadcasts machine scope to every directory',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'machine', action: 'add', content: 'fact' }),
    tag => withRecord(tag, {}, (world) => {
      world.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
    }));
  add('memory action rejects a system session',
    () => post('/api/sessions/aux1/memory/action', { scope: 'own', action: 'add', content: 'x' }),
    (tag) => { const world = base(tag); world.records = [record('aux1', { type: 'aux' })]; return world; });

  add('memory action rejects an unknown scope',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'galaxy', action: 'add', content: 'x' }),
    tag => withRecord(tag));
  add('memory action needs a bound task for the task scope',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'task', action: 'add', content: 'x' }),
    tag => withRecord(tag));
  add('memory action needs a skill name for the skill scope',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'skill', action: 'add', content: 'x' }),
    tag => withRecord(tag));
  add('memory action surfaces a rejected curated edit',
    tag => post(`/api/sessions/${tag}/memory/action`, { scope: 'own', action: 'add', content: 'BAD_ACTION' }),
    tag => withRecord(tag));
  add('memory action of an unknown session',
    () => post('/api/sessions/nope/memory/action', { scope: 'own', action: 'add', content: 'x' }),
    tag => base(tag));

  // ── GET /api/sessions/:id/bundle ───────────────────────────────────────
  add('bundle export of an unknown session',
    () => get('/api/sessions/nope/bundle?passphrase=secret1'), tag => base(tag));
  add('bundle export refuses a system session',
    () => get('/api/sessions/aux1/bundle?passphrase=secret1'),
    (tag) => { const w = base(tag); w.records = [record('aux1', { type: 'aux' })]; return w; });
  add('bundle export needs a passphrase',
    tag => get(`/api/sessions/${tag}/bundle`), tag => withRecord(tag));
  add('bundle export needs a long-enough passphrase',
    tag => get(`/api/sessions/${tag}/bundle?passphrase=abc`), tag => withRecord(tag));

  // ── POST /api/sessions/import ──────────────────────────────────────────
  add('bundle import needs the encrypted fields',
    () => post('/api/sessions/import', { passphrase: 'secret1', dirId: 'd1' }), tag => base(tag));
  add('bundle import needs a passphrase',
    () => post('/api/sessions/import', { salt: 'a', iv: 'b', ct: 'c', tag: 'd', dirId: 'd1' }),
    tag => base(tag));
  add('bundle import needs a target',
    () => post('/api/sessions/import', { salt: 'a', iv: 'b', ct: 'c', tag: 'd', passphrase: 'secret1' }),
    tag => base(tag));
  add('bundle import of an unknown directory',
    () => post('/api/sessions/import', { salt: 'a', iv: 'b', ct: 'c', tag: 'd', passphrase: 'secret1', dirId: 'nope' }),
    tag => base(tag));
  add('bundle import rejects a bad ciphertext',
    () => post('/api/sessions/import', {
      salt: crypto.randomBytes(16).toString('base64'),
      iv: crypto.randomBytes(12).toString('base64'),
      ct: Buffer.from('not a bundle').toString('base64'),
      tag: crypto.randomBytes(16).toString('base64'),
      passphrase: 'secret1', dirId: 'd1',
    }),
    tag => base(tag));
  add('bundle import rejects an unsupported version',
    () => post('/api/sessions/import', encryptBundle({ v: 9, sessionMeta: {} }, 'secret1')),
    tag => base(tag));

  // ── the two binary transports stay in Node and are forwarded ───────────
  add('forwarded GET bundle.zip needs a passphrase',
    tag => get(`/api/sessions/${tag}/bundle.zip`), tag => withRecord(tag), { normalize: dropHopHeaders });
  add('forwarded POST import-zip rejects a non-zip body',
    () => ({
      method: 'POST', url: '/api/sessions/import-zip?passphrase=secret1&dirId=d1',
      headers: { ...L, 'Content-Type': 'application/zip' }, body: 'not a zip',
    }),
    tag => base(tag), { normalize: dropHopHeaders });

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────
  add('session delete of an unknown id', () => del('/api/sessions/nope'), tag => base(tag));
  add('session delete refuses a commander',
    () => del('/api/sessions/cmdr'),
    (tag) => { const w = base(tag); w.records = [record('cmdr', { type: 'commander' })]; return w; });
  add('session delete refuses a task-bound room without force',
    () => del('/api/sessions/bound'),
    (tag) => { const w = base(tag); w.records = [record('bound', { taskBoundTaskId: 'tk-1' })]; return w; });
  add('session delete cascades through the owning directory',
    () => del('/api/sessions/s1'),
    (tag) => { const w = base(tag); w.records = [record('s1')]; return w; });
  add('session delete reports a blocked cascade',
    () => del('/api/sessions/s1'),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1')];
      w.answers.destroySessionCascade = { ok: false, code: 'busy', error: 'session is busy' };
      return w;
    });
  add('session delete honours the force query',
    () => del('/api/sessions/s1?force=1'),
    (tag) => { const w = base(tag); w.records = [record('s1', { taskBoundTaskId: 'tk-1' })]; return w; });
  add('session delete tears down an active-only room',
    () => del('/api/sessions/t1'),
    (tag) => { const w = base(tag); w.sessions = { t1: { clients: 2 } }; return w; });

  // ── POST /api/sessions/:id/relocate ────────────────────────────────────
  add('relocate needs a target directory',
    () => post('/api/sessions/s1/relocate', {}),
    (tag) => { const w = base(tag); w.records = [record('s1')]; return w; });
  add('relocate rejects an unknown target directory',
    () => post('/api/sessions/s1/relocate', { dirId: 'nope' }),
    (tag) => { const w = base(tag); w.records = [record('s1')]; return w; });
  add('relocate of an unknown session',
    () => post('/api/sessions/nope/relocate', { dirId: 'd2' }),
    (tag) => { const w = base(tag); w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' }); return w; });
  add('relocate into the current directory is unchanged',
    () => post('/api/sessions/s1/relocate', { dirId: 'd1' }),
    (tag) => { const w = base(tag); w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })]; return w; });
  add('relocate refuses a target path missing on disk',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2' }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      w.missingPaths = ['/repo2'];
      return w;
    });
  add('relocate blocks an active room without force',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2' }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      w.sessions = { s1: { clients: 0 } };
      return w;
    });
  add('relocate of a planned room only updates the record',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2' }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1')];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      return w;
    });
  add('relocate moves the worktree of a materialised room',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2', carry: true }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      return w;
    });
  add('relocate surfaces a blocked worktree move',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2' }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      w.answers.gitRelocateWorktree = { ok: false, blocked: true, reasons: ['dirty'] };
      return w;
    });
  add('relocate surfaces a failed worktree move',
    () => post('/api/sessions/s1/relocate', { dirId: 'd2' }),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { worktreePath: '/repo/wt/s1', branch: 'multicc/s1' })];
      w.directories.push({ id: 'd2', path: '/repo2', name: 'Repo2', baseBranch: 'main' });
      w.answers.gitRelocateWorktree = { ok: false, error: 'move failed' };
      return w;
    });

  // ── POST /api/sessions/:id/restart ─────────────────────────────────────
  add('restart of an unknown session', () => post('/api/sessions/nope/restart', {}), tag => base(tag));
  add('restart refuses a chat session',
    () => post('/api/sessions/s1/restart', {}),
    (tag) => { const w = base(tag); w.records = [record('s1', { kind: 'chat' })]; return w; });
  add('restart respawns a terminal session',
    () => post('/api/sessions/t1/restart', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('t1', { kind: 'terminal', worktreePath: '/repo/wt/t1', branch: 'multicc/t1' })];
      w.sessions = { t1: { clients: 2 } };
      return w;
    });
  add('restart recreates a missing worktree',
    () => post('/api/sessions/t1/restart', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('t1', { kind: 'terminal', worktreePath: '/repo/wt/t1', branch: 'multicc/t1' })];
      w.missingPaths = ['/repo/wt/t1'];
      return w;
    });
  add('restart reports a failed respawn',
    () => post('/api/sessions/t1/restart', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('t1', { kind: 'terminal', worktreePath: '/repo/wt/t1', branch: 'multicc/t1' })];
      w.answers.createSession = { throw: 'spawn failed' };
      return w;
    });

  // ── POST /api/sessions/:id/restart-spawn ───────────────────────────────
  add('restart-spawn of an unknown session', () => post('/api/sessions/nope/restart-spawn', {}), tag => base(tag));
  add('restart-spawn refuses a terminal session',
    () => post('/api/sessions/t1/restart-spawn', {}),
    (tag) => { const w = base(tag); w.records = [record('t1', { kind: 'terminal' })]; return w; });
  add('restart-spawn tears down and reports the prior state',
    () => post('/api/sessions/s1/restart-spawn', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1')];
      w.chats = { s1: { clients: 1, streaming: true } };
      w.streamStatus = { s1: { alive: true, busy: true, queued: 2, pid: 4321 } };
      return w;
    });
  add('restart-spawn force-archives a codex rollout',
    () => post('/api/sessions/s1/restart-spawn', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { cli: 'codex' })];
      w.chats = { s1: { clients: 0 } };
      w.answers.codexGuard = {
        action: 'archived',
        archived: [{ file: 'rollout.jsonl', sizeBytes: 128, archivedTo: '/arch/rollout.jsonl' }],
      };
      return w;
    });
  add('restart-spawn falls back when the cancel fails',
    () => post('/api/sessions/s1/restart-spawn', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1')];
      w.chats = { s1: { clients: 0 } };
      w.answers.cancelActiveTurn = { ok: false, code: 'cancel_failed', error: 'nope' };
      return w;
    });

  // ── POST /api/sessions/:id/vendor-login-terminal ───────────────────────
  add('vendor login of an unknown session',
    () => post('/api/sessions/nope/vendor-login-terminal', {}), tag => base(tag));
  add('vendor login refuses a CLI without vendor auth',
    () => post('/api/sessions/s1/vendor-login-terminal', {}),
    (tag) => { const w = base(tag); w.records = [record('s1', { cli: 'claude' })]; return w; });
  add('vendor login needs the owning directory',
    () => post('/api/sessions/s1/vendor-login-terminal', {}),
    (tag) => { const w = base(tag); w.records = [record('s1', { cli: 'qoder', dirId: 'gone' })]; return w; });
  add('vendor login opens a one-shot login terminal',
    () => post('/api/sessions/s1/vendor-login-terminal', {}),
    (tag) => { const w = base(tag); w.records = [record('s1', { cli: 'qoder' })]; return w; });
  add('vendor login surfaces a refused terminal',
    () => post('/api/sessions/s1/vendor-login-terminal', {}),
    (tag) => {
      const w = base(tag);
      w.records = [record('s1', { cli: 'qoder' })];
      w.answers.createSessionRecord = { ok: false, error: 'terminal spawn refused' };
      return w;
    });

  // ── PUT /api/directories/:id/role-workers/:presetId ────────────────────
  add('role workers are a retired no-op',
    () => put('/api/directories/d1/role-workers/p1', { any: 'thing' }),
    tag => base(tag));

  // ── POST /api/directories/:id/sessions ─────────────────────────────────
  add('directory create session needs the directory',
    () => post('/api/directories/nope/sessions', { cli: 'claude', kind: 'chat' }),
    tag => base(tag));
  add('directory create chat routes through task creation',
    () => post('/api/directories/d1/sessions', { cli: 'claude', kind: 'chat', label: '新任务' }),
    tag => base(tag));
  add('directory create terminal makes a session record',
    () => post('/api/directories/d1/sessions', { cli: 'qoder', kind: 'terminal', label: 'Login' }),
    tag => base(tag));
  add('directory create surfaces a refused record',
    () => post('/api/directories/d1/sessions', { cli: 'claude', kind: 'terminal' }),
    (tag) => { const w = base(tag); w.answers.createSessionRecord = { ok: false, error: 'no room' }; return w; });

  // ── POST /api/sessions/:id/notes ───────────────────────────────────────
  add('notes post from an unknown session',
    () => post('/api/sessions/nope/notes', { toSessionId: 'b', body: 'x' }), tag => base(tag));
  add('notes post needs a recipient and a body',
    tag => post(`/api/sessions/${tag}/notes`, {}), tag => withRecord(tag));
  add('notes post needs a known recipient',
    tag => post(`/api/sessions/${tag}/notes`, { toSessionId: 'never', body: 'x' }), tag => withRecord(tag));
  add('notes post stays inside one directory',
    tag => post(`/api/sessions/${tag}/notes`, { toSessionId: 'far', body: 'x' }),
    (tag) => {
      const w = withRecord(tag);
      w.records.push(record('far', { dirId: 'd2' }));
      return w;
    });
  add('notes post delivers an in-directory note',
    tag => post(`/api/sessions/${tag}/notes`, { toSessionId: 'peer', body: 'hello there' }),
    (tag) => {
      const w = withRecord(tag);
      w.records.push(record('peer', { dirId: 'd1', label: 'Peer' }));
      return w;
    },
    { normalize: (view) => { view.headers.etag = '<uuid-hash>'; return view; } });

  // ── GET /api/sessions/:id/liveness ─────────────────────────────────────
  add('liveness of an unknown session',
    () => get('/api/sessions/nope/liveness'), tag => base(tag));
  add('liveness probes by default',
    tag => get(`/api/sessions/${tag}/liveness`),
    tag => withRecord(tag, {}, (w) => { w.liveness = { [tag]: { state: 'working', since: T0 } }; }));
  add('liveness skips the probe on request',
    tag => get(`/api/sessions/${tag}/liveness?probe=0`),
    tag => withRecord(tag, {}, (w) => { w.liveness = { [tag]: { state: 'idle', since: T0 } }; }));
  add('liveness answers HEAD', tag => head(`/api/sessions/${tag}/liveness`), tag => withRecord(tag));

  // ── GET /api/sessions/:id/notes ────────────────────────────────────────
  add('notes read of an unknown session',
    () => get('/api/sessions/nope/notes'), tag => base(tag));
  add('notes read returns the inbox and outbox',
    tag => get(`/api/sessions/${tag}/notes`),
    (tag) => {
      const w = withRecord(tag);
      w.notes = [
        { id: 'n1', toSessionId: tag, fromSessionId: 'peer', body: 'in', delivered: false },
        { id: 'n2', toSessionId: 'peer', fromSessionId: tag, body: 'out', delivered: true },
        { id: 'n3', toSessionId: 'other', fromSessionId: 'other', body: 'skip', delivered: false },
      ];
      return w;
    });

  // ── PATCH /api/sessions/:id ────────────────────────────────────────────
  add('patch of an unknown session', () => patch('/api/sessions/nope', { label: 'x' }), tag => base(tag));
  add('patch refuses a system session',
    () => patch('/api/sessions/aux1', { label: 'x' }),
    (tag) => { const w = base(tag); w.records = [record('aux1', { type: 'aux' })]; return w; });
  add('patch refuses a CLI switch',
    tag => patch(`/api/sessions/${tag}`, { cli: 'codex' }), tag => withRecord(tag));
  add('patch rejects an over-long label',
    tag => patch(`/api/sessions/${tag}`, { label: text(81) }), tag => withRecord(tag));
  add('patch renames a session',
    tag => patch(`/api/sessions/${tag}`, { label: 'Fresh Name' }), tag => withRecord(tag));
  add('patch rejects an invalid model id',
    tag => patch(`/api/sessions/${tag}`, { model: 'bad model!' }), tag => withRecord(tag));
  add('patch sets a model id',
    tag => patch(`/api/sessions/${tag}`, { model: 'claude-sonnet-4' }), tag => withRecord(tag));
  add('patch rejects an invalid effort',
    tag => patch(`/api/sessions/${tag}`, { effort: 'bogus' }), tag => withRecord(tag));
  add('patch sets an effort',
    tag => patch(`/api/sessions/${tag}`, { effort: 'high' }), tag => withRecord(tag));
  add('patch rejects an invalid agent',
    tag => patch(`/api/sessions/${tag}`, { agent: 'bogus' }), tag => withRecord(tag));
  add('patch rejects an over-long role prompt',
    tag => patch(`/api/sessions/${tag}`, { rolePrompt: text(40001) }), tag => withRecord(tag));
  add('patch sets a role prompt',
    tag => patch(`/api/sessions/${tag}`, { rolePrompt: '  be terse  ' }), tag => withRecord(tag));
  add('patch rejects over-long memory',
    tag => patch(`/api/sessions/${tag}`, { memory: [{ type: 'fact', text: text(9000), ts: 1 }] }),
    tag => withRecord(tag));
  add('patch sets manual memory',
    tag => patch(`/api/sessions/${tag}`, { memory: [{ type: 'fact', text: 'remember me', ts: 7 }] }),
    tag => withRecord(tag));
  add('patch flips auto-commit',
    tag => patch(`/api/sessions/${tag}`, { autoCommit: true }), tag => withRecord(tag));

  // ── POST /api/sessions/:id/fork ────────────────────────────────────────
  add('fork of an unknown session', () => post('/api/sessions/nope/fork', {}), tag => base(tag));
  add('fork refuses a system session',
    () => post('/api/sessions/aux1/fork', {}),
    (tag) => { const w = base(tag); w.records = [record('aux1', { type: 'aux' })]; return w; });
  add('fork needs a message id that exists',
    tag => post(`/api/sessions/${tag}/fork`, { atMessageId: 'zzz' }),
    tag => withRecord(tag, {}, (w) => {
      w.histories = { [tag]: [{ id: 'm1', role: 'assistant', content: 'hi', ts: 1 }] };
    }));
  add('fork rejects an invalid configuration session',
    tag => post(`/api/sessions/${tag}/fork`, { configurationSessionId: 'missing' }),
    tag => withRecord(tag, {}, (w) => {
      w.histories = { [tag]: [{ id: 'm1', role: 'assistant', content: 'hi', ts: 1 }] };
    }));

  return pending;
}

// ── a deterministic AES-256-GCM bundle, matching session-bundle.js ─────────

function encryptBundle(payload, passphrase, extra = {}) {
  const salt = Buffer.alloc(16, 1);
  const iv = Buffer.alloc(12, 2);
  const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return {
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    passphrase, dirId: 'd1', ...extra,
  };
}

// ── the stub Node child: the real host-port composition over the world ─────

function upstreamSource(repo) {
  return `'use strict';
// Frozen clock: note timestamps and audit rows must agree byte for byte.
Date.now = () => ${T0};
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/session-routes-scripted-world'));
const legacy = require(path.join(REPO, 'tests/helpers/legacy-session-routes'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

// One world per case, like one server process: the guard round trip and the
// business round trip of a single request must reach the same Maps.
const bags = new Map();
const reported = new Map();
function bagFor(scenario) {
  const key = String(scenario.case || '');
  let bag = bags.get(key);
  if (!bag) { bag = world.buildDeps(scenario); bags.set(key, bag); }
  return bag;
}

// The front-door guard asks session-admin's host port for the record; the live
// composition owns session-routes and the two public zip transports.
function buildComposition(bag) {
  const inner = express();
  inner.use(express.json({ limit: '50mb' }));
  inner.post('/api/__host/session-admin', (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const record = bag.deps.profile.persistedSessions.get(String(body.id || '')) || null;
    res.json({
      record,
      internal: !!(record && record.taskExecutionSlot === true),
      taskStateWritable: true,
    });
  });
  legacy.mountLiveComposition(inner, bag, { isLocal: () => true });
  return inner;
}
const compositions = new Map();
function compositionFor(key, bag) {
  let inner = compositions.get(key);
  if (!inner) { inner = buildComposition(bag); compositions.set(key, inner); }
  return inner;
}

const app = express();
app.use((req, res, next) => {
  const scenario = readWorld();
  const bag = bagFor(scenario);
  const key = String(scenario.case || '');
  res.on('finish', () => {
    const calls = bag.effects.calls;
    const from = reported.get(key) || 0;
    const fresh = calls.slice(from);
    reported.set(key, calls.length);
    if (!fresh.length) return;
    fs.appendFileSync(effectsPath, JSON.stringify({ case: key, calls: fresh }) + '\\n');
  });
  return compositionFor(key, bag)(req, res, next);
});

const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── response normalization ─────────────────────────────────────────────────

// Only the values that cannot agree by construction: the note id generated by
// crypto.randomUUID(). The clock is frozen on both sides, so timestamps agree.
function normalize(text) {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'session-routes',
  mount(app, { repo, work }) {
    // A missed dependency would otherwise fall back to the checkout's data root.
    process.env.MULTICC_DATA_DIR = work;
    process.env.NODE_PATH = path.join(repo, 'node_modules');
    require('module').Module._initPaths();
    Date.now = () => T0;
    repoPath = repo;
    worldPath = path.join(work, 'session-world.json');
    effectsPath = path.join(work, 'session-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    const world = require(path.join(repo, 'tests/helpers/session-routes-scripted-world'));
    const legacy = require(path.join(repo, 'tests/helpers/legacy-session-routes'));
    const { mountPublicSessionAccessGuard } = require(path.join(repo, 'src/session/public-session-access'));
    bag = world.buildDeps({ case: 'initial', answers: {} });
    mountPublicSessionAccessGuard(app, { records: bag.deps.meta.persistedSessions });
    // The whole server also answers GET on this path (owned by session-admin);
    // it is mounted so the automatic OPTIONS union matches the real app.
    app.get('/api/directories/:id/sessions', (_req, res) => res.json({ sessions: [] }));
    // The whole server also answers GET on the session shape (session-admin).
    app.get('/api/sessions/:id', (_req, res) => res.json({}));
    legacy.mountSessionRoutesLegacy(app, bag);
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: work,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  async ready(port) {
    // Health belongs to the front door. Guarded preflight also needs the
    // compatibility host listening before the measured corpus can begin.
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await send(port, {
        method: 'OPTIONS', url: '/api/sessions/readiness/memory',
        headers: { Host: 'localhost', Authorization: 'Bearer ' + TOKEN },
      });
      if (response.status === 503
          && JSON.parse(response.body.toString()).code === 'rust_backend_unavailable') {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      assert.equal(response.status, 200, 'session guard readiness');
      assert.equal(response.headers.allow, 'GET,HEAD,PUT,DELETE');
      assert.equal(response.body.toString(), 'GET,HEAD,PUT,DELETE');
      return;
    }
    throw new Error('session guard host did not become ready');
  },
  normalize,
  corpus,
  finalize({ work, views }) {
    const problems = [];
    const byName = new Map(views.map(entry => [entry.name, entry]));

    const expect = (name, status, needle) => {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); return; }
      for (const side of ['node', 'rust']) {
        if (view[side].status !== status) {
          problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
        }
        if (needle && !view[side].body.includes(needle)) {
          problems.push(`${name}: ${side} body lacks ${needle} (${view[side].body})`);
        }
      }
    };

    // Byte-identical is not enough: a stub that failed to resolve would let both
    // sides 500 with the same envelope. No case in this corpus is a generic 500.
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"error":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }

    // One representative per host op, so a shrunk corpus fails loudly.
    expect('memory read projects every scope', 200, '"legacy":[{"type":"fact"');
    expect('memory read rejects a malformed id escape', 400, '"request_error"');
    expect('memory write stores a plain markdown file', 200, '"files":["note.md"]');
    expect('memory write rejects a threat payload', 400, '"memory write blocked: prompt_injection"');
    expect('memory delete removes an existing file', 200, '"ok":true');
    expect('memory action appends a curated entry', 200, '"ok":true');
    expect('bundle export needs a passphrase', 400, '"error":"passphrase required');
    expect('bundle import rejects an unsupported version', 400, '"error":"unsupported bundle version"');
    expect('session delete cascades through the owning directory', 200, '"ok":true');
    expect('session delete reports a blocked cascade', 409, '"code":"busy"');
    expect('relocate of a planned room only updates the record', 200, '"planned":true');
    expect('relocate surfaces a blocked worktree move', 409, '"blocked":true');
    expect('restart respawns a terminal session', 200, '"cwd":"/repo/wt/t1"');
    expect('restart reports a failed respawn', 500, '"error":"spawn failed"');
    expect('restart-spawn tears down and reports the prior state', 200, '"busy":true');
    expect('vendor login opens a one-shot login terminal', 200, '"url":"/?id=new-');
    expect('role workers are a retired no-op', 410, '"code":"role_sessions_retired"');
    expect('directory create chat routes through task creation', 200, '"taskId":"tk-new"');
    expect('notes post delivers an in-directory note', 200, '"delivered":false');
    expect('liveness probes by default', 200, '"state":"working"');
    expect('notes read returns the inbox and outbox', 200, '"id":"n1"');
    expect('patch renames a session', 200, '"label":"Fresh Name"');
    expect('patch rejects an over-long role prompt', 400, '"error":"rolePrompt too long');
    expect('fork needs a message id that exists', 400, '"error":"atMessageId not found in history"');
    // The two binary transports are answered by Node, not the front door: only
    // Node knows these messages.
    expect('forwarded GET bundle.zip needs a passphrase', 400, '"error":"passphrase required');
    expect('forwarded POST import-zip rejects a non-zip body', 400, '"error":"body is not a zip bundle');

    // Internal execution slot: every business path AND the OPTIONS row must 404
    // through the shared guard.
    const slotCases = [...byName.keys()].filter(name => /internal slot/.test(name));
    if (slotCases.length < 10) {
      problems.push(`internal-slot coverage shrank to ${slotCases.length} cases`);
    }
    for (const name of slotCases) {
      const view = byName.get(name);
      for (const side of ['node', 'rust']) {
        if (view[side].status !== 404 || !view[side].body.includes('session not found')) {
          problems.push(`${name}: ${side} did not 404 as an internal slot (${view[side].status} ${view[side].body})`);
        }
      }
    }

    // OPTIONS: the automatic Allow union must match the whole Express app.
    const allowExpect = {
      'OPTIONS memory unions every verb': 'GET,HEAD,PUT,DELETE',
      'OPTIONS memory action is POST only': 'POST',
      'OPTIONS bundle is a read': 'GET,HEAD',
      'OPTIONS notes unions POST then GET': 'POST,GET,HEAD',
      'OPTIONS role workers is PUT only': 'PUT',
      'OPTIONS directory sessions unions GET and POST': 'GET,HEAD,POST',
      'OPTIONS forwarded bundle.zip': 'GET,HEAD',
      'OPTIONS session shape unions GET HEAD PATCH DELETE': 'GET,HEAD,PATCH,DELETE',
    };
    for (const [name, allow] of Object.entries(allowExpect)) {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); continue; }
      for (const side of ['node', 'rust']) {
        if (view[side].headers.allow !== allow) {
          problems.push(`${name}: ${side} Allow ${JSON.stringify(view[side].headers.allow)}, expected ${JSON.stringify(allow)}`);
        }
      }
    }

    // Side effects: the write sequence must be identical, not merely survivable.
    const readEffects = file => {
      const map = new Map();
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return map; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (_) { continue; }
        if (!entry || !entry.case) continue;
        if (!map.has(entry.case)) map.set(entry.case, []);
        map.get(entry.case).push(...entry.calls);
      }
      return map;
    };
    const rustEffects = readEffects(effectsPath);
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) mismatches.push({ tag, node: calls, rust });
    }
    const requireEffect = (name, kinds) => {
      const tag = tagsByName.get(name);
      if (!tag) { problems.push(`${name}: missing from the corpus`); return; }
      for (const [side, table] of [['node', nodeEffects], ['rust', rustEffects]]) {
        const seen = (table.get(tag) || []).map(call => call.call);
        for (const kind of kinds) {
          if (!seen.includes(kind)) {
            problems.push(`${name}: ${side} side effects lack ${kind} (${JSON.stringify(seen)})`);
          }
        }
      }
    };
    // delete: cascade + journal + audit; restart: journal + respawn + notify;
    // restart-spawn: canonical cancel + stream teardown + audit.
    requireEffect('session delete cascades through the owning directory',
      ['destroySessionCascade', 'persist.mutate', 'appendEvent']);
    requireEffect('session delete tears down an active-only room', ['tmuxKill']);
    requireEffect('restart respawns a terminal session',
      ['persist.mutate', 'createSession', 'broadcastTo']);
    requireEffect('restart recreates a missing worktree',
      ['ensureDirGitReady', 'gitWorktreeAdd']);
    requireEffect('restart-spawn tears down and reports the prior state',
      ['cancelActiveTurn', 'stream.close', 'appendEvent']);
    requireEffect('restart-spawn force-archives a codex rollout',
      ['codexGuard', 'persist.mutate']);

    // The 503 (host unreachable) cannot be produced with a live stub; it is
    // pinned by the gateway integration test. Fail if that pin disappeared.
    try {
      const suite = fs.readFileSync(path.join(repoPath, 'native/gateway/tests/session_routes.rs'), 'utf8');
      if (!suite.includes('fn host_unreachable_is_a_503')) {
        problems.push('503 pin missing: host_unreachable_is_a_503');
      }
      if (!suite.includes('rust_backend_unavailable')) {
        problems.push('503 pin missing: rust_backend_unavailable');
      }
    } catch (error) {
      problems.push(`cannot read native/gateway/tests/session_routes.rs: ${error.message}`);
    }

    const details = path.join(work, 'session-details.json');
    fs.writeFileSync(details, JSON.stringify({ problems, mismatches }, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }
    if (problems.length) {
      for (const problem of problems) console.log(`[session-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[session-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[session-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
