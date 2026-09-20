'use strict';

// ── One-time consolidation of cron fan-out residue (data from releases <= 2.0.2) ──
//
// Before a schedule owned one fixed Air task, a firing was delivered into a
// reusable ⏰ chat session and the task classifier tagged each delivery as its
// own board task: `origin: 'session'`, `recordType: 'observed'`, title = the
// rule prompt truncated to the board's 40-char title limit, and no
// conversation binding of its own. A board that has been upgraded in place
// therefore carries one such task per firing — hundreds of near-duplicates of
// a single schedule.
//
// `./multicc update` records the version it is upgrading from in
// `.multicc_upgrade` right before restarting the new process. The first boot
// after that update archives exactly those tasks (archive, never merge: a
// rule's fixed task is task-shell identity and cannot be a merge target) and
// writes an applied marker, so the pass never rescans.
//
// Everything here is best-effort: a failure is logged and reported but must
// never keep the server from becoming ready. Detection is deliberately
// conservative — the cost of leaving one stale copy on the board is far lower
// than the cost of archiving a task the user is actually working on.

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('../../src/runtime-security');
const { PKG_ROOT } = require('../../src/paths');

const MIGRATION_ID = 'cron-fanout-cleanup';
const SCHEMA_VERSION = 1;
// Residue can exist in data written by any release at or below this version.
const AFFECTED_CEILING = '2.0.2';
const UPGRADE_MARKER = '.multicc_upgrade';
const REPORT_RELATIVE = path.join('logs', 'cron-fanout-cleanup.log');
// Shorter titles are not evidence: a rule's display name can be a few chars and
// an 8-char prefix of a long prompt is plausible as a hand-written task title.
// Measured residue titles are 14-40 chars; genuine tasks also carry a
// conversation binding, a shell owner or a dispatch route, which is what
// actually separates them from the pile.
const MIN_TITLE = 12;
// A matcher bug must not be able to archive an unbounded number of tasks.
const MAX_CANDIDATES = 5000;
const MAX_LISTED_RULES = 10;

function collapse(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value == null ? '' : value));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// true/false when the recorded version is readable, null when it is not.
function mayContainResidue(fromVersion) {
  const parsed = parseVersion(fromVersion);
  if (!parsed) return null;
  return compareVersions(parsed, parseVersion(AFFECTED_CEILING)) <= 0;
}

// The manager records the version being upgraded from; the installer records
// the release it installed. Either one answers "was this data written by an
// affected release?".
function readUpgradeEvidence(pkgRoot = PKG_ROOT, dataDir = null) {
  // The manager writes into the checkout; an install with a custom data root
  // (isolated instances, tests) keeps its own copy next to its state.
  const roots = [pkgRoot, dataDir].filter((root, index, all) => root && all.indexOf(root) === index);
  for (const root of roots) for (const name of [UPGRADE_MARKER, path.join('logs', UPGRADE_MARKER)]) {
    try {
      const parsed = parseVersion(fs.readFileSync(path.join(root, name), 'utf8'));
      if (parsed) return { fromVersion: parsed.join('.'), source: UPGRADE_MARKER };
    } catch (_) { /* not written by this install */ }
  }
  for (const root of roots) {
    try {
      const match = /^#\s*installed:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, '.multicc_channel'), 'utf8'));
      const parsed = match && parseVersion(match[1]);
      if (parsed) return { fromVersion: parsed.join('.'), source: '.multicc_channel' };
    } catch (_) { /* dev checkout without an installer channel file */ }
  }
  return { fromVersion: null, source: 'unknown' };
}

function titleMatchesRule(title, rule) {
  const name = collapse(rule?.name);
  if (name.length >= MIN_TITLE && title === name) return 'name';
  const prompt = collapse(rule?.prompt);
  if (title.length >= MIN_TITLE && prompt.length > title.length && prompt.startsWith(title)) return 'prompt';
  return null;
}

// Pure candidate selection over the board and the schedule store. Every guard
// below is a "this is somebody's real task" signal: a rule's fixed task, a
// task owned by a live shell, a task bound to a conversation, or a dispatched
// task. Fan-out residue has none of them.
function collectResidue(tasks = [], rules = []) {
  const bound = new Set(rules.map(rule => rule?.taskId).filter(Boolean));
  const archive = [];
  for (const task of tasks) {
    if (!task || !task.id) continue;
    if (task.status === 'archived' || task.deleting) continue;
    if (bound.has(task.id)) continue;
    if (task.origin !== 'session' || task.recordType !== 'observed') continue;
    if (task.ownerShellId || task.chatSessionId || task.routing) continue;
    const title = collapse(task.title);
    let rule = null;
    let matched = null;
    for (const candidate of rules) {
      matched = titleMatchesRule(title, candidate);
      if (matched) { rule = candidate; break; }
    }
    if (!matched) continue;
    archive.push({ taskId: task.id, ruleId: rule.id, ruleName: rule.name || '', title, matched });
    if (archive.length > MAX_CANDIDATES) return { archive, overflow: true };
  }
  return { archive, overflow: false };
}

function readApplied(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}

function writeApplied(file, value) {
  try { atomicWriteJson(file, value); return true; }
  catch (error) {
    console.error('[multicc/cron] fan-out cleanup marker write failed:', error.message);
    return false;
  }
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
}

// The report is written by every pass that actually ran (including the ones
// that found nothing), so `./multicc update` can print it and move on instead
// of waiting for the slow path. It deletes the file after printing, and clears
// any stale copy before the restart, so what a user reads is always this run's.
function reportLines(summary) {
  const origin = summary.fromVersion ? `upgraded from ${summary.fromVersion}` : 'version unknown';
  if (summary.status === 'already_applied') {
    const when = summary.appliedAt ? ` on ${new Date(summary.appliedAt).toISOString()}` : '';
    return `Cron task fan-out cleanup: already applied${when}; nothing to do.\n`;
  }
  const head = `Cron task fan-out cleanup (${origin}): archived ${summary.archivedCount} stale scheduled-task copy/copies`
    + ` from ${summary.ruleCount} rule(s), ${summary.failures.length} skipped.`;
  const lines = [head];
  if (summary.status === 'archive_unavailable') {
    lines.push('  Task board archive port unavailable; the pass will retry on the next start.');
  }
  for (const [ruleId, entry] of Object.entries(summary.byRule || {}).slice(0, MAX_LISTED_RULES)) {
    lines.push(`  - ${ruleId} ${entry.name}: ${entry.count}`);
  }
  return lines.join('\n') + '\n';
}

function writeReport(report, summary, logger = console) {
  try {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, reportLines(summary), { mode: 0o600 });
  } catch (error) {
    logger.error('[multicc/cron] fan-out cleanup report write failed:', error?.message || error);
  }
}

// Archive in one pass. Returns a summary; never throws.
async function run(options = {}) {
  const {
    dataDir, tasks = [], rules = [], archiveTasks,
    fromVersion, versionSource, pkgRoot = PKG_ROOT, logger = console,
    markerFile, reportFile, readEvidence = readUpgradeEvidence,
    now = () => Date.now(), force = false, version = null,
  } = options;
  const startedAt = now();
  const summary = {
    ok: true, migration: MIGRATION_ID, schemaVersion: SCHEMA_VERSION,
    status: 'noop', at: new Date(startedAt).toISOString(), appVersion: version,
    fromVersion: null, versionEvidence: 'unknown', ruleCount: 0, archivedCount: 0,
    byRule: {}, archived: [], failures: [], error: null,
  };
  try {
    if (!dataDir) throw new Error('dataDir is required');
    const appliedFile = markerFile || path.join(dataDir, 'cron_fanout_migration.json');
    const report = reportFile || path.join(pkgRoot, REPORT_RELATIVE);
    const applied = readApplied(appliedFile);
    if (applied?.applied && !force) {
      summary.status = 'already_applied';
      summary.appliedAt = applied.appliedAt || null;
      writeReport(report, summary, logger);
      return summary;
    }
    const evidence = fromVersion === undefined
      ? readEvidence(pkgRoot, dataDir)
      : { fromVersion, source: versionSource || 'injected' };
    summary.fromVersion = evidence.fromVersion;
    summary.versionEvidence = evidence.source;
    if (mayContainResidue(evidence.fromVersion) === false) {
      summary.status = 'version_not_affected';
      removeQuietly(report);
      writeApplied(appliedFile, { ...summary, applied: true, appliedAt: startedAt });
      logger.log(`[multicc/cron] fan-out cleanup skipped: data comes from ${evidence.fromVersion} (> ${AFFECTED_CEILING})`);
      return summary;
    }
    const { archive, overflow } = collectResidue(tasks, rules);
    if (overflow) {
      summary.status = 'refused_overflow';
      summary.error = `more than ${MAX_CANDIDATES} candidates — refusing to archive`;
      logger.error(`[multicc/cron] fan-out cleanup ${summary.error}`);
      writeApplied(appliedFile, { ...summary, applied: true, appliedAt: startedAt, applied: false });
      removeQuietly(report);
      return summary;
    }
    const ids = archive.map(entry => entry.taskId);
    const byRule = {};
    for (const entry of archive) {
      byRule[entry.ruleId] ||= { name: entry.ruleName, count: 0 };
      byRule[entry.ruleId].count++;
    }
    summary.ruleCount = Object.keys(byRule).length;
    summary.byRule = byRule;
    let outcome = { archived: [], skipped: [] };
    if (ids.length) {
      outcome = typeof archiveTasks === 'function' ? ((await archiveTasks(ids)) || outcome) : null;
      // Without a working port nothing was archived: leave the applied marker
      // unset so the next boot retries instead of silently reporting success.
      if (!outcome) {
        summary.status = 'archive_unavailable';
        summary.error = 'task board archive port is unavailable';
        summary.failures = ids.map(taskId => ({ taskId, error: 'archive_port_unavailable' }));
        logger.error('[multicc/cron] fan-out cleanup could not archive:', summary.error);
        writeReport(report, summary, logger);
        return summary;
      }
    }
    summary.archived = outcome.archived || [];
    summary.archivedCount = summary.archived.length;
    summary.failures = outcome.skipped || [];
    summary.status = !ids.length ? 'no_residue' : (summary.archivedCount ? 'archived' : 'archive_failed');
    writeApplied(appliedFile, { ...summary, applied: true, appliedAt: startedAt });
    writeReport(report, summary, logger);
    logger.log(`[multicc/cron] fan-out cleanup ${summary.status}: archived ${summary.archivedCount} of ${ids.length} candidate(s)`
      + ` across ${summary.ruleCount} rule(s)${summary.failures.length ? `, ${summary.failures.length} skipped` : ''}`);
    return summary;
  } catch (error) {
    summary.ok = false;
    summary.error = error?.message || String(error);
    logger.error('[multicc/cron] fan-out cleanup failed:', summary.error);
    return summary;
  }
}

module.exports = {
  MIGRATION_ID, SCHEMA_VERSION, AFFECTED_CEILING, MAX_CANDIDATES,
  collapse, parseVersion, compareVersions, mayContainResidue,
  readUpgradeEvidence, titleMatchesRule, collectResidue, run,
};
