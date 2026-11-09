#!/usr/bin/env node
'use strict';
// Development-only migration inventory. The preload observes an isolated
// server's router after readiness; it never mounts endpoints or reads bodies.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

function installCapture() {
  const file = process.env.MULTICC_ROUTE_CAPTURE_FILE;
  if (process.env.NODE_ENV !== 'test' || !file) throw new Error('route capture requires an isolated test process');
  const { assertTestDir } = require('../src/paths');
  assertTestDir(file);
  const express = require('express');
  const http = require('node:http');
  const sourceKey = Symbol('route source');
  function source() {
    for (const line of new Error().stack.split('\n')) {
      if (!line.includes(ROOT + path.sep) || line.includes('node_modules') || line.includes(__filename)) continue;
      const match = line.slice(line.indexOf(ROOT + path.sep)).match(/^(.*):(\d+):\d+\)?$/);
      if (match) return `${path.relative(ROOT, match[1]).split(path.sep).join('/')}:${match[2]}`;
    }
    return 'dynamic/unknown';
  }
  for (const target of [express.application, express.Router]) {
    const original = target.route;
    target.route = function (...args) {
      const at = source();
      const route = Reflect.apply(original, this, args);
      route[sourceKey] ||= at;
      return route;
    };
  }
  const applications = new Set();
  function snapshot() {
    const routes = [], middleware = [];
    function walk(stack, mounts = [], ancestors = new Set()) {
      if (!Array.isArray(stack) || ancestors.has(stack)) return;
      const nextAncestors = new Set([...ancestors, stack]);
      for (let order = 0; order < stack.length; order++) {
        const layer = stack[order];
        if (layer.route) {
          const serializePath = value => value instanceof RegExp ? value.toString()
            : Array.isArray(value) ? value.map(serializePath) : value;
          routes.push({ mounts, order, path: serializePath(layer.route.path),
            methods: Object.keys(layer.route.methods).map(v => v.toUpperCase()),
            source: layer.route[sourceKey] || 'dynamic/unknown',
            handlers: layer.route.stack.map(v => v.name || '(anonymous)') });
        } else {
          const mount = layer.regexp?.toString() || '';
          middleware.push({ mounts, order, name: layer.name || '(anonymous)', mount, errorHandler: layer.handle?.length === 4 });
          walk(layer.handle?.stack, [...mounts, mount], nextAncestors);
        }
      }
    }
    for (const app of applications) walk(app._router?.stack);
    fs.writeFileSync(file, JSON.stringify({ routes, middleware }), { mode: 0o600 });
  }
  const createServer = http.createServer;
  http.createServer = function (...args) {
    for (const candidate of args) if (typeof candidate === 'function' && typeof candidate.use === 'function') applications.add(candidate);
    const server = Reflect.apply(createServer, this, args);
    server.on('request', (req, res) => {
      if (req.url === '/readyz') res.once('finish', () => { if (res.statusCode === 200) snapshot(); });
    });
    return server;
  };
}

async function capture() {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const net = require('node:net');
  const { assertTestDir } = require('../src/paths');
  const { sourcePaths, probeAddon } = require('./rust-source-cache');
  const { fingerprint, prebuiltDir } = sourcePaths(ROOT);
  const binaryDir = path.join(prebuiltDir, `${process.platform}-${process.arch}`);
  const addon = path.join(binaryDir, 'multicc_core.node');
  if (!probeAddon(addon)) throw new Error('Build the current native sources before capturing routes');
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-route-capture-')));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const file = path.join(root, 'router.json');
  const probe = net.createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
    ACCESS_TOKEN: 'inventory-isolated-fixture', MULTICC_DATA_DIR: dataDir,
    MULTICC_RUST_ADDON: addon, MULTICC_RUST_PREBUILT_DIR: prebuiltDir,
    MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    MULTICC_ROUTE_CAPTURE_FILE: file, NODE_OPTIONS: `--require ${JSON.stringify(__filename)}` };
  for (const key of ['MULTICC_GATEWAY_CHILD', 'MULTICC_GATEWAY_INTERNAL_PORT', 'MULTICC_GATEWAY_PID']) delete env[key];
  const child = spawn(path.join(binaryDir, process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway'),
    ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated gateway exited before capture');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.status === 200 && fs.existsSync(file)) { ready = true; break; }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('isolated server did not produce a ready router snapshot');
    const { routes, middleware } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!routes.some(r => r.path === '/readyz') || routes.length < 100) throw new Error('incomplete runtime capture');
    if (routes.some(r => !r.mounts.length && ['/login', '/logout', '/api/auth/exchange', '/api/auth/ws-ticket'].includes(r.path))) {
      throw new Error('gateway authentication routes unexpectedly remain mounted in Express');
    }
    const escape = value => String(value).replaceAll('|', '\\|').replaceAll('`', "'").replace(/[\r\n]/g, ' ');
    const result = [
      '# Remaining Node runtime registrations', '',
      'Generated by `node scripts/capture-backend-routes.js` against a real isolated gateway + server.js startup with an empty data root and `NODE_ENV=test`. No production configuration/data was changed.', '',
      `Native source fingerprint: \`${fingerprint}\`. Captured ${routes.length} route registrations and ${middleware.length} middleware/router layers in runtime order. Automatic HEAD/OPTIONS are implied by the Express contract and are not separate registrations.`, '',
      'This is the default startup profile, not complete feature coverage. Plugins, configured channels, conditional adapters and late mounts still require separate profiles. Regex mount chains are retained verbatim instead of guessed as URL strings; middleware and ordering are part of the exit contract. Raw WebSocket upgrades, message dispatch and SSE lifecycle behavior must be reconciled separately. A captured route remains unfinished until Rust owns its handler and dependencies.', '',
      '| Source | Methods | Route | Parent mounts | Handlers |', '|---|---|---|---|---|',
      ...routes.map(r => `| ${escape(r.source)} | ${r.methods.join(', ')} | ${escape(JSON.stringify(r.path))} | ${escape(r.mounts.join(' → '))} | ${escape(r.handlers.join(', '))} |`), '',
      '## Middleware and router order', '',
      '| Parent mounts | Position | Name | Mount expression | Error handler |', '|---|---|---|---|---|',
      ...middleware.map(r => `| ${escape(r.mounts.join(' → '))} | ${r.order} | ${escape(r.name)} | ${escape(r.mount)} | ${r.errorHandler} |`), '',
    ];
    const target = path.join(ROOT, 'docs/backend-runtime-inventory.md');
    fs.writeFileSync(target, result.join('\n'));
    console.log(JSON.stringify({ fingerprint, routes: routes.length, middleware: middleware.length, output: path.relative(ROOT, target) }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) capture().catch(error => { console.error(error.message); process.exitCode = 1; });
else installCapture();
