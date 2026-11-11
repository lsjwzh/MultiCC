'use strict';

// Differential entry for the Auto Provider migration fixtures.
//
// The actual comparison happens in scripts/generate-auto-provider-fixtures.js:
// it renders every case twice (frozen oracle + live src), asserts they are
// JSON-identical, and then compares the result byte-for-byte with the committed
// fixture. This test only proves that the generator is runnable and hermetic in
// a child process and that the fixtures still cover the required surface.
//
// Each section runs in its own child process with an isolated HOME, TMPDIR and
// MULTICC_DATA_DIR, and with every proxy variable pinned to a closed loopback
// port. That way a stray filesystem or network dependency cannot be masked by
// the test runner's environment.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const GENERATOR = path.join(root, 'scripts', 'generate-auto-provider-fixtures.js');
const FIXTURE_DIR = path.join(root, 'native', 'core', 'tests', 'fixtures');
const DEAD_PROXY = 'http://127.0.0.1:9';

const SECTIONS = [
  {
    section: 'pricing',
    fixture: 'auto-provider-pricing.json',
    minimumCases: 33,
  },
  {
    section: 'selectionKey',
    fixture: 'auto-provider-selection-key.json',
    minimumCases: 10,
  },
  {
    section: 'routing',
    fixture: 'auto-provider-routing.json',
    minimumCases: 41,
  },
  {
    section: 'runtime',
    fixture: 'auto-provider-runtime.json',
    minimumCases: 97,
  },
];

const ORACLES = [
  'legacy-auto-provider-pricing.js',
  'legacy-auto-provider-selection-key.js',
  'legacy-auto-provider-routing.js',
  'legacy-auto-provider-runtime.js',
].map(name => path.join(root, 'tests', 'helpers', name));

function countCases(section, fixture) {
  if (section === 'runtime') {
    return fixture.scenarios.reduce((total, scenario) => total + scenario.steps.length, 0);
  }
  return Array.isArray(fixture.cases) ? fixture.cases.length : 0;
}

function runSection(section) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-auto-provider-${section}-`));
  try {
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      MULTICC_DATA_DIR: path.join(home, 'data'),
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      ALL_PROXY: DEAD_PROXY,
      GLOBAL_AGENT_HTTP_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      all_proxy: DEAD_PROXY,
      NO_PROXY: '',
      no_proxy: '',
    };
    const result = spawnSync(process.execPath, [GENERATOR, '--section', section], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const target of SECTIONS) {
  test(`auto-provider ${target.section} fixture verifies in an isolated child`, () => {
    const result = runSection(target.section);
    assert.strictEqual(result.status, 0, `generator failed for ${target.section}:\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`${target.fixture.replace(/\./g, '\\.')}: current \\d+ cases`));

    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, target.fixture), 'utf8'));
    const actual = countCases(target.section, fixture);
    // Print the actual count so a shrinking fixture is visible in CI logs even
    // when the assertion passes.
    process.stdout.write(`# ${target.fixture}: ${actual} cases\n`);
    assert.ok(actual >= target.minimumCases, `${target.fixture} has ${actual} cases, expected at least ${target.minimumCases}`);
    assert.ok(Array.isArray(fixture.comment) && fixture.comment.length > 0, `${target.fixture} is missing its provenance comment`);
  });
}

test('auto-provider fixtures are hermetic (no host paths or timestamps)', () => {
  for (const target of SECTIONS) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, target.fixture), 'utf8');
    assert.ok(!text.includes(root), `${target.fixture} leaks the worktree path`);
    assert.ok(!text.includes(os.homedir()), `${target.fixture} leaks the home directory`);
    // Recorded routing decisions legitimately carry the gateway endpoint the
    // retained config resolved; it is data, not a request. What must never leak
    // is a host path or a wall-clock timestamp.
    assert.ok(!/"(?:at|succeededAt|fetchedAt)":\s*1[6-9]\d{11}/.test(text), `${target.fixture} looks like it captured a real wall clock`);
  }
});

test('generator and frozen oracles never start services or dial out', () => {
  const files = [GENERATOR, ...ORACLES];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const name = path.relative(root, file);
    assert.ok(!/\bchild_process\b/.test(text), `${name} requires child_process`);
    assert.ok(!/require\(\s*['"](?:node:)?https?['"]\s*\)/.test(text), `${name} requires an HTTP client`);
    assert.ok(!/\bhttps?\.request\s*\(/.test(text), `${name} calls http.request`);
    assert.ok(!/\bfetch\s*\(/.test(text), `${name} calls fetch`);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/.test(text), `${name} contains an external URL literal`);
  }

  const generator = fs.readFileSync(GENERATOR, 'utf8');
  assert.ok(generator.includes('127.0.0.1:9'), 'generator does not pin the proxy to a closed loopback port');
  assert.ok(generator.includes('globalThis.fetch ='), 'generator does not install the fetch trap');
  assert.ok(generator.includes('oracle and src disagree'), 'generator is missing the oracle-vs-src guard');
});
