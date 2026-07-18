'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function requires(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
}

test('session bounded-context core has no host or cross-context dependencies', () => {
  const files = fs.readdirSync('src/session', { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join('src/session', entry.name));
  assert.ok(files.length >= 5);
  for (const file of files) {
    for (const dependency of requires(file)) {
      assert.notEqual(dependency.includes('server'), true, `${file} reverse requires the host`);
      assert.doesNotMatch(dependency, /(?:directory|providers?|git|tmux|orchestration|outbox|wait-service)/);
      assert.equal(
        dependency.startsWith('./') || dependency === '../session-dto',
        true,
        `${file} has unapproved dependency ${dependency}`,
      );
    }
  }
});

test('session filesystem adapter depends only on shared data-root infrastructure', () => {
  const file = 'src/session/adapters/chat-history-file-repository.js';
  const allowed = new Set(['fs', 'path', '../../paths', '../../runtime-security']);
  for (const dependency of requires(file)) assert.equal(allowed.has(dependency), true, dependency);
});

test('no source module reverse requires server.js', () => {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit('src');
  for (const file of files) {
    for (const dependency of requires(file)) assert.doesNotMatch(dependency, /(?:^|\/)server(?:\.js)?$/);
  }
});
