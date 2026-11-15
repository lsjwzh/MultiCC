'use strict';

// FROZEN ORACLE — the task-surface cluster as it was mounted before the
// migration, assembled exactly the way HEAD:server.js assembled it:
//
//   taskBoardRuntime.mountRoutes(app)                  (5 planning + 6 board)
//   createTaskSearchRoutes({ … }).mountRoutes(app)     (2 search)
//   mountTaskGoalRoutes(app, deps)                     (mark-achieved)
//   mountTaskGraphRoutes(app, { … })                   (task graph)
//   createAttributionSettings({ … }).mount(app)        (attribution read)
//
// The route modules under legacy-task-routes/ are `git show HEAD:` snapshots
// (the parent of the migration commit) with only their relative require paths
// rewritten — see the header of each file. The migration differential
// (docs/rust-migration/differential/task-routes.js) mounts this over the same
// scripted world (tests/helpers/task-routes-scripted-world.js) the Rust front
// door calls through its host port, and compares status, body, headers and the
// side-effect call sequence.
//
// The live modules are still required underneath (task-board/planning, core,
// lifecycle, retention, relocate, search backend, task-domain): those data
// planes did not move and must not be forked here.

const board = require('./legacy-task-routes/board');
const search = require('./legacy-task-routes/search');
const graph = require('./legacy-task-routes/graph');
const goal = require('./legacy-task-routes/goal');
const attribution = require('./legacy-task-routes/attribution-settings');

function mountTaskRoutes(app, deps) {
  const boardRuntime = board.createTaskBoardRuntime(deps);
  boardRuntime.mountRoutes(app);

  const searchRoutes = search.createTaskSearchRoutes({
    getBoard: () => boardRuntime.getBoard(),
    messages: deps.messages,
    logger: deps.logger,
  });
  searchRoutes.mountRoutes(app);

  goal.mountTaskGoalRoutes(app, deps);

  const graphRoutes = graph.mountTaskGraphRoutes(app, deps.graph);
  const attributionSettings = attribution.createAttributionSettings({ initial: deps.attributionMode });
  attributionSettings.mount(app);

  return { boardRuntime, searchRoutes, graphRoutes, attributionSettings };
}

module.exports = {
  mountTaskRoutes,
  createTaskBoardRuntime: board.createTaskBoardRuntime,
  createTaskSearchRoutes: search.createTaskSearchRoutes,
  createTaskGraphRoutes: graph.createTaskGraphRoutes,
  mountTaskGoalRoutes: goal.mountTaskGoalRoutes,
  createAttributionSettings: attribution.createAttributionSettings,
};
