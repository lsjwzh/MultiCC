'use strict';

// Host environment file management: the package-root .env read/write helpers
// and VAPID key provisioning for Web Push.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly, including
// the module-load-time side effects: ENV_PATH resolves against the package
// root (this module's ../) so it matches the host's previous __dirname anchor,
// and createHostEnv writes the VAPID keypair to .env + process.env on first
// boot via writeEnvFile.

const fs = require('fs');
const path = require('path');
const { atomicWriteText } = require('./runtime-security');

const ENV_PATH = path.join(__dirname, '..', '.env');

function readEnvFile() {
  const vars = {};
  try {
    fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2];
    });
  } catch (_) {}
  return vars;
}

function writeEnvFile(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); } catch (_) {}
  const written = new Set();
  lines = lines.map(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=/);
    if (m && updates.hasOwnProperty(m[1])) {
      written.add(m[1]);
      if (updates[m[1]] == null) return '';
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  }).filter(l => l.trim() !== '');
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k) && v != null) lines.push(`${k}=${v}`);
  }
  let parentMode = 0o755;
  try { parentMode = fs.statSync(path.dirname(ENV_PATH)).mode & 0o777; } catch (_) {}
  atomicWriteText(ENV_PATH, lines.join('\n') + '\n', { dirMode: parentMode });
}

function createHostEnv(rawDeps) {
  const deps = rawDeps || {};
  const { webpush } = deps;
  if (!webpush || typeof webpush.generateVAPIDKeys !== 'function') {
    throw new TypeError('[host-env] webpush (with generateVAPIDKeys) is required');
  }

  // VAPID key management: auto-generate and persist in .env
  function ensureVapidKeys() {
    let pubKey = process.env.VAPID_PUBLIC_KEY;
    let privKey = process.env.VAPID_PRIVATE_KEY;
    if (pubKey && privKey) return { pubKey, privKey };

    console.log('[multicc/push] Generating VAPID keys...');
    const keys = webpush.generateVAPIDKeys();
    pubKey = keys.publicKey;
    privKey = keys.privateKey;

    // Persist to .env
    const updates = { VAPID_PUBLIC_KEY: pubKey, VAPID_PRIVATE_KEY: privKey };
    writeEnvFile(updates);
    process.env.VAPID_PUBLIC_KEY = pubKey;
    process.env.VAPID_PRIVATE_KEY = privKey;
    console.log('[multicc/push] VAPID keys generated and saved to .env');
    return { pubKey, privKey };
  }

  return { readEnvFile, writeEnvFile, ensureVapidKeys, ENV_PATH };
}

module.exports = { createHostEnv, readEnvFile, writeEnvFile, ENV_PATH };
