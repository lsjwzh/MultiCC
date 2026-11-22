'use strict';

// Differential: the retired `src/cli-adapters/claude-exp-history.js`
// `hasNativeHistory` (frozen as tests/helpers/legacy-claude-exp-history.js)
// versus the Rust owner `getNative().claudeExpHasNativeHistory`, now called by
// the turn engine directly.
//
// The decision logic under test is the gating: which record shapes reach the
// on-disk transcript probe and which fail closed. The probe itself
// (project-directory walk under the Claude config dir) is shared machinery
// with its own tests; here both sides point at the same fixture tree so the
// probe verdict is identical and only the gating can diverge.
//
// Corpus sweeps: cliSessionId presence/shape/case, cli lane, every
// pendingCliHandoff shape, and the three probe states (no projects tree,
// empty tree, transcript present). A case where the two sides return
// different booleans fails the test. The mutation block proves the comparison
// can turn red.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getNative } = require('../src/native/runtime');
const legacy = require('./helpers/legacy-claude-exp-history');

const SESSION_UUID = '05de20f7-563a-4d09-af34-b748c7b189ca';
const PENDING_NEW = { status: 'pending', toCli: 'claude-exp', reusedTarget: false };

function fixture(t, withTranscript) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-exp-history-diff-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  if (withTranscript === 'empty-projects') {
    fs.mkdirSync(path.join(configDir, 'projects', 'some-project'), { recursive: true });
  } else if (withTranscript === 'present') {
    const project = path.join(configDir, 'projects', 'SDK-custom-or-hashed-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION_UUID}.jsonl`), '{}\n');
  }
  return configDir;
}

// One boolean per (record, fixture) pair from each side; the fixture matters
// only for the shapes that actually reach the probe.
function sweep(t, nativeFn, legacyFn) {
  const trees = {
    none: fixture(t),
    empty: fixture(t, 'empty-projects'),
    present: fixture(t, 'present'),
  };
  const handoffs = [
    ['absent', undefined],
    ['null', null],
    ['pending new', PENDING_NEW],
    ['reused target', { ...PENDING_NEW, reusedTarget: true }],
    ['consumed', { ...PENDING_NEW, status: 'consumed' }],
    ['other lane', { ...PENDING_NEW, toCli: 'claude' }],
    ['reusedTarget missing', { status: 'pending', toCli: 'claude-exp' }],
  ];
  const ids = [
    ['null', null],
    ['empty', ''],
    ['not a uuid', 'not-a-uuid'],
    ['uuid', SESSION_UUID],
    ['uppercase uuid', SESSION_UUID.toUpperCase()],
  ];
  const clis = ['claude-exp', 'claude', 'codex', undefined];
  const divergences = [];
  let probed = 0;
  for (const [treeLabel, configDir] of Object.entries(trees)) {
    for (const [handoffLabel, pendingCliHandoff] of handoffs) {
      for (const [idLabel, cliSessionId] of ids) {
        for (const cli of clis) {
          const record = { cli, cliSessionId, pendingCliHandoff };
          const label = `${treeLabel} / ${handoffLabel} / ${idLabel} / ${cli}`;
          const before = legacyFn(record, { configDir });
          const after = nativeFn(record, { configDir });
          if (after !== before) divergences.push(`${label}: legacy=${before} native=${after}`);
          if (treeLabel === 'present' && before === true && pendingCliHandoff
            && pendingCliHandoff.status === 'pending' && pendingCliHandoff.toCli === 'claude-exp'
            && pendingCliHandoff.reusedTarget === false && cli === 'claude-exp') probed += 1;
        }
      }
    }
  }
  return { divergences, probed };
}

test('claude-exp history gating: native matches the frozen Node oracle across the corpus', t => {
  const native = getNative().claudeExpHasNativeHistory.bind(getNative());
  const { divergences, probed } = sweep(t, native, legacy.hasNativeHistory);
  assert.deepEqual(divergences, [], `divergences:\n${divergences.join('\n')}`);
  assert.ok(probed > 0, 'coverage hole: no case reached the transcript-present probe path');
});

test('the differential turns red when the oracle is tampered with', t => {
  const native = getNative().claudeExpHasNativeHistory.bind(getNative());
  // A tampered oracle that fails open on missing ids (returns true) must
  // diverge from both the real oracle and the native side.
  const tampered = (record, options) => (record.cliSessionId ? legacy.hasNativeHistory(record, options) : true);
  const { divergences } = sweep(t, native, tampered);
  assert.ok(divergences.length > 0, 'a fail-open oracle must be caught');
  assert.ok(divergences.every(line => line.includes('/ null') || line.includes('/ empty')),
    'the divergence is attributable to exactly the tampered branch');
});
