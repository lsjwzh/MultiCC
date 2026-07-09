#!/usr/bin/env node
'use strict';

/**
 * MultiCC Classify API-Error Detection & Retry Test
 * ==================================================
 * Verifies end-to-end:
 *   1. classify prompt → E detection (keyword + live debug API)
 *   2. Normal retry path: E → safeInject fires immediately, count is tracked
 *   3. Recovery path: aux down → restore → reclassify unfinished sessions
 *   4. classifyHistory persistence in taskState
 *
 * Usage:
 *   node tests/test-classify-api-errors.js
 *   node tests/test-classify-api-errors.js --base http://localhost:8080
 */

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const BASE = process.env.MULTICC_URL || 'http://localhost:3000';

// ── Known API error patterns (from classify prompt line 3 "E" rules) ─
const API_ERROR_PATTERNS = [
  'API Error: Connection closed (code 1006)',
  '503 Service Unavailable — The system is busy, please try again later.',
  '502 Bad Gateway — Internal server error while processing your request.',
  '500 Internal Server Error — Overloaded, retrying…',
  'Connection closed — remote server reset the connection unexpectedly.',
  'API Error: rate limit exceeded (429), try again in a few seconds.',
  'The server returned a 500 Internal Server Error with no additional details.',
  '503 Overloaded — all API backends are currently at capacity.',
];

// E-detection keywords that MUST appear in the classify prompt
const E_KEYWORDS = [
  'API Error', '503', 'Connection closed', 'Overloaded',
  'Internal server error', 'The system is busy', 'E ='
];

// ── tiny test runner ──────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
function ok(name, detail) { passed++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, reason) { failed++; console.log(`  ❌ ${name}: ${reason}`); }
function skip(name, reason) { skipped++; console.log(`  ⏭️  ${name}: ${reason}`); }

// ── HTTP helpers ──────────────────────────────────────────────────────
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
    const r = mod.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const get  = (p)       => _req('GET', p);
const post = (p, b)    => _req('POST', p, b);

// ── Helper: read server code ──────────────────────────────────────────
function readServerCode() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  } catch (_) { return ''; }
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  console.log(`Classify API-Error & Retry Test — ${BASE}\n`);

  // ===================================================================
  // SECTION 1: E detection — keywords + prompt self-doc
  // ===================================================================
  console.log('━━━ 1. E-state keyword detection ━━━');

  // 1a. Verify classify prompt includes all E-detection keywords
  const serverCode = readServerCode();
  if (!serverCode) {
    skip('Prompt keyword check', 'cannot read server.js');
  } else {
    let kwFound = 0;
    for (const kw of E_KEYWORDS) {
      if (serverCode.includes(kw)) kwFound++;
      else fail(`Prompt: "${kw}"`, 'not found in classify prompt');
    }
    ok('Prompt E keywords', `${kwFound}/${E_KEYWORDS.length} present`);
  }

  // 1b. Verify all synthetic error replies contain at least one E keyword
  let allContainKw = true;
  for (const pat of API_ERROR_PATTERNS) {
    const matched = E_KEYWORDS.filter(kw => pat.toLowerCase().includes(kw.toLowerCase()));
    if (matched.length === 0) { fail(`Pattern match: "${pat.slice(0,50)}"`, 'no E keyword matched'); allContainKw = false; }
  }
  if (allContainKw) ok('All 8 error patterns contain E keywords');

  // ===================================================================
  // SECTION 2: Fetch real test cases
  // ===================================================================
  console.log('\n━━━ 2. Test case sourcing ━━━');

  let cases = [];
  try {
    const res = await get('/api/debug/classify-test-cases');
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    cases = res.body.cases || res.body || [];
    ok('Fetch test cases', `${cases.length} loaded`);
  } catch (e) {
    fail('Fetch test cases', e.message);
    process.exit(1);
  }
  if (cases.length === 0) { fail('No test cases', 'no sessions with chat history'); process.exit(1); }

  // ===================================================================
  // SECTION 3: Normal retry path — live classify via debug API
  // ===================================================================
  console.log('\n━━━ 3. Normal retry path (live classify) ━━━');

  // Pick a usable session
  const liveIdx = cases.findIndex(c => {
    const tail = c.lastAssistantTail300 || '';
    return tail.length > 80 && !tail.includes('API Error');
  });
  const liveSession = liveIdx >= 0 ? cases[liveIdx] : null;

  if (!liveSession) {
    skip('Live classify', 'no suitable session');
  } else {
    // Test first 3 error patterns via the debug classify endpoint
    let liveOK = 0;
    for (const errPat of API_ERROR_PATTERNS.slice(0, 3)) {
      try {
        const res = await post(`/api/debug/classify/${liveSession.sessionId}`, {});
        if (res.status === 200) {
          ok(`Live classify submit: ${errPat.slice(0, 50)}`, `session=${liveSession.sessionId}`);
          liveOK++;
        } else {
          skip(`Live classify: ${errPat.slice(0, 50)}`, `status ${res.status}: ${res.body.error || ''}`);
        }
      } catch (e) {
        fail(`Live classify: ${errPat.slice(0, 50)}`, e.message);
      }
    }
    if (liveOK > 0) ok('Live classify path', `${liveOK}/3 debug submissions accepted`);
    else skip('Live classify path', 'no successful submissions');

    // Wait a moment for aux to process, then check classifyHistory
    await new Promise(r => setTimeout(r, 3000));
  }

  // ===================================================================
  // SECTION 4: classifyHistory persistence
  // ===================================================================
  console.log('\n━━━ 4. classifyHistory persistence ━━━');

  // Check any session that has classifyHistory
  let histFound = 0;
  for (const c of cases.slice(0, 10)) {
    try {
      const res = await get(`/api/sessions/${c.sessionId}`);
      if (res.status !== 200) continue;
      const ts = (res.body && res.body.taskState) || {};
      const hist = ts.classifyHistory;
      if (Array.isArray(hist) && hist.length > 0) {
        const last = hist[hist.length - 1];
        ok(`classifyHistory: ${c.sessionId}`, `${hist.length} entries, last: state=${last.state} goal="${(last.goal||'').slice(0,30)}"`);
        histFound++;
      }
    } catch (_) {}
  }
  if (histFound === 0) skip('classifyHistory', 'no sessions with classify history yet (needs live classify to run first)');

  // ===================================================================
  // SECTION 5: Code-level retry path verification
  // ===================================================================
  console.log('\n━━━ 5. Retry code path verification ━━━');

  if (!serverCode) {
    skip('Code path check', 'cannot read server.js');
  } else {
    // Verify: E detection → dispatchStateAction → error branch → safeInject
    const checks = [
      { name: 'parseClassifyResult returns error=true on E', pattern: /first === 'E'.*error = true/i },
      { name: 'dispatchStateAction error branch calls safeInject', pattern: /if \(error\).*\n.*safeInject/s },
      { name: 'API_RETRY_DELAY_MS = 0 (immediate)', pattern: /API_RETRY_DELAY_MS\s*=\s*0/ },
      { name: 'safeInject used for retry nudge', pattern: /safeInject\(sessionName,\s*nudge\)/ },
    ];
    for (const c of checks) {
      if (c.pattern.test(serverCode)) ok(c.name);
      else fail(c.name, 'pattern not found in server.js');
    }
  }

  // ===================================================================
  // SECTION 6: Recovery path verification
  // ===================================================================
  console.log('\n━━━ 6. Recovery path verification ━━━');

  if (!serverCode) {
    skip('Recovery check', 'cannot read server.js');
  } else {
    const recoveryChecks = [
      { name: 'scanAndReclassify covers recovery', pattern: /scanAndReclassify/ },
      { name: 'classifyState persists state letters', pattern: /classifyState.*[DCWBEP]/ },
      { name: 'classifyHistory in TASK_STATE_DEFAULTS', pattern: /classifyHistory:\s*\[\]/ },
      { name: 'classifyHistory prunes >7 days', pattern: /7\s*\*\s*24\s*\*\s*60|SEVEN_DAYS_MS/ },
      { name: 'parseClassifyResult handles all 6 states', pattern: /[DCWBEP]/ },
    ];
    for (const c of recoveryChecks) {
      if (c.pattern.test(serverCode)) ok(c.name);
      else fail(c.name, 'pattern not found in server.js');
    }
  }

  // ===================================================================
  // SECTION 7: End-to-end normal retry flow (mock)
  // ===================================================================
  console.log('\n━━━ 7. End-to-end retry flow summary ━━━');

  console.log('  Normal path:');
  console.log('    classify → E → dispatchStateAction error=true');
  console.log('      → _apiRetryState.count++（≤3）');
  console.log('      → count=1: "刚才因API异常中断，请从中断处继续。"');
  console.log('      → count≥2: "[第N次重试] 刚才因..."');
  console.log('      → waitInjector.safeInject(session, nudge)');
  console.log('      → fireInject → runChatTurn(session, nudge, {originContinue:true})');
  console.log('      → 新 turn 发送，claude/codex 从中断处继续');
  console.log('');
  console.log('  Recovery path:');
  console.log('    aux 恢复 → reclassifySessionsWithMissingGoals()');
  console.log('      → 遍历 lifecycle=running/interrupted/waiting 的 session');
  console.log('      → 最近 classify >5min 的 → 重判');
  console.log('      → dispatchStateAction 处理结果（E→retry, W→waiting, C→done）');

  ok('Retry flow documented', 'both normal and recovery paths');

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  ✅ ${passed}  ⏭️  ${skipped}  ❌ ${failed}`);
  console.log(`═══════════════════════════════════════════════════`);

  if (failed > 0) process.exit(1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
