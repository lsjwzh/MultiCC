'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, ENTRY_DELIMITER } = require('../memory-store');

// The bundled skill reference is the single source for both skill discovery
// and project-memory seeds. It ships with CLI installs and desktop bundles.
const DOCS_REGISTRY_RULE = fs.readFileSync(path.join(__dirname,
  '../../skills/multicc-artifact/references/registration-rule.md'), 'utf8').trim();
const DOCS_REGISTRY_RULE_MARKER = DOCS_REGISTRY_RULE.split('\n')[0];

function hasDocsRegistryRule(text) {
  // Older hand-written entries put the body on the marker's own line.
  return text.split(/\r?\n/).some(line => line.trimStart().startsWith(DOCS_REGISTRY_RULE_MARKER));
}

function ensureBuiltinSharedMemory(sharedDir) {
  const file = path.join(sharedDir, 'MEMORY.md');
  let previous = '';
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('shared MEMORY.md must be a regular file');
    previous = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (hasDocsRegistryRule(previous)) return false;
  // Do not normalize, deduplicate or rewrite the user's existing bytes.
  // Startup and session seeding are synchronous in the same server process.
  atomicWrite(file, previous + (previous ? ENTRY_DELIMITER : '') + DOCS_REGISTRY_RULE + '\n');
  return true;
}

module.exports = { DOCS_REGISTRY_RULE, DOCS_REGISTRY_RULE_MARKER, ensureBuiltinSharedMemory };
