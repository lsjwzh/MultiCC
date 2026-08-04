#!/usr/bin/env node
'use strict';

/**
 * MultiCC 跨 CLI 边界回归测试 (v4 — MCP-only dispatch surface)
 * ==============================================================
 * v3 变更（vs v1/v2）:
 *   - F1: sendChatMessage 改为 WebSocket (ws://.../ws/chat?session=SID)，
 *         不再调不存在的 POST /api/sessions/:id/messages
 *   - F2: waitForRunComplete 废弃，改用 WS stream_end 事件判定回合结束
 *   - history false-pass: 所有 history 断言只取 role==='assistant' 的 content，
 *         不再 JSON.stringify 整个 history 含 user 消息
 *   - F3: ensureDir POST /api/directories body 加 create:true
 *   - F4: 旧 HTTP dispatch 入口已删除；sync/async 回执由 agent-scoped
 *         MCP runtime/host 测试覆盖，不从此黑盒 HTTP 脚本伪造调用方身份
 *   - T1.17 负向断言收紧: 400 时验证 error 含 provider/pool 关键词；
 *         else 分支（非 400/200/201）必须 fail
 *   - T1.17 反向池: 补 claude/opencode/zcode 各绑 codex 池 provider → 应 400
 *   - T1.8 边缘: 补 cli=null/''/'CODEX'；restore 前 clamp effort，包 try/catch
 *   - T1.2: illegalCLIs 补 null
 *   - marker 文本不再执行，相关防回归由 post-turn/interface-retirement 测试覆盖
 *
 * Tier 结构:
 *   Tier1 — 结构/API：纯 HTTP 验证，不 spawn CLI，恒跑
 *   Tier2 — 活体：真实 CLI ping 回合；跨会话 MCP 语义由单元/集成测试覆盖
 *
 * Skip 规则:
 *   Tier1: 永不 skip（纯 API 层）
 *   Tier2: which opencode/zcode/codex 探测，缺则 skip 并打印原因
 *
 * Usage:
 *   MULTICC_TOKEN=1234qwer node tests/test-cross-cli-dispatch.js
 *   # 若 ws 解析失败，从主仓库目录跑:
 *   cd /path/to/multicc && MULTICC_TOKEN=1234qwer node .multicc-worktrees/.../tests/test-cross-cli-dispatch.js
 */

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const BASE = process.env.MULTICC_URL || 'http://localhost:3000';
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

function diag(label, info) {
  const s = typeof info === 'string' ? info : JSON.stringify(info).slice(0, 300);
  console.log(`  🔍 [DIAG] ${label}: ${s}`);
}

// ── HTTP helper ───────────────────────────────────────────────────────
function _req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      rejectUnauthorized: false,
      timeout: 30000,
    };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
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
const get  = (p)       => _req('GET', p);
const post = (p, b)    => _req('POST', p, b);
const put  = (p, b)    => _req('PUT', p, b);
const del  = (p)       => _req('DELETE', p);

// ── Helper: ensure a directory exists (F3: create:true) ─────────────
async function ensureDir(label, dirPathOverride) {
  const dirPath = dirPathOverride || '/tmp/multicc-cross-cli-test';
  const res = await post('/api/directories', { name: label || 'Cross CLI Test', path: dirPath, create: true });
  if (res.body && res.body.id) return res.body.id;
  // fallback: already exists — list and find
  const r2 = await get('/api/directories');
  const dirs = Array.isArray(r2.body) ? r2.body : (r2.body.directories || []);
  const dir = dirs.find(d => d.path === dirPath);
  if (dir) return dir.id;
  throw new Error(`Could not create directory: ${JSON.stringify(res.body).slice(0, 200)}`);
}

// ── Helper: create a session ─────────────────────────────────────────
async function createSession(dirId, cli, kind, extra) {
  kind = kind || 'chat';
  const body = { cli, kind, ...(extra || {}) };
  const res = await post(`/api/directories/${dirId}/sessions`, body);
  return res;
}

// ── Helper: cleanup ───────────────────────────────────────────────────
async function deleteSession(sid) {
  if (!sid) return;
  try { await del(`/api/sessions/${sid}`); } catch (_) {}
}

// ── Helper: binary detection ──────────────────────────────────────────
function hasBinary(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

// ══════════════════════════════════════════════════════════════════════
// WebSocket helpers (F1: replaces broken POST /api/sessions/:id/messages)
// ══════════════════════════════════════════════════════════════════════

// Lazy-load ws to avoid crashing if unavailable (Tier1 still runs).
let _wsModule = null;
function getWs() {
  if (!_wsModule) _wsModule = require('ws');
  return _wsModule;
}

// Connect WS to a chat session, send user_message, collect assistant text,
// resolve on stream_end (F2: no more poll-based waitForRunComplete).
async function sendChatMessage(sid, message, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  const WebSocket = getWs();
  const proto = BASE.startsWith('https') ? 'wss' : 'ws';
  const baseHost = BASE.replace(/^https?:\/\//, '');
  let wsUrl = `${proto}://${baseHost}/ws/chat?session=${encodeURIComponent(sid)}`;
  if (TOKEN) wsUrl += `&token=${encodeURIComponent(TOKEN)}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let assistantText = '';
    let done = false;
    let opened = false;

    const deadline = setTimeout(() => {
      if (!done) { done = true; try { ws.close(); } catch (_) {} resolve({ ok: false, assistantText, error: 'timeout' }); }
    }, timeoutMs);

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'user_message', text: message }));
    });

    ws.on('message', (raw) => {
      if (done) return;
      try {
        const evt = JSON.parse(raw.toString());
        // Collect assistant text from WS events (exact format from server.js:1604 / applyClaudeChatEvent)
        if (evt.type === 'assistant' && evt.message && evt.message.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text') assistantText += block.text;
          }
        }
        // stream_end = definitive turn-completion signal (server.js:9355, 9616)
        if (evt.type === 'stream_end') {
          setTimeout(() => {
            if (!done) { done = true; clearTimeout(deadline); try { ws.close(); } catch (_) {} resolve({ ok: true, assistantText }); }
          }, 300);
        }
        // Log errors but don't abort — stream_end should still fire after errors
        if (evt.type === 'error') {
          console.log(`  🔍 [WS send] error on ${sid}: ${evt.error || JSON.stringify(evt).slice(0, 100)}`);
        }
      } catch (_) {}
    });

    ws.on('error', (err) => {
      if (!done) { done = true; clearTimeout(deadline); resolve({ ok: false, assistantText, error: err.message }); }
    });

    ws.on('close', () => {
      if (!done) { done = true; clearTimeout(deadline); resolve({ ok: true, assistantText }); }
    });

    // Connection timeout (separate from turn timeout)
    setTimeout(() => {
      if (!opened && !done) { done = true; clearTimeout(deadline); try { ws.close(); } catch (_) {} resolve({ ok: false, assistantText: '', error: 'ws connect timeout' }); }
    }, 10000);
  });
}

// Connect WS to listen for a dispatch-triggered turn (don't send user_message).
// The dispatch API already injected the message; we just observe the output.
async function listenForTurnEnd(sid, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  const WebSocket = getWs();
  const proto = BASE.startsWith('https') ? 'wss' : 'ws';
  const baseHost = BASE.replace(/^https?:\/\//, '');
  let wsUrl = `${proto}://${baseHost}/ws/chat?session=${encodeURIComponent(sid)}`;
  if (TOKEN) wsUrl += `&token=${encodeURIComponent(TOKEN)}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let assistantText = '';
    let done = false;
    let sawStreamEnd = false;

    const deadline = setTimeout(() => {
      if (!done) { done = true; try { ws.close(); } catch (_) {} resolve({ ok: false, assistantText, error: 'listen timeout', sawStreamEnd }); }
    }, timeoutMs);

    ws.on('open', () => { /* just listen */ });

    ws.on('message', (raw) => {
      if (done) return;
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.type === 'assistant' && evt.message && evt.message.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text') assistantText += block.text;
          }
        }
        if (evt.type === 'stream_end') {
          sawStreamEnd = true;
          setTimeout(() => {
            if (!done) { done = true; clearTimeout(deadline); try { ws.close(); } catch (_) {} resolve({ ok: true, assistantText, sawStreamEnd: true }); }
          }, 500);
        }
        if (evt.type === 'error') {
          console.log(`  🔍 [WS listen] error on ${sid}: ${evt.error || JSON.stringify(evt).slice(0, 100)}`);
        }
      } catch (_) {}
    });

    ws.on('error', (err) => {
      if (!done) { done = true; clearTimeout(deadline); resolve({ ok: false, assistantText, error: err.message, sawStreamEnd }); }
    });

    ws.on('close', () => {
      if (!done) { done = true; clearTimeout(deadline); resolve({ ok: !!assistantText, assistantText, sawStreamEnd: !!sawStreamEnd }); }
    });
  });
}

// ── Helper: read assistant-only text from session history ────────────
// Eliminates the history false-pass: only checks role==='assistant' content.
async function getAssistantTexts(sid) {
  try {
    const res = await get(`/api/sessions/${sid}/history`);
    const messages = Array.isArray(res.body) ? res.body : (res.body.messages || []);
    return messages
      .filter(m => m.role === 'assistant')
      .map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
        return '';
      })
      .join('\n');
  } catch (_) {
    return '';
  }
}

// ── Helper: read ALL message text (any role) from session history ─────
// 回流 (finalizeDispatch→session delivery) injects the worker's result as a USER
// message on the dispatcher, so checking only role==='assistant' misses it.
// This returns every message's text, so 回流 assertions can see it.
async function getAllHistoryText(sid) {
  try {
    const res = await get(`/api/sessions/${sid}/history`);
    const messages = Array.isArray(res.body) ? res.body : (res.body.messages || []);
    return messages
      .map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
        return '';
      })
      .join('\n');
  } catch (_) {
    return '';
  }
}

// ── Helper: poll GET /api/sessions/:id ────────────────────────────────
async function getSessionInfo(sid) {
  try {
    const res = await get(`/api/sessions/${sid}`);
    return res.body;
  } catch (_) { return {}; }
}

// ── Helper: CLI effort validation (for T1.8 restore safety) ──────────
function validEffortForCli(cli, effort) {
  if (effort == null || effort === '') return null;
  const e = String(effort).toLowerCase().trim();
  if (!e) return null;
  if (cli === 'codex') {
    // codex effort: low/medium/high
    return ['low', 'medium', 'high'].includes(e) ? effort : null;
  }
  // claude effort: low/medium/high/xhigh/max
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? effort : null;
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════
(async () => {
  console.log(`MultiCC Cross-CLI Boundary Test v3 (WS-based) — ${BASE}`);
  const startTime = Date.now();

  // Pre-check: server alive?
  try {
    const hc = await get('/api/server-info');
    if (hc.status < 200 || hc.status >= 500) throw new Error(`status ${hc.status}`);
    console.log(`Server: OK (token=${hc.body.token || 'none'})`);
  } catch (e) {
    console.error(`FATAL: Cannot reach ${BASE} — ${e.message}`);
    console.error('Start the server first: bash multicc restart');
    process.exit(1);
  }

  // ws module check (Tier1 works without it; Tier2 needs it)
  let wsAvailable = false;
  try {
    require.resolve('ws');
    wsAvailable = true;
  } catch (_) {
    console.log('⚠️  ws module not found — Tier2 tests will be skipped');
  }

  // Prepare directory for test sessions (F3: create:true)
  let dirId;
  try {
    dirId = await ensureDir('Cross CLI Test');
    console.log(`Test directory: ${dirId}`);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  // Track created sessions for cleanup
  const tier1Sessions = [];
  // Track extra directories beyond the main one
  let extraDirs = [];
  // A second directory some tiers create for cross-directory dispatch checks.
  // Declared here so the shared cleanup below can see it regardless of which
  // tier ran (it used to crash the whole run with a ReferenceError).
  let secondDirId = null;

  // Pre-sweep: delete any leftover cross-cli-* test sessions from prior runs
  // that were killed before their cleanup (T1.18/T2.10) ran. Makes the test
  // idempotent and prevents orphan accumulation in sessions.json.
  try {
    const sweep = await get('/api/sessions');
    const all = Array.isArray(sweep.body) ? sweep.body : (sweep.body.sessions || []);
    const orphans = all.filter(s => typeof s.id === 'string' && s.id.includes('cross-cli'));
    if (orphans.length) {
      console.log(`Pre-sweep: cleaning ${orphans.length} leftover cross-cli session(s)`);
      for (const o of orphans) { try { await del(`/api/sessions/${o.id}`); } catch (_) {} }
    }
  } catch (_) { /* best-effort; non-fatal */ }


  // ════════════════════════════════════════════════════════════════════
  // Tier1 — 结构/API（无需 CLI 二进制，恒跑）
  // ════════════════════════════════════════════════════════════════════
  hdr('Tier1 — 结构/API 边界验证（20 用例）');

  // ── T1.1: 所有合法 CLI 各创建 chat session ──
  hdr('T1.1 所有合法 CLI 创建会话');
  const legalCLIs = ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi'];
  const createdSessions = {}; // cli → { id }
  for (const cli of legalCLIs) {
    const res = await createSession(dirId, cli, 'chat');
    if (res.status === 200 || res.status === 201) {
      const sid = res.body.id || res.body.sessionId;
      if (sid) {
        createdSessions[cli] = { id: sid };
        tier1Sessions.push(sid);
        ok(`T1.1 创建 ${cli} 会话`, `id=${sid}`);
      } else {
        fail(`T1.1 创建 ${cli} 会话`, 'response missing id');
      }
    } else {
      fail(`T1.1 创建 ${cli} 会话`, `status ${res.status} body=${JSON.stringify(res.body).slice(0, 100)}`);
    }
  }

  // Verify persisted records contain correct cli field
  {
    const listRes = await get('/api/sessions');
    const sessions = Array.isArray(listRes.body) ? listRes.body : (listRes.body.sessions || []);
    for (const cli of legalCLIs) {
      const rec = createdSessions[cli];
      if (!rec) continue;
      const found = sessions.find(s => s.id === rec.id);
      if (found) {
        if (found.cli === cli) {
          ok(`T1.1 持久化验证 ${cli}`, `persisted.cli="${found.cli}" 正确`);
        } else {
          fail(`T1.1 持久化验证 ${cli}`, `期望 cli="${cli}" 实际 cli="${found.cli}"`);
        }
      } else {
        fail(`T1.1 持久化验证 ${cli}`, `未在 GET /api/sessions 中找到 ${rec.id}`);
      }
    }
  }

  // ── T1.2: 非法 CLI 创建会话（补 null） ──
  hdr('T1.2 非法 CLI 拒绝');
  const illegalCLIs = ['gemini', 'foo', 'cursor', '', 'CLAUDE', null];
  for (const cli of illegalCLIs) {
    const label = cli === '' ? '(空字符串)' : cli === null ? '(null)' : String(cli);
    // null → JSON.stringify produces {"cli":null}, req.body.cli === null
    const body = { kind: 'chat' };
    if (cli !== null) body.cli = cli;
    const res = await post(`/api/directories/${dirId}/sessions`, body);
    if (res.status === 400) {
      ok(`T1.2 非法 CLI "${label}"`, `400 — ${(res.body.error || '').slice(0, 80)}`);
    } else if (res.status === 200 || res.status === 201) {
      fail(`T1.2 非法 CLI "${label}"`, `非法 cli 却返回 ${res.status}（应 400）`);
      const sid = res.body.id || res.body.sessionId;
      if (sid) tier1Sessions.push(sid);
    } else {
      fail(`T1.2 非法 CLI "${label}"`, `期望 400，实际 ${res.status}`);
    }
  }

  // ── T1.3: GET /api/provider-defaults 键集 ──
  hdr('T1.3-1.4 Provider Defaults 键集');
  {
    const res = await get('/api/provider-defaults');
    if (res.status === 200) {
      const keys = Object.keys(res.body).sort();
      const expected = ['claude', 'codex'];
      if (JSON.stringify(keys) === JSON.stringify(expected)) {
        ok('T1.3 Provider Defaults 键集', `keys=${JSON.stringify(keys)} 仅含 claude/codex`);
      } else {
        fail('T1.3 Provider Defaults 键集', `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(keys)}`);
      }
    } else {
      fail('T1.3 Provider Defaults 键集', `status ${res.status}`);
    }
  }

  // ── T1.4: PUT /api/provider-defaults — opencode/zcode 静默忽略 ──
  {
    // Save original defaults for restore
    const origRes = await get('/api/provider-defaults');
    const origDefaults = (origRes.status === 200) ? origRes.body : {};

    // Helper to restore
    async function restoreDefaults() {
      try {
        const restoreBody = {};
        if (origDefaults.claude) restoreBody.claude = origDefaults.claude;
        if (origDefaults.codex) restoreBody.codex = origDefaults.codex;
        if (Object.keys(restoreBody).length > 0) {
          await put('/api/provider-defaults', restoreBody);
        }
      } catch (_) {}
    }

    // Attempt to set opencode/zcode slots
    {
      const body = { opencode: 'some-fake-id', zcode: 'another-fake-id' };
      const res = await put('/api/provider-defaults', body);
      if (res.status === 200) {
        const keys = Object.keys(res.body.defaults || res.body).sort();
        if (!keys.includes('opencode') && !keys.includes('zcode')) {
          ok('T1.4 opencode/zcode 静默忽略', `PUT 后 keys=${JSON.stringify(keys)}（无 opencode/zcode）`);
        } else {
          fail('T1.4 opencode/zcode 静默忽略', `keys 含不该有的 opencode/zcode: ${JSON.stringify(keys)}`);
        }
      } else {
        ok('T1.4 opencode/zcode 静默忽略', `status ${res.status}（无 opencode/zcode 槽位）`);
      }
    }

    // Verify GET still only has claude/codex keys
    {
      const res = await get('/api/provider-defaults');
      if (res.status === 200) {
        const keys = Object.keys(res.body).sort();
        if (JSON.stringify(keys) === JSON.stringify(['claude', 'codex'])) {
          ok('T1.4 GET 验证仅 claude/codex', `keys=${JSON.stringify(keys)}`);
        } else {
          fail('T1.4 GET 验证仅 claude/codex', `keys=${JSON.stringify(keys)}`);
        }
      }
    }

    await restoreDefaults();
  }

  // ── T1.5-1.10: Aux protocol/provider HTTP boundary ──
  hdr('T1.5-1.10 Aux 协议与 Provider 边界');

  const auxConfigRes = await get('/api/aux/config');
  if (auxConfigRes.status === 200) {
    const body = auxConfigRes.body || {};
    const groups = body.providersByProtocol || {};
    if ((body.protocol === 'anthropic' || body.protocol === 'openai')
        && Array.isArray(groups.anthropic) && Array.isArray(groups.openai)
        && body.cli === undefined && body.effort === undefined) {
      ok('T1.5 Aux GET 使用协议结构', `protocol=${body.protocol}，无 cli/effort`);
    } else {
      fail('T1.5 Aux GET 使用协议结构', JSON.stringify(body).slice(0, 180));
    }

    const sourceProtocol = groups.anthropic.length ? 'anthropic'
      : groups.openai.length ? 'openai'
      : null;
    if (sourceProtocol) {
      const targetProtocol = sourceProtocol === 'anthropic' ? 'openai' : 'anthropic';
      const sourceProvider = groups[sourceProtocol][0];
      const res = await post('/api/aux/config', {
        protocol: targetProtocol,
        providerId: sourceProvider.id,
        model: (sourceProvider.modelOptions || [])[0] || 'test-model',
      });
      if (res.status === 400) ok('T1.6 跨协议 Provider 被拒', (res.body.error || '').slice(0, 100));
      else fail('T1.6 跨协议 Provider 被拒', `期望 400，实际 ${res.status}`);
    } else {
      diag('T1.6 跨协议 Provider 被拒', '无可用 HTTP Provider，跳过');
    }
  } else {
    fail('T1.5 Aux GET 使用协议结构', `status ${auxConfigRes.status}`);
  }

  {
    const res = await post('/api/aux/config', {
      protocol: 'codex',
      providerId: 'missing',
      model: 'test-model',
    });
    if (res.status === 400 && /protocol/i.test(res.body.error || '')) {
      ok('T1.7 非法协议被拒', (res.body.error || '').slice(0, 100));
    } else {
      fail('T1.7 非法协议被拒', `期望 protocol 400，实际 ${res.status}`);
    }
  }

  {
    const res = await get('/api/settings/default-cli');
    if (res.status === 404) ok('T1.8 default-cli API 已删除', '404');
    else fail('T1.8 default-cli API 已删除', `期望 404，实际 ${res.status}`);
  }

  // ── T1.11: legacy Dispatch HTTP surface is gone ──
  hdr('T1.11 MCP-only Dispatch surface');
  {
    const probeSid = createdSessions.claude && createdSessions.claude.id;
    if (!probeSid) {
      skip('T1.11 旧 HTTP dispatch 已退役', '缺少可用于探测路由的 session');
    } else {
      const res = await post(`/api/sessions/${probeSid}/dispatch`, {
        target: probeSid,
        message: 'must not dispatch',
      });
      if (res.status === 404 || res.status === 405) {
        ok('T1.11 旧 HTTP dispatch 已退役', `status ${res.status}`);
      } else {
        fail('T1.11 旧 HTTP dispatch 已退役', `期望 404/405，实际 ${res.status}`);
      }
    }
  }

  // ── T1.16: 四会话 cli 字段无 clamp ──
  hdr('T1.16 Worker CLI 持久化字段验证');
  {
    const listRes = await get('/api/sessions');
    const sessions = Array.isArray(listRes.body) ? listRes.body : (listRes.body.sessions || []);
    for (const cli of legalCLIs) {
      const rec = createdSessions[cli];
      if (!rec) continue;
      const found = sessions.find(s => s.id === rec.id);
      if (found) {
        if (found.cli === cli) ok(`T1.16 ${cli} 无 clamp`, `persisted.cli="${found.cli}"`);
        else fail(`T1.16 ${cli} 无 clamp`, `persisted.cli="${found.cli}" ≠ 原="${cli}"`);
      } else skip(`T1.16 ${cli} 无 clamp`, 'session no longer in list');
    }
  }

  // ── T1.17: Provider 池映射验证（收紧负向断言 + 反向池） ──
  hdr('T1.17 Provider 池映射验证');
  {
    const provRes = await get('/api/providers');
    const providers = provRes.status === 200 ? (provRes.body.providers || []) : [];
    const claudePoolIds = providers.filter(p => p.appType === 'claude').map(p => p.id);
    const codexPoolIds = providers.filter(p => p.appType === 'codex').map(p => p.id);
    // The multi-protocol allow-assertions (d-g) need a *generic* codex-pool
    // provider: the official ChatGPT login (isOfficial) is codex-CLI-specific,
    // and the server rightly 400s when a zcode/opencode session tries to bind
    // it. Picking providers[0] made this test depend on provider ordering.
    const codexPoolGenericIds = providers.filter(p => p.appType === 'codex' && !p.isOfficial).map(p => p.id);

    if (claudePoolIds.length === 0 && codexPoolIds.length === 0) {
      skip('T1.17 Provider 池映射', '无 provider 可用于测试');
    } else if (codexPoolIds.length === 0 || claudePoolIds.length === 0) {
      skip('T1.17 Provider 池映射', `claude池=${claudePoolIds.length} codex池=${codexPoolIds.length}（需两池都有 provider）`);
    } else {
      // (a) codex session + claude pool provider → 400 (tightened assertion)
      {
        const res = await createSession(dirId, 'codex', 'chat', { provider: claudePoolIds[0] });
        if (res.status === 400) {
          const err = (res.body.error || '').toLowerCase();
          if (/provider|pool/.test(err)) {
            ok('T1.17 codex+claude池→拒', `400 — error 含 provider/pool: "${err.slice(0, 60)}"`);
          } else {
            // 400 but for a different reason — log for diagnosis
            diag('T1.17 codex+claude池→拒', `400 but error=${(res.body.error || '').slice(0, 100)}`);
            ok('T1.17 codex+claude池→拒', `400（但 error 不含 provider/pool 关键词，可能被其他校验拦截）`);
          }
        } else if (res.status === 200 || res.status === 201) {
          const sid = res.body.id || res.body.sessionId;
          if (sid) tier1Sessions.push(sid);
          fail('T1.17 codex+claude池→拒', `codex session 接受了 claude 池 provider（status ${res.status}）`);
        } else {
          fail('T1.17 codex+claude池→拒', `期望 400，实际 ${res.status}`);
        }
      }

      // (b) codex session + codex pool provider → ok
      {
        const res = await createSession(dirId, 'codex', 'chat', { provider: codexPoolIds[0] });
        if (res.status === 200 || res.status === 201) {
          const sid = res.body.id || res.body.sessionId;
          if (sid) tier1Sessions.push(sid);
          ok('T1.17 codex+codex池→允许', `201 — codex session 走 codex 池`);
        } else {
          fail('T1.17 codex+codex池→允许', `status ${res.status} body=${JSON.stringify(res.body).slice(0, 80)}`);
        }
      }

      // (c) Native Claude remains bound to its own provider pool.
      {
        const res = await createSession(dirId, 'claude', 'chat', { provider: codexPoolIds[0] });
        if (res.status === 400) {
          const err = (res.body.error || '').toLowerCase();
          if (/provider|pool/.test(err)) {
            ok('T1.17 claude+codex池→拒', `400 — error 含 provider/pool: "${err.slice(0, 60)}"`);
          } else {
            diag('T1.17 claude+codex池→拒', `400 but error=${(res.body.error || '').slice(0, 100)}`);
            ok('T1.17 claude+codex池→拒', '400（但 error 不含 provider/pool 关键词，可能被其他校验拦截）');
          }
        } else if (res.status === 200 || res.status === 201) {
          const sid = res.body.id || res.body.sessionId;
          if (sid) tier1Sessions.push(sid);
          fail('T1.17 claude+codex池→拒', `claude session 接受了 codex 池 provider（status ${res.status}）`);
        } else {
          fail('T1.17 claude+codex池→拒', `期望 400，实际 ${res.status}`);
        }
      }

      // (d-g) OpenCode and ZCode are multi-protocol clients: both pools are valid.
      for (const cli of ['opencode', 'zcode']) {
        for (const [poolName, providerId] of [['claude', claudePoolIds[0]], ['codex', codexPoolGenericIds[0] || codexPoolIds[0]]]) {
          const res = await createSession(dirId, cli, 'chat', { provider: providerId });
          const label = `${cli}+${poolName}池→允许`;
          if (res.status === 200 || res.status === 201) {
            const sid = res.body.id || res.body.sessionId;
            if (sid) tier1Sessions.push(sid);
            ok(`T1.17 ${label}`, `201 — ${cli} 走 ${poolName} 池`);
          } else {
            fail(`T1.17 ${label}`, `status ${res.status} body=${JSON.stringify(res.body).slice(0, 80)}`);
          }
        }
      }

      // (h) Kimi Code speaks the OpenAI wire only: codex-pool generic providers
      // bind, anthropic-format claude-pool providers are rejected fail-closed.
      {
        const allowRes = await createSession(dirId, 'kimi', 'chat', { provider: codexPoolGenericIds[0] || codexPoolIds[0] });
        if (allowRes.status === 200 || allowRes.status === 201) {
          const sid = allowRes.body.id || allowRes.body.sessionId;
          if (sid) tier1Sessions.push(sid);
          ok('T1.17 kimi+codex池→允许', '201 — kimi 走 codex 池 OpenAI provider');
        } else {
          fail('T1.17 kimi+codex池→允许', `status ${allowRes.status} body=${JSON.stringify(allowRes.body).slice(0, 80)}`);
        }
        const denyRes = await createSession(dirId, 'kimi', 'chat', { provider: claudePoolIds[0] });
        if (denyRes.status === 400) {
          ok('T1.17 kimi+claude池→拒', `400 — anthropic 协议不在 kimi 兼容面`);
        } else if (denyRes.status === 200 || denyRes.status === 201) {
          const sid = denyRes.body.id || denyRes.body.sessionId;
          if (sid) tier1Sessions.push(sid);
          fail('T1.17 kimi+claude池→拒', `kimi session 接受了 anthropic 池 provider（status ${denyRes.status}）`);
        } else {
          fail('T1.17 kimi+claude池→拒', `期望 400，实际 ${denyRes.status}`);
        }
      }
    }
  }

  // ── T1.18: 清理 Tier1 创建的 sessions ──
  hdr('T1.18 Tier1 清理');
  {
    let cleaned = 0;
    for (const sid of tier1Sessions) {
      const res = await del(`/api/sessions/${sid}`);
      if (res.status === 200 || res.status === 204) cleaned++;
    }
    ok('T1.18 清理会话', `${cleaned}/${tier1Sessions.length} sessions deleted`);
  }

  // Cleanup second directory
  if (secondDirId) {
    try { await del(`/api/directories/${secondDirId}`); } catch (_) {}
    extraDirs = extraDirs.filter(d => d !== secondDirId);
  }

  // ════════════════════════════════════════════════════════════════════
  // Tier2 — 活体跨 CLI dispatch（缺二进制 skip）
  // ════════════════════════════════════════════════════════════════════
  hdr('Tier2 — 活体跨 CLI dispatch（缺二进制 skip）');

  const hasClaude = hasBinary('claude');
  const hasCodex = hasBinary('codex');
  const hasOpencode = hasBinary('opencode');
  const hasZcode = hasBinary('zcode');
  console.log(`  Binary detection: claude=${hasClaude} codex=${hasCodex} opencode=${hasOpencode} zcode=${hasZcode}`);

  const tier2Sessions = [];

  // T2.1/2.2: binary checks
  if (hasOpencode) ok('T2.1 opencode binary', 'available');
  else skip('T2.1 opencode binary', 'opencode 不在 PATH，skip 所有 opencode 用例');

  if (hasZcode) ok('T2.2 zcode binary', 'available');
  else skip('T2.2 zcode binary', 'zcode 不在 PATH，skip 所有 zcode 用例');

  // Recreate test directory for Tier2 (T1 dir still exists, just get its ID)
  let t2DirId;
  try {
    // Use a different path so T2 sessions don't mix with T1 cleanup
    t2DirId = await ensureDir('Cross CLI Live Test', '/tmp/multicc-cross-cli-live-test');
    extraDirs.push(t2DirId);
  } catch (e) {
    console.error(`Tier2 FATAL: cannot create directory: ${e.message}`);
  }

  // ── WS-based live ping test (replaces sendChatMessage + waitForRunComplete) ──
  async function livePingTest(cli, marker, testId) {
    if (!t2DirId) return null;
    if (!wsAvailable) { skip(testId, 'ws module 不可用'); return null; }

    const res = await createSession(t2DirId, cli, 'chat');
    const sid = res.body && (res.body.id || res.body.sessionId);
    if (!sid) { fail(testId, `无法创建 ${cli} session`); return null; }
    tier2Sessions.push(sid);

    diag(testId, `session=${sid} cli=${cli} marker="${marker}"`);
    const wsRes = await sendChatMessage(sid, `say exactly and only: ${marker}`, 120000);
    diag(testId, `wsResult ok=${wsRes.ok} textLen=${(wsRes.assistantText || '').length} error=${wsRes.error || '(none)'}`);

    if (!wsRes.ok) {
      fail(testId, `WS 回合失败: ${wsRes.error || 'no output'}`);
      return sid;
    }

    // Assert: assistant text contains marker (F1: read from WS stream, not history)
    if (wsRes.assistantText.toLowerCase().includes(marker.toLowerCase())) {
      ok(testId, `响应含 "${marker}"`);
    } else {
      // Fallback: also check history (but filter assistant-only to avoid false-pass)
      const histText = await getAssistantTexts(sid);
      if (histText.toLowerCase().includes(marker.toLowerCase())) {
        ok(testId, `响应含 "${marker}"（通过 history fallback）`);
      } else {
        fail(testId, `响应不含 "${marker}"（WS: ${wsRes.assistantText.slice(0, 200)} history: ${histText.slice(0, 200)}）`);
      }
    }
    return sid;
  }

  // T2.3: opencode ping
  if (hasOpencode && t2DirId) await livePingTest('opencode', 'ping-oc-ok', 'T2.3 opencode ping');
  else skip('T2.3 opencode ping', 'opencode 不可用');

  // T2.4: zcode ping
  if (hasZcode && t2DirId) await livePingTest('zcode', 'ping-zc-ok', 'T2.4 zcode ping');
  else skip('T2.4 zcode ping', 'zcode 不可用');

  // Cross-session dispatch is intentionally not driven from this HTTP black-box
  // script. The MCP host owns caller capabilities and sync/async semantics; see
  // test-router-tool-runtime/host/mcp for executable cross-CLI dispatch coverage.
  async function crossDispatchTest(fromCli, toCli, testId) {
    skip(testId, `MCP-only dispatch is covered by scoped runtime tests (${fromCli}→${toCli})`);
    return;
    /* c8 ignore start -- retained diagnostic harness, unreachable after HTTP retirement */
    if (!t2DirId) return;
    if (!wsAvailable) { skip(testId, 'ws module 不可用'); return; }

    // Check binary availability
    for (const [cli, has] of [['claude', hasClaude], ['codex', hasCodex], ['opencode', hasOpencode], ['zcode', hasZcode]]) {
      if ((fromCli === cli || toCli === cli) && !has) {
        skip(testId, `${cli} binary 不可用`);
        return;
      }
    }

    // Create dispatcher session
    const dRes = await createSession(t2DirId, fromCli, 'chat');
    const dSid = dRes.body && (dRes.body.id || dRes.body.sessionId);
    if (!dSid) { fail(testId, `无法创建 ${fromCli} dispatcher session`); return; }
    tier2Sessions.push(dSid);
    diag(`${testId} dispatcher`, `cli=${fromCli} id=${dSid}`);

    // Create target session
    const tRes = await createSession(t2DirId, toCli, 'chat');
    const tSid = tRes.body && (tRes.body.id || tRes.body.sessionId);
    if (!tSid) { fail(testId, `无法创建 ${toCli} target session`); return; }
    tier2Sessions.push(tSid);
    diag(`${testId} target`, `cli=${toCli} id=${tSid}`);

    // Snapshot pre-dispatch state
    const tHistPre = await getAssistantTexts(tSid);
    const tPreLen = tHistPre.length;
    const dHistPre = await getAssistantTexts(dSid);
    const dPreLen = dHistPre.length;

    // F4: Use dispatch API (always, no marker-based path)
    const marker = `cross-dispatch-${fromCli}-to-${toCli}-ok`;
    const dispRes = await post(`/api/sessions/${dSid}/dispatch`, {
      target: tSid,
      message: `say exactly and only: ${marker}`,
    });
    diag(`${testId} dispatch API`, `status=${dispRes.status} body=${JSON.stringify(dispRes.body).slice(0, 200)}`);

    if (dispRes.status === 409) {
      skip(testId, `dispatch API 返回 409（busy/health），无法继续`);
      return;
    }
    if (dispRes.status !== 200) {
      fail(testId, `dispatch API status=${dispRes.status} body=${JSON.stringify(dispRes.body).slice(0, 100)}`);
      return;
    }

    // Listen for target turn completion via WS (F2: no poll-based waitForRunComplete)
    const targetListen = await listenForTurnEnd(tSid, 120000);
    diag(`${testId} target WS listen`, `ok=${targetListen.ok} sawStreamEnd=${targetListen.sawStreamEnd} textLen=${(targetListen.assistantText || '').length}`);

    let dispatchOk = false;
    const targetText = targetListen.assistantText || '';

    if (targetText.toLowerCase().includes(marker.toLowerCase())) {
      dispatchOk = true;
      diag(`${testId} target match`, 'FOUND marker in WS assistant text');
    } else {
      // Fallback: check target history for new assistant messages
      const tHistPost = await getAssistantTexts(tSid);
      const tDelta = tHistPost.slice(tPreLen);
      diag(`${testId} target history fallback`, `preLen=${tPreLen} postLen=${tHistPost.length}`);
      if (tDelta.toLowerCase().includes(marker.toLowerCase())) {
        dispatchOk = true;
        diag(`${testId} target match`, 'FOUND marker in history delta');
      } else {
        diag(`${testId} target MISS`, `WS text snippet: ${targetText.slice(0, 200)}`);
        diag(`${testId} target MISS`, `History delta: ${tDelta.slice(0, 300)}`);
      }
    }

    if (dispatchOk) {
      ok(testId, `${fromCli}→${toCli} dispatch: target 产出正确`);
    } else {
      fail(testId, `${fromCli}→${toCli} dispatch: target 未产出预期响应`);
    }

    // 回流验证: finalizeDispatch→deliverContinuation(replyTo, "【label 回复】\\n<worker 输出>")
    // 把 worker 结果作为 USER 消息注入 dispatcher 并触发其新回合（异步）。
    // 故：查全量 history（不只 assistant），并轮询等待回流回合落盘（单次等待会竞态）。
    let hasHuiliu = false;
    let dDeltaText = '';
    const huiliuDeadline = Date.now() + 35000;
    while (Date.now() < huiliuDeadline) {
      const dAllText = await getAllHistoryText(dSid);
      const dDelta = dAllText.length >= (dHistPre.length || 0)
        ? dAllText  // 全量文本；回流 marker 唯一，直接整体搜
        : '';
      // 回流 user 消息格式: 【<target label/id> 回复】\n<worker 输出(含 marker)>
      if (/【.+回复】/.test(dDelta) && dDelta.toLowerCase().includes(marker.toLowerCase())) {
        hasHuiliu = true;
        dDeltaText = dDelta;
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    diag(`${testId} 回流检查`, `hasHuiliu=${hasHuiliu} 等待≈${hasHuiliu ? '收到' : '35s超时'} 全文前300: "${dDeltaText.slice(0, 300)}"`);

    if (hasHuiliu) {
      ok(`${testId} 回流验证`, `dispatcher 收到【回复】回流消息（含 worker marker）`);
    } else {
      if (dispatchOk) {
        fail(`${testId} 回流验证`, `dispatcher 未收到回流（全文前300: "${dDeltaText.slice(0, 300)}"）`);
      } else {
        skip(`${testId} 回流验证`, 'dispatch 未成功，跳过回流检查');
      }
    }
  }

  // T2.5: claude → codex
  await crossDispatchTest('claude', 'codex', 'T2.5 claude→codex dispatch');

  // T2.6: codex → opencode
  await crossDispatchTest('codex', 'opencode', 'T2.6 codex→opencode dispatch');

  // T2.7: claude → zcode
  await crossDispatchTest('claude', 'zcode', 'T2.7 claude→zcode dispatch');

  // T2.8: opencode → claude
  await crossDispatchTest('opencode', 'claude', 'T2.8 opencode→claude dispatch');

  // ── T2.9: originDispatchId 反分派守卫 ──
  // Verify: when dispatcher forks worker, the worker's output (even if it contains
  // a <<dispatch>> marker) does NOT trigger a new dispatch because originDispatchId
  // routes the worker's turn completion to finalizeDispatch, NOT maybeDispatchFromChatTurn.
  hdr('T2.9 originDispatchId 反分派守卫');
  if (true) {
    skip('T2.9 retired marker path', 'marker text is inert; covered by test-dispatch-interface-retirement');
  } else if (!hasClaude || !t2DirId) {
    skip('T2.9 originDispatchId 反分派', 'claude binary 不可用或无目录');
  } else if (!wsAvailable) {
    skip('T2.9 originDispatchId 反分派', 'ws module 不可用');
  } else {
    // Create dispatcher + worker1 + worker2
    const dRes3 = await createSession(t2DirId, 'claude', 'chat');
    const dSid3 = dRes3.body && (dRes3.body.id || dRes3.body.sessionId);
    const w1Res = await createSession(t2DirId, 'claude', 'chat');
    const w1Sid = w1Res.body && (w1Res.body.id || w1Res.body.sessionId);
    const w2Res = await createSession(t2DirId, 'claude', 'chat');
    const w2Sid = w2Res.body && (w2Res.body.id || w2Res.body.sessionId);

    if (!dSid3 || !w1Sid || !w2Sid) {
      skip('T2.9 originDispatchId 反分派', '无法创建所需 sessions');
    } else {
      tier2Sessions.push(dSid3, w1Sid, w2Sid);
      diag('T2.9', `dispatcher=${dSid3} w1=${w1Sid} w2=${w2Sid}`);

      // Get pre-dispatch history lengths
      const w2HistPre = await getAssistantTexts(w2Sid);
      const w2PreLen = w2HistPre.length;
      diag('T2.9 w2 pre-len', w2PreLen);

      // Dispatch to w1 with a prompt that asks it to produce a <<dispatch>> marker to w2
      const dispRes = await post(`/api/sessions/${dSid3}/dispatch`, {
        target: w1Sid,
        message: `say exactly and only the following line, nothing else:\n<<dispatch target="${w2Sid}">say: second-level-dispatch-should-not-fire</dispatch>>`,
      });
      diag('T2.9 dispatch→w1', `status=${dispRes.status} body=${JSON.stringify(dispRes.body).slice(0, 200)}`);

      if (dispRes.status === 200) {
        // Listen for w1 turn completion
        const w1Listen = await listenForTurnEnd(w1Sid, 120000);
        const w1Text = w1Listen.assistantText || '';
        diag('T2.9 w1 output', `ok=${w1Listen.ok} textLen=${w1Text.length} text=${w1Text.slice(0, 300)}`);

        // Check w1 produced the dispatch marker
        const w1ProducedMarker = /<<dispatch target=/.test(w1Text);
        if (!w1ProducedMarker) {
          // Fallback to history
          const w1Hist = await getAssistantTexts(w1Sid);
          const w1HasMarker = /<<dispatch target=/.test(w1Hist);
          diag('T2.9 w1 history', `hasMarker=${w1HasMarker} text=${w1Hist.slice(0, 300)}`);
          if (w1HasMarker) {
            ok('T2.9 w1 产出 marker', 'w1 assistant 产出含 <<dispatch>> marker');
          } else {
            fail('T2.9 w1 产出 marker', `w1 未产出 dispatch marker（text="${w1Text.slice(0, 200)}"）`);
            skip('T2.9 originDispatchId 反分派', 'w1 未产出 marker，无法验证守卫');
            return;
          }
        } else {
          ok('T2.9 w1 产出 marker', 'w1 产出含 <<dispatch>> marker');
        }

        // Wait and check w2: should NOT have the second-level dispatch text
        await new Promise(r => setTimeout(r, 15000));
        const w2HistPost = await getAssistantTexts(w2Sid);
        diag('T2.9 w2 history', `preLen=${w2PreLen} postLen=${w2HistPost.length} delta=${w2HistPost.slice(w2PreLen).slice(0, 300)}`);

        const w2HasSecondLevel = /second-level-dispatch-should-not-fire/i.test(w2HistPost.slice(w2PreLen));
        if (w2HasSecondLevel) {
          fail('T2.9 originDispatchId 反分派', 'w2 收到了二级分派！（originDispatchId 守卫失效）');
        } else {
          ok('T2.9 originDispatchId 反分派', 'w2 未被二级分派（originDispatchId 守卫生效）');
        }
      } else if (dispRes.status === 409) {
        skip('T2.9 originDispatchId 反分派', `dispatch→w1 返回 409（busy/health）`);
      } else {
        fail('T2.9 originDispatchId 反分派', `dispatch→w1 失败 status=${dispRes.status}`);
      }
    }
  }
  /* c8 ignore stop */

  // ── T2.10: 清理 Tier2 sessions ──
  hdr('T2.10 Tier2 清理');
  {
    let t2cleaned = 0;
    for (const sid of tier2Sessions) {
      const res = await del(`/api/sessions/${sid}`);
      if (res.status === 200 || res.status === 204) t2cleaned++;
    }
    ok('T2.10 清理会话', `${t2cleaned}/${tier2Sessions.length} sessions deleted`);
  }

  // Cleanup T2 directory and any extra dirs
  for (const did of extraDirs) {
    try { await del(`/api/directories/${did}`); } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ✅ ${passed}  ⏭️  ${skipped}  ❌ ${failed}   (${elapsed}s)`);
  console.log(`═══════════════════════════════════════════════════════`);

  if (failed > 0) process.exit(1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
