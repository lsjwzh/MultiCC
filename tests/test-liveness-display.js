'use strict';

// Unit test for the pure frontend liveness display mapping
// (public/chat-live-ui.js `livenessDisplay`). Mirrors the classifyDisplay
// pattern: a transport-liveness state → { tint, dot, labelKey }. Pinned so the
// header pill's colour/label can't silently drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const { livenessDisplay } = require('../public/chat-live-ui');

test('working maps to a running tint, working dot, and the working label key', () => {
  assert.deepEqual(livenessDisplay('working'), { tint: 'running', dot: 'working', labelKey: 'livenessWorking' });
});

test('stalled maps to an error tint and stalled dot', () => {
  assert.deepEqual(livenessDisplay('stalled'), { tint: 'error', dot: 'stalled', labelKey: 'livenessStalled' });
});

test('idle maps to a neutral idle descriptor', () => {
  assert.deepEqual(livenessDisplay('idle'), { tint: 'idle', dot: 'idle', labelKey: 'livenessIdle' });
});

test('unknown / any unrecognized state falls back to the unknown descriptor', () => {
  const fallback = { tint: 'idle', dot: 'unknown', labelKey: 'livenessUnknown' };
  assert.deepEqual(livenessDisplay('unknown'), fallback);
  assert.deepEqual(livenessDisplay(''), fallback);
  assert.deepEqual(livenessDisplay(undefined), fallback);
  assert.deepEqual(livenessDisplay('nonsense'), fallback);
});

test('every label key it can return exists in the i18n catalog (zh + en)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const catalog = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n-catalog.js'), 'utf8');
  for (const state of ['working', 'idle', 'stalled', 'unknown']) {
    const key = livenessDisplay(state).labelKey;
    // Each key must appear at least twice (Chinese + English blocks).
    const occurrences = catalog.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `${key} must be defined in both zh and en (found ${occurrences})`);
  }
});
