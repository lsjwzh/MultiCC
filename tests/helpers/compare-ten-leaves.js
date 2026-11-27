'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// These modules have no relative imports. Load each frozen source in its own
// CommonJS instance so closures and module-scoped caches stay independent.
async function compareLeaf(source, exercise) {
  const frozen = path.join(__dirname, 'frozen-ten-leaves', path.basename(source));
  const current = path.resolve(__dirname, '../../src', source);
  const fresh = file => { delete require.cache[require.resolve(file)]; return require(file); };
  const expected = await exercise(fresh(frozen));
  // The next migration redirects nine production callers. Replay their last
  // JS hosts too, resolving relative imports from the original source path.
  const previous = path.join(__dirname, 'frozen-leaf-hosts', 'previous', path.basename(source));
  if (fs.existsSync(previous)) {
    const mod = new Module(current, module);
    mod.filename = current;
    mod.paths = Module._nodeModulePaths(path.dirname(current));
    mod._compile(fs.readFileSync(previous, 'utf8'), current);
    assert.deepStrictEqual(await exercise(mod.exports), expected);
  }
  const actual = await exercise(fresh(current));
  assert.deepStrictEqual(actual, expected);
}

async function outcome(operation) {
  try { return { value: await operation() }; }
  catch (error) { return { name: error.name, code: error.code, message: error.message }; }
}
module.exports = { compareLeaf, outcome };
