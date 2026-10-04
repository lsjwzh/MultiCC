#!/usr/bin/env node
'use strict';
// 同任务、同 Provider 的真实 CLI 对照；不导出凭据或原始事件。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const cases = require('../tests/fixtures/command-code/history-cases.json');
const root = path.resolve(__dirname, '..');
const fixture = '127.0.0.1 localhost\n::1 localhost\n';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'command-code-benchmark-'));
fs.writeFileSync(path.join(work, 'hosts.fixture'), fixture);
const env = { ...process.env };
const idx = process.argv.indexOf('--provider-file');
if (!env.DEEPSEEK_API_KEY && idx >= 0) {
  const p = JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8')).find(p => p.name === 'DeepSeek Flash');
  if (new URL(p.settingsConfig.env.ANTHROPIC_BASE_URL).hostname !== 'api.deepseek.com') throw Error('需要官方 DeepSeek 配置');
  env.DEEPSEEK_API_KEY = p.settingsConfig.env.ANTHROPIC_AUTH_TOKEN;
}
if (!env.DEEPSEEK_API_KEY) throw Error('请通过环境变量提供 DEEPSEEK_API_KEY');
const byok = require('./configure-command-code').deepseekConfig(env);
const model = Object.keys(byok.models)[0];
const baseURL = byok.baseURL;
env.XDG_CONFIG_HOME = path.join(work, 'config');
env.XDG_DATA_HOME = path.join(work, 'data');
env.XDG_STATE_HOME = path.join(work, 'state');
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { deepseek: { npm: '@ai-sdk/openai-compatible', name: 'DeepSeek', options: { baseURL, apiKey: '{env:DEEPSEEK_API_KEY}' }, models: { [model]: { name: model, limit: { context: 1000000, output: 8192 } } } } }, permission: 'allow' });
const compose = ['compose', '-f', path.join(root, 'docker/command-code/compose.yaml'), 'exec', '-T'];
execFileSync('docker', [...compose, 'command-code', 'mkdir', '-p', '/var/lib/multicc/benchmark']);
execFileSync('docker', [...compose, 'command-code', 'sh', '-c', 'cat > /var/lib/multicc/benchmark/hosts.fixture'], { input: fixture });
function run(cli, test) {
  return new Promise(resolve => {
    const start = performance.now(); let first = null, answer = '', buf = '', errors = 0, toolCalls = 0, timedOut = false;
    const args = cli === 'commandcode' ? [...compose, '-w', '/var/lib/multicc/benchmark', 'command-code', 'sh', '-c', 'exec "$COMMAND_CODE_CMD" "$@"', 'commandcode', '-p', test.prompt, '--model', `deepseek/${model}`, '--output-format', 'json', '--max-turns', '6', '--skip-onboarding', '--no-auto-update', '--yolo'] : ['run', '--dir', work, '--pure', '--format', 'json', '--auto', '--model', `deepseek/${model}`, test.prompt];
    const child = spawn(cli === 'commandcode' ? 'docker' : (env.OPENCODE_CMD || 'opencode'), args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
    child.stderr.on('data', () => {});
    function line(s) {
      let j; try { j = JSON.parse(s); } catch { return; }
      const e = j.event || j;
      if (e.type === 'error' || j.type === 'error') errors++;
      if (e.type === 'tool_queued' || e.type === 'tool_use') toolCalls++;
      const text = cli === 'opencode' ? (j.type === 'text' ? j.part?.text : '') : (e.type === 'text_delta' ? e.delta || e.text : e.type === 'message_end' ? e.content?.filter(x => x.type === 'text').map(x => x.text).join('') : '');
      if (text) { first ??= performance.now() - start; answer += text; }
      if (j.type === 'result') answer = j.text || j.result || answer;
      if (e.type === 'run_end' && e.result?.finalText) answer = e.result.finalText;
    }
    child.stdout.on('data', chunk => { buf += chunk; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(line); });
    child.on('error', () => { errors++; });
    child.on('close', code => { clearTimeout(timer); if (buf) line(buf); answer = typeof answer === 'string' ? answer : ''; const success = code === 0 && !timedOut && errors === 0 && answer.includes(test.expected) && (test.id !== 'read-file' || (answer.includes('::1 localhost') && toolCalls > 0)) && (test.id !== 'long-command' || (toolCalls > 0 && performance.now() - start >= 30000)); resolve({ cli, caseId: test.id, success, exitCode: code, timedOut, firstTextMs: first && Math.round(first), totalMs: Math.round(performance.now() - start), interactionSteps: 1, errors, toolCalls, answer: answer.slice(0,1000) }); });
  });
}
(async () => {
  const results = [];
  for (const test of cases) for (const cli of ['opencode', 'commandcode']) { console.log(`运行 ${cli} / ${test.id}`); const r = await run(cli, test); results.push(r); console.log(JSON.stringify(r)); }
  const versions = { opencode: execFileSync(env.OPENCODE_CMD || 'opencode', ['--version'], {env, encoding:'utf8'}).trim(), commandcode: execFileSync('docker', [...compose, 'command-code', 'sh', '-c', '"$COMMAND_CODE_CMD" --version'], {encoding:'utf8'}).trim() };
  const report = { versions, generatedAt: new Date().toISOString(), model, baseURL, method: '顺序执行；每项每引擎一次；首响应为首个可见文本事件（非网络首 token）；交互数为 CLI 单次提交，不代表 GUI；OpenCode 宿主与 Command Code Docker 存在环境差异', results };
  const output = path.resolve(process.env.COMMAND_CODE_BENCHMARK_REPORT || path.join(work, 'comparison.json'));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log('报告：' + output);
  process.exitCode = results.every(x => x.success) ? 0 : 1;
})().catch(() => { console.error('对比执行失败（未输出可能包含凭据的原始异常）'); process.exitCode = 1; });
