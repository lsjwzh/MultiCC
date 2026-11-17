'use strict';

// Who typed this? Two places need the same answer:
//
//   • the session-work scheduler, which only lets a typed message start a turn
//     in every non-P classify state (see the E-at-rest rule in selectSessionItem)
//   • the orchestration runtime, which tells the turn engine that a delivery is
//     direct user input rather than a machine continuation
//
// They used to answer it separately, and only the runtime knew that the Air task
// page's messages are typed by a human too. The scheduler looked at
// `source: 'task-shell'`, called it machine work, and parked it behind the E
// verdict — permanently, because nothing else releases a non-control entry: the
// user's own message could never be selected, no matter how many more they
// typed. Hence one definition, here.
//
//   direct      the chat page / WS input box
//   task-shell  the Air task page; always carries the receipt of the message the
//               user submitted there (see task-shell/runtime.js deliver)
//   everything else (operation, trigger, continuation) is a machine admission
//               and keeps waiting for a D verdict.
function isUserTypedWork(payload) {
  if (!payload || payload.type !== 'session.work') return false;
  if (payload.source === 'direct') return true;
  return payload.source === 'task-shell' && !!payload.options?.taskShellReceiptId;
}

module.exports = { isUserTypedWork };
