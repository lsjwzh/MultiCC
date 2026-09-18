'use strict';

// Cold-start seed: a bound session that has no native cliSessionId yet is
// seeded from the durable task ledger (task-run history plus legacy refs)
// instead of replaying the whole chat history. Everything here is read-only
// and best-effort — the caller always sends the bare user text too.

function createColdStartSeed({
  records, board, taskRuns, buildTaskRunContext,
  taskIdentityIds, legacyImportMessages, contextMessages, storedTaskMessages,
}) {
  // Seed a not-yet-native bound session from durable task history.
  return function coldStartSeed(boundId, task) {
    if (records.get(boundId)?.cliSessionId) return '';
    try {
      const identityIds = taskIdentityIds(task);
      const runBacked = new Map(identityIds.map(identityId => [
        identityId,
        taskRuns ? taskRuns.listTaskRuns(identityId).length > 0 : false,
      ]));
      // A surviving target already carries the union of source refs, and a
      // source that survived an earlier merge may itself carry descendant
      // refs. Assign each historical ref to the most specific member first
      // (fewest refs; canonical target last). Run-backed members still claim
      // their refs so the same turn is not injected again through an ancestor's
      // legacy fallback.
      const claimedRefs = new Set();
      const refsByIdentity = new Map();
      const claimOrder = identityIds.map(identityId => board.tasks[identityId])
        .filter(Boolean)
        .sort((left, right) => {
          if (left.id === task.id) return 1;
          if (right.id === task.id) return -1;
          return Number(runBacked.get(left.id)) - Number(runBacked.get(right.id))
            || (left.refs?.length || 0) - (right.refs?.length || 0)
            || String(left.id).localeCompare(String(right.id));
        });
      for (const member of claimOrder) {
        const owned = [];
        for (const ref of member.refs || []) {
          const sid = String(ref?.sessionId || '');
          const userKey = ref?.userMsgId ? `u\0${sid}\0${ref.userMsgId}` : '';
          const assistantKey = ref?.assistantMsgId ? `a\0${sid}\0${ref.assistantMsgId}` : '';
          if (userKey || assistantKey) {
            const projected = { ...ref,
              userMsgId: userKey && !claimedRefs.has(userKey) ? ref.userMsgId : null,
              assistantMsgId: assistantKey && !claimedRefs.has(assistantKey) ? ref.assistantMsgId : null,
              excerpt: userKey && claimedRefs.has(userKey) ? '' : ref.excerpt };
            if (userKey) claimedRefs.add(userKey);
            if (assistantKey) claimedRefs.add(assistantKey);
            if (projected.userMsgId || projected.assistantMsgId) owned.push(projected);
          } else {
            const key = `l\0${sid}\0${Number(ref?.ts) || 0}\0${String(ref?.excerpt || '')}`;
            if (!claimedRefs.has(key)) owned.push(ref);
            claimedRefs.add(key);
          }
        }
        refsByIdentity.set(member.id, owned);
      }
      const legacyById = new Map(identityIds.flatMap(identityId => {
        if (runBacked.get(identityId)) return [];
        const member = board.tasks[identityId];
        return member ? legacyImportMessages({
          ...member,
          refs: refsByIdentity.get(identityId) || [],
        }, { identityIds: [identityId] }) : [];
      }).map(message => [message.messageId, message]));
      const imports = contextMessages([...legacyById.values()]);
      const context = buildTaskRunContext({
        task,
        messages: [...storedTaskMessages(task.id), ...imports],
        includeCurrent: false,
      });
      // Layers concatenate with no separator, so the seed carries its own.
      return context.text.trim() ? `${context.text}\n\n` : '';
    } catch (_) { return ''; /* best-effort: the bare text always sends */ }
  };
}

module.exports = { createColdStartSeed };
