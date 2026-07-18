'use strict';
/**
 * multicc integration test
 * Usage:  node test.js           (auto-detects running server)
 *         node test.js --no-ws   (skip WebSocket test)
 *         node test.js --live-ai (include tests that call the configured Aux model)
 *         npm test
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const http  = require('http');
const https = require('https');
const WebSocket = require('ws');

const SKIP_WS     = process.argv.includes('--no-ws');
const RUN_LIVE_AI = process.argv.includes('--live-ai') || process.env.RUN_LIVE_AI_TESTS === '1';
const TIMEOUT_WS  = 20_000;

/* ── tiny test runner ──────────────────────────────────────────────── */
let passed = 0, failed = 0, skipped = 0;
const results = [];

function ok(name)           { passed++; results.push({ ok: true,  name }); }
function fail(name, reason) { failed++; results.push({ ok: false, name, reason }); }
function skip(name, reason) { skipped++; results.push({ ok: null, name, reason }); }

function check(name, fn) {
  try { fn(); ok(name); }
  catch (e) { fail(name, e.message); }
}

async function checkAsync(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { fail(name, e.message); }
}

/* ── helpers ───────────────────────────────────────────────────────── */
function resolveClaude() {
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;
  const extraDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    '/usr/local/bin', '/opt/homebrew/bin',
  ];
  for (const dir of extraDirs) {
    const p = path.join(dir, 'claude');
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync("zsh -l -c 'which claude 2>/dev/null'", { encoding: 'utf8', timeout: 5000 })
      .trim().split('\n')[0];
  } catch (_) {}
  return 'claude';
}

function detectServer() {
  const certPath = path.join(__dirname, 'cert.pem');
  const keyPath  = path.join(__dirname, 'key.pem');
  const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const port     = process.env.PORT || (useHttps ? 3443 : 3000);
  const proto    = useHttps ? 'https' : 'http';
  const wsProto  = useHttps ? 'wss'   : 'ws';
  return { proto, wsProto, port };
}

function httpRequest(url, { method = 'GET', body, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (process.env.MULTICC_TOKEN) {
      headers.Authorization = `Bearer ${process.env.MULTICC_TOKEN}`;
    }
    const req = lib.request(url, { method, headers, rejectUnauthorized: false }, res => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function httpGet(url) {
  return httpRequest(url, { timeout: 5000 });
}

function serverIsUp(proto, port) {
  return httpGet(`${proto}://localhost:${port}/api/sessions`)
    .then(r => r.status === 200)
    .catch(() => false);
}

/* ── main ──────────────────────────────────────────────────────────── */
(async () => {

  /* 1. STATIC CHECKS */
  console.log('\n── Static checks ──────────────────────────────────────────');

  const CLAUDE_CMD = resolveClaude();
  check('claude binary found', () => {
    if (!CLAUDE_CMD || !fs.existsSync(CLAUDE_CMD))
      throw new Error(`not found (tried: ${CLAUDE_CMD})`);
  });

  check('claude binary is executable', () => {
    const stat = fs.statSync(CLAUDE_CMD);
    if (!(stat.mode & 0o111)) throw new Error(`not executable: ${CLAUDE_CMD}`);
  });

  /* 2. WEBSOCKET INTEGRATION TEST */
  if (SKIP_WS) {
    console.log('\n── WebSocket test (skipped via --no-ws) ───────────────────');
  } else {
    console.log('\n── WebSocket integration test ─────────────────────────────');
    const { proto, wsProto, port } = detectServer();
    const isUp = await serverIsUp(proto, port);

    if (!isUp) {
      console.log(`  ⚠  Server not running on ${proto}://localhost:${port}`);
      console.log('     Run "npm start" in another terminal then re-run to include WS test.');
    } else {
      await checkAsync('GET /api/sessions returns 200', async () => {
        const r = await httpGet(`${proto}://localhost:${port}/api/sessions`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      });

      await checkAsync('WebSocket: persisted terminal gets session_id + PTY output', async () => {
        const baseUrl = `${proto}://localhost:${port}`;
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ws-test-'));
        let dirId = null;

        try {
          const dirRes = await httpRequest(`${baseUrl}/api/directories`, {
            method: 'POST',
            body: { name: `WS integration ${process.pid}`, path: testDir, create: true },
            timeout: 30_000,
          });
          if (dirRes.status !== 200 || !dirRes.json?.id) {
            throw new Error(`could not create test directory: HTTP ${dirRes.status} ${dirRes.body}`);
          }
          dirId = dirRes.json.id;

          const sessionRes = await httpRequest(`${baseUrl}/api/directories/${dirId}/sessions`, {
            method: 'POST',
            body: { cli: 'claude', kind: 'terminal', label: 'WS integration terminal' },
            timeout: 30_000,
          });
          if (sessionRes.status !== 200 || !sessionRes.json?.id) {
            throw new Error(`could not create terminal session: HTTP ${sessionRes.status} ${sessionRes.body}`);
          }
          const expectedSessionId = sessionRes.json.id;
          const token = process.env.MULTICC_TOKEN
            ? `&token=${encodeURIComponent(process.env.MULTICC_TOKEN)}`
            : '';

          await new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${wsProto}://localhost:${port}/?id=${encodeURIComponent(expectedSessionId)}${token}`,
              { rejectUnauthorized: false }
            );
            let gotSessionId = false;
            let settled = false;

            const finish = (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (error) {
                ws.terminate();
                reject(error);
              } else {
                ws.close();
                resolve();
              }
            };

            const timer = setTimeout(() => {
              finish(new Error(
                gotSessionId
                  ? `session ${expectedSessionId} attached but no PTY output within ${TIMEOUT_WS / 1000}s`
                  : `no session_id within ${TIMEOUT_WS / 1000}s`
              ));
            }, TIMEOUT_WS);

            ws.on('error', e => finish(e));
            ws.on('close', () => {
              if (!settled) finish(new Error('WebSocket closed before PTY output'));
            });
            ws.on('message', raw => {
              if (settled) return;
              let msg;
              try { msg = JSON.parse(raw.toString()); } catch { return; }

              if (msg.type === 'error') {
                return finish(new Error(`server error: ${msg.data}`));
              }
              if (msg.type === 'session_id') {
                if (msg.id !== expectedSessionId) {
                  return finish(new Error(`expected session ${expectedSessionId}, got ${msg.id}`));
                }
                gotSessionId = true;
                console.log(`    session_id received: ${msg.id}`);
                ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
                return;
              }
              if (msg.type === 'output' && msg.data) {
                console.log(`    first output: ${JSON.stringify(msg.data.slice(0, 60))}...`);
                finish();
              }
            });
          });
        } finally {
          if (dirId) {
            try {
              await httpRequest(`${baseUrl}/api/directories/${dirId}?force=1`, {
                method: 'DELETE', timeout: 30_000,
              });
            } catch (error) {
              console.log(`    cleanup warning: ${error.message}`);
            }
          }
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      });
    }
  }

  /* 3. VOICE API INTEGRATION TESTS */
  console.log('\n── Voice API integration tests ────────────────────────────');
  {
    const { proto, port } = detectServer();
    const isUp = await serverIsUp(proto, port);

    if (!isUp) {
      console.log('  Server not running, skipping voice API tests');
    } else {

      function readSSEStream(res, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
          const events = [];
          let buf = '';
          const rawChunks = [];
          const timer = setTimeout(() => {
            res.destroy();
            reject(new Error(`SSE stream timeout after ${timeoutMs / 1000}s. Events so far: ${JSON.stringify(events)}. Raw chunks: ${rawChunks.join('')}`));
          }, timeoutMs);

          res.on('data', (chunk) => {
            const text = chunk.toString();
            rawChunks.push(text);
            console.log(`    [sse-reader] chunk (${text.length} bytes): ${JSON.stringify(text.slice(0, 150))}`);
            buf += text;
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                events.push({ type: 'done' });
              } else {
                try {
                  const parsed = JSON.parse(payload);
                  events.push({ type: 'data', ...parsed });
                } catch (e) {
                  events.push({ type: 'parse_error', raw: payload, error: e.message });
                }
              }
            }
          });

          res.on('end', () => {
            clearTimeout(timer);
            console.log(`    [sse-reader] stream ended. Total events: ${events.length}`);
            resolve(events);
          });

          res.on('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`SSE stream error: ${e.message}. Events so far: ${JSON.stringify(events)}`));
          });
        });
      }

      function assertVoiceJsonResponse(response, { requireText = false } = {}) {
        if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}`);
        if (!response.headers['content-type']?.includes('application/json')) {
          throw new Error(`Expected application/json, got: ${response.headers['content-type']}`);
        }
        if (!response.json || typeof response.json.ok !== 'boolean') {
          throw new Error(`Missing boolean ok field: ${response.body}`);
        }
        if (typeof response.json.text !== 'string') {
          throw new Error(`Missing string text field: ${response.body}`);
        }
        if (typeof response.json.ms !== 'number' || response.json.ms < 0) {
          throw new Error(`Missing non-negative ms field: ${response.body}`);
        }
        if (requireText && (!response.json.ok || !response.json.text.trim())) {
          throw new Error(`Voice refine failed or returned empty text: ${response.body}`);
        }
      }

      // The dedicated transport fixture remains SSE; /api/voice/refine is JSON.
      await checkAsync('SSE test endpoint streams 3 chunks + [DONE]', async () => {
        const res = await new Promise((resolve, reject) => {
          const lib = proto === 'https' ? https : http;
          const headers = process.env.MULTICC_TOKEN
            ? { Authorization: `Bearer ${process.env.MULTICC_TOKEN}` }
            : {};
          lib.get(`${proto}://localhost:${port}/api/voice/test-sse`, {
            headers, rejectUnauthorized: false,
          }, resolve)
            .on('error', reject);
        });

        if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}`);
        if (!res.headers['content-type']?.includes('text/event-stream')) {
          throw new Error(`Expected text/event-stream, got: ${res.headers['content-type']}`);
        }

        const events = await readSSEStream(res, 10000);
        console.log(`    Events received: ${JSON.stringify(events)}`);

        const dataEvents = events.filter(e => e.type === 'data');
        const doneEvents = events.filter(e => e.type === 'done');
        if (dataEvents.length !== 3) throw new Error(`Expected 3 data events, got ${dataEvents.length}`);
        if (doneEvents.length !== 1) throw new Error(`Expected 1 [DONE] event, got ${doneEvents.length}`);
      });

      await checkAsync('Voice refine: empty input returns deterministic JSON', async () => {
        const response = await httpRequest(`${proto}://localhost:${port}/api/voice/refine`, {
          method: 'POST', body: { raw: '' }, timeout: 5000,
        });
        assertVoiceJsonResponse(response);
        if (!response.json.ok || response.json.text !== '' || response.json.ms !== 0) {
          throw new Error(`Unexpected empty-input response: ${response.body}`);
        }
      });

      await checkAsync('Voice refine: response is one valid JSON document', async () => {
        const response = await httpRequest(`${proto}://localhost:${port}/api/voice/refine`, {
          method: 'POST', body: { raw: '   ' }, timeout: 5000,
        });
        assertVoiceJsonResponse(response);
        if (!response.body.trim().startsWith('{') || response.body.includes('data: ')) {
          throw new Error(`Unexpected wire format: ${JSON.stringify(response.body)}`);
        }
      });

      if (RUN_LIVE_AI) {
        await checkAsync('Voice refine: live input returns refined JSON text', async () => {
          console.log('    Sending live voice refine request...');
          const response = await httpRequest(`${proto}://localhost:${port}/api/voice/refine`, {
            method: 'POST', body: { raw: '帮我检查一下 git status' }, timeout: 90_000,
          });
          assertVoiceJsonResponse(response, { requireText: true });
          console.log(`    Refined text: ${JSON.stringify(response.json.text.slice(0, 200))}`);
        });

        await checkAsync('Voice refine: concurrent live requests complete through the queue', async () => {
          console.log('    Sending 2 concurrent requests...');
          const [response1, response2] = await Promise.all([
            httpRequest(`${proto}://localhost:${port}/api/voice/refine`, {
              method: 'POST', body: { raw: '第一个请求' }, timeout: 120_000,
            }),
            httpRequest(`${proto}://localhost:${port}/api/voice/refine`, {
              method: 'POST', body: { raw: '第二个请求' }, timeout: 120_000,
            }),
          ]);
          assertVoiceJsonResponse(response1, { requireText: true });
          assertVoiceJsonResponse(response2, { requireText: true });
        });
      } else {
        skip('Voice refine: live input returns refined JSON text', 'enable with --live-ai or RUN_LIVE_AI_TESTS=1');
        skip('Voice refine: concurrent live requests complete through the queue', 'enable with --live-ai or RUN_LIVE_AI_TESTS=1');
      }
    }
  }

  /* SUMMARY */
  console.log('\n── Results ────────────────────────────────────────────────');
  for (const r of results) {
    if (r.ok === true) {
      console.log(`  ✓  ${r.name}`);
    } else if (r.ok === null) {
      console.log(`  -  ${r.name} (skipped: ${r.reason})`);
    } else {
      console.log(`  ✗  ${r.name}`);
      console.log(`       → ${r.reason}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);

})();
