'use strict';
// FROZEN ORACLE — git show HEAD:src/routes/task-graph.js (the parent of the task-surface
// migration commit). Only relative require paths were rewritten; the handler
// logic is unchanged. Mounted by tests/helpers/legacy-task-routes.js.

// Task association graph: aggregates the task-board JSON (task cards, groups,
// merge aliases) with the task-shell SQLite store (shells, durable tasks,
// links, parentTaskId) into one { nodes, edges } payload for the graph view.
// Read-only: no mutation of either store, computed per request like the
// memory graph.

const { taskDirId } = require('../load-frozen-task-board').core;
const { sanitizePublicText } = require('../frozen-file-batch19/public-safety');

const TASK_GRAPH_MAX_NODES = 800;
const TASK_GRAPH_MAX_EDGES = 2400;

function shortText(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function publicFailure(prefix, error) {
  const fallback = `${prefix} failed`;
  const message = error && typeof error.message === 'string'
    ? `${fallback}: ${error.message}`
    : fallback;
  return sanitizePublicText(message, fallback);
}

function assertTaskGraphDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('task graph route dependencies are required');
  }
  for (const name of ['getBoard', 'taskGraphData', 'getRecord']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`task graph dependency missing: ${name}`);
    }
  }
  if (!deps.directories || typeof deps.directories.get !== 'function') {
    throw new TypeError('task graph dependency missing: directories');
  }
  if (typeof deps.now !== 'function') {
    throw new TypeError('task graph dependency missing: now');
  }
  return deps;
}

function assertAppMethod(app, method) {
  if (!app || typeof app[method] !== 'function') {
    throw new TypeError(`Express app.${method} is required`);
  }
}

function createTaskGraphRoutes(rawDeps) {
  const deps = assertTaskGraphDeps(rawDeps);

  // The bound chat session is where classify writes taskState; prefer the
  // board's reverse pointer, fall back to the shell task's execution session.
  function classifyOf(node) {
    const sessionId = node.chatSessionId || node.sessionId;
    if (!sessionId) return {};
    const record = deps.getRecord(sessionId);
    const state = record && record.taskState;
    if (!state) return {};
    return {
      classifyState: shortText(state.classifyState, 8) || null,
      goal: shortText(state.goal, 160) || null,
      phase: shortText(state.phase, 80) || null,
    };
  }

  function buildTaskGraph(dirIdFilter) {
    const board = deps.getBoard() || {};
    const boardTasks = board.tasks && typeof board.tasks === 'object' ? board.tasks : {};
    const boardModules = board.modules && typeof board.modules === 'object' ? board.modules : {};
    const taskGroups = board.taskGroups && typeof board.taskGroups === 'object' ? board.taskGroups : {};
    const deleted = new Set(Array.isArray(board.deletedTaskIds) ? board.deletedTaskIds : []);
    const shellState = deps.taskGraphData() || {};
    const shellTasks = Array.isArray(shellState.tasks) ? shellState.tasks : [];
    const shellShells = Array.isArray(shellState.shells) ? shellState.shells : [];
    const shellLinks = Array.isArray(shellState.links) ? shellState.links : [];
    const shellRelations = Array.isArray(shellState.relations) ? shellState.relations : [];

    // ── 任务节点：board 卡片与 shell 持久任务按 taskId 合并 ──────────────
    const nodes = new Map();
    const upsert = (id, patch) => {
      const current = nodes.get(id) || { id, kind: 'task', sources: [] };
      nodes.set(id, Object.assign(current, patch, {
        sources: [...new Set([...current.sources, ...(patch.sources || [])])],
      }));
    };

    for (const [id, task] of Object.entries(boardTasks)) {
      if (!task || typeof task !== 'object') continue;
      const dirId = taskDirId(board, task) || task.dirId || null;
      const classifyPending = task.moduleId && boardModules[task.moduleId]?.source === 'classify';
      upsert(id, {
        title: shortText(task.title, 160) || id,
        status: shortText(task.status, 24) || null,
        runState: shortText(task.runState, 24) || null,
        workflowStage: shortText(task.workflowStage, 40) || null,
        origin: shortText(task.origin, 24) || null,
        dirId,
        mergedInto: shortText(task.mergedInto, 128) || null,
        chatSessionId: shortText(task.chatSessionId, 160) || null,
        refCount: Array.isArray(task.refs) ? task.refs.length : 0,
        updatedAt: Number(task.updatedAt) || null,
        deleted: deleted.has(id),
        classifyPending: classifyPending === true,
        sources: ['board'],
      });
    }

    for (const task of shellTasks) {
      if (!task || typeof task.id !== 'string') continue;
      const previous = nodes.get(task.id);
      upsert(task.id, {
        title: shortText(task.title, 160) || (previous && previous.title) || task.id,
        dirId: (previous && previous.dirId) || shortText(task.dirId, 128) || null,
        sessionId: shortText(task.sessionId, 160) || null,
        parentTaskId: shortText(task.parentTaskId, 128) || null,
        ownerShellId: shortText(task.ownerShellId, 128) || null,
        // 来源边（分离 / 复制副本）与独立继续的来源会话：只用于展示与检索，
        // 不构成父子关系 —— 父边会参与父任务记忆注入，来源边不会。
        separatedFromTaskId: shortText(task.separatedFromTaskId, 128) || null,
        forkedFromTaskId: shortText(task.forkedFromTaskId, 128) || null,
        independentFromSessionId: shortText(task.independentFrom?.sessionId, 160) || null,
        ready: task.ready === true,
        adopted: task.adopted === true,
        createdAt: Number(task.createdAt) || null,
        sources: ['shell'],
      });
    }

    // classify 语义（P/D/W/B/E 来自绑定会话的 taskState）+ provisional 判定。
    // provisional：身份未锁——board 上还在「待归类」模块里，或 shell 任务
    // 尚未 ready；canonical 是已经落位的正式任务。
    for (const node of nodes.values()) {
      Object.assign(node, classifyOf(node));
      node.provisional = node.classifyPending === true
        || (node.sources.includes('shell') && node.ready !== true);
      node.canonical = !node.provisional;
    }

    // ── 任务壳节点：一个壳聚着它 link 过的全部任务 ──────────────────────
    const shellNodes = new Map();
    for (const shell of shellShells) {
      if (!shell || typeof shell.id !== 'string') continue;
      const record = deps.getRecord(shell.sourceSessionId);
      shellNodes.set(shell.id, {
        id: shell.id,
        kind: 'shell',
        title: shortText(record && record.label, 80) || `壳 ${shell.id.slice(0, 10)}`,
        dirId: shortText(shell.dirId, 128) || null,
        sourceSessionId: shortText(shell.sourceSessionId, 160) || null,
        currentTaskId: shortText(shell.currentTaskId, 128) || null,
        archived: shell.archivedAt > 0,
        sources: ['shell'],
      });
    }

    // ── 边：parent / group / merged / shell-link ─────────────────────────
    // 每条边都带 provenance：用户明确建立的关系和系统推导出来的边在展示上
    // 必须能分辨，否则界面对关系的判断会被当成用户意图。
    const edgeMap = new Map();
    const addEdge = (source, target, type, provenance = 'derived') => {
      if (!source || !target || source === target) return;
      if (!nodes.has(source) || !(nodes.has(target) || shellNodes.has(target))) return;
      const key = `${source}\u0000${target}\u0000${type}`;
      edgeMap.set(key, { type, provenance });
    };
    for (const node of nodes.values()) {
      if (node.parentTaskId) addEdge(node.id, node.parentTaskId, 'parent');
      if (node.mergedInto) addEdge(node.id, node.mergedInto, 'merged');
      if (node.separatedFromTaskId) addEdge(node.id, node.separatedFromTaskId, 'split_from');
      if (node.forkedFromTaskId) addEdge(node.id, node.forkedFromTaskId, 'fork_from');
    }
    for (const group of Object.values(taskGroups)) {
      if (!group || !Array.isArray(group.taskIds)) continue;
      const root = group.rootTaskId && group.taskIds.includes(group.rootTaskId)
        ? group.rootTaskId
        : group.taskIds[0];
      if (!root) continue;
      for (const taskId of group.taskIds) {
        addEdge(root, taskId, 'group');
        const node = nodes.get(taskId);
        if (node) node.groupId = shortText(group.id, 128);
      }
    }
    for (const link of shellLinks) {
      if (!link || typeof link.shellId !== 'string' || typeof link.taskId !== 'string') continue;
      if (!shellNodes.has(link.shellId) || !nodes.has(link.taskId)) continue;
      const key = `${link.taskId}\u0000${link.shellId}\u0000shell-link`;
      edgeMap.set(key, { type: 'shell-link', provenance: 'derived' });
    }

    // 用户明确建立的关联（P4）：图上有边、检索能查到，但不改归属，也不
    // 授予上下文读取权 —— 上下文仍要求同项目权限与明确 grant。
    for (const relation of shellRelations) {
      if (!relation || typeof relation.fromTaskId !== 'string' || typeof relation.toTaskId !== 'string') continue;
      addEdge(relation.fromTaskId, relation.toTaskId, relation.kind === 'group' ? 'group' : 'related', 'user');
    }
    // ── 目录过滤（服务端裁剪；前端切项目也可本地过滤，两端同规则）──────
    const dirId = dirIdFilter && dirIdFilter !== 'all' ? dirIdFilter : 'all';
    if (dirId !== 'all') {
      for (const [id, node] of nodes) if (node.dirId !== dirId) nodes.delete(id);
      for (const [id, shell] of shellNodes) if (shell.dirId !== dirId) shellNodes.delete(id);
    }
    // 过滤后没有任何 link 任务的壳不画（避免一团孤立壳节点）。
    const linkedShellIds = new Set(
      [...edgeMap.keys()].map(key => key.split('\u0000')[1]).filter(id => shellNodes.has(id)),
    );
    for (const id of shellNodes.keys()) if (!linkedShellIds.has(id)) shellNodes.delete(id);

    let truncated = false;
    let nodeList = [...nodes.values()];
    if (nodeList.length > TASK_GRAPH_MAX_NODES) {
      nodeList = nodeList.slice(0, TASK_GRAPH_MAX_NODES);
      truncated = true;
    }
    const keptIds = new Set(nodeList.map(node => node.id));
    const edges = [...edgeMap.entries()]
      .map(([key, value]) => {
        const [source, target] = key.split('\u0000');
        return { source, target, type: value.type, provenance: value.provenance };
      })
      .filter(edge => keptIds.has(edge.source)
        && (keptIds.has(edge.target) || shellNodes.has(edge.target)))
      .slice(0, TASK_GRAPH_MAX_EDGES);

    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    for (const node of nodeList) node.degree = degree.get(node.id) || 0;
    const shellList = [...shellNodes.values()];
    for (const shell of shellList) shell.degree = degree.get(shell.id) || 0;

    // 项目选择器数据：按目录统计任务数。
    const projects = [];
    for (const [id, node] of nodes) {
      if (!node.dirId) continue;
      const entry = projects.find(p => p.dirId === node.dirId)
        || (projects.push({ dirId: node.dirId, count: 0 }), projects[projects.length - 1]);
      entry.count++;
    }
    for (const project of projects) {
      const directory = deps.directories.get(project.dirId);
      project.name = (directory && directory.name) || project.dirId.slice(0, 8);
    }
    projects.sort((a, b) => b.count - a.count);

    return {
      nodes: [...nodeList, ...shellList],
      edges,
      meta: {
        dirId,
        projects,
        taskCount: nodeList.length,
        shellCount: shellList.length,
        nodeCount: nodeList.length + shellList.length,
        edgeCount: edges.length,
        truncated,
        maxNodes: TASK_GRAPH_MAX_NODES,
      },
    };
  }

  function mountRoutes(app) {
    assertAppMethod(app, 'get');
    app.get('/api/task-graph', (req, res) => {
      const startedAt = deps.now();
      const dirId = req.query.dirId ? String(req.query.dirId) : 'all';
      let data;
      try {
        data = buildTaskGraph(dirId);
      } catch (error) {
        return res.status(500).json({ error: publicFailure('task graph build', error) });
      }
      data.meta.durationMs = deps.now() - startedAt;
      return res.json(data);
    });
  }

  return Object.freeze({ buildTaskGraph, mountRoutes });
}

function mountTaskGraphRoutes(app, deps) {
  const routes = createTaskGraphRoutes(deps);
  routes.mountRoutes(app);
  return routes;
}

module.exports = {
  TASK_GRAPH_MAX_NODES,
  TASK_GRAPH_MAX_EDGES,
  assertTaskGraphDeps,
  createTaskGraphRoutes,
  mountTaskGraphRoutes,
  publicFailure,
};
