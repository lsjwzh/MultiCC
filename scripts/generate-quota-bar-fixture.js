'use strict';

// Regenerate the `expected` half of tests/fixtures/quota-bar-golden.json.
//
//   node scripts/generate-quota-bar-fixture.js          # verify (exit 1 on drift)
//   node scripts/generate-quota-bar-fixture.js --write  # rewrite the fixture
//
// The fixture had no generator until now: it claimed to be generated, so when
// the resolver changed there was no way to regenerate it and no way to tell a
// hand-edit from a regeneration. The `bar` and `state` fields are the fixed
// INPUTS (a server-rendered bar + which alternative render is on screen) and are
// never rewritten here — only `expected` is, from the resolver the browser and
// the app both mirror. A rule change therefore shows up as a small diff of
// exactly the affected cells, in the same fixture app/test/quota_bar_render_test.dart
// reads.
//
// What this does NOT pin: the renderer (src/quota/quota-bar-view.js) itself,
// because the fixture stores no renderer inputs — the bars in it are constants.
// Regenerating from the renderer would need a case to carry {kind,value,opts};
// see the structural review for that gap.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'tests', 'fixtures', 'quota-bar-golden.json');

const { resolveQuotaBar } = require(path.join(root, 'public', 'quota-bar-view'));

function build() {
  const fixture = JSON.parse(fs.readFileSync(target, 'utf8'));
  const cases = fixture.cases.map((c) => {
    const view = resolveQuotaBar(c.bar, { state: c.state, now: fixture.now });
    if (!view) throw new Error(`case ${c.name}: a bar must resolve to a view, never null`);
    return {
      name: c.name,
      bar: c.bar,
      ...(c.state === undefined ? {} : { state: c.state }),
      expected: {
        text: view.text,
        colorHex: view.color,
        title: view.title,
        action: view.action ?? null,
      },
    };
  });
  return { ...fixture, cases };
}

function main() {
  const write = process.argv.includes('--write');
  const next = `${JSON.stringify(build(), null, 2)}\n`;
  const current = fs.readFileSync(target, 'utf8');

  if (write) {
    if (current === next) { console.log('quota bar fixture already current'); return; }
    fs.writeFileSync(target, next);
    console.log(`Generated ${path.relative(root, target)}`);
    return;
  }

  if (current === next) { console.log('Quota bar fixture OK'); return; }

  const before = JSON.parse(current);
  const after = JSON.parse(next);
  const drift = [];
  for (let i = 0; i < after.cases.length; i++) {
    const b = JSON.stringify(before.cases[i]?.expected), a = JSON.stringify(after.cases[i]?.expected);
    if (b !== a) drift.push(`  ${after.cases[i].name}:\n    ${b}\n → ${a}`);
  }
  console.error(`Quota bar fixture is STALE — ${drift.length} case(s) differ from public/quota-bar-view.js:\n${drift.join('\n')}\n\nReview, then run:\n  node scripts/generate-quota-bar-fixture.js --write\nand mirror the change in app/lib/models/quota_bar_view.dart.`);
  process.exit(1);
}

main();
