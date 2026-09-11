'use strict';

// Claude Code ≥2.1.x applies the `env` block of ~/.claude/settings.json AFTER
// the inherited process environment, so the user-level settings silently
// override the per-session provider env multicc injects into a child process.
// Observed on 2.1.268: a spawn with process-env ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_OPUS_MODEL pointing at provider A
// was routed entirely by ~/.claude/settings.json (provider B) — base URL,
// token, and tier→model aliases all came from the user settings, bypassing
// the local ccfw proxy and producing cross-provider model errors like
// "There's an issue with the selected model (glm-5.3-flash)" right after a
// provider switch.
//
// `--settings <file>` is a command-line settings source with HIGHER
// precedence than user settings (verified empirically on 2.1.268). Mirroring
// the final routing env (post provider-merge + ccfw proxy rewrite) into a
// per-session settings file and passing it via --settings therefore makes the
// session's provider authoritative again. A file (0600) is used instead of
// inline JSON so the auth token never appears in `ps` output.

const os = require('os');
const path = require('path');
const { atomicWriteJson, ensurePrivateDir } = require('../runtime-security');

const OVERRIDE_DIR = path.join(os.homedir(), '.multicc', 'claude-settings-overrides');

// Keys that decide WHERE a claude process talks and WHICH model it asks for.
// Everything else (MULTICC_*, TERM, …) stays process-env only.
const ROUTING_KEY_RE = /^(?:ANTHROPIC_|CLAUDE_CODE_)/;

// Mirror of CLAUDE_ROUTING_KEYS in providers/core.js (duplicated to avoid a
// require cycle). Settings files MERGE per key, so a key the session's
// provider does NOT define would survive from ~/.claude/settings.json and
// leak that provider's model/route into this session (e.g. a missing
// ANTHROPIC_DEFAULT_HAIKU_MODEL falling through to the global provider's
// value). Blank those out — an empty env value reads as unset to the CLI.
const BLANK_WHEN_ABSENT_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SIMPLE',
];

function routingEnvOf(childEnv) {
  const env = {};
  if (!childEnv || typeof childEnv !== 'object') return env;
  for (const [key, value] of Object.entries(childEnv)) {
    if (ROUTING_KEY_RE.test(key) && typeof value === 'string') env[key] = value;
  }
  return env;
}

// Write the per-session settings override file and return its path, or null
// when there is nothing to override (provider-less sessions carry no routing
// keys and extraSettings is empty — passing an empty file would be noise).
// Rewritten on every spawn so a provider switch (which recycles the process
// via the chat-stream env fingerprint) is picked up by the next process.
function settingsOverrideFor(sessionName, childEnv, extraSettings) {
  const env = routingEnvOf(childEnv);
  const extra = (extraSettings && typeof extraSettings === 'object') ? extraSettings : null;
  if (!Object.keys(env).length && (!extra || !Object.keys(extra).length)) return null;
  if (Object.keys(env).length) {
    for (const key of BLANK_WHEN_ABSENT_KEYS) {
      if (!(key in env)) env[key] = '';
    }
  }
  ensurePrivateDir(OVERRIDE_DIR);
  const file = path.join(OVERRIDE_DIR, `${encodeURIComponent(String(sessionName || 'session'))}.json`);
  atomicWriteJson(file, { ...(extra || {}), env });
  return file;
}

module.exports = { settingsOverrideFor, routingEnvOf, OVERRIDE_DIR, ROUTING_KEY_RE };
