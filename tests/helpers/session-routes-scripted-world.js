'use strict';

// Scripted dependency world for the session-management retirement differential
// (docs/rust-migration/differential/session-routes.js).
//
// The retired handlers (tests/helpers/legacy-session-routes/) and the surviving
// host port (src/routes/session-routes-host.js) both bottom out in the same
// handful of runtime facts: the session/directory/terminal/chat Maps, the
// folder-memory layout, the persistence journal, the CLI child processes and
// the broadcast/audit sinks. This module turns one plain JSON scenario into the
// six dependency bags the retired modules were composed with, so the frozen
// oracle and the front door's Node child read one world.
//
// Everything here is deterministic: no real filesystem, no clock, no
// randomness, no network and no subprocess. `apply(scenario)` swaps the world
// between corpus cases while every runtime keeps holding the same Maps (both
// compositions capture their deps once), and every semantic call a handler makes
// is appended to `effects.calls` so the differential can compare the side-effect
// sequence, not just the bytes.

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pushCall(state, call) {
  state.effects.calls.push(call);
}

function mapOf(entries) {
  const map = new Map();
  for (const entry of entries || []) map.set(entry.id, entry);
  return map;
}

function splitDir(full) {
  const at = String(full).lastIndexOf('/');
  if (at < 0) return ['', full];
  return [full.slice(0, at), full.slice(at + 1)];
}

function buildDeps(initialScenario = {}) {
  // The Maps the retired modules capture by reference; apply() mutates them in
  // place so the runtime never has to be rebuilt mid-run.
  const persistedSessions = new Map();
  const directories = new Map();
  const sessions = new Map();
  const chatSessions = new Map();
  const invalidSessions = new Map();

  const state = {
    scenario: initialScenario,
    files: new Map(),
    notes: [],
    effects: { calls: [] },
  };

  const scenario = () => state.scenario || {};
  const answers = () => scenario().answers || {};
  const answer = key => {
    const table = answers();
    return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  };

  // ── virtual folder memory ────────────────────────────────────────────────
  function bucket(dir) {
    if (!state.files.has(dir)) state.files.set(dir, new Map());
    return state.files.get(dir);
  }

  const folderMemory = {
    ensureDirs: (persisted) => {
      bucket(folderMemory.sessionDir(persisted));
      if (persisted && persisted.dirId) bucket(folderMemory.sharedDir(persisted.dirId));
      bucket(folderMemory.machineDir());
      if (persisted && folderMemory.cliDir(persisted.cli)) bucket(folderMemory.cliDir(persisted.cli));
    },
    sessionDir: persisted => `/mem/session/${persisted ? persisted.id : 'none'}/own`,
    sharedDir: dirId => `/mem/shared/${dirId}`,
    machineDir: () => '/mem/machine',
    cliDir: cli => (cli ? `/mem/cli/${cli}` : null),
    taskDir: (dirId, taskId) => (taskId ? `/mem/task/${dirId}/${taskId}` : null),
    scopeDir: (persisted, scope, extra = {}) => {
      switch (scope) {
        case 'own': return folderMemory.sessionDir(persisted);
        case 'shared': return folderMemory.sharedDir(persisted.dirId);
        case 'machine': return folderMemory.machineDir();
        case 'cli': return folderMemory.cliDir(persisted.cli);
        case 'task': return folderMemory.taskDir(persisted.dirId, extra.taskId);
        case 'skill': return extra.skill ? `/mem/skill/${extra.skill}` : null;
        default: return null;
      }
    },
    primaryFileName: () => 'CLAUDE.md',
    listFiles: (dir) => {
      const files = state.files.get(dir);
      return files ? [...files.keys()].sort() : [];
    },
    safeFileName: name => (typeof name === 'string' && /^[A-Za-z0-9._-]+\.md$/.test(name) ? name : null),
    safeSegment: value => (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : null),
    curatedLimit: () => 40000,
  };

  function readVirtualFile(full) {
    const [dir, name] = splitDir(full);
    const files = state.files.get(dir);
    return files ? files.get(name) : undefined;
  }

  function writeVirtualFile(full, content) {
    const [dir, name] = splitDir(full);
    bucket(dir).set(name, content);
  }

  // ── shared sinks ─────────────────────────────────────────────────────────
  function appendEvent(dirId, type, text, sessionId) {
    pushCall(state, { call: 'appendEvent', dirId: dirId === undefined ? null : dirId, type, text, sessionId: sessionId === undefined ? null : sessionId });
  }

  function workspaceBroadcast(dirId, payload) {
    pushCall(state, { call: 'workspaceBroadcast', dirId: dirId === undefined ? null : dirId, payload });
  }

  function chatBroadcast(id, payload) {
    pushCall(state, { call: 'chatBroadcast', id, payload });
  }

  function broadcastTo(clients, payload) {
    pushCall(state, { call: 'broadcastTo', clients: [...(clients || [])], payload });
  }

  const sessionPersistence = {
    begin(label) {
      pushCall(state, { call: 'persist.begin', label });
      return {
        commit() { pushCall(state, { call: 'persist.commit', label }); },
        rollback() { pushCall(state, { call: 'persist.rollback', label }); },
      };
    },
    mutate(label, fn) {
      pushCall(state, { call: 'persist.mutate', label });
      return typeof fn === 'function' ? fn(persistedSessions) : undefined;
    },
  };

  function history(id) {
    return clone((scenario().histories || {})[id]) || [];
  }

  function createSessionRecord(input) {
    pushCall(state, {
      call: 'createSessionRecord',
      dirId: input.dir ? input.dir.id : null,
      cli: input.cli === undefined ? null : input.cli,
      kind: input.kind === undefined ? null : input.kind,
      label: input.label === undefined ? null : input.label,
      loginFlow: input.loginFlow === undefined ? null : input.loginFlow,
      persistenceSource: input.persistenceSource === undefined ? null : input.persistenceSource,
    });
    const scripted = answer('createSessionRecord');
    if (scripted !== undefined) return Promise.resolve(clone(scripted));
    const id = `new-${persistedSessions.size + 1}`;
    return Promise.resolve({
      ok: true,
      id,
      session: {
        id,
        dirId: input.dir ? input.dir.id : null,
        cli: input.cli === undefined ? 'claude' : input.cli,
        kind: input.kind === undefined ? 'chat' : input.kind,
        label: input.label === undefined ? null : input.label,
      },
    });
  }

  // ── the six bags ─────────────────────────────────────────────────────────
  const memory = {
    fs: {
      unlinkSync(full) {
        const [dir, name] = splitDir(full);
        const files = state.files.get(dir);
        if (!files || !files.has(name)) {
          const error = new Error(`ENOENT: no such file, unlink '${full}'`);
          error.code = 'ENOENT';
          throw error;
        }
        pushCall(state, { call: 'unlinkMemory', path: full });
        files.delete(name);
      },
    },
    path: require('path'),
    records: persistedSessions,
    folderMemory,
    getMemoryEntries: persisted => clone((scenario().memoryEntries || {})[persisted.id]) || [],
    scanMemoryContent: body => (String(body == null ? '' : body).includes('THREAT') ? 'prompt_injection' : null),
    atomicWriteMemoryFile: (full, body) => {
      if (String(body).includes('WRITE_FAIL')) throw new Error('disk full');
      pushCall(state, { call: 'writeMemory', path: full });
      writeVirtualFile(full, body);
    },
    applyCuratedMemoryAction: (input) => {
      pushCall(state, {
        call: 'applyCuratedMemoryAction',
        dir: input.dir,
        action: input.action,
        content: input.content === undefined ? null : input.content,
        oldText: input.oldText === undefined ? null : input.oldText,
        charLimit: input.charLimit,
      });
      if (String(input.content == null ? '' : input.content).includes('BAD_ACTION')) {
        return { ok: false, code: 'invalid_content', error: 'curated action rejected', message: 'rejected' };
      }
      return { ok: true, message: `${input.action} applied`, added: 1, total: 2 };
    },
    appendEvent,
    workspaceBroadcast,
    directoriesKeys: () => directories.keys(),
  };

  const notesStore = {
    saveNotes() { pushCall(state, { call: 'saveNotes', count: state.notes.length }); },
    pendingNotesFor(id) { return state.notes.filter(note => note.toSessionId === id && !note.delivered).length; },
    getNotes() { return state.notes; },
  };

  const meta = {
    persistedSessions,
    asyncHandler: fn => fn,
    appendEvent,
    workspaceBroadcast,
    saveNotes: notesStore.saveNotes,
    pendingNotesFor: notesStore.pendingNotesFor,
    getNotes: notesStore.getNotes,
    getLivenessRuntime: () => ({
      assess: (id, options) => {
        pushCall(state, { call: 'assess', id, probe: !!(options && options.probe) });
        return Promise.resolve(clone((scenario().liveness || {})[id]) || { state: 'idle', since: 0 });
      },
    }),
  };

  const create = {
    directories,
    createSessionRecord,
    asyncHandler: fn => fn,
    sessions: persistedSessions,
    disposeLoginTerminal: (flow) => { pushCall(state, { call: 'disposeLoginTerminal', flow: flow === undefined ? null : flow }); return Promise.resolve(); },
    createTask: (input) => {
      pushCall(state, { call: 'createTask', dirId: input.dirId, title: input.title, cli: input.cli });
      return Promise.resolve(answer('createTask') || { sessionId: 'new-task', taskId: 'tk-new', url: '/air?task=tk-new' });
    },
    getRecord: id => persistedSessions.get(id),
  };

  const profile = {
    persistedSessions,
    directories,
    sessionPersistence,
    sessionPolicy: {
      normalizeEffort: value => (value === 'bogus' ? undefined : (value || null)),
      validEffortForCli: (cli, effort) => effort !== 'unsupported',
      effectiveSessionEffort: s => s.effort || 'medium',
      effortLabel: effort => String(effort || 'medium'),
      normalizeCliAgent: (cli, agent) => (agent === 'bogus' ? undefined : (agent || null)),
      providerDefaultModel: () => 'provider-default-model',
      effectiveSessionModel: s => s.model || 'default-model',
      serializeSubagent: value => (value === undefined ? null : value),
    },
    providers: {
      appTypeForCli: cli => cli || 'claude',
      modelValidForProvider: () => true,
      codexProviderProxyable: () => true,
      synchronizeCodexSessionRoute: (route) => { pushCall(state, { call: 'synchronizeCodexSessionRoute', route }); },
      CODEX_HOMES_DIR: '/codex-homes',
    },
    providerRouterRuntime: {
      getProviderSummary: (appType, id) => answer('providerSummary') || { name: `Provider ${id}`, model: 'provider-default-model', appType: appType || 'claude' },
    },
    getChatStream: () => state.chatStream,
    getChatState: id => chatSessions.get(id),
    hasLiveBackgroundTasks: id => (scenario().background || []).includes(id),
    validProviderId: (cli, id) => ({ ok: true, value: id || null }),
    asyncHandler: fn => fn,
    appendEvent,
    workspaceBroadcast,
    chatBroadcast,
    getTaskState: record => (record && record.taskState) || {},
    rememberActiveCliState: s => { pushCall(state, { call: 'rememberActiveCliState', id: s.id }); },
    buildHandoffCheckpoint: (input) => {
      pushCall(state, { call: 'buildHandoffCheckpoint', fromCli: input.fromCli, toCli: input.toCli, messages: (input.history || []).length });
      return { createdAt: 1700000000123, fromCli: input.fromCli, toCli: input.toCli };
    },
    cliStateSummary: s => clone((scenario().cliStates || {})[s.id]) || [],
    cliAvailabilitySummary: () => clone(scenario().cliAvailability) || [],
    cliHandoffSummary: s => clone((scenario().handoffs || {})[s.id]) || null,
    createSessionRecord,
    loadChatHistory: history,
    newChatMsgId: () => 'msg-fork-1',
    mergeHistory: (id, messages, options) => {
      pushCall(state, { call: 'mergeHistory', id, count: (messages || []).length, reason: options ? options.reason : null });
      return Promise.resolve();
    },
    getFolderMemory: () => folderMemory,
    getCliSwitchGitSnapshot: () => (async (session) => {
      pushCall(state, { call: 'gitSnapshot', id: session ? session.id : null });
      return { commit: 'abc123' };
    }),
    cliKeyAccounts: { has: () => false },
  };

  const bundle = {
    persistedSessions,
    directories,
    asyncHandler: fn => fn,
    appendEvent,
    createSessionRecord,
    loadChatHistory: history,
    replaceHistory: (id, messages, options) => {
      pushCall(state, { call: 'replaceHistory', id, count: (messages || []).length, reason: options ? options.reason : null });
      return Promise.resolve();
    },
    mergeHistory: (id, messages, options) => {
      pushCall(state, { call: 'mergeHistory', id, count: (messages || []).length, reason: options ? options.reason : null });
      return Promise.resolve();
    },
    getFolderMemory: () => folderMemory,
    listInstalledSkills: () => clone(scenario().skills) || [],
    getSkillSyncRuntime: () => ({}),
    agentsSkillsDir: '/agents/skills',
  };

  state.chatStream = {
    status: id => clone((scenario().streamStatus || {})[id]) || null,
    close: (id) => { pushCall(state, { call: 'stream.close', id }); },
  };

  function existsSync(full) {
    return !(scenario().missingPaths || []).includes(full);
  }

  const lifecycle = {
    sessions,
    chatSessions,
    persistedSessions,
    directories,
    invalidSessions,
    sessionPersistence,
    getChatStream: () => state.chatStream,
    hasLiveBackgroundTasks: id => (scenario().background || []).includes(id),
    reapBackgroundTasks: (id, reason) => { pushCall(state, { call: 'reapBackground', id, reason }); return 0; },
    getSessionWorkHost: () => ({
      cancelActiveTurn: (id, options) => {
        pushCall(state, { call: 'cancelActiveTurn', id, reason: options.reason });
        return Promise.resolve(answer('cancelActiveTurn') || { ok: true });
      },
    }),
    asyncHandler: fn => fn,
    destroySessionCascade: (persisted, dir, options) => {
      pushCall(state, { call: 'destroySessionCascade', id: persisted.id, dirId: dir.id, force: !!(options && options.force) });
      return Promise.resolve(answer('destroySessionCascade') || { ok: true, removed: ['worktree', 'tmux'], forced: !!(options && options.force) });
    },
    tmuxKillSession: (id) => { pushCall(state, { call: 'tmuxKill', id }); return Promise.resolve(); },
    appendEvent,
    ensureDirGitReady: (dir) => {
      pushCall(state, { call: 'ensureDirGitReady', dirId: dir.id });
      return Promise.resolve(answer('ensureDirGitReady') || { ok: true });
    },
    gitRelocateWorktree: (from, to, persisted, options) => {
      pushCall(state, { call: 'gitRelocateWorktree', from: from ? from.id : null, to: to.id, id: persisted.id, force: !!(options && options.force), carry: !!(options && options.carry) });
      return Promise.resolve(answer('gitRelocateWorktree') || {
        ok: true, worktreePath: `/repo/wt/${persisted.id}`, branch: `multicc/${persisted.id}`,
        carried: null, operationId: 'op-relocate', queueDepth: 0,
      });
    },
    gitWorktreeAdd: (dirPath, id, baseBranch) => {
      pushCall(state, { call: 'gitWorktreeAdd', dirPath, id, baseBranch: baseBranch === undefined ? null : baseBranch });
      return Promise.resolve(answer('gitWorktreeAdd') || { worktreePath: `/repo/wt/${id}`, branch: `multicc/${id}` });
    },
    fs: { existsSync },
    broadcastTo,
    stopOutputCapture: (session) => { pushCall(state, { call: 'stopOutputCapture', id: session.id }); return Promise.resolve(); },
    assignKillReason: (runner, reason) => { pushCall(state, { call: 'assignKillReason', reason }); },
    finishProviderAttempt: (attempt, facts) => {
      pushCall(state, { call: 'finishProviderAttempt', outcome: facts.outcome, errorCategory: facts.errorCategory, reasonCode: facts.reasonCode });
    },
    createSession: (id) => {
      pushCall(state, { call: 'createSession', id });
      const scripted = answer('createSession');
      if (scripted && scripted.throw) return Promise.reject(new Error(scripted.throw));
      return Promise.resolve();
    },
    cwdForSession: persisted => (persisted && persisted.cwd) || `/repo/wt/${persisted ? persisted.id : 'none'}`,
    cleanupPushMonitor: (id) => { pushCall(state, { call: 'cleanupPushMonitor', id }); },
    getSessionGitRuntime: () => ({ isWorktreeActive: () => false }),
    codexRolloutGuard: {
      enforce: (persisted, options) => {
        pushCall(state, { call: 'codexGuard', id: persisted.id, force: !!(options && options.force) });
        return answer('codexGuard') || { action: 'none' };
      },
    },
    // The /ws/chat replay buffer + live membership are native state behind the
    // replay hub. This world registers no sockets, so clearing/dropping a session
    // is unobservable to the differential — exactly like the retired oracle's
    // no-op `terminate()` on its fake string clients.
    replay: {
      clear() {},
      drop() {},
      reset() {},
      clearClients() {},
    },
  };

  // ── apply ────────────────────────────────────────────────────────────────
  function apply(next) {
    state.scenario = next || {};
    const w = scenario();

    persistedSessions.clear();
    for (const record of w.records || []) persistedSessions.set(record.id, clone(record));
    directories.clear();
    for (const dir of w.directories || []) directories.set(dir.id, clone(dir));

    sessions.clear();
    for (const [id, spec] of Object.entries(w.sessions || {})) {
      const value = spec || {};
      sessions.set(id, {
        id,
        clients: new Set(Array.from({ length: Number(value.clients) || 0 }, (_, index) => `t${index}`)),
        exitCheckTimer: null,
        captureTimer: null,
      });
    }
    chatSessions.clear();
    for (const [id, spec] of Object.entries(w.chats || {})) {
      const value = spec || {};
      chatSessions.set(id, {
        id,
        clients: new Set(Array.from({ length: Number(value.clients) || 0 }, (_, index) => `c${index}`)),
        isStreaming: value.streaming === true,
        claudeProc: value.claudeProc === false ? null : { kill() {} },
      });
    }
    invalidSessions.clear();
    for (const [id, value] of Object.entries(w.invalid || {})) invalidSessions.set(id, clone(value));

    state.files = new Map();
    for (const [dir, files] of Object.entries(w.files || {})) {
      state.files.set(dir, new Map(Object.entries(files).map(([name, content]) => [name, String(content)])));
    }
    state.notes = clone(w.notes) || [];
    state.effects.calls.length = 0;
  }

  apply(initialScenario);

  return {
    deps: { create, profile, memory, bundle, lifecycle, meta },
    apply,
    effects: state.effects,
    world: scenario,
    state,
  };
}

module.exports = { buildDeps };
