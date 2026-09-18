# MultiCC 任务身份与独立执行方案 v2

日期：2026-09-18

状态：P0–P2 已实施并合入 main；P3（独立继续）后端与入口已实施；P4 已实施；
第 9 节的非阻断建议与四字码索引按 13.1 / 13.2 / 13.3 三批复审收尾（第 13.3 批含
索引滚动高亮与排序搜索、选为下一条输入目标、在途轮次的持久排队）
批量区间、显式关联与来源边，全身份合并仍按第 6 节留作独立后续。实施状态见文末。

依据：上一版「三层身份 + 双档拆分 + 图谱折叠」、本任务完整历史、当前分支源码。历史统计来自同日诊断快照，本轮未重跑生产数据统计。

## 1. 判断与目标

上一版的主方向可行：一个对话中允许存在多个真实任务，独立交付目标应获得独立 `taskId`，同源通过图谱关系记录；生成任务身份不应强制创建新会话和新 worktree。

但不能按上一版的阶段顺序直接实施。它低估了执行身份的耦合，也把一致性、撤销与审计放得太晚。新版先建立可恢复的任务归属机制，再开放轻量划分和自动分类，最后实现按需独立执行。

用户最终看到的行为：

- 在同一对话里讨论弹窗、索引和语音三个独立交付目标，可以出现三个四字任务码；修改同一索引的颜色、补测试、报告失败仍属于索引任务。
- 这些任务可以继续串行使用当前执行环境，不要求用户等代码合并才能整理对话。
- 任意任务可申请「独立继续」。暂不满足执行条件时，申请持久挂起，页面仍可操作，准备好后显示可打开的入口。
- 索引覆盖完整历史，点击旧任务能够加载并定位，而非仅对屏幕上已加载的消息有效。
- 新任务身份、关系边、当前输入目标、运行状态分别表达，不相互冒充。

## 2. 对上一版的纠正和补全

| 上一版判断或做法 | 核验结果与新版调整 |
| --- | --- |
| 225/237 个会话绑定，身份因此被两处守卫无条件锁死 | 数字是历史快照；两处守卫已有 `shellReceiptId` / `shellOwned` 例外。仍有绑定限制，但必须联合检查 `standalone`、receipt、准入和收尾策略，不能由会话数量推导所有轮次都锁死。 |
| `taskBoundTaskId` 改成默认父任务，多个 task 直接复用一个 `sessionId` | `owns(sessionId)` 当前取第一个匹配任务，准入、上下文、回执都依赖唯一执行所有者。直接复用会导致归属歧义。保留旧字段的执行含义，新增显式绑定层。 |
| 分离补 `parentTaskId` 是低风险图谱修复 | 父边会参与父任务记忆注入及关联历史读取。分离原本只导入特定记录；补父边可能扩大上下文范围。应显示已有 `separatedFromTaskId` 的来源边，不伪造父子关系。 |
| 分组是纯展示、可在建议阶段顺便落盘 | 当前图谱上下文会消费 group，关联历史读取也识别 group 候选。建议阶段不能写成已确认关系；新关系默认不授予上下文读取权。 |
| 旧任务合并接口可直接作为拆分兜底 | 合并路由对受保护的任务壳身份返回 `task_shell_identity_immutable`，并有 busy/worktree 守卫。它不等于轮次归属撤销；没有使用也不能简单归因于一个开关。 |
| `reassignTurnTask` 是对称操作，反向调用即可撤销 | 它搬 refs、修改标题，还可能归档空卡片；绑定任务会拒绝，错误可被吞成 `false`。必须有操作前状态、版本条件和独立撤销语义。 |
| 锚点只要还存在，候选就不过期 | 锚点存在不代表消息、归属、权限、目标任务仍未变化。新版校验指定轮次和内容版本；历史归属与当前输入游标使用不同的并发条件。 |
| `new` 必须指定关联任务 | 无关的新任务合法。允许 `relatedTaskId=null`；同一仓库、同一会话或相邻时间都不强制构成父子/相关边。 |
| N 分钟最多拆一次 | 会误伤快速连续提出的不同任务，也不能避免跨时间的重复拆分。按请求/轮次、交付目标、明确续接关系去重；时间只用于提示降噪。 |
| 一致性、审计和回滚放 P2/P3 | 提前为所有写入的基础门槛，手动操作同样不能留下半次迁移。 |
| 非模态弹窗已等于挂起；只有一个码等于整个对话只有一个任务 | 当前前端没有持久挂起执行请求；索引扫描已加载 DOM。同一屏只有一个码，也可能是历史分页导致，不能单凭界面推断全量任务数。 |

## 3. 产品动作：明确四种含义

| 名称 | 用户意图 | 身份与资源变化 |
| --- | --- | --- |
| 划为新任务 | 这一段是不同交付目标 | 新 `taskId`、新四字码；指定轮次归属改变；不启动模型、不搬代码、不创建 worktree |
| 归入已有任务 / 撤销划分 | 修正整理结果 | 修改指定轮次的有效归属；操作可审计、有条件撤销；不做全任务墓碑合并 |
| 独立继续 | 已经是一个任务，希望在独立环境继续 | 保留该逻辑任务 ID 和四字码，准备新的执行绑定与原生上下文；准备完成后新输入进入独立环境 |
| 复制为新任务（Fork） | 保留原任务，同时做另一条探索 | 新 ID、新四字码、明确的 fork 来源边；原任务与副本可以分别继续 |

现有索引的「分离为独立任务」实际调用 `/fork`，语义是复制。新版应更名并分开入口。原有 `separation.decide` 的证明与屏障能力可以复用，但它创建新任务、要求最新锚点的完整行为不适合作为所有动作的唯一接口。

首期范围：整轮划分、修正归属、同壳内独立继续。任意一句话拆分、自动拆 Git commit、跨项目搬任务、全任务身份合并后任意回滚，均不纳入首期。

## 4. 身份模型与不可变事实

### 4.1 四类坐标

| 对象 | 回答的问题 | 规则 |
| --- | --- | --- |
| Task / `logicalTaskId` | 这项交付目标是什么 | 对外仍用任务 `taskId` 与现有四字码注册表；身份稳定 |
| Conversation / `shellId` | 用户在哪条对话里查看、输入 | 可包含多个任务；历史定位不自动切换发送目标 |
| Execution / `sessionId` 与 workspace | 哪个进程、原生上下文和目录执行 | 一次执行占用遵守原调度与写者规则；旧执行所有者唯一 |
| Turn / `turnId`、receipt | 哪次已准入的工作产生了这些记录 | 原执行会话、输入、原任务绑定、结果、交付凭证和用量来源保持可追溯 |

四字码继续由现有注册表维护，不新增第二套码算法，不回收旧码。尚未确认的分类候选显示「待归类」，不抢先展示以后要换掉的正式码。

### 4.2 建议新增的数据结构

优先在现有 task-shell SQLite 的版本化 schema 中建立权威记录，不另外增加一份 JSON 真相源。下列是设计契约，字段名允许实现时统一调整：

| 记录 | 核心字段与约束 |
| --- | --- |
| `TaskIdentity` | `id, directoryId, title, lifecycle, revision`；新轻量任务无自有 execution；对外投影为正常任务卡 |
| `TurnAttribution` | `(sourceSessionId, turnId), originalTaskId, effectiveTaskId, messageRefs, revision, operationId`；同一轮只有一个有效主归属 |
| `TaskExecutionBinding` | `logicalTaskId, executionOwnerTaskId, executionSessionId, workspaceOwnerSessionId, mode, epoch, state`；mode 为 shared / dedicated |
| `TaskRelation` | `id, sourceTaskId, targetTaskId, type, provenance, confirmed, revision`；关系类型与权限分开 |
| `ContextGrant` | `taskId, scope, sourceIds, snapshotHash, provenance`；授权范围可核验，视觉边不生成授权 |
| `TaskOperation` | `id, idempotencyKey, payloadHash, kind, expectedVersions, beforeState, afterState, state, reason, result`；支持重启恢复和补偿 |

兼容规则：旧 `taskBoundTaskId` 继续表示执行所有者。新轻量任务通过绑定记录复用执行，不能简单给多个现有 shell task 填同一个 `sessionId`。`owns(sessionId)` 仍然有唯一结果；逻辑任务读取用明确的 `resolveTaskIdentity` / `resolveExecutionBinding`，不能依赖 `find()` 碰巧命中的顺序。

旧 receipt 的 `taskId` 和运行事实按旧含义保留；新投递显式携带逻辑任务 ID 与冻结后的执行绑定。控制操作最终仍指向原来的 `sessionId + turnId + requestId`。适配器负责兼容，不在中途把字段含义悄悄换掉。

### 4.3 分类归属与执行来源同时保留

例如执行 E/A 下的 T17 被划为 B：

```text
原始执行事实：T17 由 E 执行，准入时归于 A，结果/用量/交付凭证仍可查
当前任务归属：T17 → B，归属修订号 2
下一条输入：在准入时冻结目标 B 与当时的执行绑定
```

对用户的历史、索引、任务详情以有效归属为准；审计可展开原执行来源。token 和费用先以 `turnId/eventId` 去重，再按有效归属汇总，不能因为引用或快照同时落在两个任务而重复计费。分组总数与子任务明细必须明确去重口径。

### 4.4 任务状态不等于执行进程状态

共用执行环境以后，不能把一个 session 的 `P/D/W/E` 同步给所有逻辑任务。运行与控制状态仍属于具体 turn；任务的进行中、待回答、失败和完成状态，按归属记录与明确的完成事实聚合，保留状态来源。没有在执行，不等于任务完成；一次轮次成功，也不一定满足整项任务的验收条件。

回答入口、完成通知、自动续接、计时器、外部等待和推送必须携带逻辑任务 ID 与原运行引用。历史被重划后，展示可以更新，但控制令牌仍指向原运行，不重新发送完成通知、不重复启动续接。任务归档只改变可见性，不默认取消活动执行；删除、取消、清空历史各有独立权限和操作语义。

## 5. 分类策略：倾向保留独立目标，避免一问一码

不要把 `locked/suggest/auto` 混成一个轴。拆为：

- **目标约束**：`explicit`（用户明确指定）、`implicit`（沿用当前输入目标）、`control`（回答/取消/重试原运行）。
- **自动化模式**：`off / shadow / suggest / auto`，按项目生效；记录策略版本。

规则优先级：

1. 回答待答问题、取消、转向、自动重试、回调、执行续接：绑定原 turn/receipt，不产生新任务，不被归类服务改投。
2. 用户点击「新任务」或手动选择划分：按其决定生成身份；幂等键防重复。
3. 用户明确选择发送目标或指令「继续 #ABCD」：该次投递尊重目标。纯粹在文本里引用任务码，不应自动当作发给该任务；保留引用与投递两种明确语义。
4. 一般工作输入：比较交付物、验收标准和续接意图。明确独立交付目标判 `new`；同产品/同文件不是 `same` 的充分理由。
5. 增补要求、修正本轮实现、补测试、追问和同目标失败重试判 `same`。一条消息包含多个独立目标时，首期给人工划分建议，不猜测如何拆工具轨迹和代码。
6. 不确定、无效 JSON、模型不可用或目标无权限：保留已准入事实并标记待归类，可恢复重判，不能悄悄落成永久 `same`。

`new` 可带确认过的 `related_to` / `derived_from`，也可不带关联。`parent/child` 只表达明确的子交付关系；来源关系不等于层级关系。

分类候选固定绑定 `sourceSessionId + turnId + messageRefs + 内容版本 + 归属版本 + policyVersion`。同一候选重判只更新建议，不重复创建任务；用户拒绝或手动修正后，自动分类不能在无新证据时反复覆盖。

准入时计算一次目标策略，放入不可变的 turn/receipt；收尾复用该值，解决目前准入与收尾分别算 `identityLocked` 的漂移。是否浏览了旧消息不影响发送目标；UI 必须显示「下一条发给 #ABCD」，用户可明确切换。

分类晚于下一轮返回时，允许修正已冻结历史轮次的归属，但不能改投正在执行或已排队的消息。只有输入游标 CAS 仍匹配时才能更新默认发送目标；不匹配就保留当前目标并给轻提示。自动化不阻塞正常发送来等待分类。

## 6. 轻量划分的写入与撤销

### 6.1 边界与流程

首期按完整持久化轮次划分，可选择一轮或多轮，用户/助手/工具与附件引用一起归属。失败或取消的轮次也可以整理，失败状态必须保留；没有最终结果的在途轮次先保存申请，在关闭后重新验证。

```text
生成预览 → 冻结轮次范围与版本 → 提交归属事务
       → 更新可恢复的历史/任务板/索引投影 → 发布带修订号的事件
```

旧的 `annotateTurn` 整段重写历史只可作为兼容投影，不再作为新策略的权威事实。仅冻结已选消息，之后追加的新轮次不自动混入。旧记录没有可靠 turnId 时，预览中明确列出 messageIds；不能在写入时再次用“最近用户消息”推断范围。

### 6.2 一致性在第一批写入前具备

- 在同一 SQLite 事务写入新任务、归属覆盖、必要关系、操作日志和待投影事件。
- 历史正文、task-board JSON、运行台账、用量等不宣称具备跨库原子事务；通过权威归属读取层和可重放投影协调。
- 投影失败显示「已记录，视图同步中」，操作状态不能伪装成全部完成；新客户端可读权威结果，旧客户端未达兼容门槛时不启用新写入能力。
- 重启重放、重复消息、重复点击、失联重试用同一操作 ID，不能再次造任务。相同幂等键配不同 payload 返回冲突。
- 区分归属修订与聊天追加修订：新增无关消息不让历史整理作废；所选内容被编辑、删除、重新划分、目标被归档/迁移时必须重验。
- 操作落盘后才广播；多端按 revision 忽略乱序旧事件，重连用权威快照恢复。

### 6.3 撤销的真实含义

「撤销划分」追加补偿操作，把当次改变的轮次归回原任务。必须校验这些轮次没有被后续手工操作覆盖；冲突时给预览，不能回滚整个任务板快照抹掉别人的新修改。

新任务若已被后续独立使用，保留任务及后续内容，仅撤销仍可证明属于原操作的部分。已经开始独立执行、发出外部消息、合入代码等行为，不被一个撤销按钮反向抹除。

全任务 `mergedInto/unmerge` 留为独立后续设计，首期不靠删除墓碑字段来声称可以恢复原 refs、分组、标题和后来产生的工作。

## 7. 独立继续：随时申请，条件满足后生效

### 7.1 持久状态

```text
requested → waiting → preparing → ready → applied
                  ↘ needs_attention / failed
未开始切换的申请 → cancelled
```

申请立即返回操作 ID；对话里显示「已挂起，可继续使用」。等待条件与错误分开呈现：正在执行、未提交改动、待交付、容量不足、权限变化、快照冲突。

状态由服务端持久工作队列驱动，通过轮次完成、交付回执、目录准备等事件唤醒，并在启动时恢复。不能依赖浏览器开着、页面轮询或 Agent 一直存活。失败重试沿用原操作和目标资源 ID；重复完成事件只能切换一次。

准备阶段创建的 session、worktree 和快照标记所属 operation，恢复时先查实物再重试，避免“资源已建、状态未写”造成重复。取消与失败只允许回收可证明由该操作创建、尚无用户内容和活动引用的临时资源；已有代码或被其他任务使用的环境必须保留并报告。超时进入可解释的待处理状态，不悄悄删除申请。

### 7.2 代码基线和上下文

- 首期默认采用已核验的基分支提交作为独立环境基线，manifest 冻结代码 commit、任务归属 revision、导入消息引用与角色配置。
- 分类划分不会证明某个文件/commit 属于 B。若共用环境还有未提交或未交付工作，显示等待条件；不暗中搬走 A 的修改，也不自动替用户提交/合并。
- 独立环境包含的是该代码基线的完整仓库，不是自动提取出的「只属于 B 的代码」。首期不提供自动 cherry-pick。
- 无代码变更的咨询任务仍需稳定的来源范围；不能只因上一轮失败或等待回答，就永久失去建立后续任务的能力。活动运行和未解决控制仍留在原执行上，需完成或显式处理后再切换。
- 普通目录/无 Git 的任务以 `codeBaseline=not_applicable` 表示，不能强索要 Git 集成回执；文件访问范围按目录机制处理。
- 上下文只导入选定任务的记录和显式授权的参考；失败/取消记录保留状态，不包装成成功结论。记忆与角色采用有来源的快照，不复制整份原生 CLI transcript。

### 7.3 切换与原对话

「独立继续」保留逻辑任务 ID/四字码，生成新的执行绑定 epoch。仅在没有该任务的活动 turn、未解决控制和冻结排队输入，且 manifest 与绑定仍匹配时原子切换。

原对话保留历史、任务段和「已独立」链接。针对该任务的新工作走新绑定；其他任务仍在原处。切换前已准入的请求严格按原绑定执行，不能迟到改投。若新输入改变了所选任务范围，操作进入重验证；不能无限复制一个旧快照又称已独立完成。

准备过程中用户继续提交到该任务时，UI 提供暂存到新环境的显式选择；已有请求按接收时声明的路由策略处理。服务端锁住最终切换的短窗口，防止旧/新环境同时收到同一条工作。

注意特殊情况：若被独立化的是承载多个逻辑任务的旧执行所有者任务，必须先支持“执行记录仍被其他任务使用、所有者任务已有新绑定”的兼容状态，禁止覆盖旧 session 或把其他任务一起带走。首期测试未覆盖前，此种切换进入待处理而非调用旧 `/fork` 冒充完成。

新环境准备好后提供「打开独立任务」，不自动抢走当前页面。复制 Fork 则明确产生新 ID，并继续保留原任务入口。

## 8. 上下文与图谱：展示关系不扩大权限

图谱保留并区别：`related_to`（相关）、`derived_from/split_from`（来源）、`fork_from`（复制）、`parent/child`（子交付）、`merged_alias`（已有合并兼容）。同一对话的成员关系独立表示，不能顺手转为父子关系。

现有 `separatedFromTaskId` / `forkedFromTaskId` 可在查询 DTO 中投影成来源边，不必批量写 `parentTaskId`。对于旧 Fork 同时有 parent 和 fork 的记录，首期保留旧权限和字段，图上避免重复误导；后续单独迁移。

新边默认只供展示和检索。上下文读取必须同时满足同项目权限与明确 grant，不因图上两节点相连而开放全部历史。已确认的相关摘要若要自动注入，受独立策略、token 预算与来源记录约束。

复用一个原生 CLI 会话的轻量任务会共享已经进入模型的历史。仅改 taskId 或记忆目录不能消除这种共享；界面应说明当前为「共用对话上下文」。需要隔离时，通过独立继续创建新的原生上下文，按授权快照重建。撤销归属也不能让模型忘记已读内容。

首次分类后不自动搬移已经写入的记忆文件、交付凭证和制品；它们保留来源。下一轮按被冻结的逻辑任务记录新记忆，历史资源通过可审计引用展示，避免搬错目录或重复统计。

## 9. 非阻断交互与四字码索引

### 9.1 建议卡

发现新目标时，消息段附近出现一条紧凑建议：「这段可以单独记为：任务标题」。操作为「划为新任务」「仍属原任务」「稍后」，均不锁住页面。

「稍后」把卡片收进常驻待处理入口，服务端记录状态，跨刷新/跨端可找回。点击关闭或 Esc 只收起，不等于拒绝。同一条建议接受/拒绝后，其他页面同步解除提示。

自动模式落地后显示「已划为 #ABCD · 撤销」，仍可查看范围和原因。不要先弹大框，再让用户点击后才发现源任务 busy；执行条件只影响「独立继续」。

### 9.2 手动入口

- 每个任务段标题及索引项的「⋯」提供：定位、选为下一条输入目标、调整归属、独立继续、复制为新任务。
- 消息操作里提供「从这一轮开始选择」，再选结束轮次，预览范围和标题；默认到当前已持久化末轮，不无限包含未来消息。
- 仅允许单一默认主归属，多目标混合轮次首期人工整轮处理；额外相关任务以引用边表示。
- 手动整理的确认面板可收起，预览期间继续看上下文。只读/分享页只提供导航入口，写操作由服务端 capability 与权限双重限制。

### 9.3 索引来源、顺序与分页

新增服务端 conversation task-index 查询，返回整个可见历史范围的任务列表及段锚点：`taskId, shortCode, title, segments[{firstMessageRef,lastMessageRef}], attributionRevision, capabilities`。不拉取全部正文，不以页面 DOM 为目录源。

默认按对话首次出现顺序排列四字码，便于与滚动位置对应；提供按 ID 排序/搜索。A → B → A 时 A 的段落不能丢失，点击可定位首段并提供上一段/下一段。滚动时高亮当前段，点击历史只定位，不悄悄改变发送目标。

未加载锚点通过现有 `around` 分页协议补取，按稳定来源消息 ID 合并、去重、排序；后续向前/向后滚动衔接正确。消息已删除时定位该段最近可见记录或提示，不能跳到别的任务。

索引开关一直可点，展开列表不能覆盖开关。手机给正文留出宽度，项目很多时可搜索，长按/拖动预览为后续增强。显隐偏好只管呈现，不影响归属或授权。

当前实现需纳入实机验收的缺口：

- 索引只扫描 `.msg[data-task-short-code]`，未加载历史无法出现。
- rail 与 toggle 同在 `top:50%; right:…`，rail 层级更高；存在覆盖开关风险。
- rail 的 `display:flex` 需要显式 `[hidden]{display:none}` 规则保障收起；现有模块测试不能证明实际 CSS 行为。
- 只读回调会早退，但仍统一传入 `onDetach`，不能称已经隐藏所有只读入口。
- Fork 每次点击新建幂等键，丢失响应后的重试可能创建重复副本；需要服务端/客户端共同复用操作 ID。
- `window.open` 放在异步网络返回后可能被拦，应用可打开链接呈现成功结果；非模态卡也仍缺收起及持久稍后处理。

以上为源码检查项，本轮未做浏览器复现，不把风险判断冒充实测故障。

## 10. 接口契约与兼容接线

以下为建议接口，不是现有可调用 API：

| 接口 | 关键语义 |
| --- | --- |
| `GET /api/task-shells/:shellId/task-index` | 全量元数据目录、分段锚点、scope revision、分页/搜索；不触发路由切换 |
| `POST /api/task-shells/:shellId/task-operations/preview` | 选择轮次、new/existing 目标、影响范围及版本、可执行能力；预览不改身份 |
| `POST /api/task-operations` | `kind=split/assign/promote/fork`，提交 previewToken 或等价冻结参数、幂等键与期望版本 |
| `GET /api/task-operations/:id` | 持久状态、等待原因、受影响任务、结果链接与修订号 |
| `POST /api/task-operations/:id/cancel` | 取消尚未生效的请求；已生效不能伪装取消成功 |
| `POST /api/task-operations/:id/undo` | 归属补偿预检与执行；返回冲突范围，不全量恢复旧快照 |
| `POST /api/task-candidates/:id/decision` | accept/reject/defer，接受转成幂等 operation，不绕开统一写入 |

身份/范围/版本不符返回 409，权限不足 403，记录不存在 404；等待执行条件返回 202 与操作 ID，不用 409 反复要求用户点击。相同请求已完成返回相同结果。

现有来源码引用、任务详情、Air、Web 聊天、Flutter、导出/分享、MCP 上下文和自动调度，统一消费带版本的任务读取层与执行解析器。客户端未声明新能力时，写入口保持旧语义；不能一端显示 B、另一端继续往 A 写却都声称同一任务。

主要接线面：

| 模块 | 要改变的边界 |
| --- | --- |
| `src/task-context-host.js`、`src/chat/turn-engine.js`、`src/chat/finalize-host.js` | 准入时冻结目标策略和双身份字段，收尾不重新推断 |
| `src/classify/state-machine.js`、`task-attribution.js` | 输出候选与 operation 请求，不直接连写多处状态 |
| `src/task-shell/runtime.js`、`host.js`、`task-actions.js` | 逻辑任务解析与唯一执行 owner 解耦，控制/回执仍精确绑定 |
| `src/routes/chat-history.js`、任务板/图谱查询、用量查询 | 有效归属统一覆盖，带 revision，运行事实不重写 |
| `src/task-shell/context-access.js`、`context-plan.js`、`task-graph-context.js` | 图谱展示与授权分离，记忆和 context ledger 按逻辑任务及原生上下文代次处理 |
| `src/task-routing/*`、workspace admission、session scheduler | 交付证明保留执行来源，独立请求持久恢复，绑定切换与派发串行协调 |
| `public/chat-task-index.js`、`chat-task-separation.js`、Air/Flutter | 服务端索引、可收起建议、持久操作状态、只读能力、跨端同步 |

## 11. 依赖顺序与验收关卡

| 阶段 | 交付 | 放行条件 |
| --- | --- | --- |
| P0：约束与契约 | 固化双身份、策略优先级、上下文权限、读取覆盖清单；来源边只读投影；shadow 数据格式 | 能证明新设计不改写现有控制目标、执行结果与授权；避免以“半天零风险”承诺复杂变更 |
| P1：手动整理闭环 | 权威归属事务 + 操作日志/投影恢复 + 手动整轮划分/归回/有条件撤销 + 全历史索引 | 持久化失败与重启恢复、双端并发、历史分页、只读访问通过；新身份可正确读、可显式继续 |
| P2：自动分类 | 共用策略解析器、shadow → suggest → auto；任务段、关联边、可撤销提示、默认输入目标 CAS | 分类效果与关键不变量达到门槛；自动只整理已关闭轮次，不自动启动独立环境 |
| P3：独立继续 | 持久申请、基线 manifest、独立上下文、资源准备、绑定切换、ready 链接与恢复 | 活动/排队/待答控制不误投；重试不重复建任务或执行；原执行所有者特殊情况通过 |
| P4：扩展 | 跨任务批量整理、人工选择历史重分类、更多关联编辑、全身份合并/恢复独立设计 | 每项单独定义数据与撤销边界，不靠移除守卫扩充能力 |

P1 上线后已能整理对话并看到多个码；P2 实现“尽量把不同目标记成新任务”；P3 才完整解决“随时申请独立继续、暂不满足时挂起”。不能交付 P1 就宣称三个目标全部完成。

灰度按目录/会话启用，既支持旧绑定会话的新轮次，也支持新会话。旧任务 ID、四字码、分支、历史正文不批量改写；缺少可靠轮次标识的旧数据仍可看，只有明确人工预览才整理。历史诊断中的 225 个绑定会话不应成为一次性重绑迁移的对象。

关闭 auto 只停止自动写入，已经创建的任务仍可读、可继续、可修正。应用版本回退也要检查 schema/read-model 兼容性：不能把新身份藏掉，让旧代码误投。旧客户端可只读降级或保持能力受限的新协议入口。

### 11.1 必过的场景

1. 连续三项不同交付目标 → 三个任务码；同目标修改/追问/失败重试 → 同一码。
2. 纯粹提及 `#ABCD` 不误投；明确继续指定任务尊重用户选择。
3. T1 分类迟到且 T2 已开始 → 只改 T1 的有效归属，T2 的目标/控制/费用不漂移。
4. 回答旧问题、外部回调、重试、取消以及队列插队，均不被新分类劫持。
5. SQLite 提交前/后、投影中、广播前注入崩溃 → 重启后只出现一次操作且所有读取最终一致。
6. 两页面同时接受、拒绝、撤销；选中轮次同时编辑/删除/重划 → 版本冲突可解释，不覆盖后来的合法操作。
7. 当前运行 B 时整理已经关闭的 A → 不阻塞 B；想整理 B 当前轮次则挂起到边界。
8. 多逻辑任务共用执行者 → owns 唯一，任务详情、角色、记忆、权限、用量分别正确；共用原生历史如实提示。
9. 独立继续在 dirty/busy/容量不足时提交 → 请求不丢；刷新、断网、服务重启后仍可恢复，权限/基线改变时可解释等待。
10. 独立执行准备完毕与新消息同刻到达 → 不双投、不丢投；旧运行控制仍打到旧执行。
11. 上百轮历史未加载、A→B→A、删除锚点、移动端旋转/键盘出现 → 索引可显隐、可定位、不会被新流式输出拉回底部。
12. 分享/只读入口无写动作；新增来源边不会扩大上下文权限；快照截断有说明和受控补读。
13. 任务归回/撤销后 token 总量不变，图谱不丢来源、四字码不复用，分组不会把待回答/失败任务藏到不可发现。
14. A 已完成、B 待回答、C 正在执行且共用 session → 三个任务状态正确；归属修正不重复通知、不误触发自动续接；资源准备中崩溃/取消不遗失用户代码、不重复创建环境。

分类灰度需要人工标注的代表样本，至少包含绑定/非绑定会话、中文短追问、同仓库不同功能、重复投递、混合目标、显式目标与控制消息。记录误拆率、漏拆率、用户撤销/驳回率、候选积压及等待时长。模型自报置信度不直接等于正确率；阈值由样本验证，不凭空指定 0.9。

控制误投、身份越权、重复执行、费用重复计算和丢失已接收操作为零容忍回归项。一周观察可以作为窗口，但时间到期不是自动模式的放行理由。实施前先确定人工样本和可接受误拆/漏拆指标。

## 12. 本轮证据与待确认假设

已核验的源码事实：

- `src/classify/state-machine.js` 的 `applyTaskAttributionResult/runClassifyNow`：任务壳绑定例外、分离建议与归属候选提前返回、多个写入环节。
- `src/task-shell/runtime.js` 的 `owns/settleAttribution/guardAdmission/deliver`：唯一 session owner、standalone 守卫、自动分类条件、receipt 与 cursor 的严格匹配。
- `src/routes/task-board.js` 的 `reassignTurnTask` 及 `src/task-board/merge-runtime.js`：绑定身份保护、refs 搬移、合并的 busy/身份守卫。
- `src/routes/chat-history.js` 的 `annotateTurn`：指定 turn 或锚点兜底后替换历史并广播；未提供归属 CAS 和跨存储事务。
- `src/task-shell/context-access.js` 的 `relatedHistory`：分离来源仅可展开已导入记录；parent/fork/group 等参与访问判定。
- `src/task-shell/task-graph-context.js`：parent 会读取父任务记忆，group 会产生上下文候选。
- `src/routes/task-graph.js`：现有关系绘制缺少 separated/fork 专有来源边。
- `src/task-shell/separation.js` 与 `workspace.js`：分离、复制和工作区基线存在不同守卫，不能简单视为同一种动作。
- `public/chat-task-index.js`、对应 CSS、`public/chat.js`、`chat-task-separation.js`：当前索引、Fork 点击、非模态建议的行为边界。

本轮不声称：生产样本数量仍等于旧报告；所有候选永远不可用；所有源码风险已在浏览器复现；旧合并接口从未成功使用；轻量划分能够隔离已经进入原生模型的上下文。

设计建议：以 P0 + P1 为第一实施批次，P2 的自动模式在读写一致性与手动修正完整之后启用。原用户的三个目标仍作为整体交付目标保留，独立执行的持久挂起明确纳入 P3，不以改一个弹窗替代。

## 13. 实施状态（2026-09-18）

| 阶段 | 已实施 | 说明 |
| --- | --- | --- |
| P0 | 读契约、全历史索引、非阻断挂起 | `GET /api/task-shells/:shellId/task-index` 只返回元数据（scopeRevision、分段锚点、capabilities，缺省 fail-closed）；分离建议有持久 defer。 |
| P1 | 手动整轮划分、归回/撤销、事务日志 | `src/task-shell/task-operations.js`：preview/apply/get/undo/list，`turn-attr` 覆盖层 + `task-op` 事务日志，previewToken/expectedRevision/turn_busy 守卫；前端 `chat-task-attribution` 勾选整轮并归回。 |
| P2 | 档位阶梯 + 决策日志 | `MULTICC_TASK_ATTRIBUTION_MODE` = off / shadow / suggest / auto（默认 suggest），`attr-decision` 日志对四档写出同一行；shadow/suggest 不改身份，auto 只在目标已知时动手，撤销走 `restoreSettledCursor`。 |
| P3 | 独立继续（持久挂起队列） | `src/task-shell/independent-continue.js`：requested → waiting → preparing → ready → applied（+ needs_attention / failed / cancelled），manifest 冻结 commit 与授权消息，apply 只在边界处切换执行绑定，cancel 只回收本次创建且无人使用的资源，重启按实物恢复。 |
| P4 | 批量区间、关联编辑、来源边 | 整段区间在服务端展开；`relations` 存 related/group 边（不改归属、不授予上下文权）；图谱画出 split_from / fork_from / related，与 parent 边区分。 |

### 13.1 第一批的对标复审与加固（2026-09-18 同一轮）

按第 5、6、7、9 节逐条复核 P1–P4 的实现后修掉的差距。每条都在同一批测试里
有对应用例，不能只靠注释声称：

| 条款 | 差距 | 修法 |
| --- | --- | --- |
| §6.2 版本/范围 | preview/apply 此前不校验 `turn.sessionId` 是否属于本壳的 `chatScope.sessionIds`，而 `turn-attr` 覆盖层是按 `sessionId:turnId` 全局索引的 → 任一壳可改写其它会话的归属 | `task-operations` 新增 `scopedSessions/assertInScope`：`task_not_linked`(403) + `conflicts`，`range` 与显式轮次列表走同一个 `resolveTurns` |
| §6.1 整段区间 | 服务端展开的区间受 50 轮「手选上限」约束，长区间点「到这里」直接 400 `invalid_turns` | 区间单独上限 `MAX_RANGE_TURNS=500`（`range_too_large` 带 `detail`），手选列表仍 50 |
| §6.2/6.3 事务 | 撤销不恢复被替换轮次的标题（改名后归回丢名） | `previous[]` 记录 `taskName`，undo 优先还原记录值、其次当前标题 |
| §6.3/§5 保留期 | `expireOlderThan` 定义了但无人调用；壳被删除时 `attr-decision/relation/relation-op/independent` 残留 | `host` 在 mount 时立即扫一次 + 每日一次（unref 定时器，close 清理）；`runtime.remove` 按 shellId 清四类日志，`turn-attr` 由 `task-operations.purgeShell` 按 operationId 回收（只删自己写的覆盖行） |
| §5 规则 6 | 判不出目标的 verdict 无处落地，等于悄悄变成永久 `same` | `parseTaskAttribution` 对「像 JSON 却读不出」或「没有可用名称」标 `unclassified`；`state-machine` 记 `attr-decision`（`path:'none'`、可忽略、不改身份）；`accept` 对该行 fail-closed `attribution_verdict_unavailable`，`dismiss` 仍可用；同一轮的 pending 行原地刷新（`revisions+1`）而不是叠第二条 |
| §7.1 持久状态 | `apply()` 的「检查→切绑定」之间没有锁，且不校验 manifest 的角色快照 | apply 全程持有 `switching` 标记（同时挡住这段窗口的新投递，返回 `task_switching`），并比对 `role_` 快照哈希，变了转 `needs_attention/role_snapshot_changed`（retry 会重新冻结 manifest） |
| §7.1 资源回收 | 取消时不检查「环境已被其他任务使用」，可能删掉别人在用的执行 | `tasksUsingExecution`：target 被别的任务绑定（或记录 `taskBoundTaskId` 指向别人）时 `cleanup='kept'` 并在 `detail.tasks` 里报告；**不**因此挡住切换——同一执行被多个逻辑任务共用是受支持状态，切换只动本任务自己的绑定（新增用例覆盖所有者任务场景） |
| §9.3 已知缺口 | 结果用 `window.open` 打开，晚于点击的网络往返会被浏览器当弹窗拦截 | 结果链接改为 toast 内真实 `<a target="_blank" rel="noopener">`（i18n `taskAttributionOpenTask`） |
| §8 provenance | 关系边缺少 `provenance/confirmed/revision`，用户建的 `group` 与推导分组无法区分；删除不幂等 | `relations` 记录与 DTO 补齐三字段；`create` 要求两侧都 `link` 在本壳（`task_not_linked`）；`remove` 用 `relation-op` 重放同一条已删边 |
| §7.1 呈现 | `needs_attention` 被前端当失败报，`execution_shared` 之类原因对用户不可读 | 前端单独呈现 `needs_attention`（warn、可重问）；`detail` 随 DTO 下发；`task_switching` 由 `chat-event-controller` 翻成人话（i18n `taskSwitchingRefused`） |
| §10 错误投影 | 403/409 的 `conflicts`/`detail` 被 `cleanError` 吃掉，调用方拿不到可操作信息 | `routes.js` 显式投影 `conflicts` 与 `detail` |

同轮的一致性清理：自动归属档位的 `.env` 写入只保留 `src/routes/host-write.js`
一个写者（`attribution-settings` 退化为纯值切换，`server.js` 不再注入
`writeEnv/reportFailure`），`src/routes/task-graph.js` 里混入的真实 NUL 字节改为
字面转义。

注意 P3 的角色快照校验以 `roles.snapshot()` 的同一算法重算
（`'role_' + hash(roles.current(taskId))`），而不是另建一套指纹；否则冻结值与
校验值不同形，正常切换会被误判成快照冲突。

尚未实施（有意留后）：全身份合并的 refs/分组/标题恢复（第 6 节）、P2 的分目录灰度
指标面板、P3 独立环境准备完成后的「打开独立任务」入口之外的高级编排、Flutter 端
对应界面。

### 13.2 第二批：非阻断建议与四字码索引的收尾（2026-09-18 同一轮）

按第 9 节逐条复核后再补的三处，都落在「会话内建议卡 / 四字码索引」这条主线上。

| 条款 | 差距 | 修法 |
| --- | --- | --- |
| §9.1 「稍后」 | `suggest` 档下卡片只有采纳/忽略；「稍后」只存在于旧的分离弹窗（仅 `off` 档可见）。点错忽略就永久丢掉建议，等于没有「不阻断的挂起」 | `attribution-decisions` 新增 `defer`（`state=deferred` + `deferredAt`；`accept/dismiss` 仍可作用于它，同一轮的新 verdict 不覆盖它），路由 `POST /api/task-shells/:shellId/attribution-decisions/:id/defer`；前端卡片第三个动作「稍后」，被稍后的行仍计入 `⇄` 徽标、收起时只收进待处理入口、展开后可以再采纳 |
| §9.1 跨端解除 | `accept` 根本不广播，`dismiss` 广播了 `task_attribution_updated` 却没有任何客户端消费 → 另一个页面上的建议卡不会消失 | `notify()` 带上 `{decisionId,state,kind,fromTaskId,toTaskId}`，apply/dismiss/defer/undo 都广播；`server.js` 透传 detail；`chat.js` 收到后刷新建议列表，`kind=applied/reverted` 时按 shell 重取当前页（`refreshShellHistory` 合并并发调用，避免同一页被清两次） |
| §9.3 定位失败 | 段锚点被删除时 `?around=` 返回 `found:false`，点击静默无反应 | 跳转把「是否落到」回传布尔值：先试该段锚点，再退到任务的首/末锚点，都不行才提示（i18n `taskIndexAnchorMissing`），并把该行标成 `data-stale` 变暗，不再看起来是活链接 |

索引行的 `data-stale` 同时从死代码变成真状态：服务端 DTO 的 `stale` 仍只服务管理层
视图，会话内索引改为对「本次跳转定位失败的 code」实时标记。

仍然存在、本轮未做的缺口（按第 9、6 节记录，供后续排期）：

- 索引没有「滚动时高亮当前段」，也没有按 ID 排序/搜索；`canSelectTarget` 能力位已下发
  但没有任何界面消费（第 9.2 节的「选为下一条输入目标」仍未接线）。
- 建议卡挂在 `⇄` 工具栏里，默认折叠，只有徽标计数可见；第 9.1 节「消息段附近出现」
  的贴段呈现尚未实现（当前是刻意降噪的替代方案）。
- 在途轮次（运行中或待回答）的划分仍是 409 `turn_busy` 直接拒绝，没有按第 6.1 节落成
  「先保存申请、关闭后重验」的持久挂起。
- `shadow` 档在 `state-machine` 里与 `suggest` 一样提前 return，因此也会一并吞掉旧的
  分离弹窗；只有 `off` 会回退旧交互。这与 `attribution-mode.js` 里「shadow 只记录、
  不改用户可见行为」的注释不完全一致，需要产品口径确认。

### 13.3 第三批：索引读法、输入目标与在途轮次的排队（2026-09-18 同一轮）

第 13.2 节列出的四条缺口里，三条本轮落地；「建议卡贴段呈现」继续留后（当前刻意
降噪的替代方案不变）。

| 条款 | 差距 | 修法 |
| --- | --- | --- |
| §9.3 滚动高亮 | 索引只有静态列表，滚到哪一段看不出来 | 阅读线取视口 34% 处、最后一条在其上方的消息所在任务（`currentCodeAt`，纯函数）；行与段圆点标 `task-index-current`。滚动只改高亮，不改归属、不改发送目标 |
| §9.3 排序/搜索 | 只有对话顺序，任务多了找不到 | 目录 ≥ 8 项时才出现筛选条（`order:-1` 放在 rail 顶部）；按 4 字码或标题子串筛选；`⇅` 在对话顺序与 4 字 ID 顺序之间切换并落 `localStorage`。筛选只改呈现 |
| §9.2 选为下一条输入目标 | `canSelectTarget` 已下发但无任何界面消费，也没有对应路由 | 新增 `POST /api/task-shells/:shellId/select-target`（`runtime.selectTarget`）：只移动 `currentTaskId` 并 bump `cursorVersion`，带 `expectedCursorVersion` CAS；拒绝未 link / 已归档 / standalone 锁定的目标。`task-index` DTO 增加 `target` 标记（**不进 `scopeRevision`**，选目标不会让归属预览失效）。索引行给一个显式 `◎`（当前目标显示为静态标记），点击历史仍只定位 |
| §6.1 在途轮次 | 建议卡采纳遇到运行中的轮次直接 409 `turn_busy`，用户点一次被拒一次 | `attribution-decisions.accept` 在轮次忙时改为落 `state='queued'`（+`queuedAt`/`queueClientMsgId`）并广播，不再报错；`drain()` 由服务端 `start()` 推进（挂载时立即跑一次 + 默认 5s 间隔，`unref`），轮次结束后重走 `applyRow` 的 busy 与 cursor CAS 校验；`turn_busy` 竞态回到 queued，其它失败落 `failed` 并留 `lastError`；24h 未成落 `queued_expired`。前端把 queued 行继续计入 `⇄` 徽标，卡片显示「已接受，轮结束后自动生效」并提供「取消排队」（走同一 `dismiss`） |
| §P2 档位语义 | `shadow` 在 `state-machine` 里和 `suggest` 一样提前 return，于是也一并吞掉旧的分离弹窗，与 `attribution-mode.js`「shadow 只记录、不改用户可见行为」的注释矛盾 | 只有 `suggest` 提前 return；`shadow` 记完隐藏行后继续走 `off` 的原路径（含旧分离弹窗与 settle）。这样 shadow 是「同一条请求跑两套逻辑、只比对不改行为」的标准灰度语义。**非默认档**，默认仍是 `suggest`。若产品口径要反过来（shadow 也吞旧弹窗），改回 `state-machine.js` 那一行即可 |

仍然存在、明确留后的缺口：

- 建议卡仍是 `⇄` 工具栏里的折叠列表而非「消息段附近出现」的贴段卡（§9.1 的原始形态）。
- 多轮手选的归属调整在预览阶段就按 `blocked` 禁用应用，所以没有走 §6.1 的排队路径；
  只有「建议卡采纳」这一条路落成了持久挂起。「调整归属」面板若要支持排队，需要给
  `task-operations` 也加一套 queued 状态与取消入口。
- 索引仍不做「上一段/下一段」按钮，段定位靠圆点；长按/拖动预览未做。
- `select-target` 之后前端只在索引里显示当前目标，输入框旁边还没有「下一条发给 #ABCD」
  的常驻提示（§9.2 的 UI 要求只完成了一半）。

### 13.4 第四批：输入目标的常驻可见、段导航与跨页目标同步（2026-09-19 同一轮）

第 13.3 节列出的四条缺口里，两条（索引段导航、输入框旁的常驻提示）本轮落地，
并顺手补上「目标在别的页面被挪走」的同步。

| 条款 | 差距 | 修法 |
| --- | --- | --- |
| §9.2 常驻提示 | `select-target` 之后只有索引里那个 ◎ 能说明「下一条发给谁」，而索引默认收起；输入框旁没有任何提示 | 新增 `public/chat-task-target.js`：`#next-task-target` 常驻胶囊显示 `下一条发给 #ABCD`，点击打开索引（不改变目标）。数据来自壳作用域本身——`chatScope` 增加只读的 `taskShortCode`（由 host 的 `taskShortCode` 端口铸造，四个字符以外的值一律不投影），`createShellView` 把它作为 `onTarget` 回传给页面，**不额外发请求**、不改投递语义 |
| §9.2 跨页一致 | 目标被另一个页面挪走后，本页的索引 ◎ 与提示都停在旧值上 | 归属本来就会广播 `task_state`（`publishSessionView` 带的 `stateSource.taskId` 就是输入游标），页面收到后比对本地游标，只有真的变了才回读一次 `/api/task-shells/:id/chat` 并闪烁提示；同一目标的回声不触发任何请求 |
| §9.3 段导航 | 长对话里多段任务只能靠一个个圆点找，段之间没有前后移动 | 索引顶部新增 `‹ n/m ›` 导航（`order:-2` 置于筛选条之上），按键在**当前显示顺序**（筛选 + 排序都算数）的段之间移动：只做定位与高亮，绝不移动输入游标。只有当真有一项拥有多段时才渲染它——一行一段的目录里「下一段」与「点下一行」是同一件事 |
| 预算 | `public/chat.js` 距 3000 行硬门只剩 2 行 | 接线压到 3 处各 1 行（`onTarget`、`notify`、`task_state` 同步）并回收 1 行空行，chat.js 现 2999 行；新增逻辑全部落在模块里 |

仍然留后：建议卡的贴段呈现（§9.1 原始形态）、多轮手选「调整归属」的排队（`task-operations`
仍只有预览期 `blocked`，没有 queued 状态与取消入口）、`select-target` 的
`expectedCursorVersion` 条件写仍未被界面使用（服务端能力保留；因为 `cursorVersion` 会随每次
投递前进，界面一旦带上它就必须先拿到最新游标，属于另一条独立的读契约）。

### 13.5 第五批：手选多轮的归属调整也排队（2026-09-19 同一轮）

第 13.4 节留后三条里的第二条本轮落地。第 13.3 节只给「建议卡采纳」做了持久挂起，
手动多轮的整段调整仍然在预览阶段就按 `blocked` 禁用应用 —— 用户点一次被挡一次，
正是这一轮改造要消掉的那种阻断，只是换了个入口。

| 条款 | 差距 | 修法 |
| --- | --- | --- |
| §6.1 在途轮次（手选路径） | `task-operations.apply` 遇到运行中的轮次直接 409 `turn_busy`，界面据此把「应用」按钮禁用 | `apply` 增加显式 `queue: true`：轮次还在跑时落一行 `status='queued'`（记下 `turns`/`targetTaskId`/`blocked`/`queuedAt`）而不报错；同一 `clientMsgId` 重放仍只产生一行。不带 `queue` 的调用保持原样 409，接口契约不变 |
| 队列推进 | — | `task-operations.drain()` 由 host 在挂载时立即跑一次、之后每 5s（同一 `attributionQueueIntervalMs`，`unref`）推进。每次尝试都重走 `apply` 本体，所以作用域校验、忙判定、`previous` 重算、`previewToken`/revision 语义全都与手动应用一致；仍在忙就是「还没到时候」（留在队列），轮次消失落 `failed`（`turn_not_found`），超过 24h 落 `queued_expired` |
| 撤销与取消 | — | 排队行是用户的申请，只能「取消」：`POST /api/task-operations/:operationId/cancel`（幂等，应用于 `queued` 以外的状态返回 409 `operation_not_queued`）。真正落地之后仍走原来的 `undo`；队列行落地时把 `queuedAt` 带进 `applied` 记录，"什么时候提的"不会因为等了很久而消失 |
| 落地广播 | 服务端替用户应用后，还开着的页面历史是旧的 | `task-operations` 新增 `notify` 端口（host 接 `onAttributionChanged`）：排队行落地时按 `kind='applied'` 广播，页面复用既有的 `task_attribution_updated` 处理（刷新建议列表 + 重取当前页），不需要新协议 |
| 界面 | 「应用」在有轮次在跑时被禁用，排队后也看不见自己排了什么 | 预览 `blocked` 时不再禁用「应用」：提交带 `queue`，返回 `queued` 时摘要写明「已排队：{n} 轮将在当前轮次结束后移到 {task}」，toast 给「取消排队」。面板的待处理列表现在同时读 `attribution-decisions` 与 `task-operations`，把两种排队行并排显示（都能取消），关掉面板也能找回来 |
| 保留期 | 终态行只有 `reverted` 会被清理 | `expireOlderThan` 一并清理 `cancelled`/`queued_expired`/`failed`（按 `resolvedAt`/`queuedAt`），`applied` 仍然保留——它还是当前归属的审计线索 |

仍然留后：建议卡的贴段呈现（§9.1 原始形态）；`select-target` 的 `expectedCursorVersion`
条件写仍未被界面使用（服务端能力保留，理由见 §13.4）。
