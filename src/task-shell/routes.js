'use strict';

// The 42 task-shell HTTP routes now live in the Rust front door:
// path matching, parameter decoding, Express auto-OPTIONS, pagination and DTO
// field order are in native/gateway/src/app/task_shell.rs and
// native/core/src/task_shell.rs. What is left here is the Node-side mount:
// artifact collection is memoized (a full transcript re-parse on a 5s/15s
// poll), and everything else is forwarded to the one loopback host port
// (src/routes/task-shell-host.js).

const { mountTaskShellHostRoute } = require('../routes/task-shell-host');

// 产物采集要整份解析任务转录（百毫秒级同步 CPU），而两个消费端是 5s/15s 的轮询，且
// web/App/聊天帧常常同时盯着同一个任务。同一任务：进行中的采集合并成一个；完成后的
// 短窗口内直接复用同一份结果。窗口必须盖过最短轮询周期（5s 抖动后约 4.25s 起），否则
// 每一轮都过期重算 —— 多页同开时全局 ~1s 一次请求流，每次都整份重扫转录会把事件循环
// 轮番钉住。取 8s：相邻两轮共享一份，新产物最多迟一轮轮询可见。失败不落缓存。
function createArtifactsMemo(artifacts, { memoMs = 8000, maxEntries = 64 } = {}) {
  const memo = new Map();
  return taskId => {
    const hit = memo.get(taskId);
    if (hit && Date.now() - hit.at < memoMs) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = Promise.resolve(artifacts(taskId)).then(result => {
      entry.at = Date.now(); // TTL 从采集完成时刻起算
      return result;
    }, error => {
      memo.delete(taskId);
      throw error;
    });
    memo.set(taskId, entry);
    if (memo.size > maxEntries) for (const key of memo.keys()) { memo.delete(key); if (memo.size <= maxEntries) break; }
    return entry.promise;
  };
}

function mountTaskShellRoutes(app, {
  getRuntime, open, history, artifacts, artifactsMemoMs,
  taskEntry, taskIndex, taskOperations, attributionDecisions, independent, relations,
} = {}) {
  mountTaskShellHostRoute(app, {
    getRuntime, open, history,
    artifacts: artifacts ? createArtifactsMemo(artifacts, { memoMs: artifactsMemoMs }) : undefined,
    taskEntry, taskIndex, taskOperations, attributionDecisions, independent, relations,
  });
}

module.exports = { mountTaskShellRoutes, createArtifactsMemo };
