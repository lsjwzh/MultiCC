---
name: multicc-service-publish
description: multicc 自带「服务发布」技能。当你为用户做出并启动了一个本地 Web 服务（dev server、Flask/FastAPI、Streamlit/Gradio、脚本 HTTP 服务、自建 API…）并已登记到服务管理表后，主动询问用户「要不要通过 MultiCC 对外提供这个服务」；用户同意后把它挂到 MultiCC 的服务路由 /services/<名称>/ 下，手机、外网经 MultiCC 入口即可访问（默认要求 MultiCC 登录）。也用于用户说「发布到 multicc」「让手机/外网能访问这个服务」「通过 multicc 分享这个服务」「取消发布/下线服务路由」时。
---

# multicc-service-publish

本技能由 multicc 随安装自动铺设。它把**本机正在运行的 Web 服务**通过 MultiCC 的「服务路由」（反向代理）发布出去：

```
用户（手机/外网/隧道） ──> MultiCC 入口 /services/<名称>/...  ──代理──> http://127.0.0.1:<端口>/...
```

- 路由与 MultiCC **同域**，走 MultiCC 已有的隧道/域名，无需另开端口、另配隧道。
- 支持普通 HTTP 和 WebSocket（dev server 的热更新也能用）。
- 两种访问模式：`private`（默认，访问者必须已登录 MultiCC）和 `public`（免密码，任何能访问 MultiCC 入口的人都能用）。

运行环境：`MULTICC_BASE_URL`（默认 `http://127.0.0.1:3000`）、`MULTICC_SESSION_ID`。本机 curl 调用管理接口无需 token；Bash 若在沙箱里连不上本机端口，需关闭沙箱执行。

## 什么时候主动询问

满足以下全部条件时，在本轮结束前**问用户一次**是否发布：

1. 你启动（或帮用户启动）了一个用户会在浏览器里打开、或会被别的设备调用的 Web 服务；
2. 它已按「文档与服务登记」规则登记进服务管理表，且 `GET $MULTICC_BASE_URL/api/docs-registry` 里该条目 `status=up`；
3. 它还没有对应的服务路由（`GET $MULTICC_BASE_URL/api/service-routes` 里没有 `target` 指向该端口的条目）；
4. 本会话里用户没有对**这个服务**说过「不发布」。

不要问的情况：纯内部依赖（数据库、消息队列、只给本机脚本调用的端口）、测试过程中临时起停的服务、用户已经明确要求发布（直接按选择执行，不用再问）。同一服务只问一次，不要每轮重复。

### 怎么问

在 MultiCC 里调用 MCP 工具 `wait_for_user_answer`（旧名 `request_user_input`），然后把同样的问题作为本轮最后一段回复并结束本轮：

- question：`服务「<标题>」已在 127.0.0.1:<端口> 运行并登记。要不要通过 MultiCC 对外提供？发布后可在手机/外网通过 MultiCC 入口的 /services/<名称>/ 访问。`
- options：
  1. `发布（访问需登录 MultiCC，推荐）`
  2. `发布为免密码公开访问（任何能访问 MultiCC 入口的人都能用）`
  3. `暂不发布`

不在 MultiCC 里（没有该工具）时，就用普通文字问同样的问题。用户没选「免密码公开」时，**永远不要**自己选 public。

## 发布步骤（用户同意后）

### 1. 取路由名称

`<名称>` 只能是 1–48 位小写字母、数字、连字符，且以字母或数字开头（如 `sales-dashboard`）。从服务标题或项目目录名派生，先查 `GET /api/service-routes`，避免覆盖别人已有的同名路由（同名 PUT 会直接替换）。

### 2. 确认服务能在子路径下工作（最常见的坑）

代理会把 `/services/<名称>/foo` 转成上游的 `/foo`，并带上请求头 `X-Forwarded-Prefix: /services/<名称>`。页面里如果用**根路径绝对地址**（`/assets/app.js`、`fetch('/api/x')`），浏览器会去请求 MultiCC 的 `/assets/...`，结果白屏或 404。按框架处理：

| 服务类型 | 做法 |
| --- | --- |
| 纯静态 / `python -m http.server` / 相对路径引用的页面 | 通常无需改动 |
| Vite | 启动加 `--base /services/<名称>/`（或 `vite.config` 里 `base`） |
| Next.js | `next.config.js` 设 `basePath: '/services/<名称>'` |
| Create React App | `PUBLIC_URL=/services/<名称>` 或 package.json `homepage` |
| Streamlit | `--server.baseUrlPath services/<名称>` |
| Gradio | `launch(root_path="/services/<名称>")` |
| Jupyter | `--ServerApp.base_url=/services/<名称>/` |
| FastAPI / Starlette | `uvicorn ... --root-path /services/<名称>`，前端请求用相对路径 |
| Flask / Django | 用 `url_for`/`{% url %}` 生成链接，并开启信任 `X-Forwarded-Prefix`（Flask: `ProxyFix(app.wsgi_app, x_prefix=1)`） |
| 自写前端 | 资源与接口一律用相对路径（`./app.js`、`fetch('api/x')`） |

改了启动参数就重启服务，并把新的完整命令 PATCH 回登记表的 `startCmd`（见第 5 步），否则面板「一键启动」会用旧命令。

### 3. 创建服务路由

```bash
curl -s -X PUT "$MULTICC_BASE_URL/api/service-routes/<名称>" -H 'Content-Type: application/json' \
  -d '{"target":"http://127.0.0.1:<端口>","access":"private","enabled":true}'
```

- `target` 只写协议+主机+端口（可带路径前缀），不能带查询串、`#` 或账号密码。
- 用户**明确选了免密码公开**时才用 `"access":"public","acknowledgePublicRisk":true`；没有 `acknowledgePublicRisk:true` 时服务端会拒绝 public。
- 不要带 `Origin` 请求头（跨源写入会被 403 拒绝）。

### 4. 验证

```bash
# 首页应为 200（或服务自身的 30x）；502 = 上游没起来或端口不对；404 = 路由名不对/未启用
curl -s -o /tmp/svc-index.html -w '%{http_code}\n' "$MULTICC_BASE_URL/services/<名称>/"
# 再从首页里挑一个 JS/CSS/接口地址，按 /services/<名称>/<相对地址> 请求一次，确认不是 404
```

首页 200 但静态资源 404，几乎都是第 2 步的子路径问题，修好再交付。验证不通过时如实告诉用户卡在哪，不要说「已发布」。

### 5. 把登记表条目指向发布后的地址

让「服务与文档」面板里的链接在手机/外网也能点开：找到该服务条目的 `id`，把 `url` 改成相对路径（`port` 不变，探活照常按端口进行）：

```bash
curl -s "$MULTICC_BASE_URL/api/docs-registry" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))if(e.kind==="service"&&e.port===<端口>)console.log(e.id,e.title,e.url)})'
curl -s -X PATCH "$MULTICC_BASE_URL/api/docs-registry/<id>" -H 'Content-Type: application/json' \
  -d '{"url":"/services/<名称>/","note":"已通过 MultiCC 服务路由发布（private）；上游 http://127.0.0.1:<端口>/"}'
```

### 6. 交付给用户

回复里给**相对链接**（和 artifact 一样，前端会按用户当前的 MultiCC 入口打开，内网/外网/手机通用）：

- `[👉 打开 <标题>](/services/<名称>/)`
- 说明访问模式：private = 需先登录 MultiCC；public = 任何能访问 MultiCC 入口的人都能打开。
- 告诉用户可在「服务路由」页（`/service-routes.html`，Air 管理菜单 →「服务路由」）停用或删除，在 /manage「服务与文档」面板启停服务本身。

不要给 `http://127.0.0.1:...` 这类本机绝对地址当作对外链接。

## 下线 / 修改

```bash
curl -s "$MULTICC_BASE_URL/api/service-routes"                       # 查看全部路由
curl -s -X DELETE "$MULTICC_BASE_URL/api/service-routes/<名称>"        # 删除路由（服务进程不受影响）
# 暂停而不删除：重新 PUT 同名路由，带 "enabled":false
```

删除路由后，把登记表条目的 `url` PATCH 回 `http://127.0.0.1:<端口>/`。

## 安全须知（发布前心里要有数）

- 路由页面与 MultiCC **同域**：被发布服务的页面脚本可以以当前登录用户身份调用 MultiCC 接口。只发布你和用户信任的服务（自己写的项目、可信开源工具），不要发布来历不明的第三方页面。
- `public` 模式下，任何能访问 MultiCC 入口的人都能使用该服务的全部页面、接口和 WebSocket（包括写入、删除）。管理后台、数据库面板、含隐私数据或能执行命令的服务（Jupyter、终端类）**不要**建议 public；用户坚持时先复述风险再执行。
- 鉴权只保护 `/services/<名称>/` 这个入口，上游原始端口仍按它自己的监听地址暴露；服务尽量只监听 `127.0.0.1`。
- MultiCC 若开启了「仅局域网」策略，外网访问服务路由同样会被拒绝，这是预期行为。
