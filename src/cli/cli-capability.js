'use strict';

// The independent facts about a CLI — its lane capability (protocol, lifecycle,
// cancel), its upstream dialect, and the two-level CLI catalogue (family → kind
// → lane) with everything derived from it — live in
// native/core/src/cli_capability.rs, the authoritative table. This module asks
// the native addon for one snapshot at load, freezes it, and from then on every
// question is a lookup by normalized id: nothing here crosses the native
// boundary per call, and nothing here re-derives a fact.
//
// The mirrors are public/provider-catalog.js (web) and
// app/lib/utils/cli_display.dart (app); tests/test-cli-display-parity.js reads
// all three and fails when they drift. Add a CLI in the Rust table first, then
// mirror it — an id the table does not know falls back to its own raw id
// everywhere, never to a neighbour's name.
const { getNative } = require('../native/runtime');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

const SNAPSHOT = deepFreeze(JSON.parse(getNative().cliCatalog()));
const {
  kinds: KINDS,
  defaultKinds: DEFAULT_KINDS,
  defaultColour: DEFAULT_COLOUR,
  defaultCapability: DEFAULT_CAPABILITY,
  capabilities: CAPABILITIES,
  clis: CLIS,
  display: DISPLAY,
  aliases: ALIASES,
} = SNAPSHOT;

// Own keys only: an id like `constructor` must not resolve to Object.prototype.
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
const raw = cli => String(cli == null ? '' : cli).trim();

// The single normalization point: trimmed, lower-case, then any retired id
// (claude-exp) folded into the lane that replaced it. Every lookup below is by
// this key, so a persisted old id answers exactly like its successor.
function nameOf(cli) {
  const key = raw(cli).toLowerCase();
  return own(ALIASES, key) || key;
}

function capabilityOf(cli) {
  return own(CAPABILITIES, nameOf(cli)) || DEFAULT_CAPABILITY;
}

function displayOf(cli) {
  return own(DISPLAY, nameOf(cli)) || null;
}

// Which CLI family a lane belongs to — by family id, or by any of its lane ids.
// Unknown answers null, so each caller keeps its own fallback.
function familyOf(cli) {
  const key = nameOf(cli);
  if (!key) return null;
  if (own(CLIS, key)) return key;
  return own(SNAPSHOT.laneFamily, key) || null;
}

// The outward name of the CLI ("Claude" for claude, claude-exp and any future
// lane of that family alike). An unknown id keeps its own spelling.
function familyNameOf(cli) {
  const family = familyOf(cli);
  return family ? CLIS[family].name : raw(cli);
}

// An unknown id keeps its own spelling — never a neighbour's product name.
function displayNameOf(cli) {
  const entry = displayOf(cli);
  return entry ? entry.displayName : raw(cli);
}

function shortMarkOf(cli) {
  const entry = displayOf(cli);
  return entry ? entry.shortMark : displayNameOf(cli).slice(0, 1).toUpperCase();
}

function colourOf(cli) {
  const entry = displayOf(cli);
  return entry ? entry.colour : DEFAULT_COLOUR;
}

// Vendor-auth CLIs sign in with their own account, so no multicc provider is
// bound to their sessions.
function isProviderless(cli) {
  const entry = displayOf(cli);
  return entry ? entry.providerless : false;
}

function providerlessClis() {
  return new Set(Object.keys(DISPLAY).filter(id => DISPLAY[id].providerless));
}

// null for a live lane and for an unknown id alike: a caller must not have to
// tell "no plan" from "never heard of it" to render a warning.
function deprecationOf(cli) {
  const entry = displayOf(cli);
  if (!entry || entry.deprecated !== true) return null;
  return { replacedBy: entry.replacedBy || null };
}

function isDeprecated(cli) {
  return deprecationOf(cli) !== null;
}

// The small line of a two-line CLI row; an unknown id answers itself.
function engineOf(cli) {
  const entry = displayOf(cli);
  return entry && entry.engine ? entry.engine : raw(cli);
}

// Unknown ids answer both kinds: a CLI the table has never heard of must not
// silently vanish from a picker.
function kindsOf(cli) {
  const entry = displayOf(cli);
  return entry && entry.kinds ? entry.kinds : DEFAULT_KINDS;
}

function offersIn(cli, kind) {
  return kindsOf(cli).includes(nameOf(kind));
}

// A retired id that resolves to a live lane (`claude-exp` -> `claude`). Pickers
// must not offer it; input paths keep accepting it.
function isAlias(cli) {
  return Object.prototype.hasOwnProperty.call(ALIASES, raw(cli).toLowerCase());
}

function knownClis() {
  return Object.keys(DISPLAY);
}

// The lanes a family (or any lane of it) offers in one kind, in picker order.
// Fresh rows per call, as callers have always been free to annotate them.
function lanesOf(familyOrLane, kind) {
  const familyId = familyOf(familyOrLane);
  const wanted = nameOf(kind);
  if (!familyId || !KINDS.includes(wanted)) return [];
  return SNAPSHOT.lanes[familyId][wanted].map(row => ({ ...row }));
}

function familiesFor(kind) {
  const wanted = nameOf(kind);
  return KINDS.includes(wanted) ? [...SNAPSHOT.familiesFor[wanted]] : [];
}

// The family's own CLI artifact: { auto, command, display, manual, package }.
function updateOf(cli) {
  const family = familyOf(cli);
  return (family && own(SNAPSHOT.updates, family)) || null;
}

function updateSpecs() {
  return SNAPSHOT.updates;
}

function npmPackages() {
  return SNAPSHOT.npmPackages;
}

// A lane whose engine ships inside MultiCC instead of the family's artifact.
function isBundled(cli) {
  return own(SNAPSHOT.bundled, nameOf(cli)) === true;
}

function bundledEnginesOf(cli) {
  const family = familyOf(cli);
  const engines = family && own(SNAPSHOT.bundledEngines, family);
  return engines ? engines.map(engine => ({ ...engine })) : [];
}

function isResident(cli) {
  return capabilityOf(cli).lifecycle === 'resident';
}

// The lane a SESSION may run on. A session's provider no longer moves it off
// the resident lane (claude's route rides the per-turn ANTHROPIC_* env, codex
// owns a session-scoped CODEX_HOME — src/codex/resident-route.js), so the
// answer depends on the CLI alone; the session-shaped call sites keep their
// signature.
function isResidentSession(cli) {
  return isResident(cli);
}

function protocolOf(cli) {
  return capabilityOf(cli).protocol;
}

// True when stopping a turn stops the lane's child; false on a lane that
// interrupts in place, where only "no turn in flight" proves the runner stopped.
function cancelStopsProcess(cli) {
  return capabilityOf(cli).cancel === 'process';
}

// Wire value on a turn request and on the provider route minted for it; kept as
// the historical strings so persisted turns and route contracts stay valid.
function transportOf(cli) {
  return isResident(cli) ? 'claude-stream' : 'cli-process';
}

// The upstream dialect, as the wire name (`anthropic-messages`) or a provider
// summary's apiFormat (`format === 'api'`). null for ACP agents and unknown CLIs.
function protocolFamilyOf(cli, format = 'wire') {
  const family = own(SNAPSHOT.protocolFamilies, nameOf(cli));
  if (!family) return null;
  return format === 'api' ? family.api : family.wire;
}

module.exports = {
  ALIASES,
  CAPABILITIES,
  CLIS,
  DEFAULT_CAPABILITY,
  DEFAULT_COLOUR,
  DEFAULT_KINDS,
  DISPLAY,
  KINDS,
  bundledEnginesOf,
  cancelStopsProcess,
  capabilityOf,
  colourOf,
  deprecationOf,
  displayNameOf,
  displayOf,
  engineOf,
  familiesFor,
  familyNameOf,
  familyOf,
  isBundled,
  isDeprecated,
  isAlias,
  isProviderless,
  isResident,
  isResidentSession,
  kindsOf,
  knownClis,
  lanesOf,
  nameOf,
  npmPackages,
  offersIn,
  protocolFamilyOf,
  protocolOf,
  providerlessClis,
  shortMarkOf,
  transportOf,
  updateOf,
  updateSpecs,
};
