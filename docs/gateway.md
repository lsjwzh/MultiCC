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

- `multicc-gateway --version` → 输出一行 `multicc-gateway 3 <crate 版本>`，退出码 0。`3` 是协议版本（2 = 加了 `--stdin-lifeline`、Node 以 0 退出时前门随之退出；3 = 前门改为 L7，按客户端连接独占上游 HTTP 连接）；三处必须一致：这里、`scripts/build-rust-kernels.js` 的探测、`src/gateway-child.js` 的 `GATEWAY_PROTOCOL`。
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
- **ACCESS_TOKEN 热改**：Node 只在启动时读一次，之后只经 `POST /api/settings/access-token` 改（先写 env 文件、再换内存）。前门每次请求读 env 文件（`MULTICC_ENV_FILE`，缺省为包根 `.env`）里的 `ACCESS_TOKEN`：在它与前门启动时不同之前用启动值，变过之后一律跟文件走。
- **Express 行为**（`native/gateway/src/app/express.rs`）：`res.json` 的弱 ETag 与 `If-None-Match` → 304、204/304 去掉实体头、`HEAD`、Express 对已注册路径的自动 `OPTIONS` 应答（`Allow`）、`express.json({ limit: '50mb' })`（类型判断、utf-8/utf-16 字符集、gzip/deflate 请求体、strict 首字符、413/415/400）、终端 `safeErrorHandler` 的错误 DTO、`/api/*` 的 JSON gzip（≥1024 字节、`Vary: Accept-Encoding`）、`X-Multicc-Request-Id` / `X-Correlation-Id` / `X-Multicc-API-Version` 响应头，以及写到 stdout 的 `http_request` 日志行。路径匹配同 Express：不区分大小写、允许一个结尾 `/`、不解码；只认区分大小写的 `/api/` 前缀（Node 闸门与 gzip 都按区分大小写判断它）。原生路径上的其它方法照常转发给 Node。
- **差分验证**：每组路由搬走前，把原 Node 流水线（真实的 requestId、gzip、认证运行时、body parser、原路由、错误处理）与前门放在一起跑同一组请求，比对状态码、响应体、ETag、内容长度和相关响应头，以及最终落盘文件。

| 路由 | 原 Node 实现 | Rust 实现 | 差分 |
|---|---|---|---|
| `GET/HEAD/PUT/OPTIONS /api/run-config/presets`、`POST/OPTIONS /api/run-config/presets/merge` | `src/routes/run-config-presets.js`（已删） | `native/gateway/src/app/run_config_presets.rs` + `multicc_core::run_config_presets`，落盘 `multicc_core::state_file`（与 `atomicWriteJson` 同格式、0600） | 39/39 请求逐字节一致，落盘文件一致 |
| `GET/HEAD/OPTIONS /api/download`、`POST/OPTIONS /api/auth/download-ticket`、`GET/HEAD/OPTIONS /api/uploads/stats`、`DELETE/OPTIONS /api/uploads/cleanup` | `src/routes/file-transfer.js` 的 `createDownloadHandler` 与上传临时文件统计/清理、`src/routes/auth.js` 的 download-ticket 签发和闸门 ticket 分支、`src/auth-security.js` 的 download ticket（均已删） | `native/gateway/src/app/download.rs` + `uploads.rs`，`multicc_core::download_ticket`（ticket 存储搬进前门进程）、`multicc_core::http_send`（`res.sendFile`/`res.download` 的发送语义）；闸门的 ticket 豁免由 `multicc_core::http_gate::authorize` 自己实现 | 71/71 请求逐字节一致（含百分号解码回退、中文文件名、ticket 目标归一化与复用、临时目录清理计数） |
| `GET/HEAD/PUT/OPTIONS /api/settings/quota-guard` | `src/routes/quota-guard.js`（已删）、`src/quota/quota-guard.js` 的配置读取/归一化、额度判定与刷新节流（已移除） | `native/gateway/src/app/quota_guard.rs` + `multicc_core::quota_guard` / `settings`，运行时通过 `RustQuotaGuard` 与无损 napi 接口调用同一内核 | 10,096 组策略对拍一致；136 组 HTTP 请求的状态、正文、相关响应头与落盘字节一致 |

额度保护默认对官方账号启用，5 小时、周、月窗口均以 98% 为阈值。只有达到阈值且 reset 仍在未来的读数才能阻断；多窗口按使用率、再按 reset 降序选择。阻断读数超过默认 30 分钟后放行并通知宿主刷新，失败刷新写入的 `lastAttemptAt` 同样重置读数年龄，避免每次请求都重试不可达上游。刷新通知按账号至少间隔 60 秒。

配置优先级为默认值 → `<data>/quota-guard.json` → 环境变量。API 立即返回保存后的有效配置，并报告环境覆盖字段；运行时保留原来的 5 秒配置缓存，到期才采用新值。文件格式仍为两空格缩进、结尾换行、新文件模式 0644；未知保存字段及 UTF-16 孤立代理项原样保留。无效输入在写入前拒绝，缺失或损坏的配置按未保存处理。原子替换失败时 Rust 会清理本次创建的临时文件。

环境入口保持不变：`MULTICC_QUOTA_GUARD`、`MULTICC_QUOTA_GUARD_PERCENT`、`MULTICC_QUOTA_GUARD_5H_PERCENT`、`MULTICC_QUOTA_GUARD_WEEKLY_PERCENT`、`MULTICC_QUOTA_GUARD_MONTHLY_PERCENT`、`MULTICC_QUOTA_GUARD_SCOPE`、`MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS`。

这批保留的 Node 例外仅为宿主适配：读取现有 provider-limit cache 对象、写日志、调用已有异步刷新回调，以及保持同步 JS 导出接口。规则、文件读写、配置缓存与节流均在 Rust；等这些缓存和刷新生命周期迁入 Rust 后删除该桥，不在桥中添加新的业务规则。源码启动预检要求新的 `RustQuotaGuard` / `quotaGuardRequestValue` 导出，旧原生模块不能静默绕过保护。验证在 macOS ARM64 隔离进程中完成，没有使用真实账号、修改生产配置或重启现有服务；不作为其他平台验收或性能收益结论。

源码启动复用外部目录的前门时，还校验产物记录的源码指纹和文件摘要；同一协议号不足以证明新增路由存在。来源不匹配时重新构建，构建失败或产物来源仍无法确认则停止启动。

与 Node 的已知差异：

- Node 关停期间（`/api` 一律 503 `SERVER_SHUTTING_DOWN`）原生路由照常应答：它们不往 Node 里排任何工作。
- `charset=utf-32` / `utf-7` 的 JSON 请求体返回 415（body-parser 经 iconv-lite 能解）。
- `/metrics` 里 `multicc_auth_*` 计数不含原生路由上的请求。
- 额度配置写入失败仍返回 500，临时文件名称由 Rust 生成；错误中的临时路径因此不同，失败后不再留下临时文件。
- `http_error` 日志行的 `detail` 是原因短语，没有 JS 调用栈。
- 用启动器环境（而非 `.env`）提供 `ACCESS_TOKEN`、又在网页上改过一次、之后 Node 被重拉：Node 回到环境里的值，前门仍认 `.env` 里改过的值。

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
`git diff --check` 均通过。入口这一批目前保留为任务工作树修改，尚未提交合并；
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
本批与上一批入口修改仍在工作树，未提交、未合并，未重启或修改生产配置。

## 测试钩子

仅供测试使用。两者都从前门进程环境读取（即在 `.env` 合并之后生效），只影响前门自身的等待和退避，不改变协议；取值非法时退回默认值，生产环境无需设置。

| 变量 | 默认 | 含义 |
|---|---|---|
| `MULTICC_GATEWAY_UPSTREAM_WAIT_MS` | `30000` | §6 里上游暂不可达时持有客户端连接、每 100ms 重试的总时长（毫秒）；超过后写回 503。 |
| `MULTICC_GATEWAY_BACKOFF_SCALE` | `1` | §7 里崩溃退避阶梯（0.5→1→2→4→8→16→30s）和退出码 75 的 0.2s 快速重试统一乘以此系数，用来把集成测试从分钟级压到毫秒级。非有限值或负数按 1 处理，上限 1000。 |
| `MULTICC_GATEWAY_TEST_ROUTES` | 未设置 | 设为 `1` 时 Router 额外注册测试路由 `GET /__gateway_test/native`（§6），证明请求由 Rust 应答。生产环境不要设置。 |
