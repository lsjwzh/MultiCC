'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isArtifactId } = require('./native/binding').artifactReference;

const TEXT_FILES = /\.(?:html?|css|[cm]?js|json|map|svg|xml|md|txt|ya?ml)$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const referenceCache = new Map();

function artifactIdFromUrl(url) {
  const id = typeof url === 'string' && url.match(/^\/artifacts\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1];
  return isArtifactId(id) ? id : null;
}

// Follow actual publication dependencies, including nested CSS/JS references.
// No network requests, code execution or traversal through filesystem symlinks.
function references(text, relativeFile) {
  const ids = new Set();
  const decoded = text.replace(/\\\//g, '/');
  const links = /(?:^|[\s"'`(<\[={])((?:\/artifacts\/|\.{1,2}\/)[^\s"'`<>\])}]+)/g;
  for (const match of decoded.matchAll(links)) {
    try {
      const url = new URL(match[1], 'https://artifact.invalid/artifacts/' + relativeFile);
      const id = artifactIdFromUrl(url.pathname);
      if (id) ids.add(id);
    } catch (_) { /* a malformed link is not a dependency */ }
  }
  return ids;
}

function permanentArtifactIds(entries, roots) {
  const kept = new Set(), pending = [], declared = new Map();
  const add = id => { if (isArtifactId(id) && !kept.has(id)) { kept.add(id); pending.push(id); } };
  for (const entry of entries) {
    const id = artifactIdFromUrl(entry.url);
    const related = Array.isArray(entry.relatedArtifactIds) ? entry.relatedArtifactIds.filter(isArtifactId) : [];
    if (id) declared.set(id, [...(declared.get(id) || []), ...related]);
    if (entry.permanent) { add(id); related.forEach(add); }
  }
  let bytes = 0, files = 0;
  function scan(file, relative) {
    if (++files > MAX_FILES) throw new Error('artifact dependency scan exceeded file limit');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) scan(path.join(file, name), relative + '/' + name);
    } else if (stat.isFile() && TEXT_FILES.test(file)) {
      bytes += stat.size;
      // Fail closed: the caller must skip cleanup if a complete graph cannot
      // be read. Never delete dependencies based on a silently truncated scan.
      if (bytes > MAX_BYTES) throw new Error('artifact dependency scan exceeded byte limit');
      const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      let cached = referenceCache.get(file);
      if (!cached || cached.fingerprint !== fingerprint) {
        cached = { fingerprint, ids: references(fs.readFileSync(file, 'utf8'), relative) };
        if (referenceCache.size >= 1000) referenceCache.delete(referenceCache.keys().next().value);
        referenceCache.set(file, cached);
      }
      cached.ids.forEach(add);
    }
  }
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (index > MAX_FILES) throw new Error('artifact dependency scan exceeded artifact limit');
    (declared.get(id) || []).forEach(add);
    for (const root of roots) {
      // A linked root must never turn a bounded scan into a scan of other data.
      try { if (fs.lstatSync(root).isSymbolicLink()) continue; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      scan(path.join(root, id), id);
    }
  }
  return kept;
}

module.exports = { artifactIdFromUrl, permanentArtifactIds };
