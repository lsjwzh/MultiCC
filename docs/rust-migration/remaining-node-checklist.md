# 剩余 Node 后端清单

## Aux 判定时效与会话广播（2026-11-25）

语音就绪提交 `fcd74d42` 经 MultiCC 操作 `merge-back_mwv252x5_e648c3a739c1` 合入本地 main。合并提交 `23d90b47` 的第二父提交为该批次，合入后任务工作区干净，分支差距为 0/0。以下统计以此提交为基线。

服务在 Aux 队列健康状态变化时广播判定是否过期，聊天连接帧、会话档案和管理接口也读取这两个字段。宿主保存进程内队列回调，Rust 从回调取数、投影 `auxUnhealthy` 和 `auxUnhealthySince`，并为已有判定的会话选择聊天与工作区接收方。队列的诊断详情留在宿主。迁移前冻结了 81 行旧实现，Git blob 为 `2d74d48d827acd14a302338f8cb596b2b7cdb92c`，SHA-256 为 `df7ff6861160f62d513dd3d7a3aa34704af53c1b909d0987a66a7cab341b353e`。[Rust 实现](../../native/addon/src/aux_verdict_health.rs) · [冻结的旧实现](../../tests/helpers/legacy-aux-verdict-health.js) · [同输入差分](../../tests/test-aux-verdict-health.js)

迁移前用旧生产入口运行固定用例；迁移后使用新编译并通过预检的 release 原生模块（源码指纹 `d9101d314ff19631ee462fea`）。56 组状态和时间值、6 组缺失或异常来源、8 组广播和读取故障，共 70 组输入与旧实现结果一致。对照包括字段与读取顺序、消息对象共享与复制、广播计数和迭代器关闭。Aux、聊天连接帧、会话管理、API 契约和工作区定向测试 82/82 通过，Rust 聊天状态帧测试 6/6 通过。

src 的 JS/CJS/MJS 文件从 528 降至 527，现有 522 JS、2 CJS、3 MJS。515 个可从 server.js 的模块依赖到达，9 个经宿主脚本路径到达，2 个用于离线工具，1 个仅发现测试调用。按 server.js 加 src 下 JS/CJS/MJS 的物理行（含注释和空行），128,818 降至 128,743，净减 75 行。[工作树逐文件清单](node-module-dependencies.md)

## 语音输入就绪判断（2026-11-25）

本地 main 的 `eeff0a8c` 已包含 Codex 终端查找器提交 `2a5f837c`。MultiCC 合并回执为 `merge-back_mwv1p0fs_f27d81feb034`，任务工作区在合并完成时干净，与主线差距为 0/0。

兼容宿主的 `POST /api/voice/stt` 在语音不可用时返回 503、`voice_not_ready` 和就绪详情。原先此处使用 `src/voice/readiness.js`，而 `GET /api/voice/readiness` 在 Rust 网关里另外计算。两个入口现共用 Rust 的引擎选择、流式提供方判定和安装状态映射。Node 仍负责调用进程内 ASR、安装器与流式服务，读取云端凭据是否存在并保留原始下载进度对象。旧文件已移出生产目录。[Rust 规则](../../native/core/src/voice_routes.rs) · [STT 接线](../../src/routes/voice.js)

相对 `eeff0a8c` 重新扫描，src 从 529 个文件降至 528 个（523 JS、2 CJS、3 MJS）。其中 516 个沿 server.js 模块导入可达、9 个经宿主脚本路径可达、2 个供离线工具使用、1 个仅见测试引用。按 server.js 加 src 下 JS/CJS/MJS 的物理行（含注释和空行），128,854 降至 128,818，净减 36 行。旧文件删除 45 行，现有路由净增 9 行。测试副本单独存放。[实时依赖清单](node-module-dependencies.md) · [差分测试](../../tests/test-voice-readiness.js)

原生模块源码指纹为 `81a1c763f12774edb1bf5699`，release 构建通过接口预检。旧实现的 Git blob 为 `586ddd3484b4139e3186d13156af1940a58f4cfe`。180 组固定输入的返回值、字段顺序、下载对象引用和探针调用顺序均与旧实现一致，另有按需读取和异常传递检查。语音宿主与 STT 路由测试 31/31 通过，Rust 语音内核 19/19 通过，真实 Rust 网关的就绪路由集成测试 1/1 通过。

## Codex 终端会话 ID 查找（2026-11-25）

在合入版本 `a94bf826`，src 内 530 个 JS/CJS/MJS 文件中有 527 个可从兼容宿主到达，2 个供离线工具使用，1 个仅见测试引用。逐文件职责和直接调用方已固定在[530 项基线清单](src-classification-2026-11-25.md)。本批删除 Codex rollout 查找器后，工作树 src 内为 529 个文件（524 JS、2 CJS、3 MJS），其中 517 个沿模块导入可达，9 个沿宿主脚本路径可达。终端创建和保存仍经兼容宿主，rollout 读取、筛选和 ID 匹配已交给 Rust 工作线程。[工作树实时依赖](node-module-dependencies.md)

旧查找器逐字节冻结在 tests/helpers/legacy-codex-session-file.js。tests/test-codex-session-file.js 的 12 组差分场景把相同目录、cwd、时间阈值同时交给旧实现和生产入口，32 次比较均一致，另有 2 项轮询生命周期测试通过。与会话策略和生命周期路由一起执行共 59/59 通过。Rust 共享 JSON 读取回归 2/2 通过，release 原生模块通过接口预检，指纹为 `c1b062cf6e2211e63188c36c`。本批验证范围为定向回归。[差分测试](../../tests/test-codex-session-file.js) · [Rust 实现](../../native/core/src/codex_session_file.rs)

## 默认构建与部署路径（2026-11-24）

| 默认生产服务中逐项计数 | 数量 |
|---|---:|
| 后端 `.js` / `.cjs` / `.mjs` 文件 | 0 |
| Node、npm 可执行文件及 N-API 扩展 | 0 |
| 随服务安装的 npm 包、Node 运行依赖 | 0 |
| 程序目录中的 npm 依赖清单 | 0 |
| Rust 程序 | 5 |

清点范围为 `make stage` 的目录、由它生成的服务归档和根 Dockerfile 最终层。`public/` 及插件的 `ui/`、`public/` 供浏览器执行。根源码分发包的 npm 清单仅用于开发及打包，生产依赖图为零。默认 Cargo 成员的普通依赖图中没有 Node 绑定。[实测结果](production-entry-2026-11-24.md)

| 入口或功能 | 当前所有者与验证 |
|---|---|
| 构建与启动 | `make production` 使用 Cargo；`make start`、源码管理器、launchd 和根镜像直接运行网关。服务归档的入口为 `bin/multicc-gateway`。 |
| cron | 网关解析五字段规则，持久化触发分钟、在途记录和运行历史。脚本与固定任务投递均有手动及恢复覆盖。 |
| Aux | Rust 消费 SQLite 队列，管理并发与取消，发送 Messages、Chat Completions 或 Responses 请求，保留终态、健康信息和历史。服务原生接入手动入队、Goal 预检及语音进度摘要。 |
| 兼容发行物 | 带 Electron 的客户端和由安装器下载的 `multicc-standalone-*` 仍包含 Node 管理程序与兼容宿主文件，在目录/会话写操作迁完前默认挂载随包兼容宿主（支持 `MULTICC_NO_NODE=1` 显式切纯 Rust）。要部署零 Node 的服务，使用 `multicc-service-*`、根镜像或 `make stage`。 |
| 其他产品功能 | 渠道消息投递、部分会话及仓库写操作仍依赖兼容宿主。旧宿主的记忆复盘、终端意图分类和任务板分类仍由各自的宿主模块发起。 |

[源码兼容宿主清单](node-module-dependencies.md) · [旧式安装包盘点](packaged-backend-darwin-arm64.md)

## 2026-11-24 独立生产网关（上一批基线）

- 根源码包和根镜像只启动 Rust。源码管理器、launchd、desktop 和 standalone 仍加载兼容宿主。
- 23 个读请求中状态码一致 20 个，状态码和正文一致 12 个；两端各通过 19/19 项带数据检查，旧会话首次启动的搜索结果也一致。网关可读任务搜索和文档登记，提供四个运行指标及目录探针操作历史。旧会话首次领养复用 SQLite 身份事务，电源读接口直接查询平台状态。目前仍需迁移会话及 Aux、cron、渠道插件和后台消费者，并验证写入及重启。
- 静态盘点共 530 个 `src/` JS/CJS/MJS 文件，518 个可经根宿主导入，9 个经脚本路径引用，另计根宿主。根包生产 Node 依赖为 0。动态加载点及每个文件的归类见[逐文件清单](node-module-dependencies.md)。带数据验收和未迁功能见[生产入口报告](production-entry-2026-11-24.md)。


## 推送订阅、目录和分享入口（2026-11-24）

纯 Rust 入口已接管订阅存储、VAPID 公钥、推送健康、目录列表和分享入口及口令校验。隔离双实例的 23 条读请求中，状态码一致 15 条，仍有 8 条有差异；两端各通过 15 项预置数据检查。本批沿用已有 JS/CJS/MJS 文件清单，`src/` 为 525 + 2 + 3 个，另有根宿主。源码包生产 Node 依赖为 0。部署范围与逐域缺口见[入口验收记录](production-entry-2026-11-24.md)。

## 2026-11-24 根包生产启动入口

`npm start`、`npm run start:gateway` 和 PM2 改为直接执行 Rust release 网关；根包运行依赖从 18 项降为 0 项。旧宿主依赖仍用于开发、对照测试和原安装包。当前 `src/` 留有 525 个 JS、2 个 CJS 和 3 个 MJS；另有 `server.js`。逐文件依赖、未迁路由以及入口差分分别见[依赖盘点](node-module-dependencies.md)和[本批验收](production-entry-2026-11-24.md)。

## 2026-11-24 通知地址的读取与保存

删除 `src/notify-settings.js` 后，`GET /api/settings/notify` 与 `POST /api/settings/notify` 在 Rust 共用地址掩码规则。写入仍通过宿主的同步配置事务比较当前值、持久化并更新推送服务。当前 `src/` 有 525 个 JS、2 个 CJS、3 个 MJS，根包有 18 项直接运行依赖。静态扫描含入口在内共 531 个文件、223 处注册候选。本批原生构建隔离启动后捕获了 128 个 Node 路由和 25 层中间件。 [批次记录](node-retirement-batches.md) · [部署说明](../gateway.md)

## 2026-11-24 人机协助截图清理

截图的启动扫描与周期扫描已迁至 Rust，删除生产文件 `src/assist-snapshots.js`。纯 Rust 网关和带 Node 子进程的网关均在自身进程内执行扫描；单独运行 `server.js` 使用同一 Rust 内核。当前 `src/` 为 526 个 JS、2 个 CJS、3 个 MJS，根包有 18 个直接运行依赖。静态注册扫描覆盖含 `server.js` 的 532 个文件，找到 223 个候选。默认启动和安装包仍需要 Node。 [批次记录](node-retirement-batches.md) · [逐文件清单](node-module-dependencies.md)

## 2026-11-24 会话与环境诊断

`src/routes/doctor.js` 和 `src/routes/env-doctor.js` 已从生产目录移除。七条公开路由在 Rust 网关里选择服务参数，生成状态码与 JSON。Node 仍持有诊断任务、取消句柄、会话历史与 Aux 执行器。端到端迁移需接管这些服务。新旧路由的对照程序为 `docs/rust-migration/differential/host-ops-routes.js`。

当前 `src/` 有 527 个 JS、2 个 CJS 和 3 个 MJS。根包有 18 个直接运行依赖。静态扫描含 `server.js` 共 533 个文件和 223 处 HTTP 注册候选。隔离启动捕获了 128 个 Node 路由注册和 25 层中间件。源码默认入口由 Rust 网关拉起 Node，npm 包清单仍含 `server.js` 和 532 个 `src/` JS/CJS/MJS 文件。 [逐文件运行依赖](node-module-dependencies.md)

## 2026-11-24 分享页、请求计时器与 Grok 配置

`src/` 剩 531 个 JS/CJS（529 + 2），另有 3 个 MJS 入口。根包 `dependencies` 有 18 项。静态 HTTP 盘点覆盖含 `server.js` 的 535 个文件，列出 230 处注册候选。默认启动仍使用 `scripts/start-gateway.js` 的 `--node … server.js`。分享页模板已由 Rust 提供，分享数据接口仍需要宿主。

隔离启动 `--no-node`、配置本地认证后，分享页 GET / HEAD 返回 200，带 ETag 的条件请求返回 304；同一网关的 `GET /api/share/example/entry` 返回 503（`rust_backend_unavailable`）。含 Node 宿主的隔离运行捕获到 128 个 Express 路由注册和 25 层中间件。`npm pack --dry-run --ignore-scripts` 列出全部 534 个 `src/` JS/CJS/MJS 文件以及 `server.js`。 [运行时捕获](../backend-runtime-inventory.md)

从 `server.js` 沿字面量模块依赖可达 522 个文件，加上脚本路径可再达 9 个。两个独立运维和回测模块分别由 `scripts/task-workspace-inventory.js` 和 `scripts/backtest-task-attribution.js` 使用。`src/http/error-presenter.js` 目前只查到两个测试调用，仍单列在文件清单里。后续仍依赖任务壳和会话状态所有者、后台投递和恢复、Provider 执行及插件 SDK。切换默认入口需验证其 HTTP、WS、进程生命周期与安装包启动。 [逐文件依赖](node-module-dependencies.md) · [迁移顺序和批次记录](node-retirement-batches.md)

## 2026-11-24 任务板与任务壳更新

任务板依赖校验和分组已移出 `src/task-board/runtime-helpers.js`，任务板与任务壳三处短码展示已移出 `src/task-display-attribution.js`。这两个生产文件均已删除，旧实现保留在测试目录。此时 `src/` 剩 531 个 JS、2 个 CJS 文件，根包有 19 个直接 Node 运行依赖。默认 `npm start` 启动 Rust 网关，再由网关运行 Node 子进程。 [批次与剩余宿主端口](node-retirement-batches.md#任务板分组与任务短码展示2026-11-24)

## 2026-11-17 调度读模型基础（当时的工作区快照）

本阶段新增 Rust 版本绑定元数据缓存和后台快照构建基础。独立所有者的
现有写入口已接入共享缓存失效；后台构建和提交复核尚未接入生产调度，
也没有移除 Node 模块。该阶段统计为 607 个 `src/` JS/CJS/MJS 文件、
132,456 行；调度 `scheduler.js` / `host.js` 以及准入、完成、重排、恢复
的事务所有权仍未迁移。限制和后续前置条件详见
[`scheduler-read-model-next.md`](scheduler-read-model-next.md)。

最近按 Git 跟踪且磁盘存在的文件重新核对：`src/` 为 607 文件、
132,481 行（含新增状态传输桥），另有 `server.js` 3,099 行。已冻结恢复宿主并增加值投影对照；
问题、活动轮次和分类尚未接入独立 Rust 数据所有者。当前源码构建的隔离
模块下，准入和完成所有权门禁各失败一项；调度、投递和聊天定向回归
274 项通过，重排和恢复的两项原有所有权门禁失败。这些数字不代表迁移完成。
全工作区 Rust 测试第三次串行运行通过，严格 Clippy 和格式检查通过；前两次
全量分别因网关代理测试超时及临时端口占用失败，两项均单独重跑通过。

## 用户输入判定批次

删除 `src/session-work/user-input.js`（28 行）：直接输入和带任务壳回执的
输入判定迁到 `native/addon/src/session_work_selection.rs`，调度器与编排
运行时仅保留对原生函数的调用。因为调度器和编排宿主仍在 Node，N-API 桥
暂时必要；待两个调用方迁至 Rust 后才能移除。调用时按原顺序读取 live
对象，包括任务壳分支对 `source` 的第二次读取，并传播 getter 异常。

迁前原件备份在工作树外；冻结对照
`tests/helpers/legacy-session-work-user-input.js` 的 SHA-256 为
`55b2e49a792f2fa1439eb92ee485e0e100614126d6910ea43bb0571cd7155626`。
调度器冻结快照通过测试加载器接入该旧实现，不从当前 Rust 路径取值。
调度、投递和无人值守 FIFO 三套定向测试共 137 项通过，其中包含 SQLite
独立所有者对照。测试中的网关和 addon 使用同一工作树源码编译。
全工作区串行 Rust 测试重跑通过 75 个目标、2,405 项，严格 Clippy 和
`cargo fmt --check` 通过；此前一次全量因测试端口 `EADDRINUSE` 中断，
对应测试独立复跑通过。完整 Node 套件的部分启动流程尚未确认隔离，
未在本批运行，不能据此声称全量 Node 验收通过。

移除后按 Git 已跟踪且磁盘存在的 `src/` JS/CJS/MJS 文件重新统计：
608 文件、132,501 行；路由 96 文件/24,792 行，根目录 94/21,632，
聊天 68/14,336，线路 32/7,328，CLI 适配 38/6,475，语音 17/5,274，
任务壳 27/4,844，编排 7/3,279，会话调度 2/2,511。统计含必要桥接，
不是可直接删除的文件数。以下更新继续使用相同统计口径；不得以删除小
模块宣称调度器迁移完成。

## 投递类别判定批次

删除 `src/orchestration/delivery-classes.js`（54 行），类别映射及条件判定
迁入 `native/addon/src/delivery_class.rs`。`src/native/runtime.js` 留一处
共享 N-API 调用桥，避免重复创建查找对象；编排运行时与聊天引擎仍由 Node
持有，待迁走后才能删除该桥。冻结副本
`tests/helpers/legacy-delivery-classes.js` 与工作树外原始备份 SHA-256 均为
`721fdf513a3c9307ac327fa2342d719bbfd199e45e8bba0f16d21dcefdda8451`。
差分覆盖未知类型、原型链、查找对象身份、类型转换、副作用 getter、
动态变化和异常；调度、投递、聊天协调、无人值守定向测试合计 281 项通过。
全工作区串行 Rust 测试通过 75 个目标、2,405 项，严格 Clippy 和格式检查通过。

本批后 `src/` 为 607 文件、132,456 行：路由 96/24,792，根目录 94/21,632，
聊天 68/14,335，线路 32/7,328，CLI 适配 38/6,475，语音 17/5,274，
任务壳 27/4,844，编排 6/3,224，会话调度 2/2,511。下一依赖仍是调度
读模型及准入、完成、重排、恢复的事务所有权；这些尚未迁移。

统计基线是本批开始时的 `b9d8ef9b`，只统计 Git 跟踪的 `src/` 下
`.js`、`.cjs`、`.mjs`，按文本行计数：610 个文件、132,585 行；另有
`server.js` 3,099 行。这里包括已迁入 Rust 后保留的宿主适配、进程和
SDK 接口，以及不属于核心后端迁移的插件入口，因此不是待删除行数。
测试、构建工具、Web 前端和 Flutter 不在此统计中。

本批删除 `src/providers/claude-proxy-policy.js` 并缩减 `core.js` 后，
同口径为 609 个文件、132,526 行；`server.js` 不变。Rust 策略位于
`native/addon/src/provider_claude_proxy_policy.rs`，对照冻结的
`tests/helpers/legacy-claude-proxy-policy.js`。原件和冻结副本的 SHA-256
均为 `0aed74ce2b178a6febd9c4a7914bf2bb8d852a6873d42e4f1cd3741064d10001`。
`src/providers/core.js` 保留两行惰性原生调用桥：现有 provider 和 CLI
执行器仍由 Node 承载，在这些调用方迁走后才能删除桥接；策略与失败
决策已在 Rust。debug 与 release addon 均通过 207 项定向回归，覆盖
普通路径、强制代理失败、旧实现差分、属性访问顺序、异常对象和字符串
代码生成禁用场景；release addon 探针、格式检查与 addon clippy 通过。
release 全工作区 Rust 测试通过 75 个目标、2,403 项，0 失败。
上述 Claude 验证时的源码指纹是 `988cded42fdf9df070fcf73a`；之后调度器
实验接口改动已产生新指纹，须使用与当前源码匹配的产物。在 release 网关与 addon 下，
隔离的真实聊天启动测试以合成 provider 和替身 CLI 经本地 SDK 中继、
网关及 provider 代理访问本地上游，确认子进程不获得 provider 凭据。
策略单测在禁止字符串代码生成时通过；将同一限制施加于整个服务时，
服务在启动阶段加载第三方 `depd` 的 `new Function` 处失败，尚未到达
本批策略。`npm test` 核心批次有 2,533 项通过、10 项失败、3 项跳过：
三项进程测试因沙箱不允许执行 setuid `/bin/ps`，审查其临时进程夹具后
单独复跑通过；另有三项 SQLite 跨驱动行为和四项调度器所有权门禁失败。
另外，真实 Claude trace 未提供而跳过，行数预算仍未通过。两个重启
集成测试现已登记为 `flow / isolated`，分级及治理检查通过；release
重启监督器与三种本机地址场景分段通过，测试侧以非 setuid 的同字节
`ps` 副本绕过 macOS 沙箱对 `/bin/ps` 的限制。契约测试 163/163 通过；
native 测试的 319 项通过，重启场景另行以 release 程序验证；独立包
分段测试通过 74 项，因未安装 PowerShell 跳过一项。三项 SQLite 跨驱动
失败在沙箱外使用临时数据库复现。桌面测试因缺少 Electron 工具链跳过
一项。全量验收尚未通过，不能据定向结果提交或合并。

| 源码分布 | 文件 | 文本行 | 主要工作 |
|---|---:|---:|---|
| `src/routes` | 96 | 24,801 | 宿主事实、剩余路由与流；按领域和状态所有者迁移 |
| `src` 根目录 | 94 | 21,635 | 启动、共享基础设施、分类和集成，需逐个判断 |
| `src/chat` | 68 | 14,320 | 回合协调、流、取消、完成和恢复 |
| `src/providers` | 33 | 7,369 | 线路状态、代理和宿主事实；本批迁出 Claude 防直连规则 |
| `src/cli-adapters` | 38 | 6,475 | 外部 CLI 协议和子进程生命周期 |
| `src/voice` | 17 | 5,274 | 音频、进程和设备适配 |
| `src/task-shell` | 27 | 4,836 | 任务运行态与宿主副作用 |
| `src/session` | 24 | 3,414 | 会话生命周期与宿主侧行为 |
| `src/codex` | 13 | 3,401 | Codex 进程、会话目录和协议 |
| `src/workspace` | 17 | 3,308 | 工作区运行态、同步和宿主端口 |
| `src/orchestration` | 7 | 3,279 | 调度协调和存储桥接 |
| `src/classify` | 9 | 3,220 | 分类状态机及宿主协调 |
| `src/session-work` | 3 | 2,540 | 准入、完成、队列重排和恢复 |
| 其他 `src` 目录 | 164 | 28,713 | 配额、搜索、通知、浏览器及其他集成 |

路由口径来自既有启动捕获和台账对账，**不是本批重新启动捕获**：
131 条 Node 路由注册中，35 条是前门的宿主端口，71 条是插件，6 条的
状态已在 Rust，19 条仍驻留 Node；另有 31 层中间件。数字不能相加推断
剩余独立模块数，宿主端口还需逐个迁移其背后的事实和状态。捕获存在
家目录隔离限制，详见 `docs/backend-runtime-inventory.md`。

## 后续优先顺序

1. 调度准入、完成、队列重排和恢复：**已完成（2026-11-19 复核）**。四个入口的
   决策与事务都在 Rust：准入 `schedule_admit_live`、完成 `schedule_settle_live`、
   重排 `schedule_admit_live::reorder`、恢复 `schedule_lifecycle_live`；Node 侧
   `src/orchestration/native-store-host.js` 只剩串行化队列、JSON 编组与时钟端口，
   按原守卫顺序调用，不做调度决策。实测门禁全绿：
   `test-scheduler-admit-rust-required` 3、`test-scheduler-complete-rust-required` 3、
   `test-scheduler-recovery-rust` 4、`test-scheduler-complete-order` 3、
   `test-scheduler-insert-native` 4、`test-scheduler-note-native` 3、
   `test-scheduler-worker-order` 5、`test-session-work-scheduler` 73、
   `test-session-work-host` 64、`test-migrated-command-ownership` 2，合计 164 项 0 失败。
   本文件此前一直写着「现有静态门禁仍未通过」，那是 2026-11-17 的状态，在 11-18
   恢复所有权收尾后就已过期；该说法已据实订正。
   `src/session-work/scheduler.js`（1,108 行）与 `host.js`（1,294 行）仍在 Node，
   但承载的是宿主副作用与事件广播，不是调度状态所有权。
2. 聊天回合与会话所有权：迁移 `turn-engine` 的状态机和效果协调，
   补齐取消、重试、后台任务、完成和恢复的真实事件样本。
3. 状态与持久化：逐个迁移会话记录、任务运行态和仍在 Node 的领域
   写入；保持单一写入所有者、旧数据读取和事务语义。
4. 剩余核心路由：插件管理 8、OAuth 登录 2、会话压缩包 2、provider
   代理 2、Air 同步 2、内部工具/语音 2、APK 下载 1；对应流、子进程
   和共享同步屏障必须随其状态一起处理。
5. 前门依赖的宿主端口、中间件、静态文件、WS/SSE：按具体事实和
   持有的句柄逐簇迁移，不以单纯删除路由注册代表完成。
   WS 部分的进度（2026-11-19）：共享连接路由的连接注册、心跳判定与每连接发送
   队列已由 addon 的 `RustWsHost` 持有，`src/ws-backpressure.js` 已删除；
   详见 `ws-host-registry-2026-11-19.md`。同日第一条**生产** WS 路径
   `/ws/machines/<id>` 的升级终结已迁入前门（`native/gateway/src/ws_machines.rs`
   与 `ws_tls.rs`），`src/ws/machines.js` 与连接路由分支已删除，8 项逐字节差分
   与 5 个变异通过，详见 `ws-machines-cutover-2026-11-19.md`；该路径是 9 类 WS 中
   唯一零共享状态的一条，`wss://` 的真实 TLS 握手尚未本地实测。仍在 Node 的是
   `/ws/chat` 的 upgrade 终结与回合引擎状态（快照/重放/聊天编排）以及其余 WS
   路径的连接注册。
6. CLI、浏览器、音频及外部 SDK 集成：迁移业务和状态，按平台保留
   必要兼容桥；插件的独立发布模型另行处理。

整体完成仍要求 Rust 独立启动能够承载完整产品、无生产 Node 后端、
契约与全量测试通过，并验证打包和回滚；当前均未达到。

调度器第一阶段已冻结四个迁前入口并建立内存和独立 SQLite 所有者对拍；
实验性元数据读取可显式准备至多 16 MiB 的记录，详见
`scheduler-read-model-next.md`。这仍不构成非阻塞读模型；但四个调度入口本身
及其所有权门禁已在 2026-11-19 复核中全部通过（证据见上文第 1 条）。
