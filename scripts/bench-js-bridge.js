'use strict';

// Compares the two ways a JavaScript value can cross into Rust:
//
//   A. JSON path   JSON.stringify(x) -> jsBridgeJsonRoundTrip(s) -> JSON.parse
//   B. direct      jsBridgeRoundTrip(x)
//
// Payloads are realistic nested board/chat records (strings with Chinese, ids,
// numbers, booleans, nulls, arrays) grown to roughly 1KB, 10KB, 100KB and 1MB.
// Reported number is the p50 of a full round trip over warm iterations.
//
// Usage: MULTICC_RUST_ADDON=<artifact.js> node scripts/bench-js-bridge.js

const { getNative } = require('../src/native/runtime');

const native = getNative();

const TARGETS = [
  ['1KB', 1024],
  ['10KB', 10 * 1024],
  ['100KB', 100 * 1024],
  ['1MB', 1024 * 1024],
];

const WORDS = [
  'Refactor the Rust kernel to drop the JSON hop',
  '任务上下文需要保留孤立代理项',
  'provider quota exhausted, retry after cooldown',
  '构建后验证原生模块加载路径',
  'battery telemetry sample with a long tail of fields',
];

function makeRecord(index) {
  return {
    id: `task-${index.toString(16).padStart(8, '0')}`,
    taskId: `88a96935-${index % 4096}`,
    title: WORDS[index % WORDS.length],
    status: ['running', 'done', 'queued', 'failed'][index % 4],
    priority: index % 7,
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_100_000 + index,
    ratio: (index % 100) / 100,
    active: index % 3 === 0,
    tags: ['rust', 'bridge', WORDS[index % WORDS.length].slice(0, 6)],
    owner: { name: 'lsjwzh', machine: `machine-${index % 5}`, online: index % 2 === 0 },
    artifacts: [
      { kind: 'diff', bytes: 1024 + index, url: `/api/artifact/${index}` },
      { kind: 'log', bytes: 4096 + index, url: null },
    ],
  };
}

function payloadAt(targetBytes) {
  const records = [];
  let size = 2;
  for (let index = 0; size < targetBytes; index += 1) {
    const record = makeRecord(index);
    records.push(record);
    size += JSON.stringify(record).length + 1;
  }
  return { records, bytes: Buffer.byteLength(JSON.stringify(records)) };
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function measure(run, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { p50: percentile(samples, 0.5), min: Math.min(...samples) };
}

function iterationsFor(bytes) {
  if (bytes <= 2048) return 400;
  if (bytes <= 20 * 1024) return 200;
  if (bytes <= 200 * 1024) return 60;
  return 12;
}

function jsonPath(value) {
  return JSON.parse(native.jsBridgeJsonRoundTrip(JSON.stringify(value)));
}

console.log('size\ttarget\tactual\tjson p50\tdirect p50\tratio (json/direct)');
for (const [label, target] of TARGETS) {
  const payload = payloadAt(target);
  const value = payload.records;
  const iterations = iterationsFor(payload.bytes);
  for (let warm = 0; warm < 20; warm += 1) {
    jsonPath(value);
    native.jsBridgeRoundTrip(value);
  }
  const json = measure(() => jsonPath(value), iterations);
  const direct = measure(() => native.jsBridgeRoundTrip(value), iterations);
  const ratio = json.p50 / direct.p50;
  console.log([
    label,
    target,
    payload.bytes,
    json.p50.toFixed(3),
    direct.p50.toFixed(3),
    `${ratio.toFixed(2)}x`,
  ].join('\t'));
}
