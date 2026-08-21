'use strict';
// Unit tests for src/state-store.js + src/state-tx.js + src/paths.js.
// Every test that mutates disk uses fs.mkdtemp under os.tmpdir() and calls
// paths.assertTestDir() to defence-in-depth against a runaway wiping the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeJsonAtomic, readJson, recoverFromBackup, createStore, CorruptedStateError,
} = require('../src/state-store');
const { commitCrossFileWrite, replayJournals } = require('../src/state-tx');
const paths = require('../src/paths');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}
function tmpDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-store-${label}-`));
  paths.assertTestDir(d);
  return d;
}

(async () => {
  // ── paths.assertTestDir refuses dangerous locations ─────────────────
  {
    let threw = false;
    try { paths.assertTestDir(os.homedir()); } catch (_) { threw = true; }
    ok(threw, 'assertTestDir refuses $HOME');
    threw = false;
    try { paths.assertTestDir('/'); } catch (_) { threw = true; }
    ok(threw, 'assertTestDir refuses /');
    threw = false;
    try { paths.assertTestDir(paths.PKG_ROOT); } catch (_) { threw = true; }
    ok(threw, 'assertTestDir refuses the package root');
    threw = false;
    try { paths.assertTestDir(path.join(os.homedir(), 'projects', 'foo')); } catch (_) { threw = true; }
    ok(threw, 'assertTestDir refuses non-tmpdir paths (defence in depth)');
    const d = tmpDir('guard');
    ok(paths.assertTestDir(d) === d, 'assertTestDir accepts a fresh mkdtemp path');
    const missingChild = path.join(d, 'not-created-yet');
    ok(paths.assertTestDir(missingChild) === path.resolve(missingChild),
      'assertTestDir accepts a missing child under a real temp directory');
  }

  // ── createPaths ─────────────────────────────────────────────────────
  {
    const d = tmpDir('pathsdir');
    const p = paths.createPaths({ dataDir: d });
    ok(p.sessionsFile === path.join(d, 'sessions.json'), 'createPaths: sessionsFile under override');
  ok(p.directoriesFile === path.join(d, 'directories.json'), 'createPaths: directoriesFile under override');
  ok(p.fleetSharesFile === path.join(d, 'fleet-shares.json'), 'createPaths: fleetSharesFile under override');
  ok(p.externalFleetsFile === path.join(d, 'external-fleets.json'), 'createPaths: externalFleetsFile under override');
    ok(p.journalDir === path.join(d, '.journal'), 'createPaths: journalDir under override');
    ok(p.bridgesDir === path.join(d, 'bridges'), 'createPaths: bridgesDir under override');
    ok(p.detachedDir === path.join(d, 'detached'), 'createPaths: detached evidence under override');
    ok(p.scheduledTasksFile === path.join(d, 'scheduled_tasks.json'), 'createPaths: cron store under override');
    ok(p.orchestrationDbFile === path.join(d, 'orchestration.sqlite'), 'createPaths: SQLite orchestration store under override');
    ok(p.orchestrationFile === path.join(d, 'orchestration.json'), 'createPaths: orchestration store under override');
    ok(p.voiceExamplesFile === path.join(d, 'voice_examples.json'), 'createPaths: voice examples under override');
    ok(p.whisperVocabFile === path.join(d, 'whisper_vocab.json'), 'createPaths: whisper vocab under override');
  }

  // ── writeJsonAtomic + readJson ──────────────────────────────────────
  {
    const d = tmpDir('atomic');
    const f = path.join(d, 'x.json');
    writeJsonAtomic(f, { a: 1 }, { kind: 'test', schemaVersion: 1 });
    const r = readJson(f);
    ok(r.present && r.data.a === 1 && r.envelope.kind === 'test' && r.envelope.version === 1,
       'writeJsonAtomic → readJson roundtrip');
    // Envelope on disk carries writtenAt
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(typeof raw.__multiccSchema.writtenAt === 'string', 'envelope carries writtenAt');
  }

  // ── rolling backups ────────────────────────────────────────────────
  {
    const d = tmpDir('backup');
    const f = path.join(d, 'x.json');
    writeJsonAtomic(f, { v: 1 });
    writeJsonAtomic(f, { v: 2 });
    writeJsonAtomic(f, { v: 3 });
    writeJsonAtomic(f, { v: 4 });
    ok(readJson(f).data.v === 4, 'latest write wins');
    ok(readJson(f + '.bak1').data.v === 3, 'bak1 holds previous');
    ok(readJson(f + '.bak2').data.v === 2, 'bak2 holds two ago');
    ok(readJson(f + '.bak3').data.v === 1, 'bak3 holds three ago');
    ok(!fs.existsSync(f + '.bak4'), 'default keep=3, no bak4');
  }

  // ── corruption → CorruptedStateError, recovery from backup ─────────
  {
    const d = tmpDir('corrupt');
    const f = path.join(d, 'x.json');
    writeJsonAtomic(f, { v: 'ok1' });
    writeJsonAtomic(f, { v: 'ok2' });
    // Truncate the primary to simulate a torn write / disk corruption.
    fs.writeFileSync(f, '{"__multiccSchema":{"version":1,"kind":"');
    let threw = false, e0;
    try { readJson(f); } catch (e) { threw = true; e0 = e; }
    ok(threw && e0 instanceof CorruptedStateError, 'corrupt primary throws CorruptedStateError');

    const rec = recoverFromBackup(f);
    ok(rec.present && rec.data.v === 'ok1' && rec.recoveredFrom.endsWith('.bak1'),
      'recoverFromBackup finds latest backup');

    // createStore.loadOrRecover falls through to backup on corruption
    const store = createStore({ file: f, kind: 'test' });
    const loaded = store.loadOrRecover();
    ok(loaded.present && loaded.data.v === 'ok1' && loaded.recovered, 'createStore.loadOrRecover recovers');
  }

  // ── fail-closed when even backups are gone ─────────────────────────
  {
    const d = tmpDir('failclosed');
    const f = path.join(d, 'x.json');
    fs.writeFileSync(f, '{not: json');   // corrupt primary
    const store = createStore({ file: f, kind: 'test' });
    let threw = false;
    try { store.loadOrRecover(); } catch (e) { threw = e instanceof CorruptedStateError; }
    ok(threw, 'fail-closed: no backups + corrupt primary → CorruptedStateError');
  }

  // ── legacy bare-array is unwrapped when opt-in ─────────────────────
  {
    const d = tmpDir('legacy');
    const f = path.join(d, 'x.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    const r = readJson(f, { legacyIsArray: true });
    ok(r.present && Array.isArray(r.data) && r.data.length === 2, 'legacy bare-array is accepted with opt-in');
    let threw = false;
    try { readJson(f); } catch (_) { threw = true; }
    ok(threw, 'legacy bare-array is corruption when NOT opted in');
  }

  // ── cross-file transaction: both files land together ───────────────
  {
    const d = tmpDir('tx-happy');
    const dirs = path.join(d, 'directories.json');
    const sess = path.join(d, 'sessions.json');
    const jrn = path.join(d, '.journal');
    writeJsonAtomic(dirs, [{ id: 'd1' }, { id: 'd2' }]);
    writeJsonAtomic(sess, [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd2' }]);
    commitCrossFileWrite({
      journalDir: jrn,
      kind: 'delete-directory',
      files: [
        { path: dirs, payload: [{ id: 'd2' }], kind: 'directories' },
        { path: sess, payload: [{ id: 's2', dirId: 'd2' }], kind: 'sessions' },
      ],
    });
    const rd = readJson(dirs);
    const rs = readJson(sess);
    ok(rd.data.length === 1 && rd.data[0].id === 'd2', 'tx: directories.json shows post-delete state');
    ok(rs.data.length === 1 && rs.data[0].id === 's2', 'tx: sessions.json shows post-delete state');
    // Journal file is cleaned up after success
    const remaining = fs.readdirSync(jrn).filter(n => /^tx-/.test(n));
    ok(remaining.length === 0, 'tx: journal cleared after success');
  }

  // ── replay: crash between journal write and file writes ────────────
  {
    const d = tmpDir('tx-replay');
    const dirs = path.join(d, 'directories.json');
    const sess = path.join(d, 'sessions.json');
    const jrn = path.join(d, '.journal');
    // Simulate: journal written, but the file writes never landed. We write a
    // journal by hand and check replayJournals() finishes the job.
    fs.mkdirSync(jrn, { recursive: true });
    const entry = {
      id: 'deadbeefdeadbeef', kind: 'delete-directory', ts: 1,
      files: [
        { path: dirs, payload: [{ id: 'd3' }], kind: 'directories' },
        { path: sess, payload: [{ id: 's3', dirId: 'd3' }], kind: 'sessions' },
      ],
    };
    writeJsonAtomic(path.join(jrn, `tx-${entry.id}.json`), entry, { rotate: 0, kind: 'state-tx-journal' });
    const stats = replayJournals(jrn);
    ok(stats.replayed === 1 && stats.skipped === 0, 'replay: one journal replayed');
    ok(readJson(dirs).data[0].id === 'd3', 'replay: directories.json updated to intended state');
    ok(readJson(sess).data[0].id === 's3', 'replay: sessions.json updated to intended state');
    const leftover = fs.readdirSync(jrn).filter(n => /^tx-/.test(n));
    ok(leftover.length === 0, 'replay: journal cleared');
  }

  // ── replay: corrupt journal moves aside without blocking boot ──────
  {
    const d = tmpDir('tx-corrupt');
    const jrn = path.join(d, '.journal');
    fs.mkdirSync(jrn, { recursive: true });
    fs.writeFileSync(path.join(jrn, 'tx-badjournal.json'), '{not json');
    const stats = replayJournals(jrn);
    ok(stats.replayed === 0 && stats.skipped === 1, 'replay: corrupt journal skipped');
    ok(fs.existsSync(path.join(jrn, 'broken')), 'replay: corrupt journal moved to broken/');
    ok(!fs.existsSync(path.join(jrn, 'tx-badjournal.json')), 'replay: corrupt journal removed from main dir');
  }

  console.log(`\n== state-store unit: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
