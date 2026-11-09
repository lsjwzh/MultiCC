'use strict';

// Differential oracle for the Rust native-session guards:
//   native/core/src/native_session_guard.rs
//   (exports RustCodexRolloutGuard / RustNativeSessionGuard)
//
// The frozen Node implementations in tests/helpers/legacy-*.js and the current
// JS facades run against two byte-identical temp trees in isolated temp
// directories. Results, logger calls and the post-run filesystem snapshot must
// agree. Filesystem error *text* is platform/implementation specific, so the
// string value of an `error` field is normalized; every other field, action and
// log name/level is compared exactly.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const legacyCodex = require('./helpers/legacy-codex-rollout-guard');
const legacyNative = require('./helpers/legacy-native-session-guard');
const currentCodex = require('../src/chat/codex-rollout-guard');
const currentNative = require('../src/chat/native-session-guard');

delete process.env.MULTICC_CODEX_ROLLOUT_MAX_BYTES;
delete process.env.MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS;
delete process.env.MULTICC_NATIVE_SESSION_MAX_BYTES;
delete process.env.MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── tree construction and snapshots ─────────────────────────────────────────

function applySpec(root, spec) {
  for (const entry of spec) {
    const full = path.join(root, entry.path);
    if (entry.kind === 'dir') {
      fs.mkdirSync(full, { recursive: true });
    } else if (entry.kind === 'symlink') {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.symlinkSync(entry.target, full);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.content);
    }
    if (entry.ageDays !== undefined) {
      const past = (Date.now() - entry.ageDays * DAY_MS) / 1000;
      fs.utimesSync(full, past, past);
    }
    if (entry.chmod !== undefined) fs.chmodSync(full, entry.chmod);
  }
}

function snapshot(root) {
  const out = [];
  const walk = (relative, absolute) => {
    let entries;
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(absolute, entry.name);
      const stats = fs.lstatSync(full);
      if (stats.isSymbolicLink()) {
        out.push([rel, 'link', fs.readlinkSync(full)]);
      } else if (stats.isDirectory()) {
        out.push([rel, 'dir', stats.mode & 0o777]);
        walk(rel, full);
      } else {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        out.push([rel, 'file', stats.size, digest]);
      }
    }
  };
  walk('', root);
  return out;
}

// ── comparison helpers ─────────────────────────────────────────────────────

function canon(value, root, key) {
  if (typeof value === 'string') return value.split(root).join('<root>');
  if (Array.isArray(value)) {
    const items = value.map(item => canon(item, root));
    // `deleted`/`archived` follow each implementation's readdir order. Two
    // distinct directory instances may enumerate differently on APFS, so the
    // differential compares those as sets while every field stays exact.
    if (key === 'deleted' || key === 'archived') {
      items.sort((left, right) => {
        const a = JSON.stringify(left);
        const b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, item] of Object.entries(value)) {
      // Error text differs between Node and Rust std; the action and presence
      // of the field are what the contract pins.
      out[name] = name === 'error' && typeof item === 'string' ? '<error>' : canon(item, root, name);
    }
    return out;
  }
  return value;
}

function createLogger(root) {
  const logs = [];
  const logger = {};
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = (name, fields) => logs.push({ level, name, fields: canon(fields, root) });
  }
  return { logger, logs };
}

// ── one differential execution ─────────────────────────────────────────────

const MODULES = {
  codex: { legacy: legacyCodex, current: currentCodex, create: 'createCodexRolloutGuard' },
  native: { legacy: legacyNative, current: currentNative, create: 'createNativeSessionGuard' },
};

function execute(kind, root, spec, scenario) {
  applySpec(root, spec);
  const { logger, logs } = createLogger(root);
  const deps = { homeDir: root, logger, ...(scenario.deps ? scenario.deps(root) : {}) };
  const mod = MODULES[kind];
  const guard = mod.current[mod.create](deps);
  const results = [];
  for (const op of scenario.ops) {
    if (op.kind === 'enforce') {
      results.push(guard.enforce(scenario.record(), op.force ? { force: true } : undefined));
    } else {
      const options = {};
      if (op.force !== undefined) options.force = op.force;
      if (op.nowMs !== undefined) options.nowMs = op.nowMs;
      results.push(guard.sweepExpiredArchives(options));
    }
  }
  const handles = kind === 'native'
    ? ['zcode', 'kimi', 'codebuddy', 'qoder', 'dsh', 'claude', 'constructor'].map(cli => guard.handles(cli))
    : undefined;
  return {
    output: {
      results: results.map(result => canon(result, root)),
      logs,
      maxBytes: guard.maxBytes,
      archiveTtlMs: guard.archiveTtlMs,
      handles,
    },
    snapshot: snapshot(root),
  };
}

function runDifferential(kind, spec, scenario, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-nsg-diff-'));
  const legacyRoot = path.join(base, 'legacy');
  const currentRoot = path.join(base, 'current');
  try {
    // Legacy first, on its own identical tree.
    applySpec(legacyRoot, spec);
    const { logger: legacyLogger, logs: legacyLogs } = createLogger(legacyRoot);
    const legacyDeps = { homeDir: legacyRoot, logger: legacyLogger,
      ...(scenario.deps ? scenario.deps(legacyRoot) : {}) };
    const legacyMod = MODULES[kind];
    const legacyGuard = legacyMod.legacy[legacyMod.create](legacyDeps);
    const legacyResults = [];
    for (const op of scenario.ops) {
      if (op.kind === 'enforce') {
        legacyResults.push(legacyGuard.enforce(scenario.record(), op.force ? { force: true } : undefined));
      } else {
        const options = {};
        if (op.force !== undefined) options.force = op.force;
        if (op.nowMs !== undefined) options.nowMs = op.nowMs;
        legacyResults.push(legacyGuard.sweepExpiredArchives(options));
      }
    }
    const legacyOutput = {
      results: legacyResults.map(result => canon(result, legacyRoot)),
      logs: legacyLogs,
      maxBytes: legacyGuard.maxBytes,
      archiveTtlMs: legacyGuard.archiveTtlMs,
      handles: kind === 'native'
        ? ['zcode', 'kimi', 'codebuddy', 'qoder', 'dsh', 'claude', 'constructor'].map(cli => legacyGuard.handles(cli))
        : undefined,
    };

    const current = execute(kind, currentRoot, spec, scenario);
    try {
      assert.deepEqual(current.output, legacyOutput, `${label}: result/log contract`);
      assert.deepEqual(current.snapshot, snapshot(legacyRoot), `${label}: filesystem effect`);
    } catch (error) {
      error.message = `${label}\n${error.message}`;
      throw error;
    }
  } finally {
    // A deliberately unreadable directory must not wedge cleanup.
    for (const entry of spec) {
      if (entry.chmod === undefined) continue;
      for (const root of [legacyRoot, currentRoot]) {
        try { fs.chmodSync(path.join(root, entry.path), 0o755); } catch (_) { /* already gone */ }
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── hand-built scenarios ────────────────────────────────────────────────────

const codexSmall = content => ({ kind: 'file', path: '.codex/sessions/2026/07/28/rollout-x-tid.jsonl', content });
const codexRecord = id => ({ cli: 'codex', cliSessionId: 'tid', provider: null, id });

const handCases = [
  {
    kind: 'codex',
    label: 'codex/empty home is not_found',
    spec: [],
    scenario: { record: () => codexRecord('t'), ops: [{ kind: 'enforce' }] },
  },
  {
    kind: 'codex',
    label: 'codex/within budget keeps the file',
    spec: [{ ...codexSmall('x'.repeat(100)) }],
    scenario: { record: () => codexRecord('t'), ops: [{ kind: 'enforce' }] },
  },
  {
    kind: 'codex',
    label: 'codex/oversized archives and sweeps',
    spec: [
      codexSmall('z'.repeat(4096)),
      { kind: 'file', path: `.codex/multicc-archived-rollouts/rollout-old.jsonl`, content: 'old', ageDays: 40 },
    ],
    scenario: {
      record: () => codexRecord('t'),
      deps: () => ({ maxBytes: 1024 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/force archives a tiny rollout',
    spec: [codexSmall('tiny')],
    scenario: { record: () => codexRecord('t'), ops: [{ kind: 'enforce', force: true }] },
  },
  {
    kind: 'codex',
    label: 'codex/mixed sizes, nested dirs, name filters',
    spec: [
      { kind: 'file', path: '.codex/sessions/a/rollout-tid-1.jsonl', content: 'x'.repeat(5) },
      { kind: 'file', path: '.codex/sessions/a/b/rollout-tid-2.jsonl', content: 'x'.repeat(2000) },
      { kind: 'file', path: '.codex/sessions/a/notid.jsonl', content: 'x'.repeat(2000) },
      { kind: 'file', path: '.codex/sessions/a/tid.txt', content: 'x'.repeat(2000) },
      { kind: 'dir', path: '.codex/sessions/a/tid.jsonl' },
      { kind: 'file', path: '.codex/sessions/a/tid.jsonl/inner.jsonl', content: 'x'.repeat(3) },
    ],
    scenario: { record: () => codexRecord('t'), deps: () => ({ maxBytes: 1000 }), ops: [{ kind: 'enforce' }] },
  },
  {
    kind: 'codex',
    label: 'codex/symlinks are not followed or matched',
    spec: [
      { kind: 'file', path: 'outside/rollout-tid.jsonl', content: 'x'.repeat(4096) },
      { kind: 'symlink', path: '.codex/sessions/link-file.jsonl', target: '../../outside/rollout-tid.jsonl' },
      { kind: 'symlink', path: '.codex/sessions/link-dir', target: '../../outside' },
    ],
    scenario: { record: () => codexRecord('t'), deps: () => ({ maxBytes: 10 }), ops: [{ kind: 'enforce' }] },
  },
  {
    kind: 'codex',
    label: 'codex/binary, CRLF and empty rollouts are size-only',
    spec: [
      { kind: 'file', path: '.codex/sessions/tid-binary.jsonl', content: Buffer.from([0, 1, 2, 255, 0]) },
      { kind: 'file', path: '.codex/sessions/tid-crlf.jsonl', content: 'a\r\nb\r\n' },
      { kind: 'file', path: '.codex/sessions/tid-empty.jsonl', content: '' },
    ],
    scenario: { record: () => codexRecord('t'), deps: () => ({ maxBytes: 4 }), ops: [{ kind: 'enforce' }] },
  },
  {
    kind: 'codex',
    label: 'codex/unicode id matching',
    spec: [
      { kind: 'file', path: '.codex/sessions/rollout-🔧.jsonl', content: 'x'.repeat(11) },
      { kind: 'file', path: '.codex/sessions/rollout-中文.jsonl', content: 'x'.repeat(11) },
    ],
    scenario: {
      record: () => ({ cli: 'codex-exp', cliSessionId: '🔧', provider: null, id: 't' }),
      deps: () => ({ maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/prepare redirects the sessions dir',
    spec: [{ kind: 'file', path: 'managed/sessions/rollout-tid.jsonl', content: 'x'.repeat(99) }],
    scenario: {
      record: () => ({ cli: 'codex', cliSessionId: 'tid', provider: 'managed', id: 'logical' }),
      deps: root => ({ prepareCodexSessionHome: () => ({ sessionsDir: path.join(root, 'managed', 'sessions') }) }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/prepare throw codes map to the legacy actions',
    spec: [],
    scenario: {
      record: () => ({ cli: 'codex', cliSessionId: 'tid', provider: 'managed', id: 'logical' }),
      deps: () => ({ prepareCodexSessionHome() { throw Object.assign(new Error('x'), { code: 'CODEX_SESSION_ROLLOUT_NOT_FOUND' }); } }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/prepare blocked code logs and returns blocked',
    spec: [],
    scenario: {
      record: () => ({ cli: 'codex', cliSessionId: 'tid', provider: 'managed', id: 'logical' }),
      deps: () => ({ prepareCodexSessionHome() { throw Object.assign(new Error('ambiguous'), { code: 'CODEX_SESSION_ROLLOUT_AMBIGUOUS' }); } }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/other prepare errors are fail-open',
    spec: [],
    scenario: {
      record: () => ({ cli: 'codex', cliSessionId: 'tid', provider: 'managed', id: 'logical' }),
      deps: () => ({ prepareCodexSessionHome() { throw new Error('boom'); } }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'codex',
    label: 'codex/provider home via callback and via codexHomesDir',
    spec: [
      { kind: 'file', path: '.multicc/codex-homes/prov1/sessions/rollout-tid.jsonl', content: 'x'.repeat(50) },
      { kind: 'file', path: 'cb-home/sessions/rollout-tid2.jsonl', content: 'x'.repeat(50) },
    ],
    scenario: {
      record: () => ({ cli: 'codex', cliSessionId: 'tid', provider: 'prov1', id: 'logical' }),
      deps: root => ({ codexSessionHomeFor: () => path.join(root, 'cb-home') }),
      ops: [
        { kind: 'enforce' },
        { kind: 'enforce', force: true },
      ],
    },
  },
  {
    kind: 'codex',
    label: 'codex/sweep covers provider homes, ignores dirs and symlinks, throttles',
    spec: [
      { kind: 'file', path: '.codex/multicc-archived-rollouts/a.jsonl', content: '12345', ageDays: 40 },
      { kind: 'file', path: '.codex/multicc-archived-rollouts/b.jsonl', content: '123', ageDays: 1 },
      { kind: 'dir', path: '.codex/multicc-archived-rollouts/sub' },
      { kind: 'file', path: '.multicc/codex-homes/p/multicc-archived-rollouts/c.jsonl', content: '1234567', ageDays: 90 },
      { kind: 'dir', path: '.multicc/codex-session-homes/s/multicc-archived-rollouts' },
      { kind: 'file', path: '.multicc/codex-session-homes/s/multicc-archived-rollouts/d.jsonl', content: '1', ageDays: 90 },
      { kind: 'file', path: '.codex/multicc-archived-rollouts/real.jsonl', content: '1', ageDays: 90 },
      { kind: 'symlink', path: '.codex/multicc-archived-rollouts/link.jsonl', target: 'real.jsonl' },
    ],
    scenario: {
      record: () => undefined,
      ops: [
        { kind: 'sweep', nowMs: Date.now() },
        { kind: 'sweep', nowMs: Date.now() + 3600_000, force: false },
        { kind: 'sweep', nowMs: Date.now() + 7 * 3600_000, force: false },
      ],
    },
  },
  {
    kind: 'codex',
    label: 'codex/ttl zero disables and ignores a null argument',
    spec: [{ kind: 'file', path: '.codex/multicc-archived-rollouts/a.jsonl', content: '1', ageDays: 90 }],
    scenario: { record: () => undefined, deps: () => ({ archiveTtlDays: 0 }), ops: [{ kind: 'sweep', force: true }] },
  },
  {
    kind: 'codex',
    label: 'codex/permission error fails open as error',
    spec: [
      { kind: 'file', path: '.codex/sessions/a/rollout-tid.jsonl', content: 'x' },
      { kind: 'dir', path: '.codex/sessions/locked', chmod: 0o000 },
    ],
    scenario: { record: () => codexRecord('t'), ops: [{ kind: 'enforce' }] },
  },

  // ── native ──
  {
    kind: 'native',
    label: 'native/skipped lanes and falsy sessions',
    spec: [],
    scenario: {
      record: () => ({ cli: 'claude', cliSessionId: 'x', provider: null, id: 't' }),
      deps: () => ({ env: {} }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/zcode through the injected home, archived then not_found',
    spec: [
      { kind: 'file', path: 'zh/.zcode/cli/rollout/model-io-sess_9.jsonl', content: 'x'.repeat(4096) },
    ],
    scenario: {
      record: () => ({ cli: 'zcode', cliSessionId: 'sess_9', provider: 'zp', id: 'task-z' }),
      deps: root => ({ env: {}, maxBytes: 1024, zcodeSessionHomeFor: id => path.join(root, 'zh', id) }),
      ops: [{ kind: 'enforce' }, { kind: 'enforce' }, { kind: 'enforce', force: true }],
    },
  },
  {
    kind: 'native',
    label: 'native/kimi providerless and provider lane',
    spec: [
      { kind: 'file', path: '.kimi-code/projects/cwd/k-sess.jsonl', content: 'x'.repeat(50) },
      { kind: 'file', path: 'kimi-home/projects/k-sess.jsonl', content: 'x'.repeat(50) },
    ],
    scenario: {
      record: () => ({ cli: 'kimi', cliSessionId: 'k-sess', provider: null, id: 'task-k' }),
      deps: root => ({ env: {}, maxBytes: 10, kimiSessionHomeFor: () => path.join(root, 'kimi-home') }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/kimi provider lane uses the callback home',
    spec: [{ kind: 'file', path: 'kimi-home/projects/k-sess-p.jsonl', content: 'x'.repeat(50) }],
    scenario: {
      record: () => ({ cli: 'kimi', cliSessionId: 'k-sess-p', provider: 'kp', id: 'task-kp' }),
      deps: root => ({ env: {}, maxBytes: 10, kimiSessionHomeFor: () => path.join(root, 'kimi-home') }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/KIMI_CODE_HOME override',
    spec: [{ kind: 'file', path: 'custom-kimi/x/k-sess.jsonl', content: 'x'.repeat(50) }],
    scenario: {
      record: () => ({ cli: 'kimi', cliSessionId: 'k-sess', provider: null, id: 'task-k' }),
      deps: root => ({ env: { KIMI_CODE_HOME: path.join(root, 'custom-kimi') }, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/codebuddy and qoder layouts',
    spec: [
      { kind: 'file', path: '.codebuddy/projects/x/cb.jsonl', content: 'x'.repeat(50) },
      { kind: 'file', path: '.qoder/projects/y/qd.jsonl', content: 'x'.repeat(50) },
    ],
    scenario: {
      record: () => ({ cli: 'codebuddy', cliSessionId: 'cb', provider: null, id: 'task-cb' }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/dsh archives the whole session directory',
    spec: [
      { kind: 'file', path: '.dsh/sessions/--cwd--/multicc-1/session.jsonl.zstd', content: 'x'.repeat(300) },
      { kind: 'file', path: '.dsh/sessions/--cwd--/multicc-1/extra/blob.bin', content: 'y'.repeat(300) },
      { kind: 'file', path: '.dsh/sessions/--cwd--/multicc-2/session.jsonl.zstd', content: 'z'.repeat(9) },
    ],
    scenario: {
      record: () => ({ cli: 'dsh', cliSessionId: 'multicc-1', provider: null, id: 'task-d' }),
      deps: () => ({ env: {}, maxBytes: 100 }),
      ops: [{ kind: 'enforce' }, { kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/archive name slices 32 units and splits emoji pairs',
    spec: [{ kind: 'file', path: '.codebuddy/projects/x/cb.jsonl', content: 'x'.repeat(50) }],
    scenario: {
      record: () => ({ cli: 'codebuddy', cliSessionId: 'cb', provider: null, id: `a${'🔧'.repeat(20)}` }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce', force: true }],
    },
  },
  {
    kind: 'native',
    label: 'native/lone-surrogate ids never match U+FFFD filenames',
    spec: [{ kind: 'file', path: '.codebuddy/projects/x/�.jsonl', content: 'x'.repeat(50) }],
    scenario: {
      record: () => ({ cli: 'codebuddy', cliSessionId: '\uD800', provider: null, id: 'task-l' }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }, { kind: 'enforce', force: true }],
    },
  },
  {
    kind: 'native',
    label: 'native/Object.prototype names are truthy-but-missing stores',
    spec: [],
    scenario: {
      record: () => ({ cli: 'constructor', cliSessionId: 'sid', provider: null, id: 't' }),
      deps: () => ({ env: {} }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/symlink files and dirs are not matched',
    spec: [
      { kind: 'file', path: 'outside/real.jsonl', content: 'x'.repeat(50) },
      { kind: 'file', path: 'outside/sess/sub.jsonl', content: 'x'.repeat(50) },
      { kind: 'symlink', path: '.qoder/link-file.jsonl', target: '../outside/real.jsonl' },
      { kind: 'symlink', path: '.qoder/link-dir', target: '../outside/sess' },
      { kind: 'symlink', path: '.dsh/sessions/--cwd--/sess', target: '../../outside/sess' },
    ],
    scenario: {
      record: () => ({ cli: 'qoder', cliSessionId: 'sess', provider: null, id: 't' }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/scan skips the archive dirname',
    spec: [
      { kind: 'file', path: `.codebuddy/multicc-archived-sessions/cb-old.jsonl`, content: 'x'.repeat(50) },
      { kind: 'file', path: '.codebuddy/projects/x/cb.jsonl', content: 'x'.repeat(20) },
    ],
    scenario: {
      record: () => ({ cli: 'codebuddy', cliSessionId: 'cb', provider: null, id: 'task-cb' }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/host callback throwing is fail-open',
    spec: [],
    scenario: {
      record: () => ({ cli: 'zcode', cliSessionId: 'sid', provider: 'zp', id: 'task-z' }),
      deps: () => ({ env: {}, zcodeSessionHomeFor() { throw new Error('callback boom'); } }),
      ops: [{ kind: 'enforce' }],
    },
  },
  {
    kind: 'native',
    label: 'native/sweep files, dirs and symlinks with throttle',
    spec: [
      { kind: 'file', path: '.codebuddy/multicc-archived-sessions/old.jsonl', content: '12345', ageDays: 40 },
      { kind: 'file', path: '.codebuddy/multicc-archived-sessions/new.jsonl', content: '123', ageDays: 1 },
      { kind: 'dir', path: '.codebuddy/multicc-archived-sessions/old-dir' },
      { kind: 'file', path: '.codebuddy/multicc-archived-sessions/old-dir/inner.jsonl', content: '1234567', ageDays: 40 },
      { kind: 'dir', path: '.codebuddy/multicc-archived-sessions/old-dir', ageDays: 40 },
      { kind: 'file', path: '.dsh/multicc-archived-sessions/real.bin', content: '1', ageDays: 90 },
      { kind: 'file', path: '.dsh/outside/real.bin', content: '1', ageDays: 90 },
      { kind: 'symlink', path: '.dsh/multicc-archived-sessions/link.bin', target: '../outside/real.bin' },
      { kind: 'dir', path: '.multicc/zcode-homes/h1/.zcode/multicc-archived-sessions' },
      { kind: 'file', path: '.multicc/zcode-homes/h1/.zcode/multicc-archived-sessions/z.jsonl', content: '123', ageDays: 90 },
      { kind: 'dir', path: '.multicc/kimi-homes/h2/multicc-archived-sessions' },
      { kind: 'file', path: '.multicc/kimi-homes/h2/multicc-archived-sessions/k.jsonl', content: '12', ageDays: 90 },
    ],
    scenario: {
      record: () => undefined,
      deps: () => ({ env: {} }),
      ops: [
        { kind: 'sweep', nowMs: Date.now() },
        { kind: 'sweep', nowMs: Date.now() + 3600_000, force: false },
        { kind: 'sweep', nowMs: Date.now() + 7 * 3600_000, force: false },
      ],
    },
  },
  {
    kind: 'native',
    label: 'native/archive target collision keeps walk-order winner',
    spec: [
      { kind: 'file', path: '.codebuddy/a/cb.jsonl', content: 'a'.repeat(50) },
      { kind: 'file', path: '.codebuddy/b/cb.jsonl', content: 'b'.repeat(60) },
    ],
    scenario: {
      record: () => ({ cli: 'codebuddy', cliSessionId: 'cb', provider: null, id: 'task-cb' }),
      deps: () => ({ env: {}, maxBytes: 10 }),
      ops: [{ kind: 'enforce' }],
    },
  },
];

for (const entry of handCases) {
  test(`differential: ${entry.label}`, () => {
    runDifferential(entry.kind, entry.spec, entry.scenario, entry.label);
  });
}

// ── randomized cases ───────────────────────────────────────────────────────

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

function randomContent(random) {
  const length = Math.floor(random() * 3000);
  const style = Math.floor(random() * 4);
  if (style === 0) return Buffer.alloc(length);
  if (style === 1) return 'x'.repeat(length);
  if (style === 2) return `${'line\r\n'.repeat(Math.ceil(length / 6))}`.slice(0, length);
  return crypto.randomBytes(length);
}

function randomSpec(random) {
  // Every random choice is made once, here: the two trees must see identical
  // records and dependency flags.
  const spec = [];
  const id = pick(random, ['tid', 'sess_1', '🔧', '中文', 'x'.repeat(40), '�', 'constructor']);
  const clis = ['codex', 'codex-exp', 'zcode', 'kimi', 'codebuddy', 'qoder', 'dsh', 'claude'];
  const cli = pick(random, clis);
  const provider = pick(random, [null, 'prov1', 'zp']);
  const count = Math.floor(random() * 4);
  const sessionsDir = pick(random, ['', '2026/07/28/', 'a/b/']);
  for (let index = 0; index < count; index += 1) {
    const name = random() < 0.7
      ? `rollout-${index}-${id}.jsonl`
      : `rollout-${index}-other.jsonl`;
    spec.push({ kind: 'file', path: `.codex/sessions/${sessionsDir}${name}`, content: randomContent(random) });
  }
  spec.push({ kind: 'file', path: `.codex/multicc-archived-rollouts/arc-${id}.jsonl`, content: randomContent(random), ageDays: pick(random, [0, 1, 10, 40, 60]) });
  spec.push({ kind: 'file', path: `.codebuddy/projects/x/${id}.jsonl`, content: randomContent(random) });
  spec.push({ kind: 'file', path: `.qoder/projects/y/${id}.jsonl`, content: randomContent(random) });
  spec.push({ kind: 'file', path: `.kimi-code/projects/cwd/${id}.jsonl`, content: randomContent(random) });
  spec.push({ kind: 'file', path: `.dsh/sessions/--cwd--/${id}/session.jsonl.zstd`, content: randomContent(random) });
  spec.push({ kind: 'file', path: `zh/.zcode/cli/rollout/model-io-${id}.jsonl`, content: randomContent(random) });
  spec.push({ kind: 'file', path: `kimi-home/projects/${id}.jsonl`, content: randomContent(random) });
  const maxBytes = pick(random, [undefined, 1, 64, 512, 4096, 10 * 1024 * 1024]);
  const useCodexHomeCallback = random() < 0.5;
  const usePrepare = random() < 0.5;
  const useZcodeCallback = random() < 0.7;
  const useKimiCallback = random() < 0.7;
  const sessionId = random() < 0.7 ? id : pick(random, ['sid', '', null]);
  const recordId = pick(random, [id, null, 'task-1']);
  const depsFactory = root => {
    const deps = { env: {} };
    if (maxBytes !== undefined) deps.maxBytes = maxBytes;
    if (cli === 'codex' || cli === 'codex-exp') {
      if (useCodexHomeCallback) deps.codexSessionHomeFor = () => path.join(root, 'cb-home');
      if (usePrepare) deps.prepareCodexSessionHome = () => ({ sessionsDir: path.join(root, '.codex', 'sessions') });
    }
    if (useZcodeCallback) deps.zcodeSessionHomeFor = session => path.join(root, 'zh', session);
    if (useKimiCallback) deps.kimiSessionHomeFor = () => path.join(root, 'kimi-home');
    return deps;
  };
  const ops = [{ kind: 'enforce' }];
  if (random() < 0.5) ops.push({ kind: 'enforce', force: true });
  if (random() < 0.5) ops.push({ kind: 'sweep', nowMs: Date.now() + Math.floor(random() * 10 * DAY_MS), force: random() < 0.5 });
  return {
    kind: cli === 'codex' || cli === 'codex-exp' ? 'codex' : 'native',
    spec,
    scenario: {
      record: () => ({ cli, cliSessionId: sessionId, provider, id: recordId }),
      deps: depsFactory,
      ops,
    },
  };
}

for (let seed = 1; seed <= 80; seed += 1) {
  test(`differential: randomized seed ${seed}`, () => {
    const random = lcg(seed * 2654435761);
    const generated = randomSpec(random);
    runDifferential(generated.kind, generated.spec, generated.scenario, `random seed ${seed} (${generated.kind})`);
  });
}
