'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const installer = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'multicc'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const stableCommand = `curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v${pkg.version}/install.sh | bash -s -- --branch v${pkg.version}`;
assert.ok(installer.includes(stableCommand), 'installer help must clone the release tag, not main');
assert.ok(readme.includes(stableCommand), 'README stable command must clone the release tag, not main');
assert.match(installer, /--branch v\$\{INSTALLER_VERSION\}/);

const beforeCapture = manager.indexOf('before="$(git rev-parse HEAD');
const stableBranch = manager.indexOf('if [ "$channel" = "stable" ]');
const stableAfter = manager.indexOf('after="$(git rev-parse HEAD', stableBranch);
const dependencyDiff = manager.indexOf('Dependencies changed — running npm install');
assert.ok(beforeCapture >= 0 && beforeCapture < stableBranch, 'stable updates must capture the old revision before checkout');
assert.ok(stableAfter > stableBranch, 'stable updates must capture the new revision after checkout');
assert.ok(dependencyDiff > stableAfter, 'stable updates must install changed manifests before restart');
assert.match(manager, /Runtime dependencies are incomplete or outdated — running npm install/);
assert.match(manager, /scripts\/check-runtime-deps\.js/);

const cprSpec = pkg.dependencies['cli-provider-router'];
assert.match(cprSpec, /^https:\/\/github\.com\/lsjwzh\/cli-provider-router\/archive\/[0-9a-f]{40}\.tar\.gz$/);
assert.equal(lock.packages[''].dependencies['cli-provider-router'], cprSpec);
assert.equal(lock.packages['node_modules/cli-provider-router'].resolved, cprSpec);
assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^cli-provider-router\/$/m);

console.log('Release upgrade guard tests passed');
