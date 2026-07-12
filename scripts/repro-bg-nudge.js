'use strict';
// Reproduction / regression harness for the background-completion-nudge dedup gap
// and its coalescing fix (src/bg-completion-coalescer.js, C1/C2).
//
// It drives a throwaway chat session end-to-end against a running multicc server:
//   - launches TWO abandoned bg tasks (Y1, Y2) that finish together while idle,
//   - launches ONE task X and pulls it synchronously via TaskOutput(block=true),
//   - then inspects the session HISTORY for injected 【后台任务完成】 nudges.
//
// The per-taskId dedup only suppresses X (the pulled task); Y1/Y2 are never
// pulled, so their completions still wake the session. What differs pre/post fix:
//   PRE-fix  (no coalescer): TWO separate 【后台任务完成】 messages — one wake turn each → SHAPE=separate
//   POST-fix (coalescer)   : ONE 【后台任务完成 ×2】 merged message               → SHAPE=coalesced
//
// Each run self-provisions a UNIQUE throwaway git dir so session ids are always
// fresh (a recycled id would otherwise read a prior run's transcript). It also
// records a baseline and only counts nudges that appear AFTER the prompt is sent.
//
// Usage:
//   node scripts/repro-bg-nudge.js [--base URL] [--variant bash|monitor] [--expect separate|coalesced]
//   node scripts/repro-bg-nudge.js --dir <existingDirId>   # skip provisioning, use a given dir

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const BASE = opt('base', 'http://127.0.0.1:3000');
const VARIANT = opt('variant', 'bash');
const EXPECT = opt('expect', '');
let DIR = opt('dir', '');
const MAX_WAIT_MS = 90000;
const STAMP = `${Date.now()}`.slice(-8);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { j = b; }
        (res.statusCode >= 400) ? reject(new Error(`${method} ${path} → ${res.statusCode}: ${String(b).slice(0, 200)}`)) : resolve(j);
      }); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function drivingPrompt(variant) {
  const launchY = (n) => variant === 'monitor'
    ? `用 Monitor 工具启动，command="sleep 25; echo DONE_${n}"（被放弃的对照任务，启动后彻底不管）`
    : `用 Bash 工具、run_in_background=true 执行：sleep 25 && echo "Y_DONE_${n}"（被放弃的对照任务，启动后彻底不管）`;
  return `【自动化测试脚本 · 严格机械执行，不要分析/解释】刻意设计的并发后台任务测试，严格按顺序：
步骤1（启动放弃任务 Y1）：${launchY(1)}
步骤2（启动放弃任务 Y2）：${launchY(2)}
步骤3（启动任务 X）：用 Bash 工具、run_in_background=true 执行：sleep 10 && echo "X_DONE"
步骤4：立刻用 TaskOutput 工具，task_id=<步骤3返回的 task_id>、block=true、timeout=60000，阻塞读取 X 的输出。
步骤5：拿到 X 输出后只回一行「X已完成，本轮结束」，立即结束本回合。
【铁律】：绝不要对 Y1/Y2 调用 TaskOutput、不要 sleep 等它们、不要再调用任何工具。本测试就是要让 Y1/Y2 在你空闲后各自完成。`;
}

// A nudge = a message whose text (after the 🔇 prefix) starts with 【后台任务完成
function nudgeTexts(history) {
  const msgs = history.messages || history.history || (Array.isArray(history) ? history : []);
  return msgs
    .map(m => (typeof (m.text ?? m.content) === 'string' ? (m.text ?? m.content) : ''))
    .filter(t => t.replace(/^🔇/, '').startsWith('【后台任务完成'));
}

async function provisionDir() {
  const p = `/tmp/multicc-bgnudge-${STAMP}`;
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  execSync('git init -q && git config user.email t@t.co && git config user.name t && echo bgtest > README.md && git add -A && git commit -qm init', { cwd: p });
  const d = await req('POST', '/api/directories', { name: `bgnudge${STAMP}`, path: p });
  console.log(`[repro] provisioned dir ${d.id} @ ${p}`);
  return { id: d.id, path: p };
}

(async () => {
  console.log(`[repro] base=${BASE} variant=${VARIANT} expect=${EXPECT || '(report only)'}`);
  let provisioned = null;
  if (!DIR) { provisioned = await provisionDir(); DIR = provisioned.id; }

  const created = await req('POST', `/api/directories/${DIR}/sessions`, { cli: 'claude', kind: 'chat', label: `repro-bgnudge-${VARIANT}` });
  const SID = created.id;
  console.log(`[repro] created session ${SID}`);

  const cleanup = async () => {
    try { await req('DELETE', `/api/sessions/${SID}`); console.log(`[repro] deleted session ${SID}`); } catch (e) { console.log(`[repro] session cleanup warn: ${e.message}`); }
    if (provisioned) {
      try { await req('DELETE', `/api/directories/${provisioned.id}`); } catch {}
      try { fs.rmSync(provisioned.path, { recursive: true, force: true }); } catch {}
    }
  };

  try {
    // Baseline: nudges already present (0 for a fresh dir; guards against recycled ids).
    let baseline = 0;
    try { baseline = nudgeTexts(await req('GET', `/api/sessions/${SID}/history`)).length; } catch {}
    if (baseline) console.log(`[repro] baseline nudges already present: ${baseline} (will ignore these)`);

    await req('POST', `/api/directories/${DIR}/memo/send`, { text: drivingPrompt(VARIANT), sessionId: SID });
    console.log(`[repro] driving prompt sent; waiting for Y1/Y2 to finish while idle...`);

    const t0 = Date.now();
    let nudges = [];
    while (Date.now() - t0 < MAX_WAIT_MS) {
      await sleep(2500);
      let hist; try { hist = await req('GET', `/api/sessions/${SID}/history`); } catch { continue; }
      nudges = nudgeTexts(hist).slice(baseline); // only nudges added after send
      const merged = nudges.filter(t => /×\d/.test(t)).length;
      process.stdout.write(`\r[repro] t+${Math.round((Date.now() - t0) / 1000)}s  new完成nudge=${nudges.length} (merged=${merged})   `);
      if (merged >= 1 || nudges.length >= 2) break;
    }
    console.log('');

    const merged = nudges.filter(t => /×\d/.test(t));
    const single = nudges.filter(t => !/×\d/.test(t));
    console.log(`[repro] RESULT: ${nudges.length} new 完成nudge(s) — merged(×N)=${merged.length}, single=${single.length}`);
    nudges.forEach((t, i) => console.log(`  nudge#${i + 1}: ${t.replace(/\n/g, ' ⏎ ').slice(0, 130)}`));

    // Y1/Y2 are the abandoned pair. Ignore an X nudge (notify-first race when X is
    // short) for the shape verdict — the fix is about the abandoned pair coalescing.
    let shape;
    if (merged.length >= 1) shape = 'coalesced';           // a ×N nudge only the coalescer emits
    else if (single.length >= 2) shape = 'separate';       // two+ un-merged nudges = pre-fix
    else if (nudges.length >= 1) shape = 'single';
    else shape = 'none';
    console.log(`[repro] SHAPE = ${shape}`);

    await cleanup();

    if (EXPECT) {
      if (shape === EXPECT) { console.log(`[repro] ✅ PASS: shape "${shape}" matches expected`); process.exit(0); }
      console.log(`[repro] ❌ FAIL: expected "${EXPECT}" but observed "${shape}"`); process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(`[repro] ERROR: ${e.message}`);
    await cleanup();
    process.exit(2);
  }
})();
