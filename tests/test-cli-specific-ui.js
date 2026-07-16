'use strict';

// Browser-level coverage for CLI-specific controls in one logical chat.
// No model turns are sent; fake executable paths make availability deterministic.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cli-specific-ui-test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-cli-ui-'));
const project = path.join(tmpRoot, 'project');
const missingZcode = path.join(tmpRoot, 'missing-zcode');
fs.mkdirSync(project, { recursive: true });

let server;
let browser;
let dirId;

async function api(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = raw; }
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
  return data;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try { await api('GET', '/api/server-info'); return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('isolated server did not start');
}

async function openConfig(page, expectedCli) {
  await page.waitForFunction(cli => document.querySelector('#cli-btn')?.textContent.includes(cli),
    { timeout: 10000 }, expectedCli);
  await page.click('#model-btn');
  await page.waitForSelector('#ai-agent-section', { timeout: 10000 });
  return page.evaluate(() => ({
    effortLabel: document.querySelector('#ai-effort-label')?.textContent.trim(),
    effortVisible: getComputedStyle(document.querySelector('#ai-effort-section')).display !== 'none',
    effortValues: [...document.querySelectorAll('#ai-effort option')].map(option => option.value),
    agentVisible: getComputedStyle(document.querySelector('#ai-agent-section')).display !== 'none',
    subagentVisible: getComputedStyle(document.querySelector('#ai-sub-section')).display !== 'none',
    subagentPillVisible: getComputedStyle(document.querySelector('#subagent-pill')).display !== 'none',
  }));
}

async function closeConfig(page) {
  await page.click('#ai-cancel');
  await page.waitForFunction(() => !document.querySelector('#ai-cancel'));
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  try { server.kill('SIGTERM'); } catch (_) {}
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (server.exitCode === null) try { server.kill('SIGKILL'); } catch (_) {}
  server = null;
}

async function cleanup() {
  try { if (browser) await browser.close(); } catch (_) {}
  browser = null;
  try { if (dirId) await api('DELETE', `/api/directories/${dirId}?force=1`); } catch (_) {}
  await stopServer();
  for (const file of ['sessions.json', 'directories.json', 'events', 'chat_history', 'token_usage.json', 'token_daily.json']) {
    try { fs.rmSync(path.join(ROOT, file), { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), ACCESS_TOKEN: TOKEN,
      CLAUDE_CMD: '/usr/bin/true', CODEX_CMD: '/usr/bin/true', OPENCODE_CMD: '/usr/bin/true',
      ZCODE_CMD: missingZcode,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  await waitForServer();

  const directory = await api('POST', '/api/directories', { name: 'CLI UI', path: project });
  dirId = directory.id;
  const session = await api('POST', `/api/directories/${dirId}/sessions`, {
    cli: 'opencode', kind: 'chat', effort: 'high', agent: 'build',
  });

  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const chatUrl = `${BASE}/chat.html?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(TOKEN)}`;
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  let ui = await openConfig(page, 'OpenCode');
  if (!ui.agentVisible || ui.subagentVisible || ui.subagentPillVisible
      || ui.effortLabel !== 'Variant' || !ui.effortValues.includes('minimal')) {
    throw new Error(`OpenCode controls mismatch: ${JSON.stringify(ui)}`);
  }
  await closeConfig(page);

  await page.click('#cli-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('option')].some(option => option.value === 'zcode'));
  const zcodeOption = await page.evaluate(() => {
    const option = [...document.querySelectorAll('option')].find(item => item.value === 'zcode');
    return { disabled: option?.disabled, text: option?.textContent || '' };
  });
  if (!zcodeOption.disabled || !zcodeOption.text.includes('未安装')) {
    throw new Error(`missing CLI was selectable: ${JSON.stringify(zcodeOption)}`);
  }
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '取消')?.click());

  await api('POST', `/api/sessions/${session.id}/switch-cli`, { cli: 'claude' });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  ui = await openConfig(page, 'Claude');
  if (!ui.agentVisible || !ui.subagentVisible || !ui.subagentPillVisible || ui.effortLabel !== 'Effort') {
    throw new Error(`Claude controls mismatch: ${JSON.stringify(ui)}`);
  }
  await closeConfig(page);

  await api('POST', `/api/sessions/${session.id}/switch-cli`, { cli: 'codex' });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  ui = await openConfig(page, 'Codex');
  if (ui.agentVisible || !ui.subagentVisible || ui.effortLabel !== 'Reasoning Level') {
    throw new Error(`Codex controls mismatch: ${JSON.stringify(ui)}`);
  }

  console.log('CLI-specific UI controls and missing-CLI guard passed');
  await cleanup();
})().catch(async error => {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
});
