# 生产入口切换验收（2026-11-24）

## Rust 后台任务与默认生产部署

本批原生源码指纹为 `26d7237cbdb9925abc8af9e8`。Aux 使用与 Provider 请求相同的 HTTP 客户端核对已配置的出口 IP，覆盖匹配、不匹配及探测失败，探测不携带 Provider 凭据。同 ID、同载荷复用结果，不同载荷返回 409。18 项验收命令均退出 0。在 macOS ARM64 上用同一 release 网关跑双入口对照、完整串行工作区和独立服务启动探针。Linux ARM64 镜像由根 Dockerfile 在一次性虚拟机内构建。所有运行测试均使用隔离的数据目录和本地模拟上游。

| 验收项 | 实测结果 |
|---|---|
| 1. 默认 Cargo release | 按锁文件构建成功，生产成员不含兼容 addon |
| 2. 工作区 release | 全工作区构建成功，兼容对照使用此次构建的 addon |
| 3. 格式 | `cargo fmt --all --check` 退出 0 |
| 4. Clippy | 全工作区、全部目标、`-D warnings` 退出 0 |
| 5. 生产包及依赖清单 | 源码分发 997 项，旧宿主文件 0，npm 生产包 0，正常 Cargo 依赖图中的 Node 绑定 0 |
| 6. 空 PATH 冒烟 | Rust 路由、健康和就绪均为 200；无令牌时按约返回 503，SIGTERM 退出 0 |
| 7. 从源码包部署并直接启动 | 解包、组装服务目录并启动网关，含静态页面、会话、cron、渠道在内的 8 项请求均为 200 |
| 8. 更新状态 | Git、独立包、桌面和相对数据目录四种布局，每种 8 个状态以及 HEAD、条件 GET 均一致 |
| 9. 保险箱列表 | 两种语言环境的正文、鉴权、HEAD、条件 GET、审计故障和重启读回均通过 |
| 10. 双入口 HTTP | 23/23 个状态一致，14/23 个正文逐字节一致 |
| 11. 带数据契约 | 两个入口各 20/20，持久化任务板与旧数据首次排名均一致 |
| 12. 宿主操作差分 | 40 条路由，96/96 个相同结果，2/2 个预期差异符合约定 |
| 13. 纯 Rust 切换探针 | 10/10 项的状态和公开错误码一致 |
| 14. Provider、Aux 配置及建 cron | 19/19，并通过中断绑定恢复检查 |
| 15. cron 月历与历史 | 11/11 |
| 16. 会话、渠道、cron 列表 | 13/13 |
| 17. 串行 Rust 工作区 | 85 个测试目标，2,854 项通过，失败 0，忽略 0 |
| 18. 完整 npm 开发与兼容回归 | 退出 0。Node 测试汇总 7,964 项，通过 7,957，失败 0，跳过 6，TODO 1，取消 0 |

**独立启动与故障恢复。** 对解包后的 macOS 服务归档执行下列探针。测试驱动位于服务目录外；网关进程的 PATH 为空，启动命令只有 `bin/multicc-gateway serve`。九个关键 GET 均为 200。脚本由真实定时器触发，在工作目录写入一行。手动脚本退出 7，另一条脚本超时返回已输出的正文；慢脚本运行期间独立规则正常触发。固定 agent 任务取得投递回执。

```sh
python3 docs/rust-migration/differential/production-workers.py /absolute/path/to/multicc-service
```

在指纹 `26d7237cbdb9925abc8af9e8` 的服务归档上，额外验证了 agent 已接收任务但 cron 尚未写回历史的情况。在隔离数据目录中保留任务存储，连续两次从同一条待确认的 cron 记录启动。两次完成记录均返回同一张非空回执。归档启动与恢复探针退出 0。另用两个网关打开同一数据目录，第二个因作业锁被占用而退出 1，第一个仍返回就绪 200。释放锁后重新启动，就绪返回 200。

源码管理器重启专项使用独立端口、临时 HOME 和数据目录。用真实网关替换旧测试使用的 Node PID 夹具后，确认原进程退出、替换进程回答 `/readyz`，且响应 PID 与新 PID 文件和源码工作目录一致。`tests/test-restart-supervisor-isolated.js` 共 20/20 通过。

本指纹的双入口 HTTP 对照中，23 项状态码全部一致，14 项正文逐字节一致。其余九项为 `/healthz`、`/readyz`、`/api/push/vapid-key`、`/api/settings/power`、`/metrics`、`/api/server-info`、`/api/directories`、`/api/sessions`、`/api/machines`。健康接口正文含实例运行时长。上述检查分别记录 HTTP 状态和正文相等性。

Aux 的 Messages、Chat Completions、Responses 请求在本地模拟上游核对正文。检查覆盖结果、429、Responses 错误和未收到完成帧的断流；进度摘要通过实际业务入口加入后台队列，模型回复与历史一致。探针在脚本已产生副作用、一个 Aux 请求已发出且另一请求仍在排队时强制终止网关。重新打开同一数据目录后，脚本中断入账、外部写入仍为一行；已发出的 Aux 请求保留中断错误，排队请求完成，同 ID 重查复用结果，已取消项未发出。模拟 CLI 仅用于确认 agent 回执，未调用真实模型账户。

**生产文件清点。** macOS 服务目录实数为 309 个文件，包括五个原生程序和 225 个浏览器 JavaScript 文件。后端 JS/CJS/MJS、Node/npm 程序、N-API 扩展、npm 依赖清单和 Node 运行依赖均为 **0**。Linux 镜像内检查程序和清单后直接启动入口，`/readyz` 返回 200。发布矩阵另含 macOS x64、Linux x64 和 Windows x64，本机只实测 macOS 与 Linux ARM64。旧式桌面管理包仍附带 Node；渠道投递等兼容宿主功能的边界见[部署清单](remaining-node-checklist.md)。

以下各节按批次保留之前的入口及回归结果。

## 创建定时任务、Provider 列表与 Aux 配置

原生源码指纹 `37eb361eb1e1ccfdc70ec5e7`。在 macOS ARM64 上分别启动默认的独立 Rust 网关和带 Node 的兼容网关。两端使用同次 release 构建、新建的用户目录和数据目录。切换探针由上一批的 7/10 提高到 **10/10**，下表十项的 HTTP 状态与公开错误码全部一致，命令退出 0。

| 方法 | 路径 | 兼容宿主 | 独立 Rust |
|---|---|---:|---:|
| GET | `/api/settings/notify` | 200 | 200 |
| POST | `/api/settings/notify` | 200 | 200 |
| POST | `/api/cron`，请求体为 `{}` | 400 | 400 |
| GET | `/api/cron/calendar?month=2026-11` | 200 | 200 |
| GET | `/api/providers` | 200 | 200 |
| GET | `/api/update/status` | 200 | 200 |
| GET | `/api/aux/config` | 200 | 200 |
| GET | `/api/secrets` | 200 | 200 |
| GET | `/api/directories` | 200 | 200 |
| GET | `/api/channels` | 200 | 200 |

| 专项检查 | 实测结果 |
|---|---|
| 创建定时任务 | 六种无效输入返回相同的 400 和错误正文。按目录路径创建停用的 agent 规则得到 200，固定任务使用已配置的默认 Provider。并发创建两条停用脚本后，规则文件含三个不同 ID。两端重启后，固定任务 ID、会话 ID 和三条规则均保留，运行次数均为 0。 |
| 创建中断与重试 | 在 Rust 的隔离任务板中注入不支持的版本，绑定失败返回 500，规则数保持三条。恢复任务板并重试原请求后，Rust 复用预留 ID，新增一条规则，清除临时记录。 |
| Provider 列表 | 全目录、Codex 池、Claude CLI 与未知 CLI 四种查询的公开正文逐字段一致。数据包含官方账号、模型别名、无凭据线路、自定义默认值、历史用量和过期限额。检查公开响应中不含完整的测试凭据。 |
| Aux 配置 | 旧 `cli: codex` 配置迁移并落盘为 `openai`、原 Provider 和去除首尾空格的模型，重启后读数一致。OpenAI 候选保留官方线路和使用 Chat Completions 的直连线路，排除缺密钥及指向本机的直连配置。两个读接口的 HEAD 和条件 GET 均通过。 |

新增双入口差分 **19/19**，另有一次 Rust 绑定失败恢复检查通过。补测从非本机地址匿名访问这三个接口，两边均返回 403。省略创建默认值时，两边均返回启用的 agent 规则，CLI 为 Claude、创建者为 user。该用例使用永不匹配的 2 月 31 日，运行次数为 0。首轮差分发现自定义默认 Provider 在新计划中被替换为官方线路，修订后两个入口均返回配置值。动态 ID、时刻和测试根目录分别核实后归一化。此次验证覆盖规则创建和目录读取。按时触发、手动运行、Aux 请求执行、远端 Provider 模型与限额的主动刷新仍需各自的运行时验收。

| 同一指纹的回归 | 结果 |
|---|---|
| 默认及全工作区 release、格式、全目标严格 Clippy | 四项退出码均为 0 |
| 打包、无 Node 启动、解包后实际执行 `npm start` | 包内列出五个 Rust 程序；8 个启动探针全部返回 200 |
| 常规 HTTP、预置数据契约 | 23/23 个状态码一致，15/23 个正文逐字节一致。两端各 20/20 项契约通过 |
| 月历和列表专项 | 月历 11/11，列表 13/13 |
| 更新状态、保险箱、宿主操作 | 更新状态 32/32，保险箱两种语言通过，宿主操作 96/96，2/2 项预期差异符合约定 |
| 完整串行 Rust 工作区 | 退出 0，85 个测试目标，2,853 项通过、0 失败、0 忽略 |
| 完整 `npm test` | 退出 0。Node 测试汇总 7,957 项通过、0 失败、6 跳过、1 个 TODO、0 取消 |

同一指纹的 18 项验收命令均退出 0。Node.js 为 26.8.1，Rust 为 1.98.0。npm 的六项跳过包括真实 Claude 会话轨迹缺失、三个实验性 SQLite owner 用例标为跳过、桌面打包工具链缺失和本机未安装 PowerShell。一个 TODO 是重复回答场景下的 nudge 重试去重。以上计数来自本批完整日志。

复查时设置 `GATEWAY` 和 `FIXTURE_ADDON` 指向同一构建的程序和兼容模块。

```sh
node docs/rust-migration/differential/production-entry.js "$GATEWAY" "$FIXTURE_ADDON" --cutover
node docs/rust-migration/differential/production-catalog-cron.js "$GATEWAY" "$FIXTURE_ADDON"
cargo test --locked --manifest-path native/Cargo.toml --workspace --no-fail-fast -- --test-threads=1
npm test
```

## 前一批的更新状态与保险箱列表

在 macOS ARM64 上用独立临时目录运行带 Node 的兼容网关与独立 Rust 网关。两端使用合成更新日志、测试保险箱和环回监听。切换探针结果如下。

| 生产请求 | 兼容宿主 | 此前独立网关 | 本批独立网关 |
|---|---:|---:|---:|
| 读取更新状态、读取保险箱元数据 | 200 | 503 | 200 |
| 通知设置读写、定时月历、目录及渠道列表 | 200 | 200 | 200 |
| 空 JSON 创建定时任务 | 400 | 503 | 503 |
| Provider 列表、Aux 配置 | 200 | 503 | 503 |

更新状态从持久日志恢复步骤、进度和退出码。兼容宿主持有发起更新到子进程启动之间的短暂状态，继续处理本模式的读取。该 Node 桥只对响应执行 JSON 序列化，保留 UTF-16 截断产生的代理码元。旧桥遇到这种合法 JSON 会返回 503。两种模式共用启动器后，可以移除这层转发。

原生指纹 `77689a17610cc1f91c372fb7` 通过默认和全工作区 release 构建、格式检查及严格 Clippy。三种布局各通过 8 组日志状态、HEAD 和条件 GET。解包后实际执行 `npm start`，8 个探针全部返回 200。23 个常规请求状态码全部一致，其中 15 个正文逐字节一致。带数据检查两端各通过 20 项，旧会话迁移后搜索排名一致。兼容宿主操作差分 96/96，另有 2/2 个预期差异。另测带 `..` 的相对数据目录时发现旧宿主返回规范化路径，该指纹保留了父目录段。后续修订按 Node 的路径解析规则生成日志路径，并将该布局纳入专项测试。

保险箱列表复用 Rust 审计模块，读取旧条目时只保留面板使用的元数据。英文和捷克文排序分别与真实宿主的响应字节、ETag 一致。差分覆盖未登录拒绝、带令牌读取、HEAD、304、每次访问的一对审计行、审计不可写时的 503，以及重启后加载损坏文件时的空列表。保险箱写入、查看值和子进程环境仍归兼容宿主管理。

修正相对路径后的原生指纹为 `27f581a4f8097854b53c648b`。四种部署配置各 8 组更新日志状态通过，合计 32/32。保险箱两种语言的全部检查、40 条宿主操作路由的 96/96 个用例及 2/2 个预期差异均通过。默认和全工作区 release、格式及严格 Clippy 均退出 0。常规 HTTP 状态码 23/23 一致，正文 15/23 逐字节一致，两端各通过 20 项带数据检查。实际解包启动的 8 个探针全部返回 200，985 项根包文件中后端宿主文件、生产 npm 依赖和默认构建中的 Node 原生依赖均为 0。

切换探针仍以退出码 1 结束。对创建定时任务另做了有效输入检查：用已登记的隔离目录创建一条停用规则，兼容宿主返回 200，规则出现在列表中，已绑定固定任务且运行次数为 0。独立网关返回 503，规则未落盘。本轮操作使用临时数据目录。

根源码包的默认入口直接运行 Rust 网关。源码管理器、launchd、桌面和独立包继续通过 `--node` 启动 `server.js`。从当前源码重建的 JS 依赖清单与此前逐文件记录相同，`src/` 有 530 个 JS/CJS/MJS 文件，另有根宿主。上一批 macOS ARM64 实装中，桌面和独立包均含 17 个必需、1 个可选生产依赖和 331 个实际安装位置。[逐文件清单](node-module-dependencies.md) · [安装包实测](packaged-backend-darwin-arm64.md)

复查命令使用同一次构建的网关和兼容模块。

```sh
node docs/rust-migration/differential/production-update-status.js "$GATEWAY" "$FIXTURE_ADDON"
node docs/rust-migration/differential/production-vault-list.js "$GATEWAY" "$FIXTURE_ADDON"
node docs/rust-migration/differential/production-entry.js "$GATEWAY" "$FIXTURE_ADDON" --cutover
```

原生指纹 `27f581a4f8097854b53c648b` 的完整串行 Rust 工作区已退出 0，85 个测试目标共 2,853 项通过、0 失败、0 忽略。

## 独立包启动与定时任务月历

后续提交 `4d033ffe` 通过默认和全工作区 release 构建。实际解包后运行 `npm start`，就绪、聊天页、通知设置、cron、渠道和会话六个探针均返回 200。桌面外壳、独立包和安装器的三组测试合计 108 项，106 项通过、0 失败、2 项跳过。跳过项分别需要当前测试环境缺少的 electron-builder 工具链和 PowerShell（`pwsh`）。整批退出码为 0。

运行代码提交 `c2d12c57`，原生源码指纹 `013b4fc5695e878c2fb21a66`。默认 Cargo 和完整工作区均以 release 构建通过，格式检查和全工作区严格 Clippy 通过。独立网关的 23 个 GET 状态码与兼容宿主全部相同，14 个响应正文字节一致；两端各通过 20 项带数据行为检查，列表差分 13 组一致。

该批后台日志随后写入完整结果。串行 Rust 工作区的 85 个目标合计 2,853 项通过、0 失败。完整 `npm test` 退出 0，Node 汇总 7,957 项通过、6 项跳过、1 项 TODO。冷构建后的首次启动没有配置访问令牌，就绪探针返回 200，聊天页返回 503。隔离对照补入部署令牌后，聊天页、cron 列表、月历、渠道和会话五项均从 503 恢复为 200。

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

提交 `9051572e` 的整批命令退出 1。16 个步骤中 13 个通过，串行 Rust 测试在 85 个目标上合计 2,853 项通过。失败的三步分别是严格 Clippy（`daemon.rs` 中多余的路径借用）、完整 npm（配额设置文件实际权限为 0600，测试曾固定要求 0644）和切换探针（4/10 一致）。后续 Clippy 通过，权限用例在 umask 022 和 077 下分别通过，`c2d12c57` 批次的完整 npm 退出 0。切换探针的最新结果见本文开头。

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
| 2 | cron 修改、删除、定时调度和手工触发 | 验证触发、投递、失败通知和重启去重。规则创建、绑定、列表和重启回读见本文首节。 |
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
