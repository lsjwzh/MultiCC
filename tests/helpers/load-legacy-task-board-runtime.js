'use strict';

const frozen = require('./load-frozen-task-board');
const { snapshot } = frozen;

const context = snapshot('task-board/turn-context.js', 'legacy-task-run-context.js');
const seed = require('./legacy-task-cold-start-seed');
const runtime = snapshot('routes/task-board.js', 'legacy-task-board-runtime.js', {
  '../task-board/core': frozen.core,
  '../task-board/planning': frozen.planning,
  '../task-board/lifecycle': frozen.lifecycle,
  '../task-board/relocate': frozen.relocate,
  '../task-board/retention': frozen.retention,
  '../task-board/board-store': frozen.boardStore,
  './task-planning': require('./legacy-task-routes/planning'),
  '../task-display-attribution': require('./legacy-task-display-attribution'),
  '../task-board/runtime-helpers': require('./legacy-task-board-runtime-helpers'),
  '../task-board/turn-context': context, '../task-board/cold-start-seed': seed,
  './frozen-host-ports/task-board-repository': require('./frozen-host-ports/task-board-repository'),
});
module.exports = { ...runtime, ...context, ...seed };
