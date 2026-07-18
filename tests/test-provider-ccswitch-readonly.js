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

test('CC-Switch import and MultiCC local mutations leave the source database unchanged', (t) => {
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
    db.prepare(
      'INSERT INTO providers (id, app_type, name, settings_config, sort_index) VALUES (?, ?, ?, ?, ?)',
    ).run('cc-source', 'claude', 'CC Source', settingsConfig, 7);
  } finally {
    db.close();
  }

  const rowsBefore = readRows(ccDb);
  const fileBefore = snapshot(ccDb);
  const providersPath = path.join(ROOT, 'src', 'providers.js');
  const childScript = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const providers = require(${JSON.stringify(providersPath)});

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

  const source = fs.readFileSync(providersPath, 'utf8');
  const sqliteMethods = [...new Set(
    [...source.matchAll(/\bsqliteRuntime\.([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]),
  )].sort();
  assert.deepEqual(sqliteMethods, ['getStatus', 'openReadonly']);
  assert.doesNotMatch(source, /require\(['"]better-sqlite3['"]\)/);
  assert.doesNotMatch(
    source,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\s+(?:INTO\s+|FROM\s+|TABLE\s+)?providers\b/i,
  );
});

test('provider delete confirmation states the local-only boundary in both languages', () => {
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.js'), 'utf8');
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'en.json'), 'utf8'));

  assert.match(manage, /confirm\(tt\('providerDeleteLocalConfirm', \{ name \}\)\)/);
  assert.doesNotMatch(manage, /会从\s*cc-switch\s*移除/i);
  assert.equal(
    zh.providerDeleteLocalConfirm,
    '仅删除 MultiCC 本地副本「{name}」，不会修改 CC-Switch；以后从 CC-Switch 同步时可能重新导入。是否继续？',
  );
  assert.equal(
    en.providerDeleteLocalConfirm,
    'Delete only the MultiCC local copy "{name}"? This does not modify CC-Switch, and a future CC-Switch sync may import it again.',
  );
});
