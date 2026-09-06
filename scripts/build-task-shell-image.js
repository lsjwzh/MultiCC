#!/usr/bin/env node
'use strict';

// Docker never sees the host checkout: export tracked regular files only.
// Read worktree contents so staged/uncommitted fixes can be tested before commit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { RUNTIME_BASENAMES } = require('./check-repository-artifacts');

function excluded(file) {
  const parts = file.split('/');
  return parts.some(p => ['.git', '.claude', '.codex', '.npmrc', 'node_modules', 'memories', 'chat_history', 'artifacts'].includes(p)
    || /^\.env(?:\.|$)/.test(p) || /^(?:auth|credentials?)\.json$/.test(p) || /\.(?:pem|key)$/.test(p))
    || RUNTIME_BASENAMES.has(path.posix.basename(file));
}

function exportSources(root, destination) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  const digest = createHash('sha256');
  let count = 0;
  for (const file of files.sort()) {
    if (excluded(file)) continue;
    const source = path.join(root, file);
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    // Reject symlinks (including symlink parents) instead of following host paths.
    if (!stat.isFile() || fs.realpathSync(source) !== path.join(fs.realpathSync(root), file)) {
      throw new Error(`Build source must be a regular file inside the checkout: ${file}`);
    }
    const bytes = fs.readFileSync(source);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
    digest.update(file + '\0').update(bytes).update('\0');
    count++;
  }
  for (const file of ['package-lock.json', 'docker/task-shell/Dockerfile', 'docker/task-shell/run-tests.js']) {
    if (!fs.existsSync(path.join(destination, file))) throw new Error(`Missing ${file}; git add new source files before building`);
  }
  const manifest = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
    sourceDigest: digest.digest('hex'), files: count };
  fs.writeFileSync(path.join(destination, 'docker-source.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(destination, '.dockerignore'), '# This context contains filtered tracked sources only.\n');
  return manifest;
}

async function main() {
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-docker-source-'));
  try {
    console.log('Exported source:', exportSources(path.resolve(__dirname, '..'), context));
    const child = spawn('docker', ['build', '--progress=plain', '-t', 'multicc-task-shell-test:local',
      '-f', path.join(context, 'docker/task-shell/Dockerfile'), context], { stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { fs.rmSync(context, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { excluded, exportSources };
