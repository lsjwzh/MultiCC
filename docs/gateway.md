# Rust 前门 multicc-gateway（进程结构倒置 + L7 转发）

## 目标与边界

把 MultiCC 的进程结构从「Node 占端口、Node 当主人」倒过来：

```
客户端 ──TCP──▶ multicc-gateway（Rust，占公开端口，看护 Node）
                     │  每个客户端连接 1:1 开一条上游连接，开头写 PROXY v1 头
                     ▼
               node server.js（只听 127.0.0.1:<内网端口>）
```

第 1 步只做「进程结构倒置」，**对外行为逐字节不变** 的约束下已经完成；本步把前门从 L4 字节中继升级成 **L7 HTTP 服务**（hyper 1.x + axum 0.8）：

- 前门解析 HTTP，先匹配**原生路由**（由 Rust 直接应答，对应的 Node 路由已删除，见 §9），其余请求经 fallback 转发给 Node。
- 转发仍然逐帧流式、不缓冲：8MB 上传下载、SSE / chunked 响应逐块到达客户端；WebSocket 升级把两侧字节流对接。
- 进程管理、端口策略、PROXY 约定、看护与信号原样复用，与 L4 时代完全一致。
- **所有启动入口、三个平台都经前门启动**：源码检出的 `./multicc`（start/restart、launchd 登录服务）、独立包启动器（含它的 launchd / systemd / Windows 登录自启）、桌面壳（`MULTICC_DESKTOP=1`），macOS / Linux / Windows 一样。没有任何「起不来就直接跑 `node server.js`」的退路，前门和原生模块一样是必需件（见 §8）。开发者的 `npm start` 也经前门前台运行（`scripts/start-gateway.js`）。直接 `node server.js` 只剩集成测试在用：它缺少 §9 里已经搬进前门的路由，不是完整的服务。

## 为什么用 PROXY 协议而不是 X-Forwarded-For

`src/request-locality.js` 的 `isLocalRequest` 只信传输层对端 `req.socket.remoteAddress`，并且只要请求带任何 `X-Forwarded-*` / `Forwarded` / `Via` 等头就一律判为外部请求（防反代提权）。全仓约 57 处按来源地址做决策。

因此前门**绝不添加任何转发头**，而是：

1. 每个客户端连接对应**独占**的一条上游连接（不复用、不池化），连接映射 1:1；
2. 上游连接建立后、转发任何客户端字节之前，先写一行 PROXY v1 头；
3. Node 的内网监听器解析这一行，把真实对端写到这条 socket 的 `remoteAddress` / `remotePort` / `remoteFamily`（以及 `localAddress` / `localPort`）上，再交给 http server。

这样那 57 处判断一行都不用改，读到的仍然是真实客户端地址。客户端自己发的 `X-Forwarded-For` 照旧原样到达 Node（照旧被判外部），行为与今天一致。

## 约定（前门 ⇄ Node）

### 1. 命令行

- `multicc-gateway --version` → 输出一行 `multicc-gateway 12 <crate 版本>`，退出码 0。`12` 是协议版本（2 = 加了 `--stdin-lifeline`、Node 以 0 退出时前门随之退出；3 = 前门改为 L7，按客户端连接独占上游 HTTP 连接；4 = 私有认证控制流及前门认证端点；5 = service 配置及 HTTP/WS 代理；6 = 外部工作区 HTTP 与文件所有者；7 = 分享源管理专用 Rust 控制通道；8 = 创建接口与双向分帧 source 请求；9 = 状态 HTTP 与实时上下文读端口；10 = 密码导入 HTTP 与原生校验/消费调用链；11 = 分享 WS 票据 HTTP 与共享认证状态引用；12 = 分享落地页与分享源 Express 路由模块退役）；三处必须一致：这里、`scripts/build-rust-kernels.js` 的探测、`src/gateway-child.js` 的 `GATEWAY_PROTOCOL`。
- `multicc-gateway serve --cwd <目录> --node <node 可执行文件> [--] <脚本> [参数…]`，脚本缺省为 `server.js`。进程 cwd 切到 `--cwd`；argv 里必须出现 `server.js`（管理脚本按 cmdline 里的 `server.js` + cwd 认领端口占用者）。

### 2. 端口策略（唯一实现在 Rust）

- `.env`：前门在 `--cwd` 下读取 `.env`，规则与 `server.js` 第 11-18 行逐字一致（逐行正则，**已存在的环境变量不覆盖**），合并进自身环境，再原样传给 Node。
- 绑定地址与端口：由 `native/core/src/network_policy.rs` 计算，**是唯一实现**；`src/network-policy.js` 改为它的薄桥，导出面与报错文本不变。
- 开发模式（`NODE_ENV=development` 或 `MULTICC_DEV`）的端口顺延由前门完成；选定的端口写进子进程环境 `PORT`，Node 据此拼本机 URL。

### 3. 拉起 Node

前门先绑定公开端口（失败则直接退出，非 0），再拉起 Node。传给 Node 的额外环境变量：

| 变量 | 含义 |
|---|---|
| `MULTICC_GATEWAY_CHILD=1` | 处于前门之后 |
| `MULTICC_GATEWAY_INTERNAL_PORT=<端口>` | Node 只能监听 `127.0.0.1:<端口>` |
| `MULTICC_GATEWAY_PID=<前门 pid>` | Node 只有在**父进程号等于它**时才认为自己在前门之后。前门之后的 Node 拉起的 CLI 会话、以及它们再启动的测试或服务都会继承这三个变量；没有这条校验，那里面的 `node server.js` 会只去听一个没人转发的内网端口 |
| `PORT=<公开端口>` | 覆盖为前门实际占用的公开端口 |

前门自己启动时读过的 `.env` 键**不传给** Node（从子进程环境里删掉）：Node 启动时自己读 `.env`，且已有的环境变量优先。若继承前门那份，网页上改过的 `ACCESS_TOKEN`（写回 `.env`）在 Node 被前门重拉后会被启动时的旧值盖住。

stdout/stderr 继承前门（落到同一组日志）。stdin 是一根**生命线管道**：前门持有写端但从不写入。前门不论以何种方式消失（正常退出、panic、`kill -9`），内核都会关闭写端，Node 读到 EOF 后按 SIGINT 走优雅关停（`src/gateway-child.js` 的 `watchGatewayLifeline`；启动早期 SIGINT 处理器还没装好时会等它装好再发，避免迁移中途被默认动作杀掉）。没有这根管道时，前门一死 Node 就成了孤儿，继续跑全套定时器和 CLI 轮次，与新实例同时写同一份数据。

### 4. Node 在前门之后的行为

- 不调用 `server.listen(PORT, BIND_HOST)`，也**不做**开发模式端口顺延（否则会撞上前门占着的公开端口）。
- 改为在 `127.0.0.1:MULTICC_GATEWAY_INTERNAL_PORT` 上开 PROXY 监听器，解析出对端后 `server.emit('connection', socket)`；WebSocket 的 `upgrade` 事件因此照常触发。
- 数据迁移期的临时页面（`src/task-shell/migration-page-worker.js`）同样改听内网端口并解析 PROXY 头。
- 内网端口绑定失败（`EADDRINUSE`）：以退出码 **75** 退出，前门立即换一个内网端口重新拉起。
- `PORT`、`BIND_HOST` 保持为公开值：日志、局域网发现（mDNS）、拼给子进程的 `MULTICC_BASE_URL` 一律指向前门。

### 5. PROXY v1 头

前门在每条上游连接上**首先**写入且只写一次：

```
PROXY TCP4 <客户端IP> <前门本地IP> <客户端端口> <前门本地端口>\r\n
PROXY TCP6 <客户端IP> <前门本地IP> <客户端端口> <前门本地端口>\r\n
```

- 地址文本与 Node 直接监听时 `socket.remoteAddress` 的写法一致：IPv4 监听上是 `192.168.1.5`；IPv6 双栈监听上的 IPv4 客户端是 `::ffff:192.168.1.5`（Rust `Ipv6Addr` 的 Display 正好是这个写法）。`remoteFamily` 取 `IPv4` / `IPv6`。
- Node 侧解析规则：5 秒内必须收到；整行不超过 107 字节；格式不对、`PROXY UNKNOWN`、或缺头，一律直接销毁连接（fail closed）。
- 内网监听器只绑 `127.0.0.1`。本机进程即使直连内网端口并伪造 PROXY 头，也拿不到比直连公开端口更多的权限（本机连接本来就是本机）。
- 客户端无法伪造：前门总是先写自己的头；客户端发来的 `PROXY …` 文本现在会被前门的 HTTP 解析器当作非法请求行直接拒绝（400 / 断开），根本到不了 Node。

### 6. 转发（L7）

- 每条被接受的客户端 TCP 连接由 `hyper::server::conn::http1` 服务：保留头的大小写（`preserve_header_case`）、keep-alive 打开、`.with_upgrades()` 支持升级；它驱动一个 `axum::Router`。
- Router 由 `native_routes()` 构建。它的 fallback 先问 `app::claim` 这个方法+路径是不是 §9 的原生路由，是就由 Rust 应答，否则转发。设置 `MULTICC_GATEWAY_TEST_ROUTES=1` 时另有测试路由 `GET /__gateway_test/native`（固定响应体），供集成测试证明请求由 Rust 应答、Node 完全没被碰。
- fallback 使用**只属于这一条客户端连接**的上游连接：首个被转发的请求到达时才惰性建立，建连后先写 §5 的 PROXY v1 行（地址与 L4 时代逐字节一致），再在该 socket 上做 `hyper::client::conn::http1` 握手（保留头大小写）；同一客户端连接的后续请求复用它。Node 关掉它（keep-alive 超时等）后，下一个请求重新建一条并写新的 PROXY 行。**绝不跨客户端连接共享或池化**（`src/request-locality.js` 约 57 处依赖 socket 对端地址做本机/外部判断，1:1 映射是它们继续正确的前提）。
- 每条客户端连接的上游句柄（`Arc<tokio::sync::Mutex<…>>`）通过请求扩展交给 fallback。
- 忠实转发：方法、路径+查询、HTTP 版本、头（原始大小写）、请求体与响应体都逐帧流式透传，不缓冲。8MB 上传下载、SSE / chunked 响应逐块到达客户端（不是攒完再发）。**不添加任何转发头**（没有 `X-Forwarded-*`、`Forwarded`、`Via`）。响应原样返回（状态、头、流式体）。
- 升级（WebSocket）：升级请求照常转发；Node 回 `101` 时把 101 返回客户端，并把 `hyper::upgrade::on(client_req)` 与 `hyper::upgrade::on(upstream_resp)` 用 `tokio::io::copy_bidirectional` 对接。该上游连接从此归升级使用。
- 上游暂不可达（Node 正在启动、重启或崩溃后等待重拉，或端口为 0）：每 100ms 重试一次，最多等 `MULTICC_GATEWAY_UPSTREAM_WAIT_MS`（默认 30 秒）；仍不可达时返回 `503 Service Unavailable`（带 `Retry-After: 2`、`Connection: close`、`Content-Length: 0`）后关闭。上游连上了但请求发不出去（例如 Node 恰好关闭了这条 keep-alive 连接）返回 `502 Bad Gateway`。
- 客户端自己发的 `PROXY …` 行会被前门的 HTTP 解析器拒绝（400 / 连接关闭），什么也到不了 Node，比 L4 时代更安全。

### 7. 看护与信号

- Node 以**非 0** 退出（崩溃）：按退避重拉，间隔 0.5s → 1 → 2 → 4 → 8 → 16 → 30s 封顶；连续健康运行 60 秒后退避清零。退出码 75 改用 0.2s 间隔。
- Node **自己以 0 退出**（不是前门要求的）：前门随之以 0 退出，不重拉。Node 只在被要求时才这样退出：`/api/desktop-shutdown`（停下）或桌面模式的 `/api/restart`（请启动我的人重启我）。两种情况都该由前门的父进程决定，和前门出现之前完全一样：supervisor 把「就绪后的 0 退出」当作重启请求、重新拉起前门。
- `SIGINT` / `SIGTERM`：前门停止接受新连接，把停机请求转给 Node，不再重拉，等 Node 自己退出（不设上限，65 秒排空由 Node 和管理脚本负责）；再次收到信号则再次转发。Node 退出后，前门以相同退出码退出（被信号杀死时为 128+信号值）。
- 转给 Node 的方式：Unix 上是**同一个信号**；Windows 没有信号，改为关闭 Node 的 stdin 生命线（§3），Node 读到 EOF 后在进程内触发 SIGINT 处理器走优雅关停（`src/gateway-child.js` 的 `raiseSigint`；Windows 上 `process.kill(自己, 'SIGINT')` 会直接终止进程，不能用）。
- `--stdin-lifeline`：前门自己的 stdin 读到 EOF（或读错误）时，当作收到 `SIGINT` 处理。supervisor（独立包启动器、桌面壳）拉起前门时持有它的 stdin、从不写入：supervisor 不论怎么消失（正常退出、崩溃、`kill -9`、`taskkill /F`），前门都会停下，Node 随之排空退出，整棵树不会变成孤儿。不带这个参数时 stdin 被忽略（`nohup` 和 launchd 给的 stdin 一开始就是 EOF）。
- 在 Windows 上拉起 Node 时带 `CREATE_NO_WINDOW`：桌面启动器拉起前门时没有控制台，否则 Windows 会给 Node 这个控制台程序弹一个新窗口。
- 公开端口被占：日志写 `cannot bind <host>:<端口>: EADDRINUSE: …` 并以非 0 退出。supervisor 认 `EADDRINUSE` 这个词来报告端口被占。
- `SIGHUP` 忽略（nohup 场景）。
- 日志写 stderr，每行以 `[multicc-gateway]` 开头。

### 8. 启动入口与进程识别

前门和原生模块一样是**必需件**：构建链三个平台都编译、打包它（`build-rust-kernels.js`、`stage-rust-kernels.js`，发布流程缺件即失败），`ensure-source-rust` 编不出来就报错、不启动。它总在原生模块同目录，查找规则和 `src/native/runtime.js` 找模块一致：`MULTICC_RUST_ADDON` 所在目录，否则 `MULTICC_RUST_PREBUILT_DIR`（缺省为 `native/prebuilt`）下的 `<平台>-<架构>/`。

- `./multicc start`：`check_runtime_dependencies` 之后 `nohup multicc-gateway serve --cwd "$SCRIPT_DIR" --node "$NODE" server.js`。二进制不在或启动 1 秒内退出，都按启动失败处理。
- `./multicc install` / `update`（macOS launchd 登录服务）：`ProgramArguments` 写成 `multicc-gateway serve --cwd <检出> --node <node> <检出>/server.js`；模块路径随每次源码更新而变，所以 update 时整组参数重写（旧 plist 还是 `node server.js`）。脚本保持绝对路径 `<检出>/server.js`，`install.sh` 靠它认出安装目录。
- 独立包启动器（`scripts/standalone-launcher.js`，以及经它启动的 launchd / systemd / Windows 登录自启）与桌面壳（`desktop/main.js`）：`desktop/lib/backend-supervisor.js` 拉起 `multicc-gateway serve --cwd <app-server> --node <内置运行时> --stdin-lifeline <app-server>/server.js`（`desktop/lib/desktop-env.js` 的 `gatewayLaunch`）。Node 崩溃由前门重拉，supervisor 看不到；supervisor 只处理前门本身的退出（就绪后的 0 退出 = 重启请求、端口被占、崩溃循环）。停机仍先 `POST /api/desktop-shutdown`（经前门到 Node，Node 以 0 退出，前门随之退出），超时再按信号 / `taskkill /T` 升级。
- `src/server-processes.js`：`serve` 模式、cwd 为本检出的 `multicc-gateway` 认作服务根进程；父进程是这种前门的 `node server.js` **不算**根（它是前门的后代，排空后由 `stopServers` 的 SIGTERM 兜底）。这样 stop/restart 只给前门发 SIGINT，前门转给 Node，不会出现「Node 先退、前门以为崩溃又拉起来」的竞态。
- `list` / `status` / `lock-alive` / `owner` 一并认得前门。

### 9. 原生路由（已从 Node 删除）

每搬一组路由，就在同一个提交里删掉对应的 Node 代码；前门负责保持那组路由的**完整契约**，客户端分辨不出换了实现：

- **鉴权**：`multicc_core::http_gate` 逐字节复刻 Node 的认证闸门（`src/routes/auth.js` 的中间件、`src/auth-security.js`、`src/request-locality.js`）：局域网对端白名单、`x-multicc-machine-grant` 优先（直接调 `multicc_core::machines::authorize`）、本机请求免登录（loopback 对端 + 本地 Host + 没有任何转发头）、HMAC cookie、`x-access-token`、可选的旧 query token，拒绝时 HTML 请求 302 到 `/login?redirect=…`、其余 403 `AUTH_REQUIRED`。对端地址就是写进 PROXY 行的那个文本，所以 Rust 与 Node 对同一请求的「本机」判断一致。
- **ACCESS_TOKEN 热改**：Rust `AuthRuntime` 是 Token、关闭状态和 WS 票据的唯一运行时所有者。宿主设置端点先持久化，再同步提交 Rust 状态；网关通过按子进程代次认证的私有控制流读取当前状态，已删除读取 `.env` 猜测 Token 的 `TokenSource`。仅修改文件不会提前切换正在运行的身份凭据。
- **Express 行为**（`native/gateway/src/app/express.rs`）：`res.json` 的弱 ETag 与 `If-None-Match` → 304、204/304 去掉实体头、`HEAD`、Express 对已注册路径的自动 `OPTIONS` 应答（`Allow`）、`express.json({ limit: '50mb' })`（类型判断、utf-8/utf-16 字符集、gzip/deflate 请求体、strict 首字符、413/415/400）、终端 `safeErrorHandler` 的错误 DTO、`/api/*` 的 JSON gzip（≥1024 字节、`Vary: Accept-Encoding`）、`X-Multicc-Request-Id` / `X-Correlation-Id` / `X-Multicc-API-Version` 响应头，以及写到 stdout 的 `http_request` 日志行。路径匹配同 Express：不区分大小写、允许一个结尾 `/`、不解码；只认区分大小写的 `/api/` 前缀（Node 闸门与 gzip 都按区分大小写判断它）。上述原生路径上的其它方法照常转发给 Node；认证端点见 §12，service 前缀全部方法由 §13 的原生宿主处理。
- **差分验证**：每组路由搬走前，把原 Node 流水线（真实的 requestId、gzip、认证运行时、body parser、原路由、错误处理）与前门放在一起跑同一组请求，比对状态码、响应体、ETag、内容长度和相关响应头，以及最终落盘文件。

| 路由 | 原 Node 实现 | Rust 实现 | 差分 |
|---|---|---|---|
| `GET/HEAD/PUT/OPTIONS /api/run-config/presets`、`POST/OPTIONS /api/run-config/presets/merge` | `src/routes/run-config-presets.js`（已删） | `native/gateway/src/app/run_config_presets.rs` + `multicc_core::run_config_presets`，落盘 `multicc_core::state_file`（与 `atomicWriteJson` 同格式、0600） | 39/39 请求逐字节一致，落盘文件一致 |
| `GET/HEAD/OPTIONS /api/download`、`POST/OPTIONS /api/auth/download-ticket`、`GET/HEAD/OPTIONS /api/uploads/stats`、`DELETE/OPTIONS /api/uploads/cleanup` | `src/routes/file-transfer.js` 的 `createDownloadHandler` 与上传临时文件统计/清理、`src/routes/auth.js` 的 download-ticket 签发和闸门 ticket 分支、`src/auth-security.js` 的 download ticket（均已删） | `native/gateway/src/app/download.rs` + `uploads.rs`，`multicc_core::download_ticket`（ticket 存储搬进前门进程）、`multicc_core::http_send`（`res.sendFile`/`res.download` 的发送语义）；闸门的 ticket 豁免由 `multicc_core::http_gate::authorize` 自己实现 | 71/71 请求逐字节一致（含百分号解码回退、中文文件名、ticket 目标归一化与复用、临时目录清理计数） |
| `/api/service-routes` 管理及 `/services/*` HTTP/WS | `src/service-routes.js` 与 server/auth/voice 接线（已删） | `native/core/src/service_routes.rs` + gateway `services.rs` / `service_transport.rs` | 80 组 HTTP 对拍及真实流式、WS、TLS 测试，见 §13 |
| `GET/HEAD/PUT/OPTIONS /api/settings/quota-guard` | `src/routes/quota-guard.js`（已删）、`src/quota/quota-guard.js` 的配置读取/归一化、额度判定与刷新节流（已移除） | `native/gateway/src/app/quota_guard.rs` + `multicc_core::quota_guard` / `settings`，运行时通过 `RustQuotaGuard` 与无损 napi 接口调用同一内核 | 10,096 组策略对拍一致；136 组 HTTP 请求的状态、正文、相关响应头与落盘字节一致 |

额度保护默认对官方账号启用，5 小时、周、月窗口均以 98% 为阈值。只有达到阈值且 reset 仍在未来的读数才能阻断；多窗口按使用率、再按 reset 降序选择。阻断读数超过默认 30 分钟后放行并通知宿主刷新，失败刷新写入的 `lastAttemptAt` 同样重置读数年龄，避免每次请求都重试不可达上游。刷新通知按账号至少间隔 60 秒。

配置优先级为默认值 → `<data>/quota-guard.json` → 环境变量。API 立即返回保存后的有效配置，并报告环境覆盖字段；运行时保留原来的 5 秒配置缓存，到期才采用新值。文件格式仍为两空格缩进、结尾换行、新文件模式 0644；未知保存字段及 UTF-16 孤立代理项原样保留。无效输入在写入前拒绝，缺失或损坏的配置按未保存处理。原子替换失败时 Rust 会清理本次创建的临时文件。

环境入口保持不变：`MULTICC_QUOTA_GUARD`、`MULTICC_QUOTA_GUARD_PERCENT`、`MULTICC_QUOTA_GUARD_5H_PERCENT`、`MULTICC_QUOTA_GUARD_WEEKLY_PERCENT`、`MULTICC_QUOTA_GUARD_MONTHLY_PERCENT`、`MULTICC_QUOTA_GUARD_SCOPE`、`MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS`。

这批保留的 Node 例外仅为宿主适配：读取现有 provider-limit cache 对象、写日志、调用已有异步刷新回调，以及保持同步 JS 导出接口。规则、文件读写、配置缓存与节流均在 Rust；等这些缓存和刷新生命周期迁入 Rust 后删除该桥，不在桥中添加新的业务规则。源码启动预检要求新的 `RustQuotaGuard` / `quotaGuardRequestValue` 导出，旧原生模块不能静默绕过保护。验证在 macOS ARM64 隔离进程中完成，没有使用真实账号、修改生产配置或重启现有服务；不作为其他平台验收或性能收益结论。

源码启动复用外部目录的前门时，还校验产物记录的源码指纹和文件摘要；同一协议号不足以证明新增路由存在。来源不匹配时重新构建，构建失败或产物来源仍无法确认则停止启动。

与 Node 的已知差异：

- 关闭状态已统一：原生 `/api` 路由与 Node 一样返回 503 `SERVER_SHUTTING_DOWN`，并带 `Retry-After: 1`。
- `charset=utf-32` / `utf-7` 的 JSON 请求体返回 415（body-parser 经 iconv-lite 能解）。
- `/metrics` 里 `multicc_auth_*` 计数不含原生路由上的请求。
- 额度配置写入失败仍返回 500，临时文件名称由 Rust 生成；错误中的临时路径因此不同，失败后不再留下临时文件。
- `http_error` 日志行的 `detail` 是原因短语，没有 JS 调用栈。
- Token 分歧已消除：子进程重启后前门只接受新代次 Rust 运行时的当前凭据；不再保留前门自己的 `.env` 推测值。

### 10. 通用请求准入迁移（2026-11-08）

本节保留第一批迁移的检查点；认证运行时的后续变化见第 11 节。

公开端口、L7 转发和上表列出的原生路由原本已经由 Rust 前门持有。
本批进一步移除 `src/routes/auth.js` 中的通用准入分支：
`native/core/src/http_entry.rs` 持有公开路径、方法、UDID 媒体类型和代理凭据格式规则，
`native/addon/src/http_entry.rs` 持有关闭期拒绝、对端检查、公开路径例外、
Cookie／Token 认证决策、代理共享与限定范围授权的顺序，以及拒绝响应和指标调用。
`src/http-errors.js` 的请求 ID 校验、生成与关联 ID 回退也调用 Rust，
复用前门已有的 `http_gate` 规则。新增六个导出均进入源码启动预检，旧模块必须重建。

三个中间件保持原挂载顺序：`/api` 关闭闸门、登录端点之前的对端闸门、
登录端点之后的通用鉴权闸门。每次请求重新读取当前 Token 与关闭状态。
携带机器 grant 但限定范围授权失败时，不能用普通 Token 降级放行。
共享授权异常、指标与 `next()` 的异常边界、宿主回调修改请求后的读取顺序，
都保留旧行为。公开路径仅豁免全局 Token，资源自己的能力令牌与密码校验仍执行。

这是通用准入策略的迁移，尚不是完整 HTTP 宿主迁移。Node 例外仍包括：

- Express 中间件和响应对象、动态宿主状态及 service／fleet／provider 授权回调；
- `auth-security.js` 的 Cookie 签发／校验与 WebSocket 票据状态、`request-locality.js` 的来源地址计算；
- 登录、登出、凭据交换和 WS 票据端点，以及请求完成／中断的日志监听。

保留这些桥接是因为它们共享现有可变凭据、单次票据和服务运行时；在所有权一起迁移前，
不能在前门创建第二套状态。后续先迁登录与凭据／票据运行时，再按组迁业务路由，
为剩余动态授权端口定义明确协议后，才能把通用准入直接放到前门并删除 Express 宿主。
桥接中不新增业务策略。本批没有改变已有原生路由的授权方式，也没有移除 HTTP／WS 宿主。

验证使用源码指纹 `c5aaa8d8efa2b56f68904c72`：137 项入口相关测试通过，
包含 2,096 组旧 Node 与新 Rust 准入对拍，比较响应、宿主调用顺序、指标、异常与属性写入；
另有请求 ID 边界、UDID 隐式转换与真实 HTTP 检查。隔离服务的 HTTP／WS 本地性验证通过。
Rust core 394 项、CPR 单元 9 项及集成 27 项、gateway 单元 24 项及集成 32 项通过，
覆盖流式传输、升级连接、原生路由和退出监督。验证在 macOS ARM64 完成，
未修改生产配置或重启正在运行的服务，也不构成端到端性能收益结论。

最终构建上的完整 `npm test` 已通过（退出码 0）；Electron 打包工具链和 PowerShell
缺失各跳过 1 项。Rust 格式、11 个改动 JS 文件语法、源码预算、测试登记、治理与
`git diff --check` 均通过。入口这一批后续已与第 11 节一起提交为 `287cbc74`，尚未合并；
前述原始 JSON 脱敏内核的 `67b074c7` 已由 `694ab85c` 合入 main。服务未重启。

### 11. 登录、Cookie 与 WebSocket 票据运行时（2026-11-08）

第二批删除了 `src/auth-security.js` 中的加密、URL 策略和 JS 票据表，
并删除 `src/routes/auth.js` 中登录页面、登录／登出、凭据交换和 WS 票据的处理逻辑。
这两个文件现在分别保留兼容导出、回收引用锚点和 Express 路由／body parser 挂载。

- `native/core/src/auth_security.rs` 是网关与 addon 共用的认证内核：HMAC、恒定时间字节比较、
  Cookie 编解码及有效期、同源跳转与 WS 路径规范化、票据哈希和有序单次消费表。
  网关的 `http_gate` 复用此实现，不再维护独立的 Cookie 算法。
- `native/addon/src/auth_security.rs` 持有唯一的 WS 票据状态。HTTP 签发和 Node WS 消费端均调用
  同一个 Rust 实例；错误作用域尝试也消费票据，无效 URL 不消费，过期和容量淘汰保持旧顺序。
  凭据仍按调用读取，修改访问密码后的旧 Cookie 立即失效；不额外改变已签发 WS 票据的旧语义。
- `native/addon/src/auth_routes.rs` 执行端点分支、响应、错误 DTO 和 Cookie 调用顺序；
  `auth_login_page.rs` 保留原页面字节。WS 端点的错误边界仍包含票据签发和响应发送。
- 元数据保持浅复制、Symbol 属性和嵌套对象身份。原生表只保存元数据槽号；JS 引用挂在运行时
  对象的不可枚举锚点上，Rust 持弱引用，避免元数据或凭据回调反向引用运行时造成 GC 环。
  回调执行期间不持有 Rust 可变借用，重入消费和异常不会留下可重复使用的票据。
- 新类、辅助函数及端点导出均加入启动预检；预检还实际签发／校验 Cookie、签发／消费票据，
  并拒绝缺方法的旧模块。默认随机数来自 Rust 的系统随机源，保留测试用时钟与随机回调。

兼容修正：共享校验器改用项目的 JS 语义 JSON 解析器，并按 Node Base64 的 UTF-16 低字节规则
解码。对拍覆盖签名正确但 JSON 异常的输入、重复字段、溢出指数、非 ASCII 和孤立代理字符；
这同时修正了先前网关 Cookie 校验器的边界差异。

有意收紧的内部配置：TTL 必须是有限数值；`maxTickets` 必须是 1 至 4294967295 的整数。
旧实现遇到零／负容量会在清理循环中卡住，新实现构造时抛 TypeError。
这些是宿主构造选项，不是新增 HTTP 参数；默认 TTL 和 2048 张票据容量不变。
Cookie JSON 同时受共享解析器的 2000 层嵌套上限保护，超过上限即拒绝；
旧 Node 可接受这种带正确签名的异常嵌套输入。正常签发的 Cookie 始终为平坦对象。

**尚未完成 HTTP 宿主迁移。** 本批 Rust 运行时通过 addon 在 Node 进程内运行，
端点仍接收 Express 请求／响应对象，不属于第 9 节“由网关直接应答”的路由。
Node 例外的具体原因是剩余路由、动态 Token／关闭状态、fleet／service／provider 授权端口、
来源地址和 WS 升级仍共享宿主。保留范围仅为这些现有宿主接口、请求体解析和 JS 引用适配，
不在桥接层新增认证策略。后续应迁移动态状态及授权协议、WS 升级与连接所有权，
将端点放到前门直接处理后删除这层 Express 挂载；不能另起第二份票据表。

验证环境为 macOS ARM64，最终源码指纹 `e18847e1f4392f048a26a306`，原生来源摘要与启动探针均通过。
认证专项最终 12 项通过；包含 180 组 Cookie 时效边界、URL／签名与畸形 claims、票据容量、
重复随机值、元数据身份、重入、异常与 GC 回收。入口保留 2,096 组对拍，新增 96 组端点／异常
对拍和 30 组完整 HTTP 响应对拍；隔离 HTTP／WS 本地性与拒绝验证、源码预检均通过。
Rust 串行全套通过：core 394、CPR 单元 9／集成 27、gateway 单元 24／集成 32。
一次并行复跑中，未改动的 `provider_store` 用例返回 BUSY 而非 CONFLICT；串行复验通过，
未把该锁竞争现象宣称为本批已修复的问题。

`npm test` 所含各阶段已按脚本顺序覆盖。首轮停在新增核心测试后的数量断言；
审查并更新测试分层计数后，从 `test:governance` 续跑。桌面暂存首次缺少
`MULTICC_RUST_PREBUILT_DIR`，补为同一指纹的完整构建目录后，从 `test:desktop` 续跑至
`test:native` 退出码 0。Electron 打包工具链和 PowerShell 缺失各跳过 1 项。
格式、JS 语法、源码预算、测试分层、仓储／写入治理及 `git diff --check` 通过。
上述两批共 30 个文件已提交为 `287cbc74`（`refactor(auth): move HTTP admission and authentication runtime into Rust`），未合并、未推送、未重启或修改生产配置。下面第 12 节为此提交之后的工作树接续。

### 12. 认证端点进入 Rust 前门（2026-11-08，接续工作树）

`native/gateway/src/app/auth.rs` 直接处理 GET/HEAD `/login`、POST `/login`、GET/HEAD
`/logout`、POST `/api/auth/exchange`、POST `/api/auth/ws-ticket`，以及自动 OPTIONS。
生产网关模式不再挂载这些 Express 端点。页面、Cookie、请求体、错误 DTO 和 HTTP 响应均在
Rust 中完成；已有网关路由也使用同一个动态 Token 和关闭状态。

状态在 `native/core/src/auth_runtime.rs`，由 Node 进程中的 Rust addon 托管：

- Node 不再维护 `ACCESS_TOKEN` 与 `_shuttingDown` 可变业务变量；同步宿主端口只读写 Rust 状态。
- WS 表同时保存宿主引用槽和原生 JSON 元数据，签发、容量淘汰与单次消费共用一张表。
  普通端点签发的 requestId、correlationId 与 machineGrantId 会传给现有 WS 消费者；
  machine/fleet 专用端点仍可保留 Symbol 与对象身份，没有序列化原来的 live 元数据。
- 网关读到凭据版本后签发票据，运行时原子复核版本与关闭状态；解析请求体期间发生 Token
  轮换时重新鉴权，最后一刻版本变化则返回 503，不自动重放可能已生效的票据操作。
- 默认票据容量、30 秒期限、错误作用域也消费一次、重启丢弃票据保持原行为。

协议版本 4 的私有控制流采用长度前缀 JSON。网关在启动子进程前绑定随机 loopback 端口，
每个子进程生成新的 256 bit capability；addon 主动连接并以新挑战的双向 HMAC 认证。
没有先释放端口再让 addon 绑定的窗口。启动早期捕获并删除 capability 环境变量，避免 CLI
继承。每帧最多 64 KiB；最多 16 个待认证连接、64 个排队 RPC，握手及 RPC 均有 3 秒截止。
超时、断流、畸形帧、子进程代次变化返回 503，不回退到环境文件或 Node HTTP 认证路由。
取消 RPC 会关闭其流，防止后续请求读到上一条响应。任务与连接随运行时/子进程释放。

明确的边界变化：

- 访问密码必须能装入 64 KiB 控制帧（含 JSON 转义与状态字段）；超过时在 Rust 状态改变前拒绝，
  设置端点沿用持久化补偿回滚。正常密码不受影响。
- 登录表单仍限制解压后 100 KiB，同时增加压缩前 100 KiB 限制，避免无界压缩输入。
- 身份状态不可用时，原生路由统一拒绝服务，不能凭陈旧副本放行。
- `/metrics` 的原生认证计数仍未汇总进 Node 指标；这是后续可观测性宿主迁移的范围。

保留的 Node 例外仍是明确的迁移桥：既有业务路由、service/fleet/provider 授权宿主、来源地址
适配及 HTTP/WS 连接对象；本轮新增 JS 只负责控制通道启动参数交接与 native 方法调用。
直接启动 Node 的隔离测试还保留 addon 端点适配，既有生产启动器不会走它。待测试宿主与剩余
路由完成迁移后删除这条直接 Node 兼容路径。当前并未删除 Express，也未完成整体 Node 清理。

隔离对拍已覆盖 43 组 HTTP 响应，并断言上述认证请求从未进入 Express；另验证同表票据、
并发重放、错误作用域、机器授权/撤销、Cookie 与 Token 轮换、仅写文件不切状态、关闭拒绝，
以及子进程重启后的票据失效。Rust 控制通道故障测试覆盖伪造证明、超限帧、取消错帧和旧代次
迟到响应。共享查询语义修正未闭合括号，保留无穷数与 null 的区别以避免错误签发。

最终源码指纹 `193a5212c452993712f2d96d`，addon 与网关的来源摘要、启动探针通过。
Rust 串行回归：core 396 项、CPR 单元 9 项/集成 27 项、gateway 单元 27 项/集成 32 项通过。
真实隔离 `server.js` 通过 Rust 前门运行，原生票据成功换得 `/ws/meta` 快照，再次使用被拒绝；
本机、转发头和外部 Host 的 HTTP/WS 准入边界保持。
完整 `npm test` 第二轮退出码 0；首轮发现 LAN 发现接线测试仍匹配旧 JS 变量，
更新为检查 Rust 状态更新后的刷新顺序后，重新执行全部阶段通过。Electron 打包工具链与
PowerShell 缺失各跳过 1 项。改动 Rust 文件格式、JS 语法、源码预算、测试分层和 diff 检查通过。
验证环境仅为 macOS ARM64，不代表 Linux/Windows 实机验收或端到端性能收益。
本批未提交、未合并、未重启生产服务；当前分支仍仅有先前的 `287cbc74` 待合并。


## 13. Service 路由的配置与连接宿主进入 Rust（2026-11-08）

`native/core/src/service_routes.rs` 持有配置校验、原子落盘及路由查找，
`native/gateway/src/app/services.rs` 处理 `/api/service-routes` 管理接口和 `/services/*` 准入，
`service_transport.rs` 直接连接 HTTP/HTTPS 上游并拥有 HTTP 流与 WebSocket 升级连接。
配置状态属于 gateway 进程，不因 Node 子进程重启而重新载入；网关重启时从 `service-routes.json`
恢复。缺失文件视为空表，损坏或不可读文件使启动失败。磁盘操作与等待配置锁在阻塞线程执行，
保存成功后才替换内存；同一 owner 串行处理修改，保持 0600 原子写入。

本批删除生产 `src/service-routes.js`、认证闸门的 `handleServiceRequest` 调用口，以及
server/voice 中的 service 管理和 WS 挂载。旧实现只冻结在 `tests/helpers/legacy-service-routes.js`
作对拍 oracle，不参与产品启动。前门协议升至 5，防止旧网关配新 Node 时丢失这些端点。

- 管理接口仍要求普通登录身份：machine/fleet/provider grant 不能代替登录。写入校验 Origin，
  public 模式要求明确确认风险。保留 Express 的大小写、结尾斜线、参数解码、OPTIONS、JSON
  解析、ETag、HEAD 及错误响应；大写 `/API` 的静态后缀和 query bootstrap 顺序也作对拍。
- service 路径保持区分大小写，不规范化原始转发路径。private 路由校验 Origin 与登录，
  public 路由仍受来源网络策略限制；普通 HTTP 先执行对端拒绝，WS 保留原升级拒绝语义。
- 认证仍读取上一批的 Rust `AuthRuntime`（目前托管于 Node 进程的 addon），从按代次认证的
  私有控制流获取当前 Token；不是第二份凭据状态。普通服务票据不代替 service 登录身份。
- HTTP 请求与响应逐块转发，无整包缓存、自动重试或重定向。每个请求独占上游连接，120 秒
  无读写活动时关闭；连接建立同样加 120 秒上限。客户端取消、上游错误或流结束释放连接任务。
  升级后取消空闲超时，任一端结束即关闭两端，保留握手同包的双方首段数据。
- 剥离逐跳头、`x-multicc-*`、`x-forwarded-*`、`x-access-token`、`forwarded` 及 MultiCC Cookie；
  只重新生成必要的 service hop 和转发标识。移除 query 中的全部 `token`。响应 Cookie 限定
  到 service 前缀，同上游 origin/base 内的 Location 改写为该前缀，保留 no-store 和 508 防环。

明确的兼容边界：Rust TLS 使用系统证书库及 `NODE_EXTRA_CA_CERTS`，默认信任集合可能与 Node
内置 CA 集不同；不允许跳过证书校验，证书错误返回 502。HTTP 头顺序、连接复用与分块编码可变，
对拍按头值和实体内容比较。管理请求读完 body 后重新检查关闭状态，关闭期间缓慢上传的旧请求
也返回 503。service 配置在网关重启时重载；仅重启 Node 子进程不会采用外部编辑的配置文件。
直接 `node server.js` 缺少本节端点，与其它已迁入前门的路由相同，仅供部分隔离测试使用。

专项已完成 80 组真实 HTTP 对拍；另覆盖原生端点不进入 Express、24 个并发更新不丢写、
失败保存不切换内存、损坏存储启动失败、重启恢复、Token/Cookie 撤销、机器 grant 不能替代
管理登录、关闭拒绝、1 MiB 双向流、客户端取消、截断响应、重复 Connection 头的升级和
同包首段、TLS 拒绝不可信证书、额外 CA 下的 HTTPS/WSS。首次对拍发现的 OPTIONS 参数
解码顺序及重复 Connection 头升级识别已修正，并由冻结旧实现/原始 TCP 请求回归锁定。
原生服务日志当前在响应头就绪时记录；完整流耗时与终止指标仍待可观测性宿主统一。

本机环境为 macOS ARM64，未验证 Linux/Windows。
当前仍保留 fleet/provider 授权及其动态状态、其他 HTTP/WS 业务宿主、来源地址 JS 兼容接口、
聊天编排和持久化。它们依赖尚在 Node 的会话及供应商生命周期；待所有者迁移后删除这些桥。
Express 仍未移除；本批没有提交、合并、改变生产配置或重启现有服务。

最终构建指纹 `a2b2a7635a7c2ceb1ea549dc`，addon/gateway 来源摘要及启动探针通过。
52 项相关专项通过（含 80 组 service HTTP、1,980 组入口及 96 组端点/故障对拍），
真实隔离 `server.js` 的前门认证与 WS 快照链路通过。Rust 串行 core 399、CPR 9+27、
gateway 27+32 通过；最终 gateway 构建再次通过 27+32 回归。
完整 `npm test` 使用最新产物重跑退出 0；首轮仍引用重建前产物，新增重复头升级用例超时，
统一产物后完整重跑通过。Electron 工具链和 pwsh 缺失各跳过 1 项。
20 个变动 Rust 文件格式检查（保留基线模块顺序）、19 个 JS 语法检查、源码预算、测试分层和
`git diff --check` 通过。累计 48 个工作树文件含上一批未提交改动，`HEAD...main=1/0`，
本批未提交、未合并、未推送，未改变生产配置或重启服务。

## 测试钩子

仅供测试使用。两者都从前门进程环境读取（即在 `.env` 合并之后生效），只影响前门自身的等待和退避，不改变协议；取值非法时退回默认值，生产环境无需设置。

| 变量 | 默认 | 含义 |
|---|---|---|
| `MULTICC_GATEWAY_UPSTREAM_WAIT_MS` | `30000` | §6 里上游暂不可达时持有客户端连接、每 100ms 重试的总时长（毫秒）；超过后写回 503。 |
| `MULTICC_GATEWAY_BACKOFF_SCALE` | `1` | §7 里崩溃退避阶梯（0.5→1→2→4→8→16→30s）和退出码 75 的 0.2s 快速重试统一乘以此系数，用来把集成测试从分钟级压到毫秒级。非有限值或负数按 1 处理，上限 1000。 |
| `MULTICC_GATEWAY_TEST_ROUTES` | 未设置 | 设为 `1` 时 Router 额外注册测试路由 `GET /__gateway_test/native`（§6），证明请求由 Rust 应答。生产环境不要设置。 |


### 14. Provider 共享授权与来源地址统一到 Rust（2026-11-08）

`native/core/relay_shares.rs` 持有 provider 共享凭据、scrypt 校验、AES-256-GCM 密封副本、
撤销与访问计数。`durable_state.rs` 读写现有 `__multiccSchema` version 1 封装，兼容旧裸数组，
保留未知字段和 UTF-16 孤立代理字符；写入继续使用 0600 文件、同目录临时文件/fsync/rename、
三代备份。主文件损坏时按 bak1→bak3 恢复；主文件缺失仍按旧规则视为空，不能将备份恢复
误报为已经修复主文件。密封密钥缺失或损坏时保持旧行为：既有共享仍可校验，但不能重新复制。

`src/providers/relay-share-store.js` 仅保留异步调用兼容层和同一 handle 的调用排序。
Rust worker 执行密码计算和变更写盘，完成后才更新记录并返回授权成功。
所有生产路由与认证端口均等待 Promise；入站认证由 Rust 决定等待位置，异步完成后继续同一
原生判定。读取/写入异常只记录错误码，不把凭据、请求正文或文件内容写入告警。断开的客户端
不会在授权完成后继续转发。旧 Node 实现仅冻结在测试目录作为对拍基线。

`src/request-locality.js` 改为原生兼容导出；Node 请求适配与 Axum 共用 `core/http_gate.rs`
中的来源规则。只读 socket 的真实地址，不使用 `req.ip` 或 `connection` 提权；转发头按名称存在
即判断为外部，不读取其值。保留 Host 类型转换、getter 次序、异常和短路行为；共享 UTF-16
大小写处理修复孤立代理字符被替换的问题。导出的两个 Set 为兼容快照，对其修改不再改变
内部授权规则；生产调用方没有修改它们。

迁移例外：Node 尚持有 provider 路由、CPR 路由挂载及动态 provider/session 生命周期，Rust
owner 暂通过 addon 托管；来源适配需要读取仍在 Node 中的 req/socket。这些桥接必须在对应
HTTP/WS 与 provider 生命周期进入 Axum 后删除，当前 **不能下线 Node**。内部 provider store
方法改为异步、输入为 JSON 数据；测试专用的自定义 JS 存储与随机数注入不属于生产接口，
继续只在旧版 oracle 使用。对外 HTTP 状态码、响应字段和凭据格式保持不变。

部署/回滚：本次仅工作树实现与隔离验证，不切生产数据、不改启动路径或重启。上线时必须
同时部署匹配源码的 addon/gateway 与调用层。回滚前停止旧进程/在途请求，使用已有兼容版本
读取同一 version 1 数据和 `.key`；不得同时运行两个写入 owner，也不能单独回退异步调用层。
旧版与 Rust 版相互解密、校验、修改并重读的隔离夹具验证覆盖此文件格式回滚；整套后端的
无 Node 部署与回滚仍属于退出计划 6f，尚未完成。

本批验证收据：最终源码指纹 `86e6a32483c2383600893d0a`，addon 与 gateway 的来源指纹、
实际文件摘要和启动探针均通过。71 项专项覆盖 provider 数据互读/故障写入/并发撤销、认证
等待与客户端断开、来源判定、WS 宿主和 Claude/Codex JSON/SSE 转发；其中包含 392 组
relay 解析与 8,330 组来源对拍。真实隔离 `server.js` 经前门签票到 WS `meta_snapshot`
并验证重放拒绝通过。Rust 串行 core 400、CPR 9+27、gateway 27+32 通过。

`npm test` 全部阶段已覆盖：最终产物上的 deterministic 段通过；contracts 被旧的
`getNative().httpEntryGate(...)` 源码字符串断言中止，更新为当前原生句柄后，从 contracts
续跑至 native 结束，退出 0（最后 test:rust 256 项通过）。首次中间构建期间引用旧产物的
shutdown 启动失败未当作成功证据，已由最终产物 deterministic 全段复验覆盖。
Electron 工具链与 pwsh 缺失各跳过 1 项，本机未验证其他操作系统。
变动 JS 语法、23 个变动 Rust 文件格式（lib.rs 保留模块次序）、源码预算、测试分层、
仓库产物/运行时写入治理和 diff 检查通过。

默认隔离启动额外捕获 [570 条运行时路由和 34 层中间件](backend-runtime-inventory.md)，
静态候选和未覆盖的条件/插件/WS/SSE 配置继续留在 [退出计划](backend-rust-exit-plan.md)。
这些数量是残余 Node 注册项，不是 Rust 完成数量。第 6 步持续进行，下一步为工作区分享状态和
动态成员授权，随后将 provider HTTP 与生命周期 owner 搬到前门。本批未提交/合并/推送，
未重启生产服务；Node 生产退出仍未验收。

术语澄清：上文历史批次中的 `fleet` 指工作区分享接口的旧代码/协议名称。旧 Web 管理页
已在 `7d0e2ddf` 删除，但当前 App 仍提供“分享工作区／导入共享工作区”并调用这些接口。
后续只迁移这条现有调用链并保留协议兼容，不恢复 Fleet 产品概念或已删除的界面。

## 15. 工作区分享状态和持久化迁入 Rust（2026-11-08）

`native/core/src/workspace_sharing` 现在是工作区分享记录、密码与 grant、访问计数/撤销、
外部工作区引用及两个 JSON 文件的唯一所有者。`src/fleet-sharing.js` 删除了对应 Node
内存表、scrypt/SHA 校验、状态投影、授权范围规则和文件写入；旧实现只冻结在
`tests/helpers/legacy-workspace-sharing.js` 供对拍。现存 `fleet` URL、字段名、错误码和
数据文件名继续兼容客户端，不恢复旧产品概念。

读请求只在短锁内获取不可变状态快照；密码运算与写盘在原生 worker 执行，写盘成功后才
发布内存状态。创建、密码访问、撤销和移除的宿主调用已改为 await；HTTP 响应仍保持原
状态码和 JSON 契约。同步 HTTP/WS 范围判定使用当前 grant，并通过迁移期端口读取实时
会话归属；成员移出后不能凭旧会话列表放行。

密码校验和写入之间使用 Rust 内部生成的一次性随机凭证衔接，给宿主留下读取最新目录
状态的机会。凭证不出现在 HTTP 响应中，30 秒过期、每个 owner 最多保留 4,096 个；写入前
再次检查记录是否被撤销及剩余额度。最终返回工作区数据时再查当前授权和当前成员。
路由对密码尝试保留串行检查顺序，避免异步密码失败尚未计数时并发请求越过已有次数限制。

数据沿用原 version 1 普通 JSON 对象，未增加 envelope 或改数据库；继续使用 0600 文件、
原子替换和 fsync。未知记录字段、孤立 UTF-16 代理字符、既有 salt/hash/grant 和外部缓存
字段保留。损坏/缺失文件的启动行为沿用旧实现。测试用 JS randomBytes 注入不再参与原生
生产生成；随机源由 Rust 持有。JSON 桥接仅用于普通数据，不承诺保留 JS 对象身份或
枚举值为 undefined 的属性；这些属性在既有 HTTP JSON 中同样被省略。

明确未完成：远端 DNS/HTTP 传输及响应策略、密码失败窗口、Express 路由和 HTTP/WS 宿主，
以及实时目录/会话状态源仍在 Node。此批接线是迁移桥，不能据此宣称工作区分享整个域已
迁完或 Node 可下线；后续须把这些依赖和 owner 的托管位置一起迁出。

部署和回滚仍要求停写后切换单一 owner，并同时切换匹配的 addon 与异步调用层；不要让
旧 Node 状态写入器和 Rust 状态写入器同时写同一文件。旧新实现相互读取、校验密码、更新
计数和重读的隔离夹具已覆盖当前格式兼容。本轮未改变生产数据或启动配置。

本批当前证据：60 项专项通过，其中 1,233 组 HTTP/WS 范围对拍、360 组数据规范化对拍；
覆盖旧新状态/密码互读、失败写入不发布内存状态、一次性凭证/并发撤销/访问额度竞争、
实时成员变化、未知字段保留、事件循环可响应，以及真实 LAN 到 loopback 的两实例分享。
Rust core 串行 404 项通过。最终源码指纹 `286e8e04b10998f445304d68` 的 addon 来源校验与
探针通过。CPR 9 单元+27 集成、gateway 27 单元+32 集成全部通过；完整 `npm test`
退出 0，Electron 工具链和 pwsh 缺失各跳过 1 项。扩展后的真实隔离 gateway/server 测试验证
外部请求的工作区 HTTP 范围、分享 WS 票据到快照、票据重放拒绝以及撤销后的即时拒绝。
首次扩展用例只设置 Host，没有可靠排除 loopback 放行，补上转发头及匿名拒绝前置断言后
重新验证通过；未把该次失败当作迁移成功证据。格式、JS 语法、源码预算、测试分层和 diff
检查通过。累计 77 个工作树变更，`HEAD...main=1/0`，未提交/合并/推送或重启生产。
四项总目标验收仍未完成。

## 16. 工作区分享远端传输迁入 Rust（2026-11-08）

以下为上一批历史收据。当前外部接口和上传路径以第 17 节为准，64 KiB Node 上传桥已删除。

`workspace_sharing/remote.rs` 与 `transport.rs` 接管分享链接解析、DNS/地址校验、请求构造、
HTTP/HTTPS、重定向拒绝、响应体读取/大小限制、上游错误映射以及导入/刷新/远端 WS 票据
的响应契约。`src/fleet-sharing.js` 不再调用 Node fetch 或 DNS；旧实现继续只留在测试目录。
原生接口 `RustWorkspaceRemote` 已加入源码启动预检，缺少该接口的旧 addon 不得通过启动。

传输使用 Tokio/reqwest，不占 Node 主线程或 libuv 密码/写盘工作池。每次请求校验全部 DNS
结果，并把校验结果直接固定到实际连接；禁止自动重定向、自动重试及环境代理转送共享
授权。请求只携带已有白名单头和该外部工作区的 token/grant，不转发用户 Cookie 或普通
Authorization。响应支持 gzip/brotli/deflate，按解压后字节累计限制：导入 1 MiB，其余请求
10 MiB；原始代理响应使用 Buffer 跨 N-API，不以 Base64 或数字数组搬运。

Node 例外仅保留尚在 Express 中的上传流转接、实时目录/会话端口和原生调用接线。上传桥
使用暂停式 Readable，每次最多向 Rust 发送 64 KiB，通道容量为 1，等待发送完成才读下一块。
响应提前返回、上传错误或请求取消时释放通道并移除事件监听；错误流延迟发出的 error
事件也在移除监听前被处理。这层没有 DNS、HTTP 或响应业务策略，后续路由移到 Axum
时将直接改接 Rust Body，删除该 Node 字节桥，不重写传输内核。密码失败窗口及路由宿主
仍待迁移；因此本批不是工作区分享整个域的完成验收。

兼容范围及明确差异：

- 保留原 URL/数据字段、上游状态/错误码、结构化错误元数据、请求关联 ID、原始响应字节，
  以及成功修改后刷新缓存的行为。错误消息/详情保留孤立 UTF-16 代理字符；BOM、重复响应头、
  Latin-1 头值与空值优先级按旧 Fetch 行为对拍。JSON 桥不承诺旧 JS 对象的 undefined 自有属性，
  如第 15 节所述，HTTP JSON 无此差异。原测试用 `fetchImpl`/`lookupHost` 注入和内部
  `assertSafeRemoteTarget` 导出已退役，测试改为真实隔离服务器，不保留 Node 网络回退。
- 修复旧实现只在收到响应头前计时的缺口：默认 10 秒截止时间覆盖 DNS、连接、上传和完整
  响应读取。超时返回 `REMOTE_TIMEOUT`，主动取消/上传中断返回 `REMOTE_ABORTED`；这两个
  有限失败取代旧的挂起或运行时特有 AbortError。操作发送后超时不代表上游未执行，不能重试
  一个可能已经消耗额度的导入或修改请求。
- DNS 校验和连接不再二次解析。实际传输额外拒绝 IPv6 十六进制形式的链路本地映射地址，
  以及带末尾点的 metadata 域名；正常 LAN、loopback、IPv6 私网分享继续支持。旧公开地址
  字符串辅助接口仍保持原返回值，实际连接另做解析后的检查。
- TLS 使用系统信任库与 `NODE_EXTRA_CA_CERTS`，保持证书和主机名校验。Rust TLS 不接受把
  CA 证书当作服务端叶证书；测试使用独立 CA 签发的合法叶证书。底层 DNS/TLS/网络错误文本
  可随运行时/系统变化，不承诺复刻 Node 的错误栈，且不回传带 token 的请求 URL。
- 使用新的请求客户端；没有宣称连接复用或端到端性能优于同等优化的 Node。传输头序、连接
  复用、分块方式及压缩后的 Content-Length 展示可能不同，外部 HTTP JSON 契约仍受测试约束。

本批在独立数据根和本地 HTTP/HTTPS 服务上验证，未读取或修改生产分享记录。部署仍要求
使用匹配的 addon 与 Node 桥接；回滚沿用第 15 节的数据互读和单一写入所有者约束。
当前验证收据：最终构建指纹 `dab9493f8e0f81f548af5b03`，addon/gateway 来源摘要及
启动探针通过。72 项专项通过，包含 193 组真实 HTTP 错误/重定向对拍、另 4 组重复/空值/
Latin-1 响应头对拍、1,233 组 HTTP/WS 授权对拍和 360 组数据规范化对拍；覆盖 9.6 MB
分块上传、提前响应/上传错误/取消后的监听器清理、响应体超时、压缩响应限额、合法额外 CA
与不受信任证书，以及真实 LAN 到 loopback 分享。Rust core 404、CPR 9 单元+27 集成、
gateway 27 单元+32 集成通过；真实隔离网关的分享 HTTP/WS 快照、权限拒绝、票据重放
与持久撤销验证通过。完整 `npm test` 在最终产物上退出 0，末段原生测试 256/256；
Electron 打包工具链及 PowerShell 缺失各跳过 1 项，本机验收为 macOS ARM64。

验证中发现并修正了上传流销毁后延迟 error 的监听清理问题、URL 开头 BOM、异常 IPv6
辅助接口返回值及错误文本孤立代理字符；重复/Latin-1 头值同时加入对拍。两处测试夹具
问题（缺少原格式时间字段、CA 误作叶证书）已改为完整旧格式记录和合法 CA/叶证书链。
早先 npm 回归为处理这些边界修正而主动停止，该次不算通过；测试分层门禁已重新审查新增
core/isolated 用例及既有网络测试的 isolated 分类。此前与本批所有改动均留在工作树，
没有提交、合并、推送、重启服务或修改生产配置。


最终回归曾因早先中断测试留下的假浏览器守护进程而在两项“无残留进程”断言失败。
核对其本工作树测试身份并清理后，两项独立复验通过，随后完整 `npm test` 从头重跑退出 0；
没有把失败结果或未跑到的阶段记作通过。29 个已跟踪变动 JS 文件及新增测试/辅助文件的语法、
本批 4 个 Rust 文件格式、源码预算、837 项测试分层及 `git diff --check` 通过。
本批没有自动重启生产服务。`HEAD...main=1/0`，原计划仍是 5/6 完成，第 6 步持续推进；
下一依赖为工作区分享密码失败窗口及路由宿主，再继续 provider/其它 HTTP/WS 与聊天持久化。


## 17. 外部工作区 HTTP、状态所有者与上传迁入 Rust（2026-11-08）

整组 `/api/external-fleets` 的列表、导入、删除、刷新、远端 WS 票据请求和
`/:id/remote/*` 代理由 `gateway/app/external_workspaces.rs` 直接处理。
`workspace_sharing/external.rs` 负责网络操作与成功修改后的 best-effort 刷新，
网关是 `external-fleets.json` 的唯一所有者；Node 的 source facade 只打开
`fleet-shares.json`。所有权在 Store 构造时限定，越域读写和密码操作直接拒绝。
外部记录原子写盘成功后才发布内存快照，文件操作仍放阻塞工作线程。
网关启动时加载外部记录，Node 子进程重启不会重载或替换这个 owner。

生产 Node 的 external 方法、路由挂载、调用编排、上传泵及 `RustWorkspaceRemote`
通道全部删除。非 JSON 上传由 Axum Body 直接进入 reqwest，利用传输背压；上传字节
不再进入 Express 或跨 N-API。缓冲型 `RustExternalWorkspaces` 库适配器只供隔离测试
调用同一 Rust runtime，并纳入源码启动探针，不是生产 HTTP 回退。

保留 `/api/external-fleets` 旧命名与 App 契约：本地缓存投影、JSON 字段顺序及 ETag、
HEAD/OPTIONS、JSON 解析错误优先级、错误脱敏/UTF-16、请求 ID 和远端错误头。
`core/api_contract.rs` 共享本批所需错误 DTO 的展示规则；尚未替换整个 Node api-contract。
JSON 请求继续采用 50 MiB 解析限额，读取完成后重新检查授权和关闭状态。
刷新/导入时间在网络返回后采样，避免把慢网络等待误记为已更新缓存的时间。

用户授权改造上传后的明确行为变化：非 JSON body 现在传递原始字节流，修复旧 Express
路径可能把默认空对象当作上传体的问题；JSON 仍解析后序列化。上传在整个远端请求的
默认 10 秒截止内执行，客户端中断会关闭上游请求；提前拒绝不会等待上传完成。
源端可能已执行的修改不会自动重放。上游响应仍按解压后大小限额缓冲（导入 1 MiB，
其它 10 MiB），本批没有把响应改为无限流，也没有作性能提升承诺。

必要 Node 兼容范围仍是分享源 HTTP/WS 路由、密码失败窗口、实时目录/会话端口和
认证状态的 addon 托管。其原因是这些状态与尚未迁移的会话生命周期相连；待对应 owner
和宿主一起迁入 Rust 后删除。外部 WS 票据在 Rust 请求，真正连接的分享源 WS 宿主
仍在 Node。Express 与整体 Node 退出目标尚未完成。

部署须同时使用协议 6 网关、匹配 addon 和新 Node 宿主，停止旧实例写入后再切换；
不要让旧 external writer 与新网关同时运行。JSON schema 仍为 1，既有格式互读测试继续
保留。回滚须整体恢复匹配版本并重新加载文件。直接 `node server.js` 不再提供外部工作区
端点；正式启动必须经过 Rust 网关。本轮未切换生产配置、未重启服务。

本批审查修正了错误脱敏规则、坏 JSON 与非法路径的报错顺序、列表字段排序影响 ETag、
以及导入/刷新时间提前采样的问题。gzip 压缩器输出可以不同，验证比较解压后的完整字节、
ETag 与其它语义响应头，并分别核对各自 Content-Length。初次暴露上述字段顺序和压缩
比较差异的测试不计为通过，修正后的对拍已通过。

当前收据：最终源码指纹 `129db673b9a3544692de2cf4`，addon/gateway 来源摘要和启动探针
通过；协议输出 `multicc-gateway 6 0.1.0`。45 组完整 external HTTP 对拍确认请求没有进入
Express，既有 193 组错误/重定向和 4 组头语义对拍继续覆盖共享 runtime。验证 9.6 MB
字节摘要、慢上游背压、断流关闭、提前重定向、失败写盘不发布内存、Node 子进程重启、
LAN 导入及完整网关重启恢复；真实 server 隔离测试覆盖分享 HTTP/WS 范围、快照、
票据重放拒绝和撤销。Rust 串行 core 405、CPR 9 单元+27 集成、gateway 27 单元+32 集成
通过；43 个 JS 文件语法、36 个 Rust 文件格式、837 项分层登记、源码预算及 diff 检查通过。
完整 `npm test` 从头运行退出 0，末组原生测试 256/256；Electron 打包工具链和 pwsh
缺失各跳过 1 项。本次证据来自 macOS ARM64，未宣称其它平台安装包已验收。
累计 85 个工作树文件变更（包含此前批次），`HEAD...main=1/0`。本轮未提交、合并、
推送、重启生产或改变生产配置。原计划前 5/6 步完成，第 6 步继续推进剩余域。


## 18. 分享源密码窗口与请求队列迁入 Rust（2026-11-08）

`core/workspace_sharing/access.rs` 持有分享源密码失败窗口和先进先出队列。
`src/routes/fleet-sharing.js` 的 failures Map、过期/计数/清零逻辑及 accessTail 已删除；
窗口长度与失败次数由 Rust 导出，不在 Node 中维护第二份策略。请求进入时同步预订顺序，
异步等待资格；等待不会占用密码工作线程，也不在跨宿主 await 期间持有同步锁。

保留旧契约：键为 token 与真实对端地址组合；15 分钟内 10 次 WRONG_PASSWORD 后返回
相同 429 DTO，恰好 15 分钟时仍受限，超过才解除。只有 WRONG_PASSWORD 增加计数，
成功清零；不存在、额度耗尽、写盘或宿主异常不计为密码错误。队列仍在同一挂载实例内
按请求顺序执行，成功与失败混合时不会改变窗口结果。失败窗口不写盘，随该挂载实例
销毁/进程退出重置，与旧生命周期一致；本批没有引入新的持久化限流语义。

Reservation 的 Drop/显式 release 取消等待并推进后继；重复释放或迟到完成不会影响下一
请求。取消队列中间项不会越过仍活跃的前序。Native admission 与 completion 均校验
当前 reservation 身份，防止已结束请求重新准入或修改窗口。

必要 Node 例外仅保留输入/错误封送、调用现有 source port 和 finally 释放：源记录已在
Rust，但最新目录/会话仍由 Node 生命周期持有，因此操作结束后才能向 Rust 报告结果。
这一桥接不保存窗口或队列。下一步必须将源端 HTTP/WS 宿主与实时上下文一起贯通，才能
删除该适配器；本批不把调用 Rust 视作源 HTTP 已迁完。

依赖核对：server.js 仍挂载 source 路由，创建/消费密码凭证之后读取实时目录与成员，
普通 HTTP 及 WS 授权还要读取同一实时成员集合。共享 WS 票据使用 Rust 单一票据表，
源 WS socket/snapshot 仍由 Node 托管。不能把成员缓存复制进网关后就删掉这些端口；
迁移须覆盖成员删除、撤销与密码校验之间的竞态，保持同一状态所有者。

最终源码指纹 `37fae5702ecb77df19927a26` 的 addon/gateway 来源摘要与启动探针通过，
协议仍为 6（本批未改变进程控制协议）。专项 23/23、31 组旧新路由对拍通过；混合成功、
错误密码、宿主异常与请求 getter 异常保持 FIFO 并释放后继。原生取消/重复完成/过期边界
3 项回归通过。真实隔离 gateway + server 的 14 并发错误密码请求得到 10 个 403 与
4 个 429，变化 X-Forwarded-For 不拆分真实对端窗口，失败和限流均不消耗访问额度；
原分享 HTTP/WS、快照、重放拒绝、撤销和 LAN 双实例测试继续通过。

Rust 串行 core 408、CPR 9 单元+27 集成、gateway 27 单元+32 集成通过。
43 个 JS 语法、37 个 Rust 格式、837 项测试分层、源码预算和 diff 检查通过。
完整 `npm test` 从头运行退出 0，末组原生测试 256/256；Electron 打包工具链和 pwsh
缺失各跳过 1 项。验收环境为 macOS ARM64，不代表其它平台包已经验收。
`HEAD...main=1/0`，此前批次和本批修改继续留在工作树。整体仍为原计划 5/6，Express 与
Node 清理未完成；本轮未提交、合并、推送、重启生产或更改生产配置。

## 19. 分享列表与撤销由 Rust 网关完整处理（2026-11-09）

`GET/HEAD /api/fleets/:id/shares`、`DELETE /api/fleets/:id/share/:token` 及对应
OPTIONS 已迁到 `gateway/app/source_workspaces.rs`。旧 Express list/revoke
处理函数和挂载已删除；其认证、JSON 解析、参数解码、DTO、链接、ETag、压缩及错误响应
都由网关完成。创建、密码导入、分享状态、分享 WS 票据和 landing page 仍在原宿主。
产品仍称工作区分享，旧 fleet API 名称保持客户端兼容。

唯一分享记录所有者仍是 Node 进程中的 Rust `Store`，没有重复打开文件或复制授权状态。
新 `workspace_sharing/control.rs` 直接使用它的同一个 Arc；网关请求经过私有 Rust
通道调用 list/revoke，不经过 JS VM、Express req/res 或 JS Promise 队列。必要 Node
例外只有启动时将一次性连接参数传给 native owner，以及其余 source 操作仍需使用的实时
目录/成员端口。待这些生命周期迁完，再把 Store 所在进程迁入网关并删除启动适配。

专用通道复用既有双向 HMAC、按子进程代次注册、64 项并发准入及截止机制，但与认证/票据
使用不同监听器、随机 capability 和连接。写盘或密码线程等待不会占用认证控制连接，
文件操作放阻塞工作线程，授权读取仍只读取已发布快照。capability 在 Node 模块加载时
从环境删除，连接后清除 JS 启动副本。替换子进程会撤销旧代次注册和响应。

请求帧仍最多 64 KiB；列表回复按不超过 64 KiB 的块发送，以零长度终止。
列表没有新增总条数/字节上限，聚合内存仍随列表大小增长；该协议只接受经过认证的本地
所有者回复。缺终止块、畸形/超长块、取消、超时均废弃连接，后续请求不能读取旧回复。
等待所有者连接和一次 RPC（含排队）分别最多 3 秒，最多 64 项在途；过载或不可用返回
503。副作用不自动重放：客户端遇到连接失效或截止时，已开始的撤销写盘可能仍完成，
应重新读取列表确定状态。慢 JSON 输入结束后重新检查凭据和关闭状态，轮换/关闭后拒绝
执行。这些是迁出进程后的明确失败边界；不能把超时响应解释为“撤销未发生”。

本次对拍修正了已有 publicShare 字段顺序造成的 ETag 差异，并修正 Axum 为条件 HEAD
304 自动添加 Content-Length: 0 的问题。gzip 压缩字节允许不同，解压正文、ETag 与其余
语义头保持一致。沿用已有 50 MiB JSON 输入及共享解析器边界。

部署/回滚必须成套使用协议 7 网关、addon 与 Node 宿主；不支持混用协议 6。
分享文件 schema 仍是 1，回滚先停止当前进程，再由匹配旧版本单独加载，禁止双 writer。
直接 `node server.js` 不再提供这两个管理端点，生产启动仍通过 Rust 网关。
整体仍为 5/6：剩余源 HTTP/WS、实时成员所有权、provider、聊天编排和持久化继续迁移，
Express/Node 尚不可下线。本轮没有提交、合并、推送、生产重启或配置切换。

最终收据：源码指纹 `3803e14e0af6f74f69e9e5b5`，addon/gateway 来源摘要与启动探针通过，
协议输出 `multicc-gateway 7 0.1.0`。62 项专项组合全部通过；其中源管理 HTTP 40 组完整
对拍确认不进入 Express，另有 600 条记录的大列表原文/gzip 对拍、写盘失败不发布撤销、
旧 grant 即时失效、子进程及完整网关重启恢复、慢 JSON 期间凭据轮换拒绝。
新增 3 项原生通道回归覆盖多帧及认证隔离、取消/截断和超长块；原有认证代次、伪造证明
与取消回归继续通过。既有 31 组失败窗口、45 组 external HTTP、80 组 service HTTP、
193 组远端错误/重定向与重复头对拍继续通过。LAN 双实例测试现在源端也经过真实网关。
真实 `gateway + server.js` 隔离验证覆盖密码限流、分享 HTTP/WS、快照、范围拒绝、
票据重放拒绝与持久撤销。

Rust 串行 core 408、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过。
完整 `npm test` 从头退出 0，末组 256/256；Electron 打包工具链和 pwsh 缺失各跳过 1 项。
43 个 JS 语法、39 个 Rust 格式、837 项分层、源码预算与 diff 检查通过。源路由套件因
新增真实网关/文件/进程验证，已重新审查为 core/isolated，并同步发布分层计数。
验收环境是 macOS ARM64，不代表其它平台包已验收。当前 `HEAD...main=1/0`，累计
86 个工作树条目（含此前批次）保持未提交；本批不改变生产服务或配置。

## 20. 分享创建由 Rust 网关处理（2026-11-09）

`POST /api/fleets/:id/share` 和对应 OPTIONS 迁入 `source_workspaces.rs`；Node 创建
handler 和 Express 挂载已删除。结合第 19 节，分享管理的创建、列表、撤销整组 HTTP
现在都由网关接收、鉴权、解析并生成响应。口令与选项校验、随机凭据、scrypt、分享记录、
原子写盘仍复用同一个 Rust Store，无重复 writer。

创建必须读取当前目录是否存在。目录生命周期尚在 Node，因此保留一个最小 N-API 异步
读端口：只调用现有 getDirectory 并封送布尔结果；它不保存目录副本、不接收 Express
req/res、不承担创建策略。此端口由 Rust 控制任务按请求读取，并在释放 JS 线程后执行
密码计算和文件操作。目录读取异常或端口释放返回原有脱敏 500；目录不存在仍先于口令
校验返回 404。读取最多等待 3 秒，未获得有效结果就不发起创建，不会在迟到回调后补写。

读端口用独立作用域中的 WeakRef 避免 TSFN → callback → facade → native 循环引用。
TSFN 不保持 Node 事件循环存活；native owner 回收会取消控制任务。单独 GC 子进程验证
循环对象可回收并正常退出。初版仅在 createFleetSharing 内放 WeakRef 仍被同一闭包作用域
保活，测试发现后已修正。目录 Map 的实际所有权仍在 Node；这个读端口必须在目录生命
周期迁完后删除，不能据此宣称实时成员 owner 已迁完。

协议升为 8：source 请求与回复都使用 64 KiB 分块及零长度终止，保留原 50 MiB JSON
输入，合法大描述/未知字段不因旧单帧限制变成 503。每帧有界，聚合内存仍随请求/列表
增长；原有连接等待、RPC 截止、并发准入、代次校验及不重放语义沿用第 19 节。认证通道
继续使用原来的单帧协议，不受 source 大输入或 scrypt 排队占用。

HTTP JSON 经共享解析器后使用已有 json_encode_wire 编码，保留孤立 UTF-16、负零与
溢出指数。初版用 JSON.stringify 语义将 Infinity 变成 null，导致非法天数/额度变成
默认值；已由完整对拍发现并修复。成功响应中的随机 token 和毫秒时间按结构及相对过期
间隔比较，同时独立核对各自真实正文的 ETag；其余错误、状态、字段顺序和响应头完整
对拍。目录存在性在每次原生操作开始时读取，不复制缓存；这不是把目录删除与创建密码
计算组成新的跨生命周期事务。

部署和回滚须使用配套协议 8 网关、addon、宿主；不支持混用协议 7。文件 schema 仍为
1，旧数据可读取，切换前仍须停止旧 writer。本批不改生产配置、不重启、不提交或合并。
原计划仍为 5/6：密码导入、状态、分享 WS 票据/连接宿主、落地页和实时成员 owner 继续
迁移；provider、其它业务、聊天编排和持久化也未完成。

最终收据：源码指纹 `e9524d0928824811ad2a71e6`，addon/gateway 来源摘要及启动探针通过，
协议输出 `multicc-gateway 8 0.1.0`。64 项专项组合全部通过，其中新增创建 HTTP 48 组
完整对拍确认不进入 Express，覆盖参数/JSON 错误顺序、非有限数值、Unicode、状态、
响应头与字段顺序。实时目录删除/恢复、宿主异常脱敏、8 并发创建与撤销、写盘失败不
发布、2 MiB 描述、超单帧输入和 GC 子进程退出均通过；原有 40 组管理 HTTP 对拍及
大列表/gzip、密码准入、external/service/远端传输专项继续通过。LAN 双实例与真实
`gateway + server.js` 隔离验证覆盖分享 HTTP/WS、快照、范围拒绝、票据重放拒绝、
持久撤销和密码失败限流。原生控制测试确认目录读取超时后没有迟到创建。

Rust 串行 core 409、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过。
完整 `npm test` 从头运行退出 0，末组原生测试 256/256；Electron 打包工具链和 pwsh
缺失各跳过 1 项。43 个 JS 语法、39 个 Rust 格式、837 项测试分层、源码预算与 diff
检查通过。验收环境为 macOS ARM64，未将其它平台包计为已验收。`HEAD...main=1/0`，
所有本批及此前未提交修改仍保留在工作树；没有提交、合并、推送、生产重启或配置切换。

## 21. 分享状态 HTTP 由 Rust 网关处理（2026-11-09）

`GET/HEAD /api/fleet-shares/:token/state` 与对应 OPTIONS 由网关接收，原 Node 状态
handler 和 Express 挂载已删除。入口范围授权直接查询同一 Rust Store；有效的分享凭据
仍先于机器/global 授权生效，对端限制始终在其前面。范围判断保留原方法、路径大小写、
尾斜杠和原 URL 语义，HEAD/OPTIONS 不会自动继承 GET 的分享授权。50 MiB JSON 解析、
参数解码与错误先后顺序沿用原 HTTP 契约，慢请求体结束后重查授权和关闭状态。
大写 `/API/...` 的 GET 仍保留旧入口的 URL 令牌建立 Cookie 行为；它发生在范围授权
和 JSON 解析之前，错误响应也携带 Cookie。重复令牌参数、HEAD 和普通小写 API 不会
误用该分支。此前管理路由的同一入口行为也由此补齐。

Rust owner 先核对分享记录和 grant，再通过最小异步读端口获取当前目录及成员，随后
重新核对撤销/有效期并生成公开 DTO。读端口只在一次同步 JS 调用内读取现有 Map 和
封送 JSON，不保存副本、不决定权限、不接收 req/res。沿用迁移前该上下文 JSON 封送
语义，公开字段筛选、最多前 500 个成员及无效 ID 过滤仍由 Rust 完成；不会把私有目录
或会话字段返回客户端。成功响应保留 no-store、字段顺序、ETag、gzip 及条件请求语义。
完整正文对拍发现原 Rust 成员 DTO 的 active/createdAt 顺序与旧实现不同，已恢复旧
字段顺序，避免产生额外的正文和 ETag 差异。上下文封送内存仍随当前成员数据量增长，
没有新增后台成员副本。

两个宿主函数均由独立作用域中的 WeakRef 引用，原生线程安全回调不保持 Node 事件
循环存活。宿主读取异常/无效返回按脱敏 500 处理；读取等待与 RPC 各有既有 3 秒截止，
通道不可用或超时可返回 503，不回退到 Express、不缓存旧上下文。读取期间撤销会在
最后一次 Rust 授权查询被拒绝。目录/会话生命周期仍在 Node，读取完成后发生的成员
变动属于后续状态；这里没有新增跨目录生命周期事务，也没有迁完实时成员所有者。

协议升 9，网关、addon 和宿主须成套部署或回滚；schema 仍为 1，分帧及独立认证通道
沿用第 20 节。Node 兼容层中的 readSharedFleet 仍用于尚未迁移的密码导入流程和库
接口，待导入与成员生命周期迁完后删除。剩余 landing/import/ws-ticket、WS 宿主、
provider、其它业务、聊天编排及持久化仍待迁移；总计划保持 5/6。本批不提交、合并、
推送或改变生产进程及配置。

最终收据：源码指纹 `ef1796e0d7ee0483a8656b8f`，addon/gateway 来源摘要和启动探针通过，
协议输出 `multicc-gateway 9 0.1.0`。54 项专项组合全部通过；新增 55 组状态 HTTP 对拍
确认没有进入 Express，包含完整正文/头、Cookie、授权顺序、HEAD/OPTIONS、gzip、
条件请求与错误先后顺序。505 个成员的投影验证上限、私有字段排除及孤立 UTF-16；
实时成员迁出、目录删除/恢复、宿主异常脱敏和撤销立即失效均通过。原生测试验证读取
期间撤销、失败/畸形/超时上下文及拒绝后恢复，未授权请求不会调用上下文读端口。
慢请求体期间撤销会拒绝后续读取。原有创建/列表/撤销、密码窗口、external、service、
远端传输及 GC 专项继续通过；LAN 双实例和真实 `gateway + server.js` 验证包含状态
读取、分享 HTTP/WS、范围拒绝、票据重放拒绝、持久撤销及密码失败限流。

Rust 串行 core 410、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过。
最终产物完整 `npm test` 从头退出 0，末组 256/256；Electron 打包器和 pwsh 缺失各
跳过 1 项。43 个 JS 语法、39 个 Rust 格式、837 项测试分层、源码预算和 diff 检查通过。
验收环境为 macOS ARM64，其他平台包未计为已验收。`HEAD...main=1/0`，累计 86 个
工作树条目继续保留未提交；未提交、合并、推送、重启生产或更改生产配置。

## 22. 密码导入 HTTP 与原生调用链（2026-11-09）

`POST /api/fleet-shares/:token/import` 和对应 OPTIONS 已由 Rust 网关处理，Node
导入 handler 与 Express 挂载已删除。保留公开路径的原大小写/尾斜杠/编码判定、真实
socket 对端、50 MiB JSON 解析和错误顺序；慢输入读完后重新检查关闭及授权。只把
token、password 和真实 peer 传到 source owner，忽略的请求字段不再跨控制通道。

原先的 JS「校验密码 → 获取 proof → 传回消费 → 再读状态」改为一个原生调用链。
`VerifiedAccess` 为不可 Clone、按值消费的 Rust 值，并绑定 Store 身份；中间不再编码
JSON，也没有随机 proof 表、nonce 查找或 N-API proof 参数。旧的 4096 条 pending-proof
上限随表删除，保留原 30 秒校验结果时效和消费时的记录/撤销/额度重检。
`RustWorkspaceAccess`、Reservation 的 N-API 类、JS 准入封送及 readSharedFleet 均删除。
库兼容的 accessSharedFleet 只做一次 importShare 调用，同样复用原生流程；生产 HTTP
直接调用 source 流程。Rust 内部直接传值，JSON 只保留在网络、现存宿主读端口和文件边界。

source owner 保有一个原生密码失败窗口；只计 WRONG_PASSWORD，成功清零，严格大于
15 分钟才过期，10 次后返回 429。连接重建不清窗口，owner 重启才重置。异步 FIFO
reservation 在退出时释放，失败/取消不会卡住后续请求。认证控制流仍独立，source
通道沿用 64 个并发准入、等待连接和 RPC 各 3 秒截止；导入现在也受这些边界约束。
请求一旦发送后断线或超时，导入可能已经完成并扣额度；不会自动重放，客户端应先查询
已有授权状态/管理记录。取消等待不能撤回已经开始的阻塞写盘工作。

顺序保持为校验密码、读取目录存在性、原子持久化额度、重新读取目录及成员、再验 grant
并投影。目录读取失败/超时或写盘失败不会扣额度；写盘成功后成员读取失败则保留已扣
额度。目录和成员生命周期仍归 Node，两个弱引用只读端口是迁移期必要适配，不保有
缓存副本、不处理 HTTP。待实时状态 owner 迁入 Rust 后删除读端口和相应 JSON 封送，
并把 source Store 从 addon 迁到网关进程。

协议升为 10，必须配套部署/回滚 gateway、addon、宿主；schema 仍为 1。旧 writer 停止
后才能切换。剩余分享票据/landing/WS 宿主、实时成员 owner、provider/其他域及聊天
编排/持久化未完成，总计划仍为 5/6。本批不提交、合并、推送、生产重启或改生产配置。

最终收据：源码指纹 `8b71c948abd41a3042575b4a`，addon/gateway 来源摘要和启动探针通过，
协议输出 `multicc-gateway 10 0.1.0`。53 项专项组合全部通过，含新增 71 组导入 HTTP
完整对拍，确认导入不进入 Express；覆盖密码类型、JSON/路径/鉴权错误顺序、Unicode、
大输入、gzip、公开路径边界和成功清零。14 个并发错误密码得到 10 个 403、4 个 429；
额度 2 的 6 个并发正确请求只有 2 个成功。写盘前失败不扣额度、成员读取失败保留已扣
额度、恢复后继续、慢输入期间关闭拒绝均通过。原生测试覆盖上下文失败/畸形/超时、
校验后撤销、Unicode 窗口键、FIFO/取消、连接重建保留窗口、owner 重启清窗口及丢失
响应不重放。真实 `gateway + server.js` 和 LAN 双实例验证分享 HTTP/WS、范围拒绝、
票据重放拒绝、撤销与限流均通过。

Rust 串行 core 413、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过。
最终产物完整 `npm test` 从头退出 0，末组 256/256；Electron 打包工具链和 pwsh
缺失各跳过 1 项。43 个 JS 语法、40 个 Rust 格式、837 项测试分层、源码预算、治理和
`git diff --check` 通过。验收环境为 macOS ARM64，其它平台包未计为已验收。
`HEAD...main=1/0`，累计 86 个工作树条目仍未提交；未合并、推送、生产重启或改配置。
本批密码导入已验收，总计划仍为 5/6。下一步继续分享票据/landing/WS 宿主、实时成员
owner，再迁 provider/其它域与聊天编排/持久化。


## 23. 分享 WS 票据原生调用链（2026-11-09）

`POST /api/fleet-shares/:token/ws-ticket` 及其 OPTIONS 由 Rust 前门处理。
删除 Express 票据处理器、挂载、错误包装和 `requestOrigin`，并删除生产
`authorizeWebSocket` JS 方法。分享路由模块只保留落地页文件适配。
HTTP、密码导入和票据签发仍使用同一个 source Store；认证运行时通过
原生 `Arc<Mutex<AuthRuntime>>` 引用注入，不新增票据表或第二份分享权限。

- Rust 完成分享范围判断、实时成员 ID 读取后的再次授权、票据元数据构造及
  单次票据插入；元数据在同进程内直接传 Rust 值，保留孤立 UTF-16 代理项，
  不经过 JS/JSON 中转。通用认证端点仍使用原有控制协议与同一个票据表。
- 最终授权持有 source 快照读锁直到同步签发结束，撤销发布不能插入两步之间。
  锁顺序固定为 source snapshot → auth runtime；锁内不 await、不调用 JS。
  认证 revision 或停机状态变化会拒绝签发，返回明确的 503 错误。
- `/ws/workspace` 直接校验目录范围，不读取成员；`/ws/chat` 和 `/` 按当前成员
  授权。沿用原接口的目录存在性边界，不额外用目录存在性拒绝票据。
  保留 `sessionId` 为真值时优先写 `fleetSessionId` 的既有语义。
- Node 例外仅为启动装配、现有实时成员映射的只读端口，以及尚未迁移的
  WS 消费/连接宿主。票据读端口只复制 ID，避免读取私有字段、循环引用或
  无关 getter；无权限/无效路径不会触发成员读取。迁移成员生命周期后删除
  该端口；迁移 WS 宿主后删除票据消费的 N-API 适配。
- 票据使用同一容量、30 秒 TTL、作用域与单次消费机制。已经签发的票据
  不因后续分享撤销而新增追溯失效语义，保持旧行为；后续签发立即拒绝。
  成员快照之后的变更仍存在跨 owner 时间边界，不宣称成员迁移已完成。
- 协议升级到 **11**，磁盘 schema 仍为 1。网关、addon、Node 装配必须配套
  部署/回滚。source 控制流仍有 64 个并发准入和三秒 RPC 截止时间；连接断开
  或响应丢失可能发生在票据插入之后，不自动重放签发，也不返回伪成功。

本批当前验证：73 组新增票据 HTTP 完整响应对拍通过，覆盖范围、授权先后、
大小写/尾斜线/编码参数、异常 JSON、gzip、来源协议和错误 DTO；确认票据
请求未进入 Express。原生测试覆盖撤销/认证轮换/停机/读取失败与超时、
原子发布顺序、超过 500 个成员及 UTF-16 元数据。真实 gateway + server.js
的分享票据、WS 快照、重放拒绝、撤销及 LAN 双实例通过。
最终收据：源码指纹 `ecf3d68274e8dd96589b9dfa`，addon/网关产物来源与协议 11
探针通过。72 项专项组合通过，成员投影和适配清理后最终 32 项专项复验通过；
另验证撤销前已签发票据的既有消费语义。Rust core 417、CPR 9 + 27、gateway
30 + 32 全部通过；完整 `npm test` 退出 0，末组 256/256。Electron 打包工具链
和 pwsh 缺失各跳过 1 项。43 个 JS 语法、41 个 Rust 格式（保留已有模块顺序）、
837 项测试分层、源码预算及 diff 检查通过。`HEAD...main=1/0`，共 86 个未提交
工作树条目，包含此前批次。实测环境为 macOS ARM64，不代表跨平台安装包认证。

整体仍为 5/6。落地页、WS 连接宿主和实时目录/成员所有者仍待迁移，随后是
provider 剩余域及聊天编排/持久化。本轮未提交、合并、推送、重启或修改生产配置。


## 24. 分享落地页与源 Express 路由退役（2026-11-09）

`GET/HEAD/OPTIONS /fleet-share/:token` 由 Rust 网关直接处理，删除最后的分享源
Express 挂载及整个 `src/routes/fleet-sharing.js`。创建、列表、撤销、状态、密码导入、
WS 票据和落地页均已迁出该模块。`server.js` 只直接装配既有 source owner 和实时只读
端口；通用请求的分享范围授权和 WS 消费/连接宿主仍依赖 Node，不能据此下线 Express。

页面固定读取启动脚本所属包目录的 `public/fleet-share.html`，与进程 cwd、数据目录及
URL 中的 token 分离。沿用共享异步文件发送器及 64 KiB 流式读取，保留文件替换、
ETag/Last-Modified、条件请求、范围请求和 HEAD 契约；不新增整文件缓存。页面不含
分享私有数据，不访问 source Store。保留旧入口的 peer 检查、公开路径、大小写、
尾斜线、参数解码、JSON 错误顺序及非 API 停机行为。公开路径先于 URL token 的
Cookie 引导，因此公开落地页带有效 token 也不会新增 Cookie；非公开大小写变体仍
按旧入口执行授权和引导。

对拍发现的文件响应差异修在共享层：错误 DTO 的 code/message 参数顺序恢复，
条件 HEAD 304 使用无精确长度的空 body，避免框架补入 Content-Length: 0；非 API
错误不附加仅供 API JSON 压缩的 Vary。sendFile 遇目录复用原有的通用 404，保留
缺失文件的 ENOENT、父路径非目录的 ENOTDIR 和读取失败的 EACCES。权限错误时 HEAD
只读取 metadata，仍返回 200；GET 打开文件失败返回 500，与旧实现一致。

Node 例外限于启动装配、现存目录/成员只读端口、通用请求范围授权适配和 WS 宿主。
实时目录、成员和会话投影的 owner 尚在 Node，不能建立第二份 Map 充当迁移完成。
下一批应按状态所有者、投影、订阅和连接宿主的依赖顺序推进：`workspace/runtime.js`
的 attachWorkspace 依赖 directories/clients、workspaceSnapshot、recentEvents、
queueSnapshot，以及 status/summaries/queueStatuses/metaClients/observers；
`session/workspace-service.js` 的 snapshot 又依赖 sessionQuery、workspaceFacts 和
目录 records。通用 `ws/connection-router.js` 还负责心跳、认证/票据消费、分享绑定、
聊天和终端分流。移动 `/ws/workspace` 的 socket 不能替代这些状态与生命周期迁移。
owner 迁完后删除只读端口及 JSON 封送，再移动 addon 中的 source/auth owner。

协议升为 12，磁盘 schema 仍为 1。gateway、addon 和宿主必须配套部署/回滚，避免
已删路由落到旧前门的空缺；旧 writer 停止后才能启用另一套 owner。本批仅在隔离环境
验证，未提交、合并、推送、重启生产或更改生产配置。总体计划仍为 5/6，后续还有实时
状态与 WS、provider/其它域及聊天编排/持久化。

源码指纹 `fe62afc2e9d46e3521648717`，addon/gateway 来源校验和协议 12 启动探针通过。
落地页专项覆盖 122 组完整 HTTP 对拍、12 组文件系统对拍，确认请求不进入 Express；
12 MiB 文件 SHA-256、跨 64 KiB 边界范围读取和客户端断流后继续服务通过。真实
`gateway + server.js` 与 LAN 双实例 2/2 通过，包含页面字节与条件 HEAD 304 验证。
Rust 串行 core 417、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过；最后的
入口顺序修正后 gateway 30+32 已复验。验收平台为 macOS ARM64，其他平台安装包尚未验收。

最终完整 `npm test` 从头退出 0，末组 256/256；Electron 打包工具链和 pwsh
缺失各跳过 1 项。42 个 JS 语法、41 个 Rust 格式（保留原模块顺序）、837 项测试
分层、源码预算、治理和 `git diff --check` 通过。`HEAD...main=1/0`，累计 86 个
工作树条目（含此前批次）继续保留未提交。本批落地页迁移已验证，总体 Node 退出
尚未完成，下一步继续上述实时状态与 WS 依赖。


## 25. 工作区队列状态单一所有者（2026-11-09）

WS 迁移的下一项前置状态已迁入 `native/core/src/workspace_queues.rs`：每个工作区
runtime 的队列记录、归一化、过期更新判断与视图时钟现在归同一个 Rust Store。
删除 `src/workspace/runtime.js` 的 queueStatuses Map、normalizeQueueStatus、
queueViewTime 和相应判断。Node 只通过 RustWorkspaceQueues 封送输入、读取不可变
快照和交付事件，保留 get/has/size 的只读兼容视图，不持有第二份可写队列表。

物理执行的 updatedAt 与工作区视图时间分开：严格更旧的物理事件被拒绝，相同时间戳
仍能替换；只有时间变化时更新存储但不额外广播。壳会话切换到旧执行或无队列执行时，
视图仍生成更晚的时间戳，空队列可以清除前一个执行的展示；这不会污染物理事件时间，
后续较早但合法的执行事件仍可接受。状态字母复用 classify_vocab 的唯一常量表。
归一化保留现有 Number/String 语义、非有限值与负零处理及 UTF-16；不增加客户端字段。

原生内部直接传 Queue/Store 值，get/view 读取同一所有者，既不走 JSON，也不先取出
JS 队列再传回 Rust 归一化。尚在 Node 的 stateSource 元数据作为不透明引用附到返回
值，不遍历其中的循环引用或私有字段。边界只读取队列的四个输入字段，私有正文不会
被复制入状态。getter、数值转换和 clock 回调均在锁外执行；归一化完成后才读取当前
记录以拒绝过期更新，重入不能拿旧快照覆盖新队列。视图时间保留旧表达式的求值顺序
和异常时已发生的时钟推进。每个 runtime 独立持有队列，重建后通过既有 scheduler
queueSummaries 重新水合，无新增持久化文件或全局缓存。

Node 例外仍为实时 records/目录与成员读取、记录类型准入、游标和 sessionView 读取、
事件分流及 WS/observer 交付。这些依赖属于未迁移的状态/连接宿主，本批没有复制它们
或把 socket 迁移等同于生命周期迁完。status、summaries 和会话状态转换仍在 Node；
下一步继续这些状态及其持久化副作用，再迁目录/成员和订阅/WS 所有者。迁完相应依赖
后删除临时 N-API 读适配，调用同进程内的 Rust Store。

跨进程协议保持 12、磁盘 schema 保持 1；本批新增 addon 能力由源码指纹和启动探针
校验，旧 addon 不会静默回退到 JS 队列实现。部署/回滚仍须配套二进制及宿主，停止旧
进程后重建瞬态队列，不迁移生产数据。本批未提交、合并、推送、重启或改生产配置，
总体仍为 5/6。

源码指纹 `eb571715c533c41ad3c154ec`，addon/gateway 来源与启动探针通过。
106 项相关测试通过，包含 1,000 次旧/新运行时操作对拍和 94 组输入边界；覆盖水合、
相同/过期时间戳、游标切换、重连、目录迁移、私有字段、非有限数值、Unicode、getter
失败和重入、clock 异常/转换顺序、owner 隔离及只读快照。真实 WebSocket 的事件、
切换清空、重连快照和断开后的订阅清理与冻结旧实现一致；真实 gateway/server 与
LAN 双实例 2/2 通过。45 个 JS 语法、44 个 Rust 格式、837 项分层和源码预算通过。
Rust 串行 core 421、CPR 9 单元+27 集成、gateway 30 单元+32 集成全部通过。
最终完整 `npm test` 从头退出 0，末组 256/256。Electron 打包工具链与 pwsh 缺失
各跳过 1 项；原有重复气泡 S6 测试仍标记 TODO，未计为通过项，本批未修改它。
源码预算、治理和 `git diff --check` 通过。`HEAD...main=1/0`，累计 92 个工作树
条目（含旧批次）未提交。验证环境为 macOS ARM64，不代表其它平台安装包验收。
本批队列所有权迁移已验证；整体 Node 退出仍未完成，按上述依赖继续第 6 步。


## 26. 工作区运行状态与摘要单一所有者（2026-11-09）

`native/core/src/workspace_state.rs` 接管每个 runtime 的 status/summary 表、运行状态
词表与会话转换核心；`RustWorkspaceState` 接管初始化、状态发布及摘要副作用顺序。
删除 `src/workspace/runtime.js` 中两张 Node Map、水合、转换和摘要写入编排，
`src/session/state-transition.js` 仅保留原 API、默认参数和 clock/pendingWork 适配。
原生 Store/RunState/Status/Summary 直接传值，不增加镜像表或内部 JSON 编解码。
架构门禁仅允许已迁移的 state-transition 门面引用共享 native/runtime 加载器；
其他 session 模块仍受原有依赖边界约束。

保留运行段开始/结束、pendingWork 转 background、零时钟、Number(null)、相同状态
仅更新时间不广播等边界。摘要仍按内存摘要、record.summary、setTaskState、
saveBestEffort、广播的顺序执行；保存或交付异常不回滚此前已发布状态，前置读取与
转换异常不发布。getter、转换、clock、持久化和广播回调均在原生借用之外执行，
保留回调重入以及旧实现的异常优先级。

迁移期对象、函数、Symbol 和 BigInt 使用共享 `js_host_value` 不透明引用适配；
标量直接存原生值，不遍历私有字段、循环对象或调用 toJSON。JS 可追踪 anchor 加
Rust 弱引用防止跨边界循环保活，替换/删除后的槽位随所有者操作回收。读取 status/
summary 返回新的快照包装对象，保留其中不透明 payload 的引用身份；包装对象不再
作为绕过 owner 的写入口。现存生产消费者只读字段或显式删除，已逐项核查。

对抗性审查修复两类初始化差异：外层记录读取失败时关闭迭代器并保留原始异常；
每个条目按自身迭代器解构两个值，进入水合前关闭它，不依赖数字下标。实现落在共享
LiveValue 迭代适配中，覆盖条目提前结束、next/return 抛错和外层关闭顺序。
会话转换还保留动态 status getter 的第二次返回值与原始 TypeError 文本。

Node 例外仍是实时 records/directories/chatSessions、现存 setTaskState 和
saveBestEffort writer、游标/sessionView、事件分流与 WS/observer 交付。本批迁移的是
状态所有权和副作用编排，未迁完任务状态或持久化 writer，更未完成 WS 宿主。下一步
先继续实时记录/目录成员与任务状态、持久化所有者，再迁订阅与 WS；相应原生所有者
可同进程装配后删除临时 N-API/host 引用端口。provider、其余域和聊天编排/历史持久化
仍属于第 6 步开放范围。协议保持 12、磁盘 schema 保持 1，没有生产数据格式变更。

源码指纹 `75e0aa45fc7e721b840389df`，addon/gateway 来源与启动探针通过。
116 项专项全部通过，含 893 组会话转换输入、1,200 次状态/摘要生命周期对拍、
1,000 次既有队列操作与 94 组队列输入边界。覆盖副作用失败/重入、GC 回收、字段
顺序、非有限数值/UTF-16 和真实 WS 原始帧、重连与订阅清理。

最终产物的真实 gateway/server 和 LAN 双实例 2/2 通过。Rust 串行 core 424、
CPR 9 单元+27 集成、gateway 30 单元+32 集成通过；最后一次修改仅涉及 addon 的
迭代适配，core/CPR/gateway 源码未再变化。最终完整 `npm test` 从头退出 0，末组
256/256。Electron 打包工具链与 pwsh 缺失各跳过 1 项；既有重复气泡 S6 仍标记
TODO，未计入通过项。中途停止旧产物测试留下的 fake 浏览器 daemon 曾触发两项
清理断言；已核对 PID/本工作树路径后清理，两项独立复验和最终整轮回归均通过。

49 个 JS 语法、49 个 Rust 格式、837 项测试分层、源码预算、仓库产物和运行时写入
治理、`git diff --check` 通过。`HEAD...main=1/0`，累计 101 个工作树条目包含旧批次，
继续保留未提交。日志及摘要归档到主仓
`data/rust-source/75e0aa45fc7e721b840389df/validation/workspace-state/`。
验收环境为 macOS ARM64；其他平台安装包尚未验收。协议 12/schema 1 保持，
未提交、合并、推送、生产重启或更改生产配置。本批状态/摘要迁移已验证，整体仍为
5/6，后续继续上述实时记录、持久化与订阅/WS 所有者。

## 27. 会话记录表与持久化生命周期单一所有者（2026-11-09）

会话记录表、插入顺序和整条持久化生命周期现在只有 Rust 一个所有者：
`native/addon/src/session_records.rs` 的 `RustSessionRecords`，纯规则在
`native/core/src/session_records.rs`。Node 侧不再有第二张 Map：`server.js` 启动
解析出的 Map 交给 `src/session/records.js` 后立即丢弃，只留一个保持
`instanceof Map` 的门面指向原生表。没有 Node 回退路径。

迁入所有者的部分：脏标记/重试计时器/重试次数、事务快照与整表回滚、
`JSON.stringify` 记录数组（宿主端口）、原子写 `sessions.json`（文件 fsync +
父目录 fsync，`.bak1..3` 三档轮转）、任务状态默认值合并、`classifyUpdatedAt`
打戳规则、`task:state-changed` 事件、聊天/工作区广播顺序、`{save:false}` 批量
标志、分类历史窗口追加。三处直写 `taskState` 的路径（任务删除重置在
`src/task-board/lifecycle-host.js`、分类历史在 `src/classify/state-machine.js`、
`src/workspace/air-routes.js` 已核实只读）全部改走所有者。

`src/session/persistence.js` 缩为 169 行，只做原生状态到 `PersistenceError` 的
映射；`src/routes/task-state-store.js` 缩为 68 行端口适配。删除的 Node 逻辑是
190 行快照/保存/回滚/重试实现和 50 行状态合并/打戳/广播主体。

保留的适配及原因：记录对象经 `js_host_value` 不透明宿主槽保持活引用，字段写入
仍保持身份与属性顺序；门面保留 `instanceof Map` 供仍做该判断的宿主使用；
`stringify`、计时器、`bus.emit`、聊天/工作区广播、`taskStatePayload` 与 `now`
是宿主端口，因为消费者仍在 Node。`getTaskState` 与线上报文都直接读原生表，不读
镜像。

验证：以 `tests/helpers/legacy-session-records.js` 冻结的旧实现做随机差分，
3 个种子各 1,200 步共 3,600 次操作；与 `StateStore` 逐字节比对落盘格式；旧版
裸数组、主文件损坏、有效备份、半写尾部夹具；重启重载；重入；身份与 GC。注入
四个故障（失败不回滚、无脏标记重试、无条件打戳、只轮转两档）均被测试捕获后还原。

源码指纹 `27f35300f545c32737a33223`，`ensure-source-rust.js` 重建后 Rust 工作区
640 项测试通过（core 单元 428，gateway 单元 30 加集成 32，其余 crate 含远程、
CPR 等），新增/改动文件 clippy 无告警。最终产物
`npm test` 从头退出 0：27 次 Node 测试运行共 6,508 项，6,505 通过、0 失败。
架构边界测试的白名单按既有先例把 `src/session/records.js`
列入原生核心端口（仅限 `../native/runtime`，未放宽其他模块）。两个新套件按复核
规则登记为 core/deterministic，发行核心集 392→394 项、deterministic 323→325、
命令 364→366，复核注记已写入发行一致性测试。整轮回归暴露上一批
状态转换差分测试的时钟抖动（`now` 缺省时两次对拍跨毫秒，约 1/19 偶发）；已在该
测试内固定 `Date.now`，15 次独立复跑全绿，不涉及产品代码。另一处整轮才暴露的
既有抖动是单实例启动器用例把 `port+1` 的任意 HTTP 响应都当作"走开了"；并行测试
文件可能占用该临时端口（本次拿到 404），现只把 `/readyz` 的 200/503 判为走开。
完整回归以 `MULTICC_RUST_PREBUILT_DIR` 指向指纹目录（而非其 `darwin-arm64`
子目录）重跑，桌面打包与独立包阶段均执行。Electron 打包工具
链与 pwsh 缺失各跳过 1 项；既有重复气泡 S6 仍标记 TODO，未计入通过项。本批推进 6b/6c 但均未完成：目录成员投影、WS/观察
者投递、游标选择、provider 与聊天编排/历史持久化仍未迁移，故不声明任何后端退出
验收项完成，整体账本仍为 5/6。日志归档到主仓
`data/rust-source/27f35300f545c32737a33223/validation/session-persistence/`。
验收环境为 macOS ARM64；未提交、合并、推送或重启生产服务。
