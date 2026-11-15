'use strict';

// The sixteen task-surface public routes are answered by the Rust front door
// (native/gateway/src/app/task_routes.rs). What stays in Node is the host port
// (`taskBoardRuntime.routePorts`, mounted at POST /api/__host/task-routes by
// src/routes/task-routes-host.js); the front door calls one op per request.
//
// Tests that used to call `runtime.mountRoutes(app)` and then invoke the
// retired Express handler keep their shape through this adapter: the same
// `METHOD path` lookup maps onto the port, and the port renders into the same
// fake `res`. A test asserts the port contract (the facts Node still owns),
// never the path/status ladder — that now lives in Rust and is pinned by
// native/gateway/tests/task_routes.rs and the differential run.

const ROUTES = Object.freeze([
  ['POST', '/api/task-board/tasks', 'planningCreate', req => ({ body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/update', 'planningUpdate',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/title', 'planningRename',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/planning', 'planningUpdate',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/move', 'planningMove',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['GET', '/api/task-board/directories/:dirId/retention', 'retentionPreview',
    req => ({ dirId: req.params.dirId })],
  ['POST', '/api/task-board/directories/:dirId/retention', 'retentionDelete',
    req => ({ dirId: req.params.dirId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/status', 'status',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['DELETE', '/api/task-board/tasks/:taskId', 'delete',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/relocate', 'relocate',
    req => ({ taskId: req.params.taskId, body: req.body })],
  ['POST', '/api/task-board/tasks/:taskId/chat-session', 'chatSession',
    req => ({ taskId: req.params.taskId })],
]);

/** `METHOD path` -> `(req, res) => port(context(req), res)` over routePorts. */
function retiredRoutes(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('retiredRoutes needs runtime.routePorts');
  const table = new Map();
  for (const [method, path, port, context] of ROUTES) {
    if (typeof ports[port] !== 'function') throw new TypeError(`routePorts.${port} is missing`);
    table.set(`${method} ${path}`, (req = {}, res) => ports[port](context(req), res));
  }
  return table;
}

/** The retired route names, in registration order, for registration tests. */
const ROUTE_NAMES = ROUTES.map(([method, path]) => `${method} ${path}`);

module.exports = { retiredRoutes, ROUTE_NAMES };
