'use strict';
// 新会话的「自动提交并合并回基分支」缺省是**开**的。
//
// 这条是产品决定，不是实现细节：新任务的每轮勾选框默认就是勾上的状态，用户
// 主动关掉（会话开关 PATCH 或取消勾选）才是关。2026-09-23 它被误改成「缺省关」
// 并合进了 main —— 当时没有任何测试会变红，所以这里把它钉死：默认值只在
// create-record 的参数默认值里写，但「字段缺失怎么读」散在 Air 视图模型 / App
// 的 Session 解析里（`!= false` = 缺键算开），两边必须一致。
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionRecordFactory } = require('../src/session/create-record');
// src/session 不能 require 车道表（bounded context），所以由组合根注入；这里给真表，
// 免得桩掉之后 streaming 这类字段在测试里和生产不一致。
const { isResidentSession } = require('../src/cli/cli-capability');

// 只看创建默认值：每个端口都换成桩，但记录本身由生产代码拼出来。
function createHarness() {
  const persisted = new Map();
  const factory = createSessionRecordFactory({
    isResidentSession,
    sharedWorkspace: () => ({ worktreePath: '/wt/shared', branch: 'multicc/shared' }),
    SUPPORTED_CHAT_CLIS: ['claude', 'codex'],
    validateExperimentalSession: () => ({ ok: true }),
    tuiChatMirrorEnabled: () => false,
    normalizeEffort: value => (value == null ? null : String(value)),
    validEffortForCli: () => true,
    codexDefaultReasoningLevel: () => null,
    normalizeCliAgent: () => null,
    validateProviderSelection: () => ({ ok: true, value: null }),
    providers: { normalizeOfficialProviderId: (_cli, id) => (id === undefined ? null : id) },
    primaryProviderCandidate: () => null,
    providerDefaults: {},
    validProviderId: () => ({ ok: true, value: null }),
    allocateSessionId: () => `sess-${persisted.size + 1}`,
    persistedSessions: persisted,
    ensureDirGitReady: async () => ({ ok: true }),
    friendlyDirReason: reason => String(reason),
    WORKTREE_SUBDIR: '.multicc-worktrees',
    gitWorktreeAdd: async (dirPath, sid) => ({
      worktreePath: `${dirPath}/.multicc-worktrees/${sid}`, branch: `multicc/${sid}`,
    }),
    gitWorktreeRollbackCreate: async () => {},
    sanitizeLoginEnv: () => ({ ok: true }),
    ensureCliStates: () => {},
    sessionPersistence: { mutate: () => {} },
    savePersistedSessionsBestEffort: () => {},
    appendEvent: () => {},
    cliForLoginFlow: () => null,
  });
  return { factory, persisted, dir: { id: 'd', path: '/repo', baseBranch: 'main' } };
}

test('a new session defaults to auto-commit ON, and only an explicit false turns it off', async () => {
  const { factory, persisted, dir } = createHarness();
  const created = await factory({ dir, cli: 'claude', kind: 'chat' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.session.autoCommit, true, '缺省必须是 true 本身，不是 undefined/真值');
  assert.equal(persisted.get(created.id).autoCommit, true, '落库的记录也一样');

  const optedOut = await factory({ dir, cli: 'claude', kind: 'chat', autoCommit: false });
  assert.equal(optedOut.session.autoCommit, false, '显式 false 必须真的关掉（实验分支靠它）');

  const optedIn = await factory({ dir, cli: 'claude', kind: 'chat', autoCommit: true });
  assert.equal(optedIn.session.autoCommit, true);
});

// Air 里新建的任务走任务壳（src/task-shell/host.js 的 createExecution），它曾经写死
// `autoCommit: false`：会话开关显示「开」是缺省口径，新任务却一律是关。任务壳必须
// 吃同一个缺省，不能自己再传 false。
test('Air task-shell executions inherit the auto-commit default instead of forcing it off', () => {
  const fs = require('node:fs'), path = require('node:path');
  const host = fs.readFileSync(path.join(__dirname, '../src/task-shell/host.js'), 'utf8');
  const create = host.slice(host.indexOf('createExecution:'), host.indexOf('indexTask:'));
  assert.ok(create.includes('createSessionRecord'), '找到任务壳的创建入口');
  assert.doesNotMatch(create, /autoCommit/, '任务壳创建执行会话时不许覆盖 autoCommit');
});

// 「缺字段怎么读」在每个对外投影里都得是「开」，否则同一条记录在不同入口显示不一样。
test('every session projection reads a missing autoCommit as ON', () => {
  const { toSessionDto } = require('../src/session-dto');
  {
    assert.equal(toSessionDto({ id: 's', kind: 'chat', cli: 'claude', dirId: 'd' }).autoCommit, true);
    assert.equal(toSessionDto({ id: 's', kind: 'chat', cli: 'claude', dirId: 'd', autoCommit: false }).autoCommit, false);
  }
  const fs = require('node:fs'), path = require('node:path');
  for (const file of ['src/session-dto.js', 'src/routes/session-admin.js', 'src/workspace/air-routes.js', 'public/chat.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/!!\s*[\w.]*\.autoCommit\b/.test(text), false, `${file} 不许用 !! 读 autoCommit（缺键会读成关）`);
  }
});
