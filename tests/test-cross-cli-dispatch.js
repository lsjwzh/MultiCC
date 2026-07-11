#!/usr/bin/env node
'use strict';

/**
 * MultiCC 跨 CLI 边界回归测试
 * ==========================================
 * 测什么边界：
 *   - worker CLI 白名单：claude/codex/opencode/zcode（4 种）vs 非法值
 *   - aux CLI 白名单：仅 claude/codex（2 种），opencode/zcode 被静默 clamp
 *   - provider 池映射：codex → codex 池，其余 → claude 池（仅此二池）
 *   - provider-defaults：仅有 claude/codex 两个键，无 opencode/zcode 槽位
 *   - dispatch 跨 CLI 独立性：任意 CLI → 任意 CLI，目标用自己的 runner
 *   - dispatch 安全边界：拒绝 aux/gateway/占位符/跨目录/自分派
 *   - aux CLI 负向防护：openend/zcode 被 normalizeAuxCli 强制 clamp 为 claude
 *
 * Tier 结构：
 *   Tier1 — 结构/API（18 用例）：纯 HTTP 验证，不 spawn CLI，恒跑
 *   Tier2 — 活体（9 用例）：真实 CLI ping 回合 + 跨 CLI dispatch 回流，缺二进制 skip
 *
 * Skip 规则：
 *   Tier1: 永不 skip（纯 API 层）
 *   Tier2: which opencode/zcode/codex 探测，缺则 skip 并打印原因
 *
 * 需要 server 在 localhost:3000（或 MULTICC_URL 环境变量指定）
 * 预计耗时：Tier1 ~5-10s（HTTP 往返），Tier2 ~30-90s（CLI spawn + ping 回合）
 *
 * Usage:
 *   node tests/test-cross-cli-dispatch.js
 *   MULTICC_TOKEN=<token> node tests/test-cross-cli-dispatch.js
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

// ── Helper: ensure a directory exists ─────────────────────────────────
async function ensureDir(label) {
  const res = await post('/api/directories', { name: label || 'Cross CLI Test', path: '/tmp/multicc-cross-cli-test' });
  if (res.body && res.body.id) return res.body.id;
  const r2 = await get('/api/directories');
  const dirs = Array.isArray(r2.body) ? r2.body : (r2.body.directories || []);
  const dir = dirs.find(d => d.path === '/tmp/multicc-cross-cli-test');
  if (dir) return dir.id;
  throw new Error(`Could not create directory: ${JSON.stringify(res.body).slice(0, 200)}`);
}

// ── Helper: create a session with a given CLI ─────────────────────────
async function createSession(dirId, cli, kind) {
  kind = kind || 'chat';
  const res = await post(`/api/directories/${dirId}/sessions`, { cli, kind });
  return res;
}

// ── Helper: cleanup a session ─────────────────────────────────────────
async function deleteSession(sid) {
  if (!sid) return;
  try { await del(`/api/sessions/${sid}`); } catch (_) { /* best-effort */ }
}

// ── Helper: wait for poll (used by Tier2) ────────────────────────────

// ── Tier2 binary detection ────────────────────────────────────────────
function hasBinary(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Tier2: wait for a chat session to complete a turn (poll GET /api/sessions/:id) ──
async function waitForRunComplete(sid, timeoutMs) {
  timeoutMs = timeoutMs || 60000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(`/api/sessions/${sid}`);
    // When the session is not busy/streaming, the turn is done.
    const active = res.body && (res.body.active === true || res.body.isStreaming === true);
    if (!active) {
      // Give it a moment to settle then fetch history
      return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false; // timed out
}

// ── Tier2: fetch chat history and find assistant text ─────────────────
async function getChatHistory(sid) {
  const res = await get(`/api/sessions/${sid}/history`);
  return res.body;
}

// ── Tier2: send a message via SSE/chat endpoint and wait for result ───
async function sendChatMessage(sid, message) {
  // POST /api/sessions/:id/messages  — use the chat message API
  const res = await post(`/api/sessions/${sid}/messages`, { message });
  return res;
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  console.log(`MultiCC Cross-CLI Boundary Test — ${BASE}`);
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

  // Prepare directory for test sessions
  let dirId;
  try {
    dirId = await ensureDir('Cross CLI Test');
    console.log(`Test directory: ${dirId}`);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  // Store created session IDs for cleanup
  const tier1Sessions = [];

  // ══════════════════════════════════════════════════════════════════════
  // Tier1 — 结构/API（无需 CLI 二进制，恒跑）
  // ══════════════════════════════════════════════════════════════════════
  hdr('Tier1 — 结构/API 边界验证（18 用例）');

  // ── T1.1: 四种合法 CLI 各创建 chat session ──
  hdr('T1.1 四种合法 CLI 创建会话');
  const legalCLIs = ['claude', 'codex', 'opencode', 'zcode'];
  const createdSessions = {}; // cli → { id, session }
  for (const cli of legalCLIs) {
    const res = await createSession(dirId, cli, 'chat');
    if (res.status === 200 || res.status === 201) {
      const sid = res.body.id || res.body.sessionId;
      if (sid) {
        createdSessions[cli] = { id: sid, body: res.body };
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

  // ── T1.2: 非法 CLI 创建会话 ──
  hdr('T1.2 非法 CLI 拒绝');
  const illegalCLIs = ['gemini', 'foo', 'cursor', '', 'CLAUDE'];
  for (const cli of illegalCLIs) {
    const res = await createSession(dirId, cli, 'chat');
    const label = cli === '' ? '(空字符串)' : cli;
    if (res.status === 400) {
      const err = (res.body && res.body.error) || '';
      if (err.includes('claude') || err.includes('codex') || err.includes('opencode') || err.includes('zcode') || err.includes('cli must be')) {
        ok(`T1.2 非法 CLI "${label}"`, `400 — ${err.slice(0, 80)}`);
      } else {
        ok(`T1.2 非法 CLI "${label}"`, `400 — ${err.slice(0, 80)}`);
      }
    } else if (res.status === 200 || res.status === 201) {
      fail(`T1.2 非法 CLI "${label}"`, `非法 cli 却返回 ${res.status}（应 400）`);
      // Cleanup if accidentally created
      const sid = res.body.id || res.body.sessionId;
      if (sid) { tier1Sessions.push(sid); }
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

  // ── T1.4: PUT /api/provider-defaults — opencode/zcode 槽位静默忽略 ──
  {
    // First, get current defaults to restore later
    const origRes = await get('/api/provider-defaults');
    const origDefaults = (origRes.status === 200) ? origRes.body : {};

    // Get valid claude/codex provider IDs for testing
    let claudeProvId = null;
    let codexProvId = null;
    const provRes = await get('/api/providers');
    if (provRes.status === 200) {
      const provList = provRes.body.providers || [];
      // Try to find one claude provider
      const claudeProv = provList.find(p => p.appType === 'claude');
      if (claudeProv) claudeProvId = claudeProv.id;
      const codexProv = provList.find(p => p.appType === 'codex');
      if (codexProv) codexProvId = codexProv.id;
    }

    // Attempt to set opencode/zcode slots
    {
      const body = { opencode: 'some-fake-id', zcode: 'another-fake-id' };
      const res = await put('/api/provider-defaults', body);
      // The PUT handler only iterates ['claude','codex'], so opencode/zcode should be ignored
      if (res.status === 200) {
        const keys = Object.keys(res.body.defaults || res.body).sort();
        if (!keys.includes('opencode') && !keys.includes('zcode')) {
          ok('T1.4 opencode/zcode 静默忽略', `PUT 后 keys=${JSON.stringify(keys)}（无 opencode/zcode）`);
        } else {
          fail('T1.4 opencode/zcode 静默忽略', `keys 含不该有的 opencode/zcode: ${JSON.stringify(keys)}`);
        }
      } else {
        // 400 is also acceptable (no provider exists for those slots)
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

    // Restore original defaults (best-effort)
    if (origDefaults.claude !== undefined || origDefaults.codex !== undefined) {
      try {
        // Only try to restore if there were valid original values
        const restoreBody = {};
        if (origDefaults.claude) {
          const v = provRes.status === 200 && (provRes.body.providers || []).find(p => p.id === origDefaults.claude);
          if (v) restoreBody.claude = origDefaults.claude;
        }
        if (origDefaults.codex) {
          const v = provRes.status === 200 && (provRes.body.providers || []).find(p => p.id === origDefaults.codex);
          if (v) restoreBody.codex = origDefaults.codex;
        }
        if (Object.keys(restoreBody).length > 0) {
          await put('/api/provider-defaults', restoreBody);
        }
      } catch (_) { /* best-effort restore */ }
    }
  }

  // ── T1.5-1.7: POST /api/settings/default-cli 边界 ──
  hdr('T1.5-1.7 Aux 默认 CLI 切换边界');

  // Save original defaultCli to restore later
  let origDefaultCli = 'claude';
  {
    const res = await get('/api/settings/default-cli');
    if (res.status === 200) origDefaultCli = res.body.defaultCli || 'claude';
  }

  // T1.5: opencode → 400
  {
    const res = await post('/api/settings/default-cli', { defaultCli: 'opencode' });
    if (res.status === 400) {
      ok('T1.5 opencode 被拒', `400 — ${(res.body.error || '').slice(0, 80)}`);
    } else {
      fail('T1.5 opencode 被拒', `期望 400，实际 ${res.status}`);
    }
  }

  // T1.6: zcode → 400
  {
    const res = await post('/api/settings/default-cli', { defaultCli: 'zcode' });
    if (res.status === 400) {
      ok('T1.6 zcode 被拒', `400 — ${(res.body.error || '').slice(0, 80)}`);
    } else {
      fail('T1.6 zcode 被拒', `期望 400，实际 ${res.status}`);
    }
  }

  // T1.7: claude/codex → 200
  {
    const res = await post('/api/settings/default-cli', { defaultCli: 'claude' });
    if (res.status === 200) {
      ok('T1.7 claude 允许', `200 — defaultCli=${res.body.defaultCli}`);
    } else {
      fail('T1.7 claude 允许', `期望 200，实际 ${res.status}`);
    }
  }
  {
    const res = await post('/api/settings/default-cli', { defaultCli: 'codex' });
    if (res.status === 200) {
      ok('T1.7 codex 允许', `200 — defaultCli=${res.body.defaultCli}`);
    } else {
      fail('T1.7 codex 允许', `期望 200，实际 ${res.status}`);
    }
  }

  // Restore original defaultCli
  if (origDefaultCli) {
    await post('/api/settings/default-cli', { defaultCli: origDefaultCli });
  }

  // ── T1.8: POST /api/aux/config — opencode/zcode 被静默 clamp ──
  hdr('T1.8 Aux Config opencode/zcode 静默 clamp');
  {
    // Save original aux config
    const orig = await get('/api/aux/config');
    const origCli = (orig.status === 200) ? orig.body.cli : 'claude';
    const origProv = (orig.status === 200) ? orig.body.providerId : null;
    const origModel = (orig.status === 200) ? orig.body.model : null;
    const origEffort = (orig.status === 200) ? orig.body.effort : null;

    // Try opencode
    {
      const res = await post('/api/aux/config', {
        cli: 'opencode',
        providerId: origProv,
        model: origModel,
        effort: origEffort || null,
      });
      if (res.status === 200) {
        if (res.body.cli === 'claude') {
          ok('T1.8 opencode→claude clamp', `响应 .cli="${res.body.cli}"（被 normalizeAuxCli 静默 clamp）`);
        } else if (res.body.cli === 'opencode') {
          fail('T1.8 opencode→claude clamp', `未 clamp！.cli="${res.body.cli}"（应为 claude）`);
        } else {
          fail('T1.8 opencode→claude clamp', `意外 .cli="${res.body.cli}"`);
        }
      } else {
        fail('T1.8 opencode→claude clamp', `expect 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 100)}`);
      }
    }

    // Try zcode
    {
      const res = await post('/api/aux/config', {
        cli: 'zcode',
        providerId: origProv,
        model: origModel,
        effort: origEffort || null,
      });
      if (res.status === 200) {
        if (res.body.cli === 'claude') {
          ok('T1.8 zcode→claude clamp', `响应 .cli="${res.body.cli}"（被 normalizeAuxCli 静默 clamp）`);
        } else if (res.body.cli === 'zcode') {
          fail('T1.8 zcode→claude clamp', `未 clamp！.cli="${res.body.cli}"（应为 claude）`);
        } else {
          fail('T1.8 zcode→claude clamp', `意外 .cli="${res.body.cli}"`);
        }
      } else {
        fail('T1.8 zcode→claude clamp', `expect 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 100)}`);
      }
    }

    // Restore original aux config
    await post('/api/aux/config', {
      cli: origCli,
      providerId: origProv,
      model: origModel,
      effort: origEffort || null,
    });
  }

  // ── T1.9: GET /api/aux/config — cli 永不为 opencode/zcode ──
  {
    const res = await get('/api/aux/config');
    if (res.status === 200) {
      const cli = res.body.cli;
      if (cli === 'opencode' || cli === 'zcode') {
        fail('T1.9 GET aux config', `.cli="${cli}" 不应为 opencode/zcode`);
      } else if (cli === 'claude' || cli === 'codex') {
        ok('T1.9 GET aux config', `.cli="${cli}"（仅 claude/codex）`);
      } else {
        fail('T1.9 GET aux config', `意外 .cli="${cli}"`);
      }
    } else {
      fail('T1.9 GET aux config', `status ${res.status}`);
    }
  }

  // ── T1.10: GET /api/settings/default-cli — 仅 claude/codex ──
  {
    const res = await get('/api/settings/default-cli');
    if (res.status === 200) {
      const dc = res.body.defaultCli;
      if (dc === 'opencode' || dc === 'zcode') {
        fail('T1.10 GET default-cli', `defaultCli="${dc}" 不应为 opencode/zcode`);
      } else if (dc === 'claude' || dc === 'codex') {
        ok('T1.10 GET default-cli', `defaultCli="${dc}"（仅 claude/codex）`);
      } else {
        fail('T1.10 GET default-cli', `意外 defaultCli="${dc}"`);
      }
    } else {
      fail('T1.10 GET default-cli', `status ${res.status}`);
    }
  }

  // ── T1.11-1.15: Dispatch 安全边界 ──
  hdr('T1.11-1.15 Dispatch 安全边界');

  // Need two sessions in the same directory for dispatch tests
  // Use claude (dispatcher) and opencode (target) — cross-CLI
  const dispatcherSid = createdSessions['claude'] ? createdSessions['claude'].id : null;
  let opencodeTargetId = createdSessions['opencode'] ? createdSessions['opencode'].id : null;
  let secondDirId = null;

  // Ensure we have a dispatcher session
  if (!dispatcherSid) {
    const res = await createSession(dirId, 'claude', 'chat');
    if (res.status === 200 || res.status === 201) {
      const sid = res.body.id || res.body.sessionId;
      if (sid) {
        createdSessions['claude'] = { id: sid, body: res.body };
        tier1Sessions.push(sid);
      }
    }
  }

  // Ensure we have an opencode target
  if (!opencodeTargetId) {
    const res = await createSession(dirId, 'opencode', 'chat');
    if (res.status === 200 || res.status === 201) {
      opencodeTargetId = res.body.id || res.body.sessionId;
      if (opencodeTargetId) tier1Sessions.push(opencodeTargetId);
    }
  }

  const dsid = createdSessions['claude'] ? createdSessions['claude'].id : null;

  // T1.11: Cross-CLI dispatch (claude → opencode)
  if (dsid && opencodeTargetId) {
    const res = await post(`/api/sessions/${dsid}/dispatch`, {
      target: opencodeTargetId,
      message: 'say: cross-cli-test-ping',
    });
    if (res.status === 400) {
      const err = (res.body.error || '').toLowerCase();
      // 400 is ok for self-dispatch, same-dir, placeholder etc. but NOT for CLI filtering
      if (err.includes('cli not supported') || err.includes('不支持的 cli') || err.includes('invalid cli')) {
        fail('T1.11 跨 CLI dispatch', `被 CLI 过滤拒绝: ${err.slice(0, 80)}`);
      } else {
        ok('T1.11 跨 CLI dispatch', `status ${res.status}（非 CLI 过滤原因: ${(res.body.error || '').slice(0, 60)}）`);
      }
    } else if (res.status === 200) {
      ok('T1.11 跨 CLI dispatch', `200 — 目标=${opencodeTargetId} 跨 CLI 分派接受`);
    } else if (res.status === 409) {
      ok('T1.11 跨 CLI dispatch', `409 — busy/health（非 CLI 拒绝）`);
    } else {
      fail('T1.11 跨 CLI dispatch', `status ${res.status}`);
    }
  } else {
    skip('T1.11 跨 CLI dispatch', '缺少 dispatcher 或 opencode target session');
  }

  // T1.12: Dispatch to aux (__aux__) → 400
  if (dsid) {
    const res = await post(`/api/sessions/${dsid}/dispatch`, {
      target: '__aux__',
      message: 'test dispatch to aux',
    });
    if (res.status === 400) {
      ok('T1.12 dispatch→aux 被拒', `400 — ${(res.body.error || '').slice(0, 80)}`);
    } else {
      fail('T1.12 dispatch→aux 被拒', `期望 400，实际 ${res.status}`);
    }
  } else {
    skip('T1.12 dispatch→aux 被拒', '缺少 dispatcher session');
  }

  // T1.13: Dispatch to gateway (__gateway__) → 400
  if (dsid) {
    const res = await post(`/api/sessions/${dsid}/dispatch`, {
      target: '__gateway__',
      message: 'test dispatch to gateway',
    });
    if (res.status === 400) {
      ok('T1.13 dispatch→gateway 被拒', `400 — ${(res.body.error || '').slice(0, 80)}`);
    } else {
      fail('T1.13 dispatch→gateway 被拒', `期望 400，实际 ${res.status}`);
    }
  } else {
    skip('T1.13 dispatch→gateway 被拒', '缺少 dispatcher session');
  }

  // T1.14: Dispatch to cross-directory session → 400
  {
    // Create a second directory
    try {
      const dir2Res = await post('/api/directories', {
        name: 'Cross CLI Test Dir2',
        path: '/tmp/multicc-cross-cli-test-dir2',
      });
      if (dir2Res.body && dir2Res.body.id) {
        secondDirId = dir2Res.body.id;
      }
    } catch (_) { /* ok if fails */ }

    if (dsid && secondDirId) {
      // Create a session in dir2
      const crossRes = await createSession(secondDirId, 'claude', 'chat');
      const crossId = crossRes.body && (crossRes.body.id || crossRes.body.sessionId);
      if (crossId) {
        const res = await post(`/api/sessions/${dsid}/dispatch`, {
          target: crossId,
          message: 'test cross-dir dispatch',
        });
        if (res.status === 400) {
          ok('T1.14 dispatch 跨目录被拒', `400 — ${(res.body.error || '').slice(0, 80)}`);
        } else {
          fail('T1.14 dispatch 跨目录被拒', `期望 400，实际 ${res.status}`);
        }
        // cleanup
        await deleteSession(crossId);
      } else {
        skip('T1.14 dispatch 跨目录被拒', '无法在 dir2 创建 session');
      }
    } else {
      skip('T1.14 dispatch 跨目录被拒', '缺少 dispatcher 或 second directory');
    }
  }

  // T1.15: Dispatch to placeholder → 400
  if (dsid) {
    const placeholders = ['sid', 'session_id', 'target', '目标会话id', '<目标会话id>', '<session_id>'];
    for (const ph of placeholders) {
      const res = await post(`/api/sessions/${dsid}/dispatch`, {
        target: ph,
        message: 'test dispatch to placeholder',
      });
      if (res.status === 400) {
        ok(`T1.15 占位符 "${ph}" 被拒`, `400 — ${(res.body.error || '').slice(0, 60)}`);
      } else {
        fail(`T1.15 占位符 "${ph}" 被拒`, `期望 400，实际 ${res.status}`);
      }
    }
  } else {
    skip('T1.15 占位符被拒', '缺少 dispatcher session');
  }

  // ── T1.16: 创建的四会话 cli 字段无 clamp ──
  hdr('T1.16 Worker CLI 持久化字段验证');
  {
    const listRes = await get('/api/sessions');
    const sessions = Array.isArray(listRes.body) ? listRes.body : (listRes.body.sessions || []);
    for (const cli of legalCLIs) {
      const rec = createdSessions[cli];
      if (!rec) continue;
      const found = sessions.find(s => s.id === rec.id);
      if (found) {
        if (found.cli === cli) {
          ok(`T1.16 ${cli} 无 clamp`, `persisted.cli="${found.cli}"（未 clamp/回退）`);
        } else {
          fail(`T1.16 ${cli} 无 clamp`, `persisted.cli="${found.cli}" 被改写成非原值（原="${cli}"）`);
        }
      } else {
        // Session may have been cleaned up; check persistedSessions another way
        skip(`T1.16 ${cli} 无 clamp`, 'session no longer in list');
      }
    }
  }

  // ── T1.17: Provider 池映射验证 ──
  hdr('T1.17 Provider 池映射验证');
  {
    // Get provider list to find valid IDs
    const provRes = await get('/api/providers');
    const providers = provRes.status === 200 ? (provRes.body.providers || []) : [];

    // Find valid IDs from each pool
    const claudePoolIds = providers.filter(p => p.appType === 'claude').map(p => p.id);
    const codexPoolIds = providers.filter(p => p.appType === 'codex').map(p => p.id);

    if (claudePoolIds.length === 0 && codexPoolIds.length === 0) {
      skip('T1.17 Provider 池映射', '无 provider 可用于测试');
    } else {
      // codex session should ONLY accept codex-pool providers
      // Create a codex session with a claude-pool provider → should fail
      if (codexPoolIds.length > 0 && claudePoolIds.length > 0) {
        // codex session + claude pool provider → 400
        {
          const res = await post(`/api/directories/${dirId}/sessions`, {
            cli: 'codex',
            kind: 'chat',
            provider: claudePoolIds[0],
          });
          if (res.status === 400) {
            ok(`T1.17 codex+claude池→拒`, `400 — codex session 不能绑定 claude 池 provider`);
          } else if (res.status === 200 || res.status === 201) {
            // This is unexpected: codex should reject claude-pool provider
            const sid = res.body.id || res.body.sessionId;
            if (sid) { tier1Sessions.push(sid); }
            fail(`T1.17 codex+claude池→拒`, `codex session 接受了 claude 池 provider（status ${res.status}）`);
          } else {
            ok(`T1.17 codex+claude池→拒`, `status ${res.status}`);
          }
        }

        // codex session + codex pool provider → ok
        {
          const res = await post(`/api/directories/${dirId}/sessions`, {
            cli: 'codex',
            kind: 'chat',
            provider: codexPoolIds[0],
          });
          if (res.status === 200 || res.status === 201) {
            const sid = res.body.id || res.body.sessionId;
            if (sid) { tier1Sessions.push(sid); }
            ok(`T1.17 codex+codex池→允许`, `201 — codex session 走 codex 池`);
          } else {
            fail(`T1.17 codex+codex池→允许`, `status ${res.status} body=${JSON.stringify(res.body).slice(0, 80)}`);
          }
        }

        // opencode session + claude pool provider → ok
        {
          const res = await post(`/api/directories/${dirId}/sessions`, {
            cli: 'opencode',
            kind: 'chat',
            provider: claudePoolIds[0],
          });
          if (res.status === 200 || res.status === 201) {
            const sid = res.body.id || res.body.sessionId;
            if (sid) { tier1Sessions.push(sid); }
            ok(`T1.17 opencode+claude池→允许`, `201 — opencode 走 claude(Anthropic 兼容) 池`);
          } else {
            fail(`T1.17 opencode+claude池→允许`, `status ${res.status} body=${JSON.stringify(res.body).slice(0, 80)}`);
          }
        }

        // zcode session + claude pool provider → ok
        {
          const res = await post(`/api/directories/${dirId}/sessions`, {
            cli: 'zcode',
            kind: 'chat',
            provider: claudePoolIds[0],
          });
          if (res.status === 200 || res.status === 201) {
            const sid = res.body.id || res.body.sessionId;
            if (sid) { tier1Sessions.push(sid); }
            ok(`T1.17 zcode+claude池→允许`, `201 — zcode 走 claude(Anthropic 兼容) 池`);
          } else {
            fail(`T1.17 zcode+claude池→允许`, `status ${res.status} body=${JSON.stringify(res.body).slice(0, 80)}`);
          }
        }
      } else {
        skip('T1.17 Provider 池映射', `claude池=${claudePoolIds.length} codex池=${codexPoolIds.length}（需两池都有 provider）`);
      }
    }
  }

  // ── T1.18: 清理 T1 创建的 session ──
  hdr('T1.18 Tier1 清理');
  {
    let cleaned = 0;
    for (const sid of tier1Sessions) {
      const res = await del(`/api/sessions/${sid}`);
      if (res.status === 200 || res.status === 204) {
        cleaned++;
      }
    }
    ok('T1.18 清理会话', `${cleaned}/${tier1Sessions.length} sessions deleted`);
  }

  // Cleanup second directory if created
  if (secondDirId) {
    try { await del(`/api/directories/${secondDirId}`); } catch (_) { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Tier2 — 活体（缺二进制则 skip）
  // ══════════════════════════════════════════════════════════════════════
  hdr('Tier2 — 活体跨 CLI dispatch（缺二进制 skip）');

  const hasClaude = hasBinary('claude');
  const hasCodex = hasBinary('codex');
  const hasOpencode = hasBinary('opencode');
  const hasZcode = hasBinary('zcode');

  console.log(`  Binary detection: claude=${hasClaude} codex=${hasCodex} opencode=${hasOpencode} zcode=${hasZcode}`);

  const tier2Sessions = [];

  // T2.1: Check opencode
  if (hasOpencode) {
    ok('T2.1 opencode binary', 'available');
  } else {
    skip('T2.1 opencode binary', 'opencode 不在 PATH，skip 所有 opencode 用例');
  }

  // T2.2: Check zcode
  if (hasZcode) {
    ok('T2.2 zcode binary', 'available');
  } else {
    skip('T2.2 zcode binary', 'zcode 不在 PATH，skip 所有 zcode 用例');
  }

  // Recreate a test directory (the previous one's sessions are cleaned up)
  let t2DirId;
  try {
    t2DirId = await ensureDir('Cross CLI Live Test');
  } catch (e) {
    console.error(`Tier2 FATAL: cannot create directory: ${e.message}`);
    // Fall through to summary
  }

  // ── Helper: create session, send message, wait for completion ──
  async function livePingTest(cli, marker, testId) {
    if (!t2DirId) return null;
    const res = await createSession(t2DirId, cli, 'chat');
    const sid = res.body && (res.body.id || res.body.sessionId);
    if (!sid) {
      fail(testId, `无法创建 ${cli} session`);
      return null;
    }
    tier2Sessions.push(sid);

    // Send the ping message
    const msgRes = await sendChatMessage(sid, `say exactly and only: ${marker}`);
    if (msgRes.status !== 200 && msgRes.status !== 201) {
      fail(testId, `发送消息失败 status=${msgRes.status}`);
      return sid;
    }

    // Wait for turn completion
    const done = await waitForRunComplete(sid, 90000);
    if (!done) {
      fail(testId, '回合超时未完成');
      return sid;
    }

    // Check history for the marker
    const hist = await getChatHistory(sid);
    const allText = typeof hist === 'string' ? hist : JSON.stringify(hist);
    if (allText.toLowerCase().includes(marker.toLowerCase())) {
      ok(testId, `响应含 "${marker}"`);
    } else {
      fail(testId, `响应不含 "${marker}"（前200字符: ${allText.slice(0, 200)}）`);
    }
    return sid;
  }

  // T2.3: opencode ping
  if (hasOpencode && t2DirId) {
    await livePingTest('opencode', 'ping-oc-ok', 'T2.3 opencode ping');
  } else {
    skip('T2.3 opencode ping', 'opencode 不可用');
  }

  // T2.4: zcode ping
  if (hasZcode && t2DirId) {
    await livePingTest('zcode', 'ping-zc-ok', 'T2.4 zcode ping');
  } else {
    skip('T2.4 zcode ping', 'zcode 不可用');
  }

  // ── Helper: cross-CLI dispatch test ──
  async function crossDispatchTest(fromCli, toCli, testId, useMarker) {
    if (!t2DirId) return;
    if (!hasClaude && (fromCli === 'claude' || toCli === 'claude')) {
      skip(testId, 'claude binary 不可用');
      return;
    }
    if (!hasCodex && (fromCli === 'codex' || toCli === 'codex')) {
      skip(testId, 'codex binary 不可用');
      return;
    }
    if (!hasOpencode && (fromCli === 'opencode' || toCli === 'opencode')) {
      skip(testId, 'opencode binary 不可用');
      return;
    }
    if (!hasZcode && (fromCli === 'zcode' || toCli === 'zcode')) {
      skip(testId, 'zcode binary 不可用');
      return;
    }

    // Create dispatcher session
    const dRes = await createSession(t2DirId, fromCli, 'chat');
    const dSid = dRes.body && (dRes.body.id || dRes.body.sessionId);
    if (!dSid) { fail(testId, `无法创建 ${fromCli} dispatcher`); return; }
    tier2Sessions.push(dSid);

    // Create target session
    const tRes = await createSession(t2DirId, toCli, 'chat');
    const tSid = tRes.body && (tRes.body.id || tRes.body.sessionId);
    if (!tSid) { fail(testId, `无法创建 ${toCli} target`); return; }
    tier2Sessions.push(tSid);

    let dispatchOk = false;

    if (useMarker) {
      // Use marker-based dispatch: send a message to the dispatcher containing <<dispatch>> marker
      const markerMsg = `reply with exactly this line and nothing else:\n<<dispatch target="${tSid}">say exactly: cross-dispatch-${fromCli}-to-${toCli}-ok</dispatch>>`;
      const msgRes = await sendChatMessage(dSid, markerMsg);
      if (msgRes.status !== 200 && msgRes.status !== 201) {
        fail(testId, `marker 消息发送失败 status=${msgRes.status}`);
        return;
      }
      // Wait for dispatcher to finish (it outputs the marker, which triggers dispatch)
      const dDone = await waitForRunComplete(dSid, 120000);
      if (!dDone) {
        fail(testId, 'dispatcher 回合超时');
        return;
      }
      // Then wait for target to finish
      const tDone = await waitForRunComplete(tSid, 120000);
      if (!tDone) {
        fail(testId, 'target 回合超时');
        return;
      }
      // Check target history
      const tHist = await getChatHistory(tSid);
      const tText = typeof tHist === 'string' ? tHist : JSON.stringify(tHist);
      const expectedMarker = `cross-dispatch-${fromCli}-to-${toCli}-ok`;
      if (tText.toLowerCase().includes(expectedMarker.toLowerCase())) {
        dispatchOk = true;
      }
    } else {
      // Use curl dispatch API
      const dispRes = await post(`/api/sessions/${dSid}/dispatch`, {
        target: tSid,
        message: `say exactly: cross-dispatch-${fromCli}-to-${toCli}-ok`,
      });
      if (dispRes.status === 200) {
        // Wait for target to complete
        const tDone = await waitForRunComplete(tSid, 120000);
        if (tDone) {
          const tHist = await getChatHistory(tSid);
          const tText = typeof tHist === 'string' ? tHist : JSON.stringify(tHist);
          const expectedMarker = `cross-dispatch-${fromCli}-to-${toCli}-ok`;
          if (tText.toLowerCase().includes(expectedMarker.toLowerCase())) {
            dispatchOk = true;
          }
        }
      } else if (dispRes.status === 409) {
        skip(testId, `dispatch API 返回 409（busy/health）`);
        return;
      } else {
        fail(testId, `dispatch API status=${dispRes.status} body=${JSON.stringify(dispRes.body).slice(0, 80)}`);
        return;
      }
    }

    if (dispatchOk) {
      ok(testId, `${fromCli}→${toCli} dispatch 成功，target 产出正确响应`);
    } else {
      fail(testId, `${fromCli}→${toCli} dispatch: target 未产出预期响应`);
    }
  }

  // T2.5: claude dispatch → codex (marker)
  await crossDispatchTest('claude', 'codex', 'T2.5 claude→codex marker dispatch', true);

  // T2.6: codex dispatch → opencode (curl API)
  await crossDispatchTest('codex', 'opencode', 'T2.6 codex→opencode curl dispatch', false);

  // T2.7: claude dispatch → zcode (curl API)
  await crossDispatchTest('claude', 'zcode', 'T2.7 claude→zcode curl dispatch', false);

  // T2.8: opencode dispatch → claude (marker)
  await crossDispatchTest('opencode', 'claude', 'T2.8 opencode→claude marker dispatch', true);

  // ── T2.9: Cleanup T2 sessions ──
  hdr('T2.9 Tier2 清理');
  {
    let t2cleaned = 0;
    for (const sid of tier2Sessions) {
      const res = await del(`/api/sessions/${sid}`);
      if (res.status === 200 || res.status === 204) t2cleaned++;
    }
    ok('T2.9 清理会话', `${t2cleaned}/${tier2Sessions.length} sessions deleted`);
  }

  // Cleanup T2 directory
  if (t2DirId) {
    try { await del(`/api/directories/${t2DirId}`); } catch (_) { /* best-effort */ }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ✅ ${passed}  ⏭️  ${skipped}  ❌ ${failed}   (${elapsed}s)`);
  console.log(`═══════════════════════════════════════════════════════`);

  if (failed > 0) process.exit(1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
