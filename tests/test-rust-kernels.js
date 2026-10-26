'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const js = require('../src/task-board/search');
const native = require('../src/native/runtime');
const { buildIndex, searchIndex, createTaskSearchBackend } = require('../src/native/task-search');
const usage = require('../src/token-global');
const { taskBoard, usageFixture } = require('./fixtures/rust-kernel-fixtures');
const available = !!native.getNative('search', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const rustTest = (name, fn) => test(name, { skip: !available && '未构建可选 Rust 模块' }, fn);
const stableUsage = ({ generatedAt, ...data }) => data;

test('Node 模式不依赖原生模块，保持同步搜索接口', () => {
  const board = taskBoard(8);
  assert.deepEqual(createTaskSearchBackend({ backend: 'node' })(board, '全文检索'), js.searchBoard(board, '全文检索'));
});
test('原生模块缺失时自动回退，强制 Rust 时明确失败', () => {
  const script = `const r=require('./src/native/runtime'); if(r.getNative('search','auto')!==null)process.exit(1);try{r.getNative('search','rust');process.exit(2)}catch(e){if(e.message!=='rust_backend_unavailable')process.exit(3)}`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MULTICC_RUST_ADDON: path.join(os.tmpdir(), 'nonexistent-multicc-rust-module.node') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
rustTest('搜索差分：中文、Unicode、空查询、过滤、排名、高亮完全一致', async () => {
  const board = taskBoard(150);
  const samples = ['😀 ＡＩＲ.js 全文检索', 'İSTANBUL ΣΟΣ Straße', 'é e\u0301 \u00a0全文检索\uFEFF',
    'ヿ 㐀䶿 한글 空格', 'a +b ..air provider-router 缓存', '全文检索 '.repeat(100)];
  for (let i = 0; i < samples.length; i += 1) board.tasks[`extra_${i}`] = {
    id: `extra_${i}`, title: samples[i], description: samples[(i + 1) % samples.length], updatedAt: 5,
    refs: [{ excerpt: '😀'.repeat(50) + samples[i] }], areas: [samples[i]], status: 'active',
  };
  board.tasks.tsk_2.mergedInto = 'tsk_1'; board.tasks.tsk_3.deleting = true; board.deletedTaskIds = ['tsk_4'];
  for (const statuses of [null, ['active'], ['archived']]) {
    const opts = { statuses };
    const index = await buildIndex(board, { ...opts, backend: 'rust' });
    assert.equal(index.backend, 'rust');
    const baseline = js.buildTaskSearchIndex(board, opts);
    for (const query of ['', 'a', '，。', '索', '全文检索', 'AIR.js', 'İSTANBUL', 'ΣΟΣ', '缓存 供应商', '😀全文检索', ...samples]) {
      for (const filters of [{}, { dirIds: ['dir_1', 'dir_2'] }, { taskIds: [] },
        { limit: 3, excludeTaskIds: ['tsk_0'], minScore: 2 }, { dirId: 'missing' }]) {
        assert.deepEqual(await searchIndex(index, query, { ...opts, ...filters }), js.searchTaskIndex(baseline, query, { ...opts, ...filters }), query);
      }
    }
  }
});
rustTest('随机搜索样本和同分排序保持一致', async () => {
  let seed = 17;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const vocabulary = ['任务', '缓存', '全文检索', 'air.js', 'provider-router', '索', 'ＡＢＣ', '😀', 'a', '한글'];
  for (let pass = 0; pass < 6; pass += 1) {
    const board = { tasks: {} };
    for (let i = 0; i < 70; i += 1) {
      const text = Array.from({ length: next() % 30 }, () => vocabulary[next() % vocabulary.length]).join(' ');
      const id = `${i % 2 ? 'a' : 'A'}-${i}`;
      board.tasks[id] = { id, title: text, description: text, updatedAt: i % 3 };
    }
    const index = await buildIndex(board, { backend: 'rust' });
    const baseline = js.buildTaskSearchIndex(board);
    for (const query of vocabulary) assert.deepEqual(await searchIndex(index, query), js.searchTaskIndex(baseline, query));
  }
});
rustTest('缓存按内容失效，同一对象和同一 revision 的修改也可见', async () => {
  const board = taskBoard(20);
  const backend = createTaskSearchBackend({ backend: 'rust' });
  assert.deepEqual(await backend(board, '全文检索'), js.searchBoard(board, '全文检索'));
  board.tasks.tsk_0.title = '改变标题后仍有全文检索';
  board.tasks.tsk_0.updatedAt += 1;
  board.deletedTaskIds = ['tsk_6'];
  assert.deepEqual(await backend(board, '全文检索'), js.searchBoard(board, '全文检索'));
  assert.deepEqual(await backend(board, '全文检索', { statuses: ['archived'] }), js.searchBoard(board, '全文检索', { statuses: ['archived'] }));
});
rustTest('HTTP 搜索等待原生结果，并将异步失败转换为 503', async () => {
  const { createTaskSearchRoutes } = require('../src/routes/task-search');
  const board = taskBoard(10);
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } });
  const res = response();
  await createTaskSearchRoutes({ getBoard: () => board, searchTasks: createTaskSearchBackend({ backend: 'rust' }) }).handleSearch({ query: { q: '全文检索' } }, res);
  assert.deepEqual(res.body.results, js.searchBoard(board, '全文检索', { limit: 20 }));
  const failed = response();
  await createTaskSearchRoutes({ getBoard: () => board, searchTasks: () => Promise.reject(new Error('failure')) }).handleSearch({ query: { q: '全文检索' } }, failed);
  assert.equal(failed.statusCode, 503);
});
rustTest('Token 文件扫描差分：重复、损坏尾行、无关正文与窗口一致', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-test-'));
  try {
    const fixture = usageFixture(root, { rows: 120 });
    const before = native.status().usage;
    assert.deepEqual(stableUsage(await usage._compute({ ...fixture, backend: 'rust' })), stableUsage(await usage._computeJs(fixture)));
    assert.equal(native.status().usage, before + 1, '必须确实经过 Rust，不能静默回退');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
rustTest('原生工作不阻塞 Node 定时器', async () => {
  const board = taskBoard(3000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { await buildIndex(board, { backend: 'rust' }); } finally { clearInterval(timer); }
  assert.ok(ticks > 0);
});

rustTest('不完整 Unicode 安全回退到 Node，保持历史字符串行为', async () => {
  const board = taskBoard(2);
  board.tasks.tsk_0.title = '\ud800全文检索\udfff';
  const before = native.status().fallbacks;
  assert.deepEqual(await createTaskSearchBackend({ backend: 'auto' })(board, '全文检索'), js.searchBoard(board, '全文检索'));
  assert.equal(native.status().fallbacks, before + 1);
});

rustTest('Token 不完整 Unicode 与非 ISO 时间回退，不能静默漏算', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-edge-'));
  try {
    const fixture = usageFixture(root, { files: 1, rows: 2 });
    for (const overrides of [{ requestId: '\ud800' }, { timestamp: 'July 19, 2026 12:00:00' },
      { timestamp: '2016-12-31T23:59:60Z' }, { timestamp: '0026-01-01T00:00:00Z' }]) {
      const row = { timestamp: '2026-07-19T01:00:00Z', requestId: 'extra',
        message: { id: 'extra', model: 'edge', usage: { input_tokens: 9 } }, ...overrides };
      fs.writeFileSync(path.join(fixture.projectsDir, 'edge.jsonl'), JSON.stringify(row) + '\n');
      const before = native.status().fallbacks;
      assert.deepEqual(stableUsage(await usage._compute({ ...fixture, backend: 'auto' })), stableUsage(await usage._computeJs(fixture)));
      assert.equal(native.status().fallbacks, before + 1);
      await assert.rejects(usage._compute({ ...fixture, backend: 'rust' }));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

rustTest('Token 日期窗口在 UTC、上海和纽约时区与 Node 一致', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-tz-'));
  try {
    const timestamps = ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
      '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2026-11-01',
      '2026-11-01T01:30:00', '2026-10-31T23:59:59.999-04:00', 1793520000000];
    fs.writeFileSync(path.join(root, 'tz.jsonl'), timestamps.map((timestamp, i) => JSON.stringify({
      timestamp, requestId: String(i), message: { id: String(i), model: 'tz', usage: { input_tokens: i + 1 } },
    })).join('\n'));
    const script = `const u=require('./src/token-global'),a=require('node:assert/strict');
      const clean=({generatedAt,...v})=>v;(async()=>{const o={projectsDir:process.argv[1],codexDir:process.argv[1]+'/absent',now:new Date('2026-11-01T17:00:00Z')};
      a.deepEqual(clean(await u._compute({...o,backend:'rust'})),clean(await u._computeJs(o)));})().catch(e=>{console.error(e);process.exitCode=1})`;
    for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      const result = spawnSync(process.execPath, ['-e', script, root], { cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8', env: { ...process.env, TZ } });
      assert.equal(result.status, 0, `${TZ}: ${result.stderr}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('打包明确要求 Rust 时缺产物必须失败；架构映射拒绝未知目标', () => {
  const { targetFor } = require('../scripts/build-rust-kernels');
  assert.equal(targetFor('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.throws(() => targetFor('unknown', 'arm64'));
  const script = `require('./scripts/stage-rust-kernels').stageRustKernels({repoRoot:'.',out:process.argv[1]})`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-package-'));
  try {
    const result = spawnSync(process.execPath, ['-e', script, root], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, MULTICC_REQUIRE_RUST_BUNDLE: '1', MULTICC_RUST_PREBUILT_DIR: path.join(root, 'absent') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /打包缺少 Rust 模块/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

rustTest('打包后的 Rust 模块可加载，错误架构不能进入安装包', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-package-'));
  const beforeDir = process.env.MULTICC_RUST_PREBUILT_DIR;
  const { stageRustKernels } = require('../scripts/stage-rust-kernels');
  try {
    process.env.MULTICC_RUST_PREBUILT_DIR = path.join(root, 'prebuilt');
    const source = process.env.MULTICC_RUST_ADDON || path.join(beforeDir || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}/multicc_core.node`);
    for (const arch of [process.arch, 'ia32']) {
      const dir = path.join(process.env.MULTICC_RUST_PREBUILT_DIR, `${process.platform}-${arch}`);
      fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(source, path.join(dir, 'multicc_core.node'));
      fs.writeFileSync(path.join(dir, remoteName()), binaryHeader(process.platform, arch));
    }
    const options = { repoRoot: '.', out: path.join(root, 'app-server'), logger: { log() {} } };
    const staged = stageRustKernels(options);
    // Windows keeps loaded DLLs locked until process exit. Probe in a child so
    // cleanup tests the package, without trying to unlink our own loaded module.
    const probe = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const addon = require(process.argv[1]);
      assert.equal(addon.protocolVersion(), 1);
      (async () => {
        const index = await addon.buildSearchIndex('[]');
        assert.deepEqual(JSON.parse((await index.search('{"terms":[],"strong":[],"phrase":""}')).result), []);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, staged], { encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr);
    if (hasRemoteCrate('.')) {
      const stagedRemote = path.join(path.dirname(staged), remoteName());
      assert.equal(fs.existsSync(stagedRemote), true, '远控二进制必须和模块同目录打包');
      if (process.platform !== 'win32') assert.equal(fs.statSync(stagedRemote).mode & 0o111, 0o111);
    }
    assert.throws(() => stageRustKernels({ ...options, npmEnv: { npm_config_arch: 'ia32' } }), /架构不匹配/);
  } finally {
    if (beforeDir === undefined) delete process.env.MULTICC_RUST_PREBUILT_DIR; else process.env.MULTICC_RUST_PREBUILT_DIR = beforeDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- multicc-remote：分步编译、缺件策略、可执行位、--version ----

const { build, hasRemoteCrate, remoteBinaryName, remoteBinaryPath } = require('../scripts/build-rust-kernels');
const { builtFromSource: fromSource, sourceFingerprint: fingerprintOf } = require('../scripts/rust-source-cache');
const { stageRustKernels: stageKernels } = require('../scripts/stage-rust-kernels');

function remoteName(platform = process.platform) {
  return remoteBinaryName(platform);
}

// 只给 verify() 读魔数的平台/架构头；远控二进制的执行结果由注入的 run 模拟。
function binaryHeader(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    return buffer;
  }
  if (platform === 'linux') {
    const buffer = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]).copy(buffer, 0);
    buffer.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18);
    return buffer;
  }
  const buffer = Buffer.alloc(0x48);
  buffer.write('MZ', 0);
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x40);
  buffer.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x44);
  return buffer;
}

// 一个只读写文件、不真跑编译器的 cargo：按 -p 写出对应产物，记录调用顺序。
function fakeCargo({ failRemote = false, omitRemote = false, version = 'multicc-remote 1 0.1.0\n' } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    if (command !== 'cargo') return { status: 0, stdout: version, stderr: '' };
    calls.push(args.join(' '));
    const crate = args[args.indexOf('-p') + 1];
    if (crate === 'multicc-remote' && failRemote) return { status: 2, stdout: '', stderr: 'compile error' };
    const target = args[args.indexOf('--target') + 1];
    const release = path.join(options.env.CARGO_TARGET_DIR, target, 'release');
    fs.mkdirSync(release, { recursive: true });
    if (crate === 'multicc-addon') {
      const library = process.platform === 'win32' ? 'multicc_addon.dll'
        : process.platform === 'darwin' ? 'libmulticc_addon.dylib' : 'libmulticc_addon.so';
      fs.writeFileSync(path.join(release, library), Buffer.concat([binaryHeader(), Buffer.alloc(300)]));
    } else if (!omitRemote) {
      fs.writeFileSync(path.join(release, remoteName()), Buffer.concat([binaryHeader(), Buffer.alloc(300)]));
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function rustBuildFixture(t, { members = ['core', 'addon', 'remote'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const name of ['build-rust-kernels.js', 'rust-source-cache.js']) {
    fs.writeFileSync(path.join(root, 'scripts', name), fs.readFileSync(path.join(__dirname, '..', 'scripts', name)));
  }
  fs.mkdirSync(path.join(root, 'native'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native/Cargo.toml'),
    `[workspace]\nmembers = [${members.map(name => `"${name}"`).join(', ')}]\n`);
  fs.writeFileSync(path.join(root, 'native/Cargo.lock'), 'version = 4\n');
  return { root, out: path.join(root, 'prebuilt'), targetDir: path.join(root, 'cargo-target') };
}

// 打包只认 MULTICC_RUST_PREBUILT_DIR（CI 会设），测试自己的 fixture 必须独占它。
function ownPrebuiltRoot(t) {
  const before = process.env.MULTICC_RUST_PREBUILT_DIR;
  delete process.env.MULTICC_RUST_PREBUILT_DIR;
  t.after(() => { if (before !== undefined) process.env.MULTICC_RUST_PREBUILT_DIR = before; });
}

const quiet = { log() {}, error() {} };

test('远控二进制分步编译：先模块后进程，可执行位保留并过 --version 校验', t => {
  const fixture = rustBuildFixture(t);
  const { calls, run } = fakeCargo();
  const result = build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: false, run, logger: quiet });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /-p multicc-addon$/);
  assert.match(calls[1], /-p multicc-remote$/);
  assert.equal(result.addon, path.join(fixture.out, `${process.platform}-${process.arch}`, 'multicc_core.node'));
  assert.equal(result.remote, remoteBinaryPath(result.addon));
  assert.equal(fs.existsSync(result.remote), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.remote).mode & 0o111, 0o111);
  // 两个产物都要能证明是当前源码编的（指纹目录之外还给 /tmp 输出用）。
  assert.equal(fromSource(result.remote, fingerprintOf(fixture.root, process.env)), true);
  assert.equal(fromSource(result.addon, fingerprintOf(fixture.root, process.env)), true);
});

test('远控编不出来：源码路径只警告并保留模块，发布路径必须报错', t => {
  const fixture = rustBuildFixture(t);
  const warnings = [];
  const logger = { log() {}, error(message) { warnings.push(message); } };
  const source = fakeCargo({ failRemote: true });
  const result = build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: false, run: source.run, logger });
  assert.equal(result.remote, null);
  assert.equal(fs.existsSync(result.addon), true, '模块仍然可用，服务照常启动');
  assert.match(warnings.join('\n'), /「🖥 屏幕」本次不可用/);
  assert.match(warnings.join('\n'), /MULTICC_REMOTE_BIN/);

  const release = fakeCargo({ failRemote: true });
  assert.throws(() => build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: true, run: release.run, logger: quiet }), /远控二进制构建失败/);
  assert.equal(fs.existsSync(remoteBinaryPath(path.join(fixture.out, `${process.platform}-${process.arch}`,
    'multicc_core.node'))), false, '失败不能留下半成品');
});

test('发布路径要求二进制真的存在：编译器成功但没产物也要失败', t => {
  const fixture = rustBuildFixture(t);
  const { run } = fakeCargo({ omitRemote: true });
  assert.throws(() => build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: true, run, logger: quiet }), /远控二进制构建失败/);
});

test('--version 不是 multicc-remote 1 时拒绝发布，源码路径只警告', t => {
  const fixture = rustBuildFixture(t);
  const wrong = fakeCargo({ version: 'multicc-remote 2 0.1.0\n' });
  assert.throws(() => build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: true, run: wrong.run, logger: quiet }), /--version 校验失败/);
  const warnings = [];
  const source = fakeCargo({ version: 'multicc-remote 2 0.1.0\n' });
  const result = build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: false, run: source.run, logger: { log() {}, error(message) { warnings.push(message); } } });
  assert.equal(result.remote, null);
  assert.match(warnings.join('\n'), /--version 校验失败/);
});

test('native/remote 不在 workspace 时跳过远控，两个产物规则都不报错', t => {
  ownPrebuiltRoot(t);
  const fixture = rustBuildFixture(t, { members: ['core', 'addon'] });
  const { calls, run } = fakeCargo();
  const result = build({ repoRoot: fixture.root, out: fixture.out, targetDir: fixture.targetDir, probe: () => true,
    requireRemote: true, run, logger: quiet });
  assert.deepEqual(calls.map(call => call.split(' ').pop()), ['multicc-addon']);
  assert.equal(result.remote, null);
  assert.equal(fs.existsSync(remoteBinaryPath(result.addon)), false);
  const prebuilt = path.join(fixture.root, 'native/prebuilt', `${process.platform}-${process.arch}`);
  fs.mkdirSync(prebuilt, { recursive: true });
  fs.writeFileSync(path.join(prebuilt, 'multicc_core.node'), fs.readFileSync(result.addon));
  const staged = stageKernels({ repoRoot: fixture.root, out: path.join(fixture.root, 'stage'), logger: quiet });
  assert.equal(path.basename(staged), 'multicc_core.node');
  assert.equal(fs.existsSync(remoteBinaryPath(staged)), false);
});

test('打包：远控二进制同目录复制且保留可执行位，workspace 声明了却缺件必须报错', t => {
  ownPrebuiltRoot(t);
  const fixture = rustBuildFixture(t);
  const prebuilt = path.join(fixture.root, 'native/prebuilt', `${process.platform}-${process.arch}`);
  fs.mkdirSync(prebuilt, { recursive: true });
  fs.writeFileSync(path.join(prebuilt, 'multicc_core.node'), Buffer.concat([binaryHeader(), Buffer.alloc(300)]));
  const missing = path.join(fixture.root, 'stage-missing');
  assert.throws(() => stageKernels({ repoRoot: fixture.root, out: missing, logger: quiet }), /打包缺少远控二进制/);
  fs.writeFileSync(path.join(prebuilt, remoteName()), binaryHeader(process.platform));
  const out = path.join(fixture.root, 'stage');
  const staged = stageKernels({ repoRoot: fixture.root, out, logger: quiet });
  const remote = path.join(path.dirname(staged), remoteName());
  assert.equal(fs.existsSync(remote), true);
  assert.deepEqual(fs.readFileSync(remote), binaryHeader(process.platform));
  if (process.platform !== 'win32') assert.equal(fs.statSync(remote).mode & 0o111, 0o111);
  // 平台/架构不符的远控二进制不能混进安装包。
  const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  fs.writeFileSync(path.join(prebuilt, remoteName()), binaryHeader(process.platform, wrongArch));
  assert.throws(() => stageKernels({ repoRoot: fixture.root, out: path.join(fixture.root, 'stage-bad'), logger: quiet }),
    /平台或架构不匹配|架构/);
});

