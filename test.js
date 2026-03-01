'use strict';
/**
 * webcc integration test
 * Usage:  node test.js           (auto-detects running server)
 *         node test.js --no-ws   (skip WebSocket test)
 *         npm test
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const http  = require('http');
const https = require('https');
const WebSocket = require('ws');
const pty  = require('node-pty');

const SKIP_WS     = process.argv.includes('--no-ws');
const TIMEOUT_PTY = 20_000;
const TIMEOUT_WS  = 20_000;

/* ── tiny test runner ──────────────────────────────────────────────── */
let passed = 0, failed = 0;
const results = [];

function ok(name)           { passed++; results.push({ ok: true,  name }); }
function fail(name, reason) { failed++; results.push({ ok: false, name, reason }); }

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
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

  const spawnHelper = path.join(
    __dirname,
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
  );

  check('spawn-helper exists', () => {
    if (!fs.existsSync(spawnHelper)) throw new Error(`not found: ${spawnHelper}`);
  });

  check('spawn-helper is executable', () => {
    const stat = fs.statSync(spawnHelper);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(spawnHelper, 0o755);
      console.log('    (auto-fixed: chmod +x spawn-helper)');
    }
  });

  check('node-pty native module loads', () => { require('node-pty'); });

  const CLAUDE_CMD = resolveClaude();
  check('claude binary found', () => {
    if (!CLAUDE_CMD || !fs.existsSync(CLAUDE_CMD))
      throw new Error(`not found (tried: ${CLAUDE_CMD})`);
  });

  check('claude binary is executable', () => {
    const stat = fs.statSync(CLAUDE_CMD);
    if (!(stat.mode & 0o111)) throw new Error(`not executable: ${CLAUDE_CMD}`);
  });

  /* 2. PTY SPAWN TEST */
  console.log('\n── PTY spawn test ─────────────────────────────────────────');

  await checkAsync('claude spawns in PTY and produces output', () =>
    new Promise((resolve, reject) => {
      let proc;
      const timer = setTimeout(() => {
        try { proc && proc.kill(); } catch (_) {}
        reject(new Error(`no output within ${TIMEOUT_PTY / 1000}s`));
      }, TIMEOUT_PTY);

      try {
        proc = pty.spawn(CLAUDE_CMD, [], {
          name: 'xterm-256color',
          cols: 120, rows: 30,
          cwd: os.homedir(),
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
      } catch (e) {
        clearTimeout(timer);
        return reject(e);
      }

      proc.onData(() => {
        clearTimeout(timer);
        try { proc.kill(); } catch (_) {}
        resolve();
      });

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode !== 0 && exitCode !== null)
          reject(new Error(`claude exited immediately with code ${exitCode}`));
        else
          resolve();
      });
    })
  );

  /* 3. WEBSOCKET INTEGRATION TEST */
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

      await checkAsync('WebSocket: new session gets session_id + PTY output', () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsProto}://localhost:${port}`, {
            rejectUnauthorized: false,
          });
          let gotSessionId = false;
          let sessionId = null;

          const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error(
              gotSessionId
                ? `session ${sessionId} created but no PTY output within ${TIMEOUT_WS / 1000}s`
                : `no session_id within ${TIMEOUT_WS / 1000}s`
            ));
          }, TIMEOUT_WS);

          ws.on('error', e => { clearTimeout(timer); reject(e); });

          ws.on('message', raw => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'error') {
              clearTimeout(timer);
              ws.terminate();
              return reject(new Error(`server error: ${msg.data}`));
            }
            if (msg.type === 'session_id') {
              gotSessionId = true;
              sessionId = msg.id;
              console.log(`    session_id received: ${sessionId}`);
              return;
            }
            if (msg.type === 'output' && msg.data) {
              clearTimeout(timer);
              console.log(`    first output: ${JSON.stringify(msg.data.slice(0, 60))}…`);
              ws.close();
              // clean up test session
              if (sessionId) {
                const lib = proto === 'https' ? https : http;
                const req = lib.request(
                  { hostname: 'localhost', port, path: `/api/sessions/${sessionId}`, method: 'DELETE', rejectUnauthorized: false },
                  () => {}
                );
                req.on('error', () => {});
                req.end();
              }
              resolve();
            }
          });
        })
      );
    }
  }

  /* SUMMARY */
  console.log('\n── Results ────────────────────────────────────────────────');
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓  ${r.name}`);
    } else {
      console.log(`  ✗  ${r.name}`);
      console.log(`       → ${r.reason}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);

})();
