'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { defaultRepoActor } = require('../repo-actor');
const { getNative, runNative } = require('../native/runtime');
const digest = value => createHash('sha256').update(value).digest('hex');

// Read actual tracked/untracked bytes without staging, committing, or following
// symlinks. This is a version observation, NOT proof that writers have stopped.
async function observeCodeRevision(cwd, execGit, { maxBytes = 256 * 1024 * 1024, maxFiles = 50000, depth = 0 } = {}) {
  cwd = await fs.realpath(cwd);
  const git = args => execGit(cwd, args, { env: { GIT_OPTIONAL_LOCKS: '0' }, timeout: 30000, raw: args.includes('-z') });
  const commonDir = await fs.realpath(path.resolve(cwd, await git(['rev-parse', '--git-common-dir'])));
  const head = await git(['rev-parse', 'HEAD']);
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const gitDir = path.resolve(cwd, await git(['rev-parse', '--git-dir']));
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    if (await fs.lstat(path.join(gitDir, marker)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('code_git_operation');
  }
  const entries = await git(['ls-files', '--stage', '-z']);
  const flags = await git(['ls-files', '-v', '-z']);
  if (flags.split('\0').filter(Boolean).some(line => line[0] === 'S' || /^[a-z]/.test(line))) throw new Error('code_index_unsupported');
  const tracked = new Map(), gitlinks = new Map();
  for (const line of entries.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[3] !== '0') throw new Error('code_index_unsupported');
    // Submodules / nested repositories are observed separately, never read as files.
    if (match[1] === '160000') gitlinks.set(match[4], match[2]);
    else tracked.set(match[4], match[1]);
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set([...tracked.keys(), ...untracked.split('\0').filter(Boolean)])].sort();
  if (files.length > maxFiles) throw new Error('code_observation_limit');
  const fileMode = await git(['config', '--bool', 'core.filemode']).catch(() => 'true');
  // Git stays in its existing repo actor. Rust owns the fresh file observation
  // in one worker job; only path/mode descriptors cross the native boundary.
  const hash = await runNative(() => getNative().observeCodeFiles(
    cwd, files, files.map(file => tracked.get(file) || ''), fileMode !== 'false', maxBytes));
  let gitlinkLines = '';
  // Appended after files so repositories without gitlinks keep their existing revisions.
  for (const [relative, oid] of [...gitlinks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const state = await observeGitlink(cwd, relative, execGit, { maxBytes, maxFiles, depth });
    gitlinkLines += JSON.stringify([relative, '160000', oid, state]) + '\n';
  }
  if (head !== await git(['rev-parse', 'HEAD']) || status !== await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('code_changed_during_observation');
  return { repoId: 'repo_' + digest(commonDir).slice(0, 32), head, revision: 'code_' + hash.finish(gitlinkLines),
    dirty: !!status, observedAt: Date.now(), writersStopped: false };
}

// A gitlink is either not checked out (absent / empty directory, the normal
// state in a fresh worktree) or a nested repository whose own HEAD and bytes
// are folded in. Anything else stays fail-closed.
async function observeGitlink(cwd, relative, execGit, options) {
  const absolute = path.resolve(cwd, relative);
  if (!absolute.startsWith(cwd + path.sep)) throw new Error('code_path_unsupported');
  const stat = await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!stat) return 'absent';
  if (!stat.isDirectory()) throw new Error('code_file_unsupported');
  if (await fs.realpath(absolute) !== absolute) throw new Error('code_parent_unsupported');
  const names = await fs.readdir(absolute);
  if (!names.length) return 'uninitialized';
  if (!names.includes('.git') || options.depth >= 4) throw new Error('code_index_unsupported');
  const toplevel = await execGit(absolute, ['rev-parse', '--show-toplevel'], { env: { GIT_OPTIONAL_LOCKS: '0' }, timeout: 30000 });
  if (await fs.realpath(toplevel) !== absolute) throw new Error('code_index_unsupported');
  const nested = await observeCodeRevision(absolute, execGit, { ...options, depth: options.depth + 1 });
  return `${nested.head} ${nested.revision}`;
}

// The stopped-writer capture runs as ONE native worker job (git orchestration,
// index parsing and file hashing included), so a release never queues a dozen
// subprocesses on the event loop. observeCodeRevision above stays on the
// injected execGit for merge hooks, where the repo actor must see every step.
async function captureCodeRevision(cwd) {
  return defaultRepoActor.run(cwd, 'code-revision', async () => {
    const observation = await runNative(() => getNative().observeCodeRevision(cwd));
    return { ...observation, observedAt: Date.now(), writersStopped: false };
  });
}
module.exports = { observeCodeRevision, captureCodeRevision };
