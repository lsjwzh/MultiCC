'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { gitExportSessionBundle, gitImportSessionBundle } = require('../git/service');
const { createHandoffEnvService } = require('../session/handoff-env');
const { DOCS_REGISTRY_RULE } = require('../memory/builtin-rules');

const execFileAsync = promisify(execFile);
const PROJECT_DOC_FILES = ['CLAUDE.md', 'AGENTS.md'];
const PROJECT_DOC_CAP = 256 * 1024;

// Cross-machine handoff routes (Happier-parity: move a live session to another
// machine): GET /api/sessions/:id/bundle exports an encrypted bundle carrying
// session metadata, chat history, the session's memory files (v1: private only;
// v2: the memory waterfall scopes requested via ?scopes=), the skills the
// session relied on (?skillsMode=auto|explicit|none, ?skills=a,b), the context
// dependencies a teammate needs to keep building (repo remote, branches,
// project instruction files, provider env key names), the provider state (env,
// and for codex the auth.json/config.toml files), and a `git bundle` of the
// session's worktree branch; POST /api/sessions/import rebuilds the session on
// this machine — restoring shared memory into the target project, folding the
// narrower scopes into the new session's private memory, installing carried
// skills into ~/.agents/skills, and writing a HANDOFF.md manifest. The bundle
// is AES-256-GCM encrypted with a passphrase-derived key (PBKDF2), so it is
// safe to move over email/syncthing/cloud.
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
    providers,
    providerRouterRuntime,
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
  if (!providers || typeof providers.CODEX_HOMES_DIR !== 'string') {
    throw new TypeError('[session-bundle] providers.CODEX_HOMES_DIR is required');
  }
  if (!providerRouterRuntime || typeof providerRouterRuntime.resolveSpawnEnv !== 'function') {
    throw new TypeError('[session-bundle] providerRouterRuntime.resolveSpawnEnv is required');
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

  // Limitation: the target machine must already have (or create) a directory
  // backed by the same git repo, so `git fetch` from the bundle can land the
  // branch and `git worktree add` can check it out. multicc is single-machine by
  // design; this is the file-shuffle equivalent of Happier's direct_peer handoff.
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

  function mountRoutes(app) {
    app.get('/api/sessions/:id/bundle', asyncHandler(async (req, res) => {
      const s = persistedSessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'session not found' });
      if (s.type === 'aux' || s.type === 'gateway') {
        return res.status(400).json({ error: 'system session cannot be bundled' });
      }
      const passphrase = req.query.passphrase;
      if (!passphrase || passphrase.length < 6) {
        return res.status(400).json({ error: 'passphrase required (≥6 chars) — use ?passphrase=...' });
      }
      // v2 knobs: which memory scopes ride along (default: the ones that make
      // sense to share with a teammate), and which skills. skillsMode=auto
      // detects skill references in the carried memories + recent turns;
      // an explicit ?skills= list forces exactly those; none omits skills.
      const folderMemory = getFolderMemory();
      const requestedScopes = String(req.query.scopes || 'session,shared,task')
        .split(',').map(v => v.trim())
        .filter(v => handoffEnv.supportedScopes().includes(v));
      const scopes = requestedScopes.length ? requestedScopes : ['session'];
      const skillsMode = String(req.query.skillsMode
        || (req.query.skills ? 'explicit' : 'auto')).toLowerCase();
      const explicitSkills = String(req.query.skills || '')
        .split(',').map(v => v.trim()).filter(Boolean);
      try {
        // 1) Messages + memory scopes (session scope = the v1 memoryFiles).
        const messages = loadChatHistory(s.id);
        let memoryScopes;
        try {
          memoryScopes = handoffEnv.collectMemoryScopes(folderMemory, s, scopes);
        } catch (e) {
          memoryScopes = { session: { dir: null, files: {}, skipped: [{ name: '*', reason: e.message }] } };
        }
        const memoryFiles = { ...(memoryScopes.session && memoryScopes.session.files) };

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

        // 2) Provider state: env (claude ANTHROPIC_*, codex CODEX_HOME pointer)
        //    plus, for codex, the auth.json/config.toml file contents so the
        //    target machine can reconstruct the codex home.
        const provEnv = providerRouterRuntime.resolveSpawnEnv(s);
        const providerState = {
          providerId: s.provider, providerName: provEnv.providerName,
          env: provEnv.env || {}, codexFiles: {},
        };
        if (s.cli === 'codex' && s.provider) {
          try {
            const home = path.join(providers.CODEX_HOMES_DIR, s.provider);
            if (fs.existsSync(home)) {
              for (const fn of ['auth.json', 'config.toml']) {
                const fp = path.join(home, fn);
                if (fs.existsSync(fp)) {
                  providerState.codexFiles[fn] = fs.readFileSync(fp, 'utf8');
                }
              }
            }
          } catch (e) { /* best-effort */ }
        }

        // 3) git bundle of the session's worktree branch — but ONLY the commits
        //    unique to this session (baseBranch..branch). Bundling the full branch
        //    history would pull in the entire main lineage (100MB+ for a mature
        //    repo) and OOM the process when base64'd into the JSON payload. If the
        //    session has no unique commits (already merged back), there is nothing
        //    to carry — the target machine's main already has the work.
        let gitBundleB64 = null;
        let gitBundleNote = null;
        const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;  // 100MB hard cap
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

        // 4) Context dependencies: everything a teammate needs to rebuild the
        //    working context on their machine. Values stay non-secret — env is
        //    reduced to key names; provider creds only travel via providerState
        //    inside the encrypted payload, as in v1.
        const dir = directories.get(s.dirId);
        const contextDeps = { dirName: dir?.name || null, dirPath: dir?.path || null,
                              baseBranch: dir?.baseBranch || null, repoRemote: null,
                              projectDocs: {}, envKeys: Object.keys(providerState.env || {}) };
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

        // 5) Assemble + encrypt.
        const payload = {
          v: 2, exportedAt: new Date().toISOString(),
          sessionMeta: {
            id: s.id, cli: s.cli, kind: s.kind, label: s.label,
            model: s.model, effort: s.effort, agent: s.agent || null, rolePrompt: s.rolePrompt || null,
            branch: s.branch, worktreePath: s.worktreePath, dirId: s.dirId,
            // dirId/branch/worktreePath are hints; target rebuilds its own paths.
          },
          messages, memoryFiles, providerState, gitBundleB64, gitBundleNote,
          memoryScopes, skills: carriedSkills, contextDeps,
        };
        const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
        const enc = bundleEncrypt(String(passphrase), plaintext);
        appendEvent(s.dirId, 'session_bundled', `${s.label || s.id} → export`, s.id);
        const scopeCounts = Object.fromEntries(Object.entries(memoryScopes)
          .map(([scope, v]) => [scope, Object.keys((v && v.files) || {}).length]));
        res.json({
          ok: true, ...enc,
          meta: { v: 2, sessionId: s.id, label: s.label, messages: messages.length,
                  hasGitBundle: !!gitBundleB64, hasMemory: Object.keys(memoryFiles).length,
                  scopes: scopeCounts,
                  skills: carriedSkills.map(skill => ({
                    name: skill.name, files: skill.files.length,
                    bytes: skill.bytes, truncated: !!skill.truncated,
                  })),
                  repoRemote: contextDeps.repoRemote,
                  note: gitBundleNote },
        });
      } catch (e) {
        res.status(500).json({ error: 'bundle failed: ' + e.message });
      }
    }));

    // Import an encrypted bundle produced by GET /api/sessions/:id/bundle and
    // rebuild the session on THIS machine. The target directory (dirId) must be a
    // git repo (we recreate the worktree from the bundle's git payload). Provider
    // credentials are NOT auto-injected: pass targetProviderId to attach the new
    // session to an already-configured provider on this machine, or omit to use the
    // default login. The bundle's provider env/codex files are kept in the session's
    // memory folder as `.handoff-provider.json` for reference/manual setup.
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
      if (!r.ok) return res.status(400).json({ error: r.error });
      const newSid = r.id;
      const newSession = r.session;

      try {
        // 1) Restore chat history.
        if (Array.isArray(payload.messages)) {
          getChatHistoryService().replace(newSid, payload.messages, { reason: 'bundle-import' });
        }

        // 2) Restore memory files (v1 flat payload) and the v2 scope map.
        const folderMemory = getFolderMemory();
        if (payload.memoryFiles && typeof payload.memoryFiles === 'object') {
          const memDir = folderMemory.sessionDir(newSession);
          fs.mkdirSync(memDir, { recursive: true });
          for (const [rel, content] of Object.entries(payload.memoryFiles)) {
            const safe = String(rel).replace(/[^A-Za-z0-9._-]/g, '_');
            if (!safe || safe === '.' || safe === '..') continue;
            fs.writeFileSync(path.join(memDir, safe), content, 'utf8');
          }
          // Stash the source provider state for reference (creds the user must wire
          // up on this machine — never auto-injected into the provider pool).
          try {
            fs.writeFileSync(path.join(memDir, '.handoff-provider.json'),
              JSON.stringify({ sourceProviderId: meta.providerId || null,
                               sourceProviderName: payload.providerState?.providerName || null,
                               env: payload.providerState?.env || {},
                               codexFiles: payload.providerState?.codexFiles || {} }, null, 2),
              'utf8');
          } catch (_) {}
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
                                                     skillResults, gitNote });
          const memDir = folderMemory.sessionDir(newSession);
          fs.mkdirSync(memDir, { recursive: true });
          fs.writeFileSync(path.join(memDir, 'HANDOFF.md'), doc, 'utf8');
        } catch (_) { /* the manifest is documentation; import must not fail on it */ }

        appendEvent(dir.id, 'session_imported', `${newSid} ← bundle`, newSid);
        res.json({ ok: true, sessionId: newSid, session: newSession,
                   restored: { messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
                               memoryFiles: payload.memoryFiles ? Object.keys(payload.memoryFiles).length : 0,
                               memoryScopes: memoryScopeReport,
                               skills: skillResults,
                               gitRestored, gitNote } });
      } catch (e) {
        res.status(500).json({ error: 'import failed (session record created): ' + e.message, sessionId: newSid });
      }
    }));
  }

  return { mountRoutes };
}

module.exports = { createSessionBundleRoutes };
