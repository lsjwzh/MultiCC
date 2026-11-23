'use strict';

// Task board core — pure logic for the AI-tagged module→task board. No I/O and
// no host state: given a board object
// and inputs, every function here is deterministic, so the whole tagging /
// aggregation / routing surface is unit-testable without a server.
//
// The implementation is split by concern (all pure moves):
//   normalize.js      board shape, validation, lookup, grouping invariants
//   native-bridge.js 宿主事实与常驻 Rust 看板的命令接口
//   routing.js        panel-input routing and candidate ranking
//   view.js           read-side DTO projection
// planning.js (schema/stages/rank) stays a sibling. This
// module exposes the stable surface every consumer already requires.

const planning = require('./planning');
const normalize = require('./normalize');
const { getNative } = require('../native/runtime');
const { recentTaskIds, classificationRule } = require('./native-bridge');
const routing = require('./routing');
const view = require('./view');

// Rust 返回任务描述；公开接口返回当前看板上的同一对象。
function classificationTask(action, board, args) {
  const task = classificationRule(action, { board, ...args });
  return task ? board.tasks[task.id] : null;
}

module.exports = {
  MAX_TAGS_PER_TURN: normalize.MAX_TAGS_PER_TURN,
  MAX_REFS_PER_TASK: normalize.MAX_REFS_PER_TASK,
  CLASSIFY_PENDING_MODULE_NAME: normalize.CLASSIFY_PENDING_MODULE_NAME,
  PENDING_TASK_TITLE: normalize.PENDING_TASK_TITLE,
  TASK_ORIGINS: normalize.TASK_ORIGINS,
  TASK_RECORD_TYPES: planning.TASK_RECORD_TYPES,
  WORKFLOW_STAGES: planning.WORKFLOW_STAGES,
  taskOriginForSource: normalize.taskOriginForSource,
  legacyTaskOrigin: normalize.legacyTaskOrigin,
  deriveTaskTitle: normalize.deriveTaskTitle,
  createEmptyBoard: normalize.createEmptyBoard,
  normalizeBoard: normalize.normalizeBoard,
  buildTagSystemPrompt: () => getNative().taskBoardSystemPrompt(false),
  buildTagUserPrompt: options => getNative().taskBoardUserPrompt(options, recentTaskIds, false),
  buildBackfillSystemPrompt: () => getNative().taskBoardSystemPrompt(true),
  buildBackfillUserPrompt: options => getNative().taskBoardUserPrompt(options, recentTaskIds, true),
  parseTagResult: value => classificationRule('parseTagResult', { value }),
  parseBackfillResult: value => classificationRule('parseBackfillResult', { value }),
  applyTagResult: (board, entries, ref, now = Date.now(), options = {}) =>
    classificationRule('applyTagResult', { board, entries, ref, now, options }),
  applyBackfillResult: (board, entries, refByTurn, now = Date.now()) =>
    classificationRule('applyBackfillResult', { board, entries, refByTurn: Object.fromEntries(refByTurn), now }),
  addRefToTask: normalize.addRefToTask,
  groupRelatedTasks: normalize.groupRelatedTasks,
  relatedTaskGroup: normalize.relatedTaskGroup,
  reconcileTaskGroups: normalize.reconcileTaskGroups,
  mergeTasks: (board, input = {}) => classificationRule('mergeTasks', { board, input: { now: Date.now(), ...input } }),
  createPendingTask: (board, input) => classificationTask('createPendingTask', board, { input: { now: Date.now(), ...input } }),
  applyTaskClassification: (board, taskId, entry, ref, now = Date.now(), options = {}) =>
    classificationRule('applyTaskClassification', { board, taskId, entry, ref, now, options }),
  canonicalTaskTitle: normalize.canonicalTaskTitle,
  taskTitleSimilarity: normalize.taskTitleSimilarity,
  findModuleByName: normalize.findModuleByName,
  findTaskByTitle: (board, moduleId, value, options = {}) =>
    classificationTask('findTaskByTitle', board, { moduleId, value, options }),
  taskLastTs: normalize.taskLastTs,
  taskDirId: normalize.taskDirId,
  resolveTask: normalize.resolveTask,
  taskLineageIds: normalize.taskLineageIds,
  pickRouteTarget: routing.pickRouteTarget,
  pickDirTarget: routing.pickDirTarget,
  resolveDirectoryCommander: routing.resolveDirectoryCommander,
  isRoutableRecord: routing.isRoutableRecord,
  routingTerms: routing.routingTerms,
  buildRoutingContext: routing.buildRoutingContext,
  buildSessionRoutingProfile: routing.buildSessionRoutingProfile,
  routingRelevanceScore: routing.routingRelevanceScore,
  recordAppearsAvailable: routing.recordAppearsAvailable,
  rankRoutingCandidates: routing.rankRoutingCandidates,
  buildRoutedMessage: routing.buildRoutedMessage,
  buildCommanderRoutedMessage: routing.buildCommanderRoutedMessage,
  extractTaskMarker: routing.extractTaskMarker,
  messageText: routing.messageText,
  buildBoardDto: view.buildBoardDto,
  taskRunSessionIds: view.taskRunSessionIds,
  deadDispatchClaim: view.deadDispatchClaim,
  foreignRunSession: view.foreignRunSession,
  staleWorkerClaim: view.staleWorkerClaim,
  soleRunSessionId: view.soleRunSessionId,
  sessionHasTurn: view.sessionHasTurn,
  normalizeTaskRouting: normalize.normalizeTaskRouting,
  setTaskRouting: normalize.setTaskRouting,
};
