'use strict';
// Writes the frozen corpus for multicc_core::ws_admission from the frozen Node
// transcription in tests/helpers/legacy-ws-admission.js.
//
// The whole fact space is far too large to cross-multiply, so the corpus is
// built from sweeps that are each exhaustive over the dimensions the rule
// under test actually reads, against a fixed tail for the rest:
//
//   gates      the two early refusals and the internal-slot gate
//   share      every share outcome, on and off the chat path
//   deny       the final auth decision: local x token x ticket x both legacy
//              credential chains, exhaustively
//   ticket     ticket semantics: machine grant, correlation id fallback and
//              fleet scope, against both addressed ids
//   dispatch   what an admitted connection carries, chat and non-chat
//
// Run: node docs/rust-migration/differential/ws-admission-oracle.js
const fs = require('node:fs');
const path = require('node:path');
const oracle = require('../../../tests/helpers/legacy-ws-admission');

const OUT = path.join(__dirname, 'ws-admission-corpus.json');

// The tail every sweep uses for the dimensions it does not vary: a local
// client with no credentials of any kind, which the auth gate admits.
function base(over) {
  return {
    shuttingDown: false,
    peerAllowed: true,
    path: '/ws/chat',
    shareParam: '',
    sessionParam: 's1',
    addressedSessionId: 's1',
    addressedDirectoryId: null,
    shareAccess: null,
    local: true,
    accessToken: null,
    hasTicketParam: false,
    ticket: null,
    allowLegacyWsCookie: false,
    allowLegacyWsToken: false,
    authCookie: null,
    cookieValid: false,
    tokenValid: false,
    machinesPresent: true,
    machineActive: true,
    ip: '203.0.113.9',
    sessionInternalSlot: false,
    nativeSocket: false,
    ...over,
  };
}

const cases = [];
function add(sweep, name, over) {
  const facts = base(over);
  cases.push({
    sweep,
    name,
    facts,
    consumesTicket: oracle.consumesTicket(facts),
    steps: oracle.plan(facts),
  });
}

// ── gates ──────────────────────────────────────────────────────────────────
// The shutdown and peer gates precede everything, and the internal-slot gate
// follows every credential decision. Exhaustive over all five inputs.
for (const shuttingDown of [false, true]) {
  for (const peerAllowed of [true, false]) {
    for (const sessionInternalSlot of [false, true]) {
      for (const addressedSessionId of ['s1', '', null]) {
        for (const p of ['/ws/chat', '/ws/aux']) {
          add('gates',
            `shutdown=${shuttingDown} peer=${peerAllowed} slot=${sessionInternalSlot} `
            + `addressed=${addressedSessionId} path=${p}`,
            { shuttingDown, peerAllowed, sessionInternalSlot, addressedSessionId, path: p });
        }
      }
    }
  }
}

// ── share ──────────────────────────────────────────────────────────────────
// Every share outcome: no record, a record for another session, a record whose
// permission is empty (falsy, so refused like a miss), and the two real
// permissions. Off the chat path the branch must not run at all, and an
// unset share parameter must not consult the record either.
const SHARE_ACCESS = [
  ['missing', null],
  ['other-session', { sessionId: 'other', access: 'operate' }],
  ['empty-permission', { sessionId: 's1', access: '' }],
  ['operate', { sessionId: 's1', access: 'operate' }],
  ['view', { sessionId: 's1', access: 'view' }],
  // `access.sessionId === sessionParam` is strict equality, so a record with
  // no session matches a request with no session parameter.
  ['null-session', { sessionId: null, access: 'operate' }],
];
for (const p of ['/ws/chat', '/ws/aux']) {
  for (const shareParam of ['', 'share-token']) {
    for (const [label, shareAccess] of SHARE_ACCESS) {
      for (const sessionParam of ['s1', null]) {
        add('share', `path=${p} param=${shareParam || 'none'} access=${label} session=${sessionParam}`,
          { path: p, shareParam, shareAccess, sessionParam, addressedSessionId: sessionParam });
      }
    }
  }
}

// ── deny ───────────────────────────────────────────────────────────────────
// The final gate: `!local && (!accessToken || (!ticket && !legacyCookie &&
// !legacyToken))`. Both legacy chains are conjunctions of three and two
// inputs, swept exhaustively so no conjunct can be dropped silently.
const BENIGN_TICKET = { correlationId: 'corr-1' };
for (const local of [true, false]) {
  for (const accessToken of [null, 'secret']) {
    for (const hasTicketParam of [false, true]) {
      for (const ticket of [null, BENIGN_TICKET]) {
        for (const allowLegacyWsCookie of [false, true]) {
          for (const authCookie of [null, 'cookie-value']) {
            for (const cookieValid of [false, true]) {
              for (const allowLegacyWsToken of [false, true]) {
                for (const tokenValid of [false, true]) {
                  add('deny',
                    `local=${local} token=${!!accessToken} param=${hasTicketParam} `
                    + `ticket=${!!ticket} cookie=${allowLegacyWsCookie}/${!!authCookie}/${cookieValid} `
                    + `query=${allowLegacyWsToken}/${tokenValid}`,
                    { local, accessToken, hasTicketParam, ticket, allowLegacyWsCookie,
                      authCookie, cookieValid, allowLegacyWsToken, tokenValid });
                }
              }
            }
          }
        }
      }
    }
  }
}

// ── ticket ─────────────────────────────────────────────────────────────────
// Ticket semantics. The machine gate reads `machines?.active`, so a missing
// machines port must refuse exactly like an inactive grant. The correlation id
// falls back to the request id. Fleet scope is checked against the addressed
// session and directory, each only when the ticket carries one.
const TICKETS = [
  ['none', null],
  ['correlation', { correlationId: 'corr-1', requestId: 'req-1' }],
  ['request-id-only', { requestId: 'req-1' }],
  ['no-identity', {}],
  ['machine', { machineGrantId: 'grant-1', correlationId: 'corr-1' }],
  ['fleet-session-match', { fleetSessionId: 's1', correlationId: 'corr-1' }],
  ['fleet-session-mismatch', { fleetSessionId: 'other', correlationId: 'corr-1' }],
  ['fleet-directory-match', { fleetDirectoryId: 'd1', correlationId: 'corr-1' }],
  ['fleet-directory-mismatch', { fleetDirectoryId: 'other', correlationId: 'corr-1' }],
  ['machine-and-fleet', { machineGrantId: 'grant-1', fleetSessionId: 'other' }],
  // Empty strings are falsy wherever these fields are read, so they must
  // behave exactly like absent ones.
  ['empty-correlation', { correlationId: '', requestId: 'req-1' }],
  ['empty-identity', { correlationId: '', requestId: '' }],
  ['empty-fleet-session', { fleetSessionId: '', correlationId: 'corr-1' }],
  ['empty-machine-grant', { machineGrantId: '', correlationId: 'corr-1' }],
];
for (const [label, ticket] of TICKETS) {
  for (const hasTicketParam of [false, true]) {
    for (const addressedSessionId of ['s1', null]) {
      for (const addressedDirectoryId of ['d1', null]) {
        for (const machinesPresent of [true, false]) {
          for (const machineActive of [true, false]) {
            add('ticket',
              `ticket=${label} param=${hasTicketParam} session=${addressedSessionId} `
              + `dir=${addressedDirectoryId} machines=${machinesPresent}/${machineActive}`,
              { ticket, hasTicketParam, addressedSessionId, addressedDirectoryId,
                machinesPresent, machineActive, sessionParam: addressedSessionId });
          }
        }
      }
    }
  }
}

// ── dispatch ───────────────────────────────────────────────────────────────
// What an admitted connection carries. A chat client always carries a share
// permission, null included; a non-chat client carries none. The internal-slot
// refusal wins over both, including for a share-authorized guest.
for (const nativeSocket of [false, true]) {
  for (const p of ['/ws/chat', '/ws/workspace']) {
    add('queue', `native=${nativeSocket} path=${p}`, { nativeSocket, path: p });
    add('queue', `native=${nativeSocket} path=${p} refused-early`,
      { nativeSocket, path: p, peerAllowed: false });
  }
}

for (const p of ['/ws/chat', '/ws/aux']) {
  for (const [label, shareParam, shareAccess] of [
    ['no-share', '', null],
    ['share-operate', 'share-token', { sessionId: 's1', access: 'operate' }],
  ]) {
    for (const sessionInternalSlot of [false, true]) {
      for (const addressedSessionId of ['s1', null]) {
        add('dispatch', `path=${p} ${label} slot=${sessionInternalSlot} addressed=${addressedSessionId}`,
          { path: p, shareParam, shareAccess, sessionInternalSlot, addressedSessionId,
            sessionParam: 's1' });
      }
    }
  }
}

const counts = {};
for (const c of cases) counts[c.sweep] = (counts[c.sweep] || 0) + 1;
fs.writeFileSync(OUT, `${JSON.stringify({
  generatedAt: '2026-11-20',
  oracle: 'tests/helpers/legacy-ws-admission.js',
  counts,
  cases,
}, null, 1)}\n`);
console.log(`wrote ${cases.length} cases to ${path.relative(process.cwd(), OUT)}`);
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
