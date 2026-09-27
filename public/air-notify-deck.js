'use strict';

// The Air page's floating reminder, as a deck of cards (③ in air-task-notify.js).
//
//   one reminder   → one card in the bottom-right corner, same as it always was
//   several        → they stack into a deck (most important on top: error >
//                    waiting > completed, newest first within a kind) with a
//                    count badge; clicking the deck fans the cards out along a
//                    quarter arc anchored at the corner
//   fanned out     → each card keeps its own [打开] [✕]; the scrim, Esc or
//                    [收起] fold it back; a card that leaves flies away and the
//                    rest re-lay out. Narrow screens get a column instead of
//                    an arc (an arc wider than the phone is useless).
//
// This module only draws. Which tasks are on the deck is decided by the
// notifier: it calls upsert() when a task needs attention and remove() when
// the task was opened or no longer needs you. ✕ takes a card off the deck
// only; the sidebar row stays marked until the task is actually opened.
//
// Motion is transform/opacity transitions only (no keyframes, no backdrop
// blur — see tests/test-air-paint-budget.js), so nothing animates once the
// cards have settled.
(function installNotifyDeck(root) {
  const PRIORITY = { completed: 1, waiting: 2, error: 3 };
  const CARD_W = 224;          // fanned-out card size, must match air.css
  const CARD_H = 58;
  const GAP = 8;
  const LIFT = 30;             // the tilted leftmost card dips ~25px below its anchor
  const MAX_ON_ARC = 6;
  const NARROW_PX = 640;
  const LEAVE_MS = 320;
  const STAGGER_MS = 45;

  function create(options) {
    const opts = options || {};
    const win = opts.window || root;
    const doc = opts.document || win.document;
    const t = typeof opts.translate === 'function' ? opts.translate : key => key;
    const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : () => {};
    const schedule = opts.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    const items = new Map();   // id → { task, kind, at }
    const cards = new Map();   // id → element
    let deck = null;
    let scrim = null;
    let hub = null;
    let badge = null;
    let hint = null;
    let more = null;
    let open = false;

    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const setVar = (node, name, value) => node.style?.setProperty?.(name, value);

    function build() {
      if (deck) return;
      scrim = el('div', 'task-notify-scrim');
      scrim.onclick = () => setOpen(false);
      deck = el('div', 'task-notify-deck');
      deck.setAttribute('role', 'region');
      deck.setAttribute('aria-label', t('deckLabel'));
      hub = el('button', 'task-notify-hub', t('deckCollapse'));
      hub.type = 'button';
      hub.onclick = event => { event?.stopPropagation?.(); setOpen(false); };
      badge = el('div', 'task-notify-badge');
      hint = el('div', 'task-notify-hint');
      more = el('div', 'task-notify-more');
      deck.append(hub, badge, hint, more);
      doc.body.append(scrim, deck);
      doc.addEventListener?.('keydown', event => { if (event.key === 'Escape' && open) setOpen(false); });
      win.addEventListener?.('resize', () => { if (open) render(); });
    }

    function titleKey(kind) {
      return kind === 'error' ? 'floatTitleError' : kind === 'waiting' ? 'floatTitleWaiting' : 'floatTitle';
    }
    function bodyKey(kind) {
      return kind === 'error' ? 'errored' : kind === 'waiting' ? 'waiting' : 'completed';
    }

    function buildCard(id) {
      const card = el('div', 'task-notify-card');
      card.setAttribute('role', 'alert');
      const text = el('div', 'task-notify-text');
      const title = el('div', 'task-notify-title');
      const body = el('div', 'task-notify-body');
      text.append(title, body);
      const actions = el('div', 'task-notify-actions');
      const openBtn = el('button', 'task-complete-open', t('floatOpen'));
      openBtn.type = 'button';
      const close = el('button', 'task-complete-close', t('floatClose'));
      close.type = 'button';
      close.setAttribute('aria-label', t('floatClose'));
      actions.append(openBtn, close);
      card.append(text, actions);
      openBtn.onclick = event => {
        event?.stopPropagation?.();
        const item = items.get(id);
        remove(id);
        if (item) onOpen(item.task);
      };
      close.onclick = event => { event?.stopPropagation?.(); remove(id); };
      // The folded deck opens from anywhere on its top card except the buttons.
      card.onclick = () => { if (!open && items.size > 1) setOpen(true); };
      card._title = title;
      card._body = body;
      deck.appendChild(card);
      return card;
    }

    function ordered() {
      return [...items.entries()]
        .sort(([, a], [, b]) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0) || b.at - a.at);
    }

    // Quarter arc from straight up (90°) to straight left (180°) around a
    // centre just inside the corner. An ellipse, because the cards are wide:
    // spreading sideways costs less height. The radius grows until neighbours
    // stop overlapping but never past the viewport, so every card stays on screen.
    function arc(n) {
      const angles = Array.from({ length: n }, (_, i) => 90 + 90 * (n === 1 ? 0.5 : i / (n - 1)));
      const maxRx = Math.max(CARD_W, (win.innerWidth || 1280) - CARD_W - 48);
      const maxRy = Math.max(CARD_H, (win.innerHeight || 800) - CARD_H - 60 - LIFT);
      const at = r => angles.map(deg => {
        const rad = deg * Math.PI / 180;
        return [Math.cos(rad) * Math.min(r * 1.9, maxRx), -Math.sin(rad) * Math.min(r, maxRy)];
      });
      const clear = pts => pts.every((p, i) => i === 0
        || Math.abs(p[0] - pts[i - 1][0]) >= CARD_W + GAP
        || Math.abs(p[1] - pts[i - 1][1]) >= CARD_H + GAP);
      let r = 200;
      while (!clear(at(r)) && r < Math.max(maxRx, maxRy)) r += 10;
      // Cards are anchored by their bottom-right corner. The whole arc sits
      // LIFT px up so the tilted leftmost card clears the bottom of the screen.
      return at(r).map(([dx, dy], i) => ({
        x: dx, y: dy - LIFT, r: (90 - angles[i]) * 0.07,
      }));
    }
    function column(n) {
      return Array.from({ length: n }, (_, i) => ({ x: 0, y: -(i + 1) * (CARD_H + GAP) - 40, r: 0 }));
    }

    function render() {
      if (!deck) return;
      const list = ordered();
      const n = list.length;
      const shown = Math.min(n, MAX_ON_ARC);
      const narrow = (win.innerWidth || 1280) < NARROW_PX;
      const spots = open ? (narrow ? column(shown) : arc(shown)) : [];
      list.forEach(([id, item], i) => {
        let card = cards.get(id);
        if (!card) { card = buildCard(id); cards.set(id, card); }
        card._title.textContent = t(titleKey(item.kind)) + ' ·';
        card._body.textContent = t(bodyKey(item.kind), { title: item.task?.title || item.task?.id || '' });
        card.className = `task-notify-card k-${item.kind}${i === 0 ? ' is-top' : ''}`;
        card.style.zIndex = String(40 - i);
        if (open && i >= shown) {
          // past the arc's capacity: tucked behind the corner, counted by `more`
          setVar(card, '--x', '0px'); setVar(card, '--y', '0px'); setVar(card, '--r', '0deg');
          setVar(card, '--s', '.8'); setVar(card, '--o', '0');
          card.inert = true;
        } else if (open) {
          const p = spots[i];
          setVar(card, '--x', p.x.toFixed(1) + 'px');
          setVar(card, '--y', p.y.toFixed(1) + 'px');
          setVar(card, '--r', p.r.toFixed(2) + 'deg');
          setVar(card, '--s', '1'); setVar(card, '--o', '1');
          setVar(card, '--d', (i * STAGGER_MS) + 'ms');
          card.inert = false;
        } else {
          // folded: the next cards peek 7px above, a little smaller, 3 layers max
          const depth = Math.min(i, 3);
          setVar(card, '--x', '0px');
          setVar(card, '--y', (-depth * 7) + 'px');
          setVar(card, '--r', '0deg');
          setVar(card, '--s', String(1 - depth * 0.04));
          setVar(card, '--o', i > 3 ? '0' : '1');
          setVar(card, '--d', ((n - 1 - i) * 25) + 'ms');
          card.inert = i > 0;
        }
      });
      deck.hidden = n === 0;
      deck.classList.toggle('is-open', open);
      deck.classList.toggle('is-narrow', narrow);
      deck.classList.toggle('is-multi', n > 1);
      scrim.classList.toggle('is-on', open);
      badge.textContent = String(n);
      hint.textContent = n > 1 && !open ? t('deckHint', { n }) : '';
      more.textContent = open && n > MAX_ON_ARC ? t('deckMore', { n: n - MAX_ON_ARC }) : '';
    }

    function setOpen(next) {
      next = !!next && items.size > 1;
      if (next === open) return;
      open = next;
      render();
    }

    function upsert(task, kind) {
      const id = String(task?.id || '').trim();
      if (!id) return;
      build();
      const leaving = cards.get(id);
      if (leaving?.classList.contains('is-leaving')) { leaving.remove(); cards.delete(id); }
      items.set(id, { task, kind: PRIORITY[kind] ? kind : 'completed', at: now() });
      render();
    }

    function remove(taskId) {
      const id = String(taskId || '');
      if (!items.delete(id)) return false;
      const card = cards.get(id);
      if (card) {
        card.classList.add('is-leaving');
        card.inert = true;
        schedule(() => { if (cards.get(id) === card && !items.has(id)) { card.remove(); cards.delete(id); } }, LEAVE_MS);
      }
      if (items.size <= 1) open = false;
      render();
      return true;
    }

    function clear() {
      for (const id of [...items.keys()]) remove(id);
    }

    return Object.freeze({
      upsert,
      remove,
      clear,
      has: id => items.has(String(id || '')),
      size: () => items.size,
      ids: () => ordered().map(([id]) => id),
      isOpen: () => open,
      setOpen,
    });
  }

  const api = Object.freeze({ create, MAX_ON_ARC });
  root.MultiCCNotifyDeck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
