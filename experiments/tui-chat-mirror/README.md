# TUI → Chat 实验会话

这个实验验证一条边界清晰的架构：

- Codex 交互式 TUI 是唯一执行者；
- 输入由实验网页注入同一个 tmux TUI；
- Chat 投影读取 Codex 原生 rollout JSONL；
- 本地 Tool 仍由 Codex TUI 执行，旁路只展示，绝不重放；
- tmux 原始画面仅作诊断兜底，不作为历史事实源。

仓库保留两种隔离方式：

- 本页 sidecar：完全独立于 MultiCC，用于最小原理验证；
- MultiCC 集成实验：复用正式 Chat UI、WebSocket 与事件渲染，但只有服务端开关和会话标记同时存在时才启用。

两种方式都不改变普通会话的执行路径。

## MultiCC 集成实验

只在隔离的实验实例设置服务端开关：

```sh
MULTICC_EXPERIMENT_TUI_CHAT=1 node server.js
```

然后通过现有创建会话接口建立带标记的 Codex Chat 会话：

```json
{
  "cli": "codex",
  "kind": "chat",
  "label": "🧪 TUI Chat Mirror",
  "experimentalMode": "tui-chat-mirror"
}
```

隔离边界是 fail-closed 的：

- 未设置 `MULTICC_EXPERIMENT_TUI_CHAT=1` 时，服务拒绝创建带该标记的会话；
- 该标记只接受 `cli=codex`、`kind=chat`；
- 普通会话不进入实验运行时；
- TUI 是唯一执行者，Chat 只注入输入并投影原生 rollout，Tool 不会在旁路重放。

## 启动

```sh
node experiments/tui-chat-mirror/server.js \
  --host 127.0.0.1 \
  --port 3317 \
  --cwd /tmp/multicc-tui-chat-poc-workspace \
  --tmux multicc-exp-tui-chat
```

打开 <http://127.0.0.1:3317>。

## 实验限制

- 当前仅适配 Codex rollout JSONL；
- 展示的是原生落盘事件粒度，不保证逐 token；
- Tool 输入和输出仅做基础凭据脱敏，不应投向公网；
- 生产化前需要接入 MultiCC 的统一鉴权、事件账本和 Chat 渲染器；
- 停止 sidecar 不会停止 TUI；两者是刻意解耦的。

## 清理

确认实验不再需要后，可分别停止 sidecar 和 TUI：

```sh
tmux kill-session -t multicc-exp-tui-chat-sidecar
tmux kill-session -t multicc-exp-tui-chat
```
