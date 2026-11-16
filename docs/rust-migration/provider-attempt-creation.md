# Provider attempt 创建入口迁移（2026-11-16）

本批延续“列出剩余模块 → 逐批迁移 → 对拍及全量验证”的计划。迁移的是 `beginAttempt` 完整创建入口，尚未完成整个 provider runtime 或整个后端的 Rust 替换。所有变更保留在当前 worktree；未提交、未合并、未重启服务，也未修改真实配置、数据库或活会话。

## 剩余模块及推进顺序

下表是模块范围，不是完成清单。已存在的 Rust 内核继续复用；宿主端口只代表 HTTP 入口已迁，不能作为 Node 后端退役的完成证据。

| 顺序 | 模块 | 剩余工作 |
|---|---|---|
| 1 | 编排存储 | 独立 Rust 所有者已接入正式入口；继续移除事务回调及代理兼容层，关闭混合驱动诊断门禁 |
| 2 | 会话调度 | admit、complete、reorder、recover 领域命令及版本化读模型；已有持久子任务，尚无可验证交付 |
| 3 | 聊天轮次引擎 | turn/attempt、取消、后台、完成及恢复；本批迁移其中的 provider attempt 创建入口 |
| 4 | 会话与任务状态 | session、directory、task-board、workspace 状态及跨存储副作用 |
| 5 | Provider 与代理授权 | 剩余生命周期、事件和快照组装，以及代理 HTTP/流宿主；能力表及多项授权规则已在 Rust |
| 6 | CLI 与进程宿主 | 启停、常驻进程、安装升级与登录；复用已有 Rust 车道 |
| 7 | HTTP 宿主 | 剩余驻留 Node 的处理器及 Rust 路由背后的宿主事实 |
| 8 | WS / Air | 客户端表、快照、重放与实时事件之间的原子屏障 |
| 9 | 文件与静态资源 | session ZIP、导入 multipart、静态文件及 APK 文件宿主 |
| 10 | 语音与推送 | 音频宿主、语音进程及消息投递生命周期 |
| 11 | 工具与集成 | router tools、browser/CDP、memory、remote 等宿主 |
| 12 | 插件与渠道 | 插件管理、IM、cron；保留独立发布协议，仍纳入最终退出范围 |
| 13 | 启动与交付 | 去掉 backend Node 子进程，验证纯 Rust 启动、打包与部署 |

本轮开始时实测 `server.js + src/**/*.{js,cjs,mjs}` 共 612 文件 / 135,884 行，包含必要桥接，不能全视为待迁业务。运行时台账核对为 131 条路由 / 31 层中间件：35 条 host-port、71 条 plugin、6 条 state-in-rust、19 条 node-resident。本批未改路由注册。

## 本批实现

- `native/addon/src/provider_attempt_creation.rs` 的 `providerBeginAttempt` 负责校验、准入、旧 producer 排空、状态转移检查、代次分配、能力令牌复用、decision/attempt ID 分配、预算及 fence 继承、record 安装和事件阶段选择。
- 直接复用身份、转移、producer、CLI capability 规则；不复制已迁内核。Rust 直接操作当前表、代次表和生命周期结构体，生命周期创建不再通过 JavaScript 构造器反调 Rust，也没有 JSON 编码/解析。
- 准入由 Rust 作用域守卫释放，错误路径也会清理。当前表与代次表采用短期内部借用，调用输入 getter、ID、时钟及事件回调时不持有可变借用。
- record 安装后先释放准入，再调用事件宿主。事件回调可以完成当前 attempt 并创建后继；外层仍返回其捕获的原 record 的快照。
- `scripts/rust-source-cache.js` 的 addon 探针要求新增入口，旧产物无法被误认为支持该命令。
- `src/chat/provider-attempt-runtime.js` 从 676 行缩到 549 行：删除 129 行，新增 2 行，净减少 127 行。没有删除 Node 文件或依赖。

## 保留的 Node 范围及退出条件

`provider-attempt-runtime.js` 尚不是 shim-only 文件。其宿主仍提供 ID/时钟、事件投递、快照，以及未迁的 finish/event/scrub 等协调逻辑。创建入口只保留一行原生命令调用。保留这些部分是为了保持现有 runner、审计和代理的对象身份及回调协议；后续迁移生命周期命令、事件/快照构建及 runner 消费方后，才可删除这一宿主。它们属于仍待迁移的依赖，不能当作永久例外或宣布纯 Rust 完成。

`tests/helpers/legacy-provider-attempt-runtime.js` 是从 `git show 4a9d1aa3:src/chat/provider-attempt-runtime.js` 冻结的测试 oracle，仅调整相对导入。产品不加载它，且不从新实现反向构造基线。

## 验证

最终源码指纹：`8837cc9e6da19e3013f7585c`。测试明确覆盖同指纹 addon 与配套二进制，未使用父进程继承的旧 `MULTICC_RUST_ADDON`。

| 检查 | 本批证据 |
|---|---|
| `cargo fmt --all --check` | 退出 0，输出为空 |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | 退出 0，无警告 |
| `cargo build --locked --workspace` | 退出 0 |
| 串行 `cargo test --workspace --no-fail-fast -- --test-threads=1` | 74 个目标：2,377 passed / 3 failed；未全绿 |
| provider attempt / invocation / proxy guard / auto-route 等 11 文件 | 282/282 通过，0 skipped |
| 冻结对拍 | 80 组随机序列、每组 12 次创建，另覆盖输入 getter、ID/时钟异常、UTF-16 身份、预算转换、同会话与跨会话重入、事件回调启动后继，以及 null/primitive 输入 |
| 差分变异见证 | 4/4：破坏令牌复用、事件阶段、预算继承或安装后释放准入，差分均能识别；没有修改产品代码作假基线 |
| addon 探针、line budget、918 项测试分层、路由台账、`git diff --check` | 均通过；路由仍为 131/31 |
| WS backpressure | 单独补跑 14/14 通过 |

`npm test` 已实际执行，但不是全绿：它仍因缺少有效真实 Claude trace 而中止。随后独立执行余下 44 段，42 段通过，编排段与安全段失败。没有删除、放宽或跳过失败断言。

原有 8 项未关闭：真实 Claude trace 1 项、直接同进程混合 SQLite 驱动诊断 3 项、scheduler admit/complete/reorder/recover 迁移门禁 4 项。独立所有者正式入口的回归仍通过；底层混合驱动诊断不能冒称已修复。

此外，本轮安全复核遇到远控测试的限时失败：`test-remote-screen.js` 的 150ms 子进程启动等待没有生成 pid 文件；一次重跑中 `test-remote-screen-probe.js` 的 2 秒 relay 等待也失败。文件级串行安全复核达到 240 秒上限，没有完成，不能记为通过。期间机器 load average 约 74；生产与测试断言均未因负载而修改。

最终 Rust 使用 `--no-fail-fast` 执行完全部 74 个目标，2,377 通过 / 3 失败：

- `workspace_sharing::control::tests::create_reads_live_context_and_timed_out_context_never_mutates`：5 秒控制响应等待返回 `Elapsed`。
- `workspace_sharing::tests::concurrent_workers_share_one_durable_budget`：并发拒绝结果不是全部 `SHARE_EXHAUSTED`，错误分类断言失败；本轮没有将其直接归因为机器负载。
- `gateway/tests/outbound.rs::http_target_uses_absolute_form_through_the_proxy`：2 秒请求期限返回 `Timeout`。

完整门禁仍未关闭，上一源码指纹的 2,380 项通过不替代最终结果。本轮新增的创建入口定向回归均通过。

在整套检查结束后，保持原断言、原超时和相同源码，单独复跑上述 3 个 Rust 用例及 2 个远控用例：**5/5 通过**（Rust 分别 1/1，远控 2/2，0 skipped）。因此存在执行条件敏感性，但不能把这组单独通过改写为整个 Rust/Node 套件全绿。未继续重复整套检查，未改相关产品或测试代码。

本轮模块清单与创建入口迁移已完成；完整验证门禁仍开放。后续继续调度领域命令、剩余 attempt 生命周期和宿主迁移，保留所有失败门禁。所有本轮启动的检查进程均已结束。


## 部署差异

没有部署脚本、启动参数、默认配置或依赖变化。新增 addon 导出要求重新构建原生模块；已有编排所有者批次的部署差异另见 [编排所有者记录](orchestration-owner-experiment.md)。本轮没有触发服务重启；生产是否加载新代码仍由用户手动控制。
