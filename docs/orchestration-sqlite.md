# 编排 SQLite 存储与终态记录保留

## 当前状态

2026-11-12：本批源码改造与集中测试完成。Rust 存储、保留策略、宿主接线和回归用例已落盘，
已通过 Rust 格式检查、全工作区全部目标的 Clippy 严格检查和调试构建；原生模块加载校验通过。
编排聚焦回归 223 项全部通过；Rust 全工作区串行运行 1,310 项测试通过。
npm 套件全部 15 个组成分组经修复后完整复跑通过，保留 2 项环境跳过与 1 项既有待办，详见验证记录。
生产服务未重启，生产数据库未清理；不要把下述设计当成已上线或生产性能验证结论。

同日对本机主仓 `orchestration.sqlite` 的只读统计（不含 WAL 大小）：

| 项目 | 数量 |
|---|---:|
| 主库文件 | 154,361,856 字节，约 147 MiB |
| 编排任务总数 | 61,361 |
| completed / failed / interrupted | 58,190 / 2,703 / 464 |
| 非终态编排任务 | 4 |
| outbox 总数 | 16,441 |
| delivered / cancelled / dead-letter | 15,373 / 977 / 82 |
| pending / leased | 9 / 0 |
| operations 总数 | 610 |

这是本机证据，与另一现场报告的 110,133 条任务、105,154 条 completed 不同。
只读统计证明有终态累积，没有在生产复现 OOM，也未测得本机恢复时的堆峰值。

## 问题与修改边界

SQLite 只解决持久化方式，不能自动限制进程内存。旧实现打开数据库时将五个集合整体
载入 Node，再冻结内存快照；读取和异常恢复会复制或重载快照，退出导出也重新物化全库。
此前的写时复制仅减少普通 mutation 的序列化，仍有上述放大路径。

本批同时处理长期累积和全量物化：

- `native/core/src/orchestration_store.rs` 以 SQLite 为唯一权威，按记录和实际访问字段读取；
  不在 Rust 中另存全库镜像。提交只处理脏记录。
- `src/orchestration/native-store-host.js` 兼容已有 `read(selector)` / `mutate(draft)` 回调，
  以惰性对象代理保持旧宿主接口；回调结束后释放代理和缓存。
- `select(collection, {where, fields, limit, orderBy, descending})` 支持参数化筛选及字段投影；
  同一事务中的 `draft.select` / `draft.count` 合并本次未提交的修改。
- 聊天后台任务状态条通过 `GET /api/sessions/:id/tasks?taskIds=<JSON数组>` 只读取当前显示的 ID，
  每批最多 100 项；Rust 按主键和会话定位，运行中输出仅返回末尾 500 个 UTF-16 单位，
  终态只返回状态和时间，保留 WebSocket 结束事件丢失时的补偿。无参数接口仍保持完整详情契约。
- 恢复、中断活动任务、到期 wait、outbox 领取、FIFO 排队和状态统计先筛选活动候选；
  operation 引用查询不带消息和结果正文。Router 状态查询先筛选截取，再读所需结果。
- 默认生产回滚导出在 Rust 中逐行输出，避免生成完整 Node 对象和完整 JSON 字符串。
  `snapshot()`、无 selector 的 `read()` 以及明确要求完整列表的接口仍可返回大结果，
  不承诺这些显式全量调用的内存与数据量无关。

Node 例外限于迁移期回调、对象身份和运行时生命周期适配：`draft-host.js` 与
`native-store-host.js` 保留 JS 回调及事务内 Proxy 桥。重复 SQL、全库内存镜像和
数据库/文件系统注入式旧后端已删除，存储入口不会回退到 Node 实现。数据库查询、
提交、迁移、导出与保留规则归 Rust；待调用方改用原生仓储接口后，可删除上述桥接。
独立数据库读回与摘要校验仅保留在测试 oracle 中，不进入产品或导出工具。

相对当前分支基线，`sqlite-store.js` 从 1,146 行缩为 50 行；新增的回调兼容文件
`draft-host.js` 为 403 行，原生宿主桥 `native-store-host.js` 为 284 行。
这三个生产文件合计从 1,146 行降至 737 行，净减少 409 行；没有把迁入桥接文件的
代码计作删除。本批没有删除整个编排服务或 npm 依赖，JSON store 与既有编排调度服务
仍有 Node 实现，不能据此声称整个编排后端已迁完。

## 终态回执与正文分离

终态 task 用于展示最后状态/结果摘要，并抑制迟到事件重新激活；已投递 outbox 用于
按 ID、会话和载荷哈希去重；operation 的结果仍供状态查询、迟到回执修正使用。
这些用途不等于需要永久保留整份执行状态。当前积累来自缺少保留策略，同时把历史
当运行时状态全量加载；SQLite 本身不会自动清理或限制应用堆。

本批源码采用「活动记录 + 小回执 + 按需正文」：活动记录保持完整；终态主表只保存
状态、时间、去重和引用判断所需字段，完整原件写入
`orchestration_record_bodies(collection, record_key, data_json)`，以集合和记录键定位。
`tasks`、`outbox`、`operations` 和 `waits` 主表通过 `body_ref` 标明是否存在独立正文；
`body_ref=1` 时缺少正文会显式报数据损坏，不能把小回执当成完整结果返回。
`body_ref=0` 的记录继续读取主表原件，`sessionSchedules` 不参与正文拆分。
正文保留未知字段，完整读取、详情查询和回滚导出由 Rust 按需还原原有 DTO；只查
活动状态或回执字段时不加载正文。状态变更、回执与正文仍在同一事务内写入。

当前没有足够可靠的聊天定位关系，所以保留独立正文，不宣称已经复用聊天记录。
这次拆分先减少运行时查询的数据体积，并未承诺正文磁盘占用立刻降低。

正文和嵌套属性名通过共享 `JsValue/JsString` 保留 UTF-16，包括 emoji 切片留下的
孤立代理项；持久化、投影及流式导出使用单条 JSON 边界，不生成全库镜像。
常规筛选仍走 SQL；孤立代理项比较退为逐行匹配，投影只累积投影结果。
记录 ID、根扩展键和查询字段名仍要求合法 Unicode；不符合时明确拒绝。

## 一致性约定

1. 状态转换及其生成的投递记录仍在同一 `BEGIN IMMEDIATE` 事务内提交。
2. 回调读取固定 SQLite 快照；提交比较 revision，跨实例冲突不覆盖新状态。
3. mutation 和 read 保持原有 FIFO 顺序；异步维护加入同一队列。
4. 无变化的 mutation 不推进 revision；删除和保留策略的 revision 更新同事务提交。
5. 修改和返回值与已提交数据隔离；未提交异常不留下部分持久化状态。
6. 原库、WAL、SHM、维护锁和回滚文件使用私有权限；已有 SQLite 永远优先于旧 JSON。
7. 流式导入/导出使用临时文件、完整性核验和原子替换；失败保留原权威数据。

编排数据库版本升级为 schema 2，状态 JSON 版本仍为 3。Rust 打开 schema 1 数据库时
建立正文表并升级版本；旧历史记录的回执瘦身由原生异步维护分批执行，启动时不全库
改写正文。不删除或重建任务看板库、聊天记录库和交付证据库。
仅识别 schema 1 的旧二进制不得直接打开 schema 2；回退前需用新版本完整导出 JSON，
再由旧版本通过 JSON 恢复，不能只回退可执行文件并继续使用新数据库。
本批新增派生索引；首次建设清理索引交由异步维护作业，仍可能消耗磁盘与锁等待时间。
现有同步 store 工厂继续在打开时执行完整性检查，首次旧 JSON 导入也保持同步契约，
但按记录流式处理。它们仍可能延长启动时间；本批不宣称所有启动工作已异步化。
指标接口读取最近完成作业的缓存，避免等待后台维护持有的原生互斥锁。

## 在线保留策略

清理有两个独立触发条件，计时、计数、筛选和删除都归 Rust：

- 时间：默认至少保留 30 天，每小时检查一批过期记录。
- 数量：只计 tasks 终态和 outbox 的 delivered / cancelled，合计超过 5,000 条时
  提前安排维护；数量压力绝不缩短 30 天保留期，也不绕过引用保护。活动记录和死信
  不计入该数量，5,000 是维护软目标，不是任务运行容量或强制删除上限。

每批合计最多删除 500 条过期且无引用的记录；两张表分别按更新时间由旧到新扫描并
分享预算，不承诺跨表的全局时间排序。只有有效终止时间、有效更新时间均不晚于
保留期截止点，且没有恢复引用的记录可删除；时间和数量触发共用这套删除条件与游标。
容量探测只读终态索引键，累计到 `maxRecords + batchSize` 就停止，避免全库 COUNT 和正文解析；
每分钟最多探测一次，不受小时清理间隔限制。有删除进展时最早一秒后继续下一批；全被
保护或失败时退避一分钟，实际时机随编排 tick 调度。首次 tick 即可探测积压。
每类每批最多检查 `batchSize × 4` 个候选，用持久游标跳过受保护的旧记录；在线报告
中的候选数只属于本次扫描，`eligibilityExact=false`。完整可回收总数只在显式报告中计算。

| 对象 | 行为 |
|---|---|
| tasks：completed / failed / interrupted / cancelled | 计入容量；超过保留期且无活动引用时可回收 |
| outbox：delivered / cancelled | 计入容量；超过保留期且无保留引用时可回收 |
| 非终态任务、pending / leased outbox、dead-letter | 保留，不计入容量 |
| operations | 保留，保护请求幂等和恢复 |
| waits、session schedules | 本批不清理 |
| 时间缺失、无效或仍被活动对象引用 | 保留 |

operations 引用的请求/结果 outbox 继续保留，即使 operation 已终态；因此不能把所有
终态 outbox 都计为可回收量。独立 outbox ID 的去重窗口至少受配置的保留期保护，
数量超额不提前结束该窗口；过期并删除后再次使用同一 ID 可以创建新记录，不承诺
该类 ID 的永久去重。operation 幂等记录不清理。

5,000 条是否覆盖足够历史取决于生成速率：每天 1,000 条只相当于约 5 天。它不能
代替按时间定义的去重窗口，因此本策略允许近期或受保护回执超过软目标。

可用环境变量（所有策略值在 Rust 校验；非法值报错）：

| 变量 | 默认值 |
|---|---:|
| `MULTICC_ORCHESTRATION_RETENTION_ENABLED` | `true` |
| `MULTICC_ORCHESTRATION_RETENTION_TASK_DAYS` | `30` |
| `MULTICC_ORCHESTRATION_RETENTION_OUTBOX_DAYS` | `30` |
| `MULTICC_ORCHESTRATION_RETENTION_BATCH_SIZE` | `500` |
| `MULTICC_ORCHESTRATION_RETENTION_MAX_RECORDS` | `5000` |
| `MULTICC_ORCHESTRATION_RETENTION_INTERVAL_MS` | `3600000` |

在线清理不执行 VACUUM；释放的 SQLite 页可复用，但文件不一定立刻变小。
保留策略不能替代按需查询，也不能承诺磁盘固定上限：受保护记录、operations 和 waits
仍会保留，需要结合用途另行定义归档策略。

## 离线整理工具

源码入口：`native/core/src/bin/multicc-orchestration-maintenance.rs`。
工具已随调试构建生成；生产离线整理未执行。以下是操作说明，不是生产执行记录。

构建命令：

```sh
npm run build:orchestration-maintenance
```

默认产物位于 `native/target/release/`；若设置 `CARGO_TARGET_DIR`，以该目录为准。
本批新增独立构建入口，未修改安装包或镜像的二进制分发流程。验证使用外部构建缓存中的调试产物。
默认只读报告：

```sh
native/target/release/multicc-orchestration-maintenance \
  --database /absolute/data/orchestration.sqlite
```

真正清理需用户先手动停止所有使用该数据库的服务，再显式指定：

```sh
native/target/release/multicc-orchestration-maintenance \
  --database /absolute/data/orchestration.sqlite \
  --apply --offline-confirm \
  --backup /absolute/backups/orchestration-before-retention.sqlite \
  --compact
```

写入前取得排他维护锁、检查进程文件占用并取得 SQLite 独占锁；无法核实则拒绝写入。
新原生存储持有共享维护锁，旧 Node 服务由文件占用检查覆盖。Windows 暂只支持报告。
备份必须是新的绝对路径，不能覆盖原库、附属文件或已有备份；请放独立备份目录，
不要放会话 worktree。先创建 0600 一致性备份、核验并持久化，成功后才开始清理。

可加 `--task-days`、`--outbox-days`、`--batch-size` 和 `--max-batches`；默认最多 1000 批。
离线支持 `--max-records N`，与在线使用同一规则。`capacityTriggered/capacityExcess` 报告
数量压力；显式报告给出精确超额量，在线批次给出的超额量最多为批次大小（下界）。
`remainingEligible` 表示超过保留期且无引用的候选数量；容量触发不改变这套资格判断。
`complete` 表示没有可清理候选，不保证近期或受保护回执低于 5,000 条。
达到批数上限不等于全部完成。
`--compact` 仅离线执行，可能需要额外磁盘空间。工具不会自动停止或重启服务。

## 验证记录

2026-11-12，验证在会话 worktree 与隔离数据库中执行：

| 检查 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `cargo build --workspace` 与发布构建 | 均通过；addon、gateway、remote、cdpd 的来源校验与原生模块加载探针通过 |
| `cargo test --workspace -- --test-threads=1` | 47 组、1,310 项通过，0 失败、0 忽略 |
| 10 个编排集中回归文件 | 223 项通过，0 失败、0 跳过 |
| `npm test` 的全部组成分组 | 15/15 完整分组退出 0，所有 `&&` 后续命令均覆盖；并非一次顶层命令全绿 |
| 最终契约组 | 152 项通过，包含额度文本行终止符、严格枚举与 Claude 属性键转换的差分回归 |
| 离线维护工具隔离验证 | 9 组检查通过：只读无变更、参数与占用锁保护、备份拒绝覆盖、过期清理、无孤儿正文、备份与压缩后重读 |

集中回归文件：`test-orchestration-sqlite-store.js`、`test-orchestration-receipts.js`、
`test-orchestration-runtime.js`、`test-operation-service.js`、`test-outbox.js`、
`test-wait-service.js`、`test-session-work-scheduler.js`、`test-router-tool-runtime.js`、
`test-orchestration-routes.js`、`test-chat-bg-activity.js`。

已覆盖旧库迁移与完整导出、未知字段和 UTF-16 无损、正文/回执原子回滚与删除、正文缺失报错、
5,000/5,001 边界、近期和引用保护、容量超额后的真实投递/回调/派发幂等，以及重启后读取。
大历史用例在 80 MiB Node 堆限制下打开 6,000 条终态加 1 条活动记录，并完成按需查询和更新。
按 ID 的任务状态轮询覆盖会话隔离、限量分批和丢失 WebSocket 终态事件后的收尾。

完整 npm 门禁保留两项环境跳过：桌面打包的真实 electron-builder 复制测试缺少工具链，
PowerShell 安装迁移测试缺少 `pwsh`；另有一项既有重复气泡重试待办。没有把跳过或待办计为通过。
旧源码形状断言已改为真实宿主/Rust 行为验证；TLS 测试使用测试 CA 签发的合法服务端证书，
并验证不受信 CA 仍被拒绝。配额差分修复没有改变冻结 oracle 或放宽期望。
同轮门禁还将无人值守悬浮按钮的无限阴影动画改为透明度动画，以满足既有绘制预算。

Rust 默认并发验证曾出现基线共享测试的五秒响应超时，以及密钥路由夹具预占后释放端口导致的
`EADDRINUSE`。前者在完整串行运行中通过，超时与断言未修改；后者已结构性修复：网关新增
显式 `--ephemeral-loopback` 隔离启动选项，直接绑定 `127.0.0.1:0`，将实际端口同步至策略、
子进程与日志，夹具读取实际端口并删除旧连接重试。默认 `PORT` 校验契约不变。
参数用例 5/5、密钥路由集成 17/17 及最终完整串行工作区测试均通过。历史失败日志保留，
不能把串行结果描述为最终默认并发运行已通过。

最终发布产物对应源码指纹 `0f34d8b1fc2268a51f84d3e9`，使用该产物再次运行完整契约组，
152/152 通过，0 失败、0 跳过。完整验证日志保存在主仓
`data/rust-source/validation/task-88a969353c0b716636b714b302483a39/`；
最终 Rust 汇总为 `rust-validation-summary-final4.json`，npm 分组覆盖为
`npm-coverage-summary.json`，最终发布契约日志为 `final4-test-contracts.log`。

未进行生产 OOM 复现、同等优化 Node 基线的堆/RSS/延迟对比，不能据此宣称具体性能倍数。
上述验证未部署、重启服务或整理生产数据；提交与合并状态以 Git 记录为准。

2026-11-12 提交前复测：最终源码指纹保持不变，Rust 格式、严格 Clippy、构建及串行
完整工作区 1,310 项重新通过；全部 34 个修改或新增 Node 测试文件及四个相关完整门禁
共 1,184 项通过，另有缓存脚本 183 项断言和四次隔离 HTTP/派发场景通过。
本轮针对性验证无失败、跳过或待办；不替代上文完整 npm 套件的环境限制记录。
