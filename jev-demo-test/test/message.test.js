'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { greeting } = require('../src/message');

test('greeting includes the given name', () => {
  assert.equal(greeting('Jev'), 'Hello, Jev!');
});
