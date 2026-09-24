'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, ENTRY_DELIMITER } = require('../memory-store');

// Bundled skill references are the single source for both skill discovery
// and project-memory seeds. They ship with CLI installs and desktop bundles.
const DOCS_REGISTRY_RULE = fs.readFileSync(path.join(__dirname,
  '../../skills/multicc-artifact/references/registration-rule.md'), 'utf8').trim();
const DOCS_REGISTRY_RULE_MARKER = DOCS_REGISTRY_RULE.split('\n')[0];

const SECRET_VAULT_RULE = fs.readFileSync(path.join(__dirname,
  '../../skills/multicc-secrets/references/secret-vault-rule.md'), 'utf8').trim();
const SECRET_VAULT_RULE_MARKER = SECRET_VAULT_RULE.split('\n')[0];

const SHARED_FILES_RULE = fs.readFileSync(path.join(__dirname,
  '../../skills/multicc-workspaces/references/shared-files-rule.md'), 'utf8').trim();
const SHARED_FILES_RULE_MARKER = SHARED_FILES_RULE.split('\n')[0];

// The rules were seeded in Chinese before 2026-09-24. Existing shared
// MEMORY.md files still carry those first lines; recognising them keeps the
// English version from being appended as a duplicate entry.
const LEGACY_MARKERS = Object.freeze({
  docsRegistry: Object.freeze(['[规则][文档与服务登记·强制]']),
  secretVault: Object.freeze(['[规则][敏感信息保险箱·强制]']),
  sharedFiles: Object.freeze(['[规则][共享文件约定·强制]']),
});

// Immutable built-ins, seeded into every shared MEMORY.md and injected as
// pinned retrieval entries. Order only matters for first-seed layout.
const BUILTIN_RULES = Object.freeze([
  { rule: DOCS_REGISTRY_RULE, marker: DOCS_REGISTRY_RULE_MARKER, legacyMarkers: LEGACY_MARKERS.docsRegistry },
  { rule: SECRET_VAULT_RULE, marker: SECRET_VAULT_RULE_MARKER, legacyMarkers: LEGACY_MARKERS.secretVault },
  { rule: SHARED_FILES_RULE, marker: SHARED_FILES_RULE_MARKER, legacyMarkers: LEGACY_MARKERS.sharedFiles },
]);

function hasRuleMarker(text, marker, legacyMarkers = []) {
  // Older hand-written entries put the body on the marker's own line.
  const markers = [marker, ...legacyMarkers];
  return text.split(/\r?\n/).some(line => {
    const head = line.trimStart();
    return markers.some(m => head.startsWith(m));
  });
}

function hasDocsRegistryRule(text) {
  return hasRuleMarker(text, DOCS_REGISTRY_RULE_MARKER, LEGACY_MARKERS.docsRegistry);
}

function ensureBuiltinSharedMemory(sharedDir) {
  const file = path.join(sharedDir, 'MEMORY.md');
  let content = '';
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('shared MEMORY.md must be a regular file');
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let updated = false;
  for (const { rule, marker, legacyMarkers } of BUILTIN_RULES) {
    if (hasRuleMarker(content, marker, legacyMarkers)) continue;
    // Do not normalize, deduplicate or rewrite the user's existing bytes.
    // Startup and session seeding are synchronous in the same server process.
    content += (content ? ENTRY_DELIMITER : '') + rule + '\n';
    updated = true;
  }
  if (updated) atomicWrite(file, content);
  return updated;
}

module.exports = {
  DOCS_REGISTRY_RULE,
  DOCS_REGISTRY_RULE_MARKER,
  SECRET_VAULT_RULE,
  SECRET_VAULT_RULE_MARKER,
  SHARED_FILES_RULE,
  SHARED_FILES_RULE_MARKER,
  BUILTIN_RULES,
  LEGACY_MARKERS,
  hasDocsRegistryRule,
  ensureBuiltinSharedMemory,
};
