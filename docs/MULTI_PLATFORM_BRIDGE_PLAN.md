# 多平台 Bridge 实现计划（参考 hermes / 仿 feishu-bridge）

## 目标
为 multicc 增加除微信、飞书之外的 IM 平台桥接，gateway 模式与微信/飞书完全一致。

## 参考源
- Python 全平台协议参考：`~/.hermes/hermes-agent/gateway/platforms/{telegram,discord,slack,...}.py`
- TS 参考（更贴近 Node）：`/opt/homebrew/lib/node_modules/openclaw/extensions/{telegram,discord,slack}/src/`
- 落地模板（必须精确复刻结构）：本仓库 `feishu-bridge.js`
- gateway 集成参考：`server.js:4175-4196`（wechat/feishu init + mount）

## 契约（每座桥必须满足）
- `module.exports = { router, init, loadConfig, startBridge, stopBridge }`
- 专属 gateway 会话 `__<platform>_gateway__`，专属 cwd `~/.multicc/<platform>-gateway`
- 内部 chat WS 连 `ws://127.0.0.1:<port>/ws/chat?session=__<platform>_gateway__`
- 入站长连接（NAT 后可用）→ 提取文本 → `_sendUserMessage`；出站分块 + echo 抑制 + 日志
- 命令 `/help /status /reset`；REST `/status /config /gateway(GET/PUT/DELETE) /gateway/reset /start /stop /send /log /events(SSE)`
- SDK 懒加载，`<platform>-config.json` 存凭证，剥离 `<<dispatch>>` marker

## 分工
| 工人 | 平台 | 文件 | 入站 | SDK |
|---|---|---|---|---|
| codex | Slack | slack-bridge.js | Socket Mode | @slack/bolt |
| deepseek | Telegram | telegram-bridge.js | long-polling | node-telegram-bot-api |
| glm | Discord | discord-bridge.js | Gateway WS | discord.js |

## 防撞规则
工人只新建各自 bridge 文件，不改 server.js / package.json / public。挂载与依赖由 commander 统一集成。

## 集成（commander 自己做，3 桥都回来后）
- server.js: require + init + `app.use('/api/<platform>', bridge.router)`
- package.json: 加 3 个 SDK 依赖（^ 最新稳定版）
- 可选：public 管理页（后续）
