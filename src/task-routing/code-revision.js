'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { defaultRepoActor } = require('../repo-actor');
const digest = value => createHash('sha256').update(value).digest('hex');

// Read actual tracked/untracked bytes without staging, committing, or following
// symlinks. This is a version observation, NOT proof that writers have stopped.
async function observeCodeRevision(cwd, execGit, { maxBytes = 256 * 1024 * 1024, maxFiles = 50000 } = {}) {
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
  const tracked = new Map();
  for (const line of entries.split('\0').filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== '0' || match[1] === '160000') throw new Error('code_index_unsupported');
    tracked.set(match[3], match[1]);
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set([...tracked.keys(), ...untracked.split('\0').filter(Boolean)])].sort();
  if (files.length > maxFiles) throw new Error('code_observation_limit');
  const fileMode = await git(['config', '--bool', 'core.filemode']).catch(() => 'true');
  const hash = createHash('sha256'); let total = 0;
  for (const relative of files) {
    const absolute = path.resolve(cwd, relative);
    if (!absolute.startsWith(path.resolve(cwd) + path.sep)) throw new Error('code_path_unsupported');
    const stat = await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) continue; // tracked deletion
    // Reject symlinked parent directories: reading them could leave this worktree.
    if (path.dirname(absolute) !== cwd && await fs.realpath(path.dirname(absolute)).catch(() => null) !== path.dirname(absolute)) throw new Error('code_parent_unsupported');
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('code_file_unsupported');
    total += stat.size; if (total > maxBytes) throw new Error('code_observation_limit');
    let bytes;
    if (stat.isSymbolicLink()) bytes = Buffer.from(await fs.readlink(absolute));
    else {
      const handle = await fs.open(absolute, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('code_changed_during_observation');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
    }
    if (bytes.length !== stat.size && !stat.isSymbolicLink()) throw new Error('code_changed_during_observation');
    const after = await fs.lstat(absolute);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('code_changed_during_observation');
    const mode = stat.isSymbolicLink() ? '120000' : fileMode === 'false' && tracked.has(relative)
      ? tracked.get(relative) : stat.mode & 0o111 ? '100755' : '100644';
    hash.update(JSON.stringify([relative, mode, digest(bytes)]) + '\n');
  }
  if (head !== await git(['rev-parse', 'HEAD']) || status !== await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('code_changed_during_observation');
  return { repoId: 'repo_' + digest(commonDir).slice(0, 32), head, revision: 'code_' + hash.digest('hex'),
    dirty: !!status, observedAt: Date.now(), writersStopped: false };
}

async function captureCodeRevision(cwd) {
  return defaultRepoActor.run(cwd, 'code-revision', ({ execGit }) => observeCodeRevision(cwd, execGit));
}
module.exports = { observeCodeRevision, captureCodeRevision };
