'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, token } = require('./production-entry');

const synthetic = 'synthetic-vault-value';
const who = { 'x-forwarded-for': '192.0.2.1' };
const headers = { ...who, 'x-access-token': token };
const names = ['A', 'a', 'old.name', '_key', '-old', 'ch', 'cz', 'd', 'Z0', 'z9'];
const entries = [
  ...names.map(name => ({ name, value: synthetic, source: '', createdAt: 0 })),
  { name: 'old.name', value: synthetic, description: '设'.repeat(510), source: 'x'.repeat(75),
    updatedAt: '2026-11-20', updatedBy: 'u'.repeat(140) },
  { name: 'invalid name', value: synthetic }, { name: 'invalidValue', value: null },
  null, { name: 42, value: synthetic },
];

async function sample(dir, gateway, addon, reference, locale) {
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const file = path.join(data, 'secrets.json');
  const audit = path.join(data, 'logs/secret-audit.jsonl');
  fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  const launch = () => start(dir, gateway, addon, reference, false, undefined, { LC_ALL: locale, LANG: locale });
  let server = await launch();
  try {
    const get = (options = {}) => fetch(server.origin + '/api/secrets', {
      headers, redirect: 'manual', signal: AbortSignal.timeout(5000), ...options,
    });
    const count = () => fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line)).filter(r => r.operation === 'list' && r.source === 'http') : [];
    const denied = await get({ headers: who });
    assert.equal(denied.status, 403);
    assert.equal(count().length, 0);
    const result = await get();
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.ok(!body.includes(synthetic));
    const rows = JSON.parse(body);
    assert.equal(rows.length, names.length + 1);
    assert.deepEqual(rows.find(r => r.name === 'old.name'), { name: 'old.name', description: '设'.repeat(500),
      source: 'x'.repeat(64), createdAt: null, updatedAt: '2026-11-20', updatedBy: 'u'.repeat(128) });
    const head = await get({ method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const etag = result.headers.get('etag');
    assert.ok(etag && head.headers.get('etag') === etag);
    const fresh = await get({ headers: { ...headers, 'if-none-match': etag, 'cache-control': 'max-age=0' } });
    assert.equal(fresh.status, 304);
    const events = count();
    assert.equal(events.length, 6);
    for (let i = 0; i < events.length; i += 2) {
      assert.equal(events[i].phase, 'started');
      assert.equal(events[i + 1].outcome, 'succeeded');
      assert.equal(events[i].callId, events[i + 1].callId);
      assert.deepEqual(events[i].names, []);
    }
    assert.ok(!fs.readFileSync(audit, 'utf8').includes(synthetic));
    fs.renameSync(audit, audit + '.saved');
    fs.mkdirSync(audit);
    const failed = await get();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, 'rust_backend_unavailable');
    fs.rmdirSync(audit);
    fs.writeFileSync(file, '{');
    assert.equal(await (await get()).text(), body, 'running process retains its loaded catalog');
    await server.stop();
    server = null;
    server = await launch();
    assert.deepEqual(await (await get()).json(), []);
    return { body, etag };
  } finally { if (server) await server.stop(); }
}

(async () => {
  const [gateway, addon] = process.argv.slice(2).map(s => path.resolve(s));
  assert.ok(gateway && addon, 'expected gateway and reference addon');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-vault-list-'));
  try {
    for (const locale of ['en_US.UTF-8', 'cs_CZ.UTF-8']) {
      const oracle = await sample(path.join(dir, locale, 'node'), gateway, addon, true, locale);
      const rust = await sample(path.join(dir, locale, 'rust'), gateway, addon, false, locale);
      assert.deepEqual(rust, oracle, locale);
      console.log(locale, 'metadata bytes, auth, HEAD, conditional GET, audit failure and restart matched');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
