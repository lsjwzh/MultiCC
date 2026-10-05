'use strict';

// A domain → profile index, never a cookie store or proof of authentication.
// Keep the installed sites.json format while serializing read/modify/write
// across CLI processes. Queries never start Chrome or select an account.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

function registryPath() {
  return path.join(P.stateDir(), 'sites.json');
}

function domainFromUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const value = input.trim();
  // Only HTTP(S) pages can contribute to this index; a file/data URL must
  // never be interpreted as a hostname. Credentials and paths are discarded.
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  if (/^(?:about|file|data|javascript|chrome):/i.test(value)) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // Preserve subdomains: www.example.com and example.com can use different accounts.
    if (!host || /[\s\\/@]/.test(host)) return null;
    return host;
  } catch (_) {
    return null;
  }
}

function profileAvailable(name) {
  if (!P.isValidName(name)) return false;
  const config = P.readJson(P.configPath(name), null);
  if (config && config.attachOnly && typeof config.cdpUrl === 'string') return true;
  try {
    return fs.statSync((config && config.userDataDir) || P.profileDir(name)).isDirectory();
  } catch (_) {
    return false;
  }
}

function normalize(data) {
  const clean = Object.create(null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return clean;
  for (const [domain, entries] of Object.entries(data)) {
    if (domainFromUrl(domain) !== domain || !Array.isArray(entries)) continue;
    const seen = new Set();
    const valid = entries.filter(entry => entry && profileAvailable(entry.profile) &&
      Number.isFinite(entry.lastUsedAt) && entry.lastUsedAt >= 0 && entry.lastUsedAt <= 8640000000000000 &&
      !seen.has(entry.profile) && seen.add(entry.profile)).map(entry => ({
      profile: entry.profile,
      label: typeof entry.label === 'string' ? entry.label : null,
      lastUsedAt: entry.lastUsedAt,
    }));
    if (valid.length) clean[domain] = valid;
  }
  return clean;
}

function load(strict = false) {
  try {
    return normalize(JSON.parse(fs.readFileSync(registryPath(), 'utf8')));
  } catch (error) {
    if (strict && error.code !== 'ENOENT') {
      throw new P.MbError('registry_unreadable', '站点登记表无法读取；保留原文件，请修复后重试。');
    }
    return Object.create(null);
  }
}

async function update(domain, name, label) {
  const normalized = domainFromUrl(domain);
  if (!normalized) throw new P.MbError('usage', '请输入有效的 HTTP(S) 域名或地址。');
  P.requireName(name);
  if (!profileAvailable(name)) throw new P.MbError('not_created', `Profile ${name} 不存在或其数据目录已删除。`);
  P.ensureDir(P.stateDir(), 0o700);
  const lockPath = `${registryPath()}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        // Never steal a lock from another writer (including a suspended one).
        throw new P.MbError('registry_busy', '站点登记表正在写入；若此前进程异常退出，请确认无写入进程后清理 sites.json.lock。');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const data = load(true);
    const entries = data[normalized] || [];
    const entry = entries.find(item => item.profile === name);
    if (entry) {
      if (label !== undefined) entry.label = label || null;
      entry.lastUsedAt = Date.now();
    } else {
      entries.push({ profile: name, label: label || null, lastUsedAt: Date.now() });
    }
    data[normalized] = entries;
    P.writeJson(registryPath(), data);
    return entries.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

async function recordUse(domain, name) {
  if (!domain || !name) return;
  try { await update(domain, name); } catch (_) { /* Navigation already succeeded. */ }
}

function tag(domain, name, label) {
  return update(domain, name, label);
}

function candidatesFor(domain) {
  return (load()[domainFromUrl(domain)] || []).slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function allSites() {
  return load();
}

module.exports = { registryPath, domainFromUrl, recordUse, tag, candidatesFor, allSites };
