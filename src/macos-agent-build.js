'use strict';

// One Mac has ONE MultiCC Agent, but may have several MultiCC copies that ship
// one (the desktop app, a standalone package, a source checkout). Comparing
// source hashes alone cannot say which copy is newer, so each copy that would
// replace another one ping-pongs with it. The build number makes "newer" a
// fact: scripts/macos-agent/agent-build.json pins {build, sourceSha256}, and
// tests/test-macos-agent.js fails when the sources change without a bump.
//
//   node src/macos-agent-build.js bump     # after editing the Agent sources

const path = require('path');
const crypto = require('crypto');

// Order matters: install-agent.sh hashes the same files in the same order.
const AGENT_SOURCE_FILES = Object.freeze([
  'MultiCCAgent.swift',
  'LidBrightnessBridge.h',
  'LidBrightnessBridge.m',
  'MultiCCAgentH264.swift',
  'AgentPermissions.swift',
]);
const BUILD_FILE = 'agent-build.json';

function agentDir(rootDir) {
  return path.join(rootDir, 'scripts', 'macos-agent');
}

function sourceHash(rootDir, fs = require('fs')) {
  const hash = crypto.createHash('sha256');
  for (const file of AGENT_SOURCE_FILES) hash.update(fs.readFileSync(path.join(agentDir(rootDir), file)));
  return hash.digest('hex');
}

// { build, sourceSha256 } as shipped; build 0 when the file is missing or
// malformed, which ranks this copy below every numbered build.
function readShippedBuild(rootDir, fs = require('fs')) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(agentDir(rootDir), BUILD_FILE), 'utf8'));
    const build = Number.isSafeInteger(data.build) && data.build > 0 ? data.build : 0;
    return { build, sourceSha256: typeof data.sourceSha256 === 'string' ? data.sourceSha256 : '' };
  } catch (_) {
    return { build: 0, sourceSha256: '' };
  }
}

function bump(rootDir, fs = require('fs')) {
  const current = readShippedBuild(rootDir, fs);
  const sourceSha256 = sourceHash(rootDir, fs);
  if (current.sourceSha256 === sourceSha256) return { ...current, changed: false };
  const next = { build: current.build + 1, sourceSha256 };
  fs.writeFileSync(path.join(agentDir(rootDir), BUILD_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return { ...next, changed: true };
}

if (require.main === module) {
  const rootDir = path.join(__dirname, '..');
  if (process.argv[2] !== 'bump') {
    console.error('usage: node src/macos-agent-build.js bump');
    process.exit(2);
  }
  const result = bump(rootDir);
  console.log(result.changed ? `agent build -> ${result.build}` : `agent build ${result.build} already matches the sources`);
}

module.exports = { AGENT_SOURCE_FILES, BUILD_FILE, sourceHash, readShippedBuild, bump };
