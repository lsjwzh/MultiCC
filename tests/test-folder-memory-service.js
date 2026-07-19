'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readMemoryFolder } = require('../src/memory-store');
const {
  SESSION_MEM_CAP,
  SHARED_MEM_CAP,
  SESSION_CURATED_MEM_CAP,
  SHARED_CURATED_MEM_CAP,
  createFolderMemoryService,
} = require('../src/memory/folder-service');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-folder-memory-'));
  const directories = new Map([['d1', { id: 'd1', rolePrompt: 'directory role' }]]);
  const service = createFolderMemoryService({
    fs,
    path,
    memoryStoreRoot: root,
    directories,
    readMemoryFolder,
    getMemoryEntries: record => Array.isArray(record.memory) ? record.memory : [],
  });
  return { root, directories, service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('folder memory seeds CLI-specific private and shared files without overwriting them', () => {
  const { root, service, cleanup } = fixture();
  try {
    const claude = { id: 's1', dirId: 'd1', cli: 'claude', label: 'Claude session' };
    const first = service.ensureDirs(claude);
    assert.equal(first.own, path.join(root, 'd1', 'sessions', 's1'));
    assert.equal(first.shared, path.join(root, 'd1', '_shared'));
    assert.equal(fs.existsSync(path.join(first.own, 'CLAUDE.md')), true);
    assert.equal(fs.existsSync(path.join(first.shared, 'README.md')), true);
    fs.writeFileSync(path.join(first.own, 'CLAUDE.md'), 'do not overwrite');
    service.ensureDirs(claude);
    assert.equal(fs.readFileSync(path.join(first.own, 'CLAUDE.md'), 'utf8'), 'do not overwrite');

    const codex = { id: 's2', dirId: 'd1', cli: 'codex', memory: [{ type: 'fact', text: 'legacy', ts: 1 }] };
    const second = service.ensureDirs(codex);
    assert.equal(fs.existsSync(path.join(second.own, 'AGENTS.md')), true);
    assert.match(fs.readFileSync(path.join(second.own, '_auto.md'), 'utf8'), /\[fact\] legacy/);
  } finally {
    cleanup();
  }
});

test('folder snapshot preserves absolute paths, bounded scopes, and system-session exclusions', () => {
  const { service, cleanup } = fixture();
  try {
    const record = { id: 's1', dirId: 'd1', cli: 'claude' };
    const { own, shared } = service.ensureDirs(record);
    fs.writeFileSync(path.join(own, 'topic.md'), 'private stable fact');
    fs.writeFileSync(path.join(shared, 'MEMORY.md'), 'shared stable fact');
    const block = service.buildBlock(record);
    assert.match(block, /原生会话快照/);
    assert.equal(block.includes(own), true);
    assert.equal(block.includes(shared), true);
    assert.match(block, /private stable fact/);
    assert.match(block, /shared stable fact/);
    assert.equal(service.buildBlock({ ...record, type: 'aux' }), null);
    assert.equal(service.buildBlock({ ...record, type: 'gateway' }), null);
    assert.equal(service.buildBlock({ dirId: 'd1' }), null);
    assert.equal(SESSION_MEM_CAP, 5000);
    assert.equal(SHARED_MEM_CAP, 4000);
  } finally {
    cleanup();
  }
});

test('file helpers sort markdown, reject traversal, choose scope, and remove empty auto memory', () => {
  const { service, cleanup } = fixture();
  try {
    const record = { id: 's1', dirId: 'd1', cli: 'claude' };
    const { own, shared } = service.ensureDirs(record);
    fs.writeFileSync(path.join(own, 'z.md'), 'z');
    fs.writeFileSync(path.join(own, 'a.md'), 'a');
    fs.writeFileSync(path.join(own, 'ignored.txt'), 'x');
    assert.deepEqual(service.listFiles(own).map(file => file.name), ['CLAUDE.md', 'a.md', 'z.md']);
    for (const invalid of ['', '../x.md', 'x/y.md', 'x\\y.md', 'x..md', 'x.txt']) {
      assert.equal(service.safeFileName(invalid), null, `rejects ${invalid}`);
    }
    assert.equal(service.safeFileName('项目 notes.md'), '项目 notes.md');
    assert.equal(service.scopeDir(record, 'own'), own);
    assert.equal(service.scopeDir(record, 'shared'), shared);
    assert.equal(service.curatedLimit('own'), SESSION_CURATED_MEM_CAP);
    assert.equal(service.curatedLimit('shared'), SHARED_CURATED_MEM_CAP);
    service.writeAutoFile(record, [{ type: 'decision', text: 'keep this' }]);
    assert.equal(fs.existsSync(path.join(own, '_auto.md')), true);
    service.writeAutoFile(record, []);
    assert.equal(fs.existsSync(path.join(own, '_auto.md')), false);
  } finally {
    cleanup();
  }
});

test('role prompt keeps session override precedence and always appends the folder snapshot', () => {
  const { service, cleanup } = fixture();
  try {
    const inherited = service.resolveRolePrompt({ id: 's1', dirId: 'd1', cli: 'claude' });
    assert.equal(inherited.startsWith('directory role\n\n[记忆库'), true);
    const overridden = service.resolveRolePrompt({
      id: 's2', dirId: 'd1', cli: 'codex', rolePrompt: 'session role',
    });
    assert.equal(overridden.startsWith('session role\n\n[记忆库'), true);
    assert.equal(service.resolveRolePrompt(null), null);
  } finally {
    cleanup();
  }
});
