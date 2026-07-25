'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { gitExportSessionBundle, gitImportSessionBundle } = require('../git');

// Cross-machine handoff routes (Happier-parity: move a live session to another
// machine): GET /api/sessions/:id/bundle exports an encrypted bundle carrying
// session metadata, chat history, the session's private memory files, the
// provider state (env, and for codex the auth.json/config.toml files), and a
// `git bundle` of the session's worktree branch; POST /api/sessions/import
// rebuilds the session on this machine. The bundle is AES-256-GCM encrypted
// with a passphrase-derived key (PBKDF2), so it is safe to move over
// email/syncthing/cloud.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; the only
// change is that mutable host state (chatHistoryService, folderMemory) is read
// through getters so a runtime that is composed after this module mounts is
// still resolved at request time rather than captured as a stale null snapshot.

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
      try {
        // 1) Messages + memory files.
        const messages = loadChatHistory(s.id);
        const memoryFiles = {};
        try {
          const memDir = getFolderMemory().sessionDir(s);
          if (fs.existsSync(memDir)) {
            for (const entry of fs.readdirSync(memDir, { withFileTypes: true })) {
              if (entry.isFile()) {
                const rel = entry.name;
                const abs = path.join(memDir, entry.name);
                memoryFiles[rel] = fs.readFileSync(abs, 'utf8');
              }
            }
          }
        } catch (e) { /* best-effort */ }

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

        // 4) Assemble + encrypt.
        const payload = {
          v: 1, exportedAt: new Date().toISOString(),
          sessionMeta: {
            id: s.id, cli: s.cli, kind: s.kind, label: s.label,
            model: s.model, effort: s.effort, agent: s.agent || null, rolePrompt: s.rolePrompt || null,
            branch: s.branch, worktreePath: s.worktreePath, dirId: s.dirId,
            // dirId/branch/worktreePath are hints; target rebuilds its own paths.
          },
          messages, memoryFiles, providerState, gitBundleB64, gitBundleNote,
        };
        const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
        const enc = bundleEncrypt(String(passphrase), plaintext);
        appendEvent(s.dirId, 'session_bundled', `${s.label || s.id} → export`, s.id);
        res.json({
          ok: true, ...enc,
          meta: { v: 1, sessionId: s.id, label: s.label, messages: messages.length,
                  hasGitBundle: !!gitBundleB64, hasMemory: Object.keys(memoryFiles).length,
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
      if (!payload || payload.v !== 1 || !payload.sessionMeta) {
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

        // 2) Restore memory files.
        if (payload.memoryFiles && typeof payload.memoryFiles === 'object') {
          const memDir = getFolderMemory().sessionDir(newSession);
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

        appendEvent(dir.id, 'session_imported', `${newSid} ← bundle`, newSid);
        res.json({ ok: true, sessionId: newSid, session: newSession,
                   restored: { messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
                               memoryFiles: payload.memoryFiles ? Object.keys(payload.memoryFiles).length : 0,
                               gitRestored, gitNote } });
      } catch (e) {
        res.status(500).json({ error: 'import failed (session record created): ' + e.message, sessionId: newSid });
      }
    }));
  }

  return { mountRoutes };
}

module.exports = { createSessionBundleRoutes };
