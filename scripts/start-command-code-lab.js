#!/usr/bin/env node
'use strict';

// 可选地复用用户明确指定的 MultiCC DeepSeek Flash Provider；凭据仅进入子进程环境。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--provider-file')) throw new Error('用法：node scripts/start-command-code-lab.js [--provider-file /绝对路径/providers.json]');
  const env = { ...process.env };
  if (args.length && !env.DEEPSEEK_API_KEY) {
    const rows = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const provider = rows.find(p => p.name === 'DeepSeek Flash');
    const config = provider?.settingsConfig?.env;
    if (!config?.ANTHROPIC_AUTH_TOKEN) throw new Error('指定文件中没有可复用的 DeepSeek Flash 配置');
    if (new URL(config.ANTHROPIC_BASE_URL).hostname !== 'api.deepseek.com') throw new Error('现有 Provider 不是 DeepSeek 官方端点，请显式提供 DEEPSEEK_* 环境变量');
    env.DEEPSEEK_API_KEY = config.ANTHROPIC_AUTH_TOKEN;
    env.DEEPSEEK_BASE_URL ||= 'https://api.deepseek.com/v1';
    env.DEEPSEEK_FLASH_MODEL ||= 'deepseek-flash';
  }
  const root = path.resolve(__dirname, '..');
  const child = spawn('docker', ['compose', '-f', 'docker/command-code/compose.yaml', 'up', '-d', '--wait', '--wait-timeout', '120'], { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('Docker 实例未通过启动检查');
  const port = Number(env.COMMAND_CODE_PORT || 8080);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Command Code 实例：${url}（仅本机监听）`);
  if (env.MULTICC_BASE_URL) {
    // 启动命令里只保存 Provider 文件路径，不保存凭据。
    const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
    const startCmd = `COMMAND_CODE_PORT=${port} node scripts/start-command-code-lab.js`
      + (args.length ? ` --provider-file ${quote(path.resolve(args[1]))}` : '');
    const response = await fetch(env.MULTICC_BASE_URL + '/api/docs-registry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'service', title: 'Command Code · DeepSeek Docker 集成', url, port, startCmd, cwd: root, sessionId: env.MULTICC_SESSION_ID }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`服务已启动，但登记失败：HTTP ${response.status}`);
    console.log('服务登记请求已成功，需查询登记表确认探活状态');
  }
}
main().catch(error => { console.error('启动失败：', error instanceof SyntaxError ? '配置格式错误' : error.message); process.exitCode = 1; });
