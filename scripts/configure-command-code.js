#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function deepseekConfig(env = process.env) {
  const baseURL = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('DEEPSEEK_BASE_URL 必须是不含凭据、查询参数的 HTTP(S) API 根地址');
  }
  const model = env.DEEPSEEK_FLASH_MODEL || 'deepseek-flash';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model)) throw new Error('DEEPSEEK_FLASH_MODEL 格式无效');
  return { name: 'DeepSeek Flash', api: 'openai-completions', baseURL: baseURL.replace(/\/+$/, ''),
    apiKey: '$DEEPSEEK_API_KEY', models: { [model]: { contextWindow: 1000000, maxOutput: 8192 } } };
}

function configure({ home = os.homedir(), env = process.env } = {}) {
  const provider = deepseekConfig(env);
  const dir = path.join(home, '.commandcode');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'providers.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || (current.provider != null && (typeof current.provider !== 'object' || Array.isArray(current.provider)))) {
    throw new Error('现有 providers.json 格式无效，已保留原文件');
  }
  current.provider = { ...current.provider, deepseek: provider };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { file, model: `deepseek/${Object.keys(provider.models)[0]}`, keyConfigured: !!env.DEEPSEEK_API_KEY };
}

if (require.main === module) {
  try { console.log(JSON.stringify(configure())); }
  catch (error) { console.error('Command Code 配置失败：', error instanceof SyntaxError ? '现有配置不是有效 JSON' : error.message); process.exitCode = 1; }
}
module.exports = { deepseekConfig, configure };
