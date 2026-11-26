'use strict';

const { getNative } = require('./native/binding');
let native;
function history() { return native ??= getNative().responsesHistoryApi(); }

function preprocessResponsesHistory(body) { return history().preprocess(body); }
function normalizeResponsesHistory(body, { omitReasoningContent = false } = {}) {
  return history().normalize(body, omitReasoningContent);
}
function repairRejectedResponsesHistory(body, error) { return history().repair(body, error); }
function stripReasoningContent(body) { return history().stripContent(body); }
function stripUnverifiableEncryptedContent(body) { return history().stripEncrypted(body); }
function fillWebSearchQueries(body) { return history().fillQueries(body); }
function stripUnresolvedItemReferences(body, extraIds = []) { return history().stripReferences(body, extraIds); }

module.exports = {
  fillWebSearchQueries, normalizeResponsesHistory, preprocessResponsesHistory, repairRejectedResponsesHistory,
  stripReasoningContent, stripUnresolvedItemReferences, stripUnverifiableEncryptedContent,
};
