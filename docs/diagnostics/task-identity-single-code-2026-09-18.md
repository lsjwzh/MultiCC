# 诊断报告：为什么一串对话几乎只有一个 4 字任务码

- 日期：2026-09-18
- 数据来源：本机 multicc 实例（`task-shells.sqlite`、`aux_runs/*.jsonl`、`task_board.json`、`task-short-codes.json`、`chat_history/*.json`）
- 性质：只读诊断，不含任何策略改动

## 1. 结论摘要

1. **4 字码不是 classify 生成的**，它是 `taskId` 的显示派生句柄（display handle），在第一次有界面需要显示该 `taskId` 时惰性铸造并持久化。因此「只有一个 4 字码」严格等价于「这一串对话只有一个 `taskId`」，与码本身无关。
2. **`taskId` 的生成时机在 admission（本轮开始时），不在归集判定时**。归集（Aux）只做两件事：把临时 ID 并回旧任务，或把临时 ID 升格为正式新任务。
3. **当前策略是「默认合并，拆分需用户点头」**，共有三道闸门让身份倾向于留在原任务：`identityLocked` 强制覆盖、任务壳会话只提议不切身份、判定被 superseded 作废。
4. **用户设想的「同源用任务图谱关联」在数据结构上已经存在，但接线断了三处**，其中最明确的一处：分离（separation）产生的新任务只写 `separatedFromTaskId`，而任务图谱只把 `parentTaskId` 画成父边，所以分离关系在图上完全不可见。

## 2. 4 字码：定义、生成时机、调用点

### 2.1 定义与铸造

文件：`src/classify/task-short-code.js`

| 项 | 事实 | 位置 |
| --- | --- | --- |
| 字符集 | `0-9A-Z` 共 36 符号，长度 4，约 168 万种 | `:25-27` |
| 铸造算法 | `sha256(taskId)` 或 `sha256(taskId#salt)` 的前 32 bit，base36 编码为 4 位 | `:37-48` |
| 铸造时机 | `codeFor(taskId)` 首次见到该 `taskId` 时铸造，随后持久化 | `:91-108` |
| 冲突处理 | 码已被别的任务占用则 salt+1 重试，上限 4096 次，超限抛错 | `:96-107` |
| 唯一性保证 | 持久化 registry（`taskId → code` 与 `code → taskId` 双向表），一码一任务，铸造后永不复用 | `:55-116` |
| 持久化文件 | `task-short-codes.json`，由 `initTaskShortCodeRegistry({ file })` 装载 | `server.js:248` |
| 升级兼容 | salt 0 与升级前的纯派生算法字节一致，老任务保持用户已见过的码 | `:33-36` |
| 空 ID 行为 | `taskId` 为空返回 `''`，未归集的消息不显示码 | `:92-93` |

关键语义（源码注释 `:10-12`）：**这是显示句柄，不是身份键**；全局唯一主键始终是完整 `taskId`，码不承担任何安全或权限含义。反查 `taskIdForShortCode()`（`:142-146`）只接受 registry 已拥有的码，因此 `#ABCD` 文本无法凭空获得权限。

### 2.2 谁在调用（全部是显示层）

| 调用点 | 用途 |
| --- | --- |
| `src/routes/task-board.js:1625` | 任务对话消息分页渲染，给每条消息附 `taskShortCode` |
| `src/task-shell/runtime.js:386` | 任务壳消息渲染 |
| `src/chat/task-state-seed.js:31` | 任务状态种子（前端首帧） |
| `src/routes/session-profile.js:378` | 会话 profile 的 `task_state` 事件 |
| `src/routes/task-state-store.js:41` | 任务状态落盘时的显示字段 |
| `src/routes/session-admin.js:105` | 会话管理列表 |
| `src/classify/state-machine.js:251` | 任务完成语音播报里的 `#CODE · 目标` |

`src/task-display-attribution.js:3-7` 是统一的显示装配点：只有 `taskId` 存在且能解析出合法 4 位码时才附加字段，否则消息原样返回。**没有任何一处在归集判定时铸造码。**

## 3. `taskId` 的真实生命周期

### 3.1 admission：本轮身份从哪来

文件：`src/task-context-host.js:63-90`（`beginTurn`）

优先级从高到低：

1. `detached`（分离投递）→ `taskId = null`；
2. 请求显式带 `requested.id`（任务板点击、`#CODE` 引用、任务壳、commander、dispatch 投递）→ 直接用它；
3. 否则若 `options.provisional === true` 或没有上一个任务 → **铸造临时 ID** `tsk_<uuid>`；
4. 否则（自动续接）→ 复用 `state._currentTaskId`。

`provisional` 的判定在 `src/chat/turn-engine.js:1351`：

```
provisionalAdmission = !requestedTask.id && !reexecutePersistedDelivery
  && (!originContinue || directUserInput)
```

即「没有显式任务、不是失败重投、并且这一轮是用户直接输入（或不是自动续接）」才铸造临时 ID。源码注释（`task-context-host.js:66-69`）明确了设计意图：**每次新的用户/派发准入都拿自己的候选身份，持久化与首帧 UI 绝不因为旧任务还活着就借用它的标题和 ID**；分类可以稍后把它重新指回旧的正式任务。

`boundaryChanged`（`:74-75`）决定是否触发归集：`detached`、铸造了新 ID、或显式 ID 与上一个不同 / 带 `start:true`。

### 3.2 落盘：消息上的任务字段

`src/task-context-host.js:92-103`（`messageMetadata`）写入 `taskId`、`taskRunId`、`leaseEpoch`、`taskStart`、`taskSource`、`taskText`、`taskDetached`。`appendMessage`（`:105-124`）在消息没有 `taskId` 时补当前会话的 `_currentTaskId`，并同步任务板 `onMessagePersisted`。

### 3.3 归集判定：Aux 说什么、系统怎么裁决

入口：`src/classify/state-machine.js:872`（`runClassifyNow`）；提示词：`src/classify/task-attribution.js:106-118`。

模型被要求输出一个 JSON：`taskName / phase / relation(same|new) / taskId / relatedTaskId / contextRelevance(high|medium|low) / splitTaskName / relevanceReason / memory_candidate`。

裁决链（`state-machine.js:966-1044`）：

| 步骤 | 行为 | 位置 |
| --- | --- | --- |
| 解析 | `relation` 非 `new` 一律当 `same`；`taskId` 必须在 `allowedTaskIds`（最近 6 个任务）内，否则回落 fallback | `task-attribution.js:43-56` |
| **闸门 1：identityLocked 覆盖** | 若本轮身份已锁，模型的 `relation` 被强制改回 `same`、`taskId` 强制为 `currentTaskId`、`relatedTaskId` 清空 | `:973-978` |
| resolvedTaskId | `boundTaskId`（绑定会话）优先；其次 identityLocked → 原 ID；`same` → 模型给的或原 ID；`new` → 任务壳会话给 `null`，普通会话给 admission 的临时 ID | `:983-988` |
| superseded | 锚点消息变了或被更新的请求顶替 → 整条判定作废，身份保持旧值 | `:484-508`、`:989-992` |
| **闸门 2：任务壳只提议** | `shellOwned` 且判 `new`（或 `contextRelevance=low`）→ `proposeTaskSeparation()` 弹分离建议卡，然后 **直接 return**，身份、transcript、cursor 全不动 | `:1015-1030` |
| **闸门 3：归属候选** | `shellOwned` 且 `resolvedTaskId !== currentTaskId` → `proposeTaskShellAttribution()` 记为候选，**直接 return** | `:1032-1038` |
| 真正落地 | 只有走到 `applyTaskAttributionResult` 才会改身份；`same` 时把临时 ID 并回旧正式 ID，并重写该轮消息的 `taskId`（`board.reassignTurnTask`） | `:511-571` |
| 关联边 | `relatedTaskId` 存在且不等于自身 → `board.linkRelatedTasks()` 形成 `taskGroups` 弱分组边 | `:578-597` |

`identityLocked` 的定义（`src/chat/turn-engine.js:1366`）：

```
identityLocked = !!requestedTask.id && !taskShellAutoClassify
  && (requestedTask.start !== true
      || ['task-board','commander','code-reference','task-shell'].includes(requestedTask.source))
```

含义：只要这一轮是**从任务卡、`#CODE` 引用、任务壳或 commander 点进来的**，身份就是证据级锁定，模型无权改判。`src/chat/finalize-host.js:148` 在收尾阶段沿用同一条件。

提示词侧也同步收紧（`task-attribution.js:113`）：锁定时直接要求「输出 relation=same、该 taskId、relatedTaskId=null，只精炼名称与阶段」，但仍要求独立判断 `contextRelevance`（`:117`）。

### 3.4 分离确认后发生什么

文件：`src/task-shell/separation.js:75-155`（`decide`）

- `keep` → 建议标记 `kept`，什么都不变；
- `separate` → 需要 writer barrier + 源任务不忙 + 工作区不脏（`:97`、`:110`），随后**新建一个独立任务和独立壳**：新 `taskId = tsk_<hash>`、新会话 `task-<id>`、新 `shellId`，并写 `separatedFromTaskId: source.id`（`:104-129`）；
- 新任务默认 `ready:false`，要 `createExecution` 建执行位、`indexTask` 建索引后才可用（`:138-145`）；
- 返回 `url: /air?dir=…&task=…`（`:150-151`）。

注意：分离是**把新任务搬到新会话**，原会话继续留在原任务上——这也是为什么原对话里的 4 字码不会变多。

## 4. 实测数据（本机快照，2026-09-18）

### 4.1 任务壳与任务数量

来源：`task-shells.sqlite`（单表 `shell_records`，KV 结构）

| 记录类型 | 数量 |
| --- | --- |
| `shell`（任务壳） | 221 |
| `task`（持久任务） | 227 |
| `link`（壳↔任务） | 228 |
| `receipt`（轮次收据） | 1228 |
| `task-separation`（分离建议） | **3** |
| `attribution-candidate`（归属候选） | 20（stale 14 / pending 6） |

**每壳任务数直方图：`{1: 217, 2: 1, 3: 3}`** —— 98.2% 的任务壳从头到尾只有一个任务，也就是只有一个 4 字码。

### 4.2 身份锁定比例

1228 条 receipt 中 `taskIdentityLocked === true` 的有 **653 条（53.2%）**。这些轮次涉及的 distinct `taskId` 只有 42 个；按壳统计 distinct `taskId`：`{1: 32, 2: 2, 3: 2}`。

也就是说：**超过一半的轮次连「判新」的资格都没有**，模型即使输出 `relation=new` 也会在 `state-machine.js:973-978` 被改回 `same`。

### 4.3 归集判定分布

来源：`aux_runs/*.jsonl`（105 个文件，101 MB）

| 指标 | 数值 |
| --- | --- |
| run 总行数 | 3805 |
| 带 `parsed` 结果 | 3311 |
| `relation=same` | 2943（**88.9%**） |
| `relation=new` | 368（11.1%） |
| `superseded=true`（判定作废） | 311（占 parsed 9.4%） |
| `parsed.separation` 存在（低关联度建议） | 12 |
| 2026-08 | same 614 / new 80 |
| 2026-09 | same 2329 / new 288 |

模型侧本身就偏向 `same`（约 9:1）；系统侧再把 `new` 的绝大部分挡在「提议」阶段。两层叠加的结果就是实测的每壳一个任务。

### 4.4 分离建议的最终去向

`task-separation` 全部 3 条：

| 状态 | 源任务 | 建议标题 |
| --- | --- | --- |
| `kept` | `tsk_36ec81e8…` | 谁在等我列表过滤与空任务排查 |
| `kept` | `tsk_96a7bba4…` | 掉电保护改为 multicc 内置轮询 |
| `pending` | `tsk_96a7bba4…` | 禁用 mediaanalysisd |

**没有任何一条走到 `separated`** —— 历史上从未真正完成过一次自动分离。两条被用户选择「保留」，一条仍挂着待决。这与「弹窗是模态、点的时候总被阻拦」的主观体验一致（该弹窗已在上一轮改为非阻断悬浮卡）。

### 4.5 任务板与图谱关联覆盖率

来源：`task_board.json`

| 指标 | 数值 |
| --- | --- |
| 任务总数 | 1067（active 432 / archived 624 / done 11） |
| `deletedTaskIds` | 106 |
| 设置了 `mergedInto` 的任务 | **0** |
| `taskGroups` 组数 | 20，组内任务数 `[2,3,2,2,18,2,2,6,14,2,2,7,2,4,4,3,3,2,2,2]`，合计约 91 个任务 ≈ **8.5% 覆盖率** |

来源：`task-shells.sqlite` 的 `task` 记录 —— **带 `parentTaskId` 的任务只有 1 个**。

来源：`task-short-codes.json` —— registry 共 **2491** 条码（`tsk_` 前缀 938 条，其余为旧格式 `tsk-…` / `tsk-router-…`）。

来源：`chat_history/*.json` —— 128 个普通会话中 124 个只有 ≤1 个 `taskId`，且大量历史消息根本没有 `taskId`（早于归集功能上线）。

## 5. 图谱关联为什么没接上：三处断点

### 断点 1：分离关系在图上没有边（最明确）

- 分离创建的新任务只写 `separatedFromTaskId`（`src/task-shell/separation.js:119`），**不写 `parentTaskId`**；测试 `tests/test-task-separation.js:63` 还显式断言 `task.parentTaskId === undefined`，说明这是有意为之的当前契约。
- 而任务图谱只把 `parentTaskId` 画成 `parent` 边（`src/routes/task-graph.js:163-166`），前端 tooltip 也只读 `parentTaskId`（`public/task-graph.js:458`）。
- `separatedFromTaskId` 目前唯一的消费方是上下文访问权限判断（`src/task-shell/context-access.js:17`）和角色继承（`src/task-routing/evidence.js:153`）。

结论：**分离产生的父子关系在任务图谱上完全不可见**。

### 断点 2：任务壳会话几乎不产生 group 边

`relatedTaskId → linkRelatedTasks → taskGroups` 这条弱分组边只在 `applyTaskAttributionResult` 里执行（`state-machine.js:578-597`），而任务壳会话在到达那里之前就已经 `return`（`:1030` 提议分离、`:1037` 归属候选）。因此壳会话——也就是绝大多数任务对话——基本不会写入分组边。板上 20 组、8.5% 覆盖率与此吻合。

### 断点 3：`relatedTaskId → parentTaskId` 只有一条极窄的路

`src/task-shell/runtime.js:652` 在新建壳任务时把 `attribution.relatedTaskId` 当作 `parentTaskId`。这是唯一会把「同源」写成父边的路径，实测只有 1 个任务用上。

对比之下，**Fork 路径是完整的**：`src/task-shell/task-actions.js:128` 同时写 `forkedFromTaskId` 与 `parentTaskId`，所以手动 Fork 出来的任务能在图上画出父边。

### 图谱已具备但未用满的能力

`src/routes/task-graph.js` 已经能聚合四类边并输出 `{nodes, edges}`：`parent`（父子）、`group`（弱分组）、`merged`（合并别名）、`shell-link`（壳↔任务），节点上还带 `provisional / canonical / classifyState / goal / phase`，并支持按目录过滤与 800 节点 / 2400 边上限裁剪（`:12-13`、`:155-251`）。也就是说，**可视化与数据模型都在，缺的是写入侧的接线**。

## 6. 若要改策略：三个方向的落点与风险（仅记录，本轮不动手）

| 方向 | 需要改的落点 | 主要风险 |
| --- | --- | --- |
| A. 默认拆分：判 `new` 就开新任务并写父/组边 | `state-machine.js:973-978`（放开 identityLocked 覆盖）、`:1015-1038`（壳会话不再只提议）、`separation.js:119`（补写 `parentTaskId`）、`task-attribution.js:117`（提示词阈值） | 任务板碎片化：一次追问就可能一个新任务；需要合并兜底 |
| B. A + 面板按 group 折叠 + 一键「合并回上一个」 | A 全部，另加 `task-board` 视图聚合与 `mergedInto` 写入（当前 0 条使用） | 工作量最大，但列表不会炸；`mergedInto` 与 `deletedTaskIds` 语义要先对齐 |
| C. 只调提示词与阈值，仍保留「分离需确认」 | `task-attribution.js:117-118` 的 `contextRelevance` 判据与 `relation` 倾向 | 改动最小、风险最低；但用户不点确认，身份仍然只有一个 |

无论选哪个，**断点 1（分离不写 `parentTaskId`）都建议先修**：它只增加一个字段，不改变任何身份裁决，却能立刻让已有的分离与 Fork 关系在任务图谱上显示出来。

## 7. 复现方式

只读统计脚本要点（均在仓库根执行，不写任何文件）：

```bash
# 每壳任务数、身份锁定比例、分离建议去向
node -e "…better-sqlite3 readonly 打开 task-shells.sqlite，
  按 kind 聚合 shell/task/link/receipt/task-separation/attribution-candidate…"

# relation 分布（3311 条 parsed）
node -e "…readline 流式读 aux_runs/*.jsonl，JSON.parse 后取 parsed.relation / superseded…"

# 任务板分组与合并覆盖
node -e "…读 task_board.json，统计 tasks/status/taskGroups/mergedInto/deletedTaskIds…"

# 码 registry 规模
node -e "…读 task-short-codes.json 的 data.byTaskId 计数…"
```

注意事项：

- `better-sqlite3` 从 `/tmp` 下的脚本 require 会失败，需要 `NODE_PATH=<仓库根>/node_modules`；
- 数据库正被运行中的服务持有，必须 `readonly: true` 打开（WAL 模式下安全）；
- 在 multicc chat 会话里用 Bash 跑 `grep`/`rg` 搜索仓库根（worktree 之外）会被沙箱拦截并返回空 stdout，统计一律用 `node` + `fs`/`readline` 完成。
