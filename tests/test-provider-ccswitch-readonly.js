'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

function snapshot(file) {
  const stat = fs.statSync(file, { bigint: true });
  return {
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

function readRows(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      'SELECT id, app_type, name, settings_config, sort_index FROM providers ORDER BY id',
    ).all();
  } finally {
    db.close();
  }
}

function verifyReadOnlyImport(t, hasMeta) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-boundary-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const home = path.join(temp, 'home');
  const dataRoot = path.join(temp, 'multicc-data');
  const ccDir = path.join(home, '.cc-switch');
  const ccDb = path.join(ccDir, 'cc-switch.db');
  fs.mkdirSync(ccDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });

  const settingsConfig = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://relay.example.test',
      ANTHROPIC_AUTH_TOKEN: 'cc-switch-secret',
      ANTHROPIC_MODEL: 'source-model',
    },
  });
  const db = new Database(ccDb);
  try {
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        sort_index INTEGER NOT NULL DEFAULT 0
      )
    `);
    if (hasMeta) db.exec("ALTER TABLE providers ADD COLUMN meta TEXT DEFAULT '{}'");
    db.prepare(
      'INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?, ?, ?, ?, ?)',
    ).run('cc-source', 'claude', 'CC Source', settingsConfig, 7);
  } finally {
    db.close();
  }

  const rowsBefore = readRows(ccDb);
  const fileBefore = snapshot(ccDb);
  const bindingPath = path.join(ROOT, 'src', 'native', 'binding.js');
  const childScript = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const providers = require(${JSON.stringify(bindingPath)}).providersHost;

    const status = providers.getCcSwitchStatus();
    assert.equal(status.available, true);
    assert.equal(status.dbPath, process.env.EXPECTED_CC_DB);

    assert.deepEqual(providers.importFromCcSwitch(), { imported: 1, updated: 0, total: 1 });
    assert.equal(providers.getProvider('claude', 'cc-source').source, 'ccswitch');

    providers.updateProvider('claude', 'cc-source', {
      name: 'MultiCC Local Override',
      model: 'local-model',
    });
    assert.equal(providers.getProviderSummary('claude', 'cc-source').name, 'MultiCC Local Override');
    assert.equal(providers.deleteProvider('claude', 'cc-source'), true);
    assert.equal(providers.getProvider('claude', 'cc-source'), null);

    const localStore = path.join(process.env.MULTICC_DATA_DIR, 'providers.json');
    assert.equal(fs.existsSync(localStore), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(localStore, 'utf8')), []);
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MULTICC_DATA_DIR: dataRoot,
      EXPECTED_CC_DB: ccDb,
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);

  assert.deepEqual(snapshot(ccDb), fileBefore, 'CC DB hash/mtime/size changed');
  assert.deepEqual(readRows(ccDb), rowsBefore, 'CC DB provider rows changed');
  assert.deepEqual(snapshot(ccDb), fileBefore, 'read-back changed CC DB metadata');

  const facade = fs.readFileSync(path.join(ROOT, 'native/addon/src/providers_host_runtime/facade.rs'), 'utf8');
  const sqliteMethods = [...facade.matchAll(/get\(c"sqlite"\)\?\s*,\s*c"(\w+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(sqliteMethods)], ['getStatus']);
  const registry = fs.readFileSync(path.join(ROOT, 'native/addon/src/provider_service/registry.rs'), 'utf8');
  assert.match(registry, /cc_switch::read_rows/);
  const reader = fs.readFileSync(path.join(ROOT, 'native/core/src/cc_switch.rs'), 'utf8');
  assert.match(reader, /OpenFlags::SQLITE_OPEN_READ_ONLY/);
  assert.doesNotMatch(fs.readFileSync(bindingPath, 'utf8'), /require\(['"]better-sqlite3['"]\)/);
  assert.doesNotMatch(
    reader,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\s+(?:INTO\s+|FROM\s+|TABLE\s+)?providers\b/i,
  );
}

for (const hasMeta of [false, true]) {
  test(`CC-Switch 导入及本地修改保持源数据库只读（含 meta 列：${hasMeta}）`, t => verifyReadOnlyImport(t, hasMeta));
}

test('provider delete confirmation states the local-only boundary in both languages', () => {
  const air = fs.readFileSync(path.join(ROOT, 'public', 'air-provider.js'), 'utf8');
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'en.json'), 'utf8'));

  assert.match(air, /confirm\(t\('airProviderDeleteConfirm', \{ name: displayName\(provider\) \}\)\)/);
  assert.doesNotMatch(air, /会从\s*cc-switch\s*移除/i);
  assert.match(zh.airProviderDeleteConfirm, /只删 MultiCC 本地副本，不会修改 CC-Switch/);
  assert.match(en.airProviderDeleteConfirm, /only the MultiCC local copy .+ CC-Switch is not modified/);
});
