# MultiCC HTTP 路由迁移清点（route inventory）

生成时间：2026-11-07。范围：本 worktree `task-88a969353c0b716636b714b302483a39` 的只读清点，没有启动/重启服务，也没有跑任何测试。行号均指本 worktree 当前文件。

## 0. 口径与方法

- 主表由 `server.js` + `src/**/*.js` 中所有 `app.{get,post,put,patch,delete,use}` / `router.{...}` 注册行扫描得到，共 **493 条注册、102 个文件**。`USE` 行按一条注册计，挂载的 sub-router 未展开，所以 493 不是最终 endpoint 数。
- `plugins/cron`、`plugins/bridges/*`、`src/docs-registry.js` 的路由挂在传入的 `app` 上（不是模块自身的 `app`/`router` 常量），静态扫描没抓到，已手工补入；补入后总数 **570 条注册、109 个文件**。
- 依赖分类：`a` = Node 进程内内存态（session Map、WS 客户端、任务/job Map、缓存）；`b` = 持久化状态（JSON/SQLite/JSONL，含其它写者或 Node 侧缓存）；`c` = 派生进程或外部网络；`d` = 已经是 Rust 内核的薄桥。未逐行通读的文件，其分类按路由名与 import 推断（表中不带 `*` 标记，但 `a/b` 边界应按实际 handler 再核）。
- Tier 定义按任务书：**T0** = 纯函数/静态/只读配置，现在就能搬；**T1** = 只依赖持久化状态；**T2** = 依赖 Node 进程内内存态。
- 另有一个并行 agent 正在改 `native/gateway`、`docs/gateway.md`、`src/gateway-child.js` 与若干脚本；本文没有读取它们的未提交状态，迁移顺序也不依赖它们的中间态。

---

## 1. HTTP pipeline（server.js / src 模块）

总体事实：**没有 CORS 中间件、没有 Helmet、没有 rate-limit、没有 cookie-parser、没有 `compression` 包、没有 body-parser 包、没有 `app.set('trust proxy')`**。`package.json` 里也不存在这些依赖。gzip 是自研的 `/api/*` JSON 压缩；cookie 解析是 10 行的本地函数。Express 4 默认行为（`express.json` 只在显式位置安装）决定了大量路由没有全局 body 解析。

按注册顺序：

1. **`.env` 预加载** — `server.js:11-18`。在创建 Express app 之前把包根 `.env` 的 `KEY=VALUE` 塞进 `process.env`（已存在的环境变量优先）。随后 `server.js:20-30` 剥掉继承的 provider routing 标记，避免子 CLI 误用父进程线路。
2. **access token / authSecurity 初始化** — `server.js:364`。`ACCESS_TOKEN = networkPolicy.accessToken`；`createAuthSecurity({ getSecret: () => ACCESS_TOKEN })`。`networkPolicy` 由 Rust `network_policy` 内核解析（`src/network-policy.js:17-19`）。
3. **请求 ID + JSON gzip** — `server.js:380`：`app.use(requestIdMiddleware, require('./src/http/json-compression').jsonCompression)`。
   - `requestIdMiddleware`（`src/http-errors.js:37-83`）：接受 `x-request-id`（正则 `/^[A-Za-z0-9._:-]{1,128}$/`），否则 4 字节随机 hex；`x-correlation-id` 同理，缺省等于 request id；设置响应头 `X-Multicc-Request-Id`、`X-Correlation-Id`、`X-Multicc-API-Version: v1`；在 `finish`/`close` 时写 `http_request` 日志（method/path/status/durationMs，aborted 标记）。
   - `jsonCompression`（`src/http/json-compression.js:28-60`）：只处理 `/api/*`、非 HEAD；拦截 `res.end`；要求 `Accept-Encoding` 含 gzip、`Content-Type: application/json`、body ≥ 1024 字节、非 204/304、无既有 `Content-Encoding`；加 `Vary: Accept-Encoding`；异步 `zlib.gzip` 后重写 `Content-Length`。
4. **router tool host** — `server.js:381` 调 `routerToolHost.mount(app)`（`src/router-tool-host.js:115-160`）。注册 `POST /api/internal/router-tools/:tool`，局部 `express.json({ limit: '768kb' })`，`isLocalRequest(req)` 才放行；当 tool=`dispatch_master` 且 `arguments.mode==='sync'` 时改为 `application/x-ndjson` 流式写 progress/result。
5. **auth runtime 整块** — `server.js:387-402` 调 `authRuntime.mountRoutes(app)`（`src/routes/auth.js:122-352`），内部顺序：
   1. `app.use('/api', ...)` shutdown gate：服务开始关闭后所有 `/api` 直接 503 + `Retry-After: 1`（`auth.js:126-135`）。
   2. `app.use(...)` peer allowlist：`!networkPolicy.lanOnly || isPrivateRequestPeer(req)`，否则 403 `DIRECT_PUBLIC_ACCESS_DISABLED`（`auth.js:141-155`）。
   3. `GET /login`（`auth.js:158-192`，内联 HTML 登录页）、`POST /login`（`auth.js:194-202`，`express.urlencoded({ extended: false })`，校验后写 cookie）、`GET /logout`（`auth.js:204-207`，清 cookie）。
   4. `app.use(...)` 总认证闸门（`auth.js:210-292`）：先 `handleServiceRequest` 拦截 `/services/<name>` 反代；然后按豁免表放行；否则 `isAuthenticated` / scoped 授权；HTML 请求 302 到 `/login?redirect=…`，API 返回 403 `AUTH_REQUIRED`。
   5. `POST /api/auth/exchange`（`auth.js:294-310`，`x-access-token` 换 cookie，204）、`POST /api/auth/ws-ticket`（`auth.js:312-334`，json 4kb）、`POST /api/auth/download-ticket`（`auth.js:336-351`，json 4kb）。
6. **借道 provider relay 路由** — `server.js:411` 模型目录（`src/providers/relay-model-catalog.js`），`server.js:417` 余量查询（`/claude-proxy/:id/remote/quota`、`/codex-proxy/:id/quota`）。两者都在协议代理之前挂，鉴权靠 auth 闸门里的 `mcr1.*` 借道凭据。
7. **health/readiness/metrics** — `server.js:428` `GET /healthz`，`server.js:429` `GET /readyz`，`server.js:430-445` `GET /metrics`（同步遍历 `chatSessions` 计 activeTurns，返回 Prometheus 文本）。
8. **协议代理（Rust CPR）** — `server.js:1345-1352` 挂 claude（`providerRouterRuntime.mountProtocolProxies`，`protocols:['claude']`），`server.js:1357-1360` 挂 codex。SSE 是上游透传，不在这里做 gzip（`jsonCompression` 见 `headersSent` 就放行）。codex 前面还有 trace 中间件（注释见 `server.js:1354-1356`）。
9. **早期单条路由** — `server.js:643` `GET /api/repo-operations/:operationId`（`defaultRepoActor.status`）；`server.js:719` `mountPublicSessionAccessGuard` 对 `/api/sessions/:id` 与 `/api/v1/sessions/:id` 做 in-memory internal execution slot 拦截（`src/session/public-session-access.js:37-38`）；`server.js:941` `notesStore.mountRoutes` 挂 `GET /api/directories/:id/events`。
10. **machines + 全局 JSON parser + service-routes + quota-guard** — `server.js:1353` 一行内依次：
    - `machines.mount(app, express)`（`src/machines.js:41-101`）：先加 `/api/machines` 的 cross-site 拦截；`/api/machines/:machineId/proxy` 用 `express.raw({ type: () => true, limit: '48mb' })`；其余机器路由用局部 `express.json({ limit: '16kb' })`。
    - `app.use(express.json({ limit: '50mb' }))`：**从这里开始之后的全部路由才拿到全局 JSON body**。注册在 1353 之前的路由（auth、router-tools、claude proxy、repo-operations、notes、public guard、relay catalog/quota）没有全局 JSON parser。
    - `serviceRoutes.mountManagement(app)`：`/api/service-routes` GET/PUT/DELETE，自带 `authenticate` + Origin 同源检查（`src/service-routes.js:148-171`）。
    - quota-guard GET/PUT（`src/routes/quota-guard.js`）。
11. **codex 协议代理** — `server.js:1357`（必须在全局 JSON parser 之后，见上一行注释）。
12. **中段批量 API** — `server.js:1515` `GET /api/v1/providers`，`server.js:1528` run-config presets，`server.js:1535` `app.use(directoryModule.router)`，`server.js:1552` `app.use(memoModule.router)`，随后到 `server.js:2197` 之间的 session-/task-/provider-/quota-/voice-/oauth 等路由逐个挂载。
13. **artifacts** — `server.js:2206`（`src/artifacts.js:43-64`），注释明确“在 public static 之前认领 `/artifacts`”。
14. **静态资源** — `server.js:2213`（`src/routes/static-assets.js:58-183`）。
15. **IM bridges** — `server.js:2340` `app.use('/api/wechat', wechatBridge.router)`；`server.js:2352` feishu；`server.js:2364-2370` 循环挂 telegram/discord/slack（每个 `bridge.router`）。
16. **push / scan / air / orchestration / WS / triggers / events / 尾部管理面** — `server.js:2390` push，`server.js:2458` scan，`server.js:2529` air，`server.js:2722` orchestration，`server.js:2744` WS connection router，`server.js:2803` triggers，`server.js:2804` events host，`server.js:2842` 一行挂 cron、docs-registry、secrets-vault、annotation-live、remote-screen、plugins。
17. **终端错误处理** — `server.js:2902` `app.use(safeErrorHandler(logger))`，必须是最后一个。`safeErrorHandler`（`src/http-errors.js:89-120`）绝不回传 stack；500 一律 `internal_error`；只有 `err.safe === true` 的 message 才透出。

补充：`/services/<name>[/...]` 不是 Express 路由，而是在认证闸门里由 `handleServiceRequest` 先匹配（`auth.js:211`，`src/service-routes.js:126-147`）；它是反向代理，带自己的 `allowed()` 判定、508 环路保护、120s 超时与 WS upgrade。

---

## 2. Auth model（可逐字节复刻）

### 2.1 凭据来源

- 唯一共享密钥是 `ACCESS_TOKEN`。来源优先级：`process.env.ACCESS_TOKEN`（`.env` 预加载，`server.js:11-18`）→ Rust `network_policy` 解析结果（`src/network-policy.js:17-19`）。运行时值是 `server.js:364` 的 `let ACCESS_TOKEN`，可由 localhost UI 热改。
- **没有服务端 session store**。cookie 是无状态 HMAC；WS/download ticket 只存在进程内 `Map`。
- `.env` 路径：`MULTICC_ENV_FILE` 或包根 `.env`（`src/host-env.js:20-24`）。写 `.env` 用 `atomicWriteText` 并保留父目录 mode（`host-env.js:39-59`）。

### 2.2 Cookie

- 名字 `multicc_auth`；格式 `<body>.<sig>`：
  - `body = base64url(JSON.stringify({ v: 1, iat, exp, n }))`，`iat/exp` 是秒，`n = randomBytes(8).toString('base64url')`；
  - `sig = base64url(HMAC-SHA256(key=ACCESS_TOKEN, body))`；
  - `v = 1`（`COOKIE_VERSION`），TTL 30 天。
  - 实现：`src/auth-security.js:5-7, 90-96`。
- 校验（`auth-security.js:98-112`）：两段且非空 → `timingSafeEqualText(sig, expected)` → base64url JSON 可解析 → `v===1`、`iat/exp` 为整数 → `iat <= now+60`、`exp > now`、`exp > iat`、`(exp-iat)*1000 <= TTL+1000`。
- `Set-Cookie`（`src/routes/auth.js:69-72`）：`multicc_auth=<v>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`，当 `req.secure` 或 `x-forwarded-proto` 第一个值为 `https` 时追加 `; Secure`。没有 `Domain`、没有 `__Host-` 前缀、没有 `Partitioned`。
- 登出：`multicc_auth=; Path=/; HttpOnly; Max-Age=0`（`auth.js:205`）。

### 2.3 其它凭据

- **`x-access-token`**：与 `ACCESS_TOKEN` 做 timing-safe 全等（`auth.js:86`，`auth-security.js:114-117`）。
- **`Authorization: Bearer` / `x-api-key`**：只在 `/claude-proxy`、`/codex-proxy` 前缀下被接受，且必须是 `mcr1.*` 形式的 provider-scoped share 凭据；由 `providerRelayShares.authorize({credential, method, pathname})` 校验（`auth.js:13, 97-119`；`server.js:399`）。未授权时 fail closed。
- **query token**：只允许 `GET` 且路径不以 `/api/` 开头，用于旧书签把 `?token=` 换成 cookie（`auth.js:258-263`）。API/WS 的 query token 只有在显式环境开关下才启用：`MULTICC_ALLOW_LEGACY_TOKEN_QUERY`（`server.js:366`, `auth.js:87-91`）、`MULTICC_ALLOW_LEGACY_WS_TOKEN`/`MULTICC_ALLOW_LEGACY_WS_COOKIE`（`server.js:367-368`）。
- **scoped grants**：`x-multicc-machine-grant`（machines 授权，`server.js:399`）与 `x-multicc-fleet-token` / `x-multicc-fleet-grant`（fleet sharing 授权）。`authorizeScopedRequest` 由两者 OR 组成；异常时 fail closed（`auth.js:269-274`）。带 `x-multicc-machine-grant` 的请求不会走普通 `isAuthenticated`（`auth.js:275`）。
- **share token**：`/share/:token` 与 `/api/share/:token/{auth,session,entry,history}` 自行校验 share token/password（`auth.js:231-235`）；`/ws/chat?share=` 用同一 share 记录（`connection-router.js:107-119`）。
- **fleet share**：`/fleet-share/fleet_share_*`、`POST /api/fleet-shares/fleet_share_*/import`、同前缀 `ws-ticket` 豁免 ACCESS_TOKEN（`auth.js:239-243`）。
- **artifact capability**：`/artifacts/<id>[/...]`，`<id>` 是不可猜能力令牌，免登录（`auth.js:247`；正则同步注释在 `src/artifacts.js:32-33`）。
- **download capability**：`GET /api/download` + `download_ticket` 校验通过即免登录（`auth.js:251-253`）。

### 2.4 本机请求判定（request-locality）

`src/request-locality.js`：

- `LOOPBACK_ADDRESSES = {127.0.0.1, ::1, ::ffff:127.0.0.1}`（`:3-7`）。
- `FORWARDING_HEADERS` 包含 `forwarded`、`x-real-ip`、`via`、`cf-connecting-ip`、`true-client-ip`、`client-ip`、`x-client-ip`、`x-cluster-client-ip`、`x-original-forwarded-for`、`x-envoy-external-address`、`fastly-client-ip`、`fly-client-ip`、`cdn-loop`，并额外匹配任意 `x-forwarded-*`（`:9-23, 50-57`）。
- `isLocalRequest(req)`（`:62-67`）要求 **transport peer** `req.socket.remoteAddress` 是 loopback，且 **不存在任何 forwarding 元数据**，且 Host 是 `localhost`/`127.0.0.1`/`::1`，且 Host 不以 `.ts.net`、`.ngrok.io`、`.ngrok-free.app` 结尾（`:34-42`）。反向代理即使从 loopback 连进来，只要带 public Host 或转发头就判外网。`req.ip` 不参与判定（注释 `:63-64`）。
- `isPrivateRequestPeer(req)`（`:90-92`）覆盖 RFC1918、loopback、link-local、`100.64/10`（Tailscale）、IPv6 ULA/link-local。
- 认证里的用法（`src/routes/auth.js:74-93`）：没有 `ACCESS_TOKEN` 时只放行 `isLocalRequest`；有 token 时 local 请求直接放行，否则 cookie → `x-access-token` → 可选 legacy query。

### 2.5 Ticket（全部内存态）

`src/auth-security.js:76-77` 两个 `Map`：`tickets`、`downloadTickets`。

- **WS ticket**（`:134-155`）：24 随机字节 base64url；存 `sha256(ticket)` 为 key；TTL 30s；绑定规范化 pathname（只保留 path，不带 query）；**一次尝试即消费，包括 path 不匹配的失败尝试**；metadata 可带 `machineGrantId`/`correlationId`/`requestId`。
- **download ticket**（`:157-183`）：同样 24 字节 + sha256 key + 30s TTL，但**在 TTL 内可重复使用**，且严格绑定规范化目标 `/api/download?path=<p>[&inline=1]`；query 只允许 `path`/`inline`/`download_ticket`，`path` 恰好一个，`inline` 只能是 `1`（`normalizeDownloadTarget`，`:46-65`）。
- 清理：`pruneTickets`（`:119-132`）每 2048 条上限，并按 `expiresAt` 删过期。
- **重启后所有 ticket 失效**（纯内存）。迁移到 Rust 后如果 gateway 与 Node 分属两个进程，ticket 签发与消费必须在同一进程，或改造成带签名的无状态 ticket + 一次性重放表。

### 2.6 公开路由（认证豁免表）

精确列表见 `src/routes/auth.js:213-275`：

- `/login`、`/logout`、`/healthz`、`/readyz`；
- 非 `/api/` 且扩展名匹配 `js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|json|apk|ipa`；
- `GET /ios-ota/manifest.plist`；
- `POST /ios-ota/udid/callback/<64 hex>`，且 `Content-Type` 为 `application/pkcs7-signature` 或 `application/x-apple-aspen-deviceinfo`；
- `GET /ios-ota/udid/result/<64 hex>`；
- `POST /api/wait/<id>/resolve`（自带 per-wait token）；
- `GET /share/<token>`；`/api/share/<token>/{auth,session,entry,history}`；
- `GET /fleet-share/fleet_share_*`；`POST /api/fleet-shares/fleet_share_*/import`；`POST /api/fleet-shares/fleet_share_*/ws-ticket`；
- `/artifacts/<id>[/...]`；
- `GET /api/download` 且 download ticket 有效；
- `GET` 非 `/api/` 且 `?token=` 等于 ACCESS_TOKEN（换 cookie）；
- `/claude-proxy*`、`/codex-proxy*` 且 `mcr1.*` 借道凭据有效；
- `authorizeScopedRequest`（machine grant / fleet token）通过；
- 最后才 `isAuthenticated`。注意：带 `x-multicc-machine-grant` 的请求跳过 `isAuthenticated`。

### 2.7 持久化的 auth 相关文件

- ACCESS_TOKEN：`.env`（不在 `~/.multicc`）。
- `provider-relay-shares.json`（`src/paths.js:149`）：`mcr1.*` 借道 share。
- `shares.json`（`:133`）、`fleet-shares.json`（`:134`）、`external-fleets.json`（`:135`）：share/fleet 能力。
- `machines.json`（`:137`）：machines 授权（Rust computer registry 持有）。
- 没有 cookie/session 文件，没有 refresh token 表，没有 JWKS。

### 2.8 轮换与过期

- `POST /api/settings/access-token`（`src/routes/host-write.js:289-315`，挂载 `:362`）：**仅 localhost**；先写 `.env` 再 `setAccessToken`，失败回滚；在允许远程/公网 Funnel 时拒绝清空 token。
- cookie 过期 30 天；WS/download ticket 30 秒；无自动轮换、无服务端吊销列表。轮换 token 后旧 cookie 立即失效（签名 key 变了）——推断，但由 HMAC key 决定。
- 无 `HttpOnly` 之外的 CSRF token；写操作靠 SameSite=Lax + Origin 检查（service-routes 有显式 Origin 检查，其它路由没有统一 CSRF 中间件）。

---

## 3. 静态资源 / 前端托管

1. **public/ 根** — `src/routes/static-assets.js:164-182`：`express.static(publicDir, { extensions: ['html'], setHeaders })`。`publicDir` 是包内 `public/`。`content-type` 由 express 推断；`.apk` 强制 `application/vnd.android.package-archive` + attachment + no-store；`.ipa` 强制 `application/octet-stream` + attachment + no-store。
2. **HTML 重写与缓存** — `_serveVersionedHtml`（`:41-56`）：读 HTML，把本地 `<script src>` / `<link href>` 的 `.js`/`.css`（排除 `http(s):` 与 `//`）改写成 `?v=<file mtimeMs>`；HTML 响应 `Cache-Control: no-store, no-cache, must-revalidate`、`Pragma: no-cache`、`Content-Type: text/html`。所有 HTML 路由（包括 share 页）都必须走这个函数（注释 `:38-40`）。
3. **重定向** — `:65-112`：
   - `/manage`、`/manage.html` → `/air?view=…`（view 白名单 + 别名 `cron→schedules`、`tasks/planner→overview`）；
   - `/dashboard`、`/dashboard.html` → `/air?view=overview`；
   - `/air`、`/air.html` 且 `view=planner` → `/air?view=overview`；
   - `/` → `/air`，除非带 `id`/`newid`/`cwd`（终端会话书签）；`id=__aux__` → `/air?view=aux`。
4. **HTML 入口改写** — `:114-144`：GET 请求按路径找 `public/<rel>.html`（无扩展优先 `.html`）；`chat`、`chat.html`、`task-shell`、`task-shell.html` 在**不带** `?air=1&task=…`/`session=…` 时改送 `task-entry.html`；其它命中文件走 `_serveVersionedHtml`，未命中 `next()`。
5. **二进制白名单** — `:151-162`：除 `/multicc.apk`、`/multicc-ios.ipa` 外，任何 `.apk`/`.ipa` 都 404 且 no-store，防止误放进 `public/` 的包被下载。
6. **SPA fallback** — **没有**。未命中的路径直接落到 Express 默认 404（`static-assets.js` 只 `next()`）。
7. **artifacts** — `src/artifacts.js:43-64`：`app.use('/artifacts', headers, ...servedRoots().map(express.static))`；root 依次是 `MULTICC_DATA_DIR/artifacts` 与 `~/.multicc/artifacts`（legacy 只读）；`index: 'index.html'`、`dotfiles: 'ignore'`、`Cache-Control: no-store, must-revalidate`、`X-Content-Type-Options: nosniff`；`?download=1`/`?dl=1` 加 `Content-Disposition: attachment`，文件名取 basename 并去掉引号/CRLF（`:46-51`）。
8. **`/api/download`** — `src/routes/file-transfer.js:79-93`：`path` 必填；先按字面路径 `statSync`，失败再做一次 percent-decode 重试（处理 Markdown 双重编码，`:67-77`）；目录 400；`inline=1` 用 `res.sendFile`，否则 `res.download`。**没有根目录限制**（可以下载任意绝对路径），安全性完全依赖 auth / download ticket。
9. **`/api/files`、`/api/upload`、`/api/uploads/*`** — `file-transfer.js:40-65, 96-184`：目录列表、multer 单文件（`src/upload-middleware.js:10-22`：25 MiB、1 file、0 fields、2 parts、并发 4、临时文件 200 个/512 MiB）、上传统计与临时文件清理。
10. **service worker** — `public/sw.js`：`push` 显示通知（默认 URL `/manage`，`waiting`/`completed` 有 action），`notificationclick` 聚焦已有窗口或打开目标（`:69-100`），`pushsubscriptionchange` 重订阅。无离线缓存策略（虽然定义了 `CACHE_NAME`）。
11. **iOS OTA / APK 分发** — `src/routes/system.js:267-297`：`/api/server-info`、`/api/version-check`、`/api/apk-info`、`/multicc.apk`、`/api/ios-ota-info`、`/ios-ota/manifest.plist`；`system.js:278` 再挂 `ios-udid`，`:282-288` 再挂 developer-tools、macos-privacy、ops-terminal。

---

## 4. WebSocket 与 SSE / NDJSON 端点

### 4.1 WS

单一 upgrade dispatcher：`src/voice/host.js:128-131` 调 `wireUpgrade(server, wss, webProxy, serviceRoutes)`（`src/routes/voice-gateway-proxy.js:157-166`）。顺序：`serviceRoutes.handleUpgrade`（`/services/*`）→ `/voice-gateway/web` 的 HTTP/WS 反代 → 其余交给 `wss.handleUpgrade`，再进 `src/ws/connection-router.js`。

`wss` 由 `server.js:450` `new WebSocket.Server({ noServer: true })` 创建。

| 路径 | 用途 | 读取的状态 | 认证 |
|---|---|---|---|
| `/ws/chat?session=<id>` | 聊天流（turn 事件、用户输入、取消等） | `chatSessions`/`persistedSessions`、chat history、share 记录、provider turn 状态 | 普通 auth；或 `?share=<token>`；或一次性 ws ticket |
| `/ws/voice` | 语音 ASR 流 | `voiceAsr` 运行时（本地 sherpa/远端） | ticket / local / legacy |
| `/ws/tts` | TTS 流 | `ttsService` | ticket / local / legacy |
| `/ws/workspace?dirId=<id>` | Air/工作区实时同步 | `workspaceRuntime` 订阅 + directories | ticket / local / legacy |
| `/ws/meta` | workspace 元数据 | `workspaceRuntime.attachMeta` | ticket / local / legacy |
| `/ws/aux` | Aux 队列事件 | `auxQueue` + `loadChatHistory(auxSessionId)` 最后 100 条 | ticket / local / legacy |
| `/ws/remote-screen[?mode=h264]` | 远程屏幕 RFB/H264 | `remoteScreenRfb`（Rust 后端） | ticket / local / legacy |
| `/ws/machines/:machineId` | 到另一台电脑的桥 | consumed ws ticket 的 `upstream`、machine grant 是否 active | ws ticket（含 machineGrantId） |
| `/<任意>?id=<sessionId>` | 终端 PTY/tmux | `sessions` Map、`persistedSessions`、tmux；按需 `createSession` | ticket / local / legacy |

公共行为（`src/ws/connection-router.js:51-200`）：

- 连接即建 heartbeat：30s ping，连续 3 次没 pong 关闭（`:8-9`）；`close` 日志含 durationMs/wasClean。
- shutdown 中：close code `1012`（`:90-93`）。
- peer 不在 allowlist：close code `4003`（`:94-98`）。
- 机器桥优先：`bridgeMachineSocket(ws, urlObj, { authSecurity })` 命中即接管（`:104`）。
- share token 只对 `/ws/chat` 且 `session` 匹配时生效（`:107-119`）。
- ticket 认证：`consumeWsTicket(ticket, pathname)`，`machineGrantId` 必须仍 active；ticket 里的 fleet session/dir 必须与 query 匹配；否则 4003（`:121-156`）。
- legacy cookie/token 仅在两个环境开关下接受，并打 warn/metric（`:128-150`）。
- 非 local 且没有有效 ticket/legacy 凭据：4003（`:151-155`）。
- internal execution slot 会话拒绝（`:158-167`）。
- 之后按路径分派；终端默认分支会读 `sessions`/`persistedSessions`，必要时 `await createSession(sessionId)`（`:202-250`）。

### 4.2 SSE / 流式 HTTP

| 端点 | 文件:行 | 说明 |
|---|---|---|
| `GET /api/voice/test-sse` | `src/routes/voice.js:622-640` | `text/event-stream`，每 500ms 一条 chunk，3 条后 `[DONE]`；`X-Accel-Buffering: no`；客户端断开清 timer |
| `GET /api/machines/:machineId/proxy`（`Accept: text/event-stream`） | `src/machines.js:53-66` | 通过 Rust `machineEventStream` 把远端事件边读边写；`Cache-Control: no-store`；写压 >1MiB 时暂停 |
| `POST /api/internal/router-tools/:tool`（`dispatch_master` + `mode=sync`） | `src/router-tool-host.js:139-158` | `application/x-ndjson`，先 `progress` 帧后 `result` 帧 |
| `/claude-proxy/*`、`/codex-proxy/*` 的上游响应 | `src/providers/*`、`src/codex/official-relay.js:196-208` | 透传上游 `text/event-stream`；不算本服务的业务端点 |

`/api/events/*` 不是 SSE；事件通过 WS bus / push 投递。

---

## 5. 路由表（按文件分组）

说明：

- “注册”列是静态扫描到的 `app/router.*` 行；`USE` 是挂载点，未展开 sub-router。
- 依赖列：`a` 内存态、`b` 持久化、`c` 派生进程/外部网络、`d` Rust 薄桥、`-` 无状态。
- Tier 是**整组迁移**的判据，不是单条路由；同一文件内如果有一条依赖内存态，整组记 T2。
- `server.js` 只作为组合根，单列为“胶水”，不参与 T0/T1/T2 统计。

| 文件 | 路由数 | 行数 | 注册 (method path @line) | 依赖 | Tier |
|---|---:|---:|---|---|---|
| `server.js` | 7 | 2990 | GET '/healthz' @428<br>GET '/readyz' @429<br>GET '/metrics' @430<br>GET '/api/repo-operations/:operationId' @643<br>GET '/api/v1/providers' @1515<br>USE '/api/wechat' @2340<br>USE '/api/feishu' @2352 | 胶水 | 胶水 |
| `src/annotation-live.js` | 2 | 127 | GET '/api/annotation-live' @67<br>POST '/api/annotation-live' @70 | a | T2 |
| `src/artifacts.js` | 1 | 127 | USE '/artifacts' @64 | b | T0 |
| `src/cli/switch-runtime.js` | 7 | 1391 | POST '/api/sessions/:id/switch-cli' @1145<br>GET '/api/cli/install-specs' @1211<br>POST '/api/cli/:cli/install' @1239<br>GET '/api/cli/install-status/:jobId' @1273<br>GET '/api/cli/versions' @1291<br>POST '/api/cli/:cli/unpin' @1300<br>POST '/api/cli/:cli/upgrade' @1342 | a,b,c | T2 |
| `src/codex/official-relay.js` | 1 | 655 | POST `${proxyPath}/:providerId/responses` @643 | d | T0 |
| `src/directory/controller.js` | 10 | 64 | GET '/api/fs/list' @34<br>GET '/api/directories' @36<br>POST '/api/directories' @38<br>POST '/api/onboarding/sample-workspace' @42<br>PUT '/api/directories/order' @44<br>PATCH '/api/directories/:id' @47<br>DELETE '/api/directories/:id' @49<br>POST '/api/directories/:id/push' @52<br>GET '/api/directories/:id/uncommitted' @54<br>POST '/api/directories/:id/commit' @57 | a,b,c | T2 |
| `src/events/routes.js` | 8 | 43 | GET '/api/events/catalog' @9<br>GET '/api/events/recent' @12<br>GET '/api/event-triggers' @16<br>GET '/api/event-rules' @17<br>POST '/api/event-rules' @18<br>PUT '/api/event-rules/:id' @23<br>DELETE '/api/event-rules/:id' @28<br>POST '/api/events/test' @33 | a,b | T1 |
| `src/ios-udid.js` | 3 | 170 | GET '/ios-ota/udid.mobileconfig' @158<br>GET '/ios-ota/udid/result/:token' @159<br>POST '/ios-ota/udid/callback/:token' @160 | a,b | T1 |
| `src/machines.js` | 6 | 105 | USE '/api/machines' @45<br>USE '/api/machines/:machineId/proxy' @53<br>POST '/api/machines/pair' @76<br>DELETE '/api/machines/connection' @82<br>DELETE '/api/machines/grants/:grantId' @87<br>POST '/api/machines/:machineId/ws-ticket' @94 | a,b,d | T2 |
| `src/memo/router.js` | 3 | 32 | GET '/api/directories/:id/memo' @13<br>PUT '/api/directories/:id/memo' @16<br>POST '/api/directories/:id/memo/send' @20 | a,b,c | T2 |
| `src/notes-store.js` | 1 | 144 | GET '/api/directories/:id/events' @124 | b | T1 |
| `src/providers/rust-cpr.js` | 2 | 290 | POST `${prefix}/:providerId/:sessionId/:role/responses` @263<br>POST `${prefix}/:providerId/responses` @264 | d | T0 |
| `src/push/bark-devices.js` | 2 | 196 | GET '/api/push/bark-devices' @177<br>POST '/api/push/bark-devices' @178 | b,c | T1 |
| `src/push/channel-subscriptions.js` | 5 | 199 | GET '/api/push/channel-subscriptions' @184<br>PUT '/api/push/channel-subscriptions' @185<br>POST '/api/push/channel-subscriptions' @186<br>DELETE '/api/push/channel-subscriptions/:id' @187<br>POST '/api/push/test-channel' @188 | b | T1 |
| `src/push/fcm-devices.js` | 4 | 83 | GET '/api/push/fcm' @71<br>POST '/api/push/fcm' @72<br>DELETE '/api/push/fcm' @73<br>POST '/api/push/fcm/test' @74 | b,c | T1 |
| `src/push/runtime.js` | 7 | 501 | POST '/api/push/subscribe' @380<br>DELETE '/api/push/subscribe' @398<br>POST '/api/push/validate' @412<br>POST '/api/push/test' @417<br>POST '/api/push/notify' @430<br>POST '/api/push/test-bark' @453<br>POST '/api/push/test-webhook' @461 | a,b,c | T1 |
| `src/remote-screen-rust.js` | 1 | 609 | USE '/api/remote-screen' @557 | a,d | T2 |
| `src/routes/account-subscription.js` | 1 | 51 | GET `/api/${vendor}/subscription` @39 | b,d | T0 |
| `src/routes/agent-resources.js` | 6 | 252 | GET '/api/agent-resources/skills' @154<br>GET '/api/agent-presets' @165<br>GET '/api/agent-presets/:id' @183<br>GET '/api/agent-resources/claude-sessions' @191<br>DELETE '/api/agent-resources/claude-sessions/:project/:id' @201<br>DELETE '/api/agent-resources/claude-sessions' @216 | b | T1 |
| `src/routes/aliyun-quota.js` | 2 | 179 | GET '/api/aliyun/quota' @144<br>POST '/api/aliyun/quota/login' @160 | b,c | T1 |
| `src/routes/ark-quota.js` | 3 | 278 | GET '/api/ark/quota' @218<br>POST '/api/ark/quota/login' @244<br>POST '/api/ark/quota/install' @263 | b,c | T1 |
| `src/routes/auth.js` | 7 | 358 | USE '/api' @126<br>GET '/login' @158<br>POST '/login' @194<br>GET '/logout' @204<br>POST '/api/auth/exchange' @294<br>POST '/api/auth/ws-ticket' @312<br>POST '/api/auth/download-ticket' @336 | a,b | T2 |
| `src/routes/auto-provider-routing-test.js` | 1 | 103 | POST '/api/auto-provider/routing/test' @84 | b,d | T1 |
| `src/routes/aux-goal.js` | 10 | 945 | GET '/api/aux/status' @759<br>GET '/api/aux/health' @763<br>GET '/api/aux/history' @767<br>POST '/api/aux/enqueue' @773<br>POST '/api/aux/cancel' @792<br>GET '/api/aux/config' @799<br>POST '/api/aux/config' @820<br>GET '/api/settings/goal' @849<br>POST '/api/settings/goal' @855<br>POST '/api/goal/precheck' @861 | a,b | T2 |
| `src/routes/aux-runs.js` | 2 | 38 | GET '/api/sessions/:id/aux-runs' @12<br>GET '/api/sessions/:id/aux-runs/:runId' @25 | a,b | T2 |
| `src/routes/chat-history.js` | 3 | 838 | DELETE '/api/sessions/:id/messages/:msgId' @687<br>GET '/api/sessions/:id/history' @704<br>GET '/api/sessions/:id/context-level' @734 | a,b | T2 |
| `src/routes/claude-accounts.js` | 8 | 269 | POST '/api/claude/accounts/:id/activate' @65<br>GET '/api/claude/accounts' @150<br>POST '/api/claude/accounts' @154<br>GET '/api/claude/accounts/:id/login-status' @175<br>POST '/api/claude/accounts/:id/login-callback' @187<br>POST '/api/claude/accounts/:id/relogin' @214<br>DELETE '/api/claude/accounts/:id' @222<br>GET '/api/claude/accounts/:id/quota' @239 | b,c | T1 |
| `src/routes/claude-models.js` | 1 | 237 | GET '/api/claude/models' @214 | b | T1 |
| `src/routes/claude-oauth.js` | 2 | 185 | GET '/api/claude/oauth/status' @108<br>POST '/api/claude/oauth/login' @132 | b,c | T2 |
| `src/routes/claude-usage-quota.js` | 2 | 593 | GET '/api/claude/quota' @522<br>POST '/api/claude/quota/login' @559 | b,c | T1 |
| `src/routes/cli-key-accounts.js` | 4 | 83 | GET '/api/cli-accounts/:cli' @38<br>POST '/api/cli-accounts/:cli' @44<br>PATCH '/api/cli-accounts/:cli/:id' @53<br>DELETE '/api/cli-accounts/:cli/:id' @64 | b | T1 |
| `src/routes/codebuddy-models.js` | 1 | 103 | GET '/api/codebuddy/models' @78 | b | T1 |
| `src/routes/codex-accounts.js` | 7 | 275 | POST '/api/codex/accounts/:id/activate' @142<br>GET '/api/codex/accounts' @171<br>POST '/api/codex/accounts' @175<br>GET '/api/codex/accounts/:id/login-status' @205<br>POST '/api/codex/accounts/:id/login-callback' @217<br>POST '/api/codex/accounts/:id/relogin' @244<br>DELETE '/api/codex/accounts/:id' @258 | b,c | T1 |
| `src/routes/codex-models.js` | 2 | 459 | GET '/api/codex/models' @425<br>POST '/api/codex/models/sync' @440 | b | T1 |
| `src/routes/codex-oauth.js` | 2 | 84 | GET '/api/codex/oauth/status' @50<br>POST '/api/codex/oauth/login' @65 | b,c | T2 |
| `src/routes/codex-quota.js` | 1 | 153 | GET '/api/codex/quota' @122 | b | T1 |
| `src/routes/commandcode-auth.js` | 2 | 50 | GET '/api/commandcode/auth/status' @25<br>POST '/api/commandcode/auth/login' @28 | b,c | T2 |
| `src/routes/commandcode-models.js` | 1 | 112 | GET '/api/commandcode/models' @93 | b | T1 |
| `src/routes/developer-tools.js` | 4 | 224 | GET '/api/system/developer-tools' @214<br>POST '/api/system/developer-tools/install' @215<br>GET '/api/system/developer-tools/install-git' @216<br>POST '/api/system/developer-tools/install-git' @217 | b,c | T1 |
| `src/routes/doctor.js` | 4 | 24 | POST '/api/sessions/:id/doctor' @6<br>GET '/api/sessions/:id/doctor' @13<br>GET '/api/doctor/runs/:runId' @15<br>POST '/api/doctor/runs/:runId/cancel' @20 | a,c | T2 |
| `src/routes/env-doctor.js` | 3 | 24 | POST '/api/system/env-doctor' @8<br>GET '/api/system/env-doctor/:runId' @15<br>POST '/api/system/env-doctor/:runId/cancel' @20 | a,c | T2 |
| `src/routes/file-transfer.js` | 5 | 184 | GET '/api/files' @167<br>GET '/api/download' @168<br>POST '/api/upload' @169<br>GET '/api/uploads/stats' @170<br>DELETE '/api/uploads/cleanup' @171 | b | T1 |
| `src/routes/fleet-sharing.js` | 13 | 318 | POST '/api/fleets/:id/share' @268<br>GET '/api/fleets/:id/shares' @269<br>DELETE '/api/fleets/:id/share/:token' @270<br>GET '/fleet-share/:token' @271<br>POST '/api/fleet-shares/:token/import' @272<br>GET '/api/fleet-shares/:token/state' @273<br>POST '/api/fleet-shares/:token/ws-ticket' @274<br>POST '/api/external-fleets/import' @275<br>GET '/api/external-fleets' @276<br>DELETE '/api/external-fleets/:id' @277<br>POST '/api/external-fleets/:id/refresh' @278<br>POST '/api/external-fleets/:id/ws-ticket' @279<br>ALL '/api/external-fleets/:id/remote/*' @280 | a,b | T2 |
| `src/routes/grok-models.js` | 1 | 94 | GET '/api/grok/models' @70 | b | T1 |
| `src/routes/host-power.js` | 3 | 111 | POST '/api/settings/power' @46<br>POST '/api/settings/power/auto-unlock' @47<br>POST '/api/settings/power/unlock-password/authorize' @87 | b,c | T1 |
| `src/routes/host-read.js` | 10 | 281 | GET '/api/push/vapid-key' @247<br>GET '/api/push/health' @248<br>GET '/api/settings/notify' @249<br>GET '/api/settings/tunnel' @250<br>GET '/api/tunnel/funnel' @251<br>GET '/api/tunnel/ipv6' @252<br>GET '/api/tunnel/sakurafrp' @253<br>GET '/api/settings/access-token' @254<br>GET '/api/settings/power' @255<br>GET '/api/host/battery' @256 | b | T1 |
| `src/routes/host-write.js` | 7 | 399 | POST '/api/settings/notify' @357<br>POST '/api/settings/tunnel' @358<br>POST '/api/tunnel/restart/:provider' @359<br>POST '/api/tunnel/sakurafrp/public-url' @360<br>POST '/api/tunnel/funnel' @361<br>POST '/api/settings/access-token' @362<br>POST '/api/settings/task-attribution' @366 | b,c | T1 |
| `src/routes/kimi-auth.js` | 4 | 174 | GET '/api/kimi/auth' @38<br>GET '/api/kimi/auth/check' @51<br>PUT '/api/kimi/auth' @70<br>POST '/api/kimi/auth/login' @89 | b,c | T2 |
| `src/routes/kimi-quota.js` | 2 | 396 | GET '/api/kimi/quota' @343<br>POST '/api/kimi/quota/login' @371 | b,c | T1 |
| `src/routes/macos-privacy.js` | 7 | 221 | GET '/api/system/disk-access' @207<br>POST '/api/system/disk-access/open' @208<br>GET '/api/system/agent-permissions' @209<br>POST '/api/system/agent-permissions/open' @210<br>POST '/api/system/agent-permissions/restart' @211<br>GET '/api/system/agent-install' @212<br>POST '/api/system/agent-install/replace' @213 | b,c | T1 |
| `src/routes/memory-browser.js` | 5 | 897 | GET '/api/memory/graph' @757<br>GET '/api/memory/tree' @781<br>GET '/api/memory/file' @793<br>PUT '/api/memory/file' @818<br>DELETE '/api/memory/file' @853 | b | T1 |
| `src/routes/opencode-models.js` | 1 | 485 | GET '/api/opencode/models' @464 | b | T1 |
| `src/routes/opencode-quota.js` | 2 | 277 | GET '/api/opencode/quota' @242<br>POST '/api/opencode/quota/login' @260 | b,c | T1 |
| `src/routes/ops-terminal.js` | 4 | 360 | GET '/api/system/ops-env' @340<br>GET '/api/system/ops-run' @341<br>POST '/api/system/ops-run' @342<br>POST '/api/system/ops-run/stop' @343 | a,c | T2 |
| `src/routes/orchestration.js` | 16 | 644 | POST '/api/sessions/:id/scheduled-messages' @94<br>GET '/api/sessions/:id/scheduled-messages' @119<br>DELETE '/api/sessions/:id/scheduled-messages/:messageId' @130<br>POST '/api/sessions/:id/wait' @145<br>POST '/api/wait/:wid/resolve' @181<br>GET '/api/sessions/:id/waits' @215<br>GET '/api/v1/sessions/:id/waits' @236<br>DELETE '/api/wait/:wid' @250<br>POST '/api/sessions/:id/run-detached' @263<br>GET '/api/sessions/:id/detached' @316<br>GET '/api/sessions/:id/tasks' @331<br>GET '/api/sessions/:id/dispatches' @346<br>POST '/api/sessions/:id/user-input/dismiss' @433<br>GET '/api/sessions/:id/queue' @447<br>POST '/api/sessions/:id/queue/action' @458<br>GET '/api/detached/:taskId' @631 | a,b | T2 |
| `src/routes/plugins.js` | 11 | 453 | GET '/api/plugins' @381<br>GET '/api/plugins/catalog' @387<br>POST '/api/plugins/catalog/refresh' @392<br>POST '/api/plugins/:id/install' @400<br>POST '/api/plugins/:id/uninstall' @401<br>POST '/api/plugins/:id/rollback' @405<br>POST '/api/plugins/:id/run' @409<br>GET '/api/channels' @416<br>POST '/api/channels/recheck' @428<br>GET '/api/channels/targets' @440<br>GET '/plugins/:id/*' @446 | a,b,c | T2 |
| `src/routes/pricing.js` | 4 | 111 | GET '/api/pricing/status' @61<br>GET '/api/pricing/lookup' @65<br>POST '/api/pricing/refresh' @83<br>GET '/api/pricing/search' @90 | b,c | T1 |
| `src/routes/provider-balance.js` | 2 | 403 | GET '/api/providers/balances' @314<br>GET '/api/providers/:appType/:id/balance' @321 | b,c | T1 |
| ~~`src/routes/provider-limit-history.js`~~（已迁至前门，见 docs/gateway.md §9） | 1 | 91 | GET '/api/providers/limit-history' @47 | b,d | T0 |
| `src/routes/provider-models.js` | 1 | 240 | GET '/api/providers/:id/models' @203 | b,d | T1 |
| `src/routes/providers.js` | 17 | 880 | GET '/api/providers' @281<br>GET '/api/providers/stats' @362<br>POST '/api/providers/import' @385<br>POST '/api/providers' @393<br>PATCH '/api/providers/:appType/:id' @417<br>DELETE '/api/providers/:appType/:id' @440<br>POST '/api/providers/:appType/:id/probe' @489<br>POST '/api/providers/:appType/:id/speedtest' @515<br>POST '/api/providers/:appType/:id/reassign-sessions' @641<br>POST '/api/providers/:appType/:id/relay-share' @697<br>POST '/api/providers/:appType/:id/relay-models/sync' @747<br>GET '/api/provider-relay-shares' @761<br>DELETE '/api/provider-relay-shares/:id' @770<br>GET '/api/provider-relay-shares/:id/code' @784<br>GET '/api/providers/:appType/:id/relay-import-code' @814<br>GET '/api/provider-defaults' @836<br>PUT '/api/provider-defaults' @837 | a,b,c,d | T2 |
| `src/routes/qoder-models.js` | 1 | 109 | GET '/api/qoder/models' @82 | b | T1 |
| `src/routes/qoder-quota.js` | 3 | 278 | GET '/api/qoder/quota' @232<br>POST '/api/qoder/quota/login' @252<br>GET '/api/qoder/quota/cookies' @262 | b,c | T1 |
| `src/routes/quota-bars.js` | 3 | 178 | GET '/api/quota/bars/idle' @158<br>GET '/api/quota/bars/state' @161<br>POST '/api/quota/bars/refresh' @166 | b | T1 |
| `src/routes/quota-guard.js` | 2 | 135 | GET '/api/settings/quota-guard' @91<br>PUT '/api/settings/quota-guard' @95 | b | T1 |
| `src/routes/qwen-audio-runtime.js` | 8 | 83 | GET '/api/voice-runtime' @69<br>GET '/api/v1/voice-runtime' @70<br>POST '/api/voice-runtime/install' @71<br>POST '/api/v1/voice-runtime/install' @72<br>GET '/api/directories/:id/voice-gateway/runtime' @73<br>GET '/api/v1/directories/:id/voice-gateway/runtime' @74<br>POST '/api/directories/:id/voice-gateway/restart' @75<br>POST '/api/v1/directories/:id/voice-gateway/restart' @76 | a,b,c | T2 |
| ~~`src/routes/run-config-presets.js`~~（已迁至前门，见 docs/gateway.md §9） | 3 | 125 | GET '/api/run-config/presets' @57<br>PUT '/api/run-config/presets' @69<br>POST '/api/run-config/presets/merge' @95 | b,d | T1 |
| `src/routes/scan.js` | 1 | 34 | GET '/api/scan/history' @30 | b | T0 |
| `src/routes/server-restart-route.js` | 2 | 146 | POST '/api/restart' @49<br>POST '/api/desktop-shutdown' @129 | a,c | T2 |
| `src/routes/session-admin.js` | 13 | 621 | GET '/api/v1/sessions' @372<br>GET '/api/v1/sessions/:id' @380<br>GET '/api/v1/directories/:id/workspace' @386<br>GET '/api/sessions' @395<br>POST '/api/sessions/:id/reclassify' @415<br>POST '/api/sessions/:id/mark-task-done' @441<br>POST '/api/sessions/:id/mark-goal-achieved' @475<br>POST '/api/reclassify-all' @499<br>GET '/api/directories/:id/sessions' @515<br>GET '/api/directories/:id/workspace' @526<br>GET '/api/sessions/:id' @532<br>POST '/api/debug/classify/:id' @544<br>GET '/api/debug/classify-test-cases' @576 | a,b | T2 |
| `src/routes/session-bundle.js` | 4 | 779 | GET '/api/sessions/:id/bundle' @579<br>GET '/api/sessions/:id/bundle.zip' @598<br>POST '/api/sessions/import' @675<br>POST '/api/sessions/import-zip' @711 | a,b,c | T2 |
| `src/routes/session-create.js` | 3 | 100 | POST '/api/sessions/:id/vendor-login-terminal' @36<br>PUT '/api/directories/:id/role-workers/:presetId' @56<br>POST '/api/directories/:id/sessions' @61 | a,b,c | T2 |
| `src/routes/session-git.js` | 16 | 1387 | GET '/api/sessions/:id/merge-status' @572<br>GET '/api/sessions/:id/diff' @582<br>GET '/api/sessions/:id/diff/files' @634<br>GET '/api/sessions/:id/diff/file' @708<br>GET '/api/git/log' @789<br>GET '/api/git/commit-files' @826<br>GET '/api/git/commit-diff' @845<br>GET '/api/git/directory-file-diff' @958<br>GET '/api/git/directory-status' @1007<br>GET '/api/task-board/tasks/:taskId/diff/files' @1091<br>GET '/api/task-board/tasks/:taskId/diff/file' @1158<br>POST '/api/task-board/tasks/:taskId/merge' @1222<br>POST '/api/task-board/tasks/:taskId/cleanup-worktree' @1252<br>POST '/api/sessions/:id/merge' @1277<br>POST '/api/sessions/:id/sync' @1291<br>POST '/api/sessions/:id/rebase' @1335 | a,b,c | T2 |
| `src/routes/session-lifecycle.js` | 4 | 467 | DELETE '/api/sessions/:id' @213<br>POST '/api/sessions/:id/relocate' @273<br>POST '/api/sessions/:id/restart' @285<br>POST '/api/sessions/:id/restart-spawn' @368 | a,b,c | T2 |
| `src/routes/session-memory.js` | 4 | 181 | GET '/api/sessions/:id/memory' @65<br>PUT '/api/sessions/:id/memory' @89<br>DELETE '/api/sessions/:id/memory' @119<br>POST '/api/sessions/:id/memory/action' @142 | a,b | T2 |
| `src/routes/session-meta.js` | 3 | 91 | POST '/api/sessions/:id/notes' @46<br>GET '/api/sessions/:id/liveness' @71<br>GET '/api/sessions/:id/notes' @80 | a,b | T2 |
| `src/routes/session-profile.js` | 2 | 643 | PATCH '/api/sessions/:id' @473<br>POST '/api/sessions/:id/fork' @483 | a | T2 |
| `src/routes/share.js` | 9 | 421 | POST '/api/sessions/:id/share' @378<br>GET '/api/sessions/:id/shares' @379<br>DELETE '/api/sessions/:id/share/:token' @380<br>POST '/api/sessions/:id/share-messages' @381<br>GET '/share/:token' @382<br>POST '/api/share/:token/auth' @383<br>GET '/api/share/:token/entry' @384<br>GET '/api/share/:token/history' @385<br>GET '/api/share/:token/session' @386 | a,b | T2 |
| `src/routes/skill-sync.js` | 2 | 50 | GET '/api/skill-sync/status' @41<br>POST '/api/skill-sync/run' @42 | b,c | T1 |
| `src/routes/static-assets.js` | 4 | 189 | GET ['/manage', '/manage.html'] @65<br>GET ['/dashboard', '/dashboard.html'] @87<br>GET ['/air', '/air.html'] @96<br>GET '/' @106 | - | T0 |
| `src/routes/subagent-defaults.js` | 2 | 257 | GET '/api/subagent-defaults' @97<br>POST '/api/subagent-defaults/sync' @112 | b,d | T1 |
| `src/routes/system.js` | 7 | 318 | GET '/api/server-info' @267<br>GET '/api/version-check' @268<br>GET '/api/apk-info' @269<br>GET '/multicc.apk' @272<br>GET '/api/ios-ota-info' @273<br>GET '/ios-ota/manifest.plist' @277<br>GET '/api/debug/codex-proxy-trace' @293 | a,b | T0 |
| `src/routes/task-board.js` | 5 | 1841 | GET '/api/task-board/directories/:dirId/retention' @1714<br>POST '/api/task-board/directories/:dirId/retention' @1715<br>POST '/api/task-board/tasks/:taskId/status' @1717<br>POST '/api/task-board/tasks/:taskId/relocate' @1725<br>POST '/api/task-board/tasks/:taskId/chat-session' @1728 | a,b,d | T1 |
| `src/routes/task-graph.js` | 1 | 302 | GET '/api/task-graph' @271 | b,d | T1 |
| `src/routes/task-planning.js` | 5 | 196 | POST '/api/task-board/tasks' @180<br>POST '/api/task-board/tasks/:taskId/update' @181<br>POST '/api/task-board/tasks/:taskId/title' @183<br>POST '/api/task-board/tasks/:taskId/planning' @186<br>POST '/api/task-board/tasks/:taskId/move' @188 | b,d | T1 |
| `src/routes/task-search.js` | 2 | 182 | GET '/api/task-board/search' @169<br>GET '/api/search/messages' @170 | b,d | T1 |
| `src/routes/token-usage.js` | 2 | 553 | GET '/api/token-usage/global' @484<br>GET '/api/token-usage/by-role' @496 | b,d | T1 |
| `src/routes/update-route.js` | 2 | 199 | GET '/api/update/status' @106<br>POST '/api/update' @110 | b,c | T2 |
| `src/routes/voice-gateway-global.js` | 14 | 267 | GET '/api/voice-gateway' @243<br>GET '/api/v1/voice-gateway' @244<br>PUT '/api/voice-gateway' @245<br>PUT '/api/v1/voice-gateway' @246<br>DELETE '/api/voice-gateway' @247<br>DELETE '/api/v1/voice-gateway' @248<br>GET '/api/voice-gateway/runtime' @249<br>GET '/api/v1/voice-gateway/runtime' @250<br>POST '/api/voice-gateway/restart' @251<br>POST '/api/v1/voice-gateway/restart' @252<br>POST '/api/voice-gateway/launch' @253<br>POST '/api/v1/voice-gateway/launch' @254<br>GET '/api/voice-gateway/launch/:launchId' @255<br>GET '/api/v1/voice-gateway/launch/:launchId' @256 | a,b,c | T2 |
| `src/routes/voice-gateway.js` | 8 | 162 | GET '/api/voice-gateways' @144<br>GET '/api/v1/voice-gateways' @145<br>GET '/api/directories/:id/voice-gateway' @146<br>GET '/api/v1/directories/:id/voice-gateway' @147<br>PUT '/api/directories/:id/voice-gateway' @148<br>PUT '/api/v1/directories/:id/voice-gateway' @149<br>DELETE '/api/directories/:id/voice-gateway' @150<br>DELETE '/api/v1/directories/:id/voice-gateway' @151 | a,b,c | T2 |
| `src/routes/voice.js` | 14 | 648 | POST '/api/voice/refine' @157<br>POST '/api/voice/feedback' @197<br>POST '/api/voice/confirm' @212<br>POST '/api/voice/progress-summary' @264<br>GET '/api/voice/vocab' @302<br>GET '/api/voice/readiness' @313<br>GET '/api/voice/hotwords' @317<br>POST '/api/voice/hotwords/reject' @322<br>DELETE '/api/voice/vocab/:term' @328<br>POST '/api/voice/stt' @335<br>GET '/api/settings/voice' @403<br>POST '/api/settings/voice/asr-model' @472<br>POST '/api/settings/voice' @486<br>GET '/api/voice/test-sse' @622 | a,c | T2 |
| `src/routes/workspaces.js` | 2 | 82 | GET '/api/workspaces/overview' @77<br>POST '/api/workspaces/sweep' @78 | a,c | T2 |
| `src/routes/zcode-auth.js` | 5 | 181 | GET '/api/zcode/auth' @41<br>POST '/api/zcode/auth/sync' @60<br>PUT '/api/zcode/auth' @78<br>POST '/api/zcode/auth/login' @94<br>GET '/api/zcode/auth/check' @156 | b,c | T2 |
| `src/secrets-vault.js` | 5 | 260 | GET '/api/secrets' @204<br>POST '/api/secrets' @207<br>POST '/api/secrets/:name/rename' @219<br>DELETE '/api/secrets/:name' @224<br>GET '/api/secrets/:name/value' @231 | b | T1 |
| `src/service-routes.js` | 4 | 176 | USE '/api/service-routes' @149<br>GET '/api/service-routes' @158<br>PUT '/api/service-routes/:name' @159<br>DELETE '/api/service-routes/:name' @168 | a,b,c | T2 |
| `src/session/public-session-access.js` | 2 | 46 | USE '/api/sessions/:id' @37<br>USE '/api/v1/sessions/:id' @38 | a | T2 |
| `src/task-shell/attribution-settings.js` | 1 | 48 | GET '/api/settings/task-attribution' @36 | b | T1 |
| `src/task-shell/routes.js` | 42 | 172 | GET '/api/task-shell-tasks/:taskId' @58<br>GET '/api/task-shell-tasks/:taskId/history' @59<br>GET '/api/task-shell-tasks/:taskId/artifacts' @65<br>GET '/api/task-shells/:shellId/artifacts' @66<br>POST '/api/task-shell-tasks/:taskId/fork' @71<br>POST '/api/task-shell-tasks/:taskId/messages' @72<br>GET '/api/task-shells/config' @79<br>GET '/api/sessions/:sessionId/context' @80<br>GET '/api/sessions/:sessionId/task-separation' @85<br>POST '/api/sessions/:sessionId/task-separation/:suggestionId' @86<br>POST '/api/task-shells' @87<br>GET '/api/task-shells/:shellId' @88<br>GET '/api/task-shells/:shellId/chat' @89<br>GET '/api/task-shells/:shellId/history' @90<br>GET '/api/task-shells/:shellId/task-index' @94<br>GET '/api/task-shells/:shellId/task-operations' @97<br>POST '/api/task-shells/:shellId/task-operations/preview' @99<br>POST '/api/task-shells/:shellId/task-operations' @103<br>GET '/api/task-operations/:operationId' @108<br>POST '/api/task-operations/:operationId/cancel' @109<br>POST '/api/task-operations/:operationId/undo' @111<br>GET '/api/task-shells/:shellId/attribution-decisions' @117<br>POST '/api/task-shells/:shellId/attribution-decisions/:decisionId/accept' @120<br>POST '/api/task-shells/:shellId/attribution-decisions/:decisionId/dismiss' @122<br>POST '/api/task-shells/:shellId/attribution-decisions/:decisionId/defer' @124<br>POST '/api/task-shells/:shellId/attribution-decisions/:decisionId/undo' @126<br>POST '/api/task-shells/:shellId/tasks/:taskId/independent-continue' @132<br>GET '/api/task-shells/:shellId/task-continuations' @134<br>GET '/api/task-continuations/:continuationId' @136<br>POST '/api/task-continuations/:continuationId/apply' @138<br>POST '/api/task-continuations/:continuationId/cancel' @140<br>POST '/api/task-continuations/:continuationId/retry' @142<br>GET '/api/task-shells/:shellId/relations' @148<br>POST '/api/task-shells/:shellId/relations' @150<br>POST '/api/task-shells/:shellId/relations/remove' @153<br>DELETE '/api/task-shells/:shellId' @156<br>POST '/api/task-shells/:shellId/links' @157<br>POST '/api/task-shells/:shellId/select-target' @159<br>POST '/api/task-shells/:shellId/tasks/resolve' @161<br>GET '/api/task-shells/:shellId/tasks/:taskId' @166<br>POST '/api/task-shells/:shellId/messages' @167<br>POST '/api/task-shells/:shellId/receipts/:receiptId/retry' @168 | a,b,d | T2 |
| `src/triggers/index.js` | 5 | 543 | GET '/api/sessions/:id/triggers' @412<br>POST '/api/sessions/:id/triggers' @418<br>PUT '/api/sessions/:id/triggers/:tid' @432<br>DELETE '/api/sessions/:id/triggers/:tid' @450<br>POST '/api/sessions/:id/triggers/:tid/test' @460 | a,b | T2 |
| `src/turn-ledger/runtime.js` | 3 | 200 | GET '/api/sessions/:id/turn-ledger' @169<br>GET '/api/sessions/:id/turn-hooks/codex-trust' @173<br>POST '/api/sessions/:id/turn-hooks/codex-trust' @181 | b | T1 |
| `src/workspace/air-routes.js` | 8 | 609 | GET '/api/air' @482<br>POST '/api/air/worktrees/reclaim' @499<br>GET '/api/air/resolve' @514<br>POST '/api/air/tasks' @524<br>GET '/api/air/tasks/:id' @563<br>GET '/api/air/tasks/:id/open' @566<br>POST '/api/air/tasks/:id/delivery/reconcile' @594<br>POST '/api/air/tasks/:id/roles' @598 | a,b | T2 |
| `src/workspace/air-sync-runtime.js` | 2 | 149 | GET '/api/air/sync' @122<br>GET '/api/air/page' @129 | a,b | T2 |
| `src/docs-registry.js` | 7 | 472 | GET /api/docs-registry @372<br>POST /api/docs-registry @386<br>PATCH /api/docs-registry/:id @401<br>DELETE /api/docs-registry/:id @414<br>POST /api/docs-registry/:id/start @422<br>POST /api/docs-registry/:id/stop @429<br>GET /api/docs-registry/:id/log @435 | a,b,c | T2 |
| `plugins/cron/cron-tasks.js` | 7 | 677 | GET /api/cron<br>POST /api/cron<br>PATCH /api/cron/:id<br>DELETE /api/cron/:id<br>POST /api/cron/:id/rebind<br>POST /api/cron/:id/run<br>GET /api/cron/:id/runs | a,b,c | T2 |
| `plugins/bridges/wechat-ilink.js` | 15 | 539 | GET /status<br>GET /login-status<br>GET /qrcode<br>GET|POST /config<br>GET|PUT|DELETE /gateway<br>POST /gateway/reset<br>POST /start<br>POST /stop<br>POST /send<br>GET /log<br>GET /events<br>POST /logout (mounted at /api/wechat) | a,b,c | T2 |
| `plugins/bridges/feishu-bridge.js` | 12 | 352 | 同构路由（/status,/config,/gateway,/gateway/reset,/start,/stop,/send,/log,/events），挂载于 /api/feishu | a,b,c | T2 |
| `plugins/bridges/telegram-bridge.js` | 12 | 272 | 同构路由，挂载于 /api/telegram | a,b,c | T2 |
| `plugins/bridges/discord-bridge.js` | 12 | 302 | 同构路由，挂载于 /api/discord | a,b,c | T2 |
| `plugins/bridges/slack-bridge.js` | 12 | 366 | 同构路由，挂载于 /api/slack | a,b,c | T2 |

---

## 6. 分层合计与迁移顺序

> 进度：已迁出 2 组（`run-config-presets` 与 `provider-limit-history`，前门原生应答，Node 代码已删）。迁移顺序里第 4、5 组实际依赖 Node 内存态（扫描环形缓冲、账户凭据），不是 T0，要等它们的状态先搬进 Rust。

### 6.1 合计

统计口径：每种 Tier 的文件数、注册数（含 `USE` 挂载行）、Node 代码行数（整文件行数，不做按 handler 折算）。插件/文档表三行单独补入后：

| Tier | 文件数 | 注册数 | Node 行数 | 说明 |
|---|---:|---:|---:|---|
| T0 | 8 | 18 | 1,755 | 纯静态/只读配置/Rust 薄桥；`system.js` 318 行、`static-assets.js` 189、`artifacts.js` 127、`provider-limit-history.js` 91、`scan.js` 34、`account-subscription.js` 51、`rust-cpr.js` 290、`official-relay.js` 655 |
| T1 | 49 | 163 | 13,469 | 只依赖持久化状态（JSON/SQLite/JSONL）或外部网络；不含 session/turn 内存态 |
| T2 | 51 | 382 | 18,836 | 依赖 Node 内存态（session Map、WS clients、waiter/dispatch/job Map、缓存），或插件运行态 |
| 胶水 | 1 | 7 | 2,990 | `server.js` 组合根与 health/metrics |
| **合计** | **109** | **570** | **37,050** | 其中主扫描 493 条 / 34,070 行，插件补充 77 条 / 2,980 行 |

读法注意：

- T2 的 382 条里，`src/task-shell/routes.js` 42 条、`src/routes/providers.js` 17 条、`src/routes/session-git.js` 16 条、`src/routes/orchestration.js` 16 条、`voice-gateway-global` 14 条、`voice` 14 条、`fleet-sharing` 13 条、`session-admin` 13 条，是“大头”而不是零散小路由。
- T1 的 13,469 行里有很大一部分是查询/校验/登录辅助代码，不是 handler 本身；行数用于估算删除收益，不用来估算迁移工作量。
- `server.js` 的 2,990 行是组合根；随着路由组迁走，它会同步缩小，但不应把 2,990 行计入任何单组。

### 6.2 推荐迁移顺序（前 10 组）

排序原则：先删“已经由 Rust 持有、Node 只是读写一份副本”的薄桥（风险最低、删除最干净）；再搬纯读写持久化配置；最后碰 session/turn/WS。每组都列出覆盖测试；测试若不在 `package.json` 的 tier 脚本里，需显式点名。

| # | 组 | 依据 / 为什么先做 | 覆盖测试 |
|---|---|---|---|
| 1 | ✅ `provider-limit-history`（1 条 / 91 行，T0；已迁至前门） | 数据已由 Rust `quota_history` 持有（`src/paths.js:158-161`），Node 只做 DTO 组装 | 网关集成测试 `native/gateway/tests/provider_limit_history.rs`（冻结 Node oracle 的 golden fixture） |
| 2 | ✅ `run-config-presets`（3 条 / 125 行，T1，`d`；已迁至前门） | Rust `run_config_presets` 已是权威；Node 侧只是校验 + 文件读写 | `tests/test-run-config-presets.js`（`test:security`、`test:core`） |
| 3 | `subagent-defaults`（2 条 / 257 行，T1，`d`） | Rust `subagent_defaults` 持有继承/清除逻辑；无 session 内存态 | `tests/test-subagent-defaults.js` |
| 4 | `account-subscription`（1 条 / 51 行，T0，`d`） | Rust `account_subscription`；单端点、DTO 窄 | `tests/test-account-subscription.js`（`test:provider-router`） |
| 5 | `scan`（1 条 / 34 行，T0） | 只读扫描历史文件；无派生进程；单文件 | `tests/test-scan-route.js`（`test:core`） |
| 6 | 模型目录 8 个文件（10 条 / 1,583 行，T1）<br>`claude-models`、`codex-models`、`opencode-models`、`qoder-models`、`grok-models`、`commandcode-models`、`codebuddy-models`、`provider-models` | 只读 provider 配置 + 模型缓存；Rust `provider_store`/`codex_models` 已有；彼此同构，可一次性抽公共层 | `tests/test-claude-models-route.js`、`test-codex-models-route.js`、`test-opencode-models.js`、`test-qoder-models-route.js`、`test-commandcode-grok-models-route.js`、`test-codebuddy-models-route.js`、`test-provider-models-route.js`（`test:provider-router`） |
| 7 | `agent-resources`（6 条 / 252 行，T1） | 只读 skills/presets/Claude session 列表；不碰 turn 内存态；删除面清晰 | `tests/test-agent-resources-routes.js`（`test:core`） |
| 8 | `secrets-vault`（5 条 / 260 行，T1） | `secrets.json` 0600 + 审计 JSONL；接口小、语义独立 | `tests/test-secrets-vault.js`、`tests/test-secrets-entry-visibility.js` |
| 9 | `token-usage`（2 条 / 553 行，T1，`d`） | 统计由 Rust `computeUsage` 内核产出；Node 只读 token_usage/token_daily/token_by_role | `tests/test-token-usage-routes.js` |
| 10 | `host-read`（10 条 / 281 行，T1） | 只读主机配置（notify/tunnel/power/battery/vapid）；无写路径 | `tests/test-host-read-routes.js`（`test:core`） |

紧接着可做的 11-12 组（不在“前 10”里，但风险同样低）：`file-transfer`（5 条 / 184 行，T1；`tests/test-file-transfer-routes.js`）、`turn-ledger`（3 条 / 200 行，T1；`tests/test-turn-ledger.js`）。

不建议先动的组：

- `static-assets` + `artifacts` 虽然是 T0，但 HTML `?v=mtime` 重写、`/chat` → `task-entry.html` 的跳转、`.apk/.ipa` 白名单都必须逐字节一致；放到 Rust 静态服务稳定后再搬，或整体交给 gateway 的静态层一次性替换。
- `auth` 是所有组的公共前置件（见第 7 节）；不能单独“迁移 auth 路由”，必须和它保护的组一起换。
- `session-*`、`task-shell`、`air`、`orchestration`、`voice`、`plugins`、bridges 全部依赖 Node 内存态或子进程，属于 T2 尾部。

### 6.3 测试接线提醒

- `tests/*.js` 不会自动发现；只有写进 `package.json` 的 `test:core` / `test:security` / `test:state` / `test:git` / `test:provider-router` / `test:task-first` 等脚本才会在 CI 跑。迁移某组前，先确认它的测试在哪个 tier 脚本里。
- `tests/test-classify-api-errors.js` 会打活服务、改写活跃会话，**本次调查没有运行，迁移验证时也不应运行**。
- CDP 套件（`test:cdp`）不在 `test`/`test:deterministic` 链路里，界面回归要单独跑。
- 与 `native/gateway` 改动相关的验证用 `tests/test-gateway-child.js`、`tests/test-request-locality.js`、`tests/test-http-error-boundary.js`、`tests/test-json-compression.js`。

---

## 7. Rust 侧迁移前置件（按依赖顺序）

这些是 T1/T2 组搬进 axum 之前必须先有的公共能力；每项给出 Node 权威实现位置。原则：**谁执行路由，谁必须持有对应状态**。auth cookie 是无状态的，可以留在 gateway；WS/download ticket 是内存态，必须和消费它的路由在同一进程（或改协议）。

| # | 前置件 | 必须复刻的契约 | Node 权威位置 |
|---|---|---|---|
| 1 | request id / 访问日志 | 接受 `x-request-id`/`x-correlation-id`（`[A-Za-z0-9._:-]{1,128}`），否则 4 字节 hex；响应头 3 个；`http_request` 日志字段与 finish/close 双路径 | `src/http-errors.js:31-83` |
| 2 | 统一错误 DTO | `{ok:false,error,code,apiVersion,requestId,correlationId,...}`；message 脱敏正则、240 字符截断；500 不泄漏 stack；`err.safe` 才透传 | `src/api-contract.js:44-84`；`src/http-errors.js:89-120`；策略文档 `docs/api-error-policy.md` |
| 3 | cookie 解析 + 认证 | `multicc_auth` 的 base64url(JSON)+HMAC 格式、30 天 TTL、`iat<=now+60`/`exp`/`v=1` 校验、timing-safe；`x-access-token` 全等；HTTP cookie 属性 | `src/auth-security.js:5-7, 90-117`；`src/routes/auth.js:69-93`；cookie 解析 `server.js:370-378` |
| 4 | 认证闸门与豁免表 | 先 shutdown，再 peer allowlist，再 `/login`/`/logout`，再 30+ 条豁免正则，最后 `isAuthenticated`；401/403/302 的分支条件；`AUTH_REQUIRED`/`DIRECT_PUBLIC_ACCESS_DISABLED`/`SERVER_SHUTTING_DOWN` 的 code 与 Retry-After | `src/routes/auth.js:74-93, 122-292` |
| 5 | request-locality | loopback peer 集合、forwarding header 全集、Host 白名单、`.ts.net`/ngrok 排除、`req.ip` 不参与 | `src/request-locality.js:3-92` |
| 6 | scoped 授权 | machine grant（Rust `machines` 已持有）+ fleet token（`shares/fleet-shares`）；`mcr1.*` provider relay share；无授权 fail closed | `server.js:399`；`src/machines.js`；`src/routes/fleet-sharing.js`；`src/routes/auth.js:97-119` |
| 7 | WS / download ticket | WS：24B base64url、sha256 key、30s、一次性（含错 scope）；download：同格式但可复用、绑定 canonical target；2048 上限 | `src/auth-security.js:119-183`；签发接口 `src/routes/auth.js:312-351` |
| 8 | body parser 与大小上限 | 顺序敏感：`/api/internal/router-tools` 768kb、`/api/machines` 16kb、`/api/machines/:id/proxy` 48mb raw、tickets 4kb、`/login` urlencoded、全局 `/api` 50mb（1353 之后才生效）、上传 25MiB/1 file/0 fields/2 parts/并发 4 | `server.js:1353`；`src/router-tool-host.js:118`；`src/machines.js:42,53`；`src/routes/auth.js:194,312,336`；`src/upload-middleware.js:10-22` |
| 9 | JSON gzip | 仅 `/api/*`、非 HEAD、`application/json`、≥1024B、非 204/304、无既有编码；`Vary: Accept-Encoding`；异步压缩 | `src/http/json-compression.js:28-60` |
| 10 | 静态/HTML 重写 | `?v=<mtime>` 正则与 no-store 头；`/manage`→`/air` 等 4 组重定向；chat→task-entry；`.apk/.ipa` 白名单；`express.static` 的 `extensions:['html']` | `src/routes/static-assets.js:41-56, 65-182`；`src/artifacts.js:43-64` |
| 11 | 文件下载语义 | `path` 字面优先 + percent-decode 回退；目录 400；`inline=1` 内联；无根目录限制 | `src/routes/file-transfer.js:67-93` |
| 12 | WS 生命周期 | 30s ping/3 次 miss；shutdown 1012；peer 4003；ticket 校验顺序；share token 只对 `/ws/chat`；internal slot 拒绝 | `src/ws/connection-router.js:8-12, 51-200` |
| 13 | upgrade 分发 | `serviceRoutes.handleUpgrade` → `/voice-gateway/web` 反代 → `wss`；顺序不可换 | `src/voice/host.js:128-131`；`src/routes/voice-gateway-proxy.js:157-166`；`src/service-routes.js:140-147` |
| 14 | /services 反代 | `allowed()` 规则、508 环路、120s 超时、WS upgrade、剥离 `x-multicc-*` 与 `multicc_` cookie | `src/service-routes.js:20-147` |
| 15 | 持久化状态所有权 | T1 组必须先列出“谁还写这份文件”：`sessions.json`/`directories.json`/`task_board.json`/`task-shells.sqlite`/`orchestration.sqlite`/`search-index.sqlite`/`provider-*.db`/`shares.json`/`fleet-shares.json`/`provider-relay-shares.json`/`machines.json`/`*.env` | `src/paths.js:50-208`；Rust 侧 `native/addon/src/*.rs` 已有 task board/store/repository、search、quota history、provider store、machines authz、run-config presets、subagent defaults |

### 7.1 迁移顺序上的硬约束

1. **auth 与 ticket 不能前置到 gateway 后与 Node 分居两进程**：`consumeWsTicket`/`verifyDownloadTicket` 读进程内 Map；若 gateway 签发而 Node 消费，必然 401。要么 ticket 全部由 gateway 消费（WS/下载也由 gateway 终结），要么改成签名 ticket + 共享重放表。
2. **`request-locality` 依赖 transport peer**：gateway 转发到 Node 后，Node 看到的 peer 是 gateway 的 loopback。迁移任何一个“local-only”路由（`/api/internal/router-tools`、`POST /api/settings/access-token`、部分 host-write、machines pair）之前，必须把 original peer 通过可信内部头传下来，并让 Rust 侧重新实现“forwarding header 存在即 fail closed”，不能简单信任 `X-Forwarded-For`。
3. **body parser 顺序是行为的一部分**：例如 claude proxy（1345）在全局 `express.json`（1353）之前，它自己处理 body；codex proxy（1357）依赖全局解析。Rust 侧若统一先解析 JSON，会改变 claude proxy 的原始流语义。
4. **静态/HTML 响应是逐字节契约**：`?v=mtime`、`Cache-Control`、chat 入口改写、artifacts 的两 root 顺序，必须由 gateway 或 Node 单点提供，不能两边各写一份。
5. **shutdown 与 peer 闸门在 auth 之前**：Rust gateway 接管端口后，503/403 的产生位置会改变；错误 code、`Retry-After`、`DIRECT_PUBLIC_ACCESS_DISABLED` 文案要按 `src/routes/auth.js:126-155` 原样保留。
6. **gateway 的 PROXY v1 / `multicc-gateway 3` / stdin lifeline 契约**以 `docs/gateway.md` 为准（该文件由并行 agent 维护，本次未改）。
