'use strict';
// Differential run for the sixteen session/git routes retired from
// src/routes/session-git.js:
//
//   GET  /api/sessions/:id/merge-status
//   GET  /api/sessions/:id/diff
//   GET  /api/sessions/:id/diff/files
//   GET  /api/sessions/:id/diff/file
//   GET  /api/git/log
//   GET  /api/git/commit-files
//   GET  /api/git/commit-diff
//   GET  /api/git/directory-file-diff
//   GET  /api/git/directory-status
//   GET  /api/task-board/tasks/:taskId/diff/files
//   GET  /api/task-board/tasks/:taskId/diff/file
//   POST /api/task-board/tasks/:taskId/merge
//   POST /api/task-board/tasks/:taskId/cleanup-worktree
//   POST /api/sessions/:id/merge
//   POST /api/sessions/:id/sync
//   POST /api/sessions/:id/rebase
//
// now answered by native/gateway/src/app/session_git.rs (rules in
// native/core/src/session_git.rs).
//
//   node docs/rust-migration/differential/session-git.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-session-git-routes.js) over the scripted world in
// tests/helpers/session-git-scripted-world.js. The Rust front door calls its
// host port (/api/__host/session-git); the stub Node child here is the real
// src/routes/session-git.js host composition (createSessionGitRuntime →
// mountSessionGitHostRoute) over the same world, so both sides read one set of
// facts and the comparison covers the split itself: what stayed in Node (Maps,
// repo-actor git calls, merge-state cache, merge/sync/rebase/cleanup
// transactions, broadcasts) must feed the front door exactly the facts the
// retired handlers used.
//
// Nothing touches real git, the filesystem, the clock or the network. Each
// corpus case gets its own session/task identity (the merge-state cache is
// keyed by identity and lives for the whole run), so a first merge-status read
// is always the cache-miss LOADING answer on both sides.
//
// Side effects are compared too: appendEvent / workspaceBroadcast /
// chatBroadcast arguments are recorded by the oracle in-process and by the stub
// in an NDJSON file, then compared per case in finalize(). A route that answers
// the same bytes but forgets to broadcast (or broadcasts twice) fails.
//
// No documented differences: the corpus contains no case whose two answers are
// expected to diverge. A malformed percent-escape in a path segment is one
// corpus case rather than a registered difference — the retired pipeline's
// safeErrorHandler already turned Express's decode failure into the shared
// 400 {ok:false,error:"request_error",…} DTO the front door's request parser
// produces, so both sides agree byte for byte.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/session-git';
const MAX_DIFF = 1024 * 1024;
const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };

let worldPath = '';
let effectsPath = '';
let bag = null;
let legacy = null;
let current = null;
let upstreamText = '';
const nodeEffects = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── the scripted world ──────────────────────────────────────────────────────

function key(...args) {
  return args.join('\t');
}

function mainDir(extra = {}) {
  return { id: 'd1', path: '/repo', baseBranch: 'main', ...extra };
}

function baseWorld(tag) {
  return {
    case: tag,
    records: [],
    directories: [mainDir()],
    terminalSessions: [],
    chatSessions: {},
    tasks: {},
    absentPaths: [],
    readFiles: {},
    git: {},
    gitDefault: { stdout: '' },
    baseBranch: { value: 'main' },
    mergeStates: {},
    flows: {},
    now: 1000000,
    random: 0,
  };
}

function session(tag, extra = {}) {
  return { id: tag, dirId: 'd1', branch: `multicc/${tag}`, worktreePath: `/repo/wt-${tag}`, ...extra };
}

function sessionWorld(tag, extra = {}, mutate) {
  const world = baseWorld(tag);
  world.records = [session(tag, extra)];
  if (mutate) mutate(world, tag);
  return world;
}

function taskWorld(tag, mutate) {
  const world = baseWorld(tag);
  world.tasks.t1 = {
    dir: mainDir(), worktreePath: '/repo/task-t1', branch: 'multicc/task-t1', token: 't1',
  };
  if (mutate) mutate(world, tag);
  return world;
}

const GIT_LOG_FORMAT = '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D';
const SHOW_CHANGED = ['show', '--format=', '--name-status', '-z',
  '--root', '--first-parent', '--no-color'];

function patchAnswer(text) {
  return { stdout: text };
}

function gitError(spec = {}) {
  return { error: { stderr: 'fatal: scripted git failure', ...spec } };
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

let counter = 0;
const pending = [];

function useScenario(scenario) {
  return {
    before() {
      bag.apply(scenario);
      fs.writeFileSync(worldPath, JSON.stringify(scenario));
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      nodeEffects.set(scenario.case, clone({
        events: bag.effects.events,
        broadcasts: bag.effects.broadcasts,
        chats: bag.effects.chats,
      }));
      bag.effects.events.length = 0;
      bag.effects.broadcasts.length = 0;
      bag.effects.chats.length = 0;
    },
  };
}

function add(name, buildRequest, buildWorld, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = buildWorld ? buildWorld(tag) : baseWorld(tag);
  scenario.case = tag;
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) {
    if (hook === 'before') {
      const wrapped = hooks.before;
      hooks.before = async (side) => { await fn(side); wrapped(); };
    } else if (hook === 'capture') {
      const wrapped = hooks.capture;
      hooks.capture = (response, side) => { wrapped(response, side); fn(response, side); };
    } else {
      hooks[hook] = fn;
    }
  }
  pending.push([name, () => buildRequest(tag), hooks]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const post = (url, body, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });

  // ── OPTIONS on all sixteen (Allow list + body) ──────────────────────────
  const paths = [
    ['merge status', 'GET', '/api/sessions/s/merge-status'],
    ['diff', 'GET', '/api/sessions/s/diff'],
    ['diff files', 'GET', '/api/sessions/s/diff/files'],
    ['diff file', 'GET', '/api/sessions/s/diff/file'],
    ['git log', 'GET', '/api/git/log'],
    ['commit files', 'GET', '/api/git/commit-files'],
    ['commit diff', 'GET', '/api/git/commit-diff'],
    ['directory file diff', 'GET', '/api/git/directory-file-diff'],
    ['directory status', 'GET', '/api/git/directory-status'],
    ['task diff files', 'GET', '/api/task-board/tasks/t/diff/files'],
    ['task diff file', 'GET', '/api/task-board/tasks/t/diff/file'],
    ['task merge', 'POST', '/api/task-board/tasks/t/merge'],
    ['task cleanup', 'POST', '/api/task-board/tasks/t/cleanup-worktree'],
    ['session merge', 'POST', '/api/sessions/s/merge'],
    ['session sync', 'POST', '/api/sessions/s/sync'],
    ['session rebase', 'POST', '/api/sessions/s/rebase'],
  ];
  for (const [name, , url] of paths) {
    add(`OPTIONS ${name}`, () => ({ method: 'OPTIONS', url, headers: L }));
  }

  // ── merge-status ────────────────────────────────────────────────────────
  const MERGE = { mergeReady: true, dirty: false, ahead: 2, behind: 1, baseBranch: 'main' };
  add('merge status cache miss is loading',
    tag => get(`/api/sessions/${tag}/merge-status`),
    tag => sessionWorld(tag, {}, world => { world.mergeStates[tag] = MERGE; }));
  add('merge status refresh reads fresh',
    tag => get(`/api/sessions/${tag}/merge-status?refresh=1`),
    tag => sessionWorld(tag, {}, world => { world.mergeStates[tag] = MERGE; }));
  add('merge status fresh=1 reads fresh',
    tag => get(`/api/sessions/${tag}/merge-status?fresh=1`),
    tag => sessionWorld(tag, {}, world => { world.mergeStates[tag] = MERGE; }));
  add('merge status missing session',
    tag => get(`/api/sessions/${tag}/merge-status`),
    tag => sessionWorld(tag));
  add('merge status missing directory',
    tag => get(`/api/sessions/${tag}/merge-status`),
    tag => sessionWorld(tag, { dirId: 'd-missing' }));
  add('merge status resolves the workspace owner',
    tag => get(`/api/sessions/${tag}/merge-status`),
    (tag) => {
      const world = baseWorld(tag);
      world.records = [
        session(`${tag}-child`, { workspaceOwnerSessionId: tag }),
        session(tag),
      ];
      return world;
    });
  add('merge status session simply not found',
    () => get('/api/sessions/nope/merge-status'),
    tag => sessionWorld(tag));

  // ── session diff ────────────────────────────────────────────────────────
  const DIFF_TEXT = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+more\n';
  const STAT_TEXT = ' a.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n';
  const diffKeys = (world, base) => {
    world.git[key('diff', '--no-color', base)] = patchAnswer(DIFF_TEXT);
    world.git[key('diff', '--stat', '--no-color', base)] = patchAnswer(STAT_TEXT);
  };
  add('diff renders patch and stat',
    tag => get(`/api/sessions/${tag}/diff`),
    (tag) => sessionWorld(tag, {}, world => diffKeys(world, 'main')));
  add('diff stat is best effort',
    tag => get(`/api/sessions/${tag}/diff`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main')] = patchAnswer(DIFF_TEXT);
      world.git[key('diff', '--stat', '--no-color', 'main')] = gitError({ stderr: 'fatal: stat broke' });
    }));
  add('diff git failure surfaces the stderr',
    tag => get(`/api/sessions/${tag}/diff`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main')] = gitError({ stderr: 'x'.repeat(500) });
      world.git[key('diff', '--stat', '--no-color', 'main')] = patchAnswer(STAT_TEXT);
    }));
  add('diff max buffer becomes the truncated placeholder',
    tag => get(`/api/sessions/${tag}/diff`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main')] = {
        error: { maxBuffer: true, message: 'stdout maxBuffer exceeded' },
      };
      world.git[key('diff', '--stat', '--no-color', 'main')] = patchAnswer(STAT_TEXT);
    }));
  add('diff over the cap is sliced at a non-ascii boundary',
    tag => get(`/api/sessions/${tag}/diff`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main')] = patchAnswer('a'.repeat(MAX_DIFF - 1) + 'é' + 'zz');
      world.git[key('diff', '--stat', '--no-color', 'main')] = patchAnswer(STAT_TEXT);
    }));
  add('diff missing worktree',
    tag => get(`/api/sessions/${tag}/diff`),
    tag => sessionWorld(tag, {}, (world) => {
      world.absentPaths.push(`/repo/wt-${tag}`);
    }));
  add('diff falls back to the probed base branch',
    tag => get(`/api/sessions/${tag}/diff`),
    tag => sessionWorld(tag, {}, (world) => {
      world.directories = [mainDir({ baseBranch: undefined })];
      world.baseBranch = { value: 'trunk' };
      diffKeys(world, 'trunk');
    }));
  add('diff base branch probe failure',
    tag => get(`/api/sessions/${tag}/diff`),
    tag => sessionWorld(tag, {}, (world) => {
      world.directories = [mainDir({ baseBranch: undefined })];
      world.baseBranch = { throw: { stderr: 'fatal: not a git repository' } };
    }));

  // ── session diff/files ──────────────────────────────────────────────────
  const NUMSTAT_ARGS = base => ['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-color', '-z', base];
  const NAME_STATUS_ARGS = base => ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-color', '-z', base];
  const LS_FILES_ARGS = ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'];
  add('diff files parses numstat, renames and untracked',
    tag => get(`/api/sessions/${tag}/diff/files`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key(...NUMSTAT_ARGS('main'))] = patchAnswer(
        '1\t2\ta.js\0' + '-\t-\tbin.dat\0' + '2\t0\t\0old name.js\0new name.js\0');
      world.git[key(...NAME_STATUS_ARGS('main'))] = patchAnswer(
        'M\0a.js\0M\0bin.dat\0R100\0old name.js\0new name.js\0');
      world.git[key(...LS_FILES_ARGS)] = patchAnswer('new file.js\0');
      world.readFiles[`/repo/wt-${tag}/new file.js`] = { text: 'line1\nline2\n' };
    }));
  add('diff files reports a git error and keeps untracked empty',
    tag => get(`/api/sessions/${tag}/diff/files`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key(...NUMSTAT_ARGS('main'))] = gitError({ stderr: 'fatal: bad revision "main"' });
      world.git[key(...NAME_STATUS_ARGS('main'))] = gitError({ stderr: 'fatal: bad revision "main"' });
    }));
  add('diff files missing worktree',
    tag => get(`/api/sessions/${tag}/diff/files`),
    tag => sessionWorld(tag, {}, (world) => {
      world.absentPaths.push(`/repo/wt-${tag}`);
    }));

  // ── session diff/file ───────────────────────────────────────────────────
  const FILE_PATCH = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n';
  add('diff file returns the tracked patch',
    tag => get(`/api/sessions/${tag}/diff/file?path=a.js`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'a.js')] = patchAnswer(FILE_PATCH);
    }));
  add('diff file synthesizes an untracked text patch',
    tag => get(`/api/sessions/${tag}/diff/file?path=new%20file.js`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'new file.js')] = patchAnswer('');
      world.git[key(...LS_FILES_ARGS)] = patchAnswer('new file.js\0');
      world.readFiles[`/repo/wt-${tag}/new file.js`] = { text: 'alpha\nbeta' };
    }));
  add('diff file reports an untracked binary file',
    tag => get(`/api/sessions/${tag}/diff/file?path=blob.bin`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'blob.bin')] = patchAnswer('');
      world.git[key(...LS_FILES_ARGS)] = patchAnswer('blob.bin\0');
      world.readFiles[`/repo/wt-${tag}/blob.bin`] = { binary: true };
    }));
  add('diff file requires a path',
    tag => get(`/api/sessions/${tag}/diff/file`),
    tag => sessionWorld(tag));
  add('diff file rejects a dashes-first path',
    tag => get(`/api/sessions/${tag}/diff/file?path=-x.js`),
    tag => sessionWorld(tag));
  add('diff file reports a git failure',
    tag => get(`/api/sessions/${tag}/diff/file?path=a.js`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'a.js')] = gitError({ stderr: 'fatal: nope' });
    }));
  add('diff file slices an oversized patch',
    tag => get(`/api/sessions/${tag}/diff/file?path=big.js`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'big.js')] = patchAnswer('z'.repeat(300 * 1024));
    }));

  // ── git log ─────────────────────────────────────────────────────────────
  const LOG_LINE = 'abc1234def5678\0abc1234\0Alice\0' + '2024-01-02T03:04:05Z\0subject\0HEAD -> main, tag: v1';
  add('git log from a directory',
    () => get('/api/git/log?dirId=d1'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('log', '-30', GIT_LOG_FORMAT, '--no-color')] = patchAnswer(`${LOG_LINE}\n`);
      return world;
    });
  add('git log from a session with all branches and a limit',
    tag => get(`/api/git/log?sessionId=${tag}&all=1&limit=5`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('log', '-5', GIT_LOG_FORMAT, '--no-color', '--all')] = patchAnswer(`${LOG_LINE}\n`);
    }));
  add('git log clamps the limit to one hundred',
    () => get('/api/git/log?dirId=d1&limit=1000'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('log', '-100', GIT_LOG_FORMAT, '--no-color')] = patchAnswer('');
      return world;
    });
  add('git log falls back to thirty for a junk limit',
    () => get('/api/git/log?dirId=d1&limit=abc'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('log', '-30', GIT_LOG_FORMAT, '--no-color')] = patchAnswer('');
      return world;
    });
  add('git log requires a repo selector',
    () => get('/api/git/log'),
    tag => baseWorld(tag));
  add('git log missing session',
    tag => get(`/api/git/log?sessionId=${tag}`),
    tag => sessionWorld(tag));
  add('git log session without a worktree',
    tag => get(`/api/git/log?sessionId=${tag}`),
    tag => sessionWorld(tag, { worktreePath: undefined, branch: undefined }));
  add('git log missing directory',
    () => get('/api/git/log?dirId=nope'),
    tag => baseWorld(tag));
  add('git log missing repo path',
    () => get('/api/git/log?dirId=d1'),
    (tag) => {
      const world = baseWorld(tag);
      world.absentPaths.push('/repo');
      return world;
    });
  add('git log git failure',
    () => get('/api/git/log?dirId=d1'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('log', '-30', GIT_LOG_FORMAT, '--no-color')] = gitError({ stderr: 'fatal: bad default revision' });
      return world;
    });
  add('HEAD git log',
    () => ({ method: 'HEAD', url: '/api/git/log?dirId=d1', headers: L }),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('log', '-30', GIT_LOG_FORMAT, '--no-color')] = patchAnswer(`${LOG_LINE}\n`);
      return world;
    });

  // ── commit-files / commit-diff ──────────────────────────────────────────
  const HASH = 'abc1234';
  const CHANGED = 'M\0a.js\0R100\0old.js\0new.js\0A\0added.js\0';
  add('commit files parses name-status',
    () => get(`/api/git/commit-files?dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key(...SHOW_CHANGED, HASH)] = patchAnswer(CHANGED);
      return world;
    });
  add('commit files rejects an invalid hash',
    () => get('/api/git/commit-files?dirId=d1&hash=XYZ'),
    tag => baseWorld(tag));
  add('commit files missing repo',
    () => get(`/api/git/commit-files?dirId=nope&hash=${HASH}`),
    tag => baseWorld(tag));
  add('commit files git failure',
    () => get(`/api/git/commit-files?dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key(...SHOW_CHANGED, HASH)] = gitError({ stderr: 'fatal: bad object' });
      return world;
    });
  const DIFF_ARGS = ['show', '--format=', '--patch', '--root', '--first-parent', '--no-color',
    '--no-ext-diff', '--no-textconv'];
  add('commit diff of one file orders path before stat',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}&file=new.js`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key(...SHOW_CHANGED, HASH)] = patchAnswer(CHANGED);
      world.git[key(...DIFF_ARGS, HASH, '--', ':(literal)old.js', ':(literal)new.js')] =
        patchAnswer(FILE_PATCH);
      return world;
    });
  add('commit diff file not in the commit',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}&file=absent.js`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key(...SHOW_CHANGED, HASH)] = patchAnswer(CHANGED);
      return world;
    });
  add('commit diff rejects an empty file parameter',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}&file=`),
    tag => baseWorld(tag));
  add('commit diff without a file renders show plus stat',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('show', '--format=', '--patch', HASH)] = patchAnswer(FILE_PATCH);
      world.git[key('show', '--format=', '--stat', HASH)] = patchAnswer(STAT_TEXT);
      return world;
    });
  add('commit diff falls back to the parent range',
    () => get(`/api/git/commit-diff?sessionId=SKIP&dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('show', '--format=', '--patch', HASH)] = patchAnswer('');
      world.git[key('rev-parse', '--verify', '--quiet', `${HASH}~1`)] = patchAnswer(`${HASH}~1\n`);
      world.git[key('diff', '--patch', `${HASH}~1`, HASH)] = patchAnswer(FILE_PATCH);
      world.git[key('show', '--format=', '--stat', HASH)] = patchAnswer(STAT_TEXT);
      return world;
    });
  add('commit diff of a root commit stays empty',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('show', '--format=', '--patch', HASH)] = patchAnswer('');
      world.git[key('rev-parse', '--verify', '--quiet', `${HASH}~1`)] = gitError({ stderr: 'fatal: bad revision' });
      world.git[key('show', '--format=', '--stat', HASH)] = patchAnswer('');
      return world;
    });
  add('commit diff empty show falls back and clears the error',
    () => get(`/api/git/commit-diff?dirId=d1&hash=${HASH}`),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('show', '--format=', '--patch', HASH)] = gitError({ stderr: 'fatal: bad object' });
      world.git[key('rev-parse', '--verify', '--quiet', `${HASH}~1`)] = patchAnswer(`${HASH}~1\n`);
      world.git[key('diff', '--patch', `${HASH}~1`, HASH)] = patchAnswer(FILE_PATCH);
      world.git[key('show', '--format=', '--stat', HASH)] = patchAnswer(STAT_TEXT);
      return world;
    });
  add('commit diff rejects an invalid hash',
    () => get('/api/git/commit-diff?dirId=d1&hash=12'),
    tag => baseWorld(tag));
  add('commit diff requires a repo',
    () => get(`/api/git/commit-diff?hash=${HASH}`),
    tag => baseWorld(tag));

  // ── directory-file-diff ─────────────────────────────────────────────────
  add('directory file diff renders a tracked patch',
    () => get('/api/git/directory-file-diff?dirId=d1&path=a.js'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('diff', '--no-color', 'HEAD', '--', 'a.js')] = patchAnswer(FILE_PATCH);
      return world;
    });
  add('directory file diff falls back without HEAD',
    () => get('/api/git/directory-file-diff?dirId=d1&path=a.js'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('diff', '--no-color', 'HEAD', '--', 'a.js')] = gitError({ stderr: 'fatal: no HEAD' });
      world.git[key('diff', '--no-color', '--', 'a.js')] = patchAnswer(FILE_PATCH);
      return world;
    });
  add('directory file diff synthesizes untracked text',
    () => get('/api/git/directory-file-diff?dirId=d1&path=new.js'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('diff', '--no-color', 'HEAD', '--', 'new.js')] = patchAnswer('');
      world.git[key(...LS_FILES_ARGS)] = patchAnswer('new.js\0');
      world.readFiles['/repo/new.js'] = { text: 'x\ny\nz\n' };
      return world;
    });
  add('directory file diff reports a double failure',
    () => get('/api/git/directory-file-diff?dirId=d1&path=a.js'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('diff', '--no-color', 'HEAD', '--', 'a.js')] = gitError({ stderr: 'fatal: no HEAD' });
      world.git[key('diff', '--no-color', '--', 'a.js')] = gitError({ stderr: 'fatal: index unreadable' });
      return world;
    });
  add('directory file diff validates the path',
    () => get('/api/git/directory-file-diff?dirId=d1&path=..%2Fescape.js'),
    tag => baseWorld(tag));
  add('directory file diff requires a directory',
    () => get('/api/git/directory-file-diff?dirId=nope&path=a.js'),
    tag => baseWorld(tag));

  // ── directory-status ────────────────────────────────────────────────────
  const statusWorld = (tag, mutate) => {
    const world = baseWorld(tag);
    world.git[key('rev-parse', '--abbrev-ref', 'HEAD')] = patchAnswer('main\n');
    world.git[key('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')] = patchAnswer('origin/main\n');
    world.git[key('rev-list', '--count', 'origin/main..HEAD')] = patchAnswer('3\n');
    world.git[key('rev-list', '--count', 'HEAD..origin/main')] = patchAnswer('1\n');
    world.git[key('status', '--porcelain')] = patchAnswer(
      ' M src/a.js\nR  old.js -> new.js\n?? .multicc-worktrees/x\n');
    if (mutate) mutate(world);
    return world;
  };
  add('directory status renders ahead behind and dirty files',
    () => get('/api/git/directory-status?dirId=d1'),
    tag => statusWorld(tag));
  add('directory status without an upstream uses the base branch',
    () => get('/api/git/directory-status?dirId=d1'),
    (tag) => {
      const world = statusWorld(tag);
      world.git[key('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')] =
        gitError({ stderr: 'fatal: no upstream configured' });
      world.git[key('rev-list', '--count', 'main..HEAD')] = patchAnswer('2\n');
      world.git[key('rev-list', '--count', 'HEAD..main')] = patchAnswer('0\n');
      return world;
    });
  add('directory status probes a missing base branch',
    () => get('/api/git/directory-status?dirId=d1'),
    (tag) => {
      const world = statusWorld(tag);
      world.directories = [mainDir({ baseBranch: undefined })];
      world.baseBranch = { value: 'trunk' };
      world.git[key('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')] =
        gitError({ stderr: 'fatal: no upstream configured' });
      world.git[key('rev-list', '--count', 'trunk..HEAD')] = patchAnswer('4\n');
      world.git[key('rev-list', '--count', 'HEAD..trunk')] = patchAnswer('2\n');
      return world;
    });
  add('directory status keeps zero counts when rev-list fails',
    () => get('/api/git/directory-status?dirId=d1'),
    (tag) => {
      const world = statusWorld(tag);
      world.git[key('rev-list', '--count', 'origin/main..HEAD')] = gitError({ stderr: 'fatal: bad rev' });
      world.git[key('status', '--porcelain')] = gitError({ stderr: 'fatal: status failed' });
      return world;
    });
  add('directory status repository failure',
    () => get('/api/git/directory-status?dirId=d1'),
    (tag) => {
      const world = baseWorld(tag);
      world.git[key('rev-parse', '--abbrev-ref', 'HEAD')] = gitError({ stderr: 'fatal: not a git repository' });
      return world;
    });
  add('directory status requires a directory id',
    () => get('/api/git/directory-status'),
    tag => baseWorld(tag));

  // ── task routes ─────────────────────────────────────────────────────────
  add('task diff files uses the board worktree',
    () => get('/api/task-board/tasks/t1/diff/files'),
    (tag) => taskWorld(tag, (world) => {
      world.git[key(...NUMSTAT_ARGS('main'))] = patchAnswer('1\t0\tx.js\0');
      world.git[key(...NAME_STATUS_ARGS('main'))] = patchAnswer('A\0x.js\0');
      world.mergeStates.t1 = MERGE;
    }));
  add('task diff file renders the patch',
    () => get('/api/task-board/tasks/t1/diff/file?path=x.js'),
    (tag) => taskWorld(tag, (world) => {
      world.git[key('diff', '--no-color', 'main', '--', 'x.js')] = patchAnswer(FILE_PATCH);
    }));
  add('task diff file requires a path',
    () => get('/api/task-board/tasks/t1/diff/file'),
    tag => taskWorld(tag));
  add('task routes report an unknown task',
    () => get('/api/task-board/tasks/nope/diff/files'),
    tag => baseWorld(tag));
  add('task diff files missing worktree',
    () => get('/api/task-board/tasks/t1/diff/files'),
    (tag) => taskWorld(tag, (world) => {
      world.absentPaths.push('/repo/task-t1');
    }));

  add('task merge lands and records its effects',
    () => post('/api/task-board/tasks/t1/merge'),
    (tag) => taskWorld(tag, (world) => {
      world.flows['merge:t1'] = { ok: true, merged: true, commits: 2 };
      world.mergeStates.t1 = MERGE;
    }));
  add('task merge conflicts',
    () => post('/api/task-board/tasks/t1/merge'),
    (tag) => taskWorld(tag, (world) => {
      world.flows['merge:t1'] = { ok: false, conflicts: ['a.js'], error: 'conflict' };
    }));
  add('task merge failure is mapped by the route',
    () => post('/api/task-board/tasks/t1/merge'),
    (tag) => taskWorld(tag, (world) => {
      world.flows['merge:t1'] = { throw: { code: 'git_operation_failed', message: 'boom', operationId: 'op-1' } };
    }));
  add('task merge reports a vanished worktree',
    () => post('/api/task-board/tasks/t1/merge'),
    (tag) => taskWorld(tag, (world) => {
      world.absentPaths.push('/repo/task-t1');
    }));

  add('task cleanup removes the worktree',
    () => post('/api/task-board/tasks/t1/cleanup-worktree', { force: true }),
    (tag) => taskWorld(tag, (world) => {
      world.flows['cleanup:t1'] = { value: { ok: true } };
    }));
  add('task cleanup null result',
    () => post('/api/task-board/tasks/t1/cleanup-worktree'),
    tag => taskWorld(tag));
  add('task cleanup blocked',
    () => post('/api/task-board/tasks/t1/cleanup-worktree'),
    (tag) => taskWorld(tag, (world) => {
      world.flows['cleanup:t1'] = { value: { ok: false, blocked: true, reasons: ['active'], error: 'busy' } };
    }));
  add('task cleanup unknown task',
    () => post('/api/task-board/tasks/t1/cleanup-worktree'),
    (tag) => taskWorld(tag, (world) => {
      world.flows['cleanup:t1'] = { value: { ok: false, code: 'task_not_found' } };
    }));

  // ── session merge ───────────────────────────────────────────────────────
  add('session merge lands',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = { ok: true, merged: true, commits: 3 };
      world.mergeStates[tag] = MERGE;
    }));
  add('session merge nothing to merge',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = { ok: true, merged: false, commits: 0 };
      world.mergeStates[tag] = MERGE;
    }));
  add('session merge conflicts',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = { ok: false, conflicts: ['a.js'], error: 'conflict' };
    }));
  add('session merge operation failure',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = { ok: false, code: 'git_operation_failed' };
    }));
  add('session merge other failure',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = { ok: false, code: 'something_else' };
    }));
  add('session merge blocked by an active session',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`merge:${tag}`] = {
        throw: { code: 'SESSION_ACTIVE', message: 'session busy', operationId: 'op-2', queueDepth: 2 },
      };
    }));
  add('session merge of a hibernated workspace',
    tag => post(`/api/sessions/${tag}/merge`),
    tag => sessionWorld(tag, { workspaceState: 'hibernated' }));
  add('session merge without a worktree',
    tag => post(`/api/sessions/${tag}/merge`),
    tag => sessionWorld(tag, { worktreePath: undefined }));
  add('session merge missing session',
    () => post('/api/sessions/nope/merge'),
    tag => sessionWorld(tag));
  add('session merge with sibling auto-sync',
    tag => post(`/api/sessions/${tag}/merge`),
    (tag) => {
      const world = sessionWorld(tag, {}, (intro) => {
        intro.flows[`merge:${tag}`] = { ok: true, merged: true, commits: 1 };
        intro.mergeStates[tag] = MERGE;
      });
      world.records.push(session(`${tag}-sib`, { branch: 'multicc/sib' }));
      world.mergeStates[`${tag}-sib`] = { mergeReady: true, dirty: false, ahead: 0, behind: 2 };
      world.flows[`sync:${tag}-sib`] = { ok: true, merged: true, commits: 2, baseBranch: 'main' };
      return world;
    });

  // ── session sync ────────────────────────────────────────────────────────
  add('session sync fast-forwards',
    tag => post(`/api/sessions/${tag}/sync`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`sync:${tag}`] = { ok: true, merged: true, commits: 4, baseBranch: 'main' };
      world.mergeStates[tag] = MERGE;
    }));
  add('session sync already current',
    tag => post(`/api/sessions/${tag}/sync`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`sync:${tag}`] = { ok: true, merged: false, commits: 0, baseBranch: 'main' };
      world.mergeStates[tag] = MERGE;
    }));
  add('session sync conflicts',
    tag => post(`/api/sessions/${tag}/sync`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`sync:${tag}`] = { ok: false, conflicts: ['a.js', 'b.js'], error: 'conflict' };
      world.mergeStates[tag] = MERGE;
    }));
  add('session sync blocked by a lease',
    tag => post(`/api/sessions/${tag}/sync`),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`sync:${tag}`] = { throw: { code: 'SESSION_LEASED', message: 'leased', queueDepth: 1 } };
    }));
  add('session sync gate on a processing task',
    tag => post(`/api/sessions/${tag}/sync`),
    tag => sessionWorld(tag, { taskState: { classifyState: 'P' } }));
  add('session sync gate on a background task',
    tag => post(`/api/sessions/${tag}/sync`),
    tag => sessionWorld(tag, { taskState: { classifyState: 'B' } }));
  add('session sync gate on a busy chat session',
    tag => post(`/api/sessions/${tag}/sync`),
    (tag) => {
      const world = sessionWorld(tag);
      world.terminalSessions.push(tag);
      return world;
    });
  add('session sync force=1 bypasses the gate',
    tag => post(`/api/sessions/${tag}/sync?force=1`),
    (tag) => sessionWorld(tag, { taskState: { classifyState: 'P' } }, (world) => {
      world.flows[`sync:${tag}`] = { ok: true, merged: false, commits: 0, baseBranch: 'main' };
      world.mergeStates[tag] = MERGE;
    }));
  add('session sync body force bypasses the gate',
    tag => post(`/api/sessions/${tag}/sync`, { force: true }),
    (tag) => sessionWorld(tag, { taskState: { classifyState: 'P' } }, (world) => {
      world.flows[`sync:${tag}`] = { ok: true, merged: false, commits: 0, baseBranch: 'main' };
      world.mergeStates[tag] = MERGE;
    }));
  add('session sync without a worktree',
    tag => post(`/api/sessions/${tag}/sync`),
    tag => sessionWorld(tag, { worktreePath: undefined }));

  // ── session rebase ──────────────────────────────────────────────────────
  add('session rebase continues',
    tag => post(`/api/sessions/${tag}/rebase`, { action: 'continue' }),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`rebase:${tag}`] = { ok: true, done: true };
      world.mergeStates[tag] = MERGE;
    }));
  add('session rebase aborts',
    tag => post(`/api/sessions/${tag}/rebase?force=1`, { action: 'abort' }),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`rebase:${tag}`] = { ok: true, aborted: true };
      world.mergeStates[tag] = MERGE;
    }));
  add('session rebase conflicts',
    tag => post(`/api/sessions/${tag}/rebase`, {}),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`rebase:${tag}`] = { ok: false, conflicts: ['a.js'], error: 'conflict' };
    }));
  add('session rebase blocked',
    tag => post(`/api/sessions/${tag}/rebase`, {}),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.flows[`rebase:${tag}`] = { throw: { code: 'SESSION_ACTIVE', message: 'active' } };
    }));
  add('session rebase without a worktree',
    tag => post(`/api/sessions/${tag}/rebase`, {}),
    tag => sessionWorld(tag, { worktreePath: undefined }));

  // ── compression ─────────────────────────────────────────────────────────
  add('diff gzip for a large patch',
    tag => get(`/api/sessions/${tag}/diff`, { ...L, 'Accept-Encoding': 'gzip, deflate' }),
    (tag) => sessionWorld(tag, {}, (world) => {
      world.git[key('diff', '--no-color', 'main')] = patchAnswer('q'.repeat(4000));
      world.git[key('diff', '--stat', '--no-color', 'main')] = patchAnswer(STAT_TEXT);
    }));

  // ── request parsing ─────────────────────────────────────────────────────
  add('malformed percent escape in the id',
    () => get('/api/sessions/%E0%A4%A/merge-status'),
    tag => sessionWorld(tag));

  return pending;
}

// ── the stub Node child: the real host composition over the world ──────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const { buildDeps, asyncHandlerFrom } =
  require(path.join(REPO, 'tests/helpers/session-git-scripted-world'));
const { createSessionGitRuntime } = require(path.join(REPO, 'src/routes/session-git'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return {}; }
}

const bag = buildDeps({});
bag.deps.asyncHandler = asyncHandlerFrom(REPO);
const runtime = createSessionGitRuntime(bag.deps);
const app = express();
app.use((req, res, next) => {
  bag.apply(readWorld());
  res.on('finish', () => {
    const recorded = {
      events: bag.effects.events.splice(0),
      broadcasts: bag.effects.broadcasts.splice(0),
      chats: bag.effects.chats.splice(0),
    };
    if (recorded.events.length || recorded.broadcasts.length || recorded.chats.length) {
      fs.appendFileSync(effectsPath,
        JSON.stringify({ case: (bag.world && bag.world.case) || null, recorded }) + '\\n');
    }
  });
  next();
});
app.use(express.json({ limit: '50mb' }));
runtime.mountRoutes(app);

const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── run ─────────────────────────────────────────────────────────────────────

main({
  name: 'session-git',
  mount(app, { repo, work }) {
    worldPath = path.join(work, 'session-git-world.json');
    effectsPath = path.join(work, 'session-git-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify(baseWorld('initial')));
    legacy = require(path.join(repo, 'tests/helpers/legacy-session-git-routes'));
    const world = require(path.join(repo, 'tests/helpers/session-git-scripted-world'));
    bag = world.buildDeps(baseWorld('initial'));
    bag.deps.asyncHandler = world.asyncHandlerFrom(repo);
    current = legacy.createSessionGitRuntime(bag.deps);
    current.mountRoutes(app);
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  corpus,
  finalize({ work }) {
    const rustEffects = new Map();
    const text = fs.readFileSync(effectsPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!entry.case) continue;
      if (!rustEffects.has(entry.case)) rustEffects.set(entry.case, { events: [], broadcasts: [], chats: [] });
      const target = rustEffects.get(entry.case);
      target.events.push(...entry.recorded.events);
      target.broadcasts.push(...entry.recorded.broadcasts);
      target.chats.push(...entry.recorded.chats);
    }
    const mismatches = [];
    for (const [tag, node] of nodeEffects) {
      const rust = rustEffects.get(tag) || { events: [], broadcasts: [], chats: [] };
      if (JSON.stringify(node) !== JSON.stringify(rust)) {
        mismatches.push({ tag, node, rust });
      }
    }
    const details = path.join(work, 'effect-mismatches.json');
    fs.writeFileSync(details, JSON.stringify(mismatches, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
      console.log(`[session-git] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[session-git] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
