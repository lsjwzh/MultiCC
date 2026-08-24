'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensurePrivateDir, secureFile } = require('./runtime-security');
const { writeTextAtomic } = require('./state-store');

const ATTEMPT_OWNER_FILE = '.multicc-attempt-owner.json';
const PROCESS_INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const PROVIDER_ROUTE_REDACTION = '[REDACTED_PROVIDER_ROUTE]';
const PROVIDER_ROUTE_CAPABILITY = /pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}/g;
const MAX_ROLLOUT_SCAN_ENTRIES = 100_000;
const liveAttemptHomes = new Set();

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    const error = new Error(`${label} is required`);
    error.code = 'CODEX_ATTEMPT_HOME_IDENTITY_INVALID';
    throw error;
  }
  return text;
}

function safePrefix(value) {
  const text = String(value || 'provider').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return text.slice(0, 48) || 'provider';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function normalizedCapability(value) {
  const text = String(value || '').trim();
  return /^pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}$/.test(text) ? text : '';
}

function decodedCapabilityToken(capability) {
  const parts = String(capability || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'pr1') return '';
  try {
    const token = Buffer.from(parts[2], 'base64url').toString('utf8');
    return /^proxy-route[-_][A-Za-z0-9_-]{8,256}$/.test(token) ? token : '';
  } catch (_) {
    return '';
  }
}

function encodedCapabilityToken(capability) {
  const parts = String(capability || '').split('.');
  return parts.length === 3 && parts[0] === 'pr1' ? parts[2] : '';
}

function secretsForCapabilities(capabilities) {
  const secrets = new Set();
  for (const value of capabilities || []) {
    const capability = normalizedCapability(value);
    if (!capability) continue;
    secrets.add(capability);
    const encodedToken = encodedCapabilityToken(capability);
    if (encodedToken) secrets.add(encodedToken);
    const token = decodedCapabilityToken(capability);
    if (token) secrets.add(token);
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

function scanRolloutFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  const rootStat = fs.lstatSync(sessionsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    const error = new Error('Codex rollout root must be a real directory');
    error.code = 'CODEX_ATTEMPT_ROLLOUT_ROOT_INVALID';
    throw error;
  }
  const files = [];
  const stack = [sessionsDir];
  let inspected = 0;
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_ROLLOUT_SCAN_ENTRIES) {
        const error = new Error('Codex rollout scan limit exceeded');
        error.code = 'CODEX_ATTEMPT_ROLLOUT_SCAN_LIMIT';
        throw error;
      }
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isFile() && !stat.isSymbolicLink()) files.push({ file: target, stat });
    }
  }
  return files;
}

function snapshotRollouts(sessionsDir) {
  return new Map(scanRolloutFiles(sessionsDir).map(({ file, stat }) => [file, {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }]));
}

function bufferReplaceAll(input, needleText, replacementText) {
  const needle = Buffer.from(String(needleText));
  if (!needle.length || input.indexOf(needle) < 0) return input;
  const replacement = Buffer.from(String(replacementText));
  const chunks = [];
  let cursor = 0;
  let index = input.indexOf(needle, cursor);
  while (index >= 0) {
    chunks.push(input.subarray(cursor, index), replacement);
    cursor = index + needle.length;
    index = input.indexOf(needle, cursor);
  }
  chunks.push(input.subarray(cursor));
  return Buffer.concat(chunks);
}

function jsonStringTokens(text) {
  const tokens = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== '"') continue;
    const start = cursor;
    cursor += 1;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === '\\') {
        cursor += 1;
        continue;
      }
      if (text[cursor] !== '"') continue;
      const end = cursor + 1;
      let value;
      try { value = JSON.parse(text.slice(start, end)); }
      catch (_) { break; }
      let after = end;
      while (/\s/.test(text[after] || '')) after += 1;
      tokens.push({ start, end, value, isKey: text[after] === ':', ranges: [] });
      break;
    }
  }
  return tokens;
}

function markSecretFragments(tokens, secrets) {
  if (!tokens.length) return;
  const offsets = [];
  let combined = '';
  for (const token of tokens) {
    offsets.push(combined.length);
    combined += token.value;
  }
  for (const secret of secrets) {
    let matchAt = combined.indexOf(secret);
    while (matchAt >= 0) {
      const matchEnd = matchAt + secret.length;
      for (let index = 0; index < tokens.length; index += 1) {
        const tokenStart = offsets[index];
        const tokenEnd = tokenStart + tokens[index].value.length;
        if (tokenEnd <= matchAt || tokenStart >= matchEnd) continue;
        tokens[index].ranges.push([
          Math.max(0, matchAt - tokenStart),
          Math.min(tokens[index].value.length, matchEnd - tokenStart),
        ]);
      }
      matchAt = combined.indexOf(secret, matchAt + 1);
    }
  }
}

function redactMarkedValue(value, ranges) {
  const ordered = ranges.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let output = '';
  let cursor = 0;
  for (const [start, end] of ordered) {
    if (end <= cursor) continue;
    output += value.slice(cursor, Math.max(cursor, start));
    output += PROVIDER_ROUTE_REDACTION;
    cursor = end;
  }
  return output + value.slice(cursor);
}

function scrubJsonStringFragments(input, secrets) {
  const text = input.toString('utf8');
  const tokens = jsonStringTokens(text);
  // Values, object keys, and mixed key/value fragments are all independently
  // reconstructable by a tool reading its own rollout. Match each channel.
  markSecretFragments(tokens.filter(token => !token.isKey), secrets);
  markSecretFragments(tokens.filter(token => token.isKey), secrets);
  markSecretFragments(tokens, secrets);
  const marked = tokens.filter(token => token.ranges.length);
  if (!marked.length) return input;
  let output = '';
  let cursor = 0;
  for (const token of marked) {
    output += text.slice(cursor, token.start);
    output += JSON.stringify(redactMarkedValue(token.value, token.ranges));
    cursor = token.end;
  }
  output += text.slice(cursor);
  return Buffer.from(output);
}

function sameFileVersion(left, right) {
  return !!(left && right && left.isFile() && right.isFile()
    && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs);
}

function assertFileVersion(file, expected) {
  let current;
  try { current = fs.lstatSync(file); }
  catch (_) { current = null; }
  if (sameFileVersion(expected, current)) return;
  const error = new Error('Codex rollout changed during capability scrub');
  error.code = 'CODEX_ATTEMPT_ROLLOUT_CHANGED';
  throw error;
}

function scrubRolloutFile(file, initialStat, secrets) {
  const input = fs.readFileSync(file);
  let output = input;
  for (const secret of secrets) {
    output = bufferReplaceAll(output, secret, PROVIDER_ROUTE_REDACTION);
  }
  output = scrubJsonStringFragments(output, secrets);
  if (output === input) return false;
  const currentStat = fs.lstatSync(file);
  assertFileVersion(file, initialStat);
  writeTextAtomic(file, output, {
    mode: 0o600,
    dirMode: 0o700,
    beforeRename: () => assertFileVersion(file, currentStat),
  });
  return true;
}

function rolloutChanged(file, stat, baseline, createdAtMs) {
  if (baseline) {
    const previous = baseline.get(file);
    return !previous || previous.dev !== stat.dev || previous.ino !== stat.ino
      || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs;
  }
  return stat.mtimeMs >= Math.max(0, Number(createdAtMs) || 0) - 1000;
}

function scrubChangedRollouts({ sessionsDir, capabilities, baseline = null, createdAtMs = 0 }) {
  const secrets = secretsForCapabilities(capabilities);
  if (!secrets.length) return Object.freeze({ inspected: 0, scrubbed: 0 });
  let inspected = 0;
  let scrubbed = 0;
  for (const { file, stat } of scanRolloutFiles(sessionsDir)) {
    if (!rolloutChanged(file, stat, baseline, createdAtMs)) continue;
    inspected += 1;
    if (scrubRolloutFile(file, stat, secrets)) scrubbed += 1;
  }
  return Object.freeze({ inspected, scrubbed });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function readAttemptOwner(attemptHome) {
  const ownerFile = path.join(attemptHome, ATTEMPT_OWNER_FILE);
  try {
    const stat = fs.lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    const rawPid = Number(owner && owner.pid);
    const pid = Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null;
    const sourceHome = typeof owner.sourceHome === 'string' && path.isAbsolute(owner.sourceHome)
      ? path.resolve(owner.sourceHome)
      : '';
    const rawCreatedAtMs = Number(owner.createdAtMs);
    const parsedCreatedAt = Date.parse(String(owner.createdAt || ''));
    const createdAtMs = Number.isFinite(rawCreatedAtMs) && rawCreatedAtMs > 0
      ? rawCreatedAtMs
      : (Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0);
    return {
      pid,
      processInstanceId: String(owner.processInstanceId || ''),
      sourceHome,
      encodedCapability: normalizedCapability(owner.encodedCapability),
      createdAtMs,
    };
  } catch (_) {
    return null;
  }
}

function entryOwnerPid(entryName) {
  const match = /^p([1-9][0-9]*)-/.exec(String(entryName || ''));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

function isLiveAttemptHome(attemptHome, entryName) {
  let stat;
  try { stat = fs.lstatSync(attemptHome); }
  catch (_) { return false; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const owner = readAttemptOwner(attemptHome);
  const pid = owner ? owner.pid : entryOwnerPid(entryName);
  if (!pid) return false;
  if (pid !== process.pid) return processIsAlive(pid);
  // A restarted process can reuse the old pid. The per-process nonce lets this
  // process distinguish its own live leases from such stale directories.
  if (owner) {
    return owner.processInstanceId === PROCESS_INSTANCE_ID
      && liveAttemptHomes.has(attemptHome);
  }
  // Retain a marker-less p<PID> directory conservatively: another module copy
  // may be between mkdtemp and the atomic owner-file write.
  return true;
}

function attemptConfigCapabilities(attemptHome) {
  const configFile = path.join(attemptHome, 'config.toml');
  try {
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return [];
    return fs.readFileSync(configFile, 'utf8').match(PROVIDER_ROUTE_CAPABILITY) || [];
  } catch (_) {
    return [];
  }
}

function orphanSessionsDir(attemptHome, owner) {
  const linkedSessions = path.join(attemptHome, 'sessions');
  let linkedTarget = '';
  try {
    const stat = fs.lstatSync(linkedSessions);
    if (stat.isSymbolicLink()) linkedTarget = fs.realpathSync(linkedSessions);
  } catch (_) {}
  if (owner && owner.sourceHome) {
    if (owner.sourceHome === attemptHome
        || owner.sourceHome.startsWith(`${attemptHome}${path.sep}`)) return '';
    const ownedSessions = path.join(owner.sourceHome, 'sessions');
    if (linkedTarget && fs.existsSync(ownedSessions)
        && fs.realpathSync(ownedSessions) !== linkedTarget) return '';
    return ownedSessions;
  }
  return linkedTarget;
}

function orphanCreatedAtMs(attemptHome, owner) {
  if (owner && owner.createdAtMs > 0) return owner.createdAtMs;
  try {
    const stat = fs.lstatSync(attemptHome);
    if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) return stat.birthtimeMs;
    return Math.min(stat.ctimeMs || Infinity, stat.mtimeMs || Infinity);
  } catch (_) {
    return 0;
  }
}

function scrubOrphanAttemptHome(attemptHome) {
  const owner = readAttemptOwner(attemptHome);
  const capabilities = [...new Set([
    owner && owner.encodedCapability,
    ...attemptConfigCapabilities(attemptHome),
  ].filter(Boolean))];
  if (!capabilities.length) return Object.freeze({ inspected: 0, scrubbed: 0 });
  const sessionsDir = orphanSessionsDir(attemptHome, owner);
  if (!sessionsDir) {
    const error = new Error('Codex orphan capability rollout root is unresolved');
    error.code = 'CODEX_ATTEMPT_HOME_ORPHAN_UNRESOLVED';
    throw error;
  }
  return scrubChangedRollouts({
    sessionsDir,
    capabilities,
    createdAtMs: orphanCreatedAtMs(attemptHome, owner),
  });
}

function cleanupCodexAttemptHomes(homesDirInput) {
  const homesDir = path.resolve(requiredText(homesDirInput, 'attempt homes directory'));
  if (homesDir === path.parse(homesDir).root) {
    const error = new Error('Codex attempt homes directory is unsafe');
    error.code = 'CODEX_ATTEMPT_HOME_PATH_INVALID';
    throw error;
  }
  try {
    if (fs.existsSync(homesDir)) {
      const stat = fs.lstatSync(homesDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        const error = new Error('Codex attempt homes directory must be a real directory');
        error.code = 'CODEX_ATTEMPT_HOME_PATH_INVALID';
        throw error;
      }
    }
    ensurePrivateDir(homesDir);
    let removed = 0;
    let retained = 0;
    let scrubbed = 0;
    for (const entry of fs.readdirSync(homesDir, { withFileTypes: true })) {
      const target = path.join(homesDir, entry.name);
      if (isLiveAttemptHome(target, entry.name)) {
        retained += 1;
        continue;
      }
      try {
        const stat = fs.lstatSync(target);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          scrubbed += scrubOrphanAttemptHome(target).scrubbed;
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
        removed += 1;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    return Object.freeze({ removed, retained, scrubbed });
  } catch (cause) {
    if (cause && (cause.code === 'CODEX_ATTEMPT_HOME_PATH_INVALID'
        || cause.code === 'CODEX_ATTEMPT_HOME_CLEANUP_FAILED')) throw cause;
    const error = new Error('Codex attempt home cleanup failed');
    error.code = 'CODEX_ATTEMPT_HOME_CLEANUP_FAILED';
    error.cause = cause;
    throw error;
  }
}

function copyPrivateFile(source, destination, { required = false } = {}) {
  if (!fs.existsSync(source)) {
    if (!required) return false;
    const error = new Error(`Codex attempt source is missing ${path.basename(source)}`);
    error.code = 'CODEX_ATTEMPT_HOME_SOURCE_INVALID';
    throw error;
  }
  fs.copyFileSync(source, destination);
  secureFile(destination);
  return true;
}

function linkSharedDirectory(sourceHome, attemptHome, name, { create = false } = {}) {
  const source = path.join(sourceHome, name);
  if (create) ensurePrivateDir(source);
  if (!fs.existsSync(source)) return false;
  const target = fs.realpathSync(source);
  fs.symlinkSync(
    target,
    path.join(attemptHome, name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return true;
}

function createCodexAttemptHome(sourceHomeInput, options = {}) {
  const sourceHome = path.resolve(requiredText(sourceHomeInput, 'source CODEX_HOME'));
  const sessionId = requiredText(options.sessionId, 'attempt proxy session');
  const providerId = requiredText(options.providerId, 'providerId');
  const homesDir = path.resolve(requiredText(options.homesDir, 'attempt homes directory'));
  if (sourceHome === homesDir || sourceHome.startsWith(`${homesDir}${path.sep}`)) {
    const error = new Error('Codex provider home must be outside the attempt overlay directory');
    error.code = 'CODEX_ATTEMPT_HOME_PATH_INVALID';
    throw error;
  }
  cleanupCodexAttemptHomes(homesDir);
  const createdAtMs = Date.now();
  const sourceSessions = path.join(sourceHome, 'sessions');
  ensurePrivateDir(sourceSessions);
  const rolloutBaseline = snapshotRollouts(sourceSessions);
  const attemptHome = fs.mkdtempSync(path.join(
    homesDir,
    `p${process.pid}-${PROCESS_INSTANCE_ID}-${safePrefix(providerId)}-${fingerprint(sessionId)}-`,
  ));
  ensurePrivateDir(attemptHome);
  liveAttemptHomes.add(attemptHome);
  let released = false;
  const release = () => {
    if (released) return false;
    liveAttemptHomes.delete(attemptHome);
    try {
      scrubChangedRollouts({
        sessionsDir: sourceSessions,
        capabilities: [sessionId],
        baseline: rolloutBaseline,
        createdAtMs,
      });
      fs.rmSync(attemptHome, { recursive: true, force: true });
      if (fs.existsSync(attemptHome)) throw new Error('Codex attempt home could not be removed');
      released = true;
      return true;
    } catch (cause) {
      const error = new Error('Codex attempt capability cleanup failed');
      error.code = 'CODEX_ATTEMPT_HOME_RELEASE_FAILED';
      error.cause = cause;
      throw error;
    }
  };
  try {
    const ownerFile = path.join(attemptHome, ATTEMPT_OWNER_FILE);
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      sourceHome,
      encodedCapability: normalizedCapability(sessionId),
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
    }), { mode: 0o600, flag: 'wx' });
    secureFile(ownerFile);
    copyPrivateFile(
      path.join(sourceHome, 'config.toml'),
      path.join(attemptHome, 'config.toml'),
      { required: true },
    );
    copyPrivateFile(path.join(sourceHome, 'auth.json'), path.join(attemptHome, 'auth.json'));
    copyPrivateFile(path.join(sourceHome, 'AGENTS.md'), path.join(attemptHome, 'AGENTS.md'));
    ensurePrivateDir(path.join(attemptHome, 'agents'));
    // Native conversation state and shared skills remain provider-scoped. The
    // only attempt-private surface is config/agents, which may contain the
    // opaque proxy capability and is deleted as soon as the child closes.
    linkSharedDirectory(sourceHome, attemptHome, 'sessions', { create: true });
    linkSharedDirectory(sourceHome, attemptHome, 'skills');
    linkSharedDirectory(sourceHome, attemptHome, 'rules');
    linkSharedDirectory(sourceHome, attemptHome, 'memories');
    return Object.freeze({ home: attemptHome, sourceHome, release });
  } catch (error) {
    release();
    throw error;
  }
}

module.exports = {
  ATTEMPT_OWNER_FILE,
  cleanupCodexAttemptHomes,
  createCodexAttemptHome,
};
