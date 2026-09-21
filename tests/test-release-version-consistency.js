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

// The installer is served from the release tag it installs, so the tag in the
// documented URL is the version a user gets: no flags, nothing to keep in sync
// by hand on the command line.
function installVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.sh/g)]
    .map(match => ({ url: match[1] }));
}

test('public stable install commands use package.json as their version source', () => {
  for (const relative of ['README.md', 'README.zh.md', 'docs/installation.md']) {
    const commands = installVersions(relative);
    assert.ok(commands.length > 0, `${relative} must publish a stable install command`);
    for (const command of commands) {
      assert.equal(command.url, pkg.version, `${relative} install tag drifted`);
    }
  }

  const installer = read('install.sh');
  const declared = installer.match(/^INSTALLER_VERSION="([^"]+)"/m);
  assert.ok(declared, 'install.sh must declare INSTALLER_VERSION');
  assert.equal(declared[1], pkg.version, 'installer version drifted from package.json');
});

test('tag releases cannot bypass the relay-transparency regression gate', () => {
  const relayGate = pkg.scripts && pkg.scripts['test:relay-transparency'];
  const releaseGate = pkg.scripts && pkg.scripts['test:release'];
  assert.match(String(relayGate || ''), /tests\/test-codex-official-relay\.js/);
  assert.match(String(relayGate || ''), /tests\/test-claude-passthrough-hop\.js/);
  assert.match(String(releaseGate || ''), /npm run test:relay-transparency/);
  assert.match(String(releaseGate || ''), /npm test/);

  const providerGate = pkg.scripts && pkg.scripts['test:provider-router'];
  assert.match(String(providerGate || ''), /tests\/test-codex-official-relay\.js/);
  assert.match(String(providerGate || ''), /tests\/test-claude-passthrough-hop\.js/);

  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /npm run test:release/,
    'tag workflow must call the canonical release gate, not a weaker test command');
});
