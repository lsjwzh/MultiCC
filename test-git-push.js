'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { directoryPushState, pushDirectory } = require('./git-push');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-git-push-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');

  try {
    fs.mkdirSync(local);
    git(root, ['init', '--bare', remote]);
    assert.deepStrictEqual(directoryPushState(local, 'main'), {
      available: false,
      hasRemote: false,
      ahead: 0,
      behind: 0,
      reason: 'not-a-git-repository',
    });
    git(local, ['init', '-b', 'main']);
    git(local, ['config', 'user.email', 'test@multicc.local']);
    git(local, ['config', 'user.name', 'MultiCC Test']);
    fs.writeFileSync(path.join(local, 'file.txt'), 'one\n');
    git(local, ['add', 'file.txt']);
    git(local, ['commit', '-m', 'first']);

    assert.deepStrictEqual(directoryPushState(local, 'main'), {
      available: true,
      hasRemote: false,
      branch: 'main',
      ahead: 0,
      behind: 0,
      reason: 'no-remote',
    });

    git(local, ['remote', 'add', 'origin', remote]);
    let state = directoryPushState(local, 'main');
    assert.strictEqual(state.hasRemote, true);
    assert.strictEqual(state.upstreamConfigured, false);
    assert.strictEqual(state.ahead, 1);

    let result = await pushDirectory(local, 'main');
    assert.strictEqual(result.pushed, true);
    assert.strictEqual(result.after.upstream, 'origin/main');
    assert.strictEqual(result.after.ahead, 0);

    fs.appendFileSync(path.join(local, 'file.txt'), 'two\n');
    git(local, ['add', 'file.txt']);
    git(local, ['commit', '-m', 'second']);
    state = directoryPushState(local, 'main');
    assert.strictEqual(state.ahead, 1);

    result = await pushDirectory(local, 'main');
    assert.strictEqual(result.after.ahead, 0);

    result = await pushDirectory(local, 'main');
    assert.strictEqual(result.pushed, false);
    console.log('Git push status tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
