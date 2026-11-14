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

test('working is refined by turn stage; imprecise lanes say requesting / thinking', () => {
  const key = v => livenessDisplay('working', v).labelKey;
  assert.equal(key({ stage: 'request', stagePrecise: true }), 'livenessRequesting');
  assert.equal(key({ stage: 'request', stagePrecise: false }), 'livenessRequestingOrThinking');
  assert.equal(key({ stage: 'thinking' }), 'livenessThinking');
  assert.equal(key({ stage: 'tool' }), 'livenessToolRunning');
  assert.equal(key({ stage: 'output' }), 'livenessWorking');
  assert.equal(key({ proxyPhase: 'request' }), 'livenessRequesting');
  assert.equal(key(undefined), 'livenessWorking');
  const fs = require('node:fs');
  const path = require('node:path');
  const catalog = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n-catalog.js'), 'utf8');
  const zh = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'i18n', 'zh.json'), 'utf8');
  const en = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'i18n', 'en.json'), 'utf8');
  for (const k of ['livenessRequesting', 'livenessRequestingOrThinking', 'livenessThinking', 'livenessToolRunning']) {
    assert.ok(catalog.split(`"${k}"`).length - 1 >= 2, `${k} in web catalog zh+en`);
    assert.ok(zh.includes(`"${k}"`) && en.includes(`"${k}"`), `${k} in app json`);
  }
});

test('awaitingRetryMs overrides the stage label so a CLI retry backoff never reads as plain thinking', () => {
  const disp = livenessDisplay('working', { stage: 'thinking', awaitingRetryMs: 45_000 });
  assert.equal(disp.labelKey, 'livenessAwaitingRetry');
  assert.equal(disp.tint, 'running');
  assert.equal(disp.dot, 'working');
  // It wins over every stage refinement, including the imprecise-lane form.
  assert.equal(livenessDisplay('working', { stage: 'request', stagePrecise: false, awaitingRetryMs: 60_000 }).labelKey, 'livenessAwaitingRetry');
  // Without the field the stage label is untouched; null counts as absent.
  assert.equal(livenessDisplay('working', { stage: 'thinking', awaitingRetryMs: null }).labelKey, 'livenessThinking');
  const fs = require('node:fs');
  const path = require('node:path');
  const catalog = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n-catalog.js'), 'utf8');
  const zh = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'i18n', 'zh.json'), 'utf8');
  const en = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'i18n', 'en.json'), 'utf8');
  assert.ok(catalog.split('"livenessAwaitingRetry"').length - 1 >= 2, 'livenessAwaitingRetry in web catalog zh+en');
  assert.ok(zh.includes('"livenessAwaitingRetry"') && en.includes('"livenessAwaitingRetry"'), 'livenessAwaitingRetry in app json');
});
