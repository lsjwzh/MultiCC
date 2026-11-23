'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, token } = require('./production-entry');

const headers = { 'x-access-token': token, 'x-request-id': 'update-test', 'x-correlation-id': 'update-test',
  'accept-encoding': 'identity' };
const update = '__MULTICC_UPDATE_';
const steps = [
  update + 'START__ 2026-11-10T12:00:00Z force=1 target=v3.1',
  update + 'PLAN__ download install download INVALID',
  update + 'STEP__ download start 100',
  update + 'STEP__ download progress 101 123% ' + 'a'.repeat(74) + '🚀',
];
const cases = [
  ['idle', null, 'idle'],
  ['download', steps.join('\n'), 'running'],
  ['stalled', steps.join('\r\n'), 'stale'],
  ['failed', [...steps, update + 'STEP__ download done 102', update + 'STEP__ install skip 103 已安装',
    '10%\r60%\r100%', update + 'EXIT__ 120'].join('\n'), 'failed'],
  ['retry', [...steps, update + 'EXIT__ 2', 'ok', update + 'EXIT__ 0'].join('\n'), 'succeeded'],
  ['long', [...steps, 'x'.repeat(36000) + '😀' + 'z'.repeat(8191), update + 'EXIT__ 0'].join('\n'), 'succeeded'],
  ['invalid step time', update + 'STEP__ deps start ' + '9'.repeat(40), 'stale'],
  ['truncated plan', [update + 'PLAN__ download', 'x'.repeat(36000),
    update + 'STEP__ deps start ' + '9'.repeat(40)].join('\n'), 'unknown'],
];
const fixed = new Date('2026-01-01T00:00:00.123Z');

async function sample(dir, gateway, addon, reference, kind, relativeData) {
  const standalone = kind === 'standalone';
  fs.mkdirSync(dir, { recursive: true });
  // Exercise the launcher's on-disk detection; neither dummy file is executed.
  for (const rel of ['launcher/standalone-cli.js', process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node']) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  const environment = kind === 'git' ? {} : { MULTICC_DESKTOP: '1', MULTICC_DESKTOP_SHELL: standalone ? '' : '1' };
  if (relativeData) environment.MULTICC_DATA_DIR = '../unused/../data';
  const server = await start(dir, gateway, addon, reference, false, undefined, environment);
  const results = [];
  try {
    const filename = path.join(dir, standalone ? 'data' : 'package', 'logs/update.log');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    for (const [label, content, expected] of cases) {
      if (content !== null) {
        fs.writeFileSync(filename, content);
        const modified = expected === 'running' ? new Date() : fixed;
        fs.utimesSync(filename, modified, modified);
      }
      const url = server.origin + '/api/update/status';
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, label);
      const data = await response.json();
      assert.equal(data.state, expected, label);
      assert.equal(data.kind, kind, label);
      assert.equal(data.scheduled, false, label);
      if (expected === 'unknown') {
        assert.deepEqual(data, { state: 'unknown', running: false, exitCode: null, tail: '', scheduled: false, kind });
        results.push(data);
        continue;
      }
      assert.equal(fs.realpathSync(path.dirname(data.logPath)), fs.realpathSync(path.dirname(filename)));
      assert.equal(path.basename(data.logPath), 'update.log');
      assert.equal(data.logPath, path.normalize(data.logPath));
      data.logPath = '<log>';
      if ('silentMs' in data) {
        assert.ok(Math.abs(Date.now() - fs.statSync(filename).mtimeMs - data.silentMs) < 5000, label);
        delete data.silentMs;
      }
      if (data.running) data.updatedAt = '<now>';
      if (label === 'long') {
        assert.equal(data.tail.length, 8192);
        assert.equal(data.tail.charCodeAt(0), 0xde00);
        assert.equal(data.steps[0].state, 'running');
      }
      results.push(data);
      if (label === 'retry') {
        const head = await fetch(url, { headers, method: 'HEAD' });
        assert.equal(head.headers.get('etag'), response.headers.get('etag'));
        assert.equal(await head.text(), '');
        const fresh = await fetch(url, { headers: {
          ...headers, 'cache-control': 'max-age=0', 'if-none-match': response.headers.get('etag'),
        } });
        assert.equal(fresh.status, 304);
        await fresh.arrayBuffer();
      }
    }
    return results;
  } finally { await server.stop(); }
}

(async () => {
  const [gateway, addon] = process.argv.slice(2).map(s => path.resolve(s));
  assert.ok(gateway && addon, 'expected gateway and reference addon');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-status-'));
  try {
    for (const [layout, kind] of [['git', 'git'], ['standalone', 'standalone'],
      ['desktop', 'desktop'], ['relative-data', 'standalone']]) {
      const oracle = await sample(path.join(dir, layout, 'node'), gateway, addon, true, kind, layout === 'relative-data');
      const rust = await sample(path.join(dir, layout, 'rust'), gateway, addon, false, kind, layout === 'relative-data');
      assert.deepEqual(rust, oracle, kind);
      console.log(layout, cases.length, 'states, HEAD and conditional GET matched');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
