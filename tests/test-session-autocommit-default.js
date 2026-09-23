'use strict';
// 新会话的「自动提交并合并回基分支」缺省是关的。
//
// 这条不变量以前是反的（`autoCommit !== false`），后果是每建一个新会话就默认
// 开着自动合并：一轮成功、工作树又不脏的时候，谁也没点过任何开关，代码就自己
// 回 main 了。默认值只在 create-record 的参数默认值里写了一次，散落各处的是
// 对「字段缺失」的解读（session-dto / air 视图模型 / App 的 Session 解析），
// 三处必须一致，否则 Air 的开关会跟网页 `#auto-commit-btn` 显示相反的状态。
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionRecordFactory } = require('../src/session/create-record');
const { toSessionDto } = require('../src/session-dto');

// 只看创建默认值：每个端口都换成桩，但记录本身由生产代码拼出来。
function createHarness() {
  const persisted = new Map();
  const factory = createSessionRecordFactory({
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

test('a new session starts with auto-commit off unless it is asked for', async () => {
  const { factory, persisted, dir } = createHarness();
  const created = await factory({ dir, cli: 'claude', kind: 'chat' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.session.autoCommit, false, '缺省必须是 false 本身，不是 undefined/0');
  assert.equal(persisted.get(created.id).autoCommit, false, '落库的记录也一样');

  const optedIn = await factory({ dir, cli: 'claude', kind: 'chat', autoCommit: true });
  assert.equal(optedIn.session.autoCommit, true, '显式打开仍然有效（会话开关 / 每轮勾选靠它）');

  const optedOut = await factory({ dir, cli: 'claude', kind: 'chat', autoCommit: false });
  assert.equal(optedOut.session.autoCommit, false);
});

test('a session record that predates the field reads as off through the public DTO', () => {
  // 老记录（没有这个键）在新语义下必须读成「关」——Air 的开关状态、
  // App 的 Session 解析都走这个 DTO，缺键读成「开」会让它们显示成开着。
  const dto = toSessionDto({
    id: 'legacy', dirId: 'd', cli: 'claude', kind: 'chat', createdAt: new Date().toISOString(),
  });
  assert.equal(dto.autoCommit, false);

  const on = toSessionDto({
    id: 'legacy-on', dirId: 'd', cli: 'claude', kind: 'chat', autoCommit: true,
    createdAt: new Date().toISOString(),
  });
  assert.equal(on.autoCommit, true, '已经开着的老会话不受这次默认值调整影响');
});
