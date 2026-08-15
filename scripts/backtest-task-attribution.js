#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  corpusFromAuxRuns,
  createFakeAuxModel,
  runHistoryBacktest,
} = require('../src/classify/history-backtest');

function loadCorpus(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.cases)) return parsed;
    return corpusFromAuxRuns(Array.isArray(parsed) ? parsed : [parsed]);
  } catch (_) {
    const runs = text.split(/\r?\n/)
      .filter(line => line.trim())
      .map((line, index) => {
        try { return JSON.parse(line); }
        catch (error) { throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`); }
      });
    return corpusFromAuxRuns(runs);
  }
}

async function main(argv = process.argv.slice(2)) {
  const input = argv[0];
  if (!input) {
    process.stderr.write('Usage: node scripts/backtest-task-attribution.js <history-cases.json>\n');
    process.exitCode = 2;
    return;
  }
  const file = path.resolve(input);
  const corpus = loadCorpus(file);
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error('backtest corpus has no replayable cases');
  }
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

module.exports = { loadCorpus, main };
