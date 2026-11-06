# 「🖥 屏幕」服务端进程：multicc-remote

远程屏幕的服务端逻辑全部在 Rust 进程 `multicc-remote`（`native/remote/`）里：
Agent socket 客户端、平台画像、截图与裁剪、输入白名单、冻结快照与标注执行、
唤屏、RFB / H.264 视频流转发、WebRTC P2P 直连。

Node（`src/remote-screen-rust.js`，经入口 `src/remote-screen.js` 加载）只做三件事：

1. 启动、看护这个进程；
2. 沿用全站鉴权（HTTP 中间件、WS 票据）；
3. 把已鉴权的请求和 WS 消息**原样**转给它，并处理 WS 背压。

Node 不解析远控协议，也不承载远控策略（AGENTS.md「后端默认使用 Rust」）。
截图、编码、输入注入仍然在桌面 Agent 里（见 desktop-agent-protocol.md），
客户端（网页、App）看到的接口和字节流与迁移前完全一致。

迁移前的 Node 回退实现已整块删除：远控只有 Rust 一种实现，不存在按配置切换后端的路径。

## 1. 启动

- 二进制查找顺序：
  1. 环境变量 `MULTICC_REMOTE_BIN`；
  2. 与已选中的 Rust 原生模块（`multicc_core.node`）同目录的 `multicc-remote`（Windows 为 `multicc-remote.exe`）。
  两处都没有 = 远控不可用（见 §6），服务端照常启动。
- `multicc-remote --version` 打印一行 `multicc-remote 1 <crate 版本>` 后以 0 退出，
  构建脚本用它确认二进制能运行（`1` 是本文档的协议版本）。
- 进程继承 Node 的环境变量（Agent socket 覆盖项 `MULTICC_AGENT_*`、`MULTICC_REMOTE_STUN`、
  `MULTICC_REMOTE_P2P`、`HOME`、`XDG_RUNTIME_DIR` 等），平台画像由进程自己按这些推导。
- stdin 第一行是一个 JSON 配置，之后 stdin 保持打开：

  ```json
  {"v":1,"dir":"/abs/<assistDir>/remote-screen"}
  ```

  `dir` = 冻结截图目录（随数据根隔离，由 assist-snapshots 的 7 天清理兜底）。
  **stdin 读到 EOF 即退出**（1 秒内），所以 Node 退出或崩溃时不会留下孤儿进程。
- 就绪时在 stdout 打印且只打印一行：

  ```json
  {"ready":true,"v":1,"port":53122,"secret":"<64 位十六进制>"}
  ```

  只监听 `127.0.0.1`，端口由系统分配；`secret` 每次启动随机生成，不经过 argv 和环境变量。
  日志一律写 stderr。Node 10 秒内读不到就绪行，就杀掉进程，按崩溃处理。

## 2. 内部鉴权

所有 HTTP 请求（包括 WS 升级）都必须带 `x-multicc-remote-secret: <secret>`，
否则返回 403，不给任何细节。

## 3. HTTP 转发

Node 在全站鉴权之后，把 `/api/remote-screen/` 开头的请求原样转过去：

- 方法、路径和查询串不变；转发 `content-type`。
- 请求体：Express 已解析过的 JSON 体按 `JSON.stringify(req.body ?? {})` 重新发出。
- 唤屏（`/api/remote-screen/wake`）额外带 `x-multicc-power-consent: 1|0|error`。
  这个值由 Node 读电源设置得出：「允许自动解锁」开关 || 电源意图 === `on`。
  电源设置归 Node 的电源模块管，这里只传一个布尔值。
  **三态**：Node 读失败（抛异常）时送 `error`，Rust 把它和「没带头」一样当作
  「状态不可用」（GET/POST 都回 503 `agent-unavailable`）——与迁移前的 JS 一致：
  那时 `readConsent` 直接抛，整个 `state()` 随之失败。不能折成 `0`，那会被
  前端显示成「自动解锁未开启」。
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

仅供 Node 调用的内部路由：

- `POST /internal/annotation`：标注器对 `dir` 下 `shot-*.png` 画的标记，请求体就是原样的标注载荷，返回执行结果。
  判断「是不是远控自己的截图」只是一次路径检查，留在 Node 里，用来决定往哪里转。

## 4. WS 转发（/ws/remote-screen）

1. Node 照常完成握手和票据鉴权，然后连
   `ws://127.0.0.1:<port>/ws/remote-screen?<原查询串去掉 ticket/token>`，带上内部鉴权头。
   `mode=h264` 走 H.264 桥（可带 P2P），否则走 RFB 桥。
2. 两个方向逐条原样转发，文本还是文本、二进制还是二进制。
   上游连上之前客户端发来的消息先排队（上限 1 MB，超出以 1013 关闭）。
3. 关闭互相传递：一端关闭，另一端用同一个关闭码和原因关闭；
   1005、1006 这类不能主动发送的关闭码，换成 1011。
4. 背压：客户端真实积压 = `bufferedAmount` + 连接握手时装的 `installWsBackpressure` 队列
   （`ws._multiccBackpressure.stats().queueBytes`，没装就当 0）。两者之和 > 64 KB 时暂停读上游，
   降到 16 KB 以下再恢复（暂停期间每 15 ms 查一次）。只看 `bufferedAmount` 会漏掉背压层里
   还没写进 socket 的那一大截，慢客户端就会晚暂停。
   Rust 端把「已交给写端、尚未写进 socket 的字节数」当作这条连接的积压量，
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
- 运行中退出：Node 按 1、2、4、8…30 秒退避重启；正在转发的 WS 一律以 1011 关闭，由客户端重连。
- 构建：二进制与原生模块在同一个 cargo workspace，但**单独编译**。远控二进制编不出来，只会让远控不可用，不影响服务启动。

## 7. 唯一实现

`src/remote-screen.js` 只是稳定入口，直接 `module.exports = require('./remote-screen-rust')`：
转发到独立进程 `multicc-remote`。迁移前的 Node 实现（`remote-screen-node.js`、`src/desktop-host.js`、
`remote-screen-{h264-bridge,p2p,region,rfb-bridge,wake}.js`）与配套回退测试已整块删除。

- **不再有开关**：`MULTICC_REMOTE_SCREEN_BACKEND` 不再被读取。旧 `.env` 里残留的 `node`
  值一律忽略，实际行为始终是 Rust；不需要也无法再切换。
- **设置入口已撤**：全局配置页的「远程屏幕后端」卡片与 `/api/settings/remote-screen-backend`
  均已删除。
- **依赖**：`werift` 仅剩测试与基准使用（e2e 里当浏览器端），已从 dependencies 降到
  devDependencies，生产代码不再 require 它。

