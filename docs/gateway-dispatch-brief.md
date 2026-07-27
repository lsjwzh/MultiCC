# Gateway 自动分发 — 实现 Brief (v1)

## 目标
Gateway 收到微信消息后，可决定把任务**分发**给某个具体 session。
- **要人确认**：分发前必须用户回「确认」才真正投递。
- **产出自动回流**：目标 session 跑完后，结果自动推回微信。
- **v1 只分发给 chat 类 session**；目标若没有 chat（terminal-only），临时创建一个同目录 chat 来接活。

## 现状（已核对代码）
- Gateway 是单例 chat 会话：`type='gateway'`，id=`__gateway__`（见 `wechat-ilink.js:28,307`）。
- 微信桥以 WS 客户端连 `/ws/chat?session=__gateway__`，把微信消息作为 Gateway 回合输入；读 Gateway 回复发回微信。
- `buildGatewayPrompt`（`server.js:923`）把 session 列表 JSON + 用户文本拼成 prompt。当前提示词明确「不要假装转发」，**无任何投递逻辑**。
- 普通 chat 回合触发逻辑全在 `handleChatWs` 的 `ws.on('message')`（`server.js:3326`）里，最终走 `spawnChat`（`server.js:3711`）；子进程退出 = 回合结束。
- 跨 agent 留言 `/api/sessions/:id/notes`（`server.js:1623`）限制同目录（`:1631`）、被动送达——**不复用**。

## 改动点

### 0. 前置重构（最关键）
把 `ws.on('message')`（`server.js:3326`～`3711`）里「构建 prompt → spawnChat → 流式 → 落库」的核心抽成可后台调用的函数：
```
async function runChatTurn(sessionName, text, { isFirstTurn, originDispatchId } = {})
```
WS 入口改为调用它。这样分发路径无需 WS 客户端也能触发目标 session 跑回合。

### 1. Gateway 输出结构化分发意图
改 `buildGatewayPrompt`（`server.js:923`）提示词：
- 删掉「不要假装已自动转发」，改为：需要分发时，在回复末尾输出一行标记
  `<<dispatch target="SESSION_ID">要交给该 session 的完整指令</dispatch>>`
- 仍可同时给自然语言说明。

### 2. 拦截 Gateway 回复 → 生成待确认
在 Gateway 回合**完成**处（runChatTurn 落库 assistant text 时，判断 `persisted.type==='gateway'`）：
- 正则解析 `<<dispatch target=...>...</dispatch>>`。
- 若命中：**不立即投递**，存
  `pendingDispatch = { id, targetId, message, createdAt }`（单例即可，新的覆盖旧的；或按目标存 Map）。
- 向 Gateway clients 广播一条确认提示（桥会转发到微信）：
  `「准备把任务投给 {targetId}：{message 摘要}。回复 确认 执行，回复 取消 放弃。」`
- 标记从展示给用户的文本里剥掉（用户不该看到 raw 标记）。

### 3. 入站确认/取消拦截
在 Gateway 收到新消息、**调用 buildGatewayPrompt 之前**（`server.js:3439` 一带）：
- 若存在 pendingDispatch 且文本匹配 `^(确认|确定|yes|y|ok)$` → 调 `dispatchToSession()`，清空 pending，**不跑 LLM**。
- 若匹配 `^(取消|算了|no|n)$` → 清空 pending，回一句「已取消」，不跑 LLM。
- 否则照常走 Gateway LLM（用户可能改主意/补充）。

### 4. dispatchToSession(targetId, message)
- 取 `persistedSessions.get(targetId)`。
- **保证有 chat 目标**：
  - 若该 record `kind==='chat'` → 直接用。
  - 否则（terminal-only）→ 在**同 dirId** 下创建/复用一个临时 chat session（复用 `app.post('/api/sessions')` 的创建逻辑，抽成 `createChatSession({dirId, cli, ephemeral:true})`）。命名如 `${targetId}-gw-chat`，打 `ephemeral` 标记便于后续回收。
- 调 `runChatTurn(chatSessionId, message, { isFirstTurn, originDispatchId })`。

### 5. 自动回流
- 给该次运行带 `originDispatchId`。
- 在回合完成处：若 `originDispatchId` 存在 → 取目标 session 最终 assistant text，推回微信。
  - 推送实现：复用桥的出站通道（`wechat-ilink.js` 内向微信发消息的路径，见 router `target==='wechat'` @ `wechat-ilink.js:699`），或向 `__gateway__` clients 广播一条带前缀的 system 消息让桥转发：
    `「{targetId} 回复：\n{result}」`

## 边界 / 待定（实现时注意，先用保守默认）
- 目标 session 正忙（已有回合在跑）：v1 直接拒绝并回提示「{targetId} 正在忙，稍后再试」，不排队。
- pendingDispatch 过期：>10 分钟未确认自动失效。
- 临时 chat 的回收：先不自动删，留 `ephemeral` 标记，后续做清理。
- 安全：dispatch target 必须在 persistedSessions 内且非 aux/gateway，否则回错误提示。

## 验收
1. 微信对 Gateway 说「让 metaads 看下今天预算」→ Gateway 回带确认提示。
2. 回「确认」→ 自动给 meta-ads 目录起临时 chat 并投递。
3. 该 chat 跑完 → 结果自动推回微信，前缀「metaads 回复：」。
4. 回「取消」→ 不投递。
