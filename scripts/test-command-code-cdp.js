#!/usr/bin/env node
'use strict';

// 使用真实 Docker 实例与专用无头 Chrome；此测试不发送模型请求。
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withCdpHarness } = require('../tests/helpers/cdp-harness');

const base = process.env.COMMAND_CODE_LAB_URL || 'http://127.0.0.1:8080';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('只允许测试本机隔离实例');
const password = process.env.COMMAND_CODE_LAB_PASSWORD || 'command-code-lab';
const expectedModel = `deepseek/${process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-flash'}`;
const screenshotDir = path.join(os.homedir(), '.multicc/assist', process.env.MULTICC_SESSION_ID || 'command-code-cdp');
async function api(route) {
  const r = await fetch(base + route, { headers: { 'x-access-token': password }, signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200, route);
  return r.json();
}
async function main() {
  assert.equal((await fetch(base + '/readyz')).status, 200);
  const seed = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker/command-code/compose.yaml', 'exec', '-T', 'command-code',
    'cat', '/var/lib/multicc/data/command-code-seed.json'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }));
  // 任务绑定会话不在公共会话列表中；按种子 ID 查询权威详情。
  const session = await api(`/api/sessions/${encodeURIComponent(seed.sessionId)}`);
  assert.equal(session.cli, 'commandcode', 'Docker 种子会话的 CLI 未被错误映射');
  const target = `${base}/chat.html?session=${encodeURIComponent(session.id)}`;
  const checks = ['健康检查', '会话 DTO 与 CLI 标识'];
  await withCdpHarness({ routes: {}, screenshotDir, locale: 'zh-CN' }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${base}/login?redirect=${encodeURIComponent('/chat.html?session=' + session.id)}`);
    assert.ok(await page.waitFor('document.querySelector("input[name=password]")'));
    await page.evaluate(`document.querySelector('input[name=password]').value = ${JSON.stringify(password)}; document.querySelector('form').requestSubmit()`);
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill") && !document.querySelector("input[name=password]")'));
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill")?.textContent.toLowerCase().includes("deepseek")', { timeoutMs: 30000 }));
    checks.push('真实浏览器登录及会话查看');
    await page.evaluate('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill").click()');
    assert.ok(await page.waitFor('document.querySelector("dialog[open] .rc-model")?.options.length > 0', { timeoutMs: 30000 }));
    const config = await page.evaluate(`(() => {
      const d = document.querySelector('dialog[open]');
      return { model: d.querySelector('.rc-model').value, text: d.innerText,
        options: [...d.querySelector('.rc-model').options].map(o => o.value) };
    })()`);
    assert.ok(config.text.includes('Command Code'));
    assert.ok(config.options.includes(expectedModel), 'DeepSeek 模型出现在真实配置面板');
    assert.equal(config.model, expectedModel);
    checks.push('配置面板与 DeepSeek 模型加载');
    await page.evaluate('document.querySelector("dialog[open] button[type=submit]").click()');
    assert.ok(await page.waitFor('!document.querySelector("dialog[open]")', { timeoutMs: 15000 }));
    const saved = await api(`/api/sessions/${encodeURIComponent(session.id)}`);
    assert.equal(saved.cli, 'commandcode');
    assert.equal(saved.model, expectedModel);
    assert.ok(!saved.provider, '原生 BYOK 不绑定错误的 MultiCC Provider 池');
    checks.push('配置保存与服务端回读');
    await page.navigate(target);
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill")?.textContent.toLowerCase().includes("deepseek")', { timeoutMs: 30000 }));
    checks.push('刷新后配置恢复');
    const screenshot = await page.screenshot('command-code-deepseek');
    console.log(JSON.stringify({ passed: checks.length, checks, screenshot, coordinateBase: { width: 1280, height: 900 },
      modelExecution: '按当前范围未测试：本脚本不发送任务、不验证上游账户' }, null, 2));
  });
}
main().catch(error => { console.error('CDP 集成测试失败：', error.message); process.exitCode = 1; });
