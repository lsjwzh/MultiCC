# OpenClaw 原生浏览器适配

这里适配的是 OpenClaw 自带的托管浏览器，不是导入技能 `openclaw-imports-browser` 所描述的 Stagehand `browser` 命令。上游依据为 OpenClaw 的 `docs/tools/browser.md`。

## 预检与档案

1. 确认 `openclaw browser --help` 可执行，并用 `openclaw browser --browser-profile <已批准名称> status` 核对 Gateway 和 Profile。只找到 PATH 包装器不够；报缺失应用、Gateway 不可用或浏览器禁用时，停止并报告，不暗中安装或修复。
2. OpenClaw 默认 `chrome` Profile 是个人浏览器的扩展 relay；本任务应使用 `openclaw` 或另一个**已明确批准**的托管 Profile。每个独立进程对应独立的命名 Profile；不要共用其数据目录。
3. 新建 Profile 用 `create-profile`，属于浏览器创建，必须先让用户确认名称、用途及登录态边界。不要用 `reset-profile`、`delete-profile` 或 `stop` 清理一个可能正在被其他会话使用的 Profile。

每条命令都显式携带 `--browser-profile <name>`，需要解析结果时加 `--json`。例如：

```text
openclaw browser --browser-profile <name> status
openclaw browser --browser-profile <name> --json tabs
openclaw browser --browser-profile <name> --json open https://example.com
openclaw browser --browser-profile <name> snapshot --interactive --compact
openclaw browser --browser-profile <name> click <当前快照的ref>
openclaw browser --browser-profile <name> screenshot
```

`open` 返回目标标识后记录归属；后续只处理本会话创建或用户明确指定的目标。快照里的 ref 只对当前页面状态有效。避免 `focus`、`tab select` 等可能把用户桌面切到前台的动作；不要把 `evaluate` 当作绕过确认或跨站读取数据的通道。

OpenClaw 浏览器服务在 Gateway 中运行，托管 Profile 自带固定数据目录。持久登录是否实际保留，仍须在该 Profile 登录后做“关闭再启动 → 原站复查”的验收；不能把 `status` 成功等同于登录持久化成功。本机若 `openclaw` PATH 包装器指向缺失的 MoonClaw/XClaw，须先修复该入口或明确选择另一执行层，不能让技能假装它已可用。
