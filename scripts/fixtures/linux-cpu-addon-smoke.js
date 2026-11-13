'use strict';

// Executed by the actual shipped Node under QEMU, never by the host Node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
console.log('正在加载原生模块');
const addon = require(path.resolve(process.argv[2]));
assert.equal(addon.protocolVersion(), 1);
assert.match(addon.sqliteVersion(), /^3\./);
console.log('原生模块已加载，正在验证 SQLite');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cpu-sqlite-'));
try {
  for (const encoding of ['UTF-8', 'UTF-16le']) {
    const file = path.join(root, `${encoding}.sqlite`);
    let db = new addon.RustDatabase(file, false, false, 5000);
    try {
      db.exec(`PRAGMA encoding='${encoding}'; PRAGMA journal_mode=WAL;
        CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT, payload BLOB);
        CREATE VIRTUAL TABLE search USING fts5(body);`);
      const query = (sql, values = []) => db.query(sql, values, {}, 2).rows;
      // SQLite's decimal parser used an unguarded AVX2 zero-scanning loop in
      // the affected release. Exercise vector-width boundaries and long input.
      for (const length of [0, 15, 16, 31, 32, 33, 63, 64, 256, 4096]) {
        for (const sign of ['', '-']) {
          const decimal = `${sign}${'0'.repeat(length)}42`;
          assert.deepEqual(query('SELECT CAST(? AS INTEGER)', [decimal]), [[sign ? -42 : 42]]);
          assert.deepEqual(query(`SELECT ${decimal}`), [[sign ? -42 : 42]]);
        }
      }
      const payload = Buffer.alloc(16384, 0x5a);
      db.query('INSERT INTO records(body,payload) VALUES (?,?)', ['baseline sqlite', payload], {}, 0);
      db.exec("INSERT INTO search(body) VALUES ('baseline sqlite');");
      assert.deepEqual(query("SELECT body FROM search WHERE search MATCH 'sqlite'"), [['baseline sqlite']]);
      assert.deepEqual(query('SELECT length(payload) FROM records'), [[payload.length]]);
      assert.deepEqual(Buffer.from(query('SELECT payload FROM records')[0][0]), payload);
      const transaction = db.begin('IMMEDIATE');
      db.exec("UPDATE records SET body='rolled back'");
      db.finish(transaction, false);
      assert.deepEqual(query('SELECT body FROM records'), [['baseline sqlite']]);
      db.close();
      db = new addon.RustDatabase(file, false, true, 5000);
      assert.deepEqual(query('SELECT body FROM records'), [['baseline sqlite']]);
      db.exec('DELETE FROM records; VACUUM');
      assert.deepEqual(query('SELECT count(*) FROM records'), [[0]]);
    } finally {
      db.close();
    }
  }
  const store = new addon.RustTaskStore(':memory:');
  try {
    store.run(JSON.stringify({ op: 'set', kind: 'task', id: 'cpu-smoke', body: JSON.stringify({ id: 'cpu-smoke' }) }));
    assert.equal(JSON.parse(store.run('{"op":"get","kind":"task","id":"cpu-smoke"}')).id, 'cpu-smoke');
  } finally {
    store.run('{"op":"close"}');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('原生模块、SQLite 数字解析、事务、全文检索和任务存储验证通过');
