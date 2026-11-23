# 生产入口切换验收（2026-11-24）

## 独立包启动与定时任务月历

运行代码提交 `c2d12c57`，原生源码指纹 `013b4fc5695e878c2fb21a66`。默认 Cargo 和完整工作区均以 release 构建通过，格式检查和全工作区严格 Clippy 通过。独立网关的 23 个 GET 状态码与兼容宿主全部相同，14 个响应正文字节一致；两端各通过 20 项带数据行为检查，列表差分 13 组一致。

独立网关现可读取 `GET /api/cron/calendar?month=YYYY-MM` 和 `GET /api/cron/:id/runs`。两个真实部署使用独立目录，对照了 11 个请求，包含月份范围和重复参数、订阅提示、200 个高频点上限、最近 20 次运行、UTF-16 输出截断、未知任务、HEAD 和 OPTIONS。可用下列命令复查。

```sh
node docs/rust-migration/differential/production-cron.js "$GATEWAY" "$FIXTURE_ADDON"
```

macOS ARM64 独立安装包构建和启动通过，实际加载聊天页、报告运行中、停止后释放进程和端口。桌面 DMG 构建通过，从包内启动 Electron 后，它自己的 `/readyz` 返回 200。此前第一次独立包启动继承了旧服务指向另一份 addon 的环境变量，在加载会话任务板时反复退出。本次启动器从安装目录选择网关及配对模块。两种安装仍带同一套 Node 宿主、17 项必需和 1 项可选生产依赖。实际安装路径、版本、运行时文件和完整扫描复现命令见[安装包盘点](packaged-backend-darwin-arm64.md)。

本提交的源码发行包有 983 项，宿主 JS、生产 npm 锁依赖、默认 Cargo 图中的 Node 原生依赖均为 0。Linux ARM64 根镜像构建完成，在容器中检查 Node、npm、`server.js` 和宿主源码目录均不存在，实际运行的网关就绪接口返回 200。

| 切换抽样 | 兼容宿主 | 独立 Rust |
|---|---:|---:|
| 通知设置 GET / POST、月历、目录和渠道列表（五项） | 200 | 200 |
| 创建定时任务，空 JSON | 400 | 503 |
| Provider 列表、更新状态、Aux 配置、保险箱列表（四项） | 200 | 503 |

10 项切换探针中 5 项状态与错误码一致。单项定时任务运行历史另外通过数据和响应字节对照。源码管理器、登录服务、独立包与桌面仍需兼容宿主来提供未迁的接口、后台调度和投递。

## 默认 Rust 入口和部署复核

代码提交 `9051572e`，发布程序指纹 `db75e36470b2263af454078e`。默认 Cargo release 和显式全工作区 release 都通过。网关省略运行时参数后直接启动 Rust，外置环境文件在监听和鉴权初始化前加载。根包从 18 个 Node 运行依赖降为 0；同一提交的 npm 源码包含 982 项，宿主 JS、生产 npm 锁文件节点和默认 Rust 图中的 Node 绑定依赖各为 0。从真实发行包解包，放入本次构建的五个 Rust 程序后运行 `npm start`，就绪、聊天页面、通知设置、定时任务、渠道和会话六项均为 200。Linux ARM64 实际构建并启动 Docker 镜像，就绪返回 200，运行层找不到 Node、npm、根宿主或其源码目录。

| 隔离双入口检查 | 原生指纹 `2dd95b4d7e5a3c2c554ece51` | 提交 `9051572e` |
|---|---:|---:|
| 23 个 GET，状态码相同 | 23 | 23 |
| 同一批 GET，状态码与响应字节相同（含运行时动态字段） | 15 | 14 |
| 两端各自通过的带数据检查 | 19 | 20 |
| 10 个切换请求中状态码与公开错误码相同 | 3 | 4 |

`POST /api/settings/notify` 从 503 恢复为 200，验证覆盖掩码占位符、整批校验、即时读取以及重启后回读。切换组中 `POST /api/cron` 的空输入在旧宿主为 400，独立网关为 503；读取 cron 月历、Provider 列表、更新状态、Aux 配置和保险箱元数据在旧宿主为 200，独立网关为 503。两端的 13 组列表对照通过。源码包中的 225 个浏览器脚本、182 个兼容 addon 源文件、源码检出中的 530 个宿主目录 JS/CJS/MJS 与根宿主 `server.js` 分别统计。桌面与独立包另带 17 个必需生产依赖及 1 个可选依赖，源码管理器及其 launchd 服务也继续使用 Node。

复验使用 `production-entry.js` 的默认、`--contracts` 和 `--cutover` 三种模式、`production-lists.js` 及 `production-package.js`。这些程序位于同目录的 `differential/` 下。工作树的完整宿主静态依赖按文件列在[逐文件清单](node-module-dependencies.md)，各类安装入口见[部署清单](remaining-node-checklist.md)。

## 上一批列表迁移验收进度

| 同一组隔离部署探针 | 切换前 | 当前网关 `2dd95b4d7e5a3c2c554ece51` |
|---|---:|---:|
| 23 个实际 GET，状态码一致 | 5/23 | 23/23 |
| 同批请求，状态码和正文逐字节一致 | 3/23 | 15/23 |
| 预置数据行为检查 | — | 兼容入口 19/19，独立网关 19/19 |
| 旧会话首次启动后的搜索 | — | BM25 分数、结果及高亮一致 |
| 根包生产 npm 依赖 | 18 | 0 |

本次抽样中，`/api/sessions`、`/api/cron` 和 `/api/channels` 在两个入口均返回 200。纯 Rust 网关可从根 npm 发行包运行；桌面、独立安装包和源码管理器的服务端仍需要兼容宿主。下文按源码指纹记录结果。

## 切换前的基线

工作树基于 `a7039b0e`，含此前未提交的迁移。Apple Silicon macOS，发布二进制源码指纹 `4d281597db9455be2bb19599`。原入口是网关加 Node 宿主。对照实验启动两个独立网关，分别使用空数据目录、临时用户目录、相同测试凭据和同一套页面，候选进程以 `--no-node` 启动。复现命令为 `node docs/rust-migration/differential/production-entry.js <gateway> <reference-addon>`。逐接口比较状态码，另计状态码和正文均相同的项。端口、运行时长等动态值会影响正文比较。

现有纯 Rust 启动测试 `no_node` 7/7、`no_node_auth` 8/8。有些测试要求缺少宿主时返回 503。对现有 HTTP 差分设置 `MULTICC_DIFF_NO_NODE=1`，宿主读 11/36、服务核心就绪组 4/19、未就绪组 1/9、渠道 7/29、静态页面 172/172 逐项一致。原夹具另有 42 个预期差异依赖 Node 转发或模拟宿主，纯 Rust 模式符合这些预期的为 0。以上五组可计数的检查合计 195/307（63.5%）。任务组在解析缺少任务图的响应时中断，CLI 切换组的旧测试入口缺少导入模块，均单列、未计入分母。该比例仅适用于这些现有 HTTP 用例。

真实服务读请求：5/23 个状态码一致。复核时把旧入口复制到独立目录以隔离检出目录的 .env，同一旧版二进制的 23 项中有 3 项状态码和正文逐字节一致。

| GET 路径 | 兼容入口 | 纯 Rust | 纯 Rust 错误码 |
|---|---:|---:|---|
| `/healthz` | 200 | 200 | — |
| `/readyz` | 200 | 200 | — |
| `/manage` | 302 | 302 | — |
| `/chat.html` | 200 | 200 | — |
| `/api/claude/models` | 200 | 200 | — |
| `/api/settings/access-token` | 200 | 500 | internal_error |
| `/api/host/battery` | 200 | 500 | internal_error |
| `/api/settings/notify` | 200 | 500 | internal_error |
| `/api/push/health` | 200 | 500 | internal_error |
| `/api/push/vapid-key` | 200 | 500 | internal_error |
| `/api/push/bark-devices` | 200 | 503 | rust_backend_unavailable |
| `/api/settings/power` | 200 | 500 | internal_error |
| `/metrics` | 200 | 503 | rust_backend_unavailable |
| `/api/server-info` | 200 | 503 | rust_backend_unavailable |
| `/api/directories` | 200 | 503 | rust_backend_unavailable |
| `/api/sessions` | 200 | 503 | rust_backend_unavailable |
| `/api/task-board/search?q=fixture` | 200 | 503 | rust_backend_unavailable |
| `/api/docs-registry` | 200 | 503 | rust_backend_unavailable |
| `/api/cron` | 200 | 503 | node_runtime_absent |
| `/api/channels` | 200 | 503 | rust_backend_unavailable |
| `/api/machines` | 200 | 503 | rust_backend_unavailable |
| `/api/share/unknown/entry` | 404 | 503 | rust_backend_unavailable |
| `/api/repo-operations/unknown` | 404 | 503 | rust_backend_unavailable |

代码清单现有 525 个 `.js`、2 个 `.cjs`、3 个 `.mjs`（限 `src/`，含薄桥与运维入口）。当时根包有 18 个 Node 运行依赖。仅移出根包不计为模块已移植。

## 本批改动与实测

工作树在 `a7039b0e` 上构建，原生源码指纹为 `5310e186efffb1691da2cd01`。根包 `npm start`、`start:gateway` 和 PM2 直接启动 Rust 网关。配套二进制为 `multicc-writer`、`restart-supervisor`、`multicc-remote` 和 `multicc-cdpd`。Cargo 明确选择每个发布目标，重启监督程序来自 `multicc-core`。PM2 用 `interpreter: 'none'`。源码包部署命令和容器数据卷见[网关部署文档](../gateway.md)。

| 已接入纯 Rust 的接口 | 数据来源及验收 |
|---|---|
| `GET /api/settings/access-token` | 读取鉴权快照，远端缺少凭据时返回 403，携带有效凭据时只回掩码和 `canEdit: false` |
| `GET /api/host/battery` | macOS 调用 pmset，Linux 读 sysfs；同一实例缓存探针结果 5 秒。macOS 已测百分比和布尔字段 |
| `GET /api/server-info` | 使用网关实际监听地址和端口、包版本、网卡以及进程运行时间；动态字段逐项检查 |
| `GET /api/settings/notify`、`GET /api/push/bark-devices` | 读取已有 Bark 设备文件，保留旧设备与禁用标志，返回地址仅含来源或掩码。此处覆盖读取，通知投递和写配置仍依赖宿主 |
| `GET /api/machines`、`GET /api/machines/self`、`GET /api/machines/grants`、`PATCH /api/machines/:machineId` | 经现有来源及鉴权检查调用 Rust 机器注册表。测试覆盖有数据的列表、跨站拒绝、改名落盘后回读及 `Cache-Control: no-store` |

使用前述同一批 23 个读接口重复请求，状态码一致从 5 项升至 11 项，状态码和正文逐字节一致为 7 项。两套空数据目录各生成自己的电脑标识，健康和服务器信息还含进程动态值。带预置数据的对照可单独运行：

```sh
node docs/rust-migration/differential/production-entry.js "$GATEWAY" "$FIXTURE_ADDON" --contracts
node docs/rust-migration/differential/production-package.js
cargo test --locked --manifest-path native/Cargo.toml --workspace -- --test-threads=1
```

10 项预置数据行为检查在旧宿主与新入口各通过 10 项。另三组既有宿主兼容差分分别为宿主读相同 36/36，另 3/3 个预期差异通过；分享与电脑相同 66/66；静态页面相同 172/172，另 31/31 个转发差异符合预期。串行 Rust 工作区 85 个测试目标、2,849 项通过，失败及忽略均为 0。

实际 `npm pack --dry-run` 包含 966 个文件，`server.js`、`src/`、`node_modules/` 和旧启动脚本共 0 个。根包和锁文件的生产依赖图均为零，锁文件余下 395 项均为开发依赖。该包为源码发行，宿主架构须有 Rust/C 工具链和 libclang 才能构建。前端静态 JavaScript 随包提供。

## 推送订阅、目录和分享入口

本批原生源码指纹为 `04efcb6f4d3211c2d0a68d80`。两个入口各使用独立数据和用户目录。对照宿主使用测试目录中的 `server.js` 副本，VAPID 密钥与 Git 仓库均在该目录临时创建。本批的 23 条读请求中，状态码相同 **15/23**，状态码和正文均相同 **9/23**。VAPID 公钥和机器标识随独立部署生成，进程时长与端口也各不相同。带预置数据的行为检查在两个入口各通过 **15/15**。

| 已迁入口 | 验证到的行为 |
|---|---|
| `/api/push/vapid-key` | 自动创建 P-256 密钥对，使用旧配置的变量名和格式，仅返回公钥。验证了密钥对匹配、文件权限和重启后公钥相同。容器把可写配置放在数据卷中。 |
| `/api/push/health`、`/api/push/subscribe`、`/api/push/validate` | 读取已有订阅；新建、同端点替换、重启、验证和删除后回读。健康响应只显示端点指纹。独立网关尚无推送投递器，发送计数保持初始值。 |
| `/api/directories` | 读取已有目录与会话，统计 CLI 和会话类型，从本地 Git 引用获得分支、上游、工作区改动与领先/落后数。测试仓库含一个提交、一个未跟踪文件和一个尚无远程跟踪分支的 remote。 |
| `/api/share/:token/entry`、`/api/share/:token/auth` | 支持实时会话入口、已存消息快照、口令校验和原格式的限域 cookie。检查了错误口令、cookie 签名、过期清理和已存快照正文。 |

目录宿主兼容差分为 91/91，192 条磁盘及 Git 操作记录一致。推送宿主差分为 107/107，另有分享及电脑 66/66、静态页面 172/172 和宿主读取 36/36。目录与推送差分在记录首个请求前等待模拟宿主就绪；目录用例在一次性用户目录内运行，并验证带中文的提交说明。

历史分页文件为 21,194,349 字节。此前一次全量 npm 测试的峰值增长 18,544 KiB，超过文件大小的 75%。索引仅保留偏移，现用字段投影校验 JSON，避免构建整条消息的值树；分页返回可复用有效 UTF-8 缓冲区。原阈值下，五次独立探针的峰值增长分别为 4,992、5,056、4,864、4,896、5,200 KiB，原分页测试通过。

本批 `npm pack --dry-run` 共 969 项，旧宿主文件及 Node 生产包均为 0。`cargo fmt --check` 和全工作区 Clippy 通过。此指纹的串行 Rust 工作区通过，真实源码包编译成功，Linux 运行镜像确认无 Node/npm 且就绪返回 200。完整 npm 当时在投递证明内存上超限，峰值增量为 15,712 KiB；后续改用字段投影后单独复验。

## 搜索、登记与运行指标

原生指纹 `af6ce29b8a8976aadeef179e`。空库 23 个读请求中，状态码一致 19 个，状态码和正文均一致 13 个。两端各通过 18 项带数据检查。给两个入口相同的已升级任务板后，任务搜索结果连同 BM25 分数和 UTF-16 高亮位置完全一致。直接用旧数据启动时分数不同，原因为兼容宿主会多领养一个会话，改变了索引的文档频率。差分单列这一项并以非零退出。

| 入口 | 网关已提供的行为 | 仍由兼容宿主提供的行为 |
|---|---|---|
| `GET /api/task-board/search` | 基于持久化任务板的 BM25 排序、筛选、删除状态、Unicode 规范化、高亮及分数阈值 | 其余任务板操作和后台归类 |
| `GET /api/docs-registry` | 旧 pin 迁移、跨文档资源保留、目录筛选、过期状态与有界的本机服务探活 | 周期监控、PID 管理与登记变更 |
| `GET /metrics` | 网关就绪、WebSocket 连接、活跃回合和 Git 队列四项实测指标 | 旧宿主其余调度及投递指标 |
| `GET /api/repo-operations/:id` | 本进程目录 Git 探针的进行中与已完成记录，未知 ID 返回原 404 | 其他仓库写操作的执行与历史 |

该次完整 `npm test` 退出 0，原阈值的历史分页及投递证明内存检查通过。任务差分 79/79，目录差分 91/91，宿主读取差分 36/36。文档与记忆历史夹具曾因导入已删除的 `src/http` 中断，恢复其冻结版本的依赖后 94/94 通过，四处存储和四次执行记录一致。一次串行 Rust 工作区测试在目录夹具启动时遇到 `EADDRINUSE`；该夹具改为由网关绑定回环端口 0 后报告真实端口。上述故障与旧库首次领养分别记录。

## 旧会话首次启动和电源读取

原生指纹 `0b86a8db473a1a2914ff05e2`。独立入口在开始接收请求前检查目录中的普通聊天记录，按原有归属规则登记 SQLite 任务、关联和角色快照，使用任务板 revision 比较后写入卡片，再记录已建索引标记并补齐会话绑定。旧历史按条读取。同一个已迁移任务板再次启动时会复用身份。针对删除、归属冲突、内部执行槽和写绑定前中断的 Rust 测试通过。此步骤处理当前规划 schema 的任务板，早于规划 schema 的存量数据仍需原规划升级流程。

`GET /api/settings/power` 在 macOS 读取 pmset 观测值、powerd 意图、自动解锁偏好和钥匙串条目存在性，按需要读取 Agent 的辅助功能及录屏授权。远程客户端只得到只读状态。独立入口没有运行低电量守护定时器，返回其实际停止状态。其他平台按原契约返回不可用。电源写设置和低电量触发休眠仍待迁移。

新指纹的源码发行已在临时目录解包，用 Cargo 构建了五个二进制并通过无 Node 的启动冒烟。部署文档补入发布包后再次实际打包，977 项、无后端 JS、无 Node 二进制或生产 JS 依赖。将同指纹网关放在该包约定位置，直接执行 `npm start -- --ephemeral-loopback --stdin-lifeline`，用 `/readyz` 响应头的 PID 核对系统进程为 `multicc-gateway`，返回 200，该网关进程当时的子进程数为 0。五个发布目标在本机的 Cargo 普通依赖图共 290 个不同的 crate 名称，其中 N-API 和 Node 绑定为 0。`otool -L` 显示 macOS 网关只链接 Security、CoreFoundation、libiconv 和 libSystem。

本批全工作区 Clippy、格式、打包清单和历史内存测试已通过。兼容宿主差分为任务 79/79，文档与记忆 94/94，目录 91/91，宿主读取 36/36（另有 3/3 个预期差异）。服务核心的未就绪组首次有三条 HTTP 请求早于夹具完成启动；增加独立启动确认后，同一二进制在就绪组 19/19、未就绪组 9/9。真实入口的 23 条探针仍有三条差异，命令退出 1。该指纹的完整 `npm test` 和 Linux 镜像验收均退出 0。镜像冒烟确认容器中没有 Node/npm，网关的 `/readyz` 返回 200。

串行 Rust 首次在 `no_node_auth` 的指标用例失败。独立网关已经提供指标，旧测试仍要求带有效凭据时返回 503。复测覆盖有效凭据得到 200 和四项指标、匿名请求跳转登录、未配置本地鉴权时返回 503；该组 8/8 通过。更新测试后的原生源码指纹为 `da66984792b6c17054f21e38`，重建的网关、addon、远控、CDP 和重启监督程序与完整 npm 使用的五个文件逐一 SHA-256 相同。`cargo test --locked --manifest-path native/Cargo.toml --workspace --no-fail-fast -- --test-threads=1` 退出 0，85 个目标合计 2,852 项通过、0 失败、0 忽略。完整 npm 日志中的 Node 测试汇总为 7,957 项通过、6 项跳过、1 项 TODO、0 失败。最后修订的制品定时器断言另行复测 8/8 通过。

## 会话、定时规则与渠道列表

生产启动方式 `multicc-gateway serve --no-node` 已接管三个列表的 GET、HEAD、OPTIONS。双入口验收使用独立临时数据目录、HOME、插件目录和环回端口，对照端只使用隔离的旧宿主及显式指定的原生模块。

| 接口 | 实现与差分覆盖 |
|---|---|
| `/api/sessions` | Aux 首行、普通会话顺序、隐藏已绑定任务和内部执行槽。逐字段比较 Claude 和 Codex 配置、供应商模型别名、历史中的最后一次助手回复，并用真实 WebSocket 观察连接前、连接中、断开后的 `clients` 和 `active`。本地 Git 工作树在测试中领先一个提交且有未提交改动，两个入口后台刷新后均报告可合并。 |
| `/api/cron` | 从旧插件目录复制规则，保留原文件。已有会话认领原任务，新规则按兼容幂等键建立任务、执行记录与任务板条目。重启后保留 ID，固定任务被归档后显示只读与绑定错误。脚本类型保留零退出码，倒序展示最近十次运行，按 UTF-16 截取最后 400 个码元。用例覆盖非法 CLI、已删除目录、无效表达式、损坏配置的空列表回退、条件请求 304，以及非法运行记录的 500 错误正文。 |
| `/api/channels` | 从内置和用户插件目录读取清单，区分缺少二进制、平台不支持、子进程运行及收到 hello 后就绪。使用本地测试插件观察版本、告警、退出信号、重启次数和恢复。关闭网关后，测试确认插件读到标准输入 EOF，且原 PID 已释放。启用的推送订阅、全局钩子及会话钩子进入计数，损坏的配置文件回退后，独立来源的使用计数仍保留。 |

原生源码指纹为 `2dd95b4d7e5a3c2c554ece51`。三个列表的专项差分 **13/13 组通过**。空库 HTTP 对照为 **23/23 个状态码一致，15/23 个正文逐字节一致**。其中 cron、channels 的空库正文相同。会话首行的 Aux 工作目录和创建时间随独立部署生成。上一轮为 14/23，本轮多一项是含运行时长的 `/healthz`。原有预置数据检查在两端各通过 **19/19**，包括旧会话迁移后的搜索排名。

渠道插件先经 SIGTERM 退出并重启，再经 SIGHUP 重启，第二次握手省略版本号。两个入口均返回信号名称，并在第二次握手后回退到清单版本。相同用例在修正前的 Rust 网关上复现了数字信号和过期版本。发布包清单含 982 个文件、五个 Rust 程序，宿主文件、生产 Node 包及原生 Node 依赖均为 0。

兼容宿主的会话管理差分 **79/79**，副作用记录逐项一致。该夹具改为加载已冻结的旧访问守卫，并在启动时等待读接口就绪。渠道差分 **29/29**，既定的 **8/8** 项差异均符合预期。

在上述源码指纹上，`cargo fmt --all --check` 和全工作区 Clippy（`--all-targets -- -D warnings`）通过。下列串行 Rust 命令退出 0，**85 个测试目标合计 2,852 项通过、0 失败、0 忽略**。早期运行中，回执重试用例将会话文件当作裸数组读取。夹具改用正式 StateStore 读取和保存会话，并保留修复后重试、重启及去重断言。该用例连续三次定向复测通过，也通过了最终全量测试。另一次运行中，子代理默认配置用例因测试端口被占用而启动失败，随后定向和全量复测均通过。

专项差分使用固定的请求标识、临时任务以及合成插件。路径、动态 PID 和时刻在核对取值与状态变化后归一化。旧版 cron 文件的响应正文、ETag 和 Content-Length 直接比较。复跑时，两个参数须来自同一次构建。

```sh
node docs/rust-migration/differential/production-lists.js "$GATEWAY" "$FIXTURE_ADDON"
node docs/rust-migration/differential/production-entry.js "$GATEWAY" "$FIXTURE_ADDON"
node docs/rust-migration/differential/production-entry.js "$GATEWAY" "$FIXTURE_ADDON" --contracts
cargo test --locked --manifest-path native/Cargo.toml --workspace --no-fail-fast -- --test-threads=1
```

## 剩余接口与生产入口

| 排序 | 待迁内容 | 完成条件 |
|---|---|---|
| 1 | Aux 作业消费者及终端执行宿主 | 使用实际作业和终端连接验证活动、队列、历史计数与故障恢复。当前独立入口的 Aux 队列处于空闲状态。 |
| 2 | cron 写接口、定时调度和手工触发 | 真实触发、投递、失败通知和重启去重；本批验证规则列表与读取时的绑定迁移。 |
| 3 | 渠道投递和目标复核 | 用实际接收人验证投递、重试与告警通知；本批使用隔离插件复现进程状态和页面计数。 |
| 4 | 源码管理器及 launchd、desktop 和 standalone 的宿主启动、更新及重启 | 工作树、安装包和产物中移除宿主，隔离验证启停、端口迁移及重启恢复 |
| 5 | 其余写路由、会话执行、后台消费者及 WebSocket | 对每项验证鉴权、非空状态、真实副作用与恢复 |

静态依赖脚本重新盘点 `src/`，共 525 个 JS、2 个 CJS、3 个 MJS。其中 518 个可从 `server.js` 的导入链到达，另有 9 个是宿主脚本路径。其余 3 个分别为离线回测、工作区运维和未从已知入口到达的文件。另计根 `server.js`。这些数包含薄桥。根包和根镜像启动时均不加载这些文件；现行源码管理器及桌面、独立包仍有生产引用。[逐文件依赖](node-module-dependencies.md) · [剩余迁移清单](remaining-node-checklist.md)

复核生产包和现存宿主引用：

```sh
node docs/rust-migration/differential/production-package.js
node --expose-internals scripts/inventory-node-backend.js
rg -n -- '--node|serverEntry' multicc desktop/lib/desktop-env.js scripts/standalone-launcher.js
```
