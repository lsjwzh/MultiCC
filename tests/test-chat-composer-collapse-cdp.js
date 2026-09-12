'use strict';
// The folding mobile composer: does scrolling away from the bottom actually
// give the transcript the composer's room, does the composer come back when
// the reader returns to the bottom, and does the fold ever take something
// away from whoever is using it (a caret, a draft)?
//
// Asserted on the real DOM the module leaves behind — the card's height, the
// band wrapper's height, the oval's own state — because the module exports
// nothing and the folded geometry *is* the contract.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildRoutes(publicDir) {
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(css|js)$/.test(f))) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' },
    };
  }
  // The real Chat markup and every stylesheet, with the page's own controllers
  // removed: this is about the fold, not about booting a session.
  const html = fs.readFileSync(path.join(publicDir, 'chat.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*https:\/\/cdn[^>]*>/g, '')
    .replace('<body', '<body class="air-chat"')
    .replace('</body>', '<script src="/chat-composer-collapse.js"></script></body>');
  routes['/'] = { body: html, headers: { 'content-type': 'text/html' } };
  // The same frame as it arrives without ?air=1: chat.html adds .air-chat from
  // the query string, so the fold's gate is a load-time decision.
  routes['/plain'] = {
    body: html.replace('<body class="air-chat"', '<body'),
    headers: { 'content-type': 'text/html' },
  };
  return routes;
}

test('the mobile composer folds into an oval as the transcript is scrolled back', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const publicDir = path.resolve(__dirname, '../public');

  await withCdpHarness({ routes: buildRoutes(publicDir) }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', PHONE);
    // A headless page has no window focus, so focus()/blur() would move
    // activeElement without dispatching events — and the fold's pin rule is
    // driven by exactly those events.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.navigate('/');
    await page.evaluate(`(() => {
      window.__errors = [];
      addEventListener('error', e => window.__errors.push(e.message));
      addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason)));
    })()`);
    assert.ok(await page.waitFor('document.getElementById("air-composer-pill") !== null'),
      'the fold module should install itself on a phone-width Air frame');

    // A transcript long enough to scroll, and the 配置 band air.js would have
    // inserted for a configured task.
    await page.evaluate(String.raw`(() => {
      const scroller = document.getElementById('messages');
      scroller.replaceChildren(...Array.from({ length: 40 }, (_, i) => {
        const el = document.createElement('div');
        el.className = 'msg assistant';
        el.textContent = '历史消息 ' + (i + 1) + ' ' + '内容 '.repeat(24);
        return el;
      }));
      const band = document.createElement('div');
      band.id = 'air-composer-meta';
      band.className = 'mc-composer__aux';
      band.append(
        Object.assign(document.createElement('button'), { className: 'mc-composer__pill mc-composer__pill--ai', textContent: 'Opus 5 · Claude Code' }),
        Object.assign(document.createElement('button'), { className: 'mc-composer__pill', textContent: '角色：未绑定' }),
      );
      document.getElementById('input-bar').before(band);
      scroller.scrollTop = scroller.scrollHeight;
    })()`);
    await sleep(200);

    const state = () => page.evaluate(String.raw`(() => {
      const card = document.getElementById('input-bar');
      const clip = document.getElementById('air-band-clip');
      const pill = document.getElementById('air-composer-pill');
      const band = document.getElementById('air-composer-meta');
      const scroller = document.getElementById('messages');
      return {
        folded: document.body.classList.contains('air-composer-fold'),
        card: Math.round(card.getBoundingClientRect().height * 100) / 100,
        clip: Math.round(clip.getBoundingClientRect().height * 100) / 100,
        bandShown: !!band && !band.hidden,
        pillShown: pill.classList.contains('show'),
        pillFocusable: getComputedStyle(pill).visibility === 'visible',
        pillText: pill.querySelector('.ccp-text').textContent,
        hasDraft: pill.classList.contains('has-draft'),
        radius: parseFloat(getComputedStyle(card).borderBottomLeftRadius),
        focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
        kids: card.children.length,
        cardInline: card.style.height,
        clipInline: clip.style.height,
        viewport: scroller.clientHeight,
        distance: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        bandInClip: !!band && band.parentNode === clip,
      };
    })()`);

    const scrollUp = px => page.evaluate(`(() => { const s = document.getElementById('messages'); s.scrollTop = Math.max(0, s.scrollTop - ${px}); })()`);
    const scrollToBottom = () => page.evaluate(`(() => { const s = document.getElementById('messages'); s.scrollTop = s.scrollHeight; })()`);

    // 1. installed, and at the bottom the composer is whole.
    let s = await state();
    assert.equal(s.folded, true, 'the fold should install on a phone-width Air frame');
    assert.equal(s.bandInClip, true, 'the 配置 band should have been adopted into the clipping wrapper');
    assert.equal(s.pillShown, false, 'nothing is folded at the bottom');
    assert.equal(s.pillFocusable, false, 'an oval that is not shown must stay out of the tab order');
    const wholeCard = s.card;
    const wholeClip = s.clip;
    const wholeViewport = s.viewport;
    const wholeKids = s.kids;
    // Folding hands the composer's room back to the transcript, so a distance
    // read while folded is short by exactly this much: the fold now owns part
    // of the number that drives it, which is the whole point of the module.
    const slack = wholeClip + wholeCard - 40;
    assert.ok(wholeClip > 30, `the band should occupy its own room at rest, got ${wholeClip}px`);
    assert.ok(s.distance <= 2, `expected to start at the bottom, got ${s.distance}px away`);

    // 2. the band goes first: it gives up room before the card loses any.
    //    Sampled mid-gesture — a drag is a stream of scroll events, and the
    //    settle snap below only fires once the gesture stops, so this is also
    //    the only place where "it follows the finger" means anything.
    const dragUp = px => page.evaluate(String.raw`(async () => {
      const s = document.getElementById('messages');
      for (let i = 0; i < 5; i++) {
        s.scrollTop = Math.max(0, s.scrollTop - ${Math.round(px / 5)});
        await new Promise(r => setTimeout(r, 40));
      }
      await new Promise(r => setTimeout(r, 70));
    })()`);
    await dragUp(70);
    s = await state();
    assert.ok(s.clip < wholeClip - 8, `the band should give up room first, clip ${s.clip}px vs ${wholeClip}px`);
    assert.equal(s.card, wholeCard, `the card must not shrink before the band is spent, got ${s.card}px`);

    // 2b. but a gesture that stops between the two ends must not leave the
    //     composer squashed where it happens to have been abandoned: it settles
    //     to the nearer end, which for a nudge this short is wide open.
    await sleep(700);
    s = await state();
    assert.equal(s.card, wholeCard, `a settled nudge should leave the card whole, got ${s.card}px`);
    assert.equal(s.clip, wholeClip, `a settled nudge should reopen the band, got ${s.clip}px`);
    assert.equal(s.pillShown, false, 'nothing is folded after a nudge settles');

    // 2c. and the room comes off the *top* of the card. The card is a wrapped
    //     flex container on a phone, so its rows are packed lines: packed from
    //     the top, a shorter card eats the controls row — the exact buttons the
    //     reader was reaching for. Held open here with the same keep-alive a
    //     finger produces, because a settled mid-position snaps to an end.
    await page.evaluate(String.raw`(() => {
      const s = document.getElementById('messages');
      s.scrollTop = s.scrollHeight - s.clientHeight - 150;
      window.__hold = setInterval(() => s.dispatchEvent(new Event('scroll')), 60);
    })()`);
    await sleep(400);
    const anchored = await page.evaluate(String.raw`(() => {
      const card = document.getElementById('input-bar').getBoundingClientRect();
      const row = document.getElementById('mic-btn').getBoundingClientRect();
      const area = document.getElementById('input').getBoundingClientRect();
      return {
        card: Math.round(card.height),
        rowFits: row.top >= card.top - 0.5 && row.bottom <= card.bottom + 0.5,
        textareaCut: area.top < card.top - 0.5,
      };
    })()`);
    await page.evaluate(`clearInterval(window.__hold)`);
    assert.ok(anchored.card > 40 && anchored.card < wholeCard - 20,
      `expected a half-folded card, got ${anchored.card}px`);
    assert.ok(anchored.rowFits, 'the row of controls must survive the fold intact');
    assert.ok(anchored.textareaCut, 'the card must give up its room from the top');

    await scrollUp(500);
    await sleep(650);
    s = await state();
    assert.ok(s.distance + slack > 500, `expected to be far from the bottom, got ${s.distance + slack}px`);
    assert.equal(s.clip, 0, 'the band should be fully closed when folded');
    assert.equal(s.card, 40, `folded card should be the oval height, got ${s.card}px`);
    assert.equal(s.pillShown, true, 'the oval should carry the composer once folded');
    assert.equal(s.pillFocusable, true, 'the oval in charge of the composer must be reachable');
    assert.ok(s.radius >= 19, `a folded pill needs a stadium radius, got ${s.radius}px`);

    // 4. the room the fold gave up went to the transcript, not into thin air.
    assert.ok(s.viewport > wholeViewport + 30,
      `the transcript should gain the composer's room (${wholeViewport}px → ${s.viewport}px)`);

    // 5. no jitter while resting mid-gesture: a fold driven by scroll position
    //    feeds its own height back into that position, so this is the check
    //    that would catch a feedback loop.
    await scrollToBottom();
    await sleep(650);
    await page.evaluate(`(() => { const s = document.getElementById('messages'); s.scrollTop = s.scrollHeight - s.clientHeight - 150; })()`);
    await sleep(700);
    const samples = [];
    for (let i = 0; i < 8; i++) { samples.push((await state()).card); await sleep(45); }
    const spread = Math.max(...samples) - Math.min(...samples);
    assert.ok(spread < 1, `a resting composer must hold still, sampled ${samples.join(', ')}`);

    // 6. a caret in the composer pins it open, however far the reader scrolls.
    await scrollToBottom();
    await sleep(650);
    await page.evaluate(`document.getElementById('input').focus()`);
    await sleep(80);
    await scrollUp(600);
    await sleep(650);
    s = await state();
    assert.equal(s.focus, 'input', 'the input should still hold the caret');
    assert.equal(s.card, wholeCard, `a focused composer must stay whole, got ${s.card}px`);
    assert.equal(s.pillShown, false, 'a focused composer must not fold');

    // 7. a draft survives the fold, on the oval.
    await page.evaluate(`(() => { const i = document.getElementById('input');
      i.value = '这段草稿不能被收走'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
    await sleep(650);
    s = await state();
    assert.equal(s.pillShown, true, 'blurring should let the composer fold again');
    assert.equal(s.hasDraft, true, 'a draft on the oval should be marked as one');
    assert.match(s.pillText, /这段草稿不能被收走/, `the oval should carry the draft, got "${s.pillText}"`);

    // 8. tapping the oval brings the whole composer back, caret and all.
    await page.evaluate(`document.getElementById('air-composer-pill').click()`);
    await sleep(700);
    s = await state();
    assert.equal(s.card, wholeCard, `tapping the oval should unfold the card, got ${s.card}px`);
    assert.equal(s.pillShown, false, 'the oval should hand the surface back');
    assert.equal(s.focus, 'input', 'the caret should land in the input the oval was standing in for');
    assert.match(await page.evaluate(`document.getElementById('input').value`), /这段草稿不能被收走/);

    // 9. the oval's radius is the card's, so it covers the clipped controls.
    await page.evaluate(`(() => { const i = document.getElementById('input');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
    await sleep(650);
    const cover = await page.evaluate(String.raw`(() => {
      const card = document.getElementById('input-bar').getBoundingClientRect();
      const pill = document.getElementById('air-composer-pill').getBoundingClientRect();
      return { dw: Math.round(card.width - pill.width), dh: Math.round(card.height - pill.height),
               alike: getComputedStyle(document.getElementById('air-composer-pill')).borderBottomLeftRadius
                 === getComputedStyle(document.getElementById('input-bar')).borderBottomLeftRadius };
    })()`);
    assert.equal(cover.dw, 0, 'the oval must span the folded card');
    assert.equal(cover.dh, 0, 'the oval must fill the folded card');
    assert.equal(cover.alike, true, 'the oval must take the card radius, not a square corner');

    // 10. reduced motion lands instead of animating.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await scrollToBottom();
    await sleep(400);
    await scrollUp(500);
    await sleep(300);
    s = await state();
    assert.equal(s.card, 40, `reduced motion should land folded at once, got ${s.card}px`);
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // 11. wide frames never fold at all. The card is taller on a phone than on
    //     a desktop (the phone layout stacks the controls), so what has to hold
    //     here is that every height the fold wrote has been handed back.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await scrollUp(600);
    await sleep(400);
    s = await state();
    assert.equal(s.folded, false, 'a desktop frame must not fold');
    assert.equal(s.pillShown, false, 'a desktop frame must not show the oval');
    assert.ok(s.card > 40, `a desktop frame must keep a whole card, got ${s.card}px`);
    assert.equal(s.cardInline, '', `the fold must release the card's height, found "${s.cardInline}"`);
    assert.equal(s.clipInline, '', `the fold must release the band's height, found "${s.clipInline}"`);

    // 13. and neither does a phone frame once it is narrow enough to matter.
    //     Scoped to the composer: the fold owns the composer's boxes, and in
    //     this fixture the page's own controllers (which lay the header out on
    //     a phone) are deliberately not loaded.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await scrollUp(600);
    await sleep(650);
    const narrow = await page.evaluate(String.raw`(() => {
      const owned = ['air-band-clip', 'input-bar', 'air-composer-pill', 'air-composer-meta'];
      const bad = [];
      for (const id of owned) {
        const root = document.getElementById(id);
        if (!root) continue;
        for (const el of [root, ...root.querySelectorAll('*')]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) bad.push(el.id || el.className || el.tagName);
        }
      }
      return { bad: bad.slice(0, 5), card: Math.round(document.getElementById('input-bar').getBoundingClientRect().height * 100) / 100 };
    })()`);
    assert.deepEqual(narrow.bad, [], `the composer should not overflow at 320px: ${narrow.bad.join(', ')}`);
    assert.equal(narrow.card, 40, `the fold should still work at 320px, got ${narrow.card}px`);

    const errors = await page.evaluate('window.__errors');
    assert.deepEqual(errors, [], `the page should stay quiet: ${errors.join(' | ')}`);

    // 14. the same phone frame without ?air=1 is left completely alone: no
    //     fold, and no stray oval button sitting inside the composer.
    await page.navigate('/plain');
    assert.ok(await page.waitFor('document.getElementById("input-bar") !== null'),
      'the plain frame should still have its composer');
    const plain = await page.evaluate(String.raw`(() => ({
      hasPill: !!document.getElementById('air-composer-pill'),
      folded: document.body.classList.contains('air-composer-fold'),
      kids: document.getElementById('input-bar').children.length,
    }))()`);
    assert.equal(plain.folded, false, 'a frame that is not Air must not fold');
    assert.equal(plain.hasPill, false, 'a frame that is not Air must not be given the oval');
    // The oval is the module's only addition to the composer, so the markup a
    // frame it never touched receives carries exactly one child fewer.
    assert.equal(plain.kids, wholeKids - 1,
      `the composer must be left as it was found, ${plain.kids} children vs ${wholeKids - 1}`);
  });
});
