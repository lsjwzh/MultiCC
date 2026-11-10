'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The shared query model (native/core/src/http_gate.rs `query_value`) has to
// answer exactly what Express's `req.query` answers, because numeric query
// values on the Rust front door are read with `Number()` / `typeof === 'string'`
// like the deleted Node routes did. The fixture is generated from a running
// Express app (scripts/generate-qs-query-fixture.js); this test re-runs the
// same corpus against the installed Express and fails when the fixture is stale.
// The Rust half reads the same file in
// http_gate::node_golden::query_value_matches_the_real_express_query_parser.

const root = path.join(__dirname, '..');
const target = path.join(root, 'native', 'core', 'tests', 'fixtures', 'qs-query-cases.json');
const { build, CASES } = require('../scripts/generate-qs-query-fixture');

test('the qs query fixture matches the installed Express query parser', async () => {
  const fixture = await build();
  const committed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(committed, fixture,
    'native/core/tests/fixtures/qs-query-cases.json is stale: run node scripts/generate-qs-query-fixture.js --write');
});

test('the corpus keeps every shape the Rust parser has to reproduce', () => {
  const byName = new Map(CASES.map(([name, key, query]) => [name, { key, query }]));
  const expectedNames = [
    'index 0', 'index 1', 'index 0 and 1', 'index 20', 'index 21',
    'index 1000 overflow', 'push', 'object key', 'nested index',
    'scalar then index', 'index then push', 'push then index',
    'same index repeated', 'object then scalar', 'scalar then object',
    'encoded brackets', 'repeated key', 'empty value',
    'points index 0', 'points index 1', 'points indexes 0,1',
    'points index 20', 'points index 21', 'points index 1000',
    'points push', 'points index and push', 'since index 0', 'since object key',
    'range index 0', 'parameter limit at edge', 'parameter limit past edge',
  ];
  for (const name of expectedNames) assert.ok(byName.has(name), `missing corpus case: ${name}`);
  assert.equal(byName.size, CASES.length, 'case names must stay unique');
});

test('a single numeric index compacts, several join, 1000 falls back to an object', () => {
  const fixture = JSON.parse(fs.readFileSync(target, 'utf8'));
  const find = (query, key) => {
    const row = fixture.cases.find((entry) => entry.query === query && entry.key === key);
    assert.ok(row, `fixture row for ?${query}`);
    return row.expected;
  };
  assert.deepEqual(find('points[0]=5', 'points'), { kind: 'array', items: [{ kind: 'text', value: '5' }] });
  assert.deepEqual(find('points[0]=5&points[1]=6', 'points'), {
    kind: 'array', items: [{ kind: 'text', value: '5' }, { kind: 'text', value: '6' }],
  });
  assert.deepEqual(find('points[1000]=5', 'points'), { kind: 'object' });
  assert.deepEqual(find('since[a]=1', 'since'), { kind: 'object' });
  assert.deepEqual(find('points[]=5', 'points'), { kind: 'array', items: [{ kind: 'text', value: '5' }] });
});
