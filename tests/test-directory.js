'use strict';
// Characterization e2e for the Directory domain (fs/list + directories CRUD +
// push/commit/uncommitted). Spawns an ISOLATED server instance from this repo
// checkout (own PORT; runtime state files are gitignored so the instance boots
// with an empty registry) and exercises every route's happy path + edge cases.
// Run BEFORE and AFTER refactoring — green on both = behavior equivalent.
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

const T = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s]`, ...a);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; log('✅', m); } else { fail++; log('❌', m); } };
const H = { 'Content-Type': 'application/json' };
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let srv;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-dir-'));
const projA = path.join(tmpRoot, 'proj-a');          // pre-created plain dir
const projB = path.join(tmpRoot, 'proj-b');          // created via create:true
fs.mkdirSync(projA, { recursive: true });

(async () => {
  srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', () => {});
  let up = false;
  for (let i = 0; i < 40; i++) {
    const r = await api('GET', '/api/directories').catch(() => ({ status: 0 }));
    if (r.status === 200) { up = true; break; }
    await sleep(500);
  }
  if (!up) { console.error('server did not come up'); process.exit(1); }
  log('isolated server up on', PORT);

  // ── GET /api/fs/list ──
  let r = await api('GET', '/api/fs/list');
  ok(r.status === 200 && r.j.base === os.homedir() && Array.isArray(r.j.entries), 'fs/list no path → home dir listing');
  r = await api('GET', `/api/fs/list?path=${encodeURIComponent(tmpRoot)}`);
  ok(r.status === 200 && r.j.base === tmpRoot && r.j.entries.some(e => e.name === 'proj-a'), 'fs/list exact dir → subdirs');
  r = await api('GET', `/api/fs/list?path=${encodeURIComponent(path.join(tmpRoot, 'proj-'))}`);
  ok(r.status === 200 && r.j.base === tmpRoot && r.j.entries.length === 1 && r.j.entries[0].name === 'proj-a', 'fs/list partial → prefix completion');
  r = await api('GET', `/api/fs/list?path=${encodeURIComponent('/nonexistent-xyz/abc')}`);
  ok(r.status === 200 && r.j.entries.length === 0, 'fs/list missing parent → empty entries');
  r = await api('GET', `/api/fs/list?path=${encodeURIComponent('~')}`);
  ok(r.status === 200 && r.j.base === os.homedir(), 'fs/list tilde expansion');

  // ── POST /api/directories ──
  r = await api('POST', '/api/directories', { name: 'x' });
  ok(
    r.status === 400 &&
      r.j.code === 'invalid' &&
      r.j.error === 'name and path required',
    'POST missing path → 400 with stable error code',
  );
  r = await api('POST', '/api/directories', { name: 'home', path: os.homedir() });
  ok(r.status === 400 && r.j.error === '不允许选择 $HOME 或更高层目录', 'POST home dir → 400');
  r = await api('POST', '/api/directories', { name: 'nope', path: path.join(tmpRoot, 'missing') });
  ok(r.status === 400 && /path does not exist/.test(r.j.error), 'POST missing path without create → 400');
  r = await api('POST', '/api/directories', { name: 'A', path: projA });
  ok(r.status === 200 && r.j.id && r.j.path === fs.realpathSync(projA) || (r.j.path === projA), 'POST register existing dir → 200');
  const dirA = r.j;
  r = await api('POST', '/api/directories', { name: 'A2', path: projA });
  ok(r.status === 400 && /该路径已被目录/.test(r.j.error), 'POST duplicate path → 400');
  r = await api('POST', '/api/directories', { name: 'B', path: projB, create: true });
  ok(r.status === 200 && r.j.id, 'POST create:true → mkdir + register');
  const dirB = r.j;
  ok(fs.existsSync(path.join(projB, '.git')), 'registered dir auto git-initialised');

  // ── GET /api/directories ──
  r = await api('GET', '/api/directories');
  const listA = Array.isArray(r.j) ? r.j.find(d => d.id === dirA.id) : null;
  ok(r.status === 200 && !!listA, 'GET list contains registered dir');
  ok(listA && listA.counts && typeof listA.counts.claude_chat === 'number', 'list entry has session counts');
  ok(listA && listA.counts.claude_chat >= 1, 'commander chat session auto-seeded on create');
  ok(listA && listA.pushState && typeof listA.pushState === 'object', 'list entry has pushState');

  // ── PATCH /api/directories/:id ──
  r = await api('PATCH', '/api/directories/no-such-id', { name: 'x' });
  ok(r.status === 404, 'PATCH unknown id → 404');
  r = await api('PATCH', `/api/directories/${dirA.id}`, { name: 'A-renamed' });
  ok(r.status === 200 && r.j.name === 'A-renamed', 'PATCH rename works');
  r = await api('PATCH', `/api/directories/${dirA.id}`, { path: path.join(tmpRoot, 'missing') });
  ok(r.status === 400 && /path does not exist/.test(r.j.error), 'PATCH to missing path → 400');
  r = await api('PATCH', `/api/directories/${dirA.id}`, { path: projB });
  ok(r.status === 400 && /该路径已被目录/.test(r.j.error), 'PATCH to duplicate path → 400');
  r = await api('PATCH', `/api/directories/${dirA.id}`, { rolePrompt: '角色X' });
  ok(r.status === 200 && r.j.rolePrompt === '角色X', 'PATCH set rolePrompt');
  r = await api('PATCH', `/api/directories/${dirA.id}`, { rolePrompt: '' });
  ok(r.status === 200 && r.j.rolePrompt === null, 'PATCH clear rolePrompt → null');

  // ── uncommitted / commit ──
  r = await api('GET', `/api/directories/${dirA.id}/uncommitted`);
  ok(r.status === 200 && Array.isArray(r.j.files) && r.j.files.length === 0, 'uncommitted on clean tree → []');
  fs.writeFileSync(path.join(projA, 'newfile.txt'), 'hello');
  r = await api('GET', `/api/directories/${dirA.id}/uncommitted`);
  ok(r.status === 200 && r.j.files.some(f => f.path === 'newfile.txt' && f.status === '??'), 'uncommitted lists new file with ?? status');
  r = await api('POST', `/api/directories/${dirA.id}/commit`, {});
  ok(r.status === 200 && r.j.ok === true && r.j.committed === true, 'commit dirty tree → committed:true');
  r = await api('POST', `/api/directories/${dirA.id}/commit`, {});
  ok(r.status === 200 && r.j.ok === true && r.j.committed === false, 'commit clean tree → committed:false');
  r = await api('GET', `/api/directories/no-such/uncommitted`);
  ok(r.status === 404, 'uncommitted unknown dir → 404');

  // ── push (no remote configured → error) ──
  r = await api('POST', `/api/directories/${dirA.id}/push`);
  ok(r.status === 400 && typeof r.j.error === 'string', 'push without remote → 400 with error');
  r = await api('POST', `/api/directories/no-such/push`);
  ok(r.status === 404, 'push unknown dir → 404');

  // ── DELETE ──
  r = await api('DELETE', `/api/directories/no-such-id`);
  ok(r.status === 404, 'DELETE unknown id → 404');
  r = await api('DELETE', `/api/directories/${dirA.id}`);
  ok(r.status === 400 && /session\(s\); pass \?force=1/.test(r.j.error) && Array.isArray(r.j.sessions), 'DELETE with sessions, no force → 400 + session list');
  r = await api('DELETE', `/api/directories/${dirA.id}?force=1`);
  ok(r.status === 200 && r.j.ok === true && r.j.removedSessions >= 1, 'DELETE force → ok + removedSessions');
  r = await api('GET', '/api/directories');
  ok(r.status === 200 && !r.j.find(d => d.id === dirA.id), 'deleted dir gone from list');
  r = await api('DELETE', `/api/directories/${dirB.id}?force=1`);
  ok(r.status === 200 && r.j.ok === true, 'cleanup dir B');

  log(`\n== directory domain: ${pass} passed, ${fail} failed ==`);
  shutdown(fail ? 1 : 0);
})().catch(e => { console.error(e); shutdown(1); });

function shutdown(code) {
  try { srv && srv.kill('SIGTERM'); } catch {}
  // isolated instance state files live in the repo checkout (gitignored) — remove
  // so repeated runs always start from an empty registry.
  for (const f of ['sessions.json', 'directories.json', 'events', 'chat_history']) {
    try { fs.rmSync(path.join(ROOT, f), { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(code), 300);
}
