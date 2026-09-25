'use strict';

// The independent facts about a CLI, in one table.
//
//   protocol  — how the child frames its conversation with the host.
//   lifecycle — whether that child outlives the turn it was started for.
//   cancel    — how stopping a turn stops the lane:
//                 process — the turn IS the child; cancelling reaps it
//                 turn    — the turn is interrupted in place, the child survives
//
// These used to be one fact derived from an inline pair of claude CLI names
// (`Array.includes` over a two-element name list) repeated at ten call sites.
// That made "streams" and "is resident" look like the same question, so a CLI
// whose protocol is long-lived but whose lane had not caught up — codex-exp
// speaks the app-server protocol but was still spawned per turn — had nowhere to
// be described, and moving a CLI between lanes meant editing ten places without
// missing one.
//
// Only entries that differ from the default are listed, so an unknown or newly
// added CLI behaves exactly like the non-claude CLIs always have.

const DEFAULT_CAPABILITY = Object.freeze({ protocol: 'cli-once', lifecycle: 'per-turn', cancel: 'process' });

const CAPABILITIES = Object.freeze({
  claude: Object.freeze({ protocol: 'claude-stream', lifecycle: 'resident', cancel: 'process' }),
  // The SDK lane interrupts the in-flight turn and keeps its child, so a session
  // is stopped as soon as no turn runs — not when the process disappears.
  'claude-exp': Object.freeze({ protocol: 'claude-stream-sdk', lifecycle: 'resident', cancel: 'turn' }),
  codex: Object.freeze({ protocol: 'codex-exec-json', lifecycle: 'per-turn', cancel: 'process' }),
  // `codex app-server --listen stdio://` is a long-lived server and the bridge
  // holds it across turns (`--resident`), so this is the resident lane like
  // claude. The thread survives a reap, so cancel/recycle re-attach rather than
  // losing the conversation.
  'codex-exp': Object.freeze({ protocol: 'codex-app-server', lifecycle: 'resident', cancel: 'process' }),
  // ACP is a per-turn local agent protocol: the bridge spawns the agent for the
  // turn and exits with it, so cancelling reaps the child. opencode was the
  // first CLI on this lane; gemini and grok ride the same bridge (acp.js).
  opencode: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
  gemini: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
  grok: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
});

// Which upstream API dialect a CLI's protocol talks. This is deliberately NOT
// the transport name in CAPABILITIES: `acp` is the local agent protocol, and an
// ACP agent's upstream dialect is its own business (the agent holds the
// credential), so protocolFamilyOf answers null for it rather than guessing.
const FAMILIES = Object.freeze({
  claude: 'anthropic',
  'claude-exp': 'anthropic',
  codex: 'openai',
  'codex-exp': 'openai',
  opencode: 'acp',
  gemini: 'acp',
  grok: 'acp',
});

function nameOf(cli) {
  return String(cli == null ? '' : cli).trim().toLowerCase();
}

function capabilityOf(cli) {
  return CAPABILITIES[nameOf(cli)] || DEFAULT_CAPABILITY;
}

// The resident lane. A resident CLI keeps one child across turns, so its turns
// are cancelled and observed through the stream runtime, never through a
// per-turn child process.
function isResident(cli) {
  return capabilityOf(cli).lifecycle === 'resident';
}

// The lane a SESSION may run on. This used to be narrower than the CLI's own
// lane: a codex session routed through a concrete provider materialized a
// credential-bearing CODEX_HOME per attempt and scrubbed it when the turn ended,
// so a warm child would have outlived the credentials it was holding, and such a
// session stayed per-turn (src/codex/proxy-policy.js).
//
// That is no longer the case. A resident lane now holds a route that outlives the
// attempt on both provider paths: claude's rides in the ANTHROPIC_* env the host
// rebuilds every turn (and in a route capability the lane keeps stable while its
// spawn contract holds — src/chat/provider-attempt-runtime.js), while a codex
// session owns a session-scoped CODEX_HOME instead of an attempt-scoped one
// (src/codex/resident-route.js). So a session's provider no longer moves it off
// the resident lane, and every resident CLI answers true here.
//
// What that buys is residency — one child across turns instead of a respawn per
// turn. What it costs is attribution scope: a child orphaned by a finished
// attempt of the same spawn contract can still reach the host proxy during a
// later attempt of that session. It holds only an opaque local capability, never
// an upstream key, so this widens attribution, not credential exposure.
//
// The predicate keeps its session-shaped call sites (each caller has the session
// in hand anyway) without consulting one: today the answer depends on the CLI
// alone, and a caller without a session asks `isResident` for that same question.
function isResidentSession(cli) {
  return isResident(cli);
}

function protocolOf(cli) {
  return capabilityOf(cli).protocol;
}

// True when stopping a turn stops the lane's child, i.e. "the runner has
// stopped" and "the process is gone" are the same statement. False on a lane
// that interrupts in place: there the child outlives the cancel, so only the
// absence of an in-flight turn proves the runner stopped.
function cancelStopsProcess(cli) {
  return capabilityOf(cli).cancel === 'process';
}

// Wire value carried on a turn request and on the provider route minted for it;
// a route is only accepted for a turn whose transport matches (turn-request.js).
// Kept as the historical strings so persisted turns and route contracts stay
// valid even as the lanes they name are generalized.
function transportOf(cli) {
  return isResident(cli) ? 'claude-stream' : 'cli-process';
}

// Which API dialect the CLI speaks upstream. `format` only picks the spelling:
// the wire name (`anthropic-messages`) or a provider summary's apiFormat
// (`anthropic`). Returns null for a CLI this table does not know — including the
// ACP family, whose agent holds its own upstream credential and dialect — so
// each caller keeps its own fallback rather than inheriting one from here.
function protocolFamilyOf(cli, format = 'wire') {
  const family = FAMILIES[nameOf(cli)];
  if (family === 'acp') return null;
  if (family === 'anthropic') return format === 'api' ? 'anthropic' : 'anthropic-messages';
  if (family === 'openai') return format === 'api' ? 'openai_responses' : 'openai-responses';
  return null;
}

module.exports = {
  CAPABILITIES,
  DEFAULT_CAPABILITY,
  cancelStopsProcess,
  capabilityOf,
  isResident,
  isResidentSession,
  protocolFamilyOf,
  protocolOf,
  transportOf,
};
