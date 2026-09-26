'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { gitExportSessionBundle, gitImportSessionBundle } = require('../git/service');
const { createHandoffEnvService } = require('../session/handoff-env');
const { createZip, readZip, looksLikeZip } = require('../session/handoff-zip');
const { DOCS_REGISTRY_RULE } = require('../memory/builtin-rules');

const execFileAsync = promisify(execFile);
const PROJECT_DOC_FILES = ['CLAUDE.md', 'AGENTS.md'];
const PROJECT_DOC_CAP = 256 * 1024;
const ZIP_BODY_LIMIT = '160mb';
const ZIP_MAX_ENTRIES = 6000;
const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// The repository identity both ends of a handoff compare: export records it as
// a context dependency, import reads the target's to decide whether the code
// layer means anything here. No origin (or not a repo) is null, which reads as
// "cannot tell" rather than "different".
async function readRepoRemote(dirPath) {
  if (!dirPath) return null;
  try {
    const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'],
      { cwd: dirPath, encoding: 'utf8' });
    return String(remote.stdout || '').trim() || null;
  } catch (_) { return null; }
}

// Task attribution is machine-local. A carried message's taskId, taskName,
// taskShortCode, taskStart, taskSource, taskText and auxRunId all name work
// that happened on the SOURCE machine: on the target they name tasks that do
// not exist, and on a same-instance re-import they name live tasks the copy
// never belonged to — after which retention refuses to release the session
// (TASK_HISTORY_REFERENCED) and no board/session delete cascade can complete.
// The imported copy is deliberately task-agnostic, so the whole family goes.
//
// `_handoffArchive` marks an assistant entry as a deliberate archive record.
// Normalization's retry-dedup pass collapses a prefix-contained assistant pair
// unless the earlier one is protected — locally that protection is the task
// reference we just removed, so the archive carries its own reason to be kept.
const SOURCE_TASK_STAMP_FIELDS = [
  'taskId', 'taskName', 'taskShortCode', 'taskStart', 'taskSource', 'taskText', 'auxRunId',
];

function stripSourceTaskStamps(message) {
  const clean = { ...message };
  for (const field of SOURCE_TASK_STAMP_FIELDS) delete clean[field];
  if (clean.role === 'assistant' && !clean._interim) clean._handoffArchive = true;
  return clean;
}

// Cross-machine handoff routes (Happier-parity: move a live session to another
// machine). Two container formats share one payload builder / one restore path:
//
//   GET  /api/sessions/:id/bundle      → single AES-256-GCM encrypted JSON (v1/v2)
//   GET  /api/sessions/:id/bundle.zip  → real zip (v3): skills/assets/git ride as
//                                        real deflated files; chat history and
//                                        memories stay inside the encrypted
//                                        manifest.json entry
//   POST /api/sessions/import          → accepts the JSON bundle body
//   POST /api/sessions/import-zip      → accepts the zip bytes (raw body)
//
// The payload is three layers, and the point of a handoff is the first one:
//
//   env      the execution environment — the skills the session relied on
//            (?skillsMode=auto|explicit|none, ?skills=a,b), the memory waterfall
//            scopes (?scopes=), and the context dependencies a teammate needs
//            (repo remote, branches, project instruction files). Restored into
//            the scope each file came from, so machine-global knowledge stays
//            machine-global instead of being demoted into one session's private
//            folder. Idempotent: a local file always wins.
//   context  the conversation — chat history, the session's private memory, and
//            the local files it references. ?context=0 exports without it.
//   code     a `git bundle` of the session's worktree branch (?git=0 skips it),
//            replayed only when both machines name the same repository.
//
// Import decides where the context and code layers land: by default a fresh
// session is rebuilt, `targetSessionId` merges into an existing one, and
// `envOnly=1` installs just the environment layer — no session and no directory
// required. A session that receives the import also gets a HANDOFF.md manifest.
//
// The sensitive half (chat, memories, project docs) is always passphrase-
// encrypted (PBKDF2 + AES-256-GCM) whichever container is used.
//
// Provider state deliberately does NOT travel (see the removal note in the
// collect path); the target machine picks its own provider.
//
// Mutable host state (chatHistoryService, folderMemory, skillSyncRuntime) is
// read through getters so a runtime that is composed after this module mounts
// is still resolved at request time rather than captured as a stale null
// snapshot.

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[session-bundle] ${name} must be a function`);
  }
}

function createSessionBundleRoutes(rawDeps) {
  const deps = rawDeps || {};
  const {
    persistedSessions,
    directories,
    asyncHandler,
    appendEvent,
    createSessionRecord,
    loadChatHistory,
    getChatHistoryService,
    getFolderMemory,
    listInstalledSkills,
    getSkillSyncRuntime,
  } = deps;

  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[session-bundle] persistedSessions map is required');
  }
  if (!directories || typeof directories.get !== 'function') {
    throw new TypeError('[session-bundle] directories map is required');
  }
  for (const [fn, name] of [
    [asyncHandler, 'asyncHandler'], [appendEvent, 'appendEvent'],
    [createSessionRecord, 'createSessionRecord'], [loadChatHistory, 'loadChatHistory'],
    [getChatHistoryService, 'getChatHistoryService'], [getFolderMemory, 'getFolderMemory'],
  ]) assertFunction(fn, name);

  // Handoff v2 helpers. listInstalledSkills / getSkillSyncRuntime are optional
  // injections (skill collection degrades to "no skills carried" without them);
  // agentsSkillsDir defaults to the canonical ~/.agents/skills root that
  // skill-sync redistributes from.
  const handoffEnv = createHandoffEnvService({
    agentsSkillsDir: deps.agentsSkillsDir,
    maxSkillBytes: deps.maxSkillBytes,
    maxSkills: deps.maxSkills,
    // The builtin shared rule ships with every install and mentions a bundled
    // skill by name; it must not count as a session skill reference.
    builtinRuleText: DOCS_REGISTRY_RULE,
  });
  const agentsSkillsDir = deps.agentsSkillsDir || path.join(os.homedir(), '.agents', 'skills');

  function bundleEncrypt(passphrase, plaintextBuf) {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { salt: salt.toString('base64'), iv: iv.toString('base64'),
             ct: ct.toString('base64'), tag: tag.toString('base64') };
  }

  function bundleDecrypt(passphrase, enc) {
    const salt = Buffer.from(enc.salt, 'base64');
    const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');
    const iv = Buffer.from(enc.iv, 'base64');
    const tag = Buffer.from(enc.tag, 'base64');
    const ct = Buffer.from(enc.ct, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  // Shared export collection: builds the full v2 payload + summary meta.
  // includeGit=false (?git=0) skips the code layer, includeContext=false
  // (?context=0) skips the conversation layer — leaving an environment-only
  // bundle (skills, memory scopes, project instruction files, repo facts).
  async function collectExportPayload(s, options) {
    const { scopes, skillsMode, explicitSkills, includeGit, includeContext } = options;
    const folderMemory = getFolderMemory();
    // 1) Messages + memory scopes (session scope = the v1 memoryFiles).
    //    The transcript is read either way — skill auto-detection needs it as
    //    corpus — but it only travels with the bundle when the context layer is
    //    wanted. Session-private memory is context too, so ?context=0 collects
    //    the environment scopes alone.
    const messages = loadChatHistory(s.id);
    const carriedMessages = includeContext ? messages : [];
    const envScopes = includeContext ? scopes : scopes.filter(scope => scope !== 'session');
    let memoryScopes;
    try {
      memoryScopes = handoffEnv.collectMemoryScopes(folderMemory, s, envScopes);
    } catch (e) {
      memoryScopes = { session: { dir: null, files: {}, skipped: [{ name: '*', reason: e.message }] } };
    }
    const memoryFiles = { ...(memoryScopes.session && memoryScopes.session.files) };

    // 1a) Local files the conversation references by path — user uploads
    //     (temp-dir multicc_* files) and local image refs. Without these
    //     the imported chat shows dead paths where screenshots used to be.
    let assets = { files: [], skipped: [], totalBytes: 0 };
    if (includeContext) {
      try { assets = handoffEnv.collectMessageAssets(messages, { tmpDir: os.tmpdir() }); }
      catch (e) { assets = { files: [], skipped: [{ path: '*', reason: e.message }], totalBytes: 0 }; }
    }

    // 1b) Skills: resolve the carried set from the installed inventory.
    let skills = [];
    if (skillsMode !== 'none' && typeof listInstalledSkills === 'function') {
      let names = [];
      if (skillsMode === 'explicit') names = explicitSkills;
      else {
        const corpus = handoffEnv.detectionCorpus(memoryScopes, messages);
        names = handoffEnv.detectSkillReferences(corpus, listInstalledSkills());
        if (skillsMode !== 'auto' && explicitSkills.length) {
          names = [...new Set([...names, ...explicitSkills])].sort();
        }
      }
      skills = handoffEnv.collectSkillFolders(listInstalledSkills(), names);
    }
    const carriedSkills = skills.filter(skill => skill && !skill.missing);

    // 2) Provider state is deliberately NOT collected. v1 carried
    //    `providerState` (providerId/providerName + the verbatim spawn env, plus
    //    codex auth.json/config.toml); importing wrote it into the new
    //    session's private memory folder as a plaintext `.handoff-provider.json`
    //    that no code ever read back. The values were credential VALUES, not
    //    configuration: a claude session on a relay provider exported its
    //    ANTHROPIC_AUTH_TOKEN, a codex session its OPENAI_API_KEY and a copy of
    //    the machine's codex home. A teammate receiving a handoff needs the
    //    work, not the sender's keys — and the sender's keys are also the
    //    sender's billing. The target machine attaches the imported session to
    //    a provider IT already has: `targetProviderId` (query/body) names an
    //    existing local provider, and when it is omitted the ordinary
    //    createSessionRecord default for that CLI applies (see
    //    src/session/create-record.js). Older bundles that still carry
    //    `providerState` import fine — the field is simply ignored.

    // 3) git bundle of the session's worktree branch — but ONLY the commits
    //    unique to this session (baseBranch..branch). Bundling the full branch
    //    history would pull in the entire main lineage (100MB+ for a mature
    //    repo) and OOM the process when base64'd into the JSON payload. If the
    //    session has no unique commits (already merged back), there is nothing
    //    to carry — the target machine's main already has the work.
    let gitBundleB64 = null;
    let gitBundleNote = null;
    const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;  // 100MB hard cap
    if (!includeGit) {
      gitBundleNote = 'git payload skipped by request (?git=0)';
    } else {
      try {
        if (s.worktreePath && s.branch && fs.existsSync(s.worktreePath)) {
          const dir = directories.get(s.dirId);
          if (!dir) {
            gitBundleNote = 'directory metadata missing — bundle has no git payload';
          } else {
            const tmp = path.join(os.tmpdir(), `multicc-bundle-${s.id}-${Date.now()}.bundle`);
            const result = await gitExportSessionBundle(dir, s, tmp, MAX_BUNDLE_BYTES);
            if (result.unique === 0) {
              gitBundleNote = `no unique commits vs ${result.baseBranch} (already merged) — target's main has the work; no git payload needed`;
            } else if (result.tooLarge) {
              gitBundleNote = `git bundle too large (${(result.size/1024/1024).toFixed(1)}MB > ${MAX_BUNDLE_BYTES/1024/1024}MB cap) — skipped; merge excess back to base first`;
            } else if (result.bundlePath) {
              try {
                gitBundleB64 = (await fs.promises.readFile(result.bundlePath)).toString('base64');
                gitBundleNote = `${result.unique} unique commits, ${(result.size/1024).toFixed(0)}KB bundle`;
              } finally {
                await fs.promises.rm(result.bundlePath, { force: true });
              }
            }
          }
        } else {
          gitBundleNote = 'no worktree/branch on disk — bundle has no git payload';
        }
      } catch (e) {
        gitBundleNote = 'git bundle failed: ' + e.message;
      }
    }

    // 3) Context dependencies: everything a teammate needs to rebuild the
    //    working context on their machine. Repo/branch/doc facts only — no
    //    provider env key names either, since the target wires its own provider.
    const dir = directories.get(s.dirId);
    const contextDeps = { dirName: dir?.name || null, dirPath: dir?.path || null,
                          baseBranch: dir?.baseBranch || null,
                          // The repository identity the import side compares
                          // against its own directory before replaying code.
                          repoRemote: await readRepoRemote(dir?.path),
                          projectDocs: {} };
    if (s.worktreePath && fs.existsSync(s.worktreePath)) {
      for (const docName of PROJECT_DOC_FILES) {
        try {
          const docPath = path.join(s.worktreePath, docName);
          const stat = fs.statSync(docPath);
          if (stat.isFile() && stat.size <= PROJECT_DOC_CAP) {
            contextDeps.projectDocs[docName] = fs.readFileSync(docPath, 'utf8');
          }
        } catch (_) { /* absent project doc */ }
      }
    }

    // 5) Assemble. `layers` says what the container actually holds, so the
    //    import side — and anyone reading the zip's plaintext meta.json — can
    //    tell an environment-only export from a full one without decrypting.
    const layers = { env: true, context: includeContext, code: !!gitBundleB64 };
    const payload = {
      v: 2, exportedAt: new Date().toISOString(),
      sessionMeta: {
        id: s.id, cli: s.cli, kind: s.kind, label: s.label,
        model: s.model, effort: s.effort, agent: s.agent || null, rolePrompt: s.rolePrompt || null,
        branch: s.branch, worktreePath: s.worktreePath, dirId: s.dirId,
        // dirId/branch/worktreePath are hints; target rebuilds its own paths.
      },
      messages: carriedMessages, memoryFiles, gitBundleB64, gitBundleNote,
      memoryScopes, skills: carriedSkills, contextDeps, assets, layers,
    };
    const scopeCounts = Object.fromEntries(Object.entries(memoryScopes)
      .map(([scope, v]) => [scope, Object.keys((v && v.files) || {}).length]));
    const meta = { v: 2, sessionId: s.id, label: s.label, messages: carriedMessages.length,
                   hasGitBundle: !!gitBundleB64, hasMemory: Object.keys(memoryFiles).length,
                   scopes: scopeCounts, layers,
                   skills: carriedSkills.map(skill => ({
                     name: skill.name, files: skill.files.length,
                     bytes: skill.bytes, truncated: !!skill.truncated,
                   })),
                   repoRemote: contextDeps.repoRemote,
                   assets: { files: assets.files.length, bytes: assets.totalBytes,
                             skipped: assets.skipped.length, truncated: !!assets.truncated },
                   note: gitBundleNote };
    return { payload, meta };
  }

  function parseExportOptions(req) {
    const requestedScopes = String(req.query.scopes || 'session,shared,task')
      .split(',').map(v => v.trim())
      .filter(v => handoffEnv.supportedScopes().includes(v));
    return {
      scopes: requestedScopes.length ? requestedScopes : ['session'],
      skillsMode: String(req.query.skillsMode
        || (req.query.skills ? 'explicit' : 'auto')).toLowerCase(),
      explicitSkills: String(req.query.skills || '')
        .split(',').map(v => v.trim()).filter(Boolean),
      includeGit: req.query.git !== '0',
      includeContext: req.query.context !== '0',
    };
  }

  function requireSessionForExport(req, res) {
    const s = persistedSessions.get(req.params.id);
    if (!s) { res.status(404).json({ error: 'session not found' }); return null; }
    if (s.type === 'aux' || s.type === 'gateway') {
      res.status(400).json({ error: 'system session cannot be bundled' });
      return null;
    }
    const passphrase = req.query.passphrase;
    if (!passphrase || passphrase.length < 6) {
      res.status(400).json({ error: 'passphrase required (≥6 chars) — use ?passphrase=...' });
      return null;
    }
    return { s, passphrase: String(passphrase) };
  }

  // Shared restore: takes a decrypted v1/v2-shaped payload and applies it to
  // THIS machine, returning the HTTP response body. Three targets:
  //
  //   envOnly        the environment layer alone — skills into ~/.agents/skills
  //                  and each memory file back into the scope it came from.
  //                  Needs neither a directory nor a session.
  //   targetSession  the context and code layers land in an EXISTING session:
  //                  the imported transcript is appended to its own, and its
  //                  worktree receives the replayed commits.
  //   (default)      a fresh session is created in `dir`, which must exist (a
  //                  git repo when the bundle carries a code layer — the
  //                  worktree is recreated from it).
  //
  // The target machine's own provider wins: `targetProviderId` attaches a newly
  // created session to an already-configured local provider, and without it the
  // ordinary createSessionRecord default for that CLI applies. Bundles exported
  // before provider state was dropped still carry a `providerState` field; it is
  // ignored, and nothing is ever written into memory from it.
  async function restoreImportedPayload(payload, options) {
    const { dir, targetProviderId, labelOverride, targetSessionId, envOnly } = options;
    const meta = payload.sessionMeta;
    const folderMemory = getFolderMemory();

    // ── Resolve where the context and code layers land ──────────────────────
    let session = null;
    let mode = 'env';
    if (!envOnly) {
      if (targetSessionId) {
        const existing = persistedSessions.get(String(targetSessionId));
        if (!existing) return { status: 404, body: { error: 'target session not found' } };
        if (existing.type === 'aux' || existing.type === 'gateway') {
          return { status: 400, body: { error: 'system session cannot receive an import' } };
        }
        session = existing;
        mode = 'merge';
      } else {
        if (!dir) return { status: 404, body: { error: 'target directory not found' } };
        // Creating the record also creates a fresh empty worktree from the dir's
        // base branch; the code layer is then overlaid onto it.
        const r = await createSessionRecord({
          dir, cli: meta.cli, kind: 'chat',
          label: labelOverride || (meta.label ? `${meta.label} · imported` : null),
          provider: targetProviderId === undefined ? undefined : (targetProviderId || ''),
          model: meta.model, effort: meta.effort, agent: meta.agent, rolePrompt: meta.rolePrompt,
          persistence: 'required', persistenceSource: 'http.bundle-import-create',
        });
        if (!r.ok) return { status: 400, body: { error: r.error } };
        session = r.session;
        mode = 'create';
      }
    }
    // A merged import follows the receiving session's own directory: its
    // worktree is what the code layer replays onto, and its project is the
    // shared memory scope the environment layer writes into.
    const targetDir = session ? (directories.get(session.dirId) || dir) : dir;

    try {
      // ── env layer: memory scopes, each back into the scope it came from ───
      // machine/cli/shared are read by sessions the importer never chose, so
      // what lands there is stamped with where it came from; narrower scopes
      // fold into the receiving session's private folder. Local files always
      // win, so a re-import is idempotent.
      let memoryScopeReport = null;
      if (payload.memoryScopes && typeof payload.memoryScopes === 'object') {
        try {
          memoryScopeReport = handoffEnv.restoreMemoryScopes(payload.memoryScopes, {
            folderMemory,
            cli: meta.cli,
            sessionDir: session ? folderMemory.sessionDir(session) : null,
            sharedDir: targetDir ? folderMemory.sharedDir(targetDir.id) : null,
            provenance: { sessionId: meta.id, label: meta.label, cli: meta.cli,
                          exportedAt: payload.exportedAt },
          });
        } catch (e) {
          memoryScopeReport = { error: 'memory scope restore failed: ' + e.message };
        }
      }

      // ── env layer: skills into the canonical shared root, then let
      //    skill-sync redistribute the symlinks on its next pass.
      let skillResults = [];
      if (Array.isArray(payload.skills) && payload.skills.length) {
        skillResults = handoffEnv.restoreSkillFolders(payload.skills, agentsSkillsDir);
        try {
          const syncRuntime = typeof getSkillSyncRuntime === 'function' ? getSkillSyncRuntime() : null;
          if (syncRuntime && typeof syncRuntime.runNow === 'function') syncRuntime.runNow();
        } catch (_) { /* redistribution is periodic; a failed manual kick is fine */ }
      }

      // ── context layer: session-private memory (the v1 flat payload) ──────
      let memoryFilesRestored = 0;
      if (session && payload.memoryFiles && typeof payload.memoryFiles === 'object') {
        const memDir = folderMemory.sessionDir(session);
        fs.mkdirSync(memDir, { recursive: true });
        for (const [rel, content] of Object.entries(payload.memoryFiles)) {
          const safe = String(rel).replace(/[^A-Za-z0-9._-]/g, '_');
          if (!safe || safe === '.' || safe === '..') continue;
          // Dotfiles are machine bookkeeping, never memory content — and a
          // bundle exported by an older release can still carry the plaintext
          // provider file that release wrote. Drop it here too, so a legacy
          // bundle cannot re-plant credentials on this machine.
          if (safe.startsWith('.')) continue;
          fs.writeFileSync(path.join(memDir, safe), content, 'utf8');
          memoryFilesRestored += 1;
        }
      }

      // ── context layer: chat history + the local files it references ──────
      // Carried assets land in this machine's temp dir first and the message
      // text is rewritten to the new paths so images render again.
      let assetMapping = [];
      let messagesRestored = 0;
      if (session) {
        if (payload.assets && Array.isArray(payload.assets.files) && payload.assets.files.length) {
          try { assetMapping = handoffEnv.restoreMessageAssets(payload.assets, { tmpDir: os.tmpdir() }); }
          catch (e) { /* dead paths are cosmetic; import must not fail on them */ }
        }
        if (Array.isArray(payload.messages) && payload.messages.length) {
          const history = getChatHistoryService();
          const imported = payload.messages.map(m => {
            if (!m || typeof m !== 'object') return m;
            const clean = stripSourceTaskStamps(m);
            if (assetMapping.length && typeof clean.content === 'string') {
              clean.content = handoffEnv.rewriteAssetPaths(clean.content, assetMapping);
            }
            // Merging into a live transcript: drop the source ids so
            // normalization mints local ones. Two machines allocate from
            // independent counters, so a carried id can collide with a message
            // the target session already has — and a collision silently merges
            // two unrelated messages in every id-keyed view.
            if (mode === 'merge') delete clean.id;
            return clean;
          });
          // One replace() rather than N append()s: append persists the whole
          // transcript per message, so a 500-message import would rewrite it
          // 500 times. Keeping the local messages first also means no protected
          // (task-referenced) message is dropped, which replace() refuses.
          const merged = mode === 'merge' ? [...history.read(session.id), ...imported] : imported;
          history.replace(session.id, merged, { reason: `bundle-import-${mode}` });
          messagesRestored = imported.length;
        }
      }

      // ── code layer: replay the bundle's unique commits ───────────────────
      // Only onto the same repository. A bundle carries the commits of one
      // project's branch; replaying them into an unrelated checkout produces
      // conflicts at best and nonsense at worst, so a differing origin skips
      // the replay outright and says so. An unresolvable remote on either side
      // still attempts it — git is the arbiter there, and an unrelated history
      // has no merge base, so the replay aborts and leaves the worktree alone.
      // The Git adapter holds one RepoActor lease for fetch + replay and always
      // deletes its temporary ref. Linear histories use cherry-pick; histories
      // containing merges preserve their topology.
      let gitRestored = false;
      let gitNote = null;
      if (!session) {
        gitNote = 'environment-only import — the code layer was not applied';
      } else if (!payload.gitBundleB64) {
        gitNote = payload.gitBundleNote || 'no git payload in bundle';
      } else {
        const targetRemote = await readRepoRemote(targetDir?.path);
        if (handoffEnv.sameRepository(payload.contextDeps?.repoRemote, targetRemote) === false) {
          gitNote = 'skipped: this directory is a different repository ('
            + `${handoffEnv.normalizeRepoRemote(payload.contextDeps?.repoRemote) || 'source'} → `
            + `${handoffEnv.normalizeRepoRemote(targetRemote) || 'target'}) — the code layer only `
            + 'replays onto the repository it came from';
        } else if (!session.worktreePath || !session.branch) {
          gitNote = 'target session has no worktree/branch — the code layer was not applied';
        } else {
          const tmpBundle = path.join(os.tmpdir(), `multicc-import-${session.id}-${Date.now()}.bundle`);
          try {
            await fs.promises.writeFile(tmpBundle, Buffer.from(payload.gitBundleB64, 'base64'));
            const srcBranch = meta.branch || `multicc/${meta.id}`;
            const result = await gitImportSessionBundle(targetDir, session, tmpBundle, srcBranch);
            gitRestored = !!result.restored;
            if (!result.ok) gitNote = 'git restore failed: ' + (result.error || 'unknown error');
            else if (!result.restored) gitNote = result.note || 'bundle contained no new commits';
          } catch (e) {
            gitNote = 'git restore failed: ' + e.message;
          } finally {
            await fs.promises.rm(tmpBundle, { force: true }).catch(() => {});
          }
        }
      }

      // A receiving session also gets the handoff manifest in its private
      // memory folder, so the next context build (and any human teammate) sees
      // the dependency picture. An environment-only import writes no manifest:
      // there is no session folder for it, and the machine-global folders are
      // injected into every session's context — a per-import note there would
      // be noise everywhere. The HTTP response carries the same report.
      if (session) {
        try {
          const doc = handoffEnv.renderHandoffDoc({ payload, memoryReport: memoryScopeReport,
                                                    skillResults, assetMapping, gitNote });
          const memDir = folderMemory.sessionDir(session);
          fs.mkdirSync(memDir, { recursive: true });
          fs.writeFileSync(path.join(memDir, 'HANDOFF.md'), doc, 'utf8');
        } catch (_) { /* the manifest is documentation; import must not fail on it */ }
      }

      if (targetDir) {
        appendEvent(targetDir.id, 'session_imported',
          session ? `${session.id} ← bundle (${mode})` : 'bundle ← environment only',
          session ? session.id : null);
      }
      const body = { ok: true, mode, sessionId: session ? session.id : null,
        restored: { messages: messagesRestored,
                    memoryFiles: memoryFilesRestored,
                    memoryScopes: memoryScopeReport,
                    skills: skillResults,
                    assets: { restored: assetMapping.length },
                    gitRestored, gitNote } };
      if (session) body.session = session;
      return { status: 200, body };
    } catch (e) {
      return { status: 500, body: { error: 'import failed: ' + e.message,
                                    sessionId: session ? session.id : null } };
    }
  }

  function mountRoutes(app) {
    app.get('/api/sessions/:id/bundle', asyncHandler(async (req, res) => {
      const guard = requireSessionForExport(req, res);
      if (!guard) return;
      const { s, passphrase } = guard;
      try {
        const { payload, meta } = await collectExportPayload(s, parseExportOptions(req));
        const enc = bundleEncrypt(passphrase, Buffer.from(JSON.stringify(payload), 'utf8'));
        appendEvent(s.dirId, 'session_bundled', `${s.label || s.id} → export`, s.id);
        res.json({ ok: true, ...enc, meta });
      } catch (e) {
        res.status(500).json({ error: 'bundle failed: ' + e.message });
      }
    }));

    // v3 zip transport: the same payload, but the bulky binaries ride as real
    // deflated files a teammate can open with any zip tool, and the sensitive
    // text (chat history, memories, context docs) stays inside the
    // AES-256-GCM encrypted manifest.json entry. No base64 inflation, so a
    // 20MB asset stays ~20MB instead of ~27MB of JSON.
    app.get('/api/sessions/:id/bundle.zip', asyncHandler(async (req, res) => {
      const guard = requireSessionForExport(req, res);
      if (!guard) return;
      const { s, passphrase } = guard;
      try {
        const { payload, meta } = await collectExportPayload(s, parseExportOptions(req));
        const entries = [];
        // Plaintext summary only — no label, session id or repo remote in the
        // clear. The full picture lives in the encrypted manifest. What the
        // clear part DOES say, for anyone auditing the container: format and
        // version, the export time, the CLI (the receiver has to know which CLI
        // must be installed) and the git note (a branch name, or the reason the
        // bundle carries no git payload).
        entries.push({ name: 'meta.json', data: JSON.stringify({
          format: 'multicc-session-handoff', v: 3,
          createdAt: payload.exportedAt, cli: payload.sessionMeta.cli,
          counts: { messages: meta.messages, scopes: meta.scopes,
                    skills: meta.skills.length, assets: meta.assets.files,
                    assetBytes: meta.assets.bytes },
          layers: payload.layers,
          hasGitBundle: meta.hasGitBundle, note: meta.note,
        }, null, 2) });
        // Referential payload: bulky contents replaced by zip entry refs.
        const zipPayload = {
          ...payload, v: 3,
          skills: payload.skills.map(skill => ({
            ...skill,
            files: skill.files.map(file => ({
              rel: file.rel, encoding: file.encoding, size: file.size,
              truncated: !!file.truncated, zipRef: `skills/${skill.name}/${file.rel}`,
            })),
          })),
          assets: { files: payload.assets.files.map((file, i) => ({
                      path: file.path, name: file.name, size: file.size,
                      zipRef: `assets/${String(i).padStart(3, '0')}-${String(file.name)
                        .replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, 'dot-') || 'asset'}`,
                    })),
                    skipped: payload.assets.skipped, totalBytes: payload.assets.totalBytes },
          gitBundleB64: undefined,
          gitBundleZip: payload.gitBundleB64
            ? { zipRef: 'git.bundle', note: payload.gitBundleNote }
            : null,
        };
        for (const skill of payload.skills) {
          for (const file of skill.files) {
            entries.push({ name: `skills/${skill.name}/${file.rel}`,
                           data: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') });
          }
        }
        for (const file of payload.assets.files) {
          entries.push({ name: zipPayload.assets.files.find(f => f.path === file.path).zipRef,
                         data: Buffer.from(file.content, 'base64') });
        }
        if (payload.gitBundleB64) {
          entries.push({ name: 'git.bundle', data: Buffer.from(payload.gitBundleB64, 'base64') });
        }
        entries.push({ name: 'manifest.json', data: JSON.stringify(
          bundleEncrypt(passphrase, Buffer.from(JSON.stringify(zipPayload), 'utf8'))) });
        const zip = createZip(entries, { maxEntries: ZIP_MAX_ENTRIES, maxTotalBytes: ZIP_MAX_TOTAL_BYTES });
        appendEvent(s.dirId, 'session_bundled', `${s.label || s.id} → export (zip)`, s.id);
        res.set('Content-Type', 'application/zip');
        // The download name carries the export time, never the session id: a
        // filename rides in the clear (browser download history, proxy logs,
        // mail attachments) and the container above promises no session id in
        // the clear. `exportedAt` is an ISO stamp already in the payload, so no
        // extra clock read is needed here.
        const stamp = String(payload.exportedAt || '')
          .replace(/[-:]/g, '').replace(/\.\d+Z?$/, '').replace('T', '-') || 'export';
        res.set('Content-Disposition', `attachment; filename="multicc-handoff-${stamp}.zip"`);
        res.set('Content-Length', String(zip.length));
        res.send(zip);
      } catch (e) {
        res.status(500).json({ error: 'bundle failed: ' + e.message });
      }
    }));

    // Import an encrypted JSON bundle produced by GET /api/sessions/:id/bundle.
    app.post('/api/sessions/import', asyncHandler(async (req, res) => {
      const b = req.body || {};
      const { salt, iv, ct, tag } = b;
      const passphrase = b.passphrase;
      const dirId = b.dirId;
      const targetProviderId = b.targetProviderId || undefined;
      const labelOverride = (b.label || '').toString().trim() || null;
      const targetSessionId = (b.targetSessionId || '').toString().trim() || null;
      const envOnly = b.envOnly === true || b.envOnly === 1 || b.envOnly === '1';
      if (!salt || !iv || !ct || !tag) return res.status(400).json({ error: 'missing bundle fields (salt/iv/ct/tag)' });
      if (!passphrase) return res.status(400).json({ error: 'passphrase required' });
      if (!dirId && !targetSessionId && !envOnly) {
        return res.status(400).json({ error: 'dirId required — or targetSessionId to merge into an '
          + 'existing session, or envOnly:true to install just the environment layer' });
      }
      const dir = dirId ? directories.get(dirId) : null;
      if (dirId && !dir) return res.status(404).json({ error: 'target directory not found' });

      let payload;
      try {
        const plaintext = bundleDecrypt(String(passphrase), { salt, iv, ct, tag });
        payload = JSON.parse(plaintext.toString('utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'decrypt failed (wrong passphrase or corrupt bundle): ' + e.message });
      }
      if (!payload || (payload.v !== 1 && payload.v !== 2) || !payload.sessionMeta) {
        return res.status(400).json({ error: 'unsupported bundle version' });
      }
      const result = await restoreImportedPayload(payload,
        { dir, targetProviderId, labelOverride, targetSessionId, envOnly });
      res.status(result.status).json(result.body);
    }));

    // Import a v3 zip bundle produced by GET /api/sessions/:id/bundle.zip.
    // Raw body (Content-Type: application/zip); knobs ride on the query string
    // exactly like the JSON route's body fields.
    app.post('/api/sessions/import-zip', express.raw({ type: () => true, limit: ZIP_BODY_LIMIT }),
      asyncHandler(async (req, res) => {
        const body = req.body;
        if (!Buffer.isBuffer(body) || !body.length || !looksLikeZip(body)) {
          return res.status(400).json({ error: 'body is not a zip bundle (POST the bundle.zip bytes with Content-Type: application/zip)' });
        }
        const passphrase = String(req.query.passphrase || '');
        const dirId = String(req.query.dirId || '');
        const dir = dirId ? directories.get(dirId) : null;
        const targetProviderId = req.query.targetProviderId || undefined;
        const labelOverride = String(req.query.label || '').trim() || null;
        const targetSessionId = String(req.query.targetSessionId || '').trim() || null;
        const envOnly = req.query.envOnly === '1' || req.query.envOnly === 'true';
        if (passphrase.length < 6) return res.status(400).json({ error: 'passphrase required (≥6 chars) — use ?passphrase=...' });
        if (!dirId && !targetSessionId && !envOnly) {
          return res.status(400).json({ error: 'dirId required — or targetSessionId to merge into an '
            + 'existing session, or envOnly=1 to install just the environment layer' });
        }
        if (dirId && !dir) return res.status(404).json({ error: 'target directory not found' });

        let payload;
        try {
          const entries = readZip(body, { maxEntries: ZIP_MAX_ENTRIES, maxTotalBytes: ZIP_MAX_TOTAL_BYTES });
          const byName = new Map(entries.map(e => [e.name, e.data]));
          const manifestEnc = byName.get('manifest.json');
          if (!manifestEnc) throw new Error('manifest.json entry missing');
          const decrypted = bundleDecrypt(passphrase, JSON.parse(manifestEnc.toString('utf8')));
          const zipPayload = JSON.parse(decrypted.toString('utf8'));
          if (!zipPayload || zipPayload.v !== 3 || !zipPayload.sessionMeta) {
            throw new Error('unsupported bundle version');
          }
          const require = (ref) => {
            const data = byName.get(ref);
            if (!Buffer.isBuffer(data)) throw new Error(`referenced zip entry missing or corrupt: ${ref}`);
            return data;
          };
          // Rehydrate the v2-shaped payload the shared restore path consumes.
          payload = { ...zipPayload, v: 2,
            skills: (Array.isArray(zipPayload.skills) ? zipPayload.skills : []).map(skill => ({
              ...skill,
              files: (skill.files || []).map(file => {
                const data = require(file.zipRef);
                return { rel: file.rel, encoding: file.encoding,
                         content: file.encoding === 'base64'
                           ? data.toString('base64') : data.toString('utf8') };
              }),
            })),
            assets: { files: (zipPayload.assets?.files || []).map(file => ({
                        path: file.path, name: file.name, size: file.size,
                        encoding: 'base64', content: require(file.zipRef).toString('base64') })),
                      skipped: zipPayload.assets?.skipped || [],
                      totalBytes: zipPayload.assets?.totalBytes || 0 },
            gitBundleB64: zipPayload.gitBundleZip ? require(zipPayload.gitBundleZip.zipRef).toString('base64') : null,
            gitBundleNote: zipPayload.gitBundleZip?.note || zipPayload.gitBundleNote || null,
          };
        } catch (e) {
          return res.status(400).json({ error: 'invalid zip bundle (wrong passphrase or corrupt archive): ' + e.message });
        }
        const result = await restoreImportedPayload(payload,
          { dir, targetProviderId, labelOverride, targetSessionId, envOnly });
        res.status(result.status).json(result.body);
      }));
  }

  return { mountRoutes };
}

module.exports = { createSessionBundleRoutes };
