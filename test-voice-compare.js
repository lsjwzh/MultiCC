'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// Allow self-signed certs for local WebCC server
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Load .env (same approach as server.js) ──
const envPath = path.join(__dirname, '.env');
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) {}

const WEBCC_BASE_URL = process.env.WEBCC_BASE_URL || 'https://localhost:3443';

// ── Parse CLI args ──
const args = process.argv.slice(2);
const sttOnly = args.includes('--stt-only');
const refineOnly = args.includes('--refine-only');
const limitIdx = args.indexOf('--limit');
const recordLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
// --mode voice_transcript  (filter by Typeless mode)
const modeIdx = args.indexOf('--mode');
const modeFilter = modeIdx !== -1 ? args[modeIdx + 1] : null;

// ── Load better-sqlite3 ──
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('错误: better-sqlite3 未安装。请运行: npm install better-sqlite3');
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Typeless/typeless.db');

// ═══════════════════════════════════════════════════════════════
//  Utility functions
// ═══════════════════════════════════════════════════════════════

/** Character-level similarity (Levenshtein-based) */
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const la = a.length, lb = b.length;
  if (la > 5000 || lb > 5000) {
    const wa = new Set(a.split(/\s+/));
    const wb = new Set(b.split(/\s+/));
    let intersection = 0;
    for (const w of wa) if (wb.has(w)) intersection++;
    const union = wa.size + wb.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }
  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[la][lb] / Math.max(la, lb);
}

/** Truncate string for display */
function truncate(s, maxLen = 80) {
  if (!s) return '(空)';
  const oneLine = s.replace(/\n/g, ' ↵ ');
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

/** Brief diff description between two strings */
function diffSummary(a, b) {
  if (!a || !b) return '其中一方为空';
  const sim = similarity(a, b);
  if (sim > 0.95) return '几乎完全一致';
  if (sim > 0.8) return '高度相似，细微差异（标点/大小写/空格）';
  if (sim > 0.6) return '中度相似，存在措辞/结构差异';
  if (sim > 0.3) return '差异较大，仅保留核心语义';
  return '差异显著';
}

// ═══════════════════════════════════════════════════════════════
//  STT: WebCC Whisper (POST /api/voice/stt, multipart)
// ═══════════════════════════════════════════════════════════════

async function webccWhisperSTT(audioPath) {
  const audioData = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).slice(1) || 'ogg';
  const mimeMap = { ogg: 'audio/ogg', webm: 'audio/webm', wav: 'audio/wav', mp3: 'audio/mpeg' };
  const mime = mimeMap[ext] || 'audio/ogg';

  const t0 = Date.now();
  const formData = new FormData();
  const blob = new Blob([audioData], { type: mime });
  formData.append('file', blob, path.basename(audioPath));

  const response = await fetch(`${WEBCC_BASE_URL}/api/voice/stt`, {
    method: 'POST',
    body: formData,
  });

  const latencyMs = Date.now() - t0;

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`WebCC STT ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  return { text: (data.text || '').trim(), latencyMs, serverMs: data.duration_ms || 0 };
}

// ═══════════════════════════════════════════════════════════════
//  Refine: Call WebCC /api/voice/refine (SSE)
// ═══════════════════════════════════════════════════════════════

async function webccRefine(rawText) {
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const url = new URL(`${WEBCC_BASE_URL}/api/voice/refine`);
    const postData = JSON.stringify({ raw: rawText });

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let buffer = '';
      let fullText = '';
      let firstTokenMs = null;

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              fullText += parsed.text;
            }
          } catch (_) {}
        }
      });

      res.on('end', () => {
        resolve({
          text: fullText.trim(),
          latencyMs: Date.now() - t0,
          firstTokenMs,
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`错误: Typeless 数据库未找到: ${DB_PATH}`);
    process.exit(1);
  }

  // ── Read Typeless DB ──
  const db = new Database(DB_PATH, { readonly: true });
  let rows = db.prepare(`
    SELECT id, refined_text, duration, mode, audio_local_path, created_at
    FROM history
    ORDER BY created_at DESC
  `).all();
  db.close();

  console.log(`\n读取到 ${rows.length} 条 Typeless 历史记录`);

  // Filter: must have audio file on disk and non-empty refined_text
  let validRows = rows.filter(r =>
    r.audio_local_path && fs.existsSync(r.audio_local_path) && r.refined_text
  );
  console.log(`有效记录（有音频文件 & 有文本）: ${validRows.length} 条`);

  if (modeFilter) {
    validRows = validRows.filter(r => r.mode === modeFilter);
    console.log(`模式过滤 (${modeFilter}): ${validRows.length} 条`);
  }

  const testRows = validRows.slice(0, recordLimit);
  console.log(`本次测试: ${testRows.length} 条${recordLimit < Infinity ? ` (--limit ${recordLimit})` : ''}`);

  // Separate by mode
  const transcriptRows = testRows.filter(r => r.mode === 'voice_transcript');
  const commandRows = testRows.filter(r => r.mode === 'voice_command');
  const translationRows = testRows.filter(r => r.mode === 'voice_translation');

  console.log(`  voice_transcript: ${transcriptRows.length} | voice_command: ${commandRows.length} | voice_translation: ${translationRows.length}`);

  if (commandRows.length > 0 || translationRows.length > 0) {
    console.log(`  ⚠ 注意: voice_command/voice_translation 的 refined_text 是 AI 生成内容而非纯转录，相似度仅供参考`);
  }

  const sttResults = [];
  const refineResults = [];

  // ═══════════════════════════════════════
  //  Test A: STT 对比 (WebCC Whisper vs Typeless)
  // ═══════════════════════════════════════
  if (!refineOnly) {
    console.log('\n' + '═'.repeat(60));
    console.log('  测试 A: STT 对比（WebCC Whisper vs Typeless）');
    console.log('═'.repeat(60));

    for (let i = 0; i < testRows.length; i++) {
      const row = testRows[i];
      const fileName = path.basename(row.audio_local_path);
      const fileSize = fs.statSync(row.audio_local_path).size;
      console.log(`\n[${i + 1}/${testRows.length}] ${fileName} (${row.duration}s, ${(fileSize / 1024).toFixed(0)}KB, ${row.mode})`);

      try {
        const result = await webccWhisperSTT(row.audio_local_path);
        const sim = similarity(result.text, row.refined_text);

        sttResults.push({
          id: row.id,
          fileName,
          duration: row.duration,
          mode: row.mode,
          typelessText: row.refined_text,
          whisperText: result.text,
          whisperLatency: result.latencyMs,
          whisperServerMs: result.serverMs,
          similarity: sim,
        });

        console.log(`  Whisper  (${result.latencyMs}ms, server ${result.serverMs}ms): ${truncate(result.text)}`);
        console.log(`  Typeless: ${truncate(row.refined_text)}`);
        console.log(`  相似度: ${(sim * 100).toFixed(1)}% — ${diffSummary(result.text, row.refined_text)}`);
      } catch (err) {
        console.error(`  ⚠ 错误: ${err.message}`);
        sttResults.push({
          id: row.id,
          fileName,
          duration: row.duration,
          mode: row.mode,
          typelessText: row.refined_text,
          whisperText: `[错误] ${err.message}`,
          whisperLatency: -1,
          whisperServerMs: -1,
          similarity: -1,
          error: err.message,
        });
      }
    }
  }

  // ═══════════════════════════════════════
  //  Test B: AI 润色对比 (WebCC refine)
  // ═══════════════════════════════════════
  if (!sttOnly) {
    console.log('\n' + '═'.repeat(60));
    console.log('  测试 B: 全链路 — Whisper STT → WebCC Refine');
    console.log('═'.repeat(60));

    // Use voice_transcript entries (pure transcription comparison is meaningful)
    const refineInput = transcriptRows.length > 0 ? transcriptRows : testRows.slice(0, 3);

    if (refineInput.length === 0) {
      console.log('\n  没有可用记录');
    } else {
      for (let i = 0; i < refineInput.length; i++) {
        const row = refineInput[i];
        const fileName = path.basename(row.audio_local_path);
        console.log(`\n[${i + 1}/${refineInput.length}] ${fileName} (${row.duration}s, ${row.mode})`);

        try {
          // Step 1: Whisper STT
          const stt = await webccWhisperSTT(row.audio_local_path);
          console.log(`  1) Whisper STT (${stt.latencyMs}ms): ${truncate(stt.text)}`);

          if (!stt.text) {
            console.log(`  ⚠ Whisper 无结果，跳过润色`);
            refineResults.push({
              id: row.id, duration: row.duration, mode: row.mode,
              whisperText: '', refineText: '', typelessText: row.refined_text,
              sttLatency: stt.latencyMs, refineLatency: -1, totalLatency: stt.latencyMs,
              error: 'Whisper 无结果',
            });
            continue;
          }

          // Step 2: WebCC Refine
          const refine = await webccRefine(stt.text);
          const totalMs = stt.latencyMs + refine.latencyMs;
          const simStt = similarity(stt.text, row.refined_text);
          const simRefine = similarity(refine.text, row.refined_text);

          refineResults.push({
            id: row.id,
            duration: row.duration,
            mode: row.mode,
            whisperText: stt.text,
            refineText: refine.text,
            typelessText: row.refined_text,
            sttLatency: stt.latencyMs,
            refineLatency: refine.latencyMs,
            refineFirstToken: refine.firstTokenMs,
            totalLatency: totalMs,
            simStt: simStt,
            simRefine: simRefine,
          });

          console.log(`  2) Refine  (${refine.latencyMs}ms, 首token ${refine.firstTokenMs}ms): ${truncate(refine.text)}`);
          console.log(`  Typeless:  ${truncate(row.refined_text)}`);
          console.log(`  相似度: STT ${(simStt * 100).toFixed(1)}% → Refine ${(simRefine * 100).toFixed(1)}% | 总耗时 ${totalMs}ms`);
        } catch (err) {
          console.error(`  ⚠ 错误: ${err.message}`);
          refineResults.push({
            id: row.id, duration: row.duration, mode: row.mode,
            whisperText: '', refineText: '', typelessText: row.refined_text,
            sttLatency: -1, refineLatency: -1, totalLatency: -1,
            error: err.message,
          });
        }
      }
    }
  }

  printReport(sttResults, refineResults);
}

// ═══════════════════════════════════════════════════════════════
//  Report
// ═══════════════════════════════════════════════════════════════

function printReport(sttResults, refineResults) {
  console.log('\n\n');
  console.log('═'.repeat(60));
  console.log('  WebCC Whisper vs Typeless 对比测试报告');
  console.log('═'.repeat(60));

  // ── STT Results ──
  if (sttResults.length > 0) {
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  STT 对比（WebCC Whisper vs Typeless refined_text）     │');
    console.log('└─────────────────────────────────────────────────────────┘');

    for (const r of sttResults) {
      console.log(`\n  ${r.fileName} (${r.duration}s, ${r.mode})`);
      if (r.error) {
        console.log(`    ⚠ ${r.error}`);
        continue;
      }
      console.log(`    Whisper:   ${truncate(r.whisperText, 100)}`);
      console.log(`    Typeless:  ${truncate(r.typelessText, 100)}`);
      console.log(`    相似度 ${(r.similarity * 100).toFixed(1)}% | 延迟 ${r.whisperLatency}ms (server ${r.whisperServerMs}ms)`);
    }

    const validStt = sttResults.filter(r => !r.error);
    if (validStt.length > 0) {
      const avgLatency = validStt.reduce((s, r) => s + r.whisperLatency, 0) / validStt.length;
      const avgServerMs = validStt.reduce((s, r) => s + r.whisperServerMs, 0) / validStt.length;
      const avgSim = validStt.reduce((s, r) => s + r.similarity, 0) / validStt.length;

      const modes = [...new Set(validStt.map(r => r.mode))];

      console.log('\n  ── STT 汇总 ──');
      console.log(`  Whisper 平均延迟: ${avgLatency.toFixed(0)}ms (server ${avgServerMs.toFixed(0)}ms)`);
      console.log(`  平均相似度: ${(avgSim * 100).toFixed(1)}%`);
      for (const mode of modes) {
        const mr = validStt.filter(r => r.mode === mode);
        const ms = mr.reduce((s, r) => s + r.similarity, 0) / mr.length;
        const ml = mr.reduce((s, r) => s + r.whisperLatency, 0) / mr.length;
        console.log(`    [${mode}] ${mr.length}条 | 相似度 ${(ms * 100).toFixed(1)}% | 延迟 ${ml.toFixed(0)}ms`);
      }
      console.log(`  成功/总数: ${validStt.length}/${sttResults.length}`);
    }
  }

  // ── Refine Results ──
  if (refineResults.length > 0) {
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  全链路: Whisper STT → WebCC Refine vs Typeless        │');
    console.log('└─────────────────────────────────────────────────────────┘');

    for (const r of refineResults) {
      console.log(`\n  ${r.id.slice(0, 8)} (${r.duration}s, ${r.mode})`);
      if (r.error) {
        console.log(`    ⚠ ${r.error}`);
        continue;
      }
      console.log(`    Whisper:   ${truncate(r.whisperText, 100)}`);
      console.log(`    Refined:   ${truncate(r.refineText, 100)}`);
      console.log(`    Typeless:  ${truncate(r.typelessText, 100)}`);
      console.log(`    相似度: STT ${(r.simStt * 100).toFixed(1)}% → Refine ${(r.simRefine * 100).toFixed(1)}% | STT ${r.sttLatency}ms + Refine ${r.refineLatency}ms = ${r.totalLatency}ms`);
    }

    const validRef = refineResults.filter(r => !r.error);
    if (validRef.length > 0) {
      const avgTotal = validRef.reduce((s, r) => s + r.totalLatency, 0) / validRef.length;
      const avgStt = validRef.reduce((s, r) => s + r.sttLatency, 0) / validRef.length;
      const avgRefine = validRef.reduce((s, r) => s + r.refineLatency, 0) / validRef.length;
      const avgSimStt = validRef.reduce((s, r) => s + r.simStt, 0) / validRef.length;
      const avgSimRef = validRef.reduce((s, r) => s + r.simRefine, 0) / validRef.length;

      console.log('\n  ── 全链路汇总 ──');
      console.log(`  平均耗时: STT ${avgStt.toFixed(0)}ms + Refine ${avgRefine.toFixed(0)}ms = 总计 ${avgTotal.toFixed(0)}ms`);
      console.log(`  相似度变化: STT ${(avgSimStt * 100).toFixed(1)}% → Refine ${(avgSimRef * 100).toFixed(1)}%`);
      console.log(`  成功/总数: ${validRef.length}/${refineResults.length}`);
    }
  }

  // ── Overall ──
  console.log('\n' + '═'.repeat(60));
  console.log('  总结');
  console.log('═'.repeat(60));

  const vs = sttResults.filter(r => !r.error);
  const vr = refineResults.filter(r => !r.error);

  if (vs.length > 0) {
    const avgSim = vs.reduce((s, r) => s + r.similarity, 0) / vs.length;
    const avgLat = vs.reduce((s, r) => s + r.whisperLatency, 0) / vs.length;
    console.log(`  STT:     ${vs.length} 条 | vs Typeless 相似度 ${(avgSim * 100).toFixed(1)}% | Whisper 延迟 avg ${avgLat.toFixed(0)}ms`);
  }
  if (vr.length > 0) {
    const avgTotal = vr.reduce((s, r) => s + r.totalLatency, 0) / vr.length;
    const avgSimR = vr.reduce((s, r) => s + r.simRefine, 0) / vr.length;
    console.log(`  全链路:  ${vr.length} 条 | vs Typeless 相似度 ${(avgSimR * 100).toFixed(1)}% | 总延迟 avg ${avgTotal.toFixed(0)}ms`);
  }
  if (vs.length === 0 && vr.length === 0) {
    console.log('  所有测试均失败，请检查 WebCC 服务是否运行 及 .env 配置。');
  }

  console.log('\n  用法: node test-voice-compare.js [--stt-only] [--refine-only] [--limit N] [--mode voice_transcript]');
  console.log('');
}

// ── Run ──
main().catch(err => {
  console.error('\n致命错误:', err);
  process.exit(1);
});
