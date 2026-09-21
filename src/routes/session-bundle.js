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
// The payload carries session metadata, chat history, the memory waterfall
// scopes (?scopes=), the skills the session relied on (?skillsMode=
// auto|explicit|none, ?skills=a,b), the context dependencies a teammate needs
// (repo remote, branches, project instruction files) and a `git bundle` of the
// session's worktree branch (?git=0 skips it for scenarios where the target has
// no repo). POST import rebuilds the session — restoring shared memory into the
// target project, folding narrower scopes into the new session's private
// memory, installing carried skills into ~/.agents/skills, and writing a
// HANDOFF.md manifest.
// The sensitive half (chat, memories, project docs) is always passphrase-
// encrypted (PBKDF2 + AES-256-GCM) whichever container is used.
//
// Provider state deliberately does NOT travel (see the removal note below the
// import route for the reasoning); the target machine picks its own provider.
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
  // includeGit=false (?git=0) skips the git bundle for handoffs whose target
  // machine has no repository to replay onto.
  async function collectExportPayload(s, options) {
    const { scopes, skillsMode, explicitSkills, includeGit } = options;
    const folderMemory = getFolderMemory();
    // 1) Messages + memory scopes (session scope = the v1 memoryFiles).
    const messages = loadChatHistory(s.id);
    let memoryScopes;
    try {
      memoryScopes = handoffEnv.collectMemoryScopes(folderMemory, s, scopes);
    } catch (e) {
      memoryScopes = { session: { dir: null, files: {}, skipped: [{ name: '*', reason: e.message }] } };
    }
    const memoryFiles = { ...(memoryScopes.session && memoryScopes.session.files) };

    // 1a) Local files the conversation references by path — user uploads
    //     (temp-dir multicc_* files) and local image refs. Without these
    //     the imported chat shows dead paths where screenshots used to be.
    let assets = { files: [], skipped: [], totalBytes: 0 };
    try { assets = handoffEnv.collectMessageAssets(messages, { tmpDir: os.tmpdir() }); }
    catch (e) { assets = { files: [], skipped: [{ path: '*', reason: e.message }], totalBytes: 0 }; }

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
                          baseBranch: dir?.baseBranch || null, repoRemote: null,
                          projectDocs: {} };
    if (dir && dir.path) {
      try {
        const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'],
          { cwd: dir.path, encoding: 'utf8' });
        contextDeps.repoRemote = String(remote.stdout || '').trim() || null;
      } catch (_) { /* no origin / not a repo — hint only */ }
    }
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

    // 5) Assemble.
    const payload = {
      v: 2, exportedAt: new Date().toISOString(),
      sessionMeta: {
        id: s.id, cli: s.cli, kind: s.kind, label: s.label,
        model: s.model, effort: s.effort, agent: s.agent || null, rolePrompt: s.rolePrompt || null,
        branch: s.branch, worktreePath: s.worktreePath, dirId: s.dirId,
        // dirId/branch/worktreePath are hints; target rebuilds its own paths.
      },
      messages, memoryFiles, gitBundleB64, gitBundleNote,
      memoryScopes, skills: carriedSkills, contextDeps, assets,
    };
    const scopeCounts = Object.fromEntries(Object.entries(memoryScopes)
      .map(([scope, v]) => [scope, Object.keys((v && v.files) || {}).length]));
    const meta = { v: 2, sessionId: s.id, label: s.label, messages: messages.length,
                   hasGitBundle: !!gitBundleB64, hasMemory: Object.keys(memoryFiles).length,
                   scopes: scopeCounts,
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

  // Shared restore: takes a decrypted v1/v2-shaped payload, rebuilds the
  // session on THIS machine and returns the HTTP response body. The target
  // directory (dirId) must exist (a git repo when the bundle carries a git
  // payload — we recreate the worktree from it). The target machine's own
  // provider wins: `targetProviderId` attaches the new session to an already-
  // configured local provider, and without it the ordinary createSessionRecord
  // default for that CLI applies. Bundles exported before provider state was
  // dropped still carry a `providerState` field; it is ignored, and nothing is
  // ever written into the imported session's memory from it.
  async function restoreImportedPayload(payload, { dir, targetProviderId, labelOverride }) {
    const meta = payload.sessionMeta;

    // Create the session record — this also creates a fresh empty worktree from
    // the dir's base branch. We then overlay the bundle's git content onto it.
    const r = await createSessionRecord({
      dir, cli: meta.cli, kind: 'chat',
      label: labelOverride || (meta.label ? `${meta.label} · imported` : null),
      provider: targetProviderId === undefined ? undefined : (targetProviderId || ''),
      model: meta.model, effort: meta.effort, agent: meta.agent, rolePrompt: meta.rolePrompt,
      persistence: 'required', persistenceSource: 'http.bundle-import-create',
    });
    if (!r.ok) return { status: 400, body: { error: r.error } };
    const newSid = r.id;
    const newSession = r.session;

    try {
      // 1) Restore chat history. Carried assets (conversation-referenced
      //    uploads/images) land in this machine's temp dir first, and the
      //    message text is rewritten to the new paths so the images render
      //    again in the imported conversation.
      let assetMapping = [];
      if (payload.assets && Array.isArray(payload.assets.files) && payload.assets.files.length) {
        try { assetMapping = handoffEnv.restoreMessageAssets(payload.assets, { tmpDir: os.tmpdir() }); }
        catch (e) { /* dead paths are cosmetic; import must not fail on them */ }
      }
      if (Array.isArray(payload.messages)) {
        const restored = payload.messages.map(m => {
          if (!m || typeof m !== 'object') return m;
          const clean = stripSourceTaskStamps(m);
          if (assetMapping.length && typeof clean.content === 'string') {
            clean.content = handoffEnv.rewriteAssetPaths(clean.content, assetMapping);
          }
          return clean;
        });
        getChatHistoryService().replace(newSid, restored, { reason: 'bundle-import' });
      }

      // 2) Restore memory files (v1 flat payload) and the v2 scope map.
      const folderMemory = getFolderMemory();
      if (payload.memoryFiles && typeof payload.memoryFiles === 'object') {
        const memDir = folderMemory.sessionDir(newSession);
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
        }
      }
      let memoryScopeReport = null;
      if (payload.memoryScopes && typeof payload.memoryScopes === 'object') {
        try {
          memoryScopeReport = handoffEnv.restoreMemoryScopes(payload.memoryScopes, {
            sessionDir: folderMemory.sessionDir(newSession),
            sharedDir: folderMemory.sharedDir(newSession.dirId),
          });
        } catch (e) {
          memoryScopeReport = { error: 'memory scope restore failed: ' + e.message };
        }
      }

      // 2b) Install carried skills into the canonical shared root and let
      //     skill-sync redistribute the symlinks on its next pass.
      let skillResults = [];
      if (Array.isArray(payload.skills) && payload.skills.length) {
        skillResults = handoffEnv.restoreSkillFolders(payload.skills, agentsSkillsDir);
        try {
          const syncRuntime = typeof getSkillSyncRuntime === 'function' ? getSkillSyncRuntime() : null;
          if (syncRuntime && typeof syncRuntime.runNow === 'function') syncRuntime.runNow();
        } catch (_) { /* redistribution is periodic; a failed manual kick is fine */ }
      }

      // 3) Replay the bundle's unique commits onto the freshly-created worktree.
      //    The Git adapter holds one RepoActor lease for fetch + replay, aborts
      //    conflicts, and always deletes its temporary ref. Linear histories use
      //    cherry-pick; histories containing merges preserve their topology.
      let gitRestored = false, gitNote = null;
      if (payload.gitBundleB64 && newSession.worktreePath && newSession.branch) {
        const tmpBundle = path.join(os.tmpdir(), `multicc-import-${newSid}-${Date.now()}.bundle`);
        try {
          await fs.promises.writeFile(tmpBundle, Buffer.from(payload.gitBundleB64, 'base64'));
          const srcBranch = meta.branch || `multicc/${meta.id}`;
          const result = await gitImportSessionBundle(dir, newSession, tmpBundle, srcBranch);
          gitRestored = !!result.restored;
          if (!result.ok) gitNote = 'git restore failed: ' + (result.error || 'unknown error');
          else if (!result.restored) gitNote = result.note || 'bundle contained no new commits';
        } catch (e) {
          gitNote = 'git restore failed: ' + e.message;
        } finally {
          await fs.promises.rm(tmpBundle, { force: true }).catch(() => {});
        }
      } else {
        gitNote = payload.gitBundleNote || 'no git payload in bundle';
      }

      // 4) Write the handoff manifest into the new session's private memory
      //    folder so the next context build (and any human teammate) sees the
      //    dependency picture: repo, branches, provider hints, restored
      //    memory scopes and installed skills.
      try {
        const doc = handoffEnv.renderHandoffDoc({ payload, memoryReport: memoryScopeReport,
                                                   skillResults, assetMapping, gitNote });
        const memDir = folderMemory.sessionDir(newSession);
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, 'HANDOFF.md'), doc, 'utf8');
      } catch (_) { /* the manifest is documentation; import must not fail on it */ }

      appendEvent(dir.id, 'session_imported', `${newSid} ← bundle`, newSid);
      return { status: 200, body: { ok: true, sessionId: newSid, session: newSession,
        restored: { messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
                    memoryFiles: payload.memoryFiles ? Object.keys(payload.memoryFiles).length : 0,
                    memoryScopes: memoryScopeReport,
                    skills: skillResults,
                    assets: { restored: assetMapping.length },
                    gitRestored, gitNote } } };
    } catch (e) {
      return { status: 500, body: { error: 'import failed (session record created): ' + e.message, sessionId: newSid } };
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
        // clear. The full picture lives in the encrypted manifest.
        entries.push({ name: 'meta.json', data: JSON.stringify({
          format: 'multicc-session-handoff', v: 3,
          createdAt: payload.exportedAt, cli: payload.sessionMeta.cli,
          counts: { messages: meta.messages, scopes: meta.scopes,
                    skills: meta.skills.length, assets: meta.assets.files,
                    assetBytes: meta.assets.bytes },
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
        res.set('Content-Disposition', `attachment; filename="multicc-handoff-${s.id}.zip"`);
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
      if (!salt || !iv || !ct || !tag) return res.status(400).json({ error: 'missing bundle fields (salt/iv/ct/tag)' });
      if (!passphrase) return res.status(400).json({ error: 'passphrase required' });
      const dir = directories.get(dirId);
      if (!dir) return res.status(404).json({ error: 'target directory not found' });

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
      const result = await restoreImportedPayload(payload, { dir, targetProviderId, labelOverride });
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
        const dir = directories.get(String(req.query.dirId || ''));
        const targetProviderId = req.query.targetProviderId || undefined;
        const labelOverride = String(req.query.label || '').trim() || null;
        if (passphrase.length < 6) return res.status(400).json({ error: 'passphrase required (≥6 chars) — use ?passphrase=...' });
        if (!dir) return res.status(404).json({ error: 'target directory not found' });

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
        const result = await restoreImportedPayload(payload, { dir, targetProviderId, labelOverride });
        res.status(result.status).json(result.body);
      }));
  }

  return { mountRoutes };
}

module.exports = { createSessionBundleRoutes };
