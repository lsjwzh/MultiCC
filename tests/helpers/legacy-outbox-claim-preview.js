'use strict';

// Frozen first selection pass from the pre-migration Node outbox claim. This
// oracle is limited to the no-candidate path used by the parity test.
function legacyClaimPreview(store, selectSessionItem, at) {
  return store.mutateIf(draft => {
    const leased = draft.select('outbox', { where: { state: 'leased' } });
    if (leased.some(item => item.state === 'leased' && !(item.leasedUntil > at))) return true;
    const itemsBySession = new Map();
    const ordered = draft.select('outbox', { where: { state: { $nin: ['delivered', 'dead-letter', 'cancelled'] } } })
      .sort((a, b) => a.sequence - b.sequence);
    for (const item of ordered) {
      if (['delivered', 'dead-letter', 'cancelled'].includes(item.state)) continue;
      if (!itemsBySession.has(item.sessionId)) itemsBySession.set(item.sessionId, []);
      itemsBySession.get(item.sessionId).push(item);
    }
    const selected = [...itemsBySession.values()].map(items => selectSessionItem(items, draft, at)).filter(Boolean);
    return selected.filter(item => item.state === 'pending' && item.availableAt <= at).length > 0;
  }, () => { throw new Error('legacy preview expected no candidates'); }, () => []);
}

module.exports = { legacyClaimPreview };
