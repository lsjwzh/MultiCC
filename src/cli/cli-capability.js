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
// That made "streams" and "is resident" look like the same question, so a CLI whose
// protocol can be resident but whose lane is not — codex-exp speaks the
// long-lived app-server protocol yet is still spawned per turn — had nowhere to
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
});

const FAMILIES = Object.freeze({
  claude: 'anthropic',
  'claude-exp': 'anthropic',
  codex: 'openai',
  'codex-exp': 'openai',
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

// The lane a SESSION may run on, which is not always the lane its CLI is in.
//
// A resident child outlives the attempt that spawned it, but the codex provider
// path materializes a credential-bearing CODEX_HOME per attempt and scrubs it
// when the turn ends (src/codex/proxy-policy.js: "every concrete provider must
// be materialized as an attempt-scoped local proxy route"). A codex session
// routed through a concrete provider therefore stays on the per-turn lane: a
// warm child would outlive — and keep using — credentials belonging to a
// finished attempt. Every other resident protocol routes through a host-side
// proxy whose identity is per-session, so it may stay warm.
//
// Callers that hold the session ask here; without one only the static lane is
// known, and `isResident` is the answer to that narrower question.
function isResidentSession(cli, session) {
  if (!isResident(cli)) return false;
  if (protocolFamilyOf(cli, 'api') !== 'openai_responses') return true;
  const providerId = String(session?.provider || '').trim();
  const subProviderId = String(session?.subagent?.providerId || '').trim();
  const concrete = id => !!id && id !== '_default_';
  return !(concrete(providerId) || concrete(subProviderId));
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
// (`anthropic`). Returns null for a CLI this table does not know, so each caller
// keeps its own fallback rather than inheriting one from here.
function protocolFamilyOf(cli, format = 'wire') {
  const family = FAMILIES[nameOf(cli)];
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
