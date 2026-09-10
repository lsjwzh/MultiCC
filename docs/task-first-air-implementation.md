# MultiCC Air R2：实施契约与进度

2026-09-10。用户已授权拆分任务并开始实现。视觉与完整计划见
[R2 细节计划](/artifacts/d8e290aafe7802e1/index.html)，
[任务页状态示意](/artifacts/d8e290aafe7802e1/ui-states.html)。
此文件作为仓库内的长期实施记录；网页是辅助预览。

## 2026-09-11：已接入的执行链路与 Air 入口

本批已把常规 Chat / 任务执行接入持久 Workspace 身份、租约和出队准入，
并新增真实 Web `/air` 首页和 Flutter App 目录任务页。这里不是静态视觉原型。
旧 `/manage`、Chat、Terminal 入口继续可达，App 可切换回会话与终端视图。

- `src/workspace/registry.js`：SQLite immediate 事务统一预留执行、驻留、恢复名额。
  Workspace 使用规范化路径形成稳定 ID，共用目录的会话引用同一 Workspace。
  租约没有“到期就抢占”；重启后无法证明已停止的旧租约标记 uncertain。
- `src/workspace/admission.js`：任务先持久入队，在实际 outbox 出队前创建/恢复并
  验证工作目录，再向运行引擎签发仅进程内可用的 permit。CLI 启动前验证 permit，
  重试沿用本轮租约；终止回调后等待运行状态清理及常驻进程退出才释放。
  活跃后台写入者保留租约。容量不足延期投递，不消耗重试次数。
- `src/session/create-record.js`：独立任务和 fork 只创建会话元数据，状态 planned。
  首次执行再物化；fork 仍按记录的源 commit 建立分支。原会话/终端仍兼容原路径。
  TaskRun 可复用执行槽和实验 TUI 保留其原有准入，不宣称已迁入此新租约。
- Air 创建与发送复用 task-shell 权威记录和 receipt，不创建第二套任务库。
  Web 包含目录库搜索、最多五个本浏览器收藏、任务列表、跨目录执行、草稿保护、
  AI 配置摘要、默认收起的详情及可选角色说明。服务与文档仍为全局入口。
  App 新增原生目录任务页、创建、搜索和全部记录筛选，打开现有原生 Chat 继续工作；
  本批没有把所有 App 设置页/Chat 组件重新设计，也没有发布新 APK。
- 在线目标变化先保存不可变来源的候选，分类器在凭证齐备前不改写任务、消息或游标。
  新输入会让旧候选失效。候选不是正式目标任务 B。

**尚未启用自动归属应用。** 真实最终 attempt、集成 receipt、可持续验证的现场
停写屏障，以及基分支有效性检查尚未组成完整应用事务。界面明确显示保留归属/候选
待核验；不得把 Aux 分类成功或普通父 PID 消失伪造为这些凭证。跨壳接管、撤销与
完整 RoleBinding/ChangeSet 迁移也仍是后续包。

默认名额：执行 8、驻留 128、同时恢复 2，可由 `MULTICC_WORKSPACE_RUN_LIMIT` /
`MULTICC_WORKSPACE_RESIDENT_LIMIT` / `MULTICC_WORKSPACE_RESTORE_LIMIT` 设置。
已驻留的存量目录照常保留；超过驻留预算后新目录会排队。此阶段暂停旧自动休眠，
不自动提交 dirty 或卸载目录来腾出容量。旧进程状态不明的占用需要单独核验，不能
通过浏览器按钮无条件清除。Terminal/外部进程不构成已验证的停写屏障。

验证包括 SQLite 双连接争抢、真实临时 Git 物化、结束回调竞态、模糊启动保留，
Docker 内模拟 Codex 的主流程/容量/取消/重启和 Chromium 操作；不等同真实模型、
真实手机安装或真实未纳管子进程隔离验收。生产服务需要用户手动重启生效。

## 基础批次审查结论（历史）

方向可实施，但必须分阶段接入。最后审查修正了两点：

1. **P01 的基础存储与权威切换分开。** 先增加独立命名空间的持久事实能力，
   不改旧 task-board / task-shell 的写入权威。只有 P03 的旧入口适配和迁移验收完成，
   才进行 P01b 单写权威切换，避免隐含循环依赖或双写。
2. **交付版本不等于合并后当前 HEAD。** 正常合并和 sync-back 会推进源 HEAD。
   凭证需要覆盖本轮 endCodeRevision，并以新的源现场/操作屏障核验稳定性；
   不能要求源 HEAD 永远等于合并前 HEAD，也不能只凭一次 merge 成功放行。

最初基础批次尚未接入在线发送/合并/分类路径；没有切库、迁移角色会话或自动清理目录。
后续不得将“基础测试通过”表述为“R2 自动归属已上线”。

## 必须保持的行为

- 创建任务/角色附件不应创建 worktree；实际仓库能力执行前按需物化。
- A 中执行 A+，事后分类为 B：先保存候选，正式归属和输入目标仍为 A。
- 本轮最终有效 attempt 必须 succeeded；completed 仅是调度槽释放。
- 代码执行必须有对应版本的有效集成凭证，并验证源现场没有待处理修改、
  未整合提交或未交接文件。源现场在核验到应用之间受持续写入屏障保护。
- 无代码豁免仅允许被宿主核实的隔离讨论，且没有仓库访问、工作区依赖或待交接产物。
- 游标、已接受输入或原 run 发生变化，旧候选不能迟到应用。
- B 忙、dirty 或缺少基线是独立的目标准备状态，不抢占或覆盖 B 的执行。
- B 使用自己的工作区续接已交付基线；WA 不随归属转交或删除。
- 自动重归属不自动启用提交/合并；dirty 默认保留，未知写入者必须阻止回收。
- 原始 run、消息、角色快照、代码与待答/回调来源不因归属修订而改写。

## 第一批代码的边界

### `src/task-routing/eligibility.js`

`evaluateAttribution(facts)` 是无 I/O、无副作用的条件判定。
输出 `state / eligible / blockers / requiresAtomicRecheck`。
`ready` 不是执行许可，不能拿缓存结果直接创建任务、切游标或操作 Git。

输入包含 proposal、run、context，以及代码执行的 source、guard、integration、baseline，
或者 noCode 豁免证明。所有肯定事实必须是明确类型；未知状态阻止生效。

integration 的 `coveredCodeRevision` 对应 run 的 `endCodeRevision`；
guard 的 workspaceVersion 对应当前 source.version。
baseline 需要关联同一凭证、仓库和基分支，并证明集成仍可用。
单凭提交祖先关系不能证明一次 revert 后代码仍有效。

这些是**可信宿主观测的契约**，不是让客户端提供 verified=true。
P06/P07 接入时必须从真实日志/Git/权限/执行结果生成证据；最终应用事务要在
有效屏障内重新检查版本。模块不自行证明任意外部进程已经停止写入。

### `src/task-routing/facts.js`

`createTaskFactsRepository(store)` 复用现有同步 SQLite transaction 接口。
记录均放在 `task-first:` 命名空间，未新增在线数据库文件或修改旧 task/shell。

- appendFact：仅保存不可变 run-result / integration；重复事实幂等，冲突拒绝。
- createProposal：保存不可变定义和初始 pending；相同定义重试返回当前记录。
- recordEvaluation：通过 expectedVersion 更新候选，和领域事件在同一事务提交。
- pendingEvents / acknowledge：重放与确认领域通知，**不是第二个执行队列**。
- stale/rejected 候选不被静默复活；接口不支持直接写 applied。

这只完成 P01a 的事实账本基础，不包含完整 TaskRepository、计划索引或 P01b 权威迁移。
pendingEvents 目前读取命名空间列表，在线接入前需按投递状态建立索引与分页。
任何未来异步/跨库替代 store 必须重新验证事务契约，不能仅提供同名方法。

### `src/workspace/inventory.js` 与盘点 CLI

`inventoryWorkspaces({sessions,directories,observations})` 只处理提供的元数据。
支持旧共享 owner 引用、规范路径观测、同分支多路径、冲突/缺失/循环引用标记。
无路径且引用异常的记录是 unresolved，不能当作新任务尚未分配目录。

```sh
node scripts/task-workspace-inventory.js --input snapshot.json
```

snapshot 包含 sessions[]、directories[]，可附按声明路径索引的独立只读 observations。
输入文件须明确指定；CLI 不探测生产数据根、不写文件、不执行 Git、不建目录。
返回 `read-only-preview`，所有工作区 `canAdopt=false / canReclaim=false`。
没有文件系统观测则标记 unknown；任务 succeeded/done 不构成 clean 证据。

覆盖范围仅是所提供的 session 声明，不是磁盘上的全部 worktree：
隐藏任务、孤儿检出、历史分支与 retiredWorktrees 需后续独立盘点。
检测到 retiredWorktrees 会明确标记未核验，不能据此自动导入或回收。

## 实施包状态

以下 16 包已登记为项目任务，标题统一为 `[Air R2] Pxx …`。
依赖写在任务说明中；本次没有批量启动执行器或创建 16 个工作区。

| 包 | 范围 | 本批进展 / 后续依赖 |
|---|---|---|
| P00 | 契约与迁移盘点 | 契约和只读盘点入口；完整磁盘/隐藏引用核验仍待做 |
| P01 | TaskRepository 与事件事实 | P01a 事实账本基础；P01b 权威切换待 P03 |
| P02 | 工作区身份与存量引用 | 只读分组与冲突检查；尚不授予 Workspace 所有权 |
| P03 | 统一执行准入 | 待 P01a/P02 的身份和租约能力 |
| P04 | 按需物化与容量 | 待 P03 |
| P05 | 角色附件与上下文 | 待 P01a/P03 |
| P06 | 本轮结果与集成凭证 | 待 P03，接真实 Git/执行结果 |
| P07 | 候选与交付门槛 | 纯判定已开始；实际应用待 P01b/P03/P06 |
| P08 | 目标续接与撤销 | 待 P04/P05/P07 |
| P09 | Air 多目录任务导航 | 可用假数据先做；真实写入依赖单一权威 |
| P10 | 任务页与交付交互 | 待 P05/P07/P08/P09 |
| P11 | Web/App 与历史兼容 | 待 P03/P08/P10 |
| P12 | 端到端验收与开关 | 待基础接入完成；观察模式先行 |
| P13 | 受控 clean 休眠 | 待 P04/P12；须实际停写控制 |
| P14 | dirty 检查点 | 后续试点；默认关闭自动卸载 |
| P15 | 性能与规模优化 | 待真实基线；不能更改保护语义 |

## 验证与后续接入

`npm run test:task-first` 运行新基础测试，并纳入 test:core。
覆盖失败/待答/取消、版本过期、错误凭证、源 dirty、未知写入、讨论豁免，
真实 SQLite 重开、双连接 CAS、事件保存失败回滚和旧记录不受影响。
盘点测试确认不修改输入、不写工作目录，并显式暴露观测范围不足。

本批验证结果：新基础测试 46/46、任务壳 44/44、契约 65/65、治理测试 12/12
及两项治理脚本通过。架构套件 54/55，通过项之外的失败是既有
`app/lib/widgets/task_board_view.dart` 3068 行超出 3000 行限制；该文件在本批
起点 `1d8797bf`、合入前 main 与工作区的 107770 字节内容完全相同。
因架构命令短路而未执行的 detached 检查已单独运行，通过全部 3 项。
本批没有运行完整 npm test，也未完成真实 CLI/归属应用的端到端验收。

项目公开 sessions 接口的只读盘点预览得到 15 个会话、15 个候选路径，
可接管/可回收均为 0。接口 cwd 只作为未经核实的执行路径，不能当作物理
worktree 身份；没有读取磁盘现场，也不覆盖隐藏/历史/孤儿工作区。

下一批先完善 Workspace 持久身份/租约与只读物理观测，再接统一准入。
完整端到端验收包括：真实 CLI 启动确认窗口、Git 已合入但凭证未落库、
自动归属和新输入的竞争、旧 Web/App/网关/cron 入口，以及待答/外部回调的原始身份。
未完成这些验收前保持在线行为不变。需要服务重启时由用户手动触发。
