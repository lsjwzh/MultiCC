'use strict';

// Regenerate tests/fixtures/quota-gating-golden.json from the web gating module
// (public/chat-rate-limit.js) over the shared input table in
// tests/helpers/quota-gating-cases.js.
//
//   node scripts/generate-quota-gating-fixture.js          # verify (exit 1 on drift)
//   node scripts/generate-quota-gating-fixture.js --write  # rewrite the fixture
//
// The web module is the authority: it is the implementation the browser runs and
// the one the app's Dart mirror is written against. Regenerating after a rule
// change produces a small, reviewable diff of exactly the cells that moved —
// that diff is the review of the change, and the same fixture then holds the
// Dart mirror to it (app/test/quota_gating_parity_test.dart).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'tests', 'fixtures', 'quota-gating-golden.json');

const api = require(path.join(root, 'public', 'chat-rate-limit'));
const { buildGatingFixture, BASE_URLS, CLIS, WINDOW_KINDS } = require(path.join(root, 'tests', 'helpers', 'quota-gating-cases'));

function render() {
  return `${JSON.stringify(buildGatingFixture(api), null, 2)}\n`;
}

function main() {
  const write = process.argv.includes('--write');
  const next = render();
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  if (write) {
    if (current === next) { console.log(`quota gating fixture already current (${BASE_URLS.length} baseUrls × ${WINDOW_KINDS.length} kinds × ${CLIS.length} clis)`); return; }
    fs.writeFileSync(target, next);
    console.log(`Generated ${path.relative(root, target)} (${BASE_URLS.length} baseUrls, ${WINDOW_KINDS.length} kinds, ${CLIS.length} clis)`);
    return;
  }

  if (current === next) { console.log('Quota gating fixture OK'); return; }

  // Point at the cells that moved instead of dumping two 20KB blobs.
  const before = current ? JSON.parse(current) : {};
  const after = JSON.parse(next);
  const drift = [];
  for (const section of ['providerMatchesCliIn', 'balanceBarVisibleFor', 'baseUrlTraits']) {
    const b = before[section] || {}, a = after[section] || {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const bs = JSON.stringify(b[key]), as = JSON.stringify(a[key]);
      if (bs !== as) drift.push(`  ${section}.${key}: ${bs ?? '(absent)'} → ${as ?? '(absent)'}`);
    }
  }
  console.error(`Quota gating fixture is STALE — ${drift.length} cell(s) differ from ${'public/chat-rate-limit.js'}:\n${drift.slice(0, 40).join('\n')}${drift.length > 40 ? `\n  … ${drift.length - 40} more` : ''}\n\nReview the cells, then run:\n  node scripts/generate-quota-gating-fixture.js --write\nand mirror the change in app/lib/models/vendor_quota.dart.`);
  process.exit(1);
}

main();
