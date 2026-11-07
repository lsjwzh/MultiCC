'use strict';

// Cross-CLI switching deliberately does not translate vendor transcripts.
// Each CLI keeps its own native session and settings; continuity between those
// independent sessions is provided by a bounded, visible-text checkpoint.
//
// The rules live in `native/core/src/cli_switch.rs`. This bridge owns what only
// the JS runtime can do: in-place mutation of the live session objects,
// `repairZcodeSessionState`, the CLI-table lookups (provider-less lanes, resident
// transport) and the vendor facts behind `routingSelection`.

const { getNative } = require('./native/runtime');
const { repairZcodeSessionState } = require('./cli-adapters/zcode-session');
const { isResidentSession, providerlessClis } = require('./cli/cli-capability');
const { nativeVendorOf } = require('./providers/native-vendor');
const { nativeOpenCodeId } = require('./providers/native-opencode');

// No Node fallback: these kernels are Rust-only.
const native = getNative();
const SUPPORTED_CHAT_CLIS = Object.freeze(
  JSON.parse(native.cliSwitchCatalog()).supportedChatClis,
);

// Derived, not listed: "owns its own account/model config" is a column of the
// canonical CLI table (src/cli/cli-capability.js DISPLAY). The set that used to
// be written out here was one of three copies of the same five ids.
const PROVIDERLESS_CLIS = providerlessClis();
const PROVIDERLESS_LIST = Object.freeze([...PROVIDERLESS_CLIS]);

function supportedCli(cli) {
  return SUPPORTED_CHAT_CLIS.includes(String(cli || ''));
}

function call(op, payload) {
  const out = JSON.parse(native.cliSwitchRequest(op, JSON.stringify(payload)));
  if (!out.ok) throw new Error(out.error.message);
  return out.value;
}

// Does each Auto Provider candidate name one of THIS lane's native lines?
// `nativeVendorOf` / `nativeOpenCodeId` own the vendor tables, so the kernel
// only receives the boolean fact and never duplicates them.
function selectionFlags(value, cli) {
  const candidates = value && Array.isArray(value.candidates) ? value.candidates : [];
  return candidates.map(candidate => {
    const providerId = candidate && candidate.providerId;
    const vendor = nativeVendorOf(providerId);
    if (vendor && vendor.cli === cli) return true;
    return cli === 'opencode' && nativeOpenCodeId(providerId) !== null;
  });
}

function activeState(session, now, cli) {
  const providerless = PROVIDERLESS_CLIS.has(cli);
  return call('activeState', {
    session: {
      cliSessionId: session.cliSessionId,
      _streamSessionId: session._streamSessionId,
      model: session.model,
      effort: session.effort,
      provider: session.provider,
      providerSelection: session.providerSelection,
      subagent: session.subagent,
      agent: session.agent,
      reportedModel: session.reportedModel,
    },
    now,
    providerless,
    selectionFlags: providerless ? selectionFlags(session.providerSelection, cli) : [],
  });
}

function ensureCliStates(session, now = Date.now()) {
  if (!session || session.kind !== 'chat' || !supportedCli(session.cli || 'claude')) return false;
  const repaired = repairZcodeSessionState(session);
  const before = JSON.stringify(session.cliStates || null);
  if (!session.cliStates || typeof session.cliStates !== 'object' || Array.isArray(session.cliStates)) {
    session.cliStates = {};
  }
  const cli = session.cli || 'claude';
  const previous = session.cliStates[cli] && typeof session.cliStates[cli] === 'object'
    ? session.cliStates[cli]
    : {};
  // Active legacy fields remain authoritative for the currently selected CLI.
  session.cliStates[cli] = { ...previous, ...activeState(session, previous.updatedAt || now, cli) };
  return repaired || before !== JSON.stringify(session.cliStates);
}

function rememberActiveCliState(session, now = Date.now()) {
  if (!session || session.kind !== 'chat' || !supportedCli(session.cli || 'claude')) return null;
  ensureCliStates(session, now);
  const cli = session.cli || 'claude';
  const state = { ...(session.cliStates[cli] || {}), ...activeState(session, now, cli) };
  session.cliStates[cli] = state;
  return state;
}

function activateCliState(session, targetCli, options = {}) {
  if (!session) throw new Error('session required');
  if (!supportedCli(targetCli)) throw new Error('unsupported cli');
  const now = options.now || Date.now();
  const fromCli = session.cli || 'claude';
  rememberActiveCliState(session, now);
  if (options.fresh === true) delete session.cliStates[targetCli];

  const defaults = options.defaults || {};
  const existing = session.cliStates[targetCli] && typeof session.cliStates[targetCli] === 'object'
    ? session.cliStates[targetCli]
    : null;
  // A remembered native id is only worth reusing if the target CLI still has
  // that session. `false` is a definite "gone"; anything else keeps the old
  // optimistic behaviour. The probe callback is native to the host, so it runs
  // here and only its answer crosses the boundary.
  let probeRan = false;
  let probeExists = null;
  if (existing && (existing.cliSessionId || existing.streamSessionId) && options.fresh !== true
    && typeof options.nativeSessionExists === 'function') {
    probeRan = true;
    try { probeExists = options.nativeSessionExists(targetCli, existing); } catch (_) { probeExists = null; }
  }
  const providerless = PROVIDERLESS_CLIS.has(targetCli);
  const plan = call('activate', {
    now,
    targetCli,
    fresh: options.fresh === true,
    kind: session.kind,
    residentTarget: !!isResidentSession(targetCli, session),
    existing: existing ? { ...existing } : null,
    probeRan,
    probeExists,
    defaults: {
      model: defaults.model,
      effort: defaults.effort,
      provider: defaults.provider,
      subagent: defaults.subagent,
      agent: defaults.agent,
    },
    providerlessTarget: providerless,
    existingSelectionFlags: existing ? selectionFlags(existing.providerSelection, targetCli) : [],
    currentEpoch: session.cliSwitchEpoch,
  });

  session.cli = targetCli;
  session.cliSessionId = plan.fields.cliSessionId;
  if (plan.fields.hasStreamSessionId) session._streamSessionId = plan.fields.streamSessionId;
  else delete session._streamSessionId;
  session.model = plan.fields.model;
  session.effort = plan.fields.effort;
  session.provider = plan.fields.provider;
  session.providerSelection = plan.fields.providerSelection;
  session.subagent = plan.fields.subagent;
  session.agent = plan.fields.agent;
  if (plan.fields.hasReportedModel) session.reportedModel = plan.fields.reportedModel;
  else delete session.reportedModel;
  session.streaming = plan.fields.streaming;
  session.cliSwitchEpoch = plan.fields.cliSwitchEpoch;

  session.cliStates[targetCli] = plan.entry;
  return {
    fromCli,
    toCli: targetCli,
    reused: plan.reused,
    staleNativeSessionId: plan.staleNativeSessionId,
    state: session.cliStates[targetCli],
  };
}

function stateSummary(session) {
  if (!session || !session.cliStates || typeof session.cliStates !== 'object') return {};
  return call('stateSummary', {
    cliStates: session.cliStates,
    providerlessClis: PROVIDERLESS_LIST,
  });
}

// Clearing a logical chat must invalidate every vendor-native conversation,
// not only the CLI that happens to be active. Otherwise switching away and
// back after /clear resurrects context the user explicitly discarded.
// Per-CLI configuration is intentionally preserved.
function clearAllNativeCliStates(session, now = Date.now()) {
  if (!session || session.kind !== 'chat') return 0;
  ensureCliStates(session, now);
  const plan = call('clearPlan', { cliStates: session.cliStates });
  for (const entry of plan.states) {
    const state = session.cliStates[entry.cli];
    state.cliSessionId = null;
    state.streamSessionId = null;
    state.updatedAt = now;
  }
  session.cliSessionId = null;
  delete session._streamSessionId;
  return plan.cleared;
}

function messageText(message) {
  return call('messageText', { message });
}

function buildHandoffCheckpoint({ session, fromCli, toCli, history, git, now = Date.now(), maxMessages = 16, maxChars = 12000 }) {
  const built = call('checkpoint', {
    session: session
      ? { taskState: session.taskState, summary: session.summary }
      : session,
    history,
    maxMessages,
    maxChars,
  });
  return {
    version: 1,
    // `new Date(now).toISOString()` (and its RangeError contract) stays here.
    createdAt: new Date(now).toISOString(),
    fromCli,
    toCli,
    task: built.task,
    git: git || null,
    transcript: built.transcript,
  };
}

function renderHandoffPrompt(handoff) {
  return call('renderPrompt', { handoff });
}

module.exports = {
  SUPPORTED_CHAT_CLIS,
  supportedCli,
  ensureCliStates,
  rememberActiveCliState,
  activateCliState,
  stateSummary,
  clearAllNativeCliStates,
  buildHandoffCheckpoint,
  renderHandoffPrompt,
  messageText,
};
