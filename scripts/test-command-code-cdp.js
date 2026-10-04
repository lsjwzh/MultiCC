#!/usr/bin/env node
'use strict';

// 默认只测配置；--live 提交真实模型任务，并验证工具日志、取消和错误提示。
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
async function api(route, body, method) {
  const r = await fetch(base + route, { method: method || (body ? 'POST' : 'GET'), body: body ? JSON.stringify(body) : undefined, headers: { 'x-access-token': password, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000) });
  assert.ok(r.ok, `${route}: ${r.status}`);
  return r.json();
}
async function main() {
  assert.equal((await fetch(base + '/readyz')).status, 200);
  const seed = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker/command-code/compose.yaml', 'exec', '-T', 'command-code',
    'cat', '/var/lib/multicc/data/command-code-seed.json'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }));
  // 任务绑定会话不在公共会话列表中；按种子 ID 查询权威详情。
  const session = process.argv.includes('--live')
    ? await api(`/api/directories/${seed.directoryId}/sessions`, { cli: 'commandcode', kind: 'chat', model: expectedModel, label: 'Command Code CDP ' + Date.now() })
    : await api(`/api/sessions/${encodeURIComponent(seed.sessionId)}`);
  assert.equal(session.cli, 'commandcode', 'Docker 种子会话的 CLI 未被错误映射');
  const target = `${base}/chat.html?session=${encodeURIComponent(session.id)}`;
  const checks = ['健康检查', '会话 DTO 与 CLI 标识'];
  const record = name => { checks.push(name); console.log('通过：' + name); };
  if (process.argv.includes('--live')) execFileSync('docker', ['compose','-f','docker/command-code/compose.yaml','exec','-T','command-code','sh','-c','mkdir -p /var/lib/multicc/benchmark && cat > /var/lib/multicc/benchmark/hosts.fixture'], {cwd:path.resolve(__dirname,'..'),input:'127.0.0.1 localhost\n::1 localhost\n'});
  await withCdpHarness({ routes: {}, screenshotDir, locale: 'zh-CN' }, async page => {
    try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${base}/login?redirect=${encodeURIComponent('/chat.html?session=' + session.id)}`);
    assert.ok(await page.waitFor('document.querySelector("input[name=password]")'));
    await page.evaluate(`document.querySelector('input[name=password]').value = ${JSON.stringify(password)}; document.querySelector('form').requestSubmit()`);
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill") && !document.querySelector("input[name=password]")'));
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill")?.textContent.toLowerCase().includes("deepseek")', { timeoutMs: 30000 }));
    record('真实浏览器登录及会话查看');
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
    record('配置面板与 DeepSeek 模型加载');
    await page.evaluate('document.querySelector("dialog[open] button[type=submit]").click()');
    assert.ok(await page.waitFor('!document.querySelector("dialog[open]")', { timeoutMs: 15000 }));
    const saved = await api(`/api/sessions/${encodeURIComponent(session.id)}`);
    assert.equal(saved.cli, 'commandcode');
    assert.equal(saved.model, expectedModel);
    assert.ok(!saved.provider, '原生 BYOK 不绑定错误的 MultiCC Provider 池');
    record('配置保存与服务端回读');
    await page.navigate(target);
    assert.ok(await page.waitFor('document.getElementById("conversation")?.contentDocument?.getElementById("air-ai-pill")?.textContent.toLowerCase().includes("deepseek")', { timeoutMs: 30000 }));
    record('刷新后配置恢复');
    if (process.argv.includes('--live')) {
      const doc = 'document.getElementById("conversation").contentDocument';
      const results = [];
      async function idle() {
        for (let i=0;i<120;i++) { const state=await api(`/api/sessions/${session.id}/liveness`); if (!state.isStreaming && !state.busy) return; await new Promise(r=>setTimeout(r,500)); }
        throw Error('任务未及时结束');
      }
      async function submit(prompt) {
        await idle();
        // 页面发送按钮有 600ms 防抖；按真实交互节奏提交下一条。
        await new Promise(resolve => setTimeout(resolve, 650));
        assert.ok(await page.waitFor(`${doc}.getElementById('status')?.classList.contains('connected') && ${doc}.getElementById('messages').innerText.includes('Session:')`, {timeoutMs:30000}));
        await page.evaluate(`(() => {const d=${doc}; d.getElementById('input').value=${JSON.stringify(prompt)}; d.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); d.getElementById('send-btn').click();})()`);
        assert.ok(await page.waitFor(`${doc}.getElementById('input').value === ''`, {timeoutMs:15000}), '消息已提交');
      }
      for (const test of require('../tests/fixtures/command-code/history-cases.json')) {
        const before = await page.evaluate(`${doc}.querySelectorAll('.msg.assistant').length`);
        const start = Date.now();
        await submit(test.prompt.replace('当前目录 hosts.fixture', '/var/lib/multicc/benchmark/hosts.fixture'));
        const expr = `[...${doc}.querySelectorAll('.msg.assistant')].slice(${before}).map(e=>e.textContent).join(' ')`;
        assert.ok(await page.waitFor(`(${expr}).includes(${JSON.stringify(test.expected)})`, {timeoutMs:90000}), test.id);
        await idle();
        results.push({caseId:test.id,totalMs:Date.now()-start,success:true});
        record('历史任务：'+test.id);
      }
      assert.ok(await page.waitFor(`[...${doc}.querySelectorAll('.tool-card')].some(e=>e.querySelector('.tool-name')?.textContent==='read_file')`), '工具日志卡可见');
      await page.evaluate(`[...${doc}.querySelectorAll('.tool-card')].find(e=>e.querySelector('.tool-name')?.textContent==='read_file').querySelector('.tool-header').click()`);
      assert.ok(await page.waitFor(`${doc}.querySelector('.tool-card.open .tool-body')`));
      record('真实工具日志查看');
      await submit('用 bash 执行 sleep 30，然后回复 CDP_CANCEL_SHOULD_NOT_FINISH');
      assert.ok(await page.waitFor(`${doc}.getElementById('cancel-btn').classList.contains('show')`));
      await page.evaluate(`${doc}.getElementById('cancel-btn').click()`);
      await idle();
      record('中断正在执行的任务');
      await api(`/api/sessions/${session.id}`, {model:'deepseek/nonexistent-cdp-test-model'}, 'PATCH');
      await submit('只回复 ERROR_PROBE');
      assert.ok(await page.waitFor(`${doc}.getElementById('messages').innerText.includes('nonexistent-cdp-test-model')`, {timeoutMs:60000}), '错误提示可见');
      await idle();
      record('无效模型错误提示');
      await api(`/api/sessions/${session.id}`, {model:expectedModel}, 'PATCH');
      await submit('只回复 CDP_RECOVERY_OK');
      assert.ok(await page.waitFor(`[...${doc}.querySelectorAll('.msg.assistant')].some(e=>e.textContent.includes('CDP_RECOVERY_OK'))`, {timeoutMs:60000}));
      await idle();
      record('错误后恢复配置并重新提交成功');
      console.log(JSON.stringify({sessionId:session.id,results}));
    }
    const screenshot = await page.screenshot('command-code-deepseek');
    console.log(JSON.stringify({ passed: checks.length, checks, screenshot, coordinateBase: { width: 1280, height: 900 },
      modelExecution: process.argv.includes('--live') ? '真实 DeepSeek 原生 JSON 任务已通过' : '配置检查，不发送模型任务' }, null, 2));
    } catch(error) { console.log('失败截图：'+await page.screenshot('command-code-failure')); throw error; }
  });
}
main().catch(error => { console.error('CDP 集成测试失败：', error.message); process.exitCode = 1; });
