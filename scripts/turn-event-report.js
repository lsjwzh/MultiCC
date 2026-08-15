#!/usr/bin/env node
'use strict';

// Forensic report for the turn event journal (#110): derive per-tool timing
// from a session's journal lines and, when the persisted history blob exists,
// diff it against the derived ground truth. Usage:
//
//   node scripts/turn-event-report.js <sessionId> [--dir <dataDir>]
//
// Exit 0 = parity (or no blob to compare); exit 1 = mismatches found.

const fs = require('fs');
const path = require('path');

const { resolveDataDir } = require('../src/paths');
const { deriveToolTiming, diffToolTiming } = require('../src/chat/turn-event-replay');

function main(argv) {
  const sessionId = argv.find(a => !a.startsWith('--'));
  if (!sessionId) {
    console.error('usage: node scripts/turn-event-report.js <sessionId> [--dir <dataDir>]');
    process.exit(2);
  }
  const dirFlag = argv.indexOf('--dir');
  const dataDir = dirFlag !== -1 && argv[dirFlag + 1] ? argv[dirFlag + 1] : resolveDataDir();
  const journalDir = path.join(dataDir, 'chat_history', 'turn-events');
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');

  // Read all generations, oldest first, so seq is ascending across files.
  const generations = ['.2', '.1', ''].filter(suf => {
    try { return fs.statSync(path.join(journalDir, safe + '.events.jsonl' + suf)).isFile(); }
    catch (_) { return false; }
  });
  const records = [];
  for (const suf of generations) {
    const raw = fs.readFileSync(path.join(journalDir, safe + '.events.jsonl' + suf), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch (_) { break; }
    }
  }
  if (records.length === 0) {
    console.log(`no journal for ${sessionId} (expected at ${journalDir}/${safe}.events.jsonl)`);
    process.exit(2);
  }
  const derived = deriveToolTiming(records);
  console.log(`journal: ${generations.length} generation(s), ${records.length} events, ${derived.length} tools derived`);
  for (const t of derived) {
    const dur = t.endedAt === null ? 'running/unknown' : (t.endedAt - t.startedAt) + 'ms';
    console.log(`  ${String(t.id).padEnd(24)} ${t.name.padEnd(18)} ${dur}${t.isError ? ' [error]' : ''}`);
  }

  const blobPath = path.join(dataDir, 'chat_history', sessionId + '.json');
  let blobTools = null;
  try {
    const blob = JSON.parse(fs.readFileSync(blobPath, 'utf8'));
    const messages = Array.isArray(blob) ? blob : (Array.isArray(blob.messages) ? blob.messages : []);
    blobTools = [];
    for (const m of messages) if (Array.isArray(m.tools)) blobTools.push(...m.tools);
  } catch (_) {
    console.log(`blob: none at ${blobPath} (parity skipped)`);
  }
  if (blobTools) {
    const mismatches = diffToolTiming(derived, blobTools);
    console.log(`blob parity: ${blobTools.length} tools in blob, ${mismatches.length} mismatch(es)`);
    for (const m of mismatches) console.log(`  ${m.kind} ${m.id}${m.name ? ' (' + m.name + ')' : ''}`);
    process.exit(mismatches.length ? 1 : 0);
  }
  process.exit(0);
}

main(process.argv.slice(2));
