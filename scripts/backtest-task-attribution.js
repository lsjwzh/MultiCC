#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createFakeAuxModel, runHistoryBacktest } = require('../src/classify/history-backtest');

async function main(argv = process.argv.slice(2)) {
  const input = argv[0];
  if (!input) {
    process.stderr.write('Usage: node scripts/backtest-task-attribution.js <history-cases.json>\n');
    process.exitCode = 2;
    return;
  }
  const file = path.resolve(input);
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  const model = createFakeAuxModel(corpus.responses || {});
  const report = await runHistoryBacktest(corpus.cases || [], model);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
