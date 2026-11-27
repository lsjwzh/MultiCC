'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

// The ten leaf sources are byte-for-byte copies from 67f54869. Each owns its
// own module state, including the pinyin dictionary and the shared trace.
async function compare(source, exercise, actual = require(path.resolve(__dirname, '../../src', source))) {
  const expected = require(path.join(__dirname, 'frozen-leaf-hosts', path.basename(source)));
  assert.deepStrictEqual(await exercise(actual), await exercise(expected));
}
module.exports = { compare };
