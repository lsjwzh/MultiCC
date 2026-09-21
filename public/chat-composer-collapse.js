// Air's mobile composer folds away as the reader scrolls back through the
// conversation. At the bottom it is whole — the 配置 band plus the input card.
// Scroll up into the transcript and it shrinks with the gesture, down to a
// thin oval on the bottom edge that carries the unsent draft; tapping it
// brings the whole composer back with the caret already in the input.
//
// Two rules keep the fold from ever taking something away from whoever is
// using it: anything focused inside the composer pins it open, and a draft is
// echoed on the oval instead of being hidden inside it. Those are why the fold
// can be this aggressive without being annoying.
//
// The band is clipped by a wrapper installed here; the card clips itself. Both
// give up their space from the top, so what stays visible is the bottom edge
// the reader is already looking at — and the card's own radius and shadow
// travel with it instead of being cut off by an outer mask.
(function () {
  'use strict';

  var body = document.body;
  if (!body.classList.contains('air-chat')) return;

  // Only phones fold. A desktop window has room for the whole composer, and
  // folding there would be motion for its own sake.
  var PHONE = window.matchMedia('(max-width: 760px)');
  var CALM = window.matchMedia('(prefers-reduced-motion: reduce)');

  // How far the transcript has to scroll away from the bottom, in px, before
  // the composer is completely folded. A feel, not a measurement.
  var FOLD_AT = 220;
  var FOLD_HEIGHT = 40;   // the oval — and the card, once folded
  var BAND_GONE = 0.38;   // the band has faded and closed by here
  var ROUND_FROM = 0.6;   // the card only starts rounding into an oval here
  var EASE = 0.3;         // per-frame approach; light damping eats inertia jitter
  var SETTLE_MS = 150;

  // 文案走 i18n：浏览器里用 i18n.js 的 t()，Node/旧目录回落到中文默认值。
  function tt(key, fallback) {
    var out = typeof window.t === 'function' ? window.t(key) : '';
    return out && out !== key ? out : fallback;
  }

  var doc = document;
  var messages = doc.getElementById('messages');
  var card = doc.getElementById('input-bar');
  var input = doc.getElementById('input');
  if (!messages || !card || !input) return;

  // The band is a sibling of the card that air.js inserts later (and only for
  // a configured task), so this wrapper is installed now and adopts it then.
  var clip = doc.createElement('div');
  clip.id = 'air-band-clip';
  card.parentNode.insertBefore(clip, card);

  var pill = doc.createElement('button');
  pill.id = 'air-composer-pill';
  pill.type = 'button';
  pill.setAttribute('aria-label', tt('airComposerExpand', '展开输入框'));
  var pillText = doc.createElement('span');
  pillText.className = 'ccp-text';
  var pillGo = doc.createElement('span');
  pillGo.className = 'ccp-go';
  pillGo.setAttribute('aria-hidden', 'true');
  pillGo.textContent = '➤';
  pill.append(pillText, pillGo);
  card.append(pill);

  var live = false;
  var p = 0;              // 0 whole · 1 folded
  var frame = null;
  var settleTimer = null;
  var snapTo = null;      // set by the settle snap, cleared on the next gesture
  var geo = { band: 0, card: 0 };
  var dirty = true;

  function clamp(value, low, high) { return value < low ? low : (value > high ? high : value); }

  function bandEl() {
    var el = doc.getElementById('air-composer-meta');
    return el && !el.hidden ? el : null;
  }

  function pinned() {
    var active = doc.activeElement;
    if (!active) return false;
    if (card.contains(active)) return true;
    var band = bandEl();
    return !!(band && band.contains(active));
  }

  // #messages is the scroller, and the composer owns part of its height: as
  // the fold gives space back, "how far from the bottom" shrinks by itself.
  // Slack is that amount, added back so the number that drives the fold is
  // the distance the finger actually travelled.
  function slack() {
    return Math.max(0, geo.band + geo.card - FOLD_HEIGHT);
  }

  function walked() {
    var d = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    return Math.max(0, d) + slack() * p;
  }

  function wanted() {
    if (snapTo !== null) return snapTo;
    if (pinned()) return 0;
    if (messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 2) return 0;
    return clamp(walked() / FOLD_AT, 0, 1);
  }

  // Reading the card's own height while it is folded would just read it back,
  // so the height is lifted for the read and put straight back — no paint
  // happens in between. The band is measured the same way, margins included,
  // because its top margin is space the fold has to give back too.
  function measure() {
    dirty = false;
    var band = bandEl();
    var bandH = 0;
    if (band && band.offsetHeight) {
      var style = getComputedStyle(band);
      bandH = band.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    var held = card.style.height;
    card.style.height = '';
    var cardH = card.offsetHeight;
    card.style.height = held;
    geo = { band: bandH, card: cardH };
  }

  function syncPill() {
    var draft = input.value.trim();
    pillText.textContent = draft || input.placeholder || '输入消息…';
    pill.classList.toggle('has-draft', !!draft);
  }

  // The oval has to cover the card's *border* box. An absolutely positioned
  // child is laid out against its ancestor's padding box instead, so the card's
  // hairline border is stepped over by hand — left to the default, a hairline
  // of the clipped controls shows all the way around the oval.
  function fitPillBox() {
    var style = getComputedStyle(card);
    pill.style.left = -(parseFloat(style.borderLeftWidth) || 0) + 'px';
    pill.style.right = -(parseFloat(style.borderRightWidth) || 0) + 'px';
    pill.style.bottom = -(parseFloat(style.borderBottomWidth) || 0) + 'px';
  }

  function render() {
    if (!live) return;
    if (dirty) measure();
    var total = geo.band + geo.card;
    if (!total) return;
    var visible = total - (total - FOLD_HEIGHT) * p;

    // The band goes first and closes to nothing; the card only starts losing
    // height once the band is spent. Clipping from the top keeps the bottom
    // edge — the buttons row — where the reader last saw it.
    clip.style.height = clamp(visible - geo.card, 0, geo.band) + 'px';
    var cardH = clamp(visible, FOLD_HEIGHT, geo.card);
    card.style.height = cardH + 'px';
    card.style.overflow = 'hidden';

    // Radius stays at the card's own 15px until the last stretch, so the oval
    // arrives at the end of the gesture instead of at the start. The browser
    // clamps it to half the box, which is exactly the stadium we want.
    var round = p < ROUND_FROM ? 15 : 15 + 985 * Math.pow((p - ROUND_FROM) / (1 - ROUND_FROM), 1.5);
    var top = (geo.band && p < BAND_GONE) ? 0 : round;
    card.style.borderTopLeftRadius = card.style.borderTopRightRadius = top + 'px';
    card.style.borderBottomLeftRadius = card.style.borderBottomRightRadius = round + 'px';

    // The oval is opaque, so it may only arrive once it actually covers what is
    // left of the card. Keyed to that, not to a progress value: the card's own
    // height moves with the draft's line count, and progress has no idea.
    var folded = visible <= FOLD_HEIGHT + 6;
    pill.classList.toggle('show', folded);
    if (folded) syncPill();
  }

  function tick() {
    frame = null;
    var to = wanted();
    if (CALM.matches) { p = to; render(); return; }
    p += (to - p) * EASE;
    if (Math.abs(to - p) < 0.004) p = to;
    render();
    if (p !== to) frame = requestAnimationFrame(tick);
  }

  function kick() {
    if (!live) return;
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  function rest() {
    // A gesture that stops between the two ends is a bad place to leave a
    // control, so it settles to the nearer one. The decision uses the position
    // it would come to rest at, not the progress still in flight — at settle
    // time those differ, and it is the resting place that matters.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      if (!live || pinned()) return;
      var at = clamp(walked() / FOLD_AT, 0, 1);
      if (at > 0.18 && at < 0.82) { snapTo = at > 0.5 ? 1 : 0; kick(); }
    }, SETTLE_MS);
  }

  function onScroll() {
    if (!live) return;
    snapTo = null;
    kick();
    rest();
  }

  function expand() {
    snapTo = 0;
    kick();
    // The caret goes in on the next frame: the fold has to be on its way out
    // first, or focusing the input would re-pin a composer that is still shut.
    requestAnimationFrame(function () { input.focus(); });
  }

  // Everything the fold did is handed back, so a frame that stops being a
  // phone (or a rotation back to desktop) is left exactly as it was found.
  function release() {
    live = false;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    clearTimeout(settleTimer);
    p = 0;
    snapTo = null;
    body.classList.remove('air-composer-fold');
    card.style.height = '';
    card.style.overflow = '';
    card.style.borderTopLeftRadius = card.style.borderTopRightRadius = '';
    card.style.borderBottomLeftRadius = card.style.borderBottomRightRadius = '';
    clip.style.height = '';
    pill.style.left = pill.style.right = pill.style.bottom = '';
    pill.classList.remove('show');
  }

  function adopt() {
    if (!PHONE.matches || !card.offsetHeight) { release(); return; }
    if (!live) { live = true; body.classList.add('air-composer-fold'); }
    fitPillBox();
    dirty = true;
    render();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  messages.addEventListener('scroll', onScroll, { passive: true });
  messages.addEventListener('touchstart', function () { snapTo = null; }, { passive: true });
  messages.addEventListener('wheel', function () { snapTo = null; }, { passive: true });

  card.addEventListener('focusin', function () { snapTo = null; kick(); });
  doc.addEventListener('focusout', function () { kick(); rest(); });

  input.addEventListener('input', function () {
    dirty = true;
    syncPill();
    kick();
    // chat.js grows the textarea from its own input handler; measuring after
    // this frame catches that growth instead of the height it had before.
    requestAnimationFrame(function () { if (live) { dirty = true; render(); } });
  });

  pill.addEventListener('click', expand);

  window.addEventListener('resize', function () {
    if (PHONE.matches) adopt(); else release();
  });
  if (PHONE.addEventListener) PHONE.addEventListener('change', adopt);

  // air.js only creates the band once a task is configured, and hides it again
  // for a task that has neither an AI route nor roles. Both change how much
  // room the fold has to give back, so both re-measure.
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var band = doc.getElementById('air-composer-meta');
      if (band && band.parentNode !== clip) {
        clip.append(band);
        new MutationObserver(function () { dirty = true; kick(); })
          .observe(band, { attributes: true, attributeFilter: ['hidden'] });
        // The pills re-label themselves as the task's route changes, which can
        // wrap the band onto a second line: that is room the fold has to know
        // about, or folding would leave the band half-shut.
        if (window.ResizeObserver) {
          new ResizeObserver(function () { if (live) { dirty = true; kick(); } }).observe(band);
        }
      }
    }
    if (!live) return;
    dirty = true;
    kick();
  }).observe(body, { childList: true });

  adopt();
})();
