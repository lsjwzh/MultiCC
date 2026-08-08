'use strict';

// The user's drag-and-drop arrangement — directory grid order, and session order
// inside each fleet — held in memory and mirrored to the server.
//
// This used to be `localStorage.multicc_dir_order`, which made the arrangement a
// property of the *browser*: a second machine, a phone, or a cleared cache each
// started from scratch. It now lives in ui-layout.json on the server (see
// src/ui-layout.js) and this module is the browser's half of that contract.
//
// The order is a hint, never an authority. `applyOrder` puts dragged items first
// in the order the user chose, and everything the user has never dragged after
// them in the caller's own default order — so a session created after the last
// drag appears at the end rather than at some arbitrary position.

(function initUiLayoutStore(root) {
  if (!root) return;

  const LEGACY_DIR_ORDER_KEY = 'multicc_dir_order';

  let _layout = { dirOrder: [], sessionOrder: {} };
  let _loaded = null;

  function adopt(layout) {
    _layout = {
      dirOrder: Array.isArray(layout && layout.dirOrder) ? layout.dirOrder.slice() : [],
      sessionOrder: (layout && layout.sessionOrder && typeof layout.sessionOrder === 'object')
        ? { ...layout.sessionOrder }
        : {},
    };
    return _layout;
  }

  // One-time lift of the pre-server arrangement. Only runs when the server has
  // nothing yet, so a user who has already arranged things on another device
  // never has this browser's stale localStorage overwrite it.
  function legacyDirOrder() {
    try {
      const raw = root.localStorage.getItem(LEGACY_DIR_ORDER_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string' && id) : [];
    } catch (_) { return []; }
  }

  function forgetLegacy() {
    try { root.localStorage.removeItem(LEGACY_DIR_ORDER_KEY); } catch (_) { /* private mode */ }
  }

  async function load() {
    try {
      const res = await root.fetch('/api/ui-layout');
      const body = await res.json();
      adopt(body && body.layout);
    } catch (err) {
      // A layout we could not fetch means default order, not a broken page.
      console.warn('[ui-layout] load failed, using default order:', err && err.message);
      adopt(null);
    }
    if (!_layout.dirOrder.length) {
      const legacy = legacyDirOrder();
      if (legacy.length) await saveDirOrder(legacy);
    }
    forgetLegacy();
    return _layout;
  }

  // Idempotent: every caller can await this, only the first triggers a request.
  function ready() {
    if (!_loaded) _loaded = load();
    return _loaded;
  }

  function dirOrder() { return _layout.dirOrder.slice(); }

  function sessionOrder(dirId) {
    const list = _layout.sessionOrder[dirId];
    return Array.isArray(list) ? list.slice() : [];
  }

  // Writes are optimistic: the caller re-renders immediately off the local copy
  // and the request settles behind it. A failed write leaves the user looking at
  // an arrangement the server does not have, so it is logged and the server's
  // answer (when it comes) wins.
  async function put(url, order, apply) {
    apply();
    try {
      const res = await root.fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      const body = await res.json();
      if (res.ok && body && body.layout) adopt(body.layout);
      else console.warn('[ui-layout] server rejected the new order:', (body && body.error) || res.status);
    } catch (err) {
      console.warn('[ui-layout] save failed:', err && err.message);
    }
  }

  function saveDirOrder(order) {
    const next = order.slice();
    return put('/api/ui-layout/dir-order', next, () => { _layout.dirOrder = next; });
  }

  function saveSessionOrder(dirId, order) {
    const next = order.slice();
    return put(`/api/ui-layout/session-order/${encodeURIComponent(dirId)}`, next, () => {
      if (next.length) _layout.sessionOrder[dirId] = next;
      else delete _layout.sessionOrder[dirId];
    });
  }

  // Sort `items` by the manual order, keeping anything unranked in the order the
  // caller already put it in. `keyOf` extracts the id. The sort is stable in
  // every browser we support (ES2019), which is what makes "unranked items keep
  // the caller's default order" true rather than accidental.
  function applyOrder(items, order, keyOf) {
    if (!order || !order.length) return items.slice();
    const rank = new Map(order.map((id, i) => [id, i]));
    return items
      .map((item, i) => ({ item, i, r: rank.has(keyOf(item)) ? rank.get(keyOf(item)) : Infinity }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i))
      .map(entry => entry.item);
  }

  // Move `draggedId` to where `targetId` currently sits, within `visibleIds`.
  // Returns the full new order: on the very first drag the stored list is empty,
  // so we materialize everything currently on screen — otherwise one dragged card
  // would rank first and every other card would be unranked behind it.
  function reorderAround(visibleIds, draggedId, targetId) {
    const next = visibleIds.slice();
    const from = next.indexOf(draggedId);
    const to = next.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return next;
    next.splice(from, 1);
    next.splice(next.indexOf(targetId) + (from < to ? 1 : 0), 0, draggedId);
    return next;
  }

  // A fleet stores ONE flat list covering every group in it (chats, terminals,
  // anything added later), so a drag inside one group must not wipe the others.
  // `stored` is what the fleet had; `groupOrder` is the dragged group's full new
  // order. Ids from other groups are carried over untouched.
  //
  // Where they land in the flat list does not matter: `applyOrder` runs per
  // group, and a rank is only ever compared against ranks of ids in the same
  // group. Putting the dragged group first is just the cheapest way to write it.
  function mergeGroupOrder(stored, groupOrder) {
    const inGroup = new Set(groupOrder);
    return groupOrder.concat((stored || []).filter(id => !inGroup.has(id)));
  }

  root.MultiCCUiLayout = {
    ready, load, dirOrder, sessionOrder, saveDirOrder, saveSessionOrder,
    applyOrder, reorderAround, mergeGroupOrder,
  };
})(typeof window !== 'undefined' ? window : null);
