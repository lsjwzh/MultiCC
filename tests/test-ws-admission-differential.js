'use strict';

// The admission wiring, case for case against the frozen Node transcription.
//
// `tests/test-ws-connection-router.js` covers the router's behaviour; this
// file covers the hand-off: for every case in the frozen corpus it drives the
// real `mountWsConnectionRouter` with facts that reproduce the case and
// asserts what the retired block would have produced -- the close code and
// reason, the metrics in order, the deprecation warning, the socket
// annotations, the `Session does not exist.` frame, and whether the one-use
// ticket was consumed at all.
//
// The corpus is the one `docs/rust-migration/differential/ws-admission-oracle.js`
// writes from `tests/helpers/legacy-ws-admission.js`; the Rust kernel is
// compared against the same file in `multicc_core::ws_admission`'s own tests,
// so a divergence here is a wiring fault rather than a kernel one.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createLogger } = require('../src/native/binding').observability;
const { mountWsConnectionRouter } = require('../src/ws/connection-router');
const corpus = require('../docs/rust-migration/differential/ws-admission-corpus.json');

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  closes = [];
  send(_data, _options, callback) { callback?.(); }
  ping() {}
  terminate() { this.readyState = WebSocket.CLOSED; }
  close(...args) { this.closes.push(args); this.readyState = WebSocket.CLOSING; }
}

// The corpus sweeps `addressedSessionId` directly, which the router derives
// from the query string: `session` on the chat path, `id` on the session
// paths, nothing on the sessionless ones. Only the chat and workspace paths
// appear in the corpus, plus `/ws/aux`, which is sessionless -- so a case that
// addresses a session on `/ws/aux` cannot be reproduced through a URL and is
// covered by the kernel's own corpus test instead.
const SESSIONLESS = new Set(['/ws/voice', '/ws/tts', '/ws/workspace', '/ws/meta', '/ws/aux',
  '/ws/remote-screen']);

function url(facts) {
  const query = new URLSearchParams();
  if (facts.path === '/ws/chat') {
    if (facts.sessionParam !== null) query.set('session', facts.sessionParam);
  } else if (!SESSIONLESS.has(facts.path) && facts.addressedSessionId !== null) {
    query.set('id', facts.addressedSessionId);
  }
  if (facts.addressedDirectoryId !== null && facts.path === '/ws/workspace') {
    query.set('dirId', facts.addressedDirectoryId);
  }
  if (facts.shareParam) query.set('share', facts.shareParam);
  if (facts.hasTicketParam) query.set('ticket', 'ticket-value');
  if (facts.allowLegacyWsToken || facts.tokenValid) query.set('token', 'token-value');
  const text = query.toString();
  return text ? `${facts.path}?${text}` : facts.path;
}

// Can this case be reproduced through a URL, with the same addressed ids? The
// router derives them from the query string, so a combination it cannot
// produce -- a chat socket addressing a directory, a sessionless path
// addressing a session -- is covered by the kernel's corpus test instead.
function reproducible(facts) {
  if (facts.addressedDirectoryId !== null && facts.path !== '/ws/workspace') return false;
  if (facts.path === '/ws/chat') return facts.addressedSessionId === facts.sessionParam;
  if (SESSIONLESS.has(facts.path)) return facts.addressedSessionId === null;
  return true;
}

// Four routers cover the whole corpus: the two legacy opt-in flags are
// mount-time options, so there is one mount per combination, and within a
// mount every port reads `state.facts`, so a case is replayed by setting it.
// Mounting one router per case would leave a thousand live heartbeat intervals
// behind.
function mount(t, { allowLegacyWsCookie, allowLegacyWsToken }) {
  const wss = new EventEmitter();
  wss.clients = new Set();
  const state = { facts: null, metrics: [], logs: [], sent: [], ticket: 0, share: 0 };
  const facts = () => state.facts;
  const record = line => state.logs.push(JSON.parse(line));
  const { wsPingInterval } = mountWsConnectionRouter(wss, {
    metrics: { inc: name => state.metrics.push(name), set() {} },
    logger: createLogger({ sink: { log: record, warn: record, error: record } }),
    share: {
      access: () => { state.share += 1; return facts().shareAccess; },
    },
    parseCookies: () => (facts().authCookie ? { multicc_auth: 'cookie-value' } : {}),
    isLocalRequest: () => facts().local,
    isRequestPeerAllowed: () => facts().peerAllowed,
    getShuttingDown: () => facts().shuttingDown,
    getAccessToken: () => (facts().accessToken ? 'secret' : ''),
    allowLegacyWsCookie,
    allowLegacyWsToken,
    authSecurity: {
      consumeWsTicket: () => { state.ticket += 1; return facts().ticket; },
      verifyCookie: () => facts().cookieValid,
      verifyAccessToken: () => facts().tokenValid,
    },
    // `machines` is a mount-time dependency. The retired check was
    // `!machines?.active(id)`, so a missing port produced `undefined` -- the
    // same falsy answer this port gives when `machinesPresent` is false, and
    // the kernel takes one boolean for both. The kernel's own corpus test
    // sweeps the two separately.
    machines: { active: () => facts().machinesPresent && facts().machineActive },
    // The corpus's `sessionInternalSlot` is the result of
    // `isInternalExecutionSlot(persistedSessions.get(id))`; a record carrying
    // the slot flag reproduces it.
    persistedSessions: { get: () => ({ taskExecutionSlot: facts().sessionInternalSlot }) },
    sessions: new Map(),
    handleChatWs() { state.sent.push('chat'); },
    voiceAsr: { handleVoiceWs() { state.sent.push('voice'); } },
    ttsService: { handleTtsWs() { state.sent.push('tts'); } },
    workspaceRuntime: {
      ownsSocket: () => facts().nativeSocket,
      attachWorkspace() { state.sent.push('workspace'); },
      attachMeta() { state.sent.push('meta'); },
      socketStats: () => null,
    },
    auxQueue: { attachClient() { state.sent.push('aux'); }, getStatus() { return {}; } },
    loadChatHistory: () => [],
    sendWs: (_ws, payload) => state.sent.push(payload),
    applyMaxClientSize() {},
  });
  t.after(() => clearInterval(wsPingInterval));
  return async function drive(caseFacts) {
    Object.assign(state, { facts: caseFacts, metrics: [], logs: [], sent: [], ticket: 0, share: 0 });
    const ws = new FakeSocket();
    wss.clients.add(ws);
    await wss.listeners('connection')[0](ws, {
      url: url(caseFacts),
      headers: {},
      socket: { remoteAddress: caseFacts.ip === null ? undefined : caseFacts.ip },
    });
    wss.clients.delete(ws);
    return {
      ws,
      metrics: state.metrics,
      logs: state.logs,
      sent: state.sent,
      ticketConsumed: state.ticket,
      shareLookups: state.share,
    };
  };
}

// What the frozen steps say the socket must end up seeing.
function expected(steps) {
  const want = {
    metrics: [],
    warnings: [],
    close: null,
    machineGrant: undefined,
    correlationId: undefined,
    sharePermission: undefined,
    sessionMissing: false,
    accepted: false,
  };
  for (const step of steps) {
    if (step.op === 'metric') want.metrics.push(step.name);
    if (step.op === 'legacyWarning') {
      want.warnings.push({ path: step.path, mode: step.mode, ip: step.ip });
    }
    if (step.op === 'machineGrant') want.machineGrant = step.value;
    if (step.op === 'correlationId') {
      want.correlationId = step.value === null ? undefined : step.value;
    }
    if (step.op === 'sharePermission') want.sharePermission = step.value;
    if (step.op === 'sessionMissing') want.sessionMissing = true;
    if (step.op === 'close') want.close = step.code === null ? [] : [step.code, step.reason];
    if (step.op === 'accept') want.accepted = true;
  }
  return want;
}

test('the admission wiring reproduces the frozen Node block case for case', async t => {
  const mounts = new Map();
  for (const cookie of [false, true]) {
    for (const token of [false, true]) {
      mounts.set(`${cookie}/${token}`,
        mount(t, { allowLegacyWsCookie: cookie, allowLegacyWsToken: token }));
    }
  }
  let checked = 0;
  let skipped = 0;
  for (const entry of corpus.cases) {
    if (!reproducible(entry.facts)) { skipped += 1; continue; }
    const drive = mounts.get(
      `${entry.facts.allowLegacyWsCookie}/${entry.facts.allowLegacyWsToken}`);
    const want = expected(entry.steps);
    const actual = await drive(entry.facts);
    const label = `${entry.sweep} / ${entry.name}`;
    assert.deepEqual(actual.metrics, want.metrics, `metrics: ${label}`);
    assert.deepEqual(
      actual.logs.filter(line => line.event === 'legacy_ws_auth')
        .map(line => ({ path: line.path, mode: line.mode, ip: line.ip ?? null })),
      want.warnings.map(w => ({ ...w, ip: w.ip ?? null })),
      `legacy warning: ${label}`,
    );
    assert.deepEqual(actual.ws.closes[0] ?? null, want.close, `close: ${label}`);
    assert.equal(actual.ws._machineGrantId, want.machineGrant, `machine grant: ${label}`);
    assert.equal(actual.ws._correlationId, want.correlationId, `correlation id: ${label}`);
    assert.equal(actual.ws._sharePerm, want.sharePermission, `share permission: ${label}`);
    assert.equal(
      actual.sent.some(item => item && item.error === 'Session does not exist.'),
      want.sessionMissing,
      `session missing frame: ${label}`,
    );
    // An admitted socket reaches exactly one per-path handler; a refused one
    // reaches none.
    const dispatched = actual.sent.filter(item => typeof item === 'string').length;
    assert.equal(dispatched > 0, want.accepted, `dispatch: ${label}`);
    // The one-use ticket must be consumed only when admission reached the auth
    // phase, so a share-authorized guest never burns one.
    assert.equal(
      actual.ticketConsumed > 0,
      entry.consumesTicket && entry.facts.hasTicketParam,
      `ticket consumed: ${label}`,
    );
    // The share table is consulted for a chat socket presenting a token, and
    // for nothing else.
    assert.equal(
      actual.shareLookups > 0,
      entry.facts.path === '/ws/chat' && !!entry.facts.shareParam,
      `share lookup: ${label}`,
    );
    checked += 1;
  }
  assert.ok(checked > 600, `expected a broad slice of the corpus, got ${checked}`);
  console.log(`ws admission wiring differential: ${checked} cases driven, ${skipped} covered by `
    + 'the kernel corpus only (addressed ids a URL cannot express)');
});
