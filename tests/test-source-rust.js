'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourcePaths, sourceFingerprint, probeAddon, writeProvenance, builtFromSource } = require('../scripts/rust-source-cache');
const { ensureSourceRust, ensureGatewayBinary } = require('../scripts/ensure-source-rust');
const ROOT = path.resolve(__dirname, '..');
const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR
  || path.join(ROOT, 'native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return file;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-source rust-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  for (const name of ['ensure-source-rust.js', 'rust-source-cache.js', 'build-rust-kernels.js', 'native-arch.js']) {
    write(root, `scripts/${name}`, fs.readFileSync(path.join(ROOT, 'scripts', name)));
  }
  write(root, 'native/Cargo.toml', '[workspace]\nmembers = ["core"]\n');
  write(root, 'native/Cargo.lock', 'version = 4\n');
  write(root, 'native/core/Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n');
  write(root, 'native/core/src/lib.rs', '// isolated compiler fixture\n');
  // Exercise the real build script, cache paths and addon probes. Only the
  // compiler is replaced: it copies a real addon without downloading/building.
  const cargo = write(root, 'bin/cargo', `#!/usr/bin/env node
    const fs=require('fs'),path=require('path');
    fs.appendFileSync(process.env.TEST_RUST_BUILDS,'build\\n');
    if(process.env.TEST_RUST_BUILD_FAIL==='1') process.exit(2);
    const target=process.argv[process.argv.indexOf('--target')+1];
    if(process.argv[process.argv.indexOf('-p')+1]==='multicc-gateway'){
      const bin=path.join(process.env.CARGO_TARGET_DIR,target,'release','multicc-gateway');
      fs.mkdirSync(path.dirname(bin),{recursive:true});fs.copyFileSync(process.env.TEST_RUST_GATEWAY,bin);fs.chmodSync(bin,0o755);
      process.exit(0);
    }
    const library=process.platform==='win32'?'multicc_addon.dll':process.platform==='darwin'?'libmulticc_addon.dylib':'libmulticc_addon.so';
    const dest=path.join(process.env.CARGO_TARGET_DIR,target,'release',library);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(process.env.TEST_RUST_ADDON,dest);
    if(process.env.TEST_RUST_EDIT_SOURCE==='1')fs.appendFileSync(path.join(process.cwd(),'native/core/src/lib.rs'),'// edit during build\\n');
  `);
  fs.chmodSync(cargo, 0o755);
  const env = { ...process.env, MULTICC_RUST_ADDON: '', MULTICC_RUST_PREBUILT_DIR: '',
    CARGO_TARGET_DIR: path.join(root, 'cargo-target'), MULTICC_NODE: process.execPath, PORT: '0',
    TEST_RUST_ADDON: path.resolve(addon), TEST_RUST_BUILDS: path.join(root, 'builds'),
    PATH: [path.join(root, 'bin'), path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/ensure-source-rust.js')],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
  const count = () => fs.existsSync(env.TEST_RUST_BUILDS) ? fs.readFileSync(env.TEST_RUST_BUILDS, 'utf8').trim().split('\n').length : 0;
  return { root, env, run, count };
}

test('source cache lives in the primary worktree and fingerprints source/config changes', t => {
  const { root, env } = fixture(t);
  const initial = sourcePaths(root, env);
  assert.ok(initial.prebuiltDir.startsWith(path.join(root, 'data/rust-source') + path.sep));
  write(root, 'native/target/ignored.rs', '// compiler output');
  assert.equal(sourceFingerprint(root, env), initial.fingerprint);
  assert.notEqual(sourceFingerprint(root, { ...env, RUSTFLAGS: '-C opt-level=2' }), initial.fingerprint);
  const messages = 'native/core/src/quota_bar_view/messages.json';
  write(root, messages, '{"quotaLoading":"Loading"}');
  const withMessages = sourceFingerprint(root, env);
  assert.notEqual(withMessages, initial.fingerprint, 'compiled quota messages must invalidate the addon cache');
  write(root, messages, '{"quotaLoading":"Checking"}');
  assert.notEqual(sourceFingerprint(root, env), withMessages, 'message edits must rebuild native code');
  const worktree = path.join(root, 'sibling');
  assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture']).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree]).status, 0);
  const { cacheRoot } = require('../scripts/rust-source-cache');
  assert.equal(cacheRoot(worktree), path.join(root, 'data/rust-source'));
});

const nativeTest = (name, fn) => test(name, { skip: process.platform === 'win32' && 'source manager uses a POSIX shell' }, fn);

test('addon preflight rejects an exported audit function that cannot write', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-audit-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapper = write(root, 'broken-audit.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}),
    recordSecretAudit() { throw new Error('secret_audit_unavailable'); }
  };`);
  assert.equal(probeAddon(addon), true, 'the real addon must pass the durable audit probe');
  assert.equal(probeAddon(wrapper), false, 'an exported function alone cannot pass preflight');
  const oldOrchestration = write(root, 'old-orchestration.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), orchestrationStoreProtocol: () => 1
  };`);
  assert.equal(probeAddon(oldOrchestration), false, '旧编排模块不能绕过终态正文分离');
  const stale = write(root, 'stale-switch.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), prepareCliSwitchRoute: undefined
  };`);
  assert.equal(probeAddon(stale), false, 'a stale addon cannot boot asynchronous switch preparation');
  for (const name of ['cliSwitchRuntimeRequest', 'RustCliToolsRuntime', 'cliToolsOfficialSpecs',
    'homebrewTakeoverRequest', 'cliUpstreamVersionRequest', 'RustCliUpstreamFetch', 'cliUpstreamVersionFetch',
    'quotaBarViewRequest', 'limitCacheRecorderRequestValue']) {
    const staleRuntime = write(root, `stale-${name}.js`, `module.exports = {
      ...require(${JSON.stringify(path.resolve(addon))}), ${name}: undefined
    };`);
    assert.equal(probeAddon(staleRuntime), false, `旧原生模块缺少 ${name} 时必须拒绝启动`);
  }
  const staleQuota = write(root, 'stale-quota.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustQuotaGuard: undefined
  };`);
  assert.equal(probeAddon(staleQuota), false, 'a stale addon cannot silently bypass quota protection');
  const staleRejection = write(root, 'stale-rejection.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), quotaRejectionRequestValue: undefined
  };`);
  assert.equal(probeAddon(staleRejection), false, 'a stale addon cannot bypass rejection park policy');
  const staleBudget = write(root, 'stale-model-budget.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), modelRequestPolicyValue: undefined
  };`);
  assert.equal(probeAddon(staleBudget), false, 'a stale addon cannot bypass model request budgets');
  const staleRetry = write(root, 'stale-retry.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), retryPolicyValue: undefined
  };`);
  assert.equal(probeAddon(staleRetry), false, 'a stale addon cannot bypass retry decisions');
  const staleConnect = write(root, 'stale-connect.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustRequestTimer: undefined
  };`);
  assert.equal(probeAddon(staleConnect), false, 'a stale addon cannot bypass connection deadlines');
  const staleWatch = write(root, 'stale-watch.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustRequestWatch: undefined
  };`);
  assert.equal(probeAddon(staleWatch), false, 'a stale addon cannot bypass request lifecycle state');
  const staleCprLifecycle = write(root, 'stale-cpr-lifecycle.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), cprRequestLifecycleVersion: undefined
  };`);
  assert.equal(probeAddon(staleCprLifecycle), false, 'a stale addon cannot bypass native connection deadlines');
  const staleCprStream = write(root, 'stale-cpr-stream.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), cprRequestLifecycleVersion: () => 2
  };`);
  assert.equal(probeAddon(staleCprStream), false, 'preflight must reject CPR without native stream deadlines');
  const partialCprStream = write(root, 'partial-cpr-stream.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustCprExchange: class OldExchange {}
  };`);
  assert.equal(probeAddon(partialCprStream), false, 'a CPR version alone cannot replace the stream lifecycle methods');
  const staleProgress = write(root, 'stale-model-progress.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustModelStreamProgress: undefined
  };`);
  assert.equal(probeAddon(staleProgress), false, 'a stale addon cannot bypass model stream progress');
  const staleFence = write(root, 'stale-attempt-fence.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustProviderAttemptLifecycle: undefined
  };`);
  assert.equal(probeAddon(staleFence), false, 'a stale addon cannot bypass the provider replay fence');
  for (const name of ['providerEventFence', 'providerHostTextEnvelope', 'chatOwnsCurrentRunner', 'chatAssignKillReason',
    'observeCodeFiles', 'RustWorkspaceRelease',
    'chatClearSucceededErrors', 'chatRecordResultEvent', 'chatRecordCloseResult', 'chatRecordPartialCheckpoint', 'chatHasPartialCheckpoint',
    'providerRequiredIdentity', 'providerPositiveInteger', 'providerTimeoutBudget', 'providerAttemptFields',
    'providerRevision', 'providerEncodeProxySession', 'providerDecodeProxySession', 'providerValidateAttemptTransition', 'providerBackgroundLingers', 'providerAuthorizeProxyRequest',
      'providerNonMainProducerKey', 'providerProxyActivity', 'providerBoundProxyAttempt',
      'RustAuthSecurity', 'authTimingSafeEqualText', 'authNormalizeRedirect', 'authNormalizeWsPath', 'authEscapeHtmlAttribute', 'httpAuthRoute', 'providerForceReleaseProducers', 'providerDrainStaleProducers', 'providerScrubSemanticJson', 'httpEntryGate', 'httpEntryAuthenticated', 'httpEntryCookie', 'httpEntryMakeRequestId', 'httpEntryCleanId', 'httpEntryRequestIds']) {
    const stalePolicy = write(root, `stale-${name}.js`, `module.exports = {
      ...require(${JSON.stringify(path.resolve(addon))}), ${name}: undefined
    };`);
    assert.equal(probeAddon(stalePolicy), false, `source preflight must reject missing ${name}`);
  }
  const partialAuth = write(root, 'partial-auth-security.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustAuthSecurity: class OldAuth {}
  };`);
  assert.equal(probeAddon(partialAuth), false, 'an auth constructor without the complete runtime cannot boot');
  const staleFenceMethods = write(root, 'stale-attempt-methods.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustProviderAttemptLifecycle: class OldLifecycle {}
  };`);
  assert.equal(probeAddon(staleFenceMethods), false, 'a partial lifecycle class cannot pass source preflight');
  const staleCompletion = write(root, 'stale-cli-completion.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), cliResultCompletion: undefined
  };`);
  assert.equal(probeAddon(staleCompletion), false, 'completion policies cannot silently use an older addon');
  const staleGenerations = write(root, 'stale-attempt-generations.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustProviderAttemptGenerations: undefined
  };`);
  assert.equal(probeAddon(staleGenerations), false, 'a stale addon cannot reset attempt generations');
  for (const name of ['RustCliCompletionTracker', 'RustStepCompletionTracker', 'RustKimiCompletionTracker', 'RustPiCompletionTracker', 'RustCurrentAttempts', 'RustNonMainProducers', 'RustMainProducers', 'RustChatTurnLifecycle', 'RustChatRunnerLifecycle']) {
    const staleLifecycle = write(root, `stale-${name}.js`, `module.exports = {
      ...require(${JSON.stringify(path.resolve(addon))}), ${name}: undefined
    };`);
    assert.equal(probeAddon(staleLifecycle), false, `source preflight must reject missing ${name}`);
  }
  const partialCurrentAttempts = write(root, 'partial-current-attempts.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustCurrentAttempts: class OldRegistry { get() {} }
  };`);
  assert.equal(probeAddon(partialCurrentAttempts), false, 'a registry missing replacement support must be rejected');
  const noAdmission = write(root, 'old-current-attempts.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustCurrentAttempts: class OldRegistry { get() {} set() {} }
  };`);
  assert.equal(probeAddon(noAdmission), false, 'a registry without admission ownership must be rejected');
  const partialMainProducer = write(root, 'partial-main-producer.js', `module.exports = {
    ...require(${JSON.stringify(path.resolve(addon))}), RustMainProducer: class OldProducer {}
  };`);
  assert.equal(probeAddon(partialMainProducer), false, 'a producer view without its mutable accessors must be rejected');
});

nativeTest('first source boot builds once; a new process reuses it and source changes select a new addon', t => {
  const { root, run, count } = fixture(t);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const file = first.stdout.trim(); assert.equal(probeAddon(file), true); assert.equal(count(), 1);
  assert.match(first.stderr, /自动编译/);
  const again = run(); assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), file); assert.equal(count(), 1);
  write(root, 'native/core/src/lib.rs', '// changed source\n');
  // This also covers a manager checking again after git pull with its previous
  // automatically exported addon still in the environment.
  const changed = run({ MULTICC_RUST_ADDON: file }); assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.stdout.trim(), file); assert.equal(count(), 2);
  assert.equal(probeAddon(file), true, 'old running processes retain their immutable artifact');
});

nativeTest('explicit addon/directory overrides built from this source are reused without a build', t => {
  const { root, env, run, count } = fixture(t);
  const external = path.join(root, 'external');
  const proven = write(external, `${process.platform}-${process.arch}/multicc_core.node`, fs.readFileSync(addon));
  writeProvenance(proven, sourcePaths(root, env).fingerprint);
  const directory = run({ MULTICC_RUST_PREBUILT_DIR: external });
  assert.equal(directory.status, 0, directory.stderr); assert.equal(directory.stdout.trim(), proven);
  const direct = run({ MULTICC_RUST_ADDON: proven });
  assert.equal(direct.status, 0, direct.stderr); assert.equal(direct.stdout.trim(), proven);
  assert.equal(count(), 0);
});
// A restart inherits the old server's MULTICC_RUST_ADDON, and a shared output
// directory can be rebuilt by another checkout: neither may pin older native APIs.
nativeTest('overrides not provably built from this source rebuild; invalid ones too', t => {
  const { root, env, run, count } = fixture(t);
  const unproven = run({ MULTICC_RUST_ADDON: path.resolve(addon) });
  assert.equal(unproven.status, 0, unproven.stderr); assert.match(unproven.stderr, /不是由当前源码构建/);
  const file = unproven.stdout.trim();
  assert.notEqual(file, path.resolve(addon)); assert.equal(probeAddon(file), true); assert.equal(count(), 1);
  assert.equal(builtFromSource(file, sourcePaths(root, env).fingerprint), true, 'own builds carry a provenance record');
  const external = path.join(root, 'external');
  const other = write(external, `${process.platform}-${process.arch}/multicc_core.node`, fs.readFileSync(addon));
  writeProvenance(other, 'another-source');
  const stale = run({ MULTICC_RUST_PREBUILT_DIR: external });
  assert.equal(stale.status, 0, stale.stderr); assert.equal(stale.stdout.trim(), file);
  writeProvenance(other, sourcePaths(root, env).fingerprint);
  fs.appendFileSync(other, Buffer.from([0]));
  const swapped = run({ MULTICC_RUST_ADDON: other });
  assert.equal(swapped.status, 0, swapped.stderr); assert.equal(swapped.stdout.trim(), file, 'record must describe these bytes');
  assert.equal(count(), 1);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const bad = write(root, 'bad.node', 'not a native module');
  const repaired = run({ MULTICC_RUST_ADDON: bad });
  assert.equal(repaired.status, 0, repaired.stderr); assert.equal(probeAddon(repaired.stdout.trim()), true); assert.equal(count(), 2);
});
nativeTest('a failed build falls back to a loadable unproven override but never to an invalid one', t => {
  const { root, run, count } = fixture(t);
  const fallback = run({ MULTICC_RUST_ADDON: path.resolve(addon), TEST_RUST_BUILD_FAIL: '1' });
  assert.equal(fallback.status, 0, fallback.stderr); assert.equal(fallback.stdout.trim(), path.resolve(addon));
  assert.match(fallback.stderr, /暂时沿用指定的模块/); assert.equal(count(), 1);
  const bad = write(root, 'bad.node', 'not a native module');
  const failed = run({ MULTICC_RUST_ADDON: bad, TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failed.status, 0); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /自动编译失败/);
});

nativeTest('compiler failure emits no addon path and does not publish a partial cache', t => {
  const { root, env, run, count } = fixture(t);
  const failed = run({ TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failed.status, 0); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /自动编译失败.*服务尚未启动/);
  assert.equal(count(), 1);
  assert.equal(fs.existsSync(path.join(sourcePaths(root, env).prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`)), false);
  const recovered = run(); assert.equal(recovered.status, 0, recovered.stderr); assert.equal(count(), 2);
});

nativeTest('cached invalid addon is rebuilt; a failed rebuild never replaces an existing output', t => {
  const { root, env, run, count } = fixture(t);
  const file = write(sourcePaths(root, env).prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`, 'broken');
  const repaired = run(); assert.equal(repaired.status, 0, repaired.stderr); assert.equal(count(), 1); assert.equal(probeAddon(file), true);
  const original = fs.readFileSync(file);
  const invalid = write(root, 'invalid.node', 'broken compiler output');
  const failed = spawnSync(process.execPath, [path.join(root, 'scripts/build-rust-kernels.js'),
    '--out', sourcePaths(root, env).prebuiltDir, '--target-dir', env.CARGO_TARGET_DIR], {
    cwd: root, env: { ...env, TEST_RUST_ADDON: invalid }, encoding: 'utf8',
  });
  assert.notEqual(failed.status, 0); assert.deepEqual(fs.readFileSync(file), original);
});

nativeTest('edits made during compilation discard the output instead of caching it under an old fingerprint', t => {
  const { root, env, run } = fixture(t);
  const before = sourcePaths(root, env);
  const result = run({ TEST_RUST_EDIT_SOURCE: '1' });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /源码发生变化/);
  assert.equal(fs.existsSync(path.join(before.prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`)), false);
});

nativeTest('real source manager exports the selected addon before preflight and never starts after build failure', t => {
  const { root, env, count } = fixture(t);
  write(root, 'multicc', fs.readFileSync(path.join(ROOT, 'multicc')));
  write(root, 'src/server-processes.js', '// fixture: no server is running\n');
  write(root, 'scripts/check-runtime-deps.js', `require('fs').writeFileSync('preflight-addon',process.env.MULTICC_RUST_ADDON||'');process.exit(57);`);
  const run = extra => spawnSync('/bin/bash', [path.join(root, 'multicc'), 'start'], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000,
  });
  const first = run({}); assert.notEqual(first.status, 0); assert.equal(count(), 1);
  assert.equal(probeAddon(fs.readFileSync(path.join(root, 'preflight-addon'), 'utf8')), true);
  fs.rmSync(path.join(root, 'preflight-addon'));
  const again = run({}); assert.notEqual(again.status, 0); assert.equal(count(), 1);
  fs.rmSync(path.join(root, 'preflight-addon'));
  write(root, 'native/core/src/lib.rs', '// new source\n');
  const failure = run({ TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failure.status, 0); assert.match(failure.stderr, /服务尚未启动/);
  assert.equal(fs.existsSync(path.join(root, 'preflight-addon')), false);
  assert.equal(fs.existsSync(path.join(root, '.multicc.pid')), false);
});

nativeTest('source start boots an isolated server with the built addon and a repeated start never rebuilds', async t => {
  const { root, env: fixtureEnv, count } = fixture(t);
  // ./multicc only starts through the Rust front door: this checkout declares
  // it, and the stand-in compiler hands out the real binary built next to the
  // real addon. The front door rejects PORT=0, so give it a free port.
  const gatewayBinary = path.join(path.dirname(path.resolve(addon)), 'multicc-gateway');
  assert.ok(fs.existsSync(gatewayBinary), `${gatewayBinary} is missing; run node scripts/ensure-source-rust.js first`);
  write(root, 'native/Cargo.toml', '[workspace]\nmembers = ["core", "gateway"]\n');
  const port = await new Promise(resolve => {
    const probe = require('node:net').createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const env = { ...fixtureEnv, PORT: String(port), TEST_RUST_GATEWAY: gatewayBinary };
  let pid;
  t.after(async () => {
    if (!pid) return;
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (_) { return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  });
  write(root, 'multicc', fs.readFileSync(path.join(ROOT, 'multicc')));
  write(root, 'src/server-processes.js', `if(process.argv[2]==='list'){
    try{const id=Number(require('fs').readFileSync('.multicc.pid','utf8'));process.kill(id,0);console.log(id)}catch{}}`);
  write(root, 'scripts/check-runtime-deps.js', 'process.exit(0);');
  write(root, 'server.js', `const db=new (require(process.env.MULTICC_RUST_ADDON).RustDatabase)(':memory:',false,false,5000);
    db.exec('CREATE TABLE booted(x)');db.close();require('fs').writeFileSync('booted-addon',process.env.MULTICC_RUST_ADDON);
    process.stdin.on('end',()=>process.exit(0));process.stdin.resume();
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  const run = () => spawnSync('/bin/bash', [path.join(root, 'multicc'), 'start'], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
  const first = run();
  const pidFile = path.join(root, '.multicc.pid');
  if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /started behind multicc-gateway/);
  // Two compiler runs: the addon and the front door, once each.
  assert.ok(pid > 1); assert.equal(count(), 2);
  const booted = path.join(root, 'booted-addon');
  for (let i = 0; i < 200 && !fs.existsSync(booted); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(probeAddon(fs.readFileSync(booted, 'utf8')), true);
  const repeated = run();
  assert.notEqual(repeated.status, 0); assert.match(repeated.stdout, /already running/); assert.equal(count(), 2);
});

// ---- 远控二进制：原型开发的补编路径（可选件，失败不阻断启动） ----

function remoteFixture(t, { members = ['core', 'addon', 'remote'] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-source-remote-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'native'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native/Cargo.toml'),
    `[workspace]\nmembers = [${members.map(name => `"${name}"`).join(', ')}]\n`);
  const prebuiltDir = path.join(root, 'prebuilt');
  const targetDir = path.join(root, 'cargo-target');
  const addonFile = path.join(prebuiltDir, `${process.platform}-${process.arch}`, 'multicc_core.node');
  fs.mkdirSync(path.dirname(addonFile), { recursive: true });
  fs.writeFileSync(addonFile, 'fixture addon');
  const cache = { fingerprint: 'fixture-fingerprint', prebuiltDir, targetDir };
  return { root, cache, addonFile, prebuiltDir, targetDir };
}

test('external front door must be built from the current source even when its protocol matches', t => {
  const fixture = remoteFixture(t, { members: ['core', 'gateway'] });
  const addonFile = write(fixture.root, 'external/multicc_core.node', 'addon');
  const binary = path.join(path.dirname(addonFile), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  const install = value => {
    fs.writeFileSync(binary, value);
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
  };
  install('old gateway with the same protocol');
  let builds = 0;
  const options = { repoRoot: fixture.root, addon: addonFile, env: {}, cache: fixture.cache,
    log() {}, gatewayVersion: () => ({ ok: true }), run: () => {
      builds += 1;
      install('current gateway');
      writeProvenance(binary, fixture.cache.fingerprint);
      return { status: 0 };
    } };
  assert.equal(ensureGatewayBinary(options), binary);
  assert.equal(builds, 1, 'same protocol alone does not prove the native routes exist');
  assert.equal(ensureGatewayBinary(options), binary);
  assert.equal(builds, 1, 'verified output is reused');
  install('replaced gateway');
  assert.throws(() => ensureGatewayBinary({ ...options, run: () => ({ status: 1 }) }), /Rust 前门编译失败/);
  assert.throws(() => ensureGatewayBinary({ ...options, run: () => ({ status: 0 }) }), /Rust 前门编译失败/,
    'successful compiler exit without matching provenance cannot launch stale code');
});

test('同目录缺远控二进制时只补编它，成功即可用', t => {
  const fixture = remoteFixture(t);
  const logs = [], builds = [];
  const run = (command, args) => {
    builds.push(args);
    const out = args[args.indexOf('--out') + 1];
    const file = path.join(out, process.platform === 'win32' ? 'multicc-remote.exe' : 'multicc-remote');
    fs.writeFileSync(file, 'fixture remote');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    return { status: 0 };
  };
  const file = ensureSourceRust({ repoRoot: fixture.root, env: {}, probe: () => true,
    paths: () => fixture.cache, builtFrom: () => true, run, remoteVersion: () => ({ ok: true }),
    log: message => logs.push(message) });
  assert.equal(file, fixture.addonFile);
  assert.equal(builds.length, 1);
  assert.ok(builds[0].includes('--remote-only'), '模块已可用时只编远控，不重编模块');
  const remote = path.join(path.dirname(fixture.addonFile), process.platform === 'win32' ? 'multicc-remote.exe' : 'multicc-remote');
  assert.equal(fs.existsSync(remote), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(remote).mode & 0o111, 0o111);
  assert.match(logs.join('\n'), /只编译 multicc-remote/);
});

test('远控补编失败只打一行提示，服务路径照常返回模块', t => {
  const fixture = remoteFixture(t);
  const logs = [];
  const file = ensureSourceRust({ repoRoot: fixture.root, env: {}, probe: () => true,
    paths: () => fixture.cache, builtFrom: () => true, remoteVersion: () => ({ ok: true }),
    run: () => ({ status: 1 }), log: message => logs.push(message) });
  assert.equal(file, fixture.addonFile);
  const message = logs.find(line => line.includes('远控「🖥 屏幕」不可用'));
  assert.ok(message, logs.join('\n'));
  assert.match(message, /编译失败（退出码 1）/);
  assert.match(message, /MULTICC_REMOTE_BIN/);
  assert.match(message, /服务照常启动/);
});

test('已存在的远控二进制版本不对会重编；显式 MULTICC_REMOTE_BIN 缺失只警告', t => {
  const fixture = remoteFixture(t);
  const remote = path.join(path.dirname(fixture.addonFile), process.platform === 'win32' ? 'multicc-remote.exe' : 'multicc-remote');
  fs.writeFileSync(remote, 'stale');
  if (process.platform !== 'win32') fs.chmodSync(remote, 0o755);
  let builds = 0;
  const file = ensureSourceRust({ repoRoot: fixture.root, env: {}, probe: () => true,
    paths: () => fixture.cache, builtFrom: () => true, remoteVersion: () => ({ ok: false }),
    run: () => { builds += 1; return { status: 1 }; }, log() {} });
  assert.equal(file, fixture.addonFile);
  assert.equal(builds, 1, '无法运行的旧二进制必须触发补编');

  const logs = [];
  let calls = 0;
  const explicit = ensureSourceRust({ repoRoot: fixture.root,
    env: { MULTICC_REMOTE_BIN: path.join(fixture.root, 'absent', 'multicc-remote') },
    probe: () => true, paths: () => fixture.cache, builtFrom: () => true,
    run: () => { calls += 1; return { status: 0 }; }, log: message => logs.push(message) });
  assert.equal(explicit, fixture.addonFile);
  assert.equal(calls, 0, '显式指定时不同目录里再编一份只会让人以为生效了');
  assert.match(logs.join('\n'), /MULTICC_REMOTE_BIN.*不存在/);
});
