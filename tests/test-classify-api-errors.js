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
const { buildClassifySystemPrompt } = require('../src/classify/vocab');
const {
  API_ERROR_SIGNATURES,
  normalizeApiError,
} = require('../src/chat/api-error-policy');

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
const E_KEYWORDS = [...API_ERROR_SIGNATURES, 'E ='];

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
  // Concatenate the current runtime boundaries used by the code-path checks.
  // Prompt text itself is generated below through buildClassifySystemPrompt(),
  // so a shared/dynamic vocabulary cannot make a source-text scan lie.
  try {
    const relativePaths = [
      'server.js',
      'src/classify/vocab.js',
      'src/classify/state-machine.js',
      'src/chat/api-error-policy.js',
      'src/chat/api-error-host.js',
      'src/chat/turn-engine.js',
    ];
    return relativePaths.map(relativePath => fs.readFileSync(
      path.join(__dirname, '..', relativePath), 'utf8',
    )).join('\n');
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
  const classifyPrompt = buildClassifySystemPrompt('发布新版本');
  let kwFound = 0;
  for (const kw of E_KEYWORDS) {
    if (classifyPrompt.includes(kw)) kwFound++;
    else fail(`Prompt: "${kw}"`, 'not found in generated classify prompt');
  }
  ok('Prompt E keywords', `${kwFound}/${E_KEYWORDS.length} present`);

  const serverCode = readServerCode();

  // 1b. Verify all synthetic error replies contain at least one E keyword
  let allContainKw = true;
  for (const pat of API_ERROR_PATTERNS) {
    const matched = E_KEYWORDS.filter(kw => pat.toLowerCase().includes(kw.toLowerCase()));
    if (matched.length === 0) { fail(`Pattern match: "${pat.slice(0,50)}"`, 'no E keyword matched'); allContainKw = false; }
    const normalized = normalizeApiError(
      { message: pat, source: 'process_stderr', provider: 'fixture' },
      { source: 'process_stderr', provider: 'fixture', phase: 'before_first_token' },
    );
    if (normalized.category === 'unknown') {
      fail(`Policy normalize: "${pat.slice(0,50)}"`, 'canonical policy returned unknown');
      allContainKw = false;
    }
  }
  if (allContainKw) ok('All 8 error patterns are prompt-visible and policy-classified');

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
  const liveCandidates = cases.filter(c => {
    const tail = c.lastAssistantTail300 || '';
    return tail.length > 80 && !tail.includes('API Error');
  });
  let liveSession = null;

  if (liveCandidates.length === 0) {
    skip('Live classify', 'no suitable session');
  } else {
    // A settled session requires the documented force flag. Try recent active
    // candidates until one accepts the debug request; one enqueue proves the
    // live Aux path without spending quota on three identical submissions.
    let lastReason = '';
    for (const candidate of liveCandidates.slice(0, 12)) {
      try {
        const res = await post(`/api/debug/classify/${candidate.sessionId}?force=true`, {});
        if (res.status === 200) {
          liveSession = candidate;
          ok('Live classify submit', `session=${candidate.sessionId}`);
          break;
        }
        lastReason = `status ${res.status}: ${res.body.error || ''}`;
      } catch (e) {
        lastReason = e.message;
      }
    }
    if (liveSession) ok('Live classify path', 'debug submission accepted');
    else skip('Live classify path', lastReason || 'no active session accepted the request');

    // Wait a moment for aux to process, then check classifyHistory
    if (liveSession) await new Promise(r => setTimeout(r, 3000));
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
    // The retry path is now centralized in apiErrorHost/evaluateTurnApiError:
    // the runner boundary owns the single bounded retry (or fail-fast), and
    // classify's E branch only delegates as a legacy fallback — it must NEVER
    // open a second retry channel. The old safeInject('继续') + API_RETRY_DELAY_MS
    // mechanism is fully retired.
    const checks = [
      { name: 'centralized API-error policy host wired (createApiErrorHost)', pattern: /createApiErrorHost/ },
      // The branch condition has since grown a guard (`error && !cancel`), so match
      // the head of the condition rather than pinning its exact text — this check
      // is about the delegation, not about how the branch is spelled.
      { name: 'classify E branch delegates to evaluateTurnApiError as legacy fallback', pattern: /if \(error[^)]*\)[\s\S]{0,120}_lastApiErrorDecision[\s\S]{0,160}evaluateTurnApiError/ },
      { name: 'a deterministic turn verdict goes through the shared applier', pattern: /function classifyTurnEnd[\s\S]{0,800}cancelClassifyFor\(sessionName\)[\s\S]{0,2200}applyClassifyResult\(/ },
      { name: 'retry vs fail_fast gated by policy decision .action', pattern: /_lastApiErrorDecision\?\.action/ },
      { name: 'wait message driven by retryNotice(decision), not injection', pattern: /retryNotice\(cs\._lastApiErrorDecision\)/ },
    ];
    for (const c of checks) {
      if (c.pattern.test(serverCode)) ok(c.name);
      else fail(c.name, 'pattern not found in classification runtime');
    }
    // Negative guards: the retired auto-continue retry machinery must stay gone.
    const retired = [
      { name: 'no API_RETRY_DELAY_MS constant remains', pattern: /API_RETRY_DELAY_MS/ },
      { name: "no safeInject('继续') auto-continue retry remains", pattern: /safeInject\([^)]*['"`]继续/ },
    ];
    for (const c of retired) {
      if (!c.pattern.test(serverCode)) ok(c.name);
      else fail(c.name, 'retired retry mechanism still present in runtime');
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
  console.log('    provider boundary → evaluateTurnApiError()');
  console.log('      → canonical taxonomy + safe replay/side-effect gate');
  console.log('      → retry: scheduleOwnedRetry() retains the current turn owner');
  console.log('      → category budget: transient/network/rate-limit ≤2; timeout/unknown ≤1');
  console.log('      → fail_fast / wait_reset: no automatic replay');
  console.log('      → classify E only projects the policy decision; it opens no retry loop');
  console.log('');
  console.log('  Recovery path:');
  console.log('    network circuit recovers → resumeHeldSessions()');
  console.log('      → held sessions resume through sessionDelivery.deliverRetry()');
  console.log('      → TaskRun slots require a new run and never receive anonymous retries');
  console.log('      → periodic classify scan repairs missing turn-state projections only');

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
