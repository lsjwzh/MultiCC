'use strict';

// Development/build tooling only. Packaged applications use their own addon.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function cacheRoot(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'],
    { encoding: 'utf8', timeout: 10_000 });
  const main = result.status === 0 && result.stdout.split('\0').find(item => item.startsWith('worktree '));
  if (main) return path.join(main.slice(9), 'data', 'rust-source');
  // Source archives have no primary worktree. Keep their cache outside the tree.
  const id = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.cache', 'multicc', 'rust-source', id);
}

function sourceFingerprint(repoRoot, env = process.env) {
  const hash = createHash('sha256').update('multicc-source-rust-v1\0');
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory() && !['target', 'prebuilt'].includes(entry.name)) walk(rel);
      else if (entry.isFile() && (/\.rs$/.test(entry.name) || ['Cargo.toml', 'Cargo.lock', 'config.toml'].includes(entry.name))) {
        const body = fs.readFileSync(path.join(repoRoot, rel));
        hash.update(rel.split(path.sep).join('/') + '\0' + body.length + '\0').update(body);
      }
    }
  }
  walk('native');
  for (const name of ['build-rust-kernels.js', 'rust-source-cache.js']) {
    hash.update(name + '\0').update(fs.readFileSync(path.join(repoRoot, 'scripts', name)));
  }
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CFLAGS']) {
    hash.update(key + '\0' + (env[key] || '') + '\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function sourcePaths(repoRoot, env = process.env) {
  repoRoot = path.resolve(repoRoot);
  const fingerprint = sourceFingerprint(repoRoot, env);
  const root = cacheRoot(repoRoot);
  // One target directory per checkout keeps worktrees from replacing each
  // other's Cargo output. The final addon path is immutable per source hash.
  const checkout = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return { fingerprint, prebuiltDir: path.join(root, fingerprint),
    targetDir: env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'multicc-rust-source-target', checkout) };
}

// Which source produced an addon: `<addon>.source.json` holds the source
// fingerprint and the sha256 of the exact bytes. A shared output directory can
// be overwritten by a build from another checkout, so a reader must check both
// that the record describes the file on disk and that it names today's source.
function provenancePath(file) {
  return `${file}.source.json`;
}

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeProvenance(file, fingerprint) {
  const record = provenancePath(file);
  const temporary = `${record}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ fingerprint, sha256: fileSha256(file) })}\n`);
  fs.renameSync(temporary, record);
}

function builtFromSource(file, fingerprint) {
  try {
    const record = JSON.parse(fs.readFileSync(provenancePath(file), 'utf8'));
    return !!record && record.fingerprint === fingerprint && record.sha256 === fileSha256(file);
  } catch (_) {
    return false;
  }
}

function probeAddon(file, node = process.execPath) {
  if (!fs.existsSync(file)) return false;
  // A separate process avoids require() caching and contains invalid binaries.
  const script = `const a=require(process.argv[1]);
    if(a.protocolVersion?.()!==1 || a.cprProtocolVersion?.()!==1 || typeof a.cprClaudeQuota!=='function' || typeof a.cprCreateExchange!=='function' || typeof a.RustDatabase!=='function'
      || typeof a.buildSearchIndex!=='function' || typeof a.computeUsage!=='function'
      || typeof a.windowsToolsDiscover!=='function' || typeof a.cliCatalog!=='function'
      || ['autoProviderLimitState','autoProviderChooseCandidate','autoProviderFailoverSafety','autoProviderPolicyFacts','providerErrorFacts','autoProviderFacts'].some(key=>typeof a[key]!=='function')
    || ['networkPolicyResolve','networkPolicyEnvEnabled','networkPolicyIsLoopbackHost','networkPolicyFindAvailablePort'].some(key=>typeof a[key]!=='function')
    || ['classifyVocabCatalog','parseClassifyResult','classifyVocabRequest'].some(key=>typeof a[key]!=='function')
    || ['turnStateCatalog','resolveTurnState','taskRoutingCatalog','taskRoutingRequest','eventsCatalog','eventsRequest'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['providerStore','providerCredential','readProviderCliCredential','accountSubscriptionPlan',
      'accountSubscriptionResult','queryAccountSubscription','RustProviderRequest','authorizeProviderRequest',
      'codexOfficialError','recordSecretAudit'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['contextSelectionTerms','contextSelectionRelevance','contextSelectionMinRelevance',
      'contextSelectionClipTokens','contextSelectionSelect','usageObservedCatalog',
      'usageObservedRequestValue'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['apiErrorFacts','apiErrorSignaturesQuoted','apiErrorPrepare','apiErrorNormalize',
      'apiErrorDecide','apiErrorRetryNotice','apiErrorMetricToken','apiErrorIsErrorOnlyText',
      'apiErrorSplitTrailingEnvelope','apiErrorDetectEnvelope','apiErrorClaudeEnvelope',
      'apiErrorEnvelopeSourceFor','apiErrorIsKnownHarmlessStderrLine','apiErrorParseRetryAfter',
      'apiErrorResetAfterFromText'].some(key=>typeof a[key]!=='function')) process.exit(1);
    // An exported function is insufficient: Windows must be able to lock,
    // append and flush an audit record before this addon can run chat turns.
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const auditRoot=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-addon-audit-'));
    try {
      const file=path.join(auditRoot,'logs','audit.jsonl');
      const started=JSON.parse(a.recordSecretAudit(file,JSON.stringify({operation:'env_inject',phase:'started'})));
      a.recordSecretAudit(file,JSON.stringify({operation:'env_inject',phase:'completed',callId:started.callId}));
      const rows=fs.readFileSync(file,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
      if(rows.length!==2 || rows[0].callId!==started.callId || rows[1].callId!==started.callId
        || rows[0].outcome!=='started' || rows[1].outcome!=='succeeded') throw Error('audit_preflight_failed');
    } finally { fs.rmSync(auditRoot,{recursive:true,force:true}); }
    if(a.taskStoreProtocolVersion?.()!==1 || a.taskDomainProtocolVersion?.()!==1
      || ['RustTaskStore','RustAirCardCache','RustTaskBoard','taskDomain','taskDomainAsync','buildTaskRunContext','jsBridgeRoundTrip','jsBridgeJsonView','jsBridgeJsonRoundTrip'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(typeof a.RustAirCardCache.prototype.prepareAsync!=='function' || typeof a.RustAirCardCache.prototype.prepareBoardAsync!=='function') process.exit(1);
    const store=new a.RustTaskStore(':memory:');
    store.run(JSON.stringify({op:'set',kind:'task',id:'smoke',body:JSON.stringify({id:'smoke'})}));
    if(JSON.parse(store.run('{"op":"get","kind":"task","id":"smoke"}')).id!=='smoke') process.exit(1);
    store.run('{"op":"close"}');
    if(JSON.parse(a.taskDomain('{"op":"normalize","action":"createEmptyBoard"}')).result.schemaVersion!==2) process.exit(1);
    const db=new a.RustDatabase(':memory:',false,false,5000);
    db.exec('CREATE TABLE smoke(x); CREATE VIRTUAL TABLE f USING fts5(x)');db.close();
    if(typeof a.syncWorktreeOnWake!=='function' || typeof a.validatePublicationText!=='function' || typeof a.quickCommitMessage!=='function'
      || typeof a.gitCommitEnvironment!=='function' || typeof a.validatePublicationRecords!=='function'
      || typeof a.planTaskContextRead!=='function' || typeof a.selectTaskContextRecords!=='function'
      || typeof a.rankTaskContextCandidates!=='function' || typeof a.RustTaskReadModel!=='function' || a.taskReadModelProtocolVersion?.()!==1) process.exit(1);
    if(['quotaGuardRequestValue','RustQuotaGuard'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(typeof a.quotaRejectionRequestValue!=='function') process.exit(1);
    if(typeof a.modelRequestPolicyValue!=='function') process.exit(1);
    if(typeof a.RustModelDefaults!=='function') process.exit(1);
    if(new a.RustModelDefaults(0).resolve({appType:'claude',models:['probe']},()=>[],()=>0)!=='probe') process.exit(1);
    if(typeof a.retryPolicyValue!=='function') process.exit(1);
    if(typeof a.RustRequestTimer!=='function') process.exit(1);
    if(typeof a.requestLocality!=='function' || !a.requestLocality('local',{socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost'}})
      || a.requestLocality('local',{socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost',Forwarded:''}})) process.exit(1);
    if(a.RustWorkspaceAccess || a.RustWorkspaceAccessReservation) process.exit(1);
    if(typeof a.RustExternalWorkspaces!=='function' || ['run','query'].some(key=>typeof a.RustExternalWorkspaces.prototype[key]!=='function') || a.RustWorkspaceRemote) process.exit(1);
    if(typeof a.RustWorkspaceSharing!=='function' || typeof a.workspaceSharingParse!=='function'
      || ['run','query','connectGateway','importShare'].some(key=>typeof a.RustWorkspaceSharing.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustRelayShares!=='function' || typeof a.RustRelayShares.prototype.run!=='function'
      || typeof a.relayShareParse!=='function') process.exit(1);
    if(typeof a.RustRequestWatch!=='function') process.exit(1);
    if(a.cprRequestLifecycleVersion?.()!==3 || typeof a.RustCprExchange!=='function'
      || ['startStreamWatch','stopStreamWatch','finishStreamWatch','noteStreamProgress','streamProgressed','streamTimeoutCode'].some(key=>typeof a.RustCprExchange.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustModelStreamProgress!=='function') process.exit(1);
    if(typeof a.RustProviderAttemptLifecycle!=='function') process.exit(1);
    if(typeof a.RustClaudeLane!=='function'
      || ['start','sendUser','interrupt','setModel','getTaskOutput','stopTask','respondControl','respondControlError','closeInput','kill','stderrTail'].some(key=>typeof a.RustClaudeLane.prototype[key]!=='function')) process.exit(1);
    if(['providerEventFence','providerHostTextEnvelope'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['providerRequiredIdentity','providerPositiveInteger','providerTimeoutBudget','providerAttemptFields',
      'providerRevision','providerEncodeProxySession','providerDecodeProxySession','providerValidateAttemptTransition', 'providerBackgroundLingers', 'providerAuthorizeProxyRequest',
      'providerNonMainProducerKey', 'providerProxyActivity', 'providerBoundProxyAttempt',
      'providerForceReleaseProducers', 'providerDrainStaleProducers'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['chatApplyClaudeEvent','chatApplyAdapterEvent','chatOwnsCurrentRunner','chatAssignKillReason','chatClearSucceededErrors','chatRecordResultEvent',
      'chatRecordCloseResult','chatRecordPartialCheckpoint','chatHasPartialCheckpoint'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['chatPlanTurnFinalization','chatPlanRetryBlockedFinalization','chatResolveTurnFinalization',
      'chatClassifyProcessExit','chatNormalizeHandoff','chatIsGuardedHandoffFailure'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['cliCompletion','cliIsCompleted','cliIsMainResult','cliResultCompletion','cliProtocolCompletion',
      'cliProxyFailureCompatible','cliCanPersistCompletion'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(typeof a.RustCliCompletionTracker!=='function'
      || ['acceptsRaw','observeDecoded','observeProtocol','finish'].some(key=>typeof a.RustCliCompletionTracker.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustStepCompletionTracker!=='function'
      || ['observe','close'].some(key=>typeof a.RustStepCompletionTracker.prototype[key]!=='function')) process.exit(1);
    for(const name of ['RustKimiCompletionTracker','RustPiCompletionTracker']) {
      if(typeof a[name]!=='function' || ['observe','close'].some(key=>typeof a[name].prototype[key]!=='function')) process.exit(1);
    }
    if(typeof a.evaluateChatPostTurn!=='function' || typeof a.decideChatRunnerFinality!=='function' || typeof a.RustChatTurnLifecycle!=='function'
      || ['resultDurable','resultRunnerId','postTurnClaimed','setResultDurable','setResultRunnerId',
        'setPostTurnClaimed','claimPostTurn','beginResultAppend','endResultAppend',
        'recordConfirmedResult','hasConfirmedResult','confirmedResultOwner'].some(key=>typeof a.RustChatTurnLifecycle.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustChatRunnerLifecycle!=='function'
      || ['usageRecorded','setUsageRecorded','claimUsage','beginUsage','endUsage'].some(key=>typeof a.RustChatRunnerLifecycle.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustWorkspaceState!=='function'
      || ['sessionStateCatalog','sessionStateInitial','sessionStateIsRunning','sessionStateTransition'].some(key=>typeof a[key]!=='function')
      || ['status','summary','hydrate','setStatus','setSummary','delete'].some(key=>typeof a.RustWorkspaceState.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustSessionRecords!=='function' || a.sessionRecordsProtocolVersion?.()!==1 || typeof a.sessionRecordsTaskStateDefaults!=='function'
      || ['init','configure','get','set','has','delete','clear','size','entriesSnapshot','listByDir',
        'mutate','begin','commit','rollback','bestEffort','retryTick','status','stop',
        'getTaskState','setTaskState','appendClassifyHistory','resetTaskState',
        'initDirectories','loadDirectories','directoryGet','directorySet','directoryHas',
        'directoryDelete','directoryClear','directorySize','directoryEntries','saveDirectories',
        'commitCrossFileWrite','replayJournals',
        'chatGet','chatSet','chatHas','chatDelete','chatClear','chatSize','chatEntries',
        'turnConfigure','turnClaim','turnMarkMessageDurable','turnMarkProviderRouteResolved',
        'turnProviderRouteFailed','turnAbortPreparation','turnSettle','turnStart',
        'turnBeginCleanup','turnCleanup','turnClaimProof','turnSnapshot','turnList']
      .some(key=>typeof a.RustSessionRecords.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustWorkspaceQueues!=='function'
      || ['get','has','update','project','view'].some(key=>typeof a.RustWorkspaceQueues.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustWorkspaceSockets!=='function'
      || ['attachWorkspace','attachMeta','detach','onPong','tickHeartbeat','publish','subscribe',
        'unsubscribe','recentEvents','hydrateEvents','appendEvent','hasEvents','clientCount',
        'hasClient','directoryCount','fleetLen','socketStats','flushClient',
        'backpressureResult','close'].some(key=>typeof a.RustWorkspaceSockets.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustProviderAttemptGenerations!=='function'
      || typeof a.RustProviderAttemptGenerations.prototype.next!=='function') process.exit(1);
    if(['providerAttributeProxyUsage','providerObserveProxyOutcome','providerProxyFailure',
      'apiSanitizeMessage','apiNormalizeRejection','redactionRedactText','redactionRouteCapability',
      'redactionSecretKey','redactionAnchors','redactionExactFragments',
      'RustAuthSecurity','authTimingSafeEqualText','authNormalizeRedirect','authNormalizeWsPath','authEscapeHtmlAttribute','httpAuthRoute','httpEntryGate','httpEntryAuthenticated','httpEntryCookie','httpEntryMakeRequestId','httpEntryCleanId','httpEntryRequestIds','providerScrubSemanticStructure','providerScrubSemanticJson','redactionRouteCapabilityValue'].some(key=>typeof a[key]!=='function')) process.exit(1);
    if(['createCookie','verifyCookie','verifyAccessToken','issueWsTicket','consumeWsTicket','pruneTickets','ticketCount','accessToken','setAccessToken','shuttingDown','setShuttingDown','connectGateway']
      .some(key=>typeof a.RustAuthSecurity.prototype[key]!=='function')) process.exit(1);
    const authAnchor={};
    const auth=new a.RustAuthSecurity({getSecret:()=> 'probe-auth',now:()=>1700000000000,randomBytes:n=>Buffer.alloc(n,7)},authAnchor);
    if(!auth.verifyCookie(auth.createCookie()) || !auth.verifyAccessToken('probe-auth')) process.exit(1);
    const wsTicket=auth.issueWsTicket('/probe',{});
    if(!auth.consumeWsTicket(wsTicket.ticket,'/probe') || auth.consumeWsTicket(wsTicket.ticket,'/probe')!==null || auth.ticketCount()!==0) process.exit(1);
    if(typeof a.RustExactSecretStreamRedactor!=='function'
      || ['push','setSecrets','flush','discard','pendingLength'].some(key=>typeof a.RustExactSecretStreamRedactor.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustCurrentAttempts!=='function'
      || ['get','set','beginAdmission','endAdmission'].some(key=>typeof a.RustCurrentAttempts.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustNonMainProducers!=='function'
      || ['start','end','hasActive','bindUsage'].some(key=>typeof a.RustNonMainProducers.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustMainProducers!=='function' || typeof a.RustMainProducer!=='function'
      || ['getActive','setActive','deleteActive','getEnded','setEnded','deleteEnded','hasEnded'].some(key=>typeof a.RustMainProducers.prototype[key]!=='function')
      || ['count','ambiguous','lastRequestAt','attempt','proxyRouteToken'].some(key=>typeof Object.getOwnPropertyDescriptor(a.RustMainProducer.prototype,key)?.get!=='function')
      || ['count','ambiguous','lastRequestAt'].some(key=>typeof Object.getOwnPropertyDescriptor(a.RustMainProducer.prototype,key)?.set!=='function')) process.exit(1);
    if(['snapshot','advance','reconcileHostError','budget','completed','observeFailure',
      'stallRetryExhausted','deadlineReached','retireIfStalled','status','running','succeeded',
      'setOutcome','setErrorCategory','setFinishedAt','matches'].some(key=>typeof a.RustProviderAttemptLifecycle.prototype[key]!=='function')) process.exit(1);
    if(['accepts','arm','progress','finish','isolateRetryBudget','armed','finished','progressed',
      'idleMs','connectMs','deadlineAt'].some(key=>typeof a.RustRequestWatch.prototype[key]!=='function')) process.exit(1);
    if(typeof a.RustRequestTimer.prototype.cancel!=='function'
      || ['feed','feedText'].some(key=>typeof a.RustModelStreamProgress.prototype[key]!=='function')) process.exit(1);
    if(['cliSwitchCatalog','cliSwitchRequest','prepareCliSwitchRoute','turnRequestCatalog','turnRequestRequestValue'].some(key=>typeof a[key]!=='function')) process.exit(1);
    (async()=>{ const model=new a.RustTaskReadModel();
      const run=async command=>JSON.parse((await model.run(JSON.stringify({op:'air',command}))).result);
      await run({op:'open',epoch:'preflight'});
      const published=await run({op:'publish',snapshot:{tasks:[]},dayStarts:[0]});
      if(!published.ready || !Array.isArray(published.stats)) throw Error('air_protocol_mismatch');
      const encoded=await run({op:'serialized'});
      if(typeof encoded.etag!=='string' || JSON.parse(encoded.body).tasks.length!==0) throw Error('air_protocol_mismatch');
      await model.run('{"op":"close"}');
    })().catch(()=>process.exit(1));`;
  const result = spawnSync(node, ['-e', script, path.resolve(file)], { stdio: 'ignore', timeout: 15_000 });
  return result.status === 0;
}

module.exports = { cacheRoot, sourceFingerprint, sourcePaths, probeAddon, provenancePath, writeProvenance, builtFromSource };
