---
name: multicc-secrets
description: MultiCC 敏感信息保险箱：安全地收集与保管 API key、token 等密钥，值不经过对话与 LLM。需要向用户讨要任何密钥时必用。
---

# MultiCC 敏感信息保险箱

MultiCC 在本地维护一个敏感信息保险箱（secrets vault），用于存放 API key、token、密码等。核心不变量：**密钥明文永远不进入聊天消息、不经过任何 LLM API**。

## Agent 用法

1. `list_secrets`（MultiCC MCP 工具）——列出保险箱条目，只返回名称/描述/更新时间。
2. `request_secret_input`（MultiCC MCP 工具）——向用户弹安全输入框：
   - `name`：条目名，`^[A-Za-z0-9_.-]{1,64}$`，如 `OPENAI_API_KEY`；
   - `question`：给用户看的说明（要填什么、哪里获取）；
   - 可选 `reason`：为什么需要。
   - 用户填写的值由前端直接 `POST /api/secrets` 存入本地，模型只会收到「已保存」的确认。
   - 调用后告诉用户弹框已打开并结束本轮。

## 人工管理

控制中心 `/manage` →「敏感信息」面板：增删改条目、查看/复制值。

## HTTP 接口（本地）

- `GET /api/secrets` — 条目列表（仅元数据）
- `POST /api/secrets` — `{name, value, description}` 新建/更新
- `DELETE /api/secrets/:name` — 删除
- `GET /api/secrets/:name/value` — 读值（仅供面板显示/复制）

存储为数据目录下的 `secrets.json`（0600 权限）。

## 红线

- 绝不要求用户把密钥明文粘贴进聊天框或写进任何会进入上下文的文件。
- 绝不尝试把保险箱里的值读出来贴进对话（值读取接口只供面板使用）。
- 引用密钥时只使用条目名。
