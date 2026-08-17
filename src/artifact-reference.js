'use strict';

const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,254}$/;
const ARTIFACT_PREFIX = '/artifacts/';
const MAX_REFERENCES = 256;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const START_BOUNDARIES = new Set(['"', "'", '`', '(', '<', '[', '{', '=', '：']);
const END_BOUNDARIES = new Set(['"', "'", '`', '(', ')', '<', '>', '[', ']', '{', '}', ',', ';', '!']);

function isArtifactId(value) {
  return typeof value === 'string' && ARTIFACT_ID_RE.test(value);
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\')) return null;
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) return null;
  const segments = trimmed.split('/');
  if (segments.length > 32 || segments.some(segment => (
    !segment || segment === '.' || segment === '..' || !PATH_SEGMENT_RE.test(segment)
  ))) return null;
  return segments.join('/');
}

function isInsideExternalLocator(text, index) {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1]) && !END_BOUNDARIES.has(text[start - 1])) {
    start -= 1;
  }
  const prefix = text.slice(start, index);
  return /[A-Za-z][A-Za-z0-9+.-]*:/.test(prefix) || /(^|=)\/\//.test(prefix);
}

function canStartAt(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1];
  return (/\s/.test(previous) || START_BOUNDARIES.has(previous))
    && !isInsideExternalLocator(text, index);
}

function referencesInText(value) {
  const text = String(value || '');
  const result = [];
  let cursor = 0;
  while (cursor < text.length && result.length < MAX_REFERENCES) {
    const index = text.indexOf(ARTIFACT_PREFIX, cursor);
    if (index < 0) break;
    cursor = index + ARTIFACT_PREFIX.length;
    if (!canStartAt(text, index)) continue;
    let end = cursor;
    while (end < text.length && !/\s/.test(text[end]) && !END_BOUNDARIES.has(text[end])) end += 1;
    const raw = text.slice(cursor, end);
    const queryAt = raw.search(/[?#]/);
    const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
    const slashAt = pathname.indexOf('/');
    const artifactId = slashAt < 0 ? pathname : pathname.slice(0, slashAt);
    const relativePath = normalizeRelativePath(slashAt < 0 ? '' : pathname.slice(slashAt + 1));
    if (isArtifactId(artifactId) && relativePath !== null) {
      result.push({ artifactId, relativePath });
    }
  }
  return result;
}

function compareReferences(left, right) {
  if (left.artifactId !== right.artifactId) return left.artifactId < right.artifactId ? -1 : 1;
  if (left.relativePath === right.relativePath) return 0;
  return left.relativePath < right.relativePath ? -1 : 1;
}

function extractArtifactReferences(content) {
  const references = new Map();
  const visited = new WeakSet();
  let nodes = 0;

  function add(artifactId, relativePath = '') {
    if (references.size >= MAX_REFERENCES || !isArtifactId(artifactId)) return;
    const normalizedPath = normalizeRelativePath(relativePath);
    if (normalizedPath === null) return;
    const key = `${artifactId}\u0000${normalizedPath}`;
    if (!references.has(key)) references.set(key, { artifactId, relativePath: normalizedPath });
  }

  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH || references.size >= MAX_REFERENCES) return;
    if (typeof value === 'string') {
      for (const reference of referencesInText(value)) add(reference.artifactId, reference.relativePath);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'artifactId') && isArtifactId(value.artifactId)) {
      const relativePath = Object.prototype.hasOwnProperty.call(value, 'relativePath')
        ? normalizeRelativePath(value.relativePath) : '';
      if (relativePath !== null) add(value.artifactId, relativePath);
    }
    if (Array.isArray(value.artifactIds)) {
      for (const artifactId of value.artifactIds) add(artifactId, '');
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }

  visit(content, 0);
  return [...references.values()].sort(compareReferences);
}

module.exports = {
  ARTIFACT_ID_RE,
  extractArtifactReferences,
  isArtifactId,
  normalizeRelativePath,
};
