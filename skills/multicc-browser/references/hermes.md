# Hermes 原生浏览器适配

上游依据为 Hermes Agent 的 `website/docs/user-guide/features/browser.md` 及其 `tools/browser_tool.py`。Hermes 浏览器是**工具集**，不是可供其他 CLI 直接调用的 `hermes browser ...` 命令。

## 何时可用

仅当当前会话实际暴露 Hermes 的 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type` 等工具时使用。常规流程是 `browser_navigate` → `browser_snapshot`（得到 `@eN` 引用）→ 点击/输入 → 再取快照验证。`browser_console` 可查 JS 错误；视觉必要时使用截图/vision。不要假设 Hermes 的 `/browser connect` 能从 MultiCC 网页聊天调用：它是 Hermes 交互式 CLI 的 slash command。

Hermes 可在 Browserbase/Browser Use/Firecrawl 云端、Camofox、本地 `agent-browser` 或已有 Chrome CDP 之间路由。不能把它们视作等价：

- 云端可能上传页面、登录态并产生费用；不根据已有密钥自动切换。
- `/browser connect` 接个人 Chrome 属于已有浏览器接管，不是免授权的独立 Profile。
- 默认本地 `agent-browser` 的任务隔离和闲置自动清理，**不证明登录可跨重启保留**，也不证明同一 Profile 能由多个进程并行打开。
- Camofox 的 `browser.camofox.managed_persistence: true` 仅提供稳定 userId；服务端还必须真实支持按 userId 持久化，并通过重启复查验证。不同身份要用隔离 Profile；不能因配置项存在就宣称持久化已经成功。

因此，对“多个独立进程、各自长期登录”这一硬要求，若当前 Hermes 后端的 Profile 隔离与重启恢复未经实测，先不要将其设为默认。可改选已验证的专用浏览器执行层；不得为了借用 Hermes 工具而启动一个额外的 Hermes Agent 代替当前模型执行任务。
