'use strict';

// Regenerates native/core/tests/fixtures/qs-query-cases.json, the oracle for
// http_gate::query_value (the shared Express `req.query` model used by the
// Rust front door).
//
//   node scripts/generate-qs-query-fixture.js          # verify (exit 1 on drift)
//   node scripts/generate-qs-query-fixture.js --write  # rewrite the fixture
//
// Every expected value comes from the running Express query parser, not from
// memory: the script mounts a real express app whose only route echoes
// `req.query[name]` through a small classifier, then sends each corpus query
// over loopback. Express 4.22 uses qs 6.15.3 with
// `{ allowPrototypes: true, arrayLimit: 1000 }` (node_modules/express/lib/utils.js).
//
// The classifier mirrors QueryValue: missing / string / array (recursively,
// holes are impossible after qs' compact()) / object. Rust compares its own
// classification against this file, so a qs upgrade that changes shape shows
// up as a small fixture diff instead of a silent route behavior change.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'native', 'core', 'tests', 'fixtures', 'qs-query-cases.json');

// name, key, query. `query` is the raw query string after '?'.
const CASES = [
  // ── numeric indexes ─────────────────────────────────────────────────────
  ['index 0', 'a', 'a[0]=5'],
  ['index 1', 'a', 'a[1]=5'],
  ['index 0 and 1', 'a', 'a[0]=5&a[1]=6'],
  ['index 0 and 1 reversed', 'a', 'a[1]=6&a[0]=5'],
  ['indexes out of order', 'a', 'a[2]=2&a[0]=0&a[1]=1'],
  ['index 20', 'a', 'a[20]=5'],
  ['index 21', 'a', 'a[21]=5'],
  ['index 999', 'a', 'a[999]=5'],
  ['index 1000 overflow', 'a', 'a[1000]=5'],
  ['index 1001 overflow', 'a', 'a[1001]=5'],
  ['leading zero index', 'a', 'a[00]=5'],
  ['negative index', 'a', 'a[-1]=5'],
  ['padded index', 'a', 'a[%200]=5'],
  ['hex index', 'a', 'a[0x1]=5'],
  ['exponent index', 'a', 'a[1e3]=5'],
  ['index then overflow', 'a', 'a[1000]=1&a=2'],
  // ── push / object / nesting ─────────────────────────────────────────────
  ['push', 'a', 'a[]=5'],
  ['push empty', 'a', 'a[]='],
  ['push twice', 'a', 'a[]=1&a[]=2'],
  ['object key', 'a', 'a[b]=5'],
  ['nested push', 'a', 'a[][]=5'],
  ['nested object push', 'a', 'a[][b]=1&a[][c]=2'],
  ['index object', 'a', 'a[0][b]=5'],
  ['nested index', 'a', 'a[0][0]=5'],
  ['index of object', 'a', 'a[0][b]=1&a[0][c]=2'],
  ['scalar then index', 'a', 'a=1&a[0]=2'],
  ['index then object key', 'a', 'a[0]=1&a[b]=2'],
  ['index then push', 'a', 'a[0]=1&a[]=2'],
  ['push then index', 'a', 'a[]=2&a[0]=1'],
  ['same index repeated', 'a', 'a[0]=5&a[0]=6'],
  ['object then scalar', 'a', 'a[b]=1&a=2'],
  ['scalar then object', 'a', 'a=2&a[b]=1'],
  ['index object then index', 'a', 'a[0][b]=1&a[0]=2'],
  ['scalar and push', 'a', 'a[]=1&a=2'],
  ['push and scalar', 'a', 'a=2&a[]=1'],
  ['empty index then scalar', 'a', 'a[0]=&a=1'],
  ['index and next index object', 'a', 'a[0]=1&a[1][b]=2'],
  ['index then same index index', 'a', 'a[0]=1&a[0][0]=2'],
  ['triple same index', 'a', 'a[0]=1&a[0]=2&a[0]=3'],
  // ── percent encoding / repeated / empty ─────────────────────────────────
  ['encoded brackets', 'a', 'a%5B0%5D=5'],
  ['lowercase encoded brackets', 'a', 'a%5b0%5d=5'],
  ['encoded push', 'a', 'a%5B%5D=5'],
  ['repeated key', 'a', 'a=1&a=2'],
  ['repeated empty key', 'a', 'a=&a='],
  ['empty value', 'a', 'a='],
  ['bare key', 'a', 'a'],
  ['plus decoding', 'a', 'a+b=c+d'],
  ['space decoding', 'a', 'a=%20%20'],
  ['unicode value', 'a', 'a=%E4%B8%AD'],
  ['no query', 'a', ''],
  ['other key only', 'a', 'b=1'],
  // ── depth ───────────────────────────────────────────────────────────────
  ['depth five', 'a', 'a[b][c][d][e][f]=1'],
  ['depth six', 'a', 'a[b][c][d][e][f][g]=1'],
  ['depth indexes', 'a', 'a[0][1][2][3][4]=1'],
  ['depth indexes beyond', 'a', 'a[0][1][2][3][4][5]=1'],
  // ── malformed brackets ──────────────────────────────────────────────────
  ['unterminated bracket', 'a', 'a[b=1'],
  ['close without open', 'a', 'a]=1'],
  ['open without close', 'a', 'a[=1'],
  ['nested literal tail', 'a', 'a[[b]]=1'],
  // ── the route's own names ───────────────────────────────────────────────
  ['points index 0', 'points', 'points[0]=5'],
  ['points index 1', 'points', 'points[1]=5'],
  ['points indexes 0,1', 'points', 'points[0]=5&points[1]=6'],
  ['points index 20', 'points', 'points[20]=5'],
  ['points index 21', 'points', 'points[21]=5'],
  ['points index 1000', 'points', 'points[1000]=5'],
  ['points push', 'points', 'points[]=5'],
  ['points nested index', 'points', 'points[0][0]=5'],
  ['points encoded index', 'points', 'points%5B0%5D=5'],
  ['points index and push', 'points', 'points[0]=5&points[]=6'],
  ['points scalar and index', 'points', 'points=1&points[0]=2'],
  ['points plain', 'points', 'points=5'],
  ['points plain empty', 'points', 'points='],
  ['points repeated', 'points', 'points=5&points=6'],
  ['since index 0', 'since', 'since[0]=123'],
  ['since object key', 'since', 'since[a]=1'],
  ['range index 0', 'range', 'range[0]=7d'],
  ['range push', 'range', 'range[]=7d'],
  ['appType index 0', 'appType', 'appType[0]=claude'],
  ['id index 0', 'id', 'id[0]=x'],
  // parameterLimit: the 1000th pair still counts, the 1001st does not.
  ['parameter limit at edge', 'points', `${'x=0&'.repeat(999)}points=5`],
  ['parameter limit past edge', 'points', `${'x=0&'.repeat(1000)}points=5`],
];

function classify(value) {
  if (value === undefined) return { kind: 'missing' };
  if (typeof value === 'string') return { kind: 'text', value };
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      items: value.map((item) => {
        if (item === undefined) throw new Error('qs returned a sparse array after compact()');
        return classify(item);
      }),
    };
  }
  if (value !== null && typeof value === 'object') return { kind: 'object' };
  throw new Error(`unexpected qs value type ${typeof value}: ${JSON.stringify(value)}`);
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`${pathname}: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`));
          return;
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`${pathname}: no answer within 10s`)));
    req.on('error', reject);
    req.end();
  });
}

async function build() {
  // Resolved from this file like every other test; a worktree without its own
  // node_modules walks up to the main checkout's install.
  const express = require('express');
  const app = express();
  // The name travels in the path so the query string stays exactly the corpus
  // text; Express parses it with the same middleware the product uses.
  app.get('/probe/:name', (req, res) => {
    res.json({ value: classify(req.query[req.params.name]) });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cases = [];
    for (const [name, key, query] of CASES) {
      const url = `/probe/${encodeURIComponent(key)}${query ? `?${query}` : ''}`;
      const { value } = await request(port, url);
      cases.push({ name, key, query, expected: value });
    }
    return {
      note: 'Generated by scripts/generate-qs-query-fixture.js from the running Express query parser. Do not edit by hand.',
      cases,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const fixture = await build();
  const next = `${JSON.stringify(fixture, null, 2)}\n`;
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (write) {
    if (current === next) {
      console.log('qs query fixture already current');
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    console.log(`Generated ${path.relative(root, target)}`);
    return;
  }
  if (current !== next) {
    console.error(`${path.relative(root, target)} is stale; run node scripts/generate-qs-query-fixture.js --write`);
    process.exit(1);
  }
  console.log(`qs query fixture current: ${fixture.cases.length} cases`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { build, CASES, classify };
