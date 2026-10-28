'use strict';

// Development/build tooling only. Packaged applications use their own addon.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function cacheRoot(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'],
    { encoding: 'utf8', timeout: 10_000 });
  const main = result.status === 0 && result.stdout.split('\0').find(item => item.startsWith('worktree '));
  if (main) return path.join(main.slice(9), 'data', 'rust-source');
  // Source archives have no primary worktree. Keep their cache outside the tree.
  const id = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.cache', 'multicc', 'rust-source', id);
}

function sourceFingerprint(repoRoot, env = process.env) {
  const hash = createHash('sha256').update('multicc-source-rust-v1\0');
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(repoRoot, relative), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory() && !['target', 'prebuilt'].includes(entry.name)) walk(rel);
      else if (entry.isFile() && (/\.rs$/.test(entry.name) || ['Cargo.toml', 'Cargo.lock', 'config.toml'].includes(entry.name))) {
        const body = fs.readFileSync(path.join(repoRoot, rel));
        hash.update(rel.split(path.sep).join('/') + '\0' + body.length + '\0').update(body);
      }
    }
  }
  walk('native');
  for (const name of ['build-rust-kernels.js', 'rust-source-cache.js']) {
    hash.update(name + '\0').update(fs.readFileSync(path.join(repoRoot, 'scripts', name)));
  }
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CFLAGS']) {
    hash.update(key + '\0' + (env[key] || '') + '\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function sourcePaths(repoRoot, env = process.env) {
  repoRoot = path.resolve(repoRoot);
  const fingerprint = sourceFingerprint(repoRoot, env);
  const root = cacheRoot(repoRoot);
  // One target directory per checkout keeps worktrees from replacing each
  // other's Cargo output. The final addon path is immutable per source hash.
  const checkout = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return { fingerprint, prebuiltDir: path.join(root, fingerprint),
    targetDir: env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'multicc-rust-source-target', checkout) };
}

// Which source produced an addon: `<addon>.source.json` holds the source
// fingerprint and the sha256 of the exact bytes. A shared output directory can
// be overwritten by a build from another checkout, so a reader must check both
// that the record describes the file on disk and that it names today's source.
function provenancePath(file) {
  return `${file}.source.json`;
}

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeProvenance(file, fingerprint) {
  const record = provenancePath(file);
  const temporary = `${record}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ fingerprint, sha256: fileSha256(file) })}\n`);
  fs.renameSync(temporary, record);
}

function builtFromSource(file, fingerprint) {
  try {
    const record = JSON.parse(fs.readFileSync(provenancePath(file), 'utf8'));
    return !!record && record.fingerprint === fingerprint && record.sha256 === fileSha256(file);
  } catch (_) {
    return false;
  }
}

function probeAddon(file, node = process.execPath) {
  if (!fs.existsSync(file)) return false;
  // A separate process avoids require() caching and contains invalid binaries.
  const script = `const a=require(process.argv[1]);
    if(a.protocolVersion?.()!==1 || a.cprProtocolVersion?.()!==1 || typeof a.cprClaudeQuota!=='function' || typeof a.cprBackendSettings!=='function' || typeof a.cprCreateExchange!=='function' || typeof a.RustDatabase!=='function' || typeof a.remoteScreenBackendSettings!=='function'
      || typeof a.buildSearchIndex!=='function' || typeof a.computeUsage!=='function') process.exit(1);
    if(['providerStore','providerCredential','readProviderCliCredential','accountSubscriptionPlan',
      'accountSubscriptionResult','queryAccountSubscription','RustProviderRequest','authorizeProviderRequest',
      'codexOfficialError'].some(key=>typeof a[key]!=='function')) process.exit(1);
    const db=new a.RustDatabase(':memory:',false,false,5000);
    db.exec('CREATE TABLE smoke(x); CREATE VIRTUAL TABLE f USING fts5(x)');db.close();
    if(typeof a.validatePublicationText!=='function' || typeof a.quickCommitMessage!=='function'
      || typeof a.gitCommitEnvironment!=='function' || typeof a.validatePublicationRecords!=='function'
      || typeof a.planTaskContextRead!=='function' || typeof a.selectTaskContextRecords!=='function'
      || typeof a.rankTaskContextCandidates!=='function' || typeof a.RustTaskReadModel!=='function' || a.taskReadModelProtocolVersion?.()!==1) process.exit(1);
    (async()=>{ const model=new a.RustTaskReadModel();
      const run=async command=>JSON.parse((await model.run(JSON.stringify({op:'air',command}))).result);
      await run({op:'open',epoch:'preflight'});
      const published=await run({op:'publish',snapshot:{tasks:[]},dayStarts:[0]});
      if(!published.ready || !Array.isArray(published.stats)) throw Error('air_protocol_mismatch');
      const encoded=await run({op:'serialized'});
      if(typeof encoded.etag!=='string' || JSON.parse(encoded.body).tasks.length!==0) throw Error('air_protocol_mismatch');
      await model.run('{"op":"close"}');
    })().catch(()=>process.exit(1));`;
  const result = spawnSync(node, ['-e', script, path.resolve(file)], { stdio: 'ignore', timeout: 15_000 });
  return result.status === 0;
}

module.exports = { cacheRoot, sourceFingerprint, sourcePaths, probeAddon, provenancePath, writeProvenance, builtFromSource };
