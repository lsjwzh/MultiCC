'use strict';

// Unit tests for the session execution-environment handoff helpers
// (src/session/handoff-env.js) — the collect/restore layer behind session
// bundle v2. Everything runs inside a temp dir with injected paths; the real
// skills root and memory store are never touched.

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHandoffEnvService } = require('../src/session/handoff-env');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-handoff-'));
}

function writeTree(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(entries)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

test('collectMemoryScopes reads each scope dir and reports oversized files', () => {
  const root = tempRoot();
  writeTree(path.join(root, 'own'), { 'CLAUDE.md': 'private notes', 'big.md': 'x'.repeat(2048) });
  writeTree(path.join(root, 'shared'), { 'MEMORY.md': 'shared facts' });
  const folderMemory = {
    sessionDir: () => path.join(root, 'own'),
    sharedDir: () => path.join(root, 'shared'),
    taskDir: () => path.join(root, 'task'),
    cliDir: () => path.join(root, 'cli'),
    machineDir: () => path.join(root, 'machine'),
  };
  const service = createHandoffEnvService({ maxFileBytes: 1024 });
  const scopes = service.collectMemoryScopes(folderMemory, { dirId: 'd1', id: 's1', cli: 'claude' }, ['session', 'shared']);
  assert.equal(scopes.session.files['CLAUDE.md'], 'private notes');
  assert.ok(scopes.session.skipped.some(s => s.name === 'big.md'));
  assert.equal(scopes.shared.files['MEMORY.md'], 'shared facts');
  fs.rmSync(root, { recursive: true, force: true });
});

test('scopeDirFor resolves the task scope from taskBoundTaskId or taskState', () => {
  const root = tempRoot();
  const service = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills') });
  const seen = [];
  const folderMemory = {
    sessionDir: () => path.join(root, 'own'),
    sharedDir: () => path.join(root, 'shared'),
    taskDir: (dirId, taskId) => { seen.push([dirId, taskId]); return path.join(root, 'tasks', taskId); },
    cliDir: () => path.join(root, 'cli'),
    machineDir: () => path.join(root, 'machine'),
  };
  service.scopeDirFor(folderMemory, { dirId: 'd1', cli: 'claude', taskBoundTaskId: 'tsk_bound' }, 'task');
  service.scopeDirFor(folderMemory, { dirId: 'd1', cli: 'claude', taskState: { taskId: 'tsk_state' } }, 'task');
  service.scopeDirFor(folderMemory, { dirId: 'd1', cli: 'claude' }, 'task');
  assert.deepEqual(seen, [['d1', 'tsk_bound'], ['d1', 'tsk_state']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectSkillReferences matches whole names in memories and messages, not substrings', () => {
  const root = tempRoot();
  const { DOCS_REGISTRY_RULE } = require('../src/memory/builtin-rules');
  const service = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills'),
                                            builtinRuleText: DOCS_REGISTRY_RULE });
  const installed = [
    { name: 'skill-maker', path: '/x/skill-maker/SKILL.md' },
    { name: 'media-gif-search', path: '/x/media-gif-search/SKILL.md' },
    { name: 'ab', path: '/x/ab/SKILL.md' }, // too short — never matched
    { name: 'bad/name', path: '/x/bad/SKILL.md' }, // unsafe — ignored
  ];
  const corpus = '用了 skill-maker 技能处理；avoid skill-makers (plural) and xabx';
  assert.deepEqual(service.detectSkillReferences(corpus, installed), ['skill-maker']);
  const withMessages = service.detectionCorpus(
    { shared: { files: { 'MEMORY.md': 'media-gif-search很好用' } } },
    [{ role: 'user', content: '请用 skill-maker' }],
  );
  assert.deepEqual(service.detectSkillReferences(withMessages, installed), ['media-gif-search', 'skill-maker']);
  // The builtin shared rule mentions multicc-artifact but is stripped from the
  // corpus — it ships with every install and is not a session skill reference.
  assert.ok(DOCS_REGISTRY_RULE.includes('multicc-artifact'));
  const seeded = service.detectionCorpus(
    { shared: { files: { 'MEMORY.md': DOCS_REGISTRY_RULE } } }, []);
  assert.deepEqual(service.detectSkillReferences(seeded,
    [{ name: 'multicc-artifact', path: '/x/multicc-artifact/SKILL.md' }]), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectSkillFolder snapshots utf8 and binary files, skips noise, honours caps', () => {
  const root = tempRoot();
  const skillDir = path.join(root, 'skills', 'demo-skill');
  writeTree(skillDir, {
    'SKILL.md': '---\nname: demo-skill\n---\nbody',
    'scripts/run.js': 'console.log(1)',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]),
    'node_modules/junk/x.js': 'junk',
    '.DS_Store': 'junk',
  });
  const full = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills') });
  const collected = full.collectSkillFolder(skillDir);
  const rels = collected.files.map(f => f.rel).sort();
  assert.deepEqual(rels, ['SKILL.md', 'assets/logo.png', 'scripts/run.js']);
  assert.equal(collected.files.find(f => f.rel === 'assets/logo.png').encoding, 'base64');
  assert.equal(collected.files.find(f => f.rel === 'scripts/run.js').encoding, 'utf8');
  assert.equal(collected.truncated, false);

  // Cap between the SKILL.md (28B) and SKILL.md+run.js (42B): the script is
  // dropped and the truncation flag reports it.
  const capped = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills'), maxSkillBytes: 30 });
  const trimmed = capped.collectSkillFolder(skillDir);
  assert.deepEqual(trimmed.files.map(f => f.rel), ['SKILL.md']);
  assert.equal(trimmed.truncated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('restoreSkillFolders installs fresh, skips identical, renames on conflict, rejects unsafe input', () => {
  const root = tempRoot();
  const skillsDir = path.join(root, 'skills');
  const service = createHandoffEnvService({ agentsSkillsDir: skillsDir });
  const filesA = [{ rel: 'SKILL.md', encoding: 'utf8', content: '---\nname: team-skill\n---\nv1' }];
  const filesB = [{ rel: 'SKILL.md', encoding: 'utf8', content: '---\nname: team-skill\n---\nv2' }];

  let results = service.restoreSkillFolders([{ name: 'team-skill', files: filesA }], skillsDir);
  assert.equal(results[0].status, 'installed');
  assert.equal(fs.readFileSync(path.join(skillsDir, 'team-skill', 'SKILL.md'), 'utf8'), filesA[0].content);

  // Identical payload → no-op.
  results = service.restoreSkillFolders([{ name: 'team-skill', files: [...filesA] }], skillsDir);
  assert.equal(results[0].status, 'identical');

  // Differing payload with the same name → renamed, never clobbers.
  results = service.restoreSkillFolders([{ name: 'team-skill', files: filesB }], skillsDir);
  assert.equal(results[0].status, 'renamed');
  assert.match(results[0].dir, /team-skill-imported/);
  assert.equal(fs.readFileSync(path.join(skillsDir, 'team-skill', 'SKILL.md'), 'utf8'), filesA[0].content);

  // Rejected: unsafe name, missing SKILL.md, path traversal inside the folder.
  results = service.restoreSkillFolders([
    { name: '../evil', files: filesA },
    { name: 'no-skill-md', files: [{ rel: 'docs.md', encoding: 'utf8', content: 'x' }] },
    { name: 'traversal', files: [{ rel: '../escape.md', encoding: 'utf8', content: 'x' }, { rel: 'SKILL.md', encoding: 'utf8', content: 'y' }] },
  ], skillsDir);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'rejected');
  assert.ok(!fs.existsSync(path.join(root, 'escape.md')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('restoreMemoryScopes writes shared without overwriting and prefixes narrow scopes', () => {
  const root = tempRoot();
  const service = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills') });
  const sessionDir = path.join(root, 'own');
  const sharedDir = path.join(root, 'shared');
  writeTree(sessionDir, { 'CLAUDE.md': 'seed' });
  writeTree(sharedDir, { 'MEMORY.md': 'local wins' });
  const report = service.restoreMemoryScopes({
    session: { files: { 'notes.md': 'private' } },
    shared: { files: { 'MEMORY.md': 'incoming', 'team-facts.md': 'facts' } },
    task: { files: { 'MEMORY.md': 'task memory' } },
  }, { sessionDir, sharedDir });
  // The session scope is the v1 memoryFiles payload's job — not written here.
  assert.ok(report.session.note);
  assert.ok(!fs.existsSync(path.join(sessionDir, 'notes.md')));
  assert.equal(fs.readFileSync(path.join(sessionDir, 'task-MEMORY.md'), 'utf8'), 'task memory');
  assert.equal(fs.readFileSync(path.join(sharedDir, 'MEMORY.md'), 'utf8'), 'local wins');
  assert.equal(fs.readFileSync(path.join(sharedDir, 'team-facts.md'), 'utf8'), 'facts');
  assert.ok(report.shared.skipped.some(s => s.name === 'MEMORY.md'));
  assert.ok(report.shared.written.includes('team-facts.md'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderHandoffDoc mentions repo, provider, memory and skills sections', () => {
  const root = tempRoot();
  const service = createHandoffEnvService({ agentsSkillsDir: path.join(root, 'skills') });
  const doc = service.renderHandoffDoc({
    payload: {
      v: 2, exportedAt: '2026-09-19T00:00:00Z',
      sessionMeta: { id: 's1', label: '源会话', cli: 'claude', model: 'glm-5.3', branch: 'multicc/s1' },
      contextDeps: { dirName: 'proj', repoRemote: 'git@example:proj.git', baseBranch: 'main',
                     envKeys: ['ANTHROPIC_BASE_URL'], projectDocs: { 'CLAUDE.md': 'x' } },
    },
    memoryReport: { shared: { written: ['team-facts.md'], skipped: [] } },
    skillResults: [{ name: 'team-skill', status: 'installed' }],
    gitNote: '2 unique commits',
  });
  assert.match(doc, /git@example:proj\.git/);
  assert.match(doc, /multicc\/s1/);
  assert.match(doc, /ANTHROPIC_BASE_URL/);
  assert.match(doc, /team-facts\.md/);
  assert.match(doc, /team-skill：installed/);
  assert.match(doc, /HANDOFF/);
  fs.rmSync(root, { recursive: true, force: true });
});
