#!/usr/bin/env node
'use strict';

// CI-only runtime gate. No disassembly blacklist: correctly dispatched SIMD
// is allowed. Test both feature reporting and actual instruction enforcement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--expect-sigill') result.expectSigill = true;
    else if (['--node', '--addon', '--companions', '--report', '--qemu'].includes(key) && argv[i + 1]) {
      result[key.slice(2)] = path.resolve(argv[++i]);
    } else throw new Error(`未知参数或缺少参数值：${key}`);
  }
  for (const key of ['node', 'addon', 'report', 'qemu']) assert.ok(result[key], `缺少 --${key}`);
  return result;
}

function sigill(result) {
  return !result.error && (result.signal === 'SIGILL' || result.status === 132);
}

function main(argv) {
  const opts = options(argv);
  assert.equal(process.platform, 'linux', 'CPU 门禁只能在 Linux x64 CI 上执行');
  assert.equal(process.arch, 'x64', 'CPU 门禁只能在 Linux x64 CI 上执行');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cpu-probe-'));
  const report = { completed: false, expectedLegacyFailure: !!opts.expectSigill, cases: [] };
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    return { status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '',
      ...(result.error ? { error: result.error.message } : {}) };
  };
  const passed = (result, label) => assert.ok(!result.error && result.status === 0,
    `${label} 失败：${JSON.stringify(result)}`);
  try {
    report.environment = {
      osRelease: fs.readFileSync('/etc/os-release', 'utf8'),
      libc: run('getconf', ['GNU_LIBC_VERSION']),
      emulator: run(opts.qemu, ['--version']),
      emulatorSha256: createHash('sha256').update(fs.readFileSync(opts.qemu)).digest('hex'),
      emulatorSource: fs.existsSync(`${opts.qemu}.source.json`)
        ? JSON.parse(fs.readFileSync(`${opts.qemu}.source.json`, 'utf8')) : null,
    };
    report.nodeSha256 = createHash('sha256').update(fs.readFileSync(opts.node)).digest('hex');
    report.addonSha256 = createHash('sha256').update(fs.readFileSync(opts.addon)).digest('hex');
    const probe = path.join(temp, 'cpu-probe');
    passed(run('rustc', [path.join(__dirname, 'fixtures/linux-cpu-probe.rs'), '--edition=2021',
      '-C', 'target-cpu=x86-64', '-D', 'warnings', '-o', probe]), '编译 CPU 探针');
    report.probeSha256 = createHash('sha256').update(fs.readFileSync(probe)).digest('hex');
    for (const [cpu, avx] of [['Nehalem', false], ['IvyBridge', true]]) {
      const row = { cpu };
      report.cases.push(row);
      const emulate = (file, args = []) => run(opts.qemu, ['-cpu', cpu, file, ...args]);
      const features = emulate(probe);
      row.probe = features;
      if (features.error || features.status !== 0) {
        // Preserve enough evidence to distinguish the probe from its dynamic
        // loader/libc. A startup SIGILL is not an AVX2 negative-control pass.
        const trace = path.join(temp, `${cpu}-probe.trace`);
        row.probeTraceResult = run(opts.qemu, ['-cpu', cpu, '-d', 'in_asm', '-D', trace, probe]);
        if (fs.existsSync(trace)) {
          const size = fs.statSync(trace).size;
          const tail = Buffer.alloc(Math.min(size, 16000));
          const fd = fs.openSync(trace, 'r');
          try { fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
          finally { fs.closeSync(fd); }
          row.probeTraceTail = tail.toString('utf8');
        }
        row.probeLibraries = run('ldd', [probe]);
      }
      passed(features, `${cpu} CPU 探针`);
      row.features = JSON.parse(features.stdout);
      assert.equal(row.features.avx2, false, `${cpu} 不能暴露 AVX2`);
      assert.equal(row.features.avx, avx, `${cpu} AVX 特征不符合测试场景`);
      if (cpu === 'IvyBridge') assert.equal(row.features.f16c, true);
      row.negativeControl = emulate(probe, ['--avx2-negative-control']);
      assert.ok(sigill(row.negativeControl), `${cpu} 未拒绝 AVX2 指令，模拟器不足以验证兼容性`);
      row.node = emulate(opts.node, ['-e', 'console.log(process.version)']);
      passed(row.node, `${cpu} Node 启动`);
      row.addon = emulate(opts.node, [path.join(__dirname, 'fixtures/linux-cpu-addon-smoke.js'), opts.addon]);
      if (opts.expectSigill) assert.ok(sigill(row.addon), `${cpu} 旧版未复现 SIGILL：${JSON.stringify(row.addon)}`);
      else passed(row.addon, `${cpu} 原生模块与 SQLite`);
      if (opts.companions && !opts.expectSigill) {
        row.companions = {};
        for (const name of ['multicc-remote', 'multicc-cdpd', 'multicc-gateway']) {
          const result = emulate(path.join(opts.companions, name), ['--version']);
          row.companions[name] = result;
          passed(result, `${cpu} ${name}`);
          assert.ok(result.stdout.startsWith(`${name} `), `${name} 版本协议不正确`);
        }
      }
      console.log(`${cpu}：${opts.expectSigill ? '已复现旧版 SIGILL' : '无 AVX2 运行验证通过'}`);
    }
    report.completed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(opts.report), { recursive: true });
    fs.writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { options, sigill };
