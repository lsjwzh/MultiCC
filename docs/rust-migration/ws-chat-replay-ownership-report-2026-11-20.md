# /ws/chat 重放缓冲与连接集合迁出 Node：最终报告（2026-11-20）

## 结论

重放缓冲写入侧与 `cs.clients` 连接注册的所有权已从 Node 迁入 addon 的 `RustWsHost`，
差分与变异基线已建立，6 个提交已经 `--no-ff` 合入 main（合并提交 `dc101960`，
双亲 `3c4774f1` 与 `745c7c4b`，工作树 `0 0` 且干净）。

「只启动 Rust 服务、删除 Node」没有按字面做完，原因有数据：Node 仍注册 128 条
HTTP 路由，`/ws/chat` 升级终结、鉴权、会话历史与回合编排仍在 Node。把生产入口切到
`--no-node` 会让这些路由和 `/ws/chat` 全部回 503 `node_runtime_absent`，把 Node 源码、
`package.json`、`node_modules` 删掉则产品无法启动。本次实际做到的，以及保留的每一类
Node 文件与理由，见「保留的 Node」一节。

## 迁移说明

| 提交 | 内容 |
|---|---|
| `dac4477a` | 真实事件基线：真网关 + 真 Node 服务 + 模拟 CLI，5 个场景（重放、620 帧淘汰到 500、回合边界清空、取消保留、崩溃恢复），零生产补丁；冻结 Node 写入侧为 oracle，生成 corpus |
| `22f4e86c` | Rust 内核 `chat_replay_buffer`：每会话 500 帧 FIFO、有序去重的客户端集合、跨会话移除；corpus 逐操作对拍 |
| `47519f79` | 修复 `quota_routes` 夹具「探测空闲端口再释放」的竞态（并发运行时 `EADDRINUSE`） |
| `6b736d14` | 前门 `ws_chat_hub`：注册、取快照、投递在同一同步段内；仅挂在测试探针 `hub=1` 后，生产流量不经过 |
| `adbd13d9` | addon 宿主接管缓冲与成员；Node 侧 `cs.clients` 变为只读 `size` 门面，缓冲读写全部走注入的 replay 端口 |
| `745c7c4b` | 阶段文档 |

关键语义：帧在推入时按 `JSON.stringify(createWsEnvelope(event))` 编码存储，重连突发直接发送存储串，
与旧实现「突发时再编码」逐字节相同；突发走绕过消息计数闸的发送路径；扇出按成员插入顺序、
跳过非 OPEN、吞掉单个 socket 的发送异常。缺少 replay 端口时抛 `TypeError`，不退回 JS 缓冲，
避免出现第二个无人观测的所有者。

仍在 Node：`/ws/chat` 的升级终结、鉴权与 share 校验、会话历史、回合编排。前门 `ws_chat_hub`
尚未接入生产路径。

## 启动说明

- 前台：`npm start` → `scripts/start-gateway.js` → `multicc-gateway serve --node <node> --stdin-lifeline server.js`。
  网关占公开端口，Node 作为被看护的子进程只监听回环端口。
- 常驻（macOS/Linux）：`./multicc start` 同样以网关为父进程，并保持这个形态。
- pm2：`ecosystem.config.js` 现在启动 `scripts/start-gateway.js`，不再裸跑 `server.js`
  （见下节「已改的启动定义」）。`kill_timeout` 仍为 75 秒，由 `tests/test-shutdown-http-errors.js` 校验。
- 无 Node 容器：`docker/task-shell/Dockerfile` 的 `node-free-runtime` 阶段只含网关与 writer 两个可执行文件，
  以 `serve --no-node` 运行，镜像构建时自带冒烟脚本。能服务的只有已迁入前门且不需要 Node 持有事实的路由。
- 重启：只能由用户手动触发，本次合入后需要手动重启才会加载新接线。

## 已改的启动定义

逐项检查了所有启动入口。只有一处会让 Node 绕过前门直接占公开端口：`ecosystem.config.js`
（pm2，`script: 'server.js'`）。裸 `server.js` 不含已迁入前门的路由，是一条静默降级的回退路径。
现改为 `scripts/start-gateway.js`，并在 `tests/test-shutdown-http-errors.js` 加两条断言
（脚本必须是该启动器、启动器文件存在）。变异验证：把 `script` 改回 `server.js`，该测试 25 通过 / 1 失败；
恢复后 26/0。

其余入口原本就经前门：`npm start`、`./multicc`、独立包启动器、`docker/command-code/start.js`
（该文件注释写明缺二进制时立刻失败，不退回裸 Node）。`install.sh` 里出现 `server.js` 的位置是
解析旧版服务单元以便升级，不是启动命令。

## 测试报告

全部在 rebase 后的头（`745c7c4b`，main 未移动所以 rebase 为空操作）与源码指纹 `137977bafca68ddee2896add`
的 release 产物上串行运行，端口敏感的段落互不并发。

| 门禁 | 结果 |
|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | 零告警 |
| `cargo test --workspace --no-fail-fast` | 78 个目标、2563 项通过、0 失败 |
| `npm run test:security` | 1188 项：1187 通过、0 失败、1 todo；含 `ws-host differential` 37/0、`chat-replay-hub` 15/15 |
| `npm run test:core` | 主汇总 2635 项：2632 通过、0 失败、3 跳过；各子段 0 失败 |
| `npm run test:governance` | 通过 |
| `npm run test:state` | 通过（129、13、96 三个子集均 0 失败） |
| 聊天隔离五套件 | `replay-wiring-capture`、`turn-isolated`、`events-isolated`、`finalize-isolated`、`adapter-events-isolated` 均退出 0 |
| 变异集：内核 | 基线通过，容量、淘汰方向、重复注册、移除、清空 5/5 被捕获 |
| 变异集：前门协调器 | 基线通过，去缓冲写入、临时事件入缓冲、跳过注册、丢快照、跳过断开清理 5/5 被捕获 |
| 变异集：addon 宿主 | 基线通过，跳过 OPEN 检查、扇出倒序、突发走受限发送、断开后仍留成员、销毁不终止、reset 空转 6/6 被捕获 |

**rustfmt 未全绿。** 字面上的 `rustfmt --edition 2021 --check`（对本批改动的 10 个 `.rs` 文件）
在 main 与本分支上都退出 1：对 `lib.rs` 检查会遍历整个 crate，撞上 7 个文件里既有的格式欠账。
同一调用对拍：分支 265 行差异、main 283 行，分支独有的新差异为空（少的 18 行来自 `lib.rs` 模块序修复）。
我没有借这次合入重排这些无关文件。

**fleet-sharing 的红是档位敏感的既有失败，不是回归。** debug 产物下 `test-fleet-sharing-routes.js`
稳定 6 项失败：本分支与干净 main（`3c4774f1`）逐条同名复现；同源 release 产物下 20/20。
本次最终门禁用 release 产物，core 段因此全绿。此前记录的「两项」口径偏小。成因指向未优化构建下的口令散列与
并发预算期限，具体是哪一项尚未单独测量；下次在 debug 产物上门禁时仍需先用 release 复核同一文件。

**一次冷编译导致的红已查明。** 改动 `.rs` 后源码指纹变化，首轮安全段会在运行中现编整套 release 产物，
把远控 e2e 挤到 609 秒超时并泄漏监听、钉住整段。本次最终门禁先单独预热产物再串行跑，没有复现。

## 无 Node 进程/端口验证记录

源码指纹 `137977bafca68ddee2896add` 的 release 网关（sha256
`cab9dfa402a9131716b02711678f25a6869114cf71f001b5fc7490cbe0de8a7a`），隔离 `HOME` 与数据根，
`multicc-gateway serve --cwd <仓库> --no-node --ephemeral-loopback`：

- 单进程：PID 11704，`pgrep -P` 无直接子进程，进程树中没有 node。
- 端口：`lsof` 只列出该网关监听 `127.0.0.1:50750`。
- `/healthz` 200；日志写明 `node runtime disabled (--no-node): routes not owned by Rust answer 503 node_runtime_absent`。
- `/ws/machines/demo` 升级由 Rust 终结：`101 Switching Protocols`，`sec-websocket-accept` 正确。本次只采到握手。
- `/ws/chat?session=demo` 升级回 `503`：该路径尚未迁移，是诚实失败，不是降级可用。
- `SIGTERM` 后退出码 0，日志 `no node to stop`，端口释放（再连 curl exit 7），无残留进程。
- 镜像自带的 `scripts/smoke-no-node-gateway.sh` 对同一二进制 PASS：隔离 PATH 内无 node，Rust 路由 200，
  `/healthz` 与 `/readyz` 200，Node 持有的路由 503 `node_runtime_absent`，SIGTERM 退出 0。
  容器镜像本身没有在本机构建，这一项只覆盖二进制，不覆盖镜像构建。

这些是隔离运行的证据，端口与 PID 不是固定配置。它不能证明所有 `/ws/*` 或完整产品可以在无 Node 下提供服务。

## 保留的 Node

没有删除任何 Node 源码、`package.json` 或 `node_modules`。删除的前提是「不再需要」，而下列都还在被需要。

**128 条仍由 Node 注册的 HTTP 路由**（2026-11-19 隔离捕获口径，不含 WebSocket，不是实时生产计数）：

| 类别 | 条数 | 留 Node 的原因 |
|---|---:|---|
| 回环宿主端口 | 35 | 已迁前门的公开路由仍经 `/api/__host/*` 查询或执行 Node 持有的事实与副作用 |
| 消息平台与 cron 插件 | 71 | 平台 SDK、连接与插件生命周期（WeChat 15、Feishu/Telegram/Discord/Slack 各 12、cron 8） |
| CLI 工具 | 6 | 作业规则在 Rust，启动子进程、终止与探测仍由 Node 宿主执行 |
| 插件管理 | 8 | 安装器、目录与通道宿主持有 Node 对象 |
| OAuth 登录 | 2 | 持有较长时间运行的登录子进程 |
| 会话打包 | 2 | 流式归档与导入依赖 Node 会话状态 |
| provider 代理 | 2 | attempt 能力校验与观测钩子依赖 Node 运行态 |
| 工具与语音 | 2 | 依赖回环工具宿主与音频上传/ASR 运行态 |

另外 `/ws/chat`、`/ws/voice`、`/ws/tts`、`/ws/workspace`、`/ws/meta`、`/ws/aux`、`/ws/remote-screen`
与终端升级入口仍经 Node；`/ws/machines/<id>` 已由前门终结。

**足迹**：`src/` 598 个 JS 文件、`server.js` 3082 行；`src/` 里有 47 个文件调用 `spawn`/`execFile`。

**运行时依赖（19 个）与引用点**——每一项都有真实调用，不是遗留：

| 依赖 | 用途（引用点） |
|---|---|
| `@larksuiteoapi/node-sdk`、`@slack/bolt`、`discord.js`、`node-telegram-bot-api` | 各 1 个 bridge 文件，对应消息平台路由 |
| `express`（13 个文件）、`ws`（16 个文件）、`multer` | Node 路由与 WebSocket 传输、上传中间件 |
| `@anthropic-ai/claude-agent-sdk` | 其包不再被执行，保留是因为它按平台携带 chat 车道实际运行的 `claude` 可执行文件（`src/cli/claude-bundled-binary.js`） |
| `@agentclientprotocol/sdk` | ACP 语音桥（`src/voice/multicc-acp-agent.mjs`） |
| `cli-provider-router`、`@iarna/toml` | provider 路由与配置读写（`src/providers/`） |
| `proxy-agent`、`undici` | 出站网络与账号专用出口 |
| `web-push`、`node-cron`、`chokidar` | 推送、定时任务、文件监听（`server.js` 与 `src/push`） |
| `sherpa-onnx-node`、`pinyin-pro` | 本地语音识别与热词纠正 |
| `@homebridge/ciao` | 局域网发现 |

**启动脚本**：`scripts/start-gateway.js`（`npm start` 与 pm2 的入口）、`./multicc`（常驻管理）、
`docker/command-code/start.js`（该容器要运行完整服务，所以带 Node，但经前门起）、`install.sh`/`install.ps1`
（安装器）都保留，因为它们启动的就是「网关 + 被看护的 Node」这个仍必需的形态。

**仅开发用、不随运行时分发**（保留，用于差分与门禁）：`tests/`（963 个文件，含冻结的 oracle，
如 `tests/helpers/legacy-chat-replay-buffer.js`）、`scripts/`（116 个）、`docs/rust-migration/differential/`
（捕获脚本、corpus、变异脚本）。删除它们会让「基线通过、变异必红」的证据无法复现。

## 阶段更新：前门终结 `/ws/chat` 客户端 socket（2026-11-20）

在重放缓冲与连接集合迁出之后，本阶段把 `/ws/chat` 的升级握手和客户端 socket 的所有权移进前门进程，
聊天引擎经一条私有、互证能力令牌的回环通道把每个客户端看成虚拟 socket。完整协议、语义对齐清单、
测试明细与边界见 `ws-chat-front-door-stage-2026-11-20.md`，部署层说明见 `docs/gateway.md` §65。

| 项目 | 状态 | 证据 |
|---|---|---|
| 前门握手并持有客户端 socket（帧传输、控制帧、关闭握手、异常断开） | 已完成 | `native/gateway/tests/ws_chat.rs` 15 项，真前门加真 Node 通道客户端 |
| 前门到 Node 的聊天通道（帧语法、互证握手、有界队列、按代重建） | 已完成 | core 7 项语料钉住；`tests/test-gateway-chat-bridge.js` 23 项；`test-gateway-child.js` 15 项 |
| 客户端可见契约不变 | 已完成 | 冻结的 19 个场景逐场景一致；去掉通道接线后变红 |
| 变异证明 | 已完成 | 本阶段 9 个自写变异全部抓出；既有 ws-handshake 3 个、ws-machines 5 个、chat-ws-conformance 5 个，基线通过且全部抓出 |
| 全量门禁 | 通过 | governance、state、core、security、`test:integration:isolated` 退出码 0；`cargo test --workspace` 2591/0；workspace clippy `-D warnings` 通过 |
| 准入与鉴权、会话历史、回合编排迁成 Rust 所有者 | **未做** | 仍在 Node；前门只终结 socket，不回答这些事实 |
| 重放缓冲写侧与 `cs.clients` 搬到前门进程 | **未做** | 仍在 addon 内的 `RustWsHost`；依赖上一行的事实先有 Rust 所有者 |
| `--no-node` 下 `/ws/chat` 真实可用 | **未达成** | 仍立即答 `503 node_runtime_absent`，`no_node.rs` 守卫未变 |
| 切 `--no-node`、删除 Node 源码、`package.json`、`node_modules` | **未做** | 前提是 128 条路由全部对齐，目前不成立 |

## 阶段更新：`/ws/chat` 准入与鉴权迁成 Rust 所有者（2026-11-20）

在前门终结 socket 之后，本阶段把每条 WebSocket 连接的准入判定从 `src/ws/connection-router.js`
的内联块搬进 `multicc_core::ws_admission`。完整有序闸门序列、事实采集边界、测试与变异明细、
以及踩到的变异脚本坑，见 `ws-chat-admission-stage-2026-11-20.md`。

| 项目 | 状态 | 证据 |
|---|---|---|
| 准入与鉴权判定成为 Rust 所有者（九道闸门的顺序、计数器、遗留警告、socket 标注、发送队列安装位） | 已完成 | 内核 5 项；1080 例语料逐例一致 |
| 一次性票据不被投机消耗 | 已完成 | `needs_ticket` 与 `plan` 同一条分享规则；两项内核不变量测试 + 接线差分逐例核对消耗次数 |
| 分享表只为带 `share` 参数的 chat socket 查 | 已完成 | `needs_share_record`；既有 `test-ws-connection-router.js` 的该契约仍绿（22/22） |
| 接线逐例差分 | 已完成 | `tests/test-ws-admission-differential.js` 用真路由驱动 800 例；另 280 例是 URL 表达不出的 id 组合，由内核语料覆盖 |
| 变异证明 | 见下方门禁小节 | `ws-admission-mutations.py` 27 个变异 |
| 会话历史迁成 Rust 所有者 | **未做** | 仍在 Node；不依赖回合编排，是建议的下一刀 |
| 回合编排迁成 Rust 所有者 | **未做** | `src/chat/` + `src/session-work/` 共 16,996 行；Claude SDK 车道依赖 Node 包 `@anthropic-ai/claude-agent-sdk` 0.3.325，无 Rust 等价物 |
| 重放缓冲写侧与 `cs.clients` 搬到前门进程 | **未做** | 已在 addon 的 `RustWsHost`，但写入方仍是 Node 的 turn engine |
| `--no-node` 下 `/ws/chat` 真实可用 | **未达成** | `forward.rs` 的 `node_absent()` 分支未改，仍答 `503 node_runtime_absent` |
| 切 `--no-node`、删除 Node 源码与依赖 | **未做** | 前提不成立 |

## 下一步

1. 升级终结与准入鉴权都已是 Rust 所有者（见上两节）。剩下的是会话历史与回合编排：按依赖顺序先做会话历史读取（连接后 `chat_history` / `task_state` 两帧的来源，不依赖回合编排），再做回合编排本身，而那一步必须先决定 Claude SDK 车道怎么办——它依赖一个 Node 包。只有这两项都有 Rust 所有者，`ws_chat_hub` 才能脱离测试探针，`--no-node` 下 `/ws/chat` 才不再 503。
2. 按上表逐类迁出 128 条路由与其余 `/ws/*`。每迁一类，同提交删除对应 Node 实现并补逐字节差分。
3. 单独治理「改 `.rs` 后首轮安全段冷编译」的门禁行为，并清理 7 个文件的 rustfmt 既有欠账。
4. 用户手动重启后，在真实数据根上验收 `/ws/chat` 重连重放。本次所有证据都在隔离数据根上，没有触碰运行中的生产实例。
