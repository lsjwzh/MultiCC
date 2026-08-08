'use strict';
// Centralised on-disk locations for multicc state files.
//
// Historically every state file was `path.join(__dirname, '<name>.json')`,
// which conflates two independent concerns:
//   (a) where multicc's binaries/source live (fixed by the checkout), and
//   (b) where multicc's *state* lives (should be swappable per environment,
//       especially for tests — the whole reason we exist as a module).
//
// This file adds a single knob — MULTICC_DATA_DIR — that controls (b).
// Default is `__dirname` of the package root, so existing installs migrate
// implicitly: same directory, same files, no user-visible change.
//
// Every test that mutates persistent state MUST use `paths.assertTestDir()` to
// guard the data dir. The check refuses the package root, $HOME, or anything at
// or above $HOME — the same rules directory registration uses. Nothing in the
// production paths calls the guard; it exists purely so a bug in a test can't
// silently wipe a developer's real state files.

const fs = require('fs');
const os = require('os');
const path = require('path');

// realPathOf / isHomeOrAbove now live in the shared path-safety module so paths.js
// and directories.js can never diverge again. Re-exported below for API compat.
const { realPathOf, isHomeOrAbove } = require('./path-safety');

const PKG_ROOT = path.resolve(__dirname, '..');

// Return the effective data directory for this process.
//
// Precedence:
//   1. explicit `override` parameter (createApp injects one for tests),
//   2. process.env.MULTICC_DATA_DIR,
//   3. package root (backwards-compatible default).
//
// The directory is created lazily if needed. The default (package root) is left
// alone — it's already there.
function resolveDataDir(override) {
  const raw = (override || process.env.MULTICC_DATA_DIR || '').trim();
  if (!raw) return PKG_ROOT;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(PKG_ROOT, raw);
  try { fs.mkdirSync(abs, { recursive: true }); }
  catch (e) { throw new Error(`[multicc/paths] cannot create MULTICC_DATA_DIR ${abs}: ${e.message}`); }
  return abs;
}

// Build a namespaced set of file locations off a data dir. Kept as a factory so
// tests can construct a `paths` object once per temp dir and pass it around.
function createPaths({ dataDir } = {}) {
  const root = resolveDataDir(dataDir);
  return {
    root,
    pkgRoot: PKG_ROOT,
    sessionsFile: path.join(root, 'sessions.json'),
    directoriesFile: path.join(root, 'directories.json'),
    // Journal directory for cross-file transactions. .journal/ under the same
    // dir as the state files so a stale journal is trivially discoverable.
    journalDir: path.join(root, '.journal'),
    chatHistoryDir: path.join(root, 'chat_history'),
    eventsDir: path.join(root, 'events'),
    bridgesDir: path.join(root, 'bridges'),
    artifactsDir: path.join(root, 'artifacts'),
    // Preserve the historical ~/.multicc/detached location for ordinary
    // installs, while isolated MULTICC_DATA_DIR instances get fully isolated
    // external-job evidence under their own root.
    detachedDir: root === PKG_ROOT
      ? path.join(os.homedir(), '.multicc', 'detached')
      : path.join(root, 'detached'),
    // Large, replaceable third-party runtimes do not belong in the source
    // checkout. Production keeps them under ~/.multicc while isolated tests
    // keep every byte below their MULTICC_DATA_DIR.
    voiceRuntimesDir: root === PKG_ROOT
      ? path.join(os.homedir(), '.multicc', 'runtimes', 'voice')
      : path.join(root, 'runtimes', 'voice'),
    // Meta files still owned by server.js modules — export the paths so future
    // consolidation can move them onto the store without another rename.
    notesFile: path.join(root, 'notes.json'),
    tokenUsageFile: path.join(root, 'token_usage.json'),
    tokenDailyFile: path.join(root, 'token_daily.json'),
    tokenByRoleFile: path.join(root, 'token_by_role.json'),
    providersFile: path.join(root, 'providers.json'),
    sharesFile: path.join(root, 'shares.json'),
    pushSubscriptionsFile: path.join(root, 'push_subscriptions.json'),
    tunnelConfigFile: path.join(root, 'tunnel-config.json'),
    auxConfigFile: path.join(root, 'aux-config.json'),
    goalConfigFile: path.join(root, 'goal-config.json'),
    providerDefaultsFile: path.join(root, 'provider-defaults.json'),
    scheduledTasksFile: path.join(root, 'scheduled_tasks.json'),
    taskBoardFile: path.join(root, 'task_board.json'),
    // The user's drag-and-drop arrangement of the dir grid and of each fleet's
    // session list. Was per-device (localStorage / SharedPreferences) until it
    // moved here; see src/ui-layout.js.
    uiLayoutFile: path.join(root, 'ui-layout.json'),
    orchestrationDbFile: path.join(root, 'orchestration.sqlite'),
    // Kept as the one-time migration source and explicit rollback export
    // target. Once orchestration.sqlite exists it is the sole live authority.
    orchestrationFile: path.join(root, 'orchestration.json'),
    voiceExamplesFile: path.join(root, 'voice_examples.json'),
    whisperVocabFile: path.join(root, 'whisper_vocab.json'),
  };
}

// Refuse to run destructive test code against a data dir that isn't clearly
// disposable. Throws (rather than returning false) because a wrong answer here
// eats real user state — hard failure is the right blast radius.
function assertTestDir(dir) {
  if (typeof dir !== 'string' || !dir) {
    throw new Error('[multicc/paths] assertTestDir: dir must be a non-empty string');
  }
  const abs = path.resolve(dir);
  const rp = realPathOf(abs);
  if (isHomeOrAbove(rp)) {
    throw new Error(`[multicc/paths] refusing to use ${rp} as test data dir (is $HOME or above)`);
  }
  const pkgRp = realPathOf(PKG_ROOT);
  if (rp === pkgRp) {
    throw new Error(`[multicc/paths] refusing to use the package root (${rp}) as a test data dir`);
  }
  // Repo root check — walk up looking for the outermost .git; refuse anything
  // that isn't strictly inside an OS tmpdir. Cheap and paranoid.
  const tmp = realPathOf(os.tmpdir());
  if (!(rp === tmp || rp.startsWith(tmp + path.sep))) {
    throw new Error(`[multicc/paths] refusing test data dir ${rp}: not under os.tmpdir() (${tmp}); use fs.mkdtemp`);
  }
  return abs;
}

module.exports = {
  createPaths,
  resolveDataDir,
  assertTestDir,
  isHomeOrAbove,
  realPathOf,
  PKG_ROOT,
};
