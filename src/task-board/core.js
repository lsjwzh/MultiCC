'use strict';

// Task board core — pure logic for the AI-tagged module→task board shown in
// the fleet panel (meta.html). No I/O and no host state: given a board object
// and inputs, every function here is deterministic, so the whole tagging /
// aggregation / routing surface is unit-testable without a server.
//
// The implementation is split by concern (all pure moves):
//   normalize.js      board shape, validation, lookup, grouping invariants
//   classification.js AI tagging/backfill prompts, parsers, board mutations
//   routing.js        panel-input routing and candidate ranking
//   view.js           read-side DTO projection
// planning.js (schema/stages/rank) and merge-runtime.js stay siblings. This
// module only re-exports the stable surface every consumer already requires.

const planning = require('./planning');
const normalize = require('./normalize');
const classification = require('./classification');
const routing = require('./routing');
const view = require('./view');

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
  buildTagSystemPrompt: classification.buildTagSystemPrompt,
  buildTagUserPrompt: classification.buildTagUserPrompt,
  buildBackfillSystemPrompt: classification.buildBackfillSystemPrompt,
  buildBackfillUserPrompt: classification.buildBackfillUserPrompt,
  parseTagResult: classification.parseTagResult,
  parseBackfillResult: classification.parseBackfillResult,
  applyTagResult: classification.applyTagResult,
  applyBackfillResult: classification.applyBackfillResult,
  addRefToTask: normalize.addRefToTask,
  groupRelatedTasks: normalize.groupRelatedTasks,
  relatedTaskGroup: normalize.relatedTaskGroup,
  reconcileTaskGroups: normalize.reconcileTaskGroups,
  mergeTasks: classification.mergeTasks,
  createPendingTask: classification.createPendingTask,
  applyTaskClassification: classification.applyTaskClassification,
  canonicalTaskTitle: normalize.canonicalTaskTitle,
  taskTitleSimilarity: normalize.taskTitleSimilarity,
  findModuleByName: normalize.findModuleByName,
  findTaskByTitle: classification.findTaskByTitle,
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
  normalizeTaskRouting: normalize.normalizeTaskRouting,
  setTaskRouting: normalize.setTaskRouting,
};
