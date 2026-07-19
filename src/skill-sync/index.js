'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const NEVER_SYNCED_STATUS = Object.freeze({
  ts: 0,
  status: 'never-synced',
  providers: null,
  linkCount: 0,
  skipCount: 0,
  convCount: 0,
  reverseImportCount: 0,
  bundledInstallCount: 0,
  sharedSkillCount: 0,
  sharedSkillNames: [],
  aiQueue: { queueLength: 0, items: [], timerActive: false },
  error: null,
});

function runningError() {
  const error = new Error('sync already running');
  error.code = 'SKILL_SYNC_RUNNING';
  return error;
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('skill sync dependencies are required');
  for (const name of ['fs', 'path', 'os', 'crypto', 'chokidar', 'skillConverter']) {
    if (!deps[name]) throw new TypeError(`skill sync dependency missing: ${name}`);
  }
  for (const name of ['cwdForSession', 'startDetached']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`skill sync dependency missing: ${name}`);
  }
  if (!deps.persistedSessions || typeof deps.persistedSessions.values !== 'function') {
    throw new TypeError('skill sync dependency missing: persistedSessions');
  }
  return deps;
}

function createSkillSyncRuntime(rawDeps) {
  const deps = assertDependencies(rawDeps);
  const {
    fs,
    path,
    os,
    crypto,
    chokidar,
    skillConverter,
    persistedSessions,
    cwdForSession,
    startDetached,
    rootDir,
    claudeCommand,
    auxSessionId,
    logger = console,
  } = deps;
  const agentsSkillsDir = deps.agentsSkillsDir || skillConverter.AGENTS_ROOT;
  const providers = deps.providers || [
    { name: 'claude', dir: path.join(os.homedir(), '.claude', 'skills'), protectedSubdirs: [] },
    { name: 'codex', dir: path.join(os.homedir(), '.codex', 'skills'), protectedSubdirs: ['.system'] },
    { name: 'hermes', dir: path.join(os.homedir(), '.hermes', 'skills'), protectedSubdirs: [] },
  ];
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const syncIntervalMs = deps.syncIntervalMs || 5 * 60 * 1000;

  let lastResult = null;
  let running = false;
  let started = false;
  let acceptingAiConversions = false;
  let watcher = null;
  let periodicTimer = null;
  const inFlightAiConversions = new Set();

  function publicSkillError(error) {
    const value = error && typeof error === 'object' ? error.message : error;
    return sanitizePublicText(value, 'skill sync failed');
  }

  function readSkillVersion(dir) {
    try { return fs.readFileSync(path.join(dir, '.skill-version'), 'utf8').trim(); }
    catch (_) { return null; }
  }

  function isSkillDir(dir) {
    try {
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md'));
    } catch (_) {
      return false;
    }
  }

  function listSharedSkillNames() {
    try {
      return fs.readdirSync(agentsSkillsDir)
        .filter(name => !name.startsWith('.') && isSkillDir(path.join(agentsSkillsDir, name)))
        .sort();
    } catch (_) {
      return [];
    }
  }

  function recordResult(partial) {
    const previous = lastResult || {};
    const next = partial || {};
    const sharedSkillNames = listSharedSkillNames();
    let aiQueue = { queueLength: 0, items: [], timerActive: false };
    try {
      if (typeof skillConverter.getAiQueueStatus === 'function') {
        aiQueue = skillConverter.getAiQueueStatus();
      }
    } catch (_) {}
    lastResult = {
      ts: Date.now(),
      providers: next.providers || previous.providers || null,
      linkCount: next.linkCount != null ? next.linkCount : (previous.linkCount || 0),
      skipCount: next.skipCount != null ? next.skipCount : (previous.skipCount || 0),
      convCount: next.convCount != null ? next.convCount : (previous.convCount || 0),
      reverseImportCount: next.reverseImportCount != null
        ? next.reverseImportCount
        : (previous.reverseImportCount || 0),
      bundledInstallCount: next.bundledInstallCount != null
        ? next.bundledInstallCount
        : (previous.bundledInstallCount || 0),
      sharedSkillCount: sharedSkillNames.length,
      sharedSkillNames,
      aiQueue,
      error: next.error !== undefined
        ? (next.error === null ? null : publicSkillError(next.error))
        : (previous.error || null),
    };
    return lastResult;
  }

  function recordBackgroundFailure(label, error) {
    const message = publicSkillError(error);
    try { recordResult({ error: message }); } catch (_) {}
    logger.warn(`[multicc/skills] ${label} failed: ${message}`);
  }

  function getStatus() {
    return lastResult || NEVER_SYNCED_STATUS;
  }

  function installBundledSkills() {
    const sourceRoot = path.join(rootDir, 'skills');
    let names;
    try { names = fs.readdirSync(sourceRoot); }
    catch (_) { return 0; }
    let installed = 0;
    for (const name of names) {
      try {
        const source = path.join(sourceRoot, name);
        if (!isSkillDir(source)) continue;
        const destination = path.join(agentsSkillsDir, name);
        if (fs.existsSync(destination)
            && readSkillVersion(destination) === readSkillVersion(source)) continue;
        fs.mkdirSync(agentsSkillsDir, { recursive: true });
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(source, destination, { recursive: true });
        try {
          for (const file of fs.readdirSync(path.join(destination, 'bin'))) {
            fs.chmodSync(path.join(destination, 'bin', file), 0o755);
          }
        } catch (_) {}
        installed++;
        logger.log(`[multicc/skills] imported bundled -> ~/.agents/skills/${name}`);
      } catch (error) {
        logger.warn(`[multicc/skills] install bundled ${name} failed: ${publicSkillError(error)}`);
      }
    }
    return installed;
  }

  function syncSharedSkills() {
    const providerCounts = {};
    for (const provider of providers) {
      providerCounts[provider.name] = { linked: 0, skipped: 0, converted: 0 };
    }

    let agentNames;
    try { agentNames = fs.readdirSync(agentsSkillsDir); }
    catch (_) {
      return recordResult({ linkCount: 0, skipCount: 0, convCount: 0, providers: providerCounts });
    }

    for (const provider of providers) {
      const counts = providerCounts[provider.name];
      fs.mkdirSync(provider.dir, { recursive: true });
      const protectedSet = new Set(provider.protectedSubdirs || []);

      for (const name of agentNames) {
        if (protectedSet.has(name)) continue;
        const source = path.join(agentsSkillsDir, name);
        if (!isSkillDir(source)) continue;

        if (provider.name !== 'claude') {
          const conversion = skillConverter.ensureSkillConverted(name);
          if (conversion.mechanical.length > 0) counts.converted++;
        }

        const linkSource = skillConverter.getLinkTarget(name, provider.name);
        if (!linkSource) continue;
        const destination = path.join(provider.dir, name);

        try {
          const stat = fs.lstatSync(destination);
          if (stat.isSymbolicLink()) {
            try {
              if (fs.realpathSync(destination) === fs.realpathSync(linkSource)) continue;
            } catch (_) {}
          }
        } catch (_) {}

        if (fs.existsSync(destination) && !fs.lstatSync(destination).isSymbolicLink()) {
          if (readSkillVersion(destination) === null) continue;
          try { fs.rmSync(destination, { recursive: true, force: true }); }
          catch (_) { counts.skipped++; continue; }
        }

        try { fs.unlinkSync(destination); } catch (_) {}
        try {
          fs.symlinkSync(linkSource, destination);
          counts.linked++;
        } catch (error) {
          logger.warn(`[multicc/skills] symlink ${provider.name} ← ${name}: ${publicSkillError(error)}`);
          counts.skipped++;
        }
      }
    }

    let linkCount = 0;
    let skipCount = 0;
    let convCount = 0;
    for (const name of Object.keys(providerCounts)) {
      linkCount += providerCounts[name].linked;
      skipCount += providerCounts[name].skipped;
      convCount += providerCounts[name].converted;
    }
    if (linkCount > 0 || skipCount > 0 || convCount > 0) {
      logger.log(`[multicc/skills] shared sync: ${linkCount} linked, ${skipCount} skipped, ${convCount} converted`);
    }
    return recordResult({ linkCount, skipCount, convCount, providers: providerCounts });
  }

  async function queueAiSkillConversions(batch) {
    if (!acceptingAiConversions) return;
    const host = [...persistedSessions.values()].find(
      session => session.id !== auxSessionId && (session.cli || 'claude') !== 'codex',
    );
    if (!host) {
      logger.warn(`[multicc/skills] AI skill conversion skipped (${batch.length} skill(s)): no claude session to host the detached job`);
      return;
    }

    for (const { skillName, provider } of batch) {
      if (!acceptingAiConversions) return;
      const spec = skillConverter.buildAiConvertPrompt(skillName, provider);
      if (!spec) continue;
      const promptFile = path.join(
        os.tmpdir(),
        `multicc-skillconv-${crypto.randomBytes(8).toString('hex')}.txt`,
      );
      await fs.promises.writeFile(promptFile, spec.prompt, { encoding: 'utf8', mode: 0o600 });
      if (!acceptingAiConversions) {
        await fs.promises.rm(promptFile, { force: true }).catch(() => {});
        return;
      }
      const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
      const command = [
        `PROMPT_FILE=${shellQuote(promptFile)}`,
        `trap 'rm -f -- "$PROMPT_FILE"' EXIT`,
        `mkdir -p ${shellQuote(spec.outputDir)}`,
        `${shellQuote(claudeCommand)} -p "$(cat "$PROMPT_FILE")" --allowedTools "Bash,Read,Write,Edit" --output-format text --max-turns 3 2>&1`,
      ].join('; ');
      logger.log(`[multicc/skills] queued AI conversion: ${skillName} → ${provider}`);
      try {
        await startDetached({
          sessionId: host.id,
          idempotencyKey: null,
          spec: {
            command,
            cwd: cwdForSession(host),
            label: `skillconv-${skillName}→${provider}`,
            daemon: false,
            intervalSec: 10,
            maxChecks: 360,
            injectPrefix: `[技能转换完成] ${skillName} → ${provider}`,
          },
        });
      } catch (error) {
        await fs.promises.rm(promptFile, { force: true }).catch(() => {});
        logger.warn(`[multicc/skills] AI conversion submit failed (${skillName}->${provider}): ${publicSkillError(error)}`);
      }
    }
  }

  skillConverter.onAiConvertNeeded((batch) => {
    if (!acceptingAiConversions) return;
    let task;
    task = queueAiSkillConversions(batch)
      .catch((error) => {
        logger.warn(`[multicc/skills] AI conversion batch failed: ${publicSkillError(error)}`);
      })
      .finally(() => inFlightAiConversions.delete(task));
    inFlightAiConversions.add(task);
  });

  function syncFromWatcher() {
    try {
      syncSharedSkills();
    } catch (error) {
      recordBackgroundFailure('watch sync', error);
    }
  }

  function syncFromTimer() {
    try {
      const imported = skillConverter.importAllProviderSkills();
      syncSharedSkills();
      recordResult({ reverseImportCount: (imported || []).length, error: null });
    } catch (error) {
      recordBackgroundFailure('periodic sync', error);
    }
  }

  function watchSharedSkills() {
    if (watcher) return;
    try {
      if (!fs.existsSync(agentsSkillsDir)) return;
      watcher = chokidar.watch(agentsSkillsDir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
      });
      watcher.on('addDir', syncFromWatcher);
      watcher.on('unlinkDir', syncFromWatcher);
      watcher.on('error', error => recordBackgroundFailure('watcher', error));
      logger.log('[multicc/skills] watching ~/.agents/skills for changes');
    } catch (_) {
      // Periodic polling remains the fallback.
    }
  }

  function runNow() {
    if (running) throw runningError();
    running = true;
    try {
      const bundled = installBundledSkills();
      const reverseImports = skillConverter.importAllProviderSkills();
      syncSharedSkills();
      return recordResult({
        bundledInstallCount: bundled,
        reverseImportCount: (reverseImports || []).length,
        error: null,
      });
    } catch (error) {
      try { recordResult({ error: publicSkillError(error) }); } catch (_) {}
      throw error;
    } finally {
      running = false;
    }
  }

  function start() {
    if (started) return getStatus();
    acceptingAiConversions = true;
    const bundled = installBundledSkills();
    let reverseImports = [];
    try {
      reverseImports = skillConverter.importAllProviderSkills() || [];
      syncSharedSkills();
    } catch (error) {
      recordBackgroundFailure('startup sync', error);
    }
    recordResult({
      bundledInstallCount: bundled,
      reverseImportCount: reverseImports.length,
    });
    watchSharedSkills();
    try {
      periodicTimer = setIntervalFn(syncFromTimer, syncIntervalMs);
    } catch (error) {
      recordBackgroundFailure('timer setup', error);
    }
    if (periodicTimer && typeof periodicTimer.unref === 'function') periodicTimer.unref();
    started = Boolean(periodicTimer);
    return getStatus();
  }

  async function stop() {
    acceptingAiConversions = false;
    if (periodicTimer) {
      clearIntervalFn(periodicTimer);
      periodicTimer = null;
    }
    try {
      if (typeof skillConverter.stop === 'function') skillConverter.stop();
    } catch (_) {}
    if (inFlightAiConversions.size) {
      await Promise.allSettled([...inFlightAiConversions]);
    }
    if (watcher) {
      const activeWatcher = watcher;
      watcher = null;
      try { await activeWatcher.close(); } catch (_) {}
    }
    started = false;
  }

  return {
    getStatus,
    isRunning: () => running,
    runNow,
    start,
    stop,
    installBundledSkills,
    syncSharedSkills,
    queueAiSkillConversions,
  };
}

module.exports = {
  NEVER_SYNCED_STATUS,
  createSkillSyncRuntime,
};
