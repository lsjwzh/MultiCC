'use strict';

const { execFile, execFileSync } = require('child_process');

function gitRun(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitTry(cwd, args) {
  try {
    return gitRun(cwd, args);
  } catch (_) {
    return '';
  }
}

function refExists(cwd, ref) {
  try {
    gitRun(cwd, ['rev-parse', '--verify', ref]);
    return true;
  } catch (_) {
    return false;
  }
}

function countRange(cwd, range) {
  const value = parseInt(gitTry(cwd, ['rev-list', '--count', range]) || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

function directoryPushState(dirPath, requestedBranch) {
  if (gitTry(dirPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { available: false, hasRemote: false, ahead: 0, behind: 0, reason: 'not-a-git-repository' };
  }

  const branch = requestedBranch || gitTry(dirPath, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch || !refExists(dirPath, `refs/heads/${branch}`)) {
    return { available: false, hasRemote: false, ahead: 0, behind: 0, reason: 'no-branch' };
  }

  const remotes = gitTry(dirPath, ['remote']).split('\n').filter(Boolean);
  if (remotes.length === 0) {
    return { available: true, hasRemote: false, branch, ahead: 0, behind: 0, reason: 'no-remote' };
  }

  const upstream = gitTry(dirPath, [
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${branch}`,
  ]);
  const remote = upstream ? upstream.split('/')[0] : (remotes.includes('origin') ? 'origin' : remotes[0]);
  const remoteBranch = upstream ? upstream.slice(remote.length + 1) : branch;
  const remoteRef = upstream || `${remote}/${remoteBranch}`;
  const remoteBranchExists = refExists(dirPath, remoteRef);
  const ahead = remoteBranchExists
    ? countRange(dirPath, `${remoteRef}..${branch}`)
    : countRange(dirPath, branch);
  const behind = remoteBranchExists ? countRange(dirPath, `${branch}..${remoteRef}`) : 0;

  return {
    available: true,
    hasRemote: true,
    branch,
    remote,
    remoteBranch,
    upstream: upstream || null,
    upstreamConfigured: !!upstream,
    remoteBranchExists,
    ahead,
    behind,
  };
}

function runGitAsync(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function pushDirectory(dirPath, requestedBranch) {
  const before = directoryPushState(dirPath, requestedBranch);
  if (!before.available) throw new Error('当前目录没有可推送的分支');
  if (!before.hasRemote) throw new Error('未设置 remote');
  if (before.ahead === 0) return { pushed: false, before, after: before };

  const args = before.upstreamConfigured
    ? ['push', before.remote, `${before.branch}:${before.remoteBranch}`]
    : ['push', '--set-upstream', before.remote, before.branch];
  try {
    await runGitAsync(dirPath, args);
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(detail || 'git push failed');
  }

  return {
    pushed: true,
    before,
    after: directoryPushState(dirPath, before.branch),
  };
}

module.exports = { directoryPushState, pushDirectory };
