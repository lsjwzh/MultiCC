'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function installVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.sh[^\n]*--branch v(\d+\.\d+\.\d+)/g)]
    .map(match => ({ url: match[1], branch: match[2] }));
}

test('public stable install commands use package.json as their version source', () => {
  for (const relative of ['README.md', 'README.zh.md', 'docs/installation.md']) {
    const commands = installVersions(relative);
    assert.ok(commands.length > 0, `${relative} must publish a stable install command`);
    for (const command of commands) {
      assert.equal(command.url, pkg.version, `${relative} download tag drifted`);
      assert.equal(command.branch, pkg.version, `${relative} branch tag drifted`);
    }
  }

  const installer = read('install.sh');
  const declared = installer.match(/^INSTALLER_VERSION="([^"]+)"/m);
  assert.ok(declared, 'install.sh must declare INSTALLER_VERSION');
  assert.equal(declared[1], pkg.version, 'installer version drifted from package.json');
});
