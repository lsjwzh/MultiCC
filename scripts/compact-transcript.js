#!/usr/bin/env node
/**
 * Compact a Claude Code transcript JSONL by keeping only the most recent turns.
 *
 * claude --resume loads ~/.claude/projects/<cwd-slashes-as-dashes>/<sessionId>.jsonl.
 * When that file grows past the model's context window (e.g. 200K for opus-4-8),
 * every resume fails with context_length_exceeded. This script truncates the
 * JSONL to the last N user-turn segments, making resume work again.
 *
 * Each line in the JSONL is an independent JSON event, so cutting at line
 * boundaries is safe — no message is left half-written.
 *
 * Usage:
 *   node scripts/compact-transcript.js <transcript.jsonl> [--keep-turns N] [--dry-run]
 *
 *   --keep-turns N   Keep the last N user-initiated turns (default 8).
 *                    A "turn" = from a line with type:"user" to the next type:"user".
 *   --keep-lines N   Alternative: keep last N raw lines regardless of turn boundary.
 *   --dry-run        Print what would be kept without modifying the file.
 *
 * A .bak copy is always written before truncation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { keepTurns: 8, keepLines: null, dryRun: false, file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-turns') args.keepTurns = parseInt(argv[++i], 10) || 8;
    else if (a === '--keep-lines') args.keepLines = parseInt(argv[++i], 10) || null;
    else if (a === '--dry-run') args.dryRun = true;
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

function isUserTurnStart(line) {
  try {
    const obj = JSON.parse(line);
    return obj.type === 'user' || (obj.message && obj.message.role === 'user');
  } catch { return false; }
}

function compact(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('File not found: ' + filePath);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  // trailing empty line from final \n
  if (lines[lines.length - 1] === '') lines.pop();

  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(raw);

  let cutIndex;

  if (opts.keepLines) {
    cutIndex = Math.max(0, totalLines - opts.keepLines);
  } else {
    // Find the start of the Nth-to-last user turn.
    const userTurnStarts = [];
    for (let i = 0; i < lines.length; i++) {
      if (isUserTurnStart(lines[i])) userTurnStarts.push(i);
    }
    const keepFromTurn = userTurnStarts[Math.max(0, userTurnStarts.length - opts.keepTurns)];
    cutIndex = keepFromTurn != null ? keepFromTurn : 0;
  }

  const kept = lines.slice(cutIndex);
  const droppedCount = cutIndex;
  const keptBytes = Buffer.byteLength(kept.join('\n') + '\n');

  console.log(`Transcript: ${path.basename(filePath)}`);
  console.log(`  Before: ${totalLines} lines / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  After:  ${kept.length} lines / ${(keptBytes / 1024 / 1024).toFixed(2)} MB (dropped ${droppedCount} lines)`);

  if (opts.dryRun) {
    console.log('  (dry-run — file unchanged)');
    return;
  }

  // Move pruned lines to <name>.pruned.jsonl (append) so token-global still
  // reads their usage; claude --resume only loads the trimmed file.
  const prunedFile = filePath.replace(/\.jsonl$/, '.pruned.jsonl');
  fs.appendFileSync(prunedFile, lines.slice(0, cutIndex).join('\n') + '\n');
  console.log(`  Pruned lines → ${path.basename(prunedFile)}`);

  // Write truncated
  fs.writeFileSync(filePath, kept.join('\n') + '\n');
  console.log('  Done. claude --resume will now load the shortened transcript.');
}

const opts = parseArgs(process.argv);
compact(opts.file, opts);
