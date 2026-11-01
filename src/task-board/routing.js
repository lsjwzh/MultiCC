'use strict';
const { taskDomain } = require('../native/task-domain');
const { taskDirId } = require('./normalize');
const call = (action, args = {}) => taskDomain({ op: 'routing', action, ...args });
const isRoutableRecord = record => call('isRoutableRecord', { record });
function resolveDirectoryCommander(records, dirId) {
  const result = call('resolveDirectoryCommander', { records: [...records || []], dirId });
  if (result.ok) result.record = records.get(result.sessionId);
  return result;
}
const routingTerms = value => new Set(call('routingTerms', { value }));
const buildRoutingContext = (args = {}) => new Map(call('buildRoutingContext', args));
const buildSessionRoutingProfile = record => new Map(call('buildSessionRoutingProfile', { record }));
const routingRelevanceScore = (contextTerms, record) => call('routingRelevanceScore', { contextTerms: [...contextTerms || []], record });
function recordAppearsAvailable(record, sid, options = {}) {
  if (typeof options.isAvailable === 'function') { try { return !!options.isAvailable(sid, record); } catch (_) { return false; } }
  return call('recordAppearsAvailable', { record });
}
function rankRoutingCandidates(records, { dirId = null, contextTerms = new Map(), affinitySessionIds = new Set(), options = {} } = {}) {
  const entries = [...records || []], availability = {}, activities = {};
  for (const [id, record] of entries) {
    if (typeof options.isAvailable === 'function') availability[id] = recordAppearsAvailable(record, id, options);
    const value = record && (record.lastActivity || record.createdAt);
    const ms = typeof value === 'number' ? value : Date.parse(value || '');
    activities[id] = Number.isFinite(ms) ? ms : 0;
  }
  return call('rankRoutingCandidates', { records: entries, dirId, contextTerms: [...contextTerms], affinitySessionIds: [...affinitySessionIds], availability, activities });
}
function explicitTarget(records, id, options) {
  const record = records.get(id);
  return isRoutableRecord(record) && recordAppearsAvailable(record, id, options) ? id : null;
}
function pickDirTarget(records, dirId, target, options = {}) {
  if (target) return explicitTarget(records, target, options);
  return rankRoutingCandidates(records, { dirId, contextTerms: buildRoutingContext({ queryText: options.queryText }), options })[0]?.sid || null;
}
function pickRouteTarget(board, task, records, target, options = {}) {
  if (target) return explicitTarget(records, target, options);
  return rankRoutingCandidates(records, { dirId: taskDirId(board, task), contextTerms: buildRoutingContext({ board, task, queryText: options.queryText }), affinitySessionIds: new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean)), options })[0]?.sid || null;
}
module.exports = { isRoutableRecord, resolveDirectoryCommander, routingTerms, buildRoutingContext, buildSessionRoutingProfile,
  routingRelevanceScore, recordAppearsAvailable, rankRoutingCandidates, pickDirTarget, pickRouteTarget,
  buildRoutedMessage: (task, value) => call('buildRoutedMessage', { task, value }),
  buildCommanderRoutedMessage: (task, value) => call('buildCommanderRoutedMessage', { task, value }),
  extractTaskMarker: value => call('extractTaskMarker', { value }), messageText: message => call('messageText', { message }) };
