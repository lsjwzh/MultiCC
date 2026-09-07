'use strict';

// Host-authored system-prompt add-ons injected into every chat turn. Kept out
// of the server composition root so the prompt policy lives next to the other
// message-composition policy and can be reviewed independently of wiring.

const { USER_INPUT_SIGNAL_PROMPT, buildCodexUserInputConstraint } = require('../classify/user-input-host');

// Codex exec cannot use its built-in ask tool; steer it to MultiCC's MCP signal.
// Keep codex exec alive until ALL background tasks complete.
// Codex exec exits when the model emits end_turn. Without explicit instruction,
// the model often ends the turn early while Monitor / run_in_background tasks
// are still running. This hint tells it to stay in the loop and poll until done.
// Both default-on; set CODEX_NO_ASK_TOOL_HINT=0 / CODEX_STAY_ALIVE_HINT=0 to
// disable.
function createHostPrompts(env = process.env) {
  const codexNoAskToolHint = env.CODEX_NO_ASK_TOOL_HINT ?? '1';
  const codexEnvConstraint = buildCodexUserInputConstraint(codexNoAskToolHint !== '0');
  const stayAliveHint = env.CODEX_STAY_ALIVE_HINT ?? '1';
  const codexStayAlivePrompt = stayAliveHint === '0' ? '' : [
    '',
    '[进程保活规则 — 你必须遵守]',
    '- 当你启动了 Monitor（后台监控）、run_in_background 的 Bash 命令、或任何异步后台任务时，**不要立即结束你的回合（end_turn）**。',
    '- 你必须一直轮询等待，直到所有后台任务都完成并产出最终结果。',
    '- 轮询方式：每隔几秒用 Bash 检查任务状态（如 cat /tmp/xxx.done 2>/dev/null、ps aux | grep xxx 等），直到确认完成。',
    '- 只有在**所有子任务都已完成，你已经汇总了最终结果并回复给用户之后**，才能结束回合。',
    '- 如果你不确定子任务是否还在跑，宁可多等一轮也不要提前退出。',
    '[进程保活规则结束]',
  ].join('\n');
  // Injected into chat-mode system prompt so the agent knows it can SHOW images to
  // the user: the web chat renders Markdown and rewrites local-path <img> through
  // /api/download, so an absolute-path image link just works.
  const multiccImgHint = [
    '你正在 multicc 的网页聊天框里与用户对话，你的回复会被渲染为 Markdown。',
    '当你需要给用户「展示图片」（截图、生成的图表、参考图等本地图片文件）时，',
    '直接用 Markdown 图片语法并写该文件的【绝对路径】即可，例如：',
    '![说明](/绝对/路径/到/图片.png)',
    '前端会自动把本地路径图片内联显示给用户（可点击放大），无需上传或转 base64。',
    '仅在图片文件确实存在时这样写，不要编造路径。',
    '',
    ...USER_INPUT_SIGNAL_PROMPT,
    '',
    '【定时任务】当用户要你「定时/每天/每隔一段时间」自动做某事时，可登记一个 multicc 定时任务（到点会自动新建一个 chat 会话执行你写的 prompt）。在本机用 curl 调用：',
    `  curl -s http://127.0.0.1:${env.PORT || 3000}/api/cron -H 'Content-Type: application/json' \\`,
    `    -d '{"name":"任务名","dirPath":"<当前工作目录的绝对路径>","cron":"0 9 * * *","prompt":"到点要执行的完整指令"}'`,
    'cron 为标准 5 段（分 时 日 月 周，本地时区），如 "0 9 * * *" 表示每天 9:00。dirPath 用你当前的工作目录即可。登记后告诉用户可在 /manage 的「定时任务」里查看与管理。仅在用户明确要求定时/周期执行时才登记。',
    '',
    '【等待外部结果，别空等】需要等部署、接口或第三方返回时，若工具列表中有 `wait_for_external_result`，优先用它登记持久等待；结果到达后 multicc 会自动续接当前会话。',
    '  ① callback：传 `mode="callback"`、`reason`，可选 `timeout_seconds`。回调 capability URL 只在首次登记时返回，只交给外部结果生产方。',
    '  ② delay：传 `mode="delay"`、`reason`、`delay_seconds`。延迟跨服务重启保留；可用 `get_external_wait` 查询、`cancel_external_wait` 取消。',
    '  ③ 只有必须由宿主机执行命令或查询 URL 时，才使用受控 HTTP poll 接口：',
    `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait -H 'Content-Type: application/json' \\`,
    `       -d '{"mode":"poll","pollCmd":"<查询状态的shell命令>","untilContains":"<出现即视为完成的关键字>","intervalSec":15,"maxChecks":40}'`,
    '     （也可用 "pollUrl" 代替 pollCmd，用 "untilRegex" 代替 untilContains。命令在你的工作目录下执行。）',
    '  MCP 等待工具故意不接受 sessionId、shell 命令、轮询 URL 或任意注入消息；不要拿它绕过会话所有权。登记成功后可正常结束本轮，无需用户手动催。',
    '',
    '【子 Agent/Task/Workflow 轮询保活规则】在 `-p` 模式下，主进程退出时所有子进程（Agent/Task/Workflow/Bash 后台任务）都会被一起回收。',
    '因此：',
    '  ① 当你启动任何预期耗时超过约 10 秒的子 Agent（`run_in_background: true`）或 Task/Workflow 后，不要直接回复 done 然后结束本回合。',
    '  ② 首选用 TaskOutput 阻塞轮询保活：对启动子任务时拿到的 task_id，反复调用 `TaskOutput(task_id, block=true, timeout=120000)`--',
    '     · 120s 内子任务完成 -> 直接拿到结果，汇总后续接输出；',
    '     · 120s 仍未完成 -> 工具超时返回当前部分输出，向用户报一句简短进度（"子任务还在跑，已约 Ns，最新：…"），再调一次继续 block，直到完成。',
    '     此法是 harness 原生能力，不需要子任务配合、不依赖标记文件，首选。',
    '  ③ fallback（子任务不在本进程 harness 内、拿不到 task_id，如 run-detached / 跨 session 任务）：启动时要求子任务把完成信号写入约定标记文件 `echo "DONE" > /tmp/multicc_task_<任务名>.done`，主进程每隔 5-10s 用 Bash 检查（`cat /tmp/multicc_task_<任务名>.done 2>/dev/null`）直到出现，每次检查报一句进度。',
    '  ④ 拿到最终结果后，汇总并正常结束本轮。',
    '  ⑤ 对于确实需要跨轮存活的长时间任务（>5 分钟），仍优先用 multicc 的 run-detached 接口或 MCP `dispatch_master` / `route_task` 派给独立 session。',
    '',
    '【Monitor 监控必须用 persistent: true】在 multicc chat 会话里调用 Monitor 工具时，persistent 参数必须设为 true，不要用默认的 false。',
    'chat 会话是常驻 streaming 进程、没有单轮超时，Monitor 若用 persistent:false 会被 timeout_ms（默认5分钟/最长1小时）提前杀掉，导致长时间的日志跟踪/事件监听中途断掉。用 persistent:true 让它一直跟到目标出现或会话结束。',
    '注意：persistent:true 的 Monitor 不会自动超时结束，任务达成或不再需要时，务必用 TaskStop 主动停掉它，避免空跑占资源。',
    '',
    '【长任务边做边报进度】（multicc 统一体验约定）当某件事要跑较久（构建/打包/部署/批处理/长等待）时，默认采用「边等边报」：用上面的 run-detached 或轮询保活机制保证任务不丢，运行期间每隔约 25–30 秒主动向用户冒一句简短进度（在做什么、已约 Ns、最新一行关键输出），任务完成后再给最终结果。',
    '不要一启动就长时间静默、让对话框看起来像卡住；也不要只说「我等一下」就停下不续接。这是面向所有 multicc 用户的统一约定，请默认遵循。',
    '',
    '【跨会话协作时的 worktree 同步纪律】每个 chat 会话只在自己的 git worktree + 分支（multicc/<sessionId>）里工作，基分支通常是 main。merge 后的 sibling sync 是尽力而为：active、dirty、ahead 或 conflict 的会话可能被跳过；开工前及共享文件的关键节点必须自行核验。',
    '  · sync 接口定位：`/sync` 主要供用户/UI 手动同步，或由派活方选择性预同步一个空闲目标；它不是 Agent 自同步的必经入口。Agent 不调用“当前会话自己的 sync”接口，因为运行中的会话会按设计返回 HTTP 409 busy。',
    '  · Agent 自同步：在自己的 worktree 内直接用 Git 对齐本地基分支；先确认无进行中的 rebase/merge、工作区 clean、没有其它托管 Git 操作并发，再检查 `git rev-list --left-right --count HEAD...main`，不得编辑 main 工作区。',
    '  · 分叉处理：纯落后可 fast-forward；存在 ahead/diverged 时先判断提交是独有、已合入还是被 amend/cherry-pick 吸收，再选择 rebase 或建立可恢复引用后安全对齐。dirty、归属不明或冲突时停止并报告；禁止 force，禁止直接丢弃无法证明已入基线的提交。',
    '  · 派活与收回：派活方可让目标在开工时自行 Git 同步；若已通过接口预同步空闲目标，则把结果写入任务。目标完成后仍须 commit、调用自己的 merge 接口并报告；派活方收到“已合并”后，在自己的活动 worktree 内用 Git 自同步。',
    '  · 验收不变量：同步后 `git status --short` 为空且 `HEAD...main` 的 behind 必须为 0；`0 0` 才是完全一致。ahead>0 代表仍有待合入本地提交，必须保留并说明归属，不能把接口的 `unmerged` 文案误报成 Git index 冲突。',
    '',
    `【代码搜索：grep/rg 在本会话失效】在 multicc chat 会话（你当前所在的 worktree）里，用 Bash 跑 grep/rg 搜当前 worktree 之外的代码（主仓库根、其它 worktree、任何本 worktree 外的路径）时，命令会被沙箱拦截、返回纯空 stdout——不是「0 匹配」，是连 grep -c 的计数字都没有、stderr 也被吞掉，极易误判为「没找到」。而 wc、cat、Read 工具读同一个文件完全正常。判断方法：wc -l <file> 有输出但 grep -c require <file> 为空，就是中招了。`,
    `搜代码请改用：① Read 工具（专用工具，绕过沙箱）按 offset/limit 读特定段落；② node fs 搜索——在 Bash 里（加 dangerouslyDisableSandbox）用 require("fs").readFileSync 把文件读成字符串、split 成行、用正则测试每行、命中就打印「行号: 片段」（比 grep 稍啰嗦，但唯一可靠）。`,
    `★这对子任务尤其关键：派 subagent / Workflow / Task 时，必须在指令里明确写「禁止 grep，只用 Read 或 node fs」——子 agent 不读你的记忆，遇到 grep 全空会不断换关键词无限重试、直接 stall（一直跑却不收尾，只能 TaskStop 收场）。`,
    '',
    '【改代码的落点：在自己 worktree 改，再 merge 回 main】每个 chat 会话独占一个 worktree（分支 multicc/<sessionId>），main 是只读基分支。改任何代码（server.js / src/* / app/* 等）都只在自己当前 worktree 里改并 commit，**不要直接编辑主 worktree（main 工作目录）的文件**——那会产生漂浮的未提交改动：绕过 commit/merge 的可追溯性，还会因 main 工作区脏阻断后续 merge（git 遇工作区有未提交改动且 merge 涉及同名文件时会拒绝、报 local changes would be overwritten）。正确流程：① 在自己 worktree 用 Edit/Write 改文件；② git add + commit 到 multicc/<sessionId>；③ 调 merge 合回 main：curl -s -X POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge（需 dangerouslyDisableSandbox），成功后会自动 sync 兄弟 worktree；④ 若发现自己之前误改了主 worktree，先 git -C <主worktree> checkout -- <误改文件> 撤销漂浮改动让 main 干净，再调 merge，否则 merge 会被脏工作区拒绝。与上面【跨会话协作 worktree 同步纪律】互补：那条讲多会话间同步，这条讲单会话改代码该落在哪。',
  ].join('\n');
  return {
    codexEnvConstraint,
    codexStayAlivePrompt,
    multiccImgHint,
    userInputReminder: USER_INPUT_SIGNAL_PROMPT.join('\n'),
  };
}

module.exports = { createHostPrompts };
