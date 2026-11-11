#!/usr/bin/env node
'use strict';
// A read-only repository benchmark. Default: isolated, automatically removed
// fixture. An explicit directory is observed without modifying its Git state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const current = require('../src/task-routing/code-revision');
const legacy = require('../tests/helpers/legacy-code-revision');
const identity = require('../commit-policy.json');

async function main() {
  const temporary = process.argv[2] ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-release-bench-'));
  const cwd = fs.realpathSync(process.argv[2] || temporary);
  let worker;
  try {
    if (temporary) {
      const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env,
        GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } });
      git('init', '-b', 'main');
      for (let i = 0; i < 2025; i++) {
        const dir = path.join(cwd, `group-${i % 20}`); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `file-${i}`), 'sample code\n'.repeat(400));
      }
      git('add', '.'); git('commit', '-m', 'test(fixture): seed workspace release benchmark');
    }
    worker = new Worker(require.resolve('../tests/helpers/code-revision-worker'));
    const optimizedNode = () => new Promise((resolve, reject) => {
      const onError = error => { worker.off('message', onMessage); reject(error); };
      const onMessage = message => {
        worker.off('error', onError);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      };
      worker.once('error', onError); worker.once('message', onMessage); worker.postMessage(cwd);
    });
    const paths = [
      ['legacy_node', () => legacy.captureCodeRevision(cwd)],
      ['optimized_node_worker', optimizedNode],
      ['rust_native', () => current.captureCodeRevision(cwd)],
    ];
    const baseline = await legacy.captureCodeRevision(cwd);
    const check = result => {
      for (const field of ['repoId', 'head', 'revision', 'dirty', 'writersStopped']) assert.equal(result[field], baseline[field]);
    };
    for (const [, observe] of paths) check(await observe());
    const samples = Object.fromEntries(paths.map(([name]) => [name, []]));
    for (let round = 0; round < 5; round++) {
      for (let n = 0; n < paths.length; n++) {
        const [name, observe] = paths[(n + round) % paths.length];
        const started = performance.now(); check(await observe());
        samples[name].push(Math.round((performance.now() - started) * 10) / 10);
      }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]));
    console.log(JSON.stringify({ rounds: 5, identicalRevisions: true, samplesMs: samples, medianMs: medians,
      // This isolates observation cost; it is not an end-to-end production SLA.
      observationBudgetMs: { oldThreeScans: medians.legacy_node * 3,
        sameTwoScansNode: medians.optimized_node_worker * 2, newTwoScansRust: medians.rust_native * 2 } }, null, 2));
  } finally {
    if (worker) await worker.terminate();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
