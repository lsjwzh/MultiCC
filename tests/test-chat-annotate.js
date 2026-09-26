'use strict';

// Human-assist screenshot annotation: the text block the web lightbox puts
// into the composer. The App (image_annotate_screen.dart) must emit the same
// bytes; the agent-side contract lives in src/chat/host-prompts.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  serializeAnnotation, refreshText, sourcePathFromUrl, exportFileName, ageText,
} = require('../public/chat-annotate.js');

test('serializes point / box / arrow with normalized 3-decimal coordinates', () => {
  const text = serializeAnnotation({
    src: '/Users/me/.multicc/assist/s1/snap.png',
    width: 1440,
    height: 900,
    marks: [
      { kind: 'point', a: { x: 810, y: 583 }, b: { x: 810, y: 583 }, note: ' 点同意 ' },
      // Dragged bottom-right to top-left: the box is normalized to min/max.
      { kind: 'box', a: { x: 500, y: 470 }, b: { x: 470, y: 330 }, note: '勾上\n这三个' },
      { kind: 'arrow', a: { x: 1152, y: 108 }, b: { x: 994, y: 243 } },
    ],
    note: '先关提示条\r\n再点同意',
  });
  assert.equal(text, [
    '[annotation] src=/Users/me/.multicc/assist/s1/snap.png size=1440x900',
    '#1 point 0.563,0.648 — 点同意',
    '#2 box 0.326,0.367-0.347,0.522 — 勾上 这三个',
    '#3 arrow 0.800,0.120->0.690,0.270',
    'note: 先关提示条 再点同意',
    '[/annotation]',
  ].join('\n'));
});

test('clamps out-of-range coordinates and falls back to src "-"', () => {
  const text = serializeAnnotation({
    src: '', width: 100, height: 50,
    marks: [{ kind: 'point', a: { x: -5, y: 80 } }],
    note: '   ',
  });
  assert.equal(text, '[annotation] src=- size=100x50\n#1 point 0.000,1.000\n[/annotation]');
});

test('refresh text names the stale source', () => {
  assert.equal(refreshText('/tmp/a.png'), '[annotation-refresh] src=/tmp/a.png\n截图已过期或页面已变化，请重新截图后再问我。');
  assert.match(refreshText(''), /^\[annotation-refresh\] src=-\n/);
});

test('source path is only derived from /api/download urls', () => {
  assert.equal(sourcePathFromUrl('/api/download?path=%2FUsers%2Fme%2Fsnap%201.png&inline=1', 'http://h/chat.html'), '/Users/me/snap 1.png');
  assert.equal(sourcePathFromUrl('blob:http://h/uuid', 'http://h/'), '');
  assert.equal(sourcePathFromUrl('/artifacts/x/a.png', 'http://h/'), '');
});

test('export filename and capture age', () => {
  assert.equal(exportFileName('/a/b/snap-1.png', 42), 'annotated-snap-1-42.png');
  assert.equal(exportFileName('', 7), 'annotated-image-7.png');
  const now = Date.parse('2026-09-26T10:00:00Z');
  assert.equal(ageText('Sat, 26 Sep 2026 09:57:00 GMT', now), '截于 3 分钟前');
  assert.equal(ageText('Sat, 26 Sep 2026 07:00:00 GMT', now), '截于 3 小时前');
  assert.equal(ageText('', now), '');
});

test('agent-side contract describes the same block the editors emit', () => {
  const { buildHumanAssistPrompt, createHostPrompts } = require('../src/chat/host-prompts');
  const text = buildHumanAssistPrompt('/data/assist/').join('\n');
  assert.match(text, /`\/data\/assist\/\$MULTICC_SESSION_ID\/`/);
  for (const token of ['[annotation] src=<path> size=WxH', '[/annotation]', '#n point x,y', '#n box x1,y1-x2,y2', '#n arrow x1,y1->x2,y2', ' — <note>', 'note: <overall instructions>', '[annotation-refresh] src=<path>', 'wait_for_user_answer']) {
    assert.ok(text.includes(token), token);
  }
  assert.ok(createHostPrompts({}, { assistRoot: '/data/assist' }).multiccImgHint.includes('[Human assist via annotated screenshots]'));
});
