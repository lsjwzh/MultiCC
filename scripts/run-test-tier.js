'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'tests', 'test-tiers.json');
const RELEASE_CORE_LANES = Object.freeze(['deterministic', 'isolated', 'flutter']);

function parseArgs(argv) {
  const options = { tier: 'core', lane: null, dryRun: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) options.tier = rest.shift();
  while (rest.length) {
    const option = rest.shift();
    if (option === '--dry-run') options.dryRun = true;
    else if (option === '--lane') {
      options.lane = rest.shift();
      if (!options.lane) throw new Error('--lane requires a value');
    }
    else throw new Error(`unknown option: ${option}`);
  }
  if (options.tier !== 'core') throw new Error(`release runner only accepts the core tier (got: ${options.tier})`);
  if (options.lane && !RELEASE_CORE_LANES.includes(options.lane)) {
    throw new Error(`unknown core lane: ${options.lane}`);
  }
  return options;
}

function variantsOf(entry) {
  return Array.isArray(entry.variants) && entry.variants.length
    ? entry.variants
    : [{ id: 'default', args: [] }];
}

function buildPlan(manifest, options = {}) {
  const tier = options.tier || 'core';
  const lane = options.lane || null;
  const root = options.root || ROOT;
  const node = options.node || process.execPath;
  const flutter = options.flutter || 'flutter';
  const entries = (manifest.tests || []).filter(entry => (
    entry.tier === tier && (!lane || entry.lane === lane)
  ));

  if (!entries.length) throw new Error(`test tier selection is empty: ${tier}${lane ? `/${lane}` : ''}`);
  const unsupported = entries.filter(entry => !RELEASE_CORE_LANES.includes(entry.lane));
  if (unsupported.length) {
    throw new Error(`core release plan contains unsupported lanes: ${[
      ...new Set(unsupported.map(entry => entry.lane)),
    ].join(', ')}`);
  }

  const commands = [];
  for (const laneName of RELEASE_CORE_LANES.slice(0, 2)) {
    if (lane && lane !== laneName) continue;
    for (const entry of entries.filter(candidate => candidate.lane === laneName)) {
      for (const variant of variantsOf(entry)) {
        commands.push({
          lane: laneName,
          label: variant.id === 'default' ? entry.path : `${entry.path}#${variant.id}`,
          command: node,
          args: [entry.path, ...variant.args],
          cwd: root,
          paths: [entry.path],
        });
      }
    }
  }

  if (!lane || lane === 'flutter') {
    const flutterEntries = entries.filter(entry => entry.lane === 'flutter');
    const plain = flutterEntries.filter(entry => !entry.variants);
    if (plain.length) {
      commands.push({
        lane: 'flutter',
        label: `flutter core (${plain.length} files)`,
        command: flutter,
        args: ['test', ...plain.map(entry => path.posix.relative('app', entry.path))],
        cwd: path.join(root, 'app'),
        paths: plain.map(entry => entry.path),
      });
    }
    for (const entry of flutterEntries.filter(entry => entry.variants)) {
      for (const variant of variantsOf(entry)) {
        commands.push({
          lane: 'flutter',
          label: `${entry.path}#${variant.id}`,
          command: flutter,
          args: ['test', path.posix.relative('app', entry.path), ...variant.args],
          cwd: path.join(root, 'app'),
          paths: [entry.path],
        });
      }
    }
  }

  return { tier, lane, entries, commands };
}

function displayArg(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayCommand(step, root = ROOT) {
  const relativeCwd = path.relative(root, step.cwd) || '.';
  const command = [step.command, ...step.args].map(displayArg).join(' ');
  return relativeCwd === '.' ? command : `(cd ${displayArg(relativeCwd)} && ${command})`;
}

async function runStep(step) {
  console.log(`\n[release core/${step.lane}] ${step.label}`);
  console.log(`$ ${displayCommand(step)}`);
  // A legacy isolated test still has an opt-in CDP branch. Release-core means
  // its normal server path only, even if a developer exported the lab flag.
  const env = { ...process.env, MULTICC_SHELL_BROWSER_TEST: '0' };
  const child = spawn(step.command, step.args, { cwd: step.cwd, env, stdio: 'inherit' });
  const forward = signal => child.kill(signal);
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) {
      const status = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
      throw new Error(`${step.label} failed (${status})`);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const plan = buildPlan(manifest, options);
  const counts = Object.fromEntries(RELEASE_CORE_LANES.map(lane => [
    lane,
    plan.entries.filter(entry => entry.lane === lane).length,
  ]));
  console.log(`[release core] manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  console.log(`[release core] selected ${plan.entries.length} entries: `
    + RELEASE_CORE_LANES.map(lane => `${lane}=${counts[lane]}`).join(', '));
  console.log(`[release core] execution plan: ${plan.commands.length} command(s)`);

  if (options.dryRun) {
    for (const step of plan.commands) console.log(`[${step.lane}] ${displayCommand(step)}`);
    return;
  }
  for (const step of plan.commands) await runStep(step);
  console.log(`\nPASS release core tier (${plan.entries.length} manifest entries)`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[release core] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { RELEASE_CORE_LANES, buildPlan, displayCommand, parseArgs };
