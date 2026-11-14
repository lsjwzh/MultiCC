'use strict';

const { getNative } = require('../native/runtime');

// Bridge to the diversity kernel (`native/core/src/search_diversity.rs`).
//
// Everything that decides an order lives in Rust — the per-session quota, the
// cross-session content fold, the tie-breaks. This file only projects the hits onto
// the fields the kernel reads and maps the returned indices back to the caller's
// own objects, so a hit keeps its `text`/`snippet` without a round trip.
//
// `score` is the index's flipped bm25 (bigger is better) — see the kernel docs; the
// kernel sorts descending and never rewrites a score.

const DEFAULT_LIMIT = 20;
const DEFAULT_PER_REF_QUOTA = 3;

function payload(hits, { limit, perRefQuota, dedupeContentHash }) {
  return JSON.stringify({
    candidates: hits.map(hit => ({
      refId: String(hit.sessionId || hit.refId || ''),
      contentHash: String(hit.contentHash || ''),
      score: Number(hit.score) || 0,
      updatedAt: Number(hit.updatedAt) || 0,
      taskId: String(hit.taskId || ''),
      dirId: String(hit.dirId || ''),
    })),
    limit,
    perRefQuota,
    dedupeContentHash,
  });
}

// Reorder `hits` and cut them to `limit`. A missing addon throws — the caller owns
// that decision (src/search/runtime.js counts it and falls back to the raw order),
// because silently returning an unranked answer from here would hide the failure.
function rerank(hits, {
  limit = DEFAULT_LIMIT,
  perRefQuota = DEFAULT_PER_REF_QUOTA,
  dedupeContentHash = true,
} = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return [];
  const wanted = Math.max(0, Math.min(list.length, Math.floor(Number(limit)) || 0));
  if (!wanted) return [];
  const answer = JSON.parse(getNative().searchDiversityRerank(payload(list, {
    limit: wanted, perRefQuota, dedupeContentHash,
  })));
  const order = Array.isArray(answer?.order) ? answer.order : [];
  const picked = [];
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= list.length) continue;
    picked.push(list[index]);
    if (picked.length >= wanted) break;
  }
  return picked;
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_PER_REF_QUOTA,
  rerank,
};
