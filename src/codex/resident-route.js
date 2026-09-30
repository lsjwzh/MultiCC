'use strict';

const fs = require('node:fs');
const { protocolFamilyOf } = require('../cli/cli-capability');
const { assertCodexProxyConfigApplied, codexProxyConfigRequired } = require('./proxy-policy');

// A resident lane keeps ONE child warm across turns, so its managed provider
// route has to outlive a single turn. Claude's route lives in ANTHROPIC_* and the
// child env is rebuilt per turn, so residency there is only a matter of not
// rotating the route capability (see provider-attempt-runtime). Codex's route
// lives *inside* CODEX_HOME (config.toml + agents/*.toml), which the per-turn
// design creates as a private attempt home and deletes the moment the child
// closes — a resident codex child would lose its route between turns.
//
// This module owns the resident variant: one home per (logical session,
// capability). The capability is the right scope because it is exactly what is
// baked into config.toml — a home may never outlive the capability written into
// it, or the child would keep sending a revoked route. Resident lanes hold that
// capability stable while the spawn contract holds, so the home (and therefore
// the child) survives; the moment the contract moves, the lane gets a new
// capability, this module replaces the home, and CODEX_HOME changes — which is
// what the app-server lane's routing fingerprint watches for, so the child is
// recycled instead of hot-swapping a route that codex only reads at startup.

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function createCodexResidentRoutes({ providers, logger = console } = {}) {
  if (!providers || typeof providers.applyCodexProxyConfig !== 'function'
      || typeof providers.releaseCodexProxyConfig !== 'function'
      || typeof providers.applyClaudeProxyEnv !== 'function') {
    throw new TypeError('[resident-route] a provider port is required');
  }
  const homes = new Map();      // logicalSessionId -> current route
  const entries = new Map();    // home path -> current or process-pinned route
  const retired = new Set();

  function releaseHolder(entry) {
    if (!entry.retired || entry.readers) return false;
    retired.delete(entry);
    entries.delete(entry.holder.CODEX_HOME);
    try { return providers.releaseCodexProxyConfig(entry.holder); } catch (error) {
      // Same fail-open as the per-turn path: an unscrbubbed home is an orphan
      // attempt-home's own sweep will collect, never a reason to fail a turn.
      logger.warn('[multicc/codex-resident] failed to scrub a private Codex home; orphan retained', {
        code: (error && error.code) || null,
      });
      return false;
    }
  }

  // Wall-clock age says nothing about a running turn. A retired home remains
  // readable until every child pinned to that exact path has actually closed.
  function retire(entry) {
    entry.retired = true;
    retired.add(entry);
    releaseHolder(entry);
  }

  function retain(home) {
    const entry = entries.get(home);
    if (!entry) return () => {};
    entry.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.readers -= 1;
      releaseHolder(entry);
    };
  }

  function prepareCodex(childEnv, options = {}) {
    const logicalSessionId = clean(options.logicalSessionId);
    const capability = clean(options.sessionId);
    if (!logicalSessionId || !capability) return false;
    let entry = homes.get(logicalSessionId);
    // A home may only outlive the route baked into it while nobody is reading
    // it. A moved capability means config.toml disagrees with the capability the
    // child would send, and a home that vanished under us means the same thing
    // for a different reason — either way the replacement has to be a DIFFERENT
    // directory, because that is the change the lane's routing fingerprint turns
    // into a respawn.
    if (entry && (entry.capability !== capability || !fs.existsSync(entry.holder.CODEX_HOME))) {
      homes.delete(logicalSessionId);
      retire(entry);
      entry = null;
    }
    if (!entry) {
      // A fresh holder seeded with the source home is how the per-turn path
      // keeps its lease private; here the holder itself is what stays live.
      const holder = { CODEX_HOME: String(childEnv.CODEX_HOME || '') };
      if (!providers.applyCodexProxyConfig(holder, options)) return false;
      entry = { capability, holder, readers: 0, retired: false };
      homes.set(logicalSessionId, entry);
      entries.set(holder.CODEX_HOME, entry);
    }
    childEnv.CODEX_HOME = entry.holder.CODEX_HOME;
    return true;
  }

  // Route one resident turn's child env. Claude and codex differ only in where
  // the route is materialized, so the lane asks for both through one call.
  function prepare(childEnv, options = {}) {
    if (!childEnv || typeof childEnv !== 'object') return false;
    const family = protocolFamilyOf(options.cli, 'api');
    // A resident CLI of neither family (zcode) owns its route already: its
    // provider was materialized into a private HOME by the route overrides, and
    // the Anthropic hop would only plant ANTHROPIC_* the engine never reads.
    if (family === null && options.cli) return false;
    if (family !== 'openai_responses') {
      providers.applyClaudeProxyEnv(childEnv, {
        providerId: options.providerId,
        sessionId: options.sessionId,
        subagent: options.subagent,
        port: options.port,
        officialOAuth: options.officialOAuth,
      });
      return true;
    }
    // Every concrete provider must end up on a managed route; a resident codex
    // child that silently kept the raw home would bypass the proxy entirely. What
    // this reports is the physical outcome, not the policy's verdict — a session
    // allowed to stay on its native home is not a routed child at all.
    const applied = prepareCodex(childEnv, options);
    assertCodexProxyConfigApplied({
      required: codexProxyConfigRequired({
        providerId: options.providerId,
        // The policy reads the sub-provider separately: a session with no
        // provider of its own still needs a managed route when its subagent
        // names one, and missing that here would fail open.
        subagentProviderId: options.subagent && options.subagent.providerId,
      }),
      applied,
    });
    return applied;
  }

  function release(logicalSessionId) {
    const id = clean(logicalSessionId);
    const entry = homes.get(id);
    if (!entry) return false;
    homes.delete(id);
    retire(entry);
    return true;
  }

  function stats() {
    return Object.freeze({ live: homes.size, retired: retired.size });
  }

  return Object.freeze({ prepare, prepareCodex, release, retain, stats });
}

let shared = null;

function sharedRoutes() {
  if (!shared) {
    // Lazy so this module can be required before providers/core finishes its own
    // initialization, and so tests can build their own port-injected instance.
    shared = createCodexResidentRoutes({ providers: require('../providers/core') });
  }
  return shared;
}

function prepareResidentChildEnv(childEnv, options) {
  return sharedRoutes().prepare(childEnv, options);
}

// A teardown path (stream close, hibernation, delete, shutdown) may reach here
// long before any resident codex turn ran, so this never builds the singleton:
// with nothing prepared there is nothing to release, and a process that only ever
// served claude sessions must not pay for this module.
//
// Homes belong to sessions, not an idle timer. The lane owns process idle
// reclamation; lifecycle close retires the route and actual process close
// releases its final reader. Crash leftovers use attempt-home's startup sweep.
function releaseResidentRoute(logicalSessionId) {
  return shared ? shared.release(logicalSessionId) : false;
}

function retainResidentRoute(home) {
  return shared ? shared.retain(home) : () => {};
}

module.exports = {
  createCodexResidentRoutes,
  prepareResidentChildEnv,
  releaseResidentRoute,
  retainResidentRoute,
};
