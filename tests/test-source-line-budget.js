'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countLines,
  isSourceFile,
  evaluateLineBudgets,
  trackedSourceEntries,
} = require('../scripts/check-source-line-budget');

test('line counting and source selection are deterministic', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\ntwo\n'), 3);
  assert.equal(isSourceFile('server.js'), true);
  assert.equal(isSourceFile('app/lib/main.dart'), true);
  assert.equal(isSourceFile('public/logo.png'), false);
});

test('new first-party files fail above 3000 and never inherit an exception', () => {
  const result = evaluateLineBudgets([
    { file: 'src/small.js', lines: 3000 },
    { file: 'src/new-god-file.js', lines: 3001 },
  ], { migrationDebt: {}, exemptions: {} });
  assert.deepEqual(result.violations, [{
    file: 'src/new-god-file.js',
    lines: 3001,
    bytes: 0,
    limit: 3000,
    byteLimit: 240000,
    kind: 'unapproved_over_3000',
  }]);
});

test('byte budget prevents compressed code and reviewed exceptions stay below 5000', () => {
  const compressed = evaluateLineBudgets([
    { file: 'src/compressed.js', lines: 2, bytes: 240001 },
  ], { migrationDebt: {}, exemptions: {} });
  assert.equal(compressed.violations[0].kind, 'unapproved_over_5000');

  const exception = evaluateLineBudgets([
    { file: 'vendor.js', lines: 5001, bytes: 100 },
  ], {
    migrationDebt: {},
    exemptions: { 'vendor.js': { maxLines: 5000, maxBytes: 240000, reason: 'reviewed' } },
  });
  assert.equal(exception.violations[0].kind, 'reviewed_exception_over_limit');
});

test('migration debt can only shrink and stale policy entries fail closed', () => {
  const policy = {
    'legacy.js': { ceiling: 4000, target: 3000, reason: 'migration' },
  };
  assert.deepEqual(evaluateLineBudgets([
    { file: 'legacy.js', lines: 4000 },
  ], { migrationDebt: policy, exemptions: {} }).debts.map(item => item.file), ['legacy.js']);
  assert.equal(evaluateLineBudgets([
    { file: 'legacy.js', lines: 3500 },
  ], { migrationDebt: policy, exemptions: {} }).violations[0].kind, 'migration_debt_ceiling_not_ratcheted');
  assert.equal(evaluateLineBudgets([
    { file: 'legacy.js', lines: 4001 },
  ], { migrationDebt: policy, exemptions: {} }).violations[0].kind, 'migration_debt_regressed');
  assert.equal(evaluateLineBudgets([
    { file: 'legacy.js', lines: 3000 },
  ], { migrationDebt: policy, exemptions: {} }).violations[0].kind, 'migration_debt_should_be_removed');
  assert.equal(evaluateLineBudgets([], {
    migrationDebt: policy,
    exemptions: {},
  }).violations[0].kind, 'stale_migration_debt');
});

test('the current tracked tree satisfies the ratcheted budget', () => {
  const result = evaluateLineBudgets(trackedSourceEntries());
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.debts.map(item => item.file).sort(), ['server.js']);
});
