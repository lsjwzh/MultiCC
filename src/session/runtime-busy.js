'use strict';

// 「这个会话的 chat 运行时现在忙不忙？」—— 服务端只有这一处定义。
//
// 位置说明：本文件刻意放在 src/session/（与 state-transition.js 的 isRunningStatus
// 同一层），而不是 src/chat/ —— src/session/*.js 是被封住的 bounded context（只许
// require node: / 同目录 / ../session-dto，见 tests/test-architecture-boundaries.js），
// 而 hibernation-composition.js 与 pending-configuration.js 正是最需要这个判定的两个
// 调用点。放在这里，它们能用 ./runtime-busy，不必破例。
//
// 一轮 turn 会在 chat state 上留下最多四条痕迹，而各个子系统历史上各读了其中
// 一个子集，于是同一个会话在不同调用点会得到不同答案：
//   · `isStreaming`    —— admission 接下这一轮时置 true（所有车道），由结构化
//                        finalize 或 stopRunner() 清掉。
//   · `claudeProc`     —— 老式 per-turn 子进程句柄，活到进程退出。
//   · `_cancelledProc` —— 已发信号但还没被 reap 的子进程。stopRunner() 在发信号
//                        的那一刻就把 `claudeProc` 摘掉了，所以「还没真死」这件事
//                        只有这里有。
//   · `_activeRunner`  —— 本轮 turn 的归属记录。它比 `isStreaming` 活得更久：
//                        stopRunner() 先清 isStreaming，确认子进程真的停了之后才
//                        释放 runner（也见 chat/finalize-host.js 的收尾路径）。
//                        只读 isStreaming 的调用点会在「这一轮正在收尾」的窗口里
//                        把会话判成空闲。
//
// 少读一条就是另一个答案：session-git 的 isWorktreeActive() 曾对同一个会话给出
// 两种判定 —— 作为同组 member 看时读 `_activeRunner`，作为被请求的那个 id 看时
// 不读。
//
// 【刻意不在这里】的三条轴，调用方按需自己叠加，它们回答的不是同一个问题：
//   · chatStream.status(id).busy / .queued —— 常驻 stream 泵（workspace/admission
//     的 isLive、session/hibernation-composition 的 inspectBlockers、
//     session/pending-configuration 的 configurationBusy 自己 OR 上）；
//   · 后台任务存活 / 会话 WS 客户端数（clients.size 是「有没有人在看」，不是
//     「有没有活在跑」）；
//   · classify 语义判定 —— 见 tests/test-architecture-boundaries.js：dispatch
//     admission 只允许从 classify + repo lease 推 busy，不许读 liveness。
// 【刻意更窄 / 问的不是同一个问题】的调用点保持原样，且已在各自的位置写明理由：
//   · session-work/host.js 的 runnerStopped()：已取消的常驻轮次在 cancel 走完
//     之前一直持有 `_activeRunner`，把它算进来会让停止等待永远不收敛；
//   · host-lifecycle.js 的 shutdown drain：收尾中的轮次不该延长停机宽限，且那段
//     表达式被 tests/test-architecture-boundaries.js 逐字钉住。
//   · liveness/runtime.js 的 processHandleAlive()：还额外要求 `killed !== true`
//     —— 「已经发了信号」对 liveness 判定就等于不活着，对本文件却仍是活着。
//   · session-work/host.js 的 answerUserInput（`turn_still_active`）：问的是「提问
//     的那一轮还在跑吗」，还带两条本文件不知道的判据（classify 处理中字母、活跃 queue
//     条目）。加宽只会把该受理的回答挡在门外。
//   · classify/state-machine.js 的 P 分支：只读 isStreaming，好让「流已关」的轮次落进
//     有界重试那支；改了等于把重试搬进 classify。
//   · chat/stalled-turn-recovery.js 的 inFlight：问的是「有没有 stream 在流」，卡死的
//     stream 泵才是它要救的东西。
//   · triggers/index.js 的延后触发：只为不打断正在流的输出。
//   · chat/background-task-runtime.js 的两处 isStreaming 判定：它们盖章的是「这一轮
//     还开着」，不是「运行时忙」。
//   · dispatch/targeting.js:148 与 session-admin 的 `clients.size`：那是「有没有人在
//     看」，不是「有没有活在跑」。

// Node 在子进程被 reap 后写入 exitCode / signalCode。刻意【不】用
// `process.kill(pid, 0)` 探针：pid 会被复用，外部进程撞上同一个 pid 会变成一个
// 永远清不掉的假「还活着」。
function processAlive(proc) {
  if (!proc) return false;
  if (proc.exitCode !== null && proc.exitCode !== undefined) return false;
  if (proc.signalCode) return false;
  return true;
}

function isChatStateBusy(cs) {
  if (!cs) return false;
  if (cs.isStreaming === true) return true;
  if (processAlive(cs.claudeProc)) return true;
  if (processAlive(cs._cancelledProc)) return true;
  return !!cs._activeRunner;
}

module.exports = { isChatStateBusy, processAlive };
