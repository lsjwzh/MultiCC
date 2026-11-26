'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// These modules have no relative imports. Load each frozen source in its own
// CommonJS instance so closures and module-scoped caches stay independent.
async function compareLeaf(source, exercise) {
  const frozen = path.join(__dirname, 'frozen-ten-leaves', path.basename(source));
  const current = path.resolve(__dirname, '../../src', source);
  const fresh = file => { delete require.cache[require.resolve(file)]; return require(file); };
  const expected = await exercise(fresh(frozen));
  const actual = await exercise(fresh(current));
  assert.deepStrictEqual(actual, expected);
}

async function outcome(operation) {
  try { return { value: await operation() }; }
  catch (error) { return { name: error.name, code: error.code, message: error.message }; }
}
module.exports = { compareLeaf, outcome };
