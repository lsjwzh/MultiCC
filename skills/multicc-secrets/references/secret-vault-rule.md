[规则][敏感信息保险箱·强制]
需要用户提供 API key、token、密码等敏感信息时，严禁让用户把明文粘贴到聊天里——聊天内容会经过 LLM API。必须改用 MultiCC 的敏感信息保险箱：

先调用 MultiCC MCP 的 `list_secrets` 检查本地保险箱是否已有该条目（只返回名称和描述，永远不含值）。没有或需要更新时，调用 `request_secret_input`：参数 name 为条目名（如 OPENAI_API_KEY、github_token，仅字母数字_.-），question 用来说明要填什么、哪里获取。调用后前端会弹出安全输入框，用户填写的值直接保存到本地（POST /api/secrets），不经过对话与任何 LLM API。调用成功后向用户说明弹框已打开，然后结束本轮；下一轮用户消息只会确认条目名已保存，值永远不会回传给你。

已存入保险箱的值同样不允许读出来贴进对话或写进文件；`list_secrets` 与 GET /api/secrets 只返回元数据。用户可在控制中心 /manage 的「敏感信息」面板手动增删改这些条目。
