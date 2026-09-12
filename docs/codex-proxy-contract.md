# Codex 协议代理端点 — 接口契约（权威）

> 现状（2026-09-12 起）：**Responses↔Chat 协议转换桥（原模块 A/B）已退役。**
> 主流国产服务商（DeepSeek、GLM、Qwen、MiniMax、Moonshot、XFYun、StepFun、
> 火山方舟）均已原生提供 `/responses`（探测返回 401 而非 404），codex CLI
> 直连即可，`wire_api = "responses"` + 真实 base_url，不再经过本地转换。
> 仍然挂载的 `/codex-proxy/...` 端点只服务两个场景：
> ① 官方 OAuth relay（多账号 auth.json 解析）；
> ② responses-compat 代理（`RESPONSES_COMPAT_PROXY_MAP`，目前仅 XFYun——
> 上游已是 Responses，代理只做流稳定化，不做协议转换）。
> 实现归属独立包 `cli-provider-router`；MultiCC 只提供 provider resolver、
> session 生命周期和 usage sink。

## 整体数据流（现状）

```
codex exec ──多数 provider：config.toml 直连真实 base_url /responses──────────────► 服务商
             ──XFYun 等 compat 代理：base_url = http://127.0.0.1:3000/codex-proxy/…
                POST /codex-proxy/<providerId>/<sessionId>/<role>/responses
                  ① 读 providerId → 查真实 base_url+key
                  ② 透传 Responses body（仅做流稳定化）
                  ③ fetch 真实服务 /responses
                  ④ Responses SSE → 稳定的 Responses SSE
codex ◄────────────────── Responses API SSE 流 ◄────────────────────────────────
```

## 退役的 Responses↔Chat 转换（历史，保留备查）

原实现把 codex 的 Responses 请求转成 Chat Completions 再转回来，位于
`cli-provider-router/lib/proxy/codex-transform.js`（`responsesToChat` /
`chatStreamToResponses`）。退役原因：转换层会把一条含 text+tool_calls 的
assistant 消息拆成两条，并在空 delta 上伪造空 `msg_0` 消息项，重放成
`[assistant(tool_calls), assistant(""), tool]`——DeepSeek 严格校验
tool_calls 后必须紧跟对应 tool 消息，直接 400
（`insufficient tool messages following tool_calls message`）。
上游全部原生支持 /responses 后该层不再有任何用户，故整体移除。
历史转换规则细节见 git 历史（本文件 2026-09-12 之前的版本）。

## ── 端点 + 宿主集成（现行）──

- `cli-provider-router` 导出 `mountCodexProxy`、`createCodexHandler`、
  `applyCodexProxyConfig` 和 `materializeCodexRoutingHome`。
- role-aware 端点为
  `POST /codex-proxy/:providerId/:sessionId/:role/responses`；旧的
  `/:providerId/responses` 仅作无 role usage 的兼容入口。
- `server.js` 注入 `providers.getProvider` 和 `recordRoleTokenUsage`，不实现协议转换。
- `src/providers/core.js` 只保留 MultiCC store 适配；Codex HOME、Agent TOML 和认证物化
  委托给独立包。真实 base URL 和凭证仍由 MultiCC provider store 提供。
- provider 侧的协议选择只剩两个值：`anthropic` 与 `openai_responses`。
  历史遗留的 `openai_chat` 标签 / `chat-to-responses` proxyTarget 由
  `migrateLegacyProviderProtocols` 在启动时迁移为直连 responses。

## 验收

- 包契约测试：direct Responses、responses-compat、main/sub role、
  cached tokens、自定义 mount path 和官方主线程直连。
- MultiCC 集成测试：provider store adapter、role token tracker 和 Codex aggregate 对账。
- 端到端（commander）：真实 DeepSeek key，codex exec "say hi" 直连 /responses 跑通，
  返回正常回复（含两轮工具调用往返）。
