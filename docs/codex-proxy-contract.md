# Codex Responses↔Chat 协议转换代理 — 接口契约（权威）

> 目的：让 codex CLI（只支持 `wire_api="responses"`）能连只提供 `/chat/completions`
> 的国产服务商（DeepSeek/GLM/Qwen/MiniMax）。复刻 cc-switch 的本地代理思路。
> 两个实现会话都必须严格遵守本契约，最后由 commander 集成。

## 整体数据流

```
codex exec  ──POST /codex-proxy/<providerId>/responses (Responses API, SSE)──►  multicc server
                                                                                      │
                                                  ① 读 providerId → 查真实 base_url+key │
                                                  ② Responses body → Chat body (模块A)  │
                                                  ③ fetch 真实服务 /chat/completions     │
                                                  ④ Chat SSE → Responses SSE (模块B)     │
codex  ◄────────────────── Responses API SSE 流 ◄─────────────────────────────────────┘
```

## 抓包确认的 codex 真实请求（Responses API）

`POST /responses`，Header：`Authorization: Bearer <key>`、`Accept: text/event-stream`、`content-type: application/json`

Body 顶层字段：
```
model, instructions, input, tools, tool_choice, parallel_tool_calls,
reasoning, store, stream, include, prompt_cache_key, client_metadata
```
- `model`: string，如 "deepseek-chat"
- `instructions`: string，系统提示词（约 2 万字符）
- `input`: 数组，每项形如：
  - 消息：`{type:"message", role:"developer"|"user"|"assistant", content:[{type:"input_text", text:"..."}]}`
  - 函数调用结果（历史）：`{type:"function_call_output", call_id:"...", output:"..."}`
  - 函数调用（历史 assistant）：`{type:"function_call", call_id:"...", name:"...", arguments:"...(json string)"}`
- `tools`: 数组，**Responses 扁平格式**：`{type:"function", name, description, strict, parameters}`
- `tool_choice`: "auto"
- `parallel_tool_calls`: bool
- `reasoning`: 可能为 null 或 `{effort, summary}`
- `stream`: true

## ── 模块 A：请求转换（纯函数，模块A会话负责）──

文件：`src/codex-proxy-transform.js`，CommonJS。

```js
/**
 * Responses API 请求体 → Chat Completions 请求体
 * @param {object} responsesBody  codex 发来的 Responses body
 * @returns {object} Chat Completions body: { model, messages, tools?, tool_choice?, stream:true }
 */
function responsesToChat(responsesBody) { ... }
module.exports = { responsesToChat, chatStreamToResponses };
```

转换规则：
1. `instructions` → messages 首条 `{role:"system", content: instructions}`。
2. `input[]` 按序转 messages：
   - `{type:"message",role,content:[{type:"input_text",text}]}` →
     `{role: role==="developer"?"system":role, content: 拼接所有 input_text 的 text}`
     （DeepSeek 不认 "developer"，统一映射成 "system"）
   - `{type:"function_call", call_id, name, arguments}` →
     `{role:"assistant", content:null, tool_calls:[{id:call_id, type:"function", function:{name, arguments}}]}`
   - `{type:"function_call_output", call_id, output}` →
     `{role:"tool", tool_call_id:call_id, content: output}`
3. `tools[]`：Responses 扁平格式 → Chat 嵌套格式：
   `{type:"function", name, description, parameters}` →
   `{type:"function", function:{name, description, parameters}}`
4. 透传 `tool_choice`、`model`、`stream:true`。`parallel_tool_calls` 透传（DeepSeek 支持则带上）。
5. 丢弃：`reasoning, store, include, prompt_cache_key, client_metadata`（Chat 不认）。

## ── 模块 B：响应流转换（流式状态机，模块B会话负责）──

同文件 `src/codex-proxy-transform.js` 导出：

```js
/**
 * 创建一个把 Chat Completions SSE 流增量转成 Responses SSE 事件的转换器。
 * 用法：对每个上游 SSE data 行调用 push()，结束时调用 end()。
 * @param {(sseText:string)=>void} emit  回调：把要发给 codex 的 SSE 文本写出（含 "event:..\ndata:..\n\n"）
 * @returns {{ pushLine:(line:string)=>void, end:()=>void }}
 */
function chatStreamToResponses(emit) { ... }
```

上游（DeepSeek Chat Completions 流）每行：`data: {"choices":[{"delta":{"content":"x"}|{"tool_calls":[...]}|{"reasoning_content":"x"}}],...}`，结束 `data: [DONE]`。

下游（发给 codex 的 Responses SSE）必须按此序列发，每个事件格式 `event: <type>\ndata: <json>\n\n`：
1. 开始：`response.created` → data `{type:"response.created", response:{id, object:"response", status:"in_progress", model, output:[]}}`
2. 文本首 delta 前：`response.output_item.added`（item: `{type:"message", id:"msg_0", role:"assistant", content:[]}`），再 `response.content_part.added`（part `{type:"output_text", text:""}`）
3. 每个文本 delta：`response.output_text.delta` → data `{type:"response.output_text.delta", item_id:"msg_0", output_index:0, content_index:0, delta:"x"}`
4. 文本结束：`response.output_text.done`（带完整 text）→ `response.content_part.done` → `response.output_item.done`
5. tool_calls：每个工具调用作为一个 output_item：`response.output_item.added`（item `{type:"function_call", id, call_id, name, arguments:""}`）→ 多个 `response.function_call_arguments.delta`（delta 为 arguments 片段）→ `response.function_call_arguments.done` → `response.output_item.done`
6. 收尾：`response.completed` → data `{type:"response.completed", response:{id, status:"completed", output:[...所有 item...], usage:{input_tokens, output_tokens, total_tokens}}}`

注意：
- id 用固定前缀 + 计数即可（如 `msg_0`、`fc_0`），但同一 item 的 added/delta/done 必须用同一 id。
- `reasoning_content`（DeepSeek 思维链）→ 可选发 `response.reasoning_summary_text.delta`，不确定就先忽略（不影响功能）。
- usage：从上游最后一帧的 `usage` 取；没有就给 0。
- 上游报错或非 200：发一个 `response.failed` 事件，data `{type:"response.failed", response:{status:"failed", error:{message}}}`。

## ── 模块 C：端点 + 集成（commander 负责，或第三会话）──

- `src/codex-proxy.js`：导出 `mountCodexProxy(app, { getProvider, port })`，挂载
  `POST /codex-proxy/:providerId/responses`。流程：查 provider → responsesToChat →
  fetch 真实 `/chat/completions`（stream）→ 用 chatStreamToResponses 转发 SSE。
- `server.js`：require 并 `mountCodexProxy(app, {...})`。
- `src/providers.js`：codex provider 若 base_url 命中国产服务，config.toml 的 base_url
  改写为 `http://127.0.0.1:<PORT>/codex-proxy/<providerId>`，wire_api="responses"；
  真实 base_url（chat/completions 端点）+ key 存在 provider 配置里供代理读取。

## 验收

- 单测（模块A/B 各自）：给定样例 Responses body → 期望 Chat body；给定样例 Chat SSE 行序列 → 期望 Responses 事件序列。
- 端到端（commander）：真实 DeepSeek key，codex exec "say hi" 经代理跑通，返回正常回复。
