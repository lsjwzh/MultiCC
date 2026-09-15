'use strict';
const { hash, estimateTokens } = require('../task-shell/context');

function terms(value) {
  const text = String(value || '').toLowerCase();
  const result = text.match(/[a-z0-9_./-]{2,}/g) || [];
  for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2));
  }
  return [...new Set(result)].slice(0, 256);
}
function relevance(query, text) {
  const tokens = terms(query), haystack = String(text || '').toLowerCase();
  return tokens.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
}
function clipTokens(text, budget) {
  if (estimateTokens(text) <= budget) return text;
  if (budget < estimateTokens('…')) return '';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + '…') <= budget) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).replace(/[\uD800-\uDBFF]$/, '') + '…';
}
// Budget includes wrappers and source labels. Omitted content is never cited.
function selectContext(candidates, { budget = 8000, header = '', footer = '' } = {}) {
  budget = Math.max(0, Math.floor(Number(budget) || 0));
  const sources = [], omitted = [], seen = new Set();
  let body = '';
  for (const source of [...candidates].sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)))) {
    const text = String(source.excerpt || '');
    const digest = hash(source.dedupeText || text);
    if (!text || seen.has(digest)) { omitted.push({ id: source.id, reason: 'duplicate' }); continue; }
    seen.add(digest);
    const prefix = source.label ? `[${source.label}]\n` : '';
    const available = Math.min(source.maxTokens || Infinity, budget - estimateTokens(header + body + prefix + '\n' + footer) - 1);
    const excerpt = source.atomic ? (estimateTokens(text) <= available ? text : '') : clipTokens(text, available);
    if (!excerpt || (excerpt !== text && estimateTokens(excerpt) < 24)) {
      omitted.push({ id: source.id, reason: 'budget' }); continue;
    }
    const chunk = prefix + excerpt + '\n';
    if (estimateTokens(header + body + chunk + footer) > budget) { omitted.push({ id: source.id, reason: 'budget' }); continue; }
    body += chunk;
    sources.push({ ...source, version: source.version || hash(text), excerpt,
      truncated: source.truncated === true || excerpt !== text, estimatedTokens: estimateTokens(chunk) });
  }
  const text = body ? header + body + footer : '';
  return { text, sources, omitted, budget: { limit: budget, used: estimateTokens(text), managedOnly: true } };
}
module.exports = { terms, relevance, clipTokens, selectContext };
