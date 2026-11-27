'use strict';
const path = require('node:path');

function attempt(fn) {
  try { return { value: fn() }; }
  catch (err) { return { error: err.name, message: err.message }; }
}

const probes = {
  requestLocality(m) {
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' } };
    const local = m.isLocalRequest(request);
    request.headers.forwarded = 'for=example.test';
    return [local, m.isLocalRequest(request), Object.isFrozen(m.FORWARDING_HEADERS), [...m.LOOPBACK_ADDRESSES]];
  },
  cliResultCompletion(m) {
    return [null, {}, { type: 'result', subtype: 'success', is_error: false },
      { type: 'result', subtype: 'error_during_execution', is_error: true }]
      .map(event => [m.isMainResult(event), m.resultCompletion(event)]);
  },
  cliCompletion(m) {
    const adapter = { createCompletionTracker() { return this; } };
    return [m.createAdapterCompletion(adapter) === adapter, m.completion('completed', 'ok'),
      Object.keys(m.createAdapterCompletion({})), m.isCompleted(null)];
  },
  cliCapability(m) {
    return ['codex','claude','unknown'].map(cli => [m.displayNameOf(cli), m.supportsEffort(cli, null, 'high')]);
  },
  repoActor(m) {
    return [m.defaultRepoActor instanceof m.RepoActor, new m.RepoActor() instanceof m.RepoActor];
  },
  gitService(m) {
    return [m.WORKTREE_SUBDIR, m.isPermissionDeniedGitError(new Error('permission denied')),
      m.isDeveloperToolsMissingGitError(new Error('xcrun: error: invalid active developer path')),
      m.defaultRepoActor instanceof require('../../src/repo-actor').RepoActor];
  },
  taskBoardCore(m) {
    const board = m.createEmptyBoard();
    return [Object.keys(board), m.taskOriginForSource('manual'), m.legacyTaskOrigin('unknown')];
  },
  sessionWork(m) { return ['wait.result','dispatch.request','wait.callback','unknown'].map(type => [m.isControlItem({ type, payload:{} }), m.workKind({ type, payload:{} })]); },
  codexHistoryHooks(m) {
    const boom = new RangeError('logger');
    const options = { get logger() { throw boom; } };
    const hooks = m.createCodexHistoryHooks({});
    return [Object.isFrozen(hooks), Object.keys(hooks), attempt(() => m.createCodexHistoryHooks(options))];
  },
  modelHistoryConverter(m) {
    const body = { input: [{ role: 'user', content: '你好' }] };
    return [m.normalizeResponsesHistory(body), m.stripUnresolvedItemReferences(body),
      attempt(() => m.normalizeResponsesHistory(body, null))];
  },
  stateContainer(m) {
    const mark = new Map(), before = m.sessions;
    try { m.sessions = mark; return [before, m.sessions === mark, m.persistedSessions, m.directories]; }
    finally { m.sessions = before; }
  },
  eventBus(m) {
    const key = Symbol('probe'), seen = [];
    m.once(key, v => seen.push(v));
    return [m.getMaxListeners(), m.emit(key,'one'), m.emit(key,'two'), seen];
  },
  airRoutes(m) {
    const calls = [], app = { get(p) { calls.push(['GET',p]); }, post(p) { calls.push(['POST',p]); } };
    return [attempt(() => m.mountAirRoutes(app, {})), calls];
  },
  chatHistoryService(m) {
    return [m.cleanThinkingBlocks({ role:'assistant', content:[{ type:'text', text:'x' }] }),
      attempt(() => m.createChatHistoryService({}))];
  },
  voiceRouter(m) {
    return [m.isVoiceRouterRecord(null), m.isVoiceRouterRecord({ id:m.VOICE_ROUTER_ID, type:'gateway', kind:'chat' }),
      attempt(() => m.createVoiceRouterProvisioner(null)), attempt(() => m.createVoiceRouterProvisioner()), attempt(() => m.createVoiceRouterProvisioner({records:new Map()}))];
  },
  rolloutPath(m) {
    return [m.DEFAULT_MISS_TTL_MS, attempt(() => m.createRolloutPathResolver(null)), attempt(() => m.createRolloutPathResolver()),
      attempt(() => m.createRolloutPathResolver({ fs:{ existsSync(){}, readdirSync(){} }, path }))];
  },
  tunnelMonitor(m) { return ['linux','win32'].map(platform => path.basename(m.defaultFrpcDest({ dataDir: path.resolve('isolated-tunnel'), platform }))); },
  orchestrationHost(m) { return [attempt(() => m.publicWait(null)), m.publicWait({ metadata:{}, id:'w' }), Object.isFrozen(m.DEFAULTS), m.DEFAULTS]; },
  chatApi(m) { return [m.sanitizeMessage('hello'), typeof m.createTurnRuntimeStore, typeof m.createApiErrorHost]; },
  taskBoardRouting(m) {
    const record = { id:'r', type:'tmux', lastActivity:1234 }, rows = new Map([['r',record]]);
    const options = { isAvailable() { throw new Error('injected'); } };
    return [[...m.routingTerms('one 二三')], m.recordAppearsAvailable(record, 'r', options),
      m.pickDirTarget(rows,'d','r',options), m.rankRoutingCandidates(rows,{ dirId:'d' })];
  },
};

function observe(name, api) {
  const exports = Object.keys(api).map(k => {
    const d = Object.getOwnPropertyDescriptor(api, k);
    return [k, d.get ? 'get' : typeof d.value, typeof d.value === 'function' ? d.value.length : null];
  });
  return JSON.parse(JSON.stringify({ exports, behavior: attempt(() => probes[name](api)) }));
}

module.exports = { observe };
if (require.main === module) {
  const fs = require('node:fs');
  const entries = JSON.parse(fs.readFileSync(process.argv[2]));
  const output = {};
  for (const [name, entry] of Object.entries(entries)) {
    const file = typeof entry === 'string' ? entry : entry.entry;
    output[name] = attempt(() => observe(name, require(path.resolve(file))));
  }
  const content = JSON.stringify(output);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], content+'\n');
  else process.stdout.write(content);
}
