'use strict';

// Install, update, uninstall and roll back plugins from the plugin list
// (docs/plugin-catalog-design.md, section 6).
//
// A package is fetched from the URL the signed index.json gives, and is only
// unpacked when its size and sha256 match that entry. The unpacked plugin.json
// must carry the same id and version as the list, and the engine binary for
// this platform must be there. Only then does the folder go in, as a whole, at
// <root>/<id>/. The version it replaces moves to <root>/.previous/<id>/; rolling
// back swaps the two, so a second roll back undoes the first.
//
// .staging/ and .previous/ start with a dot, which the plugin scan
// (src/routes/plugins.js idsIn) never takes for a plugin.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readZip } = require('../session/handoff-zip');

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

class PluginInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (_) { return false; }
}

function readVersion(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch (_) {
    return null;
  }
}

// A package may wrap everything in one top-level folder (<id>/ or
// <id>-<version>/); it is dropped when plugin.json is not at the root.
function packageRoot(names) {
  if (names.includes('plugin.json')) return '';
  const tops = new Set(names.map(name => name.split('/')[0]));
  if (tops.size !== 1 || !names.every(name => name.includes('/'))) return '';
  return `${[...tops][0]}/`;
}

// Regular files only: a link in a package could point anywhere once unpacked.
// Permission bits are kept (bin/ must stay executable), minus group/other write.
function unpack(buffer, dest) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    throw new PluginInstallError('package', `not a usable zip: ${error.message}`);
  }
  const prefix = packageRoot(entries.map(entry => entry.name));
  for (const entry of entries) {
    const relative = entry.name.slice(prefix.length);
    if (!relative) continue;
    const type = entry.mode ? entry.mode & S_IFMT : 0;
    if (type && type !== S_IFREG) throw new PluginInstallError('package', `${entry.name} is not a regular file`);
    const target = path.join(dest, ...relative.split('/'));
    const mode = entry.mode ? entry.mode & 0o755 : 0o644;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data, { mode, flag: 'wx' });
      fs.chmodSync(target, mode);
    } catch (error) {
      // A file and a folder of the same name, or the same file twice once the wrapper is gone.
      throw new PluginInstallError('package', `cannot unpack ${entry.name}: ${error.code || error.message}`);
    }
  }
}

function createPluginInstaller({
  root,
  platform = process.platform,
  fetch,
  // (parentDir, id) → { manifest, binary } | null — src/routes/plugins.js
  // readManifest + resolveBinary, so a package is held to the same rules as
  // the plugins the scan accepts.
  inspect,
  logger = console,
  now = () => Date.now(),
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (!root) throw new TypeError('[plugin-installer] root is required');
  if (typeof fetch !== 'function') throw new TypeError('[plugin-installer] fetch is required');
  if (typeof inspect !== 'function') throw new TypeError('[plugin-installer] inspect is required');
  const stagingDir = path.join(root, '.staging');
  const previousDir = path.join(root, '.previous');
  const busy = new Set();

  const target = id => path.join(root, id);
  const previous = id => path.join(previousDir, id);

  function scratch(id, label) {
    fs.mkdirSync(stagingDir, { recursive: true });
    return path.join(stagingDir, `${id}.${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  }

  // Left behind by a process that died halfway; never a plugin.
  function sweepStaging() {
    let names = [];
    try { names = fs.readdirSync(stagingDir); } catch (_) { return; }
    for (const name of names) {
      const file = path.join(stagingDir, name);
      try {
        if (now() - fs.lstatSync(file).mtimeMs > STALE_STAGING_MS) fs.rmSync(file, { recursive: true, force: true });
      } catch (_) { /* gone already */ }
    }
  }

  async function exclusive(id, work) {
    if (!ID_PATTERN.test(String(id || ''))) throw new PluginInstallError('invalidId', `invalid plugin id: ${id}`);
    if (busy.has(id)) throw new PluginInstallError('busy', `${id} is being changed already`);
    busy.add(id);
    try {
      sweepStaging();
      return await work();
    } finally {
      busy.delete(id);
    }
  }

  async function download(url, asset) {
    if (!(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_PACKAGE_BYTES)) {
      throw new PluginInstallError('size', `package size ${asset.size} is out of range`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const chunks = [];
    let received = 0;
    const hash = crypto.createHash('sha256');
    try {
      let response;
      try {
        response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      } catch (error) {
        throw new PluginInstallError('download', error.name === 'AbortError' ? 'download timed out' : error.message);
      }
      if (!response.ok) throw new PluginInstallError('download', `HTTP ${response.status}`);
      // GitHub answers with a redirect to its download host; whatever it is,
      // the sha256 from the signed list decides, but never plain http.
      if (response.url && !response.url.startsWith('https://')) {
        throw new PluginInstallError('download', `redirected off https: ${response.url}`);
      }
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > asset.size) throw new PluginInstallError('size', `package is larger than the listed ${asset.size} bytes`);
          hash.update(chunk);
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error instanceof PluginInstallError) throw error;
        throw new PluginInstallError('download', error.name === 'AbortError' ? 'download timed out' : error.message);
      }
    } finally {
      clearTimeout(timer);
    }
    if (received !== asset.size) throw new PluginInstallError('size', `got ${received} bytes, the list says ${asset.size}`);
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) throw new PluginInstallError('checksum', `sha256 ${digest} does not match the list`);
    return Buffer.concat(chunks, received);
  }

  function check(parent, id, version) {
    const found = inspect(parent, id);
    if (!found) throw new PluginInstallError('package', 'the package has no valid plugin.json for this id');
    if (found.manifest.version !== version) {
      throw new PluginInstallError('mismatch', `the package is version ${found.manifest.version}, the list says ${version}`);
    }
    if (!found.binary) throw new PluginInstallError('package', `the package has no engine binary for this platform`);
    if (platform !== 'win32') fs.chmodSync(found.binary, fs.statSync(found.binary).mode | 0o755);
  }

  // Moves the installed version aside (to .previous/) and puts `incoming` in
  // its place; the installed version comes back if that last rename fails.
  function swapIn(id, incoming) {
    const current = target(id);
    const kept = previous(id);
    let movedAside = false;
    if (exists(current)) {
      fs.mkdirSync(previousDir, { recursive: true });
      fs.rmSync(kept, { recursive: true, force: true });
      fs.renameSync(current, kept);
      movedAside = true;
    }
    try {
      fs.renameSync(incoming, current);
    } catch (error) {
      if (movedAside && !exists(current)) fs.renameSync(kept, current);
      throw error;
    }
  }

  // asset: { url, sha256, size } from the list, for this platform.
  function install({ id, version, asset }) {
    return exclusive(id, async () => {
      fs.mkdirSync(root, { recursive: true });
      const buffer = await download(asset.url, asset);
      const work = scratch(id, 'install');
      try {
        const unpacked = path.join(work, id);
        fs.mkdirSync(unpacked, { recursive: true });
        unpack(buffer, unpacked);
        check(work, id, version);
        const replaced = readVersion(target(id));
        swapIn(id, unpacked);
        logger.info?.('plugin_installed', { id, version, replaced });
        return { id, version, replaced };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  }

  function rollback(id) {
    return exclusive(id, async () => {
      if (!exists(previous(id))) throw new PluginInstallError('noPrevious', `${id} has no earlier version to go back to`);
      const back = readVersion(previous(id));
      const from = readVersion(target(id));
      const parked = scratch(id, 'rollback');
      if (exists(target(id))) fs.renameSync(target(id), parked);
      try {
        fs.renameSync(previous(id), target(id));
      } catch (error) {
        if (exists(parked)) fs.renameSync(parked, target(id));
        throw error;
      }
      if (exists(parked)) fs.renameSync(parked, previous(id));
      logger.info?.('plugin_rolled_back', { id, from, to: back });
      return { id, version: back, replaced: from };
    });
  }

  // Program files only: whatever the plugin keeps in its own data folder stays.
  function uninstall(id) {
    return exclusive(id, async () => {
      if (!exists(target(id))) throw new PluginInstallError('notInstalled', `${id} is not installed here`);
      const version = readVersion(target(id));
      const removing = scratch(id, 'remove');
      fs.renameSync(target(id), removing);
      fs.rmSync(removing, { recursive: true, force: true });
      fs.rmSync(previous(id), { recursive: true, force: true });
      logger.info?.('plugin_uninstalled', { id, version });
      return { id, version };
    });
  }

  return {
    install,
    rollback,
    uninstall,
    previousVersion: id => (ID_PATTERN.test(String(id || '')) ? readVersion(previous(id)) : null),
    isBusy: id => busy.has(id),
    root,
  };
}

module.exports = { createPluginInstaller, PluginInstallError, MAX_PACKAGE_BYTES };
