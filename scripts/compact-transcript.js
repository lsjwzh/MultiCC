#!/usr/bin/env node
/**
 * Inspect or compact a Claude Code transcript JSONL by hand.
 *
 * `claude --resume` reloads ~/.claude/projects/<sanitised-cwd>/<sessionId>.jsonl,
 * so a transcript that outgrows the context window makes every resume fail with
 * "Prompt is too long". multicc trims transcripts automatically on the way into a
 * turn (src/chat/turn-engine.js → src/chat/transcript-prune.js); this script is the
 * operator's door to the same logic — for looking at a session before touching it,
 * or for fixing one that is already wedged.
 *
 * It deliberately holds NO trimming logic of its own. It used to, and its cut rule
 * ("any entry with role user starts a turn") counted tool results as user turns,
 * which both misplaced the cut and could split a tool_use from its tool_result —
 * a transcript claude then refuses to load. Everything here delegates.
 *
 * Usage:
 *   node scripts/compact-transcript.js <transcript.jsonl>                 # measure only
 *   node scripts/compact-transcript.js <transcript.jsonl> --dry-run       # plan, no write
 *   node scripts/compact-transcript.js <transcript.jsonl> --apply         # trim it
 *   node scripts/compact-transcript.js --cwd <dir> --session <id> [...]   # resolve by session
 *
 *   --apply           Actually rewrite the file (default is measure/dry-run only).
 *   --keep-turns N    Override the lossy-tier ladder with a single rung.
 *   --max-bytes N     High-water mark in bytes (default 2MB, same as the live gate).
 *   --target-bytes N  Byte target the lossy tier aims for (default ~1.2MB).
 *
 * Removed entries are appended to <name>.pruned.jsonl so global token accounting
 * (src/token-global.js walks **\/*.jsonl) still reads their usage.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const prune = require('../src/chat/transcript-prune');

function parseArgs(argv) {
  const args = {
    file: null, cwd: null, session: null, apply: false,
    keepTurns: null, maxBytes: null, targetBytes: null,
  };
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--keep-turns') args.keepTurns = num(argv[++i]);
    else if (a === '--max-bytes') args.maxBytes = num(argv[++i]);
    else if (a === '--target-bytes') args.targetBytes = num(argv[++i]);
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

function main() {
  const args = parseArgs(process.argv);
  let file = args.file;
  if (!file && args.cwd) file = prune.findTranscriptFile(args.cwd, args.session);
  if (!file) {
    console.error('Usage: compact-transcript.js <transcript.jsonl> [--apply] | --cwd <dir> [--session <id>]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('File not found: ' + file);
    process.exit(1);
  }

  const opts = {};
  if (args.maxBytes != null) opts.maxBytes = args.maxBytes;
  if (args.targetBytes != null) opts.targetBytes = args.targetBytes;
  if (args.keepTurns != null) opts.keepTurnsLadder = [args.keepTurns];

  const level = prune.measureFile(file, opts);
  console.log(`Transcript: ${path.basename(file)}`);
  console.log(`  File:      ${level.lines} lines / ${mb(level.fileBytes)}   [${level.status}]`);
  console.log(`  Replayed:  ${level.liveLines} lines / ${mb(level.liveBytes)}`
    + (level.estimatedTokens != null ? `  (~${level.estimatedTokens.toLocaleString()} tokens sent)` : ''));
  console.log(`  Turns:     ${level.liveTurns} live / ${level.realUserTurns} total`
    + ` (${level.substantiveTurns} substantive)`);
  console.log(`  Compacted: ${level.compactBoundary.present
    ? `yes, at line ${level.compactBoundary.atLine}`
      + `${level.compactBoundary.summaryPresent ? ' (summary present)' : ' (NO summary)'}`
    : 'never'}`);
  console.log(`  Largest entry: ${mb(level.largestEntryBytes)}`);
  // The two are independent and the difference is the whole point: a trigger means
  // the next turn will look at the file; the watermark means the context is nearly
  // full, which multicc may well have no lever for.
  console.log(`  Gate:      ${level.triggers.length ? level.triggers.join(', ') : 'not armed'}`
    + `   watermark: ${level.overWatermark ? 'OVER' : 'under'}`
    + ` (${level.thresholds.tokenWatermark.toLocaleString()} tokens)`);

  // force: the operator ran this on purpose, so plan even when under the gate.
  const report = prune.pruneFile(file, { ...opts, force: true, dryRun: !args.apply });
  if (!report) {
    console.log('  Nothing worth trimming (no plan beats the file by a useful margin).');
    return;
  }
  console.log(`  Plan:      ${report.strategy} → ${mb(report.afterBytes)}`
    + ` (${report.droppedLines} lines out, ${report.elidedEntries} entries elided)`);
  if (report.lostTurns > 0) {
    console.log(`  COST:      ${report.lostTurns} replayed turn(s) lost`
      + ` — ${report.lostSubstantiveTurns} of them substantive`
      + `${report.keptSummary ? ", claude's own compact summary kept" : ''}`);
  } else {
    console.log('  COST:      no replayed turn lost'
      + (report.elidedEntries > 0 ? ' (detail inside old tool output only)' : ''));
  }
  if (!args.apply) {
    console.log('  (dry-run — file unchanged; pass --apply to write)');
    return;
  }
  console.log(`  Removed lines → ${path.basename(file).replace(/\.jsonl$/, '.pruned.jsonl')}`);
  console.log('  Done. claude --resume will now load the trimmed transcript.');
  if (report.contextAffected) {
    console.log('  NOTE: a warm `claude -p` process still holds the old context in memory —'
      + ' restart that session\'s stream for this to take effect.');
  }
}

main();
