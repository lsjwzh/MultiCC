'use strict';

const fs = require('fs');
const path = require('path');
const { renderPrompt } = require('../message-composer');

/**
 * DeepSeek Harness (dsh) adapter (@deepseek-ai/dsh).
 *
 * dsh is a Cordis plugin harness, not a stream-json CLI: its shipped headless
 * profile is one-shot with plain-text stdout and no resume. multicc instead
 * ships its own runner plugin (vendor/dsh-runner → `multicc-dsh-runner`) that
 * rides over the same dsh bundles inside a dedicated `multicc` profile
 * (~/.dsh/profiles/multicc), disables the one-shot runners, streams session
 * events as JSONL on stdout and resumes persisted sessions. ensureDshProfile()
 * bootstraps that profile idempotently — dsh itself installs the dsh-base /
 * dsh-headless bundles into ~/.dsh/profiles/node_modules on the first run, and
 * the runner resolves its @deepseek-ai imports from that shared tree.
 *
 * Auth stays native: DEEPSEEK_API_KEY (and optional DEEPSEEK_BASE_URL) in the
 * server environment flow to the child through buildChildEnv's env merge; the
 * `dsh web` Models page can also store a key through the credentials service.
 */
const DSH_PROFILE = 'multicc';
const DSH_PROFILE_VERSION = 1; // bump to force a profile re-write on upgrade
const DSH_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

function dshProfileDir(homeDir) { return path.join(homeDir, '.dsh', 'profiles', DSH_PROFILE); }

/**
 * Idempotently materialize ~/.dsh/profiles/multicc: manifest pointing at the
 * same bundles as the shipped headless profile, a patch layer that disables
 * the one-shot runners and mounts ours, and a copy of the runner package
 * under the profile's node_modules so the loader (and Node resolution for the
 * runner's @deepseek-ai imports, which reach the shared bundle tree one level
 * up) can find it. Never touches anything outside this profile directory.
 */
function ensureDshProfile({ homeDir, runnerSrcDir, fsImpl = fs } = {}) {
  const home = homeDir || require('os').homedir();
  const src = runnerSrcDir || path.join(__dirname, '..', '..', 'vendor', 'dsh-runner');
  const dir = dshProfileDir(home);
  const manifest = JSON.stringify({
    name: DSH_PROFILE,
    version: '1.0.0',
    private: true,
    dsh: { profile: { bundles: ['dsh-base', 'dsh-headless'] } },
  }, null, 2) + '\n';
  const patch = [
    '# multicc chat runner over dsh: disables the shipped one-shot headless',
    '# runners and mounts our streaming resume-capable runner instead.',
    '- id: headless-runner',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '- insert:',
    '    - id: multicc-runner',
    `      name: multicc-dsh-runner`,
  ].join('\n') + '\n';
  const stamp = path.join(dir, '.multicc-profile-version');
  const runnerDest = path.join(dir, 'node_modules', 'multicc-dsh-runner');
  const stamped = writeIfChangedSafe(fsImpl, stamp, String(DSH_PROFILE_VERSION) + '\n');
  const wroteManifest = writeIfChangedSafe(fsImpl, path.join(dir, 'package.json'), manifest);
  const wrotePatch = writeIfChangedSafe(fsImpl, path.join(dir, 'cordis.patch.yml'), patch);
  writeIfChangedSafe(fsImpl, path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  writeIfChangedSafe(fsImpl, path.join(dir, 'cordis.yml'), '[]\n');
  const runnerCurrent = fsImpl.existsSync(path.join(runnerDest, 'package.json'));
  if (stamped || wroteManifest || wrotePatch || !runnerCurrent) {
    copyTreeSafe(fsImpl, src, runnerDest);
  }
  return { dir, runnerDest };
}

function writeIfChangedSafe(fsImpl, file, content) {
  try {
    if (fsImpl.readFileSync(file, 'utf8') === content) return false;
  } catch (_) { /* write below */ }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, content);
  return true;
}

function copyTreeSafe(fsImpl, src, dest) {
  fsImpl.mkdirSync(dest, { recursive: true });
  for (const entry of fsImpl.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTreeSafe(fsImpl, from, to);
    else if (entry.isFile()) fsImpl.copyFileSync(from, to);
  }
}

function createDshAdapter({ cmd, homeDir, runnerSrcDir } = {}) {
  let bootstrapped = false;
  function bootstrap() {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
      ensureDshProfile({ homeDir, runnerSrcDir });
    } catch (error) {
      // A failed bootstrap surfaces on the first spawn as dsh's own loader
      // error — better than blocking the whole registry at startup.
      console.warn(`[multicc] dsh profile bootstrap failed: ${error && error.message}`);
    }
  }
  return {
    name: 'dsh',
    cmd,
    buildTerminalCmd(session) {
      let command = `${cmd} --profile ${DSH_PROFILE}`;
      if (session && session.model) command += ` --multicc-model ${session.model}`;
      if (session && session.cliSessionId) command += ` --multicc-resume ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      bootstrap();
      const so = env.spawnOpts;
      const args = ['--profile', DSH_PROFILE];
      if (so.rawModel && DSH_MODELS.includes(String(so.rawModel))) args.push('--multicc-model', so.rawModel);
      if (!env.historyHandle.isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--multicc-resume', env.historyHandle.cliSessionId);
      }
      // The runner takes the prompt as the trailing positional (the engine
      // appends the payload after args, matching every other adapter CLI).
      return { cmd, args, payload: renderPrompt(env) };
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      switch (event.type) {
        case 'session_started':
          return event.sessionId
            ? [{ type: 'session_started', sessionId: event.sessionId }]
            : [];
        case 'assistant_text':
          return event.text ? [{ type: 'assistant_text', text: event.text }] : [];
        case 'thinking':
          return event.text ? [{ type: 'thinking', text: event.text }] : [];
        case 'tool_update':
          return [{ type: 'tool_update',
            id: event.id,
            name: event.name || 'tool',
            input: event.input || {},
            currentFile: null,
            completed: !!event.completed,
            content: event.content || '',
            isError: !!event.isError,
          }];
        case 'status':
          return [{ type: 'status', status: event.status || 'thinking' }];
        case 'complete':
          return [{ type: 'complete' }];
        case 'error':
          return [{ type: 'error', message: String(event.message || 'dsh turn failed') }];
        default:
          return []; // session_finished and future runner lines are not chat events
      }
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createDshAdapter, ensureDshProfile, DSH_MODELS, DSH_PROFILE };
