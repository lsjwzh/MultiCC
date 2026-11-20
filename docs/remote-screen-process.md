# 「🖥 屏幕」服务端进程：multicc-remote

远程屏幕的服务端逻辑全部在 Rust 进程 `multicc-remote`（`native/remote/`）里：
Agent socket 客户端、平台画像、截图与裁剪、输入白名单、冻结快照与标注执行、
唤屏、RFB / H.264 视频流转发、WebRTC P2P 直连。

Rust 前门（`native/gateway/`：`remote_child.rs`、`app/remote_screen.rs`、
`ws_remote_screen.rs`）只做三件事：

1. 启动、看护这个进程（`Arc<RemoteChild>`，全站共用一份 supervisor）；
2. 沿用全站鉴权（HTTP 中间件、WS 票据，`multicc_core::ws_admission`）；
3. 把已鉴权的请求和 WS 消息**原样**转给它，并处理 WS 背压（`multicc_core::ws_backpressure`）。

前门不解析远控协议，也不承载远控策略（AGENTS.md「后端默认使用 Rust」）。
Node 侧不再有这一层：2026-11-21 起 `/api/remote-screen/*`、`/ws/remote-screen`
与标注的 own-shot 处理器都由前门独占；`src/remote-screen.js`、
`src/remote-screen-rust.js` 已删除，`src/ws/connection-router.js` 的分派分支也一并退休。
截图、编码、输入注入仍然在桌面 Agent 里（见 desktop-agent-protocol.md），
客户端（网页、App）看到的接口和字节流与迁移前完全一致。

迁移前的 Node 回退实现已整块删除：远控只有 Rust 一种实现，不存在按配置切换后端的路径。

## 1. 启动

- 二进制查找顺序（`remote_child.rs::default_binary`）：
  1. 环境变量 `MULTICC_REMOTE_BIN`；
  2. 与前门可执行文件（`multicc-gateway`）同目录的 `multicc-remote`（Windows 为 `multicc-remote.exe`）——
     两者随发版一起放进 `native/prebuilt/<platform>-<arch>/`（`scripts/stage-rust-kernels.js`）。
  两处都没有 = 远控不可用（见 §6），服务端照常启动。
- `multicc-remote --version` 打印一行 `multicc-remote 1 <crate 版本>` 后以 0 退出，
  构建脚本用它确认二进制能运行（`1` 是本文档的协议版本）。
- 进程继承前门的环境变量（Agent socket 覆盖项 `MULTICC_AGENT_*`、`MULTICC_REMOTE_STUN`、
  `MULTICC_REMOTE_P2P`、`HOME`、`XDG_RUNTIME_DIR` 等），平台画像由进程自己按这些推导。
- stdin 第一行是一个 JSON 配置，之后 stdin 保持打开：

  ```json
  {"v":1,"dir":"/abs/<assistDir>/remote-screen"}
  ```

  `dir` = 冻结截图目录（随数据根隔离，由 assist-snapshots 的 7 天清理兜底）。
  **stdin 读到 EOF 即退出**（1 秒内），所以前门退出或崩溃时不会留下孤儿进程。
- 就绪时在 stdout 打印且只打印一行：

  ```json
  {"ready":true,"v":1,"port":53122,"secret":"<64 位十六进制>"}
  ```

  只监听 `127.0.0.1`，端口由系统分配；`secret` 每次启动随机生成，不经过 argv 和环境变量。
  日志一律写 stderr。前门 10 秒内读不到就绪行，就杀掉进程，按崩溃处理。

## 2. 内部鉴权

所有 HTTP 请求（包括 WS 升级）都必须带 `x-multicc-remote-secret: <secret>`，
否则返回 403，不给任何细节。

## 3. HTTP 转发

前门在全站鉴权之后，把 `/api/remote-screen/` 开头的请求原样转过去
（`native/gateway/src/app/remote_screen.rs`）：

- 方法、路径和查询串不变；转发 `content-type`。
- 请求体：前门的 Express 兼容层已解析过的 JSON 体按 `JSON.stringify(req.body ?? {})` 重新发出（与迁移前的 Node 逐字节一致）。
- 唤屏（`/api/remote-screen/wake`）**不再带任何同意头**。「允许自动解锁」的同意值
  由 `multicc-remote` 自己读（`native/remote/src/power.rs`），前门这一层不算任何业务值。
  同意 = `power-settings.json` 的 `autoUnlock` **或** powerd 意图文件 `power-intent` 为 `on`；
  开关为真时短路，不读意图文件。读的路径：`$MULTICC_AGENT_DIR`（缺省 `~/.multicc/agent`）
  下的 `power-settings.json`，以及固定的 `/Library/Application Support/multicc/power-intent`。
  只读不写，设置的写入仍归网页路由。每个请求读一次，不缓存。
  **三态**：设置文件读不出来（权限错误、坏 JSON、`autoUnlock` 不是布尔）时按
  「状态不可用」处理，GET/POST 都回 503 `agent-unavailable` —— 与迁移前的 JS 一致：
  那时 `readConsent` 直接抛，整个 `state()` 随之失败。不能折成「没同意」，那会被
  前端显示成「自动解锁未开启」。**文件不存在 = 同意**（保住从没拨过开关的老用户）。
  测试台用 `MULTICC_REMOTE_POWER_CONSENT_FILE` 注入 `1|0|error` 三态，生产不设。
- 响应的状态码、`content-type`、`cache-control`、`x-screen-*`、`x-region-*` 和响应体原样流回。
  `GET /wake` 的所有分支（含 503 与平台不支持的 200）都带 `Cache-Control: no-store`。

Rust 端的路由与 JSON 形状与迁移前（已删除）的 Node 实现完全一致：

| 路由 | 说明 |
|---|---|
| `GET  /api/remote-screen/capabilities` | 平台画像 + `streams{h264,rfb}` |
| `GET  /api/remote-screen/frame` | 主屏 JPEG；并发请求共用一次截图；支持 `x,y,width,height` 裁剪 |
| `HEAD /api/remote-screen/frame` | 同上，只要头（尺寸探测） |
| `POST /api/remote-screen/input` | 输入，op 白名单 |
| `POST /api/remote-screen/snapshot` | 冻结一帧 → `{path,url}` |
| `GET/POST /api/remote-screen/wake` | 唤屏 / 解锁状态与动作 |
| `GET/POST /api/remote-screen/clipboard` | 剪贴板文本：GET 读远端（`{ok,text}`，超长截断并带 `truncated`），POST 写远端（`{text}`，上限 200000 码元）；老 Agent 回 `clipboard-unavailable` |

仅供前门调用的内部路由：

- `POST /internal/annotation`：标注器对 `dir` 下 `shot-*.png` 画的标记，请求体就是原样的标注载荷，返回执行结果。
  「是不是远控自己的截图」的判定已移进前门（`app::remote_annotation`）：它在
  `annotation-relay` 之前拦截 own-shot 端点，不查配置、也不再到 Node。

## 4. WS 转发（/ws/remote-screen）

1. 前门照常完成握手和票据准入（`multicc_core::ws_admission`），然后连
   `ws://127.0.0.1:<port>/ws/remote-screen?<原查询串去掉 ticket/token>`，带上内部鉴权头。
   `mode=h264` 走 H.264 桥（可带 P2P），否则走 RFB 桥。
2. 两个方向逐条原样转发，文本还是文本、二进制还是二进制。
   上游连上之前客户端发来的消息先排队（上限 1 MB，超出以 1013 关闭）。
3. 关闭互相传递：一端关闭，另一端用同一个关闭码和原因关闭；
   1005、1006 这类不能主动发送的关闭码，换成 1011。
4. 背压：客户端真实积压 = 正在写出的那一帧 + 前门 `multicc_core::ws_backpressure` 内核里
   还没写进 socket 的发送队列字节数。两者之和 > 64 KB 时暂停读上游，
   降到 16 KB 以下再恢复（暂停期间每 15 ms 查一次）。只看 `bufferedAmount` 会漏掉背压层里
   还没写进 socket 的那一大截，慢客户端就会晚暂停。
   丢帧、补关键帧的水位与迁移前相同。

## 5. 测试观测

设置环境变量 `MULTICC_REMOTE_STATS_FILE=<路径>` 时，进程每 200 ms 把各条流的统计原子写入该文件：

```json
{"connections":[{"mode":"h264","forwarded":0,"dropped":0,"keyRequests":0,"p2pOpened":0,"transport":"relay","clientBinary":0}]}
```

`clientBinary` = 这条 WS 上收到的客户端二进制消息数，用来证明直连期间输入没有走中继。
不设这个变量时不写任何文件。只给测试台用。

## 6. 不可用与崩溃

- 二进制缺失、启动失败、或运行中退出时：
  - HTTP 远控路由回 503 `{ok:false,error:'remote-unavailable'}`；
  - `capabilities` 回 200 `{ok:true,supported:false,reason:'remote-unavailable',features:<全 false>,streams:{h264:false,rfb:false}}`，前端据此收起 🖥；
  - WS 以 1011 `remote-unavailable` 关闭。
- 运行中退出：前门（`RemoteChild`）按 1、2、4、8…30 秒退避重启；正在转发的 WS 一律以 1011 关闭，由客户端重连。
- 构建：二进制与原生模块在同一个 cargo workspace，但**单独编译**。远控二进制编不出来，只会让远控不可用，不影响服务启动。

## 7. 唯一实现

远控只有 Rust 一种实现，而且都在前门里：HTTP、WS、进程托管、内部标注路由
（`native/gateway/src/remote_child.rs`、`app/remote_screen.rs`、`ws_remote_screen.rs`）。

- **Node 转发层已删除**（2026-11-21）：`src/remote-screen.js` 与
  `src/remote-screen-rust.js` 整文件移除，`src/ws/connection-router.js` 的
  `/ws/remote-screen` 分支与 SESSIONLESS 清单条目一并退休。迁移前更早的 Node 实现
  （`remote-screen-node.js`、`src/desktop-host.js`、`remote-screen-{h264-bridge,p2p,region,rfb-bridge,wake}.js`）
  与配套回退测试早已整块删除。
- **不再有开关**：`MULTICC_REMOTE_SCREEN_BACKEND` 不再被读取。旧 `.env` 里残留的 `node`
  值一律忽略，实际行为始终是 Rust；不需要也无法再切换。
- **设置入口已撤**：全局配置页的「远程屏幕后端」卡片与 `/api/settings/remote-screen-backend`
  均已删除。
- **依赖**：`werift` 仅剩测试与基准使用（e2e 里当浏览器端），已从 dependencies 降到
  devDependencies，生产代码不再 require 它。

