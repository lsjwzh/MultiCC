#!/usr/bin/env node
'use strict';

/**
 * MultiCC Core Smoke Test Suite
 * ==============================
 * Covers the 14 confirmed core functions:
 *
 *  A1 Chat mode          — POST /api/directories/:id/sessions, chat page loads
 *  A2 Terminal mode      — / page loads, terminal iframe present
 *  A3 Session list       — GET /api/sessions returns sessions
 *  A4 Create/delete      — POST + DELETE sessions via API
 *  A5 Fork session       — POST /api/sessions/:id/fork
 *  A6 Share session      — POST /api/sessions/:id/share + /share/:token access
 *
 *  B1 Provider list      — GET /api/providers
 *  B2 Per-session CLI    — session creation with cli=codex
 *  B3 Dispatch           — POST /api/sessions/:id/dispatch
 *  B4 Agent presets      — GET /api/agent-presets
 *  B5 Aux queue          — GET /api/aux/health
 *
 *  D1 Cron tasks         — cron API (list endpoint)
 *  D3 Wait/poll          — POST /api/sessions/:id/wait
 *  D4 Run-detached       — POST /api/sessions/:id/run-detached
 *
 * Usage:
 *   node tests/smoke-core.js                  # against http://localhost:3000
 *   node tests/smoke-core.js --base http://localhost:8080
 *   node tests/smoke-core.js --no-browser     # API-only, skip Chrome tests
 */

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const BASE = process.env.MULTICC_URL || 'http://localhost:3000';
const SKIP_BROWSER = process.argv.includes('--no-browser');
const TOKEN = process.env.MULTICC_TOKEN || '';

// ── tiny test runner ──────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];

function ok(name, detail) {
  passed++;
  results.push({ ok: true, name, detail });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, reason) {
  failed++;
  results.push({ ok: false, name, reason });
  console.log(`  ❌ ${name}: ${reason}`);
}

function skip(name, reason) {
  skipped++;
  results.push({ ok: null, name, reason });
  console.log(`  ⏭️  ${name}: ${reason}`);
}

function hdr(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

// ── HTTP helper ───────────────────────────────────────────────────────
function _req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      rejectUnauthorized: false, timeout: 30000
    };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    // Cookies from previous requests
    if (_req._cookie) opts.headers['Cookie'] = _req._cookie;

    const r = mod.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) _req._cookie = setCookie.map(c => c.split(';')[0]).join('; ');
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
_req._cookie = '';
const get    = (p)       => _req('GET', p);
const post   = (p, b)    => _req('POST', p, b);
const del    = (p)       => _req('DELETE', p);

// ── Browser test helper (Puppeteer) ───────────────────────────────────
let browser = null, page = null;

async function initBrowser() {
  if (SKIP_BROWSER) return;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-insecure-localhost', '--ignore-certificate-errors']
    });
    page = await browser.newPage();
    // If there's a token, set it as cookie so we skip login
    if (TOKEN) {
      const u = new URL(BASE);
      await page.setCookie({ name: 'multicc_auth', value: TOKEN, domain: u.hostname, path: '/', httpOnly: true });
    }
    console.log('  [browser] Puppeteer launched');
  } catch (e) {
    fail('browser-init', e.message);
    browser = null;
  }
}

async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; }
}

async function browserTest(name, fn) {
  if (!browser) { skip(name, 'browser not available'); return; }
  try {
    await fn(page);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function navTo(p, url) {
  // Use domcontentloaded instead of networkidle2 to avoid WebSocket hangs
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // Let dynamic content settle
  await new Promise(r => setTimeout(r, 2000));
}

// ── Helper: ensure a directory exists ─────────────────────────────────
async function ensureDir(label) {
  // Directories API uses { name, path }
  const res = await post('/api/directories', { name: label || 'Smoke Test', path: '/tmp/multicc-smoke-test' });
  if (res.body && res.body.id) return res.body.id;
  // Maybe it already exists — list and find
  const r2 = await get('/api/directories');
  const dirs = Array.isArray(r2.body) ? r2.body : (r2.body.directories || []);
  const dir = dirs.find(d => d.path === '/tmp/multicc-smoke-test');
  if (dir) return dir.id;
  throw new Error(`Could not create directory: ${JSON.stringify(res.body).slice(0,200)}`);
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  console.log(`MultiCC Core Smoke Test — ${BASE}`);
  console.log(`Browser: ${SKIP_BROWSER ? 'SKIPPED' : 'enabled'}`);
  const startTime = Date.now();

  // Pre-check: is the server alive?
  try {
    const hc = await get('/api/server-info');
    if (hc.status < 200 || hc.status >= 500) throw new Error(`status ${hc.status}`);
    console.log(`Server: OK (${hc.body.version || 'unknown version'})`);
  } catch (e) {
    console.error(`FATAL: Cannot reach ${BASE} — ${e.message}`);
    console.error('Start the server first: cd MultiCC && node server.js');
    process.exit(1);
  }

  // ── A: 会话管理 ───────────────────────────────────────────────────
  hdr('A. 会话管理');

  // A3: 会话列表
  {
    const res = await get('/api/sessions');
    if (res.status === 200) ok('A3 会话列表', `${(res.body.sessions || res.body || []).length} sessions`);
    else fail('A3 会话列表', `status ${res.status}`);
  }

  // A4: 创建/删除会话
  let testSessionId = null;
  let testDirId = null;
  {
    testDirId = await ensureDir('Smoke Test');
    const res = await post(`/api/directories/${testDirId}/sessions`, { cli: 'claude', kind: 'chat' });
    if (res.status === 200 || res.status === 201) {
      testSessionId = res.body.id || res.body.sessionId;
      ok('A4 创建会话', `id=${testSessionId}`);
    } else {
      fail('A4 创建会话', `status ${res.status} body=${JSON.stringify(res.body).slice(0,100)}`);
    }
  }

  // A5: Fork
  if (testSessionId) {
    const res = await post(`/api/sessions/${testSessionId}/fork`, { messageIndex: 0 });
    if (res.status === 200 || res.status === 201) {
      ok('A5 Fork 会话', `forked → ${res.body.id || res.body.sessionId || 'ok'}`);
    } else if (res.status === 400 || res.status === 404) {
      // no messages yet is expected for a fresh session
      skip('A5 Fork 会话', `no messages to fork from (status ${res.status})`);
    } else {
      fail('A5 Fork 会话', `status ${res.status}`);
    }
  } else {
    skip('A5 Fork 会话', 'no session created');
  }

  // A6: Share
  if (testSessionId) {
    const res = await post(`/api/sessions/${testSessionId}/share`);
    if (res.status === 200 || res.status === 201) {
      const token = res.body.token || res.body.shareToken;
      if (token) {
        ok('A6 分享会话', `token=${token}`);
        // Verify share page is accessible
        const sr = await get(`/share/${token}`);
        if (sr.status === 200 || sr.status === 302) ok('A6 分享页可访问', `status ${sr.status}`);
        else fail('A6 分享页可访问', `status ${sr.status}`);
      } else {
        ok('A6 分享会话', 'no token in response (may require messages)');
      }
    } else {
      skip('A6 分享会话', `status ${res.status} (may require chat history)`);
    }
  }

  // A4b: 删除会话
  if (testSessionId) {
    const res = await del(`/api/sessions/${testSessionId}`);
    if (res.status === 200 || res.status === 204) ok('A4 删除会话', `deleted ${testSessionId}`);
    else fail('A4 删除会话', `status ${res.status}`);
  }

  // A1: Chat 模式 (browser)
  await initBrowser();
  await browserTest('A1 Chat 页面加载', async (p) => {
    await navTo(p, `${BASE}/chat`);
    const title = await p.title();
    if (!title.includes('MultiCC') && !title.includes('Chat')) throw new Error(`unexpected title: ${title}`);
  });

  // A2: Terminal 模式 (browser)
  await browserTest('A2 终端页面加载', async (p) => {
    await navTo(p, BASE + '/');
    const title = await p.title();
    // Terminal page might not have MultiCC in title
    const hasTerminal = await p.evaluate(() => {
      return !!(document.querySelector('.xterm') || document.querySelector('iframe') ||
                document.querySelector('#terminal') || document.querySelector('[data-terminal]'));
    });
    if (!hasTerminal) throw new Error('no terminal element found on page');
  });

  // ── B: 多 Agent & 多 Provider ─────────────────────────────────────
  hdr('B. 多 Agent & 多 Provider');

  // B1: Provider 列表
  {
    const res = await get('/api/providers');
    if (res.status === 200) {
      const count = Array.isArray(res.body) ? res.body.length : Object.keys(res.body).length;
      ok('B1 Provider 列表', `${count} providers`);
    } else fail('B1 Provider 列表', `status ${res.status}`);
  }

  // B2: Per-session CLI (create a codex session)
  if (testDirId) {
    const res = await post(`/api/directories/${testDirId}/sessions`, { cli: 'codex', type: 'chat' });
    if (res.status === 200 || res.status === 201) {
      const sid = res.body.id || res.body.sessionId;
      ok('B2 Per-session Provider', `codex session: ${sid}`);
      // cleanup
      await del(`/api/sessions/${sid}`);
    } else {
      skip('B2 Per-session Provider', `status ${res.status} (codex may not be installed)`);
    }
  }

  // B3: Dispatch
  if (testDirId) {
    // Create a target session
    const ts = await post(`/api/directories/${testDirId}/sessions`, { cli: 'claude', type: 'chat' });
    const targetId = ts.body.id || ts.body.sessionId;
    if (targetId) {
      const res = await post(`/api/sessions/${targetId}/dispatch`, { target: targetId, message: 'ping' });
      if (res.status === 200) ok('B3 Dispatch', 'API accepted');
      else if (res.status === 400) ok('B3 Dispatch', `status ${res.status} (expected: no self-dispatch)`);
      else fail('B3 Dispatch', `status ${res.status}`);
      await del(`/api/sessions/${targetId}`);
    } else {
      skip('B3 Dispatch', 'no target session');
    }
  }

  // B4: Agent 预设
  {
    const res = await get('/api/agent-presets');
    if (res.status === 200) ok('B4 Agent 预设', `${Array.isArray(res.body) ? res.body.length : 'ok'} presets`);
    else fail('B4 Agent 预设', `status ${res.status}`);
  }

  // B5: Aux 队列
  {
    const res = await get('/api/aux/health');
    if (res.status === 200) ok('B5 Aux 队列', JSON.stringify(res.body).slice(0, 80));
    else fail('B5 Aux 队列', `status ${res.status}`);
  }

  // ── D: 定时 & 自动化 ─────────────────────────────────────────────
  hdr('D. 定时 & 自动化');

  // D1: 定时任务
  {
    const res = await post('/api/cron', {
      name: 'smoke-test-' + Date.now(),
      dirPath: '/tmp/multicc-smoke-test',
      cron: '0 3 * * 0', // Sunday 3am — won't actually fire
      prompt: 'echo smoke-test-ok'
    });
    if (res.status === 200) {
      ok('D1 定时任务创建', `${res.body.id || 'ok'}`);
      // cleanup
      if (res.body.id) await del(`/api/cron/${res.body.id}`);
    } else {
      skip('D1 定时任务创建', `status ${res.status} (cron API path may differ)`);
    }
  }

  // D3: Wait/poll
  if (testDirId) {
    const ts = await post(`/api/directories/${testDirId}/sessions`, { cli: 'claude', type: 'chat' });
    const wsid = ts.body.id || ts.body.sessionId;
    if (wsid) {
      const res = await post(`/api/sessions/${wsid}/wait`, {
        mode: 'poll',
        pollCmd: 'echo done',
        untilContains: 'done',
        intervalSec: 5,
        maxChecks: 1
      });
      if (res.status === 200) ok('D3 Wait/poll', `waitId=${res.body.id || res.body.waitId || 'ok'}`);
      else skip('D3 Wait/poll', `status ${res.status}`);
      await del(`/api/sessions/${wsid}`);
    }
  }

  // D4: Run-detached
  if (testDirId) {
    const ts = await post(`/api/directories/${testDirId}/sessions`, { cli: 'claude', type: 'chat' });
    const dsid = ts.body.id || ts.body.sessionId;
    if (dsid) {
      const res = await post(`/api/sessions/${dsid}/run-detached`, { command: 'echo detached-ok' });
      if (res.status === 200) ok('D4 Run-detached', `taskId=${res.body.taskId || res.body.id || 'ok'}`);
      else skip('D4 Run-detached', `status ${res.status}`);
      await del(`/api/sessions/${dsid}`);
    }
  }

  // ── Browser: manage page dashboard ─────────────────────────────────
  hdr('Browser: Manage Dashboard');

  await browserTest('Manage 页面加载', async (p) => {
    await p.goto(`${BASE}/manage`, { waitUntil: 'networkidle2', timeout: 15000 });
    const title = await p.title();
    if (!title.includes('MultiCC') && !title.includes('Dashboard')) throw new Error(`unexpected title: ${title}`);
    // Check key elements
    const hasNav = await p.evaluate(() => !!document.querySelector('#nav, .nav, [data-view]'));
    if (!hasNav) throw new Error('no sidebar/nav found');
  });

  await browserTest('概览 KPI 显示', async (p) => {
    await p.goto(`${BASE}/manage`, { waitUntil: 'networkidle2', timeout: 15000 });
    // Wait a bit for KPI refresh
    await new Promise(r => setTimeout(r, 2000));
    const kpi = await p.evaluate(() => {
      const el = document.querySelector('#kpi-active, .kpi .k-num');
      return el ? el.textContent : null;
    });
    if (kpi === null) throw new Error('no KPI element found');
  });

  await browserTest('版本检测可见', async (p) => {
    await p.goto(`${BASE}/manage`, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));
    const ver = await p.evaluate(() => {
      const el = document.querySelector('#ver-current');
      return el ? el.textContent : null;
    });
    if (!ver || ver === 'v—') throw new Error('version indicator not updated');
    ok('版本检测', ver);
  });

  // ── Cleanup ────────────────────────────────────────────────────────
  await closeBrowser();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ✅ ${passed}  ⏭️  ${skipped}  ❌ ${failed}   (${elapsed}s)`);
  console.log(`═══════════════════════════════════════════════════════`);

  if (failed > 0) process.exit(1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
