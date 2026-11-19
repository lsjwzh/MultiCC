# 聊天重放缓冲与连接集合：进行中

本记录描述迁移中间结果。生产 `/ws/chat` 的**重放缓冲与客户端成员集合已迁入
原生 `RustWsHost`**（见「生产接线」一节）；但 `/ws/chat` 的**升级终结**、鉴权、
会话历史与回合编排仍在 Node，前门协调器 `ws_chat_hub` 仍只接在测试探针上。
因此不能据此关闭 Node 或更改默认入口。

## 基线

`differential/capture-replay-buffer.js` 在隔离数据根中运行真实网关、Node 服务和
模拟 Claude CLI，观察重连时收到的事件。采集到：流式重连 3 帧；620 帧突发后保留
末尾 500 帧；新回合重连 3 帧；取消后 0 帧；API 受控重试后 1 帧；后台任务完成后
0 帧；服务崩溃重启后 0 帧。取消场景发送
真实协议的 `cancel`，并确认对应 CLI 进程收到终止信号及连接收到回合结束事件。
之前的采集发送了未被处理的 `stop`，其取消结果已作废。

崩溃场景的旧结果已作废：旧脚本只杀掉网关并在等待 Node 子进程超时后继续。
修复后的脚本终结隔离服务进程树、确认 Node 退出，再在同一数据根重启并采集。

采集结果存于 `differential/chat-replay-buffer-golden.json`。采集器在 TCP 连接
读取并保存完整服务端帧（包含帧头），并校验其解码结果与 WebSocket 客户端实际
收到的消息一致；采集期间关闭压缩。采到的重试是
Claude 流中断后的受控 API 重试，不是其他车道的 fresh retry。
采集时源码基线为 `3c4774f1`，负载文件 SHA-256 为
`36babdf8b74b78999fb15b0753a8540374120a93e2d2e871961c06dba4ec1ae1`。
`tests/helpers/legacy-chat-replay-buffer.js` 是对旧代码相关语句的
冻结转录，SHA-256 为 `22fe19c5085113efadbd59678cac6c50f31fe21c22e8523b346dd47fe62bd9fa`；
它不是完整的旧版服务。生成器从该转录产生 1999 组队列和连接集合操作，并以七个
真实采集场景的重放数量核对派生程序。

其中跨多个会话的 `detach` 是合成的防御性情形：实际旧版关闭回调只从该连接
所属会话移除 socket，不能把合成的多会话注册当作生产流量证据。

## 实现边界

`native/core/src/chat_replay_buffer.rs` 实现了每会话 500 项 FIFO 缓冲、清空、
有序且去重的客户端集合和跨会话移除。差分测试比较冻结语料中操作结束后的缓冲与
集合，以及从集合派生出的发送尝试顺序；它不运行真实 socket 的发送、失败处理或
Rust 网关。真实负载的额外测试检查消息字节经内核缓冲后保持不变。
`native/gateway/tests/chat_wire_frames.rs` 另将 1367 个真实 Node 数据帧与 Rust
WebSocket 编码器的输出逐字节比较；这是编码器验证，并未运行 Rust 聊天宿主。
基线通过，容量、淘汰方向、重复注册、移除、清空五种独立源码变异均被检测到。
本批 Rust 内核的两项定向测试和 `multicc-core --all-targets` Clippy（`-D warnings`）通过。
真实网关和隔离数据根上的 `test-chat-turn-isolated.js`、`test-chat-events-isolated.js`
均通过；源码行数预算检查通过。这些不是全工作区或完整迁移验收结果。

内核与 addon 宿主的职责是分开验证的：addon 直接 `use chat_replay_buffer::Sessions`，
没有第二份 FIFO/成员实现，所以差分过的内核就是生产里跑的那一份；宿主层的 OPEN 过滤、
顺序扇出、突发绕过消息计数闸门、断开清理与销毁终止由
`differential/chat-host-mutations.py` 单独覆盖（在隔离副本里重建 addon 并跑
`tests/test-chat-replay-hub.js`，基线通过，六种变异全部被捕获：跳过 OPEN 检查、
扇出倒序、突发改用受限发送、断开后仍留在成员表、销毁不终止 socket、reset 空转）。

`native/gateway/src/ws_chat_hub.rs` 在同一同步边界内注册连接、取得重放快照并
投递后续事件；定向测试覆盖并发连接与事件无缺口、隔离、溢出及 500 帧重放不占
实时消息队列。仅在 `MULTICC_GATEWAY_TEST_ROUTES=1` 的探针中接入了这一协调器；
真实网关探针的票据消费、重连重放、后续事件和跨会话隔离测试通过。探针不实现
生产聊天的鉴权、会话历史、回合编排，也未证明生产重放的字节/拥塞上限兼容。
`differential/ws-chat-hub-mutations.py` 的基线通过；去掉缓冲写入、错误缓冲临时
事件、跳过注册、丢失快照、跳过断开清理五种真实协调器源码变异均被定向测试捕获。
既有 `ws-probe-mutations.py` 基线及四种变异也通过复核。

工作区全量测试首轮在 `quota_routes` 两项遇到 `EADDRINUSE`：夹具先探测并释放端口，
网关随后绑定时可能被并发进程抢占。改为网关直接绑定系统分配的回环端口后，该套
15/15 通过。接线后的最终门禁见「2026-11-20 最终门禁」一节。

## 生产接线（已落地）

进程内所有权已经转移：聊天状态不再持有 `streamReplay` 数组，`cs.clients` 只剩
一个只读 `size` 门面（写入会抛，防止悄悄分叉成两份成员表）。权威状态在 addon 的
`RustWsHost` 里，与连接注册表、心跳和发送队列同属一个所有者；
`src/chat/replay-hub.js` 只做编码与转发，自己不持有数组、Set 或计数器。
帧在推入时就按 `JSON.stringify(createWsEnvelope(event))` 编码存储，与被替换的
「突发时再编码」逐字节相同（缓冲事件在推入后不再被改写）。

| 迁移点 | 旧写法 | 现写法 |
|---|---|---|
| 流式事件入缓冲 | `cs.streamReplay.push` + 超 500 `shift` | `replay.push(sessionId, evt)` |
| 回合准入 / fresh retry / 重连丢弃进行中助手 | `cs.streamReplay = []` | `replay.clear(sessionId)` |
| API 受控重试 | `cs.streamReplay = []` | `replay.clear(sessionId)` |
| 重启重生 / 取消 / 换 CLI 重置 | `cs.streamReplay = []` | `replay.clear(sessionId)` |
| provider 日志守卫两处 | `Array.isArray` 保护下的 push | `replay.push`（保留 try 包裹） |
| 重连突发 | JS 遍历数组 + `bp.sendImmediate` | `replay.burst(connId, sessionId)` 原生逐帧发送 |
| 进度归约读缓冲 | `cs.streamReplay` | `replay.events(sessionId)`（解码副本） |
| 客户端注册 | `cs.clients.add(ws)` / `delete(ws)` | `replay.join/leave(sessionId, connId)` |
| 会话广播 | `emitClients(state.clients, evt)` → `broadcastTo` | `emitSession(sessionId, evt)` → 原生有序扇出 |
| 删除会话 | 遍历 `chat.clients` 逐个 `terminate()` | `replay.drop(sessionId)` |
| 关机清理 | `cs.clients.clear()` | `replay.clearClients(name)` |
| 会话表删除/清空 | 无 | `chatSessions.onForget` 观察者同步丢弃缓冲与成员 |

连接 id 的接法：`src/ws/connection-router.js` 在 `wsHost.attach` 之后把 `connId`
以不可枚举属性挂在 socket 上，聊天处理器据此 join，关闭回调据此 leave；路由器与
重放门面共用同一个 `RustWsHost` 实例（由组合根建好后注入，自行挂载时才私建）。
新增端口 `connPort(id)` 让原生扇出与突发直接寻址某条连接的 `sendFrame` 视图，
Node 侧不再把 socket 交给原生层。

依赖是硬要求而非可选项：回合引擎、api-error host、provider 日志守卫、
session-lifecycle、host-lifecycle、换 CLI 运行时在缺少 hub 时直接抛 TypeError，
避免「静默回退到 Node 行为」这种看不见的双轨。

验证（当前树，addon 与网关按当前源码新建，指纹 `a4aaf99bb13d80b4e21d6905`）：
`tests/test-chat-replay-hub.js` 15/15（随安全段同轮）；隔离集成
`test-chat-replay-wiring-capture.js`、`test-chat-turn-isolated.js`、
`test-chat-events-isolated.js`、`test-chat-finalize-isolated.js`、
`test-chat-adapter-events-isolated.js` 五项逐个退出码 0。其中 wiring-capture 用真实
网关、真实 Node 服务和模拟 CLI 重跑整套采集，再与冻结黄金档比对重放文本、顺序、
帧形状与突发连续性；它不改写黄金档（输出指向临时文件）。

## 2026-11-20 最终门禁（接线后、同一构建）

全部在指纹 `a4aaf99bb13d80b4e21d6905` 的产物上运行，端口敏感的段落互不并发：

| 门禁 | 结果 |
|---|---|
| `rustfmt --edition 2021 --check`（本批文件） | 通过。本批新代码曾有两处偏差（`ws_host.rs` 多参调用换行、`core/src/lib.rs` 模块声明顺序）已修 |
| `cargo clippy --locked --offline --workspace --all-targets -- -D warnings` | 零告警 |
| `cargo test --locked --offline --workspace --no-fail-fast` | 78 个目标、2563 项、0 失败 |
| `npm run test:security` | 1188 项中 1187 通过、0 失败、1 todo；含 `ws-backpressure` 与 `ws-host differential` 37/0 |
| `npm run test:core` | 2635 项中 2626 通过，6 失败全在 `test-fleet-sharing-routes.js`（见下节，既有且档位敏感） |
| `npm run test:governance` | 通过。首轮因 `test-tiers.json` 两条新登记未按字典序插入判红，已修正并复验：927 条分类、core 466 / 确定性 387 / 隔离 48，与发布棘轮数字一致 |
| `npm run test:state` | 0 失败（补跑：`src/host-lifecycle.js` 的归属段是 state，不在要求的三段里） |
| 变异集 `chat-replay-buffer-mutations.py` | 基线通过，容量、淘汰方向、重复注册、移除、清空 5/5 被捕获 |
| 变异集 `chat-host-mutations.py` | 基线通过，6/6 被捕获（跳过 OPEN 检查、扇出倒序、突发改受限发送、断开仍留成员、销毁不终止、reset 空转） |
| 变异集 `ws-chat-hub-mutations.py` | 基线通过，5/5 被捕获 |

安全段第一轮曾有 1 失败 + 1 取消，都在 `test-remote-screen-e2e-harness.js`：本批改了
`.rs`，指纹变化使门禁在运行中按需现编整套 release 产物（`data/rust-source/a4aaf99b…`
下 5 个二进制的时间戳即该窗口），首个远控用例撞上这段编译跑满 609 秒超时，随后两个
远控用例在产物就绪后 14 秒、12 秒通过。该用例失败后未关闭自己的监听，把整段
`node --test` 钉住，需要定向终止它拉起的进程树。产物就绪后整段重跑为 1187/0。
这条红的成因是构建缓存冷启动，不是接线回归；但「首轮必须冷编译」这一点会让任何
改了 `.rs` 的批次在安全段首轮都可能出现同样现象，值得单独治理。

## 前门终结 `/ws/chat` 还差什么

以下交接与上面的进程内迁移无关，是把**升级终结**搬进前门还需要解决的：

1. `/ws/chat` 的 share token、cookie/legacy token、loopback、机器授权撤销、fleet
   session scope 和单次票据有既定顺序；票据只能在一个所有者处消费一次。现有
   `ConsumeTicket` 不能代替 share 验证和剩余访问检查。
2. `chatSessions` 表由 addon 持有，但条目是 Node VM 对象；回合引擎、任务会话、
   watchdog 和持久历史共享这些引用。需要定义有界、可恢复且不复制第二份权威状态的
   进程间命令/事件协议，并接入取消、重试、后台完成和生命周期清理。
3. 重连先注册、再取得问题状态并暂存输入，随后依次发 init、历史和重放；当前 hub
   只保证其自身快照与发布顺序，不实现问题状态屏障、Node 的重放去重或宿主发送队列
   的字节限额、拥塞计时和关闭语义。不能直接将测试探针改名为 `/ws/chat`。
4. 只有前门真正持有这些连接及事件源之后，才能以显式临时开关隔离 Node 路径并在
   启动时拒绝双重注册；否则会发生双重消费、遗漏广播或未授权访问。

## 去除 Node 常驻前的路由缺口

以下为 `docs/backend-runtime-inventory.md` 与 `node-surface-ledger.json` 的
2026-11-19 隔离捕获口径：Node 仍注册 128 条 HTTP 路由和 26 层中间件；这些数字
不包含 WebSocket，不能视为最新生产进程的实时计数。128 条分为：

| 注册项 | 数量 | 驻留原因与代表路径 |
|---|---:|---|
| 回环宿主端口 | 35 | 已迁前门的公开路由仍通过 `/api/__host/*` 查询或执行 Node 持有的事实和副作用，包括 session、provider、task-shell、orchestration、voice、plugins 等；前门能认领不代表无 Node 时能完成。完整路径见 inventory 中 `/api/__host/` 条目。 |
| 消息平台和 cron 插件 | 71 | WeChat 15、Feishu/Telegram/Discord/Slack 各 12、cron 8；平台 SDK、连接和插件生命周期仍在 Node。路径见 inventory 的 `plugins/bridges/*` 与 `plugins/cron/cron-tasks.js` 条目。 |
| CLI 工具 | 6 | `/api/cli/install-specs`、`/api/cli/:cli/install`、`/api/cli/:cli/upgrade`、`/api/cli/install-status/:jobId`、`/api/cli/versions`、`/api/cli/:cli/unpin`；作业规则在 Rust，但启动子进程、终止及探测仍由 Node 宿主执行。 |
| 插件管理 | 8 | `GET /api/plugins`、`GET /api/plugins/catalog`、`POST /api/plugins/catalog/refresh`、`POST /api/plugins/:id/{install,uninstall,rollback,run}`、`GET /api/channels/targets`；安装器、目录和通道宿主持有 Node 对象。 |
| OAuth 登录 | 2 | `POST /api/zcode/auth/login`、`POST /api/kimi/auth/login`；持有较长时间运行的登录子进程。 |
| 会话打包 | 2 | `GET /api/sessions/:id/bundle.zip`、`POST /api/sessions/import-zip`；流式归档与导入仍依赖 Node 会话状态。 |
| provider 代理 | 2 | `POST /codex-proxy/:providerId/:sessionId/:role/responses`、`POST /codex-proxy/:providerId/responses`；attempt 能力校验与观测钩子仍依赖 Node 运行态。 |
| 工具与语音 | 2 | `POST /api/internal/router-tools/:tool`、`POST /api/voice/stt`；分别依赖回环工具宿主和音频上传/ASR 运行态。 |

除此之外，`/ws/machines/<id>` 已在 Rust 前门终结升级；`/ws/chat`、`/ws/voice`、
`/ws/tts`、`/ws/workspace`、`/ws/meta`、`/ws/aux`、`/ws/remote-screen` 和终端
升级入口仍经过 Node 路由或传输；voice-gateway web 升级另由 Node 反代。workspace
和 meta 的部分状态虽由 addon 中的 Rust 持有，升级和 socket 句柄仍不在前门。
聊天、其他 WS、插件和上述宿主端口完成替代之前，移除 `--node` 或将 `--no-node`
称为完整生产模式都会丢失功能。

## fleet-sharing 既有失败复核

本轮用当前 debug 网关与 addon 串行运行 `test-fleet-sharing.js`、
`test-fleet-sharing-routes.js`、`test-fleet-sharing-two-ip.js`，结果 33 通过、2 失败：

- `source creation reads the live directory, fails closed on host errors and preserves durable state`：
  8 个并发创建的响应不全为 200。
- `native source import serializes password failures and durable access budgets`：
  并发导入预期的 4 个 429 没有出现。

此前交接记录显示这两项在干净 main 上也失败。本轮 debug 失败均约在 3.4 秒结束；
以当前源码新构建的 release 网关及 addon 单独复跑，两项分别用时约 724ms、462ms，
均通过。结果受构建配置影响；密码计算和控制通道期限是否是原因尚未单独测量。

### 2026-11-20 定性复核：6 条、既有、档位敏感

最终门禁的 core 段把这组红的真实规模暴露出来：`test-fleet-sharing-routes.js`
在 debug 产物下是 20 项中 6 项失败，不是 2 项。「两项」是此前某轮只触发了其中
两条的偏小口径。三组对照（同一文件、单独串行运行、互不并发）：

| 源码 | 产物档位 | 结果 |
|---|---|---|
| 本分支（接线后） | debug | 14 通过 / 6 失败 |
| 本分支（接线后） | release（同源新建） | 20 通过 / 0 失败 |
| 干净 main `3c4774f1` | debug（main 源码自建） | 14 通过 / 6 失败，**失败项逐条同名** |

失败项：`gateway revocation invalidates the same live source grant and survives
child/gateway restart`、`source creation HTTP matches legacy validation, headers
and ordered DTOs`、`source creation reads the live directory, fails closed on
host errors and preserves durable state`、`source import HTTP runs natively with
legacy password, admission and error contracts`、`native source import
serializes password failures and durable access budgets`、`source import
preserves context and persistence failure ordering and recovers`。

干净 main 以同样方式复现同一组 6 条，所以这不是本批接线引入的回归；release 档位
两侧都是 20/20，指向 scrypt 口令散列与并发预算期限在未优化构建下超预算。具体是
哪一项预算仍未单独测量，仍登记为既有失败，下次门禁继续复核。

对照方法有一个坑值得记下：基线工作树的 `node_modules` 若用符号链接，导出式夹具
（`gateway revocation ...` 要从导出包起隔离网关）解析不到依赖，Node 子进程进入
重启退避循环，整段会挂住而不是给出失败——必须用真实目录（APFS `cp -Rc` 克隆即可）。

## 无 Node 模式复核（未达最终验收）

本轮功能代码构建的 release 网关以隔离 HOME/数据根启动（之后仅修改了
`quota_routes.rs` 测试夹具）：
`multicc-gateway serve --cwd <仓库> --no-node --ephemeral-loopback`。一次实测 PID
3511 监听 `127.0.0.1:50801`，`pgrep -P` 无子进程，`lsof` 只见该进程持有该
监听端口；`/healthz` 返回 200。普通本地票据访问 `/ws/machines/demo` 得到
Rust 前门的 101，随后因票据没有机器连接元数据而以 4003 关闭；这不证明真实
机器上游已在无 Node 环境建立连接。`/ws/chat` 升级返回 503，说明该路径仍未迁移。
SIGTERM 后退出码 0，再连接端口返回 61（连接拒绝）。端口和 PID 是本次隔离
运行证据，并非固定配置；这不满足所有 `/ws/*` 在无 Node 模式提供服务的验收条件。

### 2026-11-20 复采（最终产物）

用指纹 `a4aaf99bb13d80b4e21d6905` 的 release 网关、隔离 `HOME` 与数据根重采一次
（采集脚本与原始输出留在本次运行的 `/tmp/nonode-evidence/` 下，不是仓库产物）：

- 单进程：PID 11227，`pgrep -P 11227` 无直接子进程，其中也没有 node 子进程；
- 端口独占：`lsof -nP -iTCP:53961 -sTCP:LISTEN` 只列出该 `multicc-gateway`；
- `/healthz` 200；网关日志写明 `node runtime disabled (--no-node): routes not owned
  by Rust answer 503 node_runtime_absent`、`authentication runtime owned locally`；
- `/ws/machines/demo` 升级由 Rust 终结：`HTTP/1.1 101 Switching Protocols` 并带
  正确的 `sec-websocket-accept`（本次只采到握手，未再采 4003 关闭帧）；
- `/ws/chat?session=demo` 升级返回 `503`，即该路径仍未迁移——这是诚实失败，不是降级可用；
- `SIGTERM` 后 `wait` 得到退出码 0，`stop signal received; no node to stop` 后端口释放
  （再连 curl exit 7），运行结束无残留进程。

结论不变：无 Node 模式只能服务已迁入前门的那部分路由，`/ws/chat` 及其余 `/ws/*`
与 128 条 Node 驻留路由仍需 Node 进程，因此不能把它称为完整生产模式。
