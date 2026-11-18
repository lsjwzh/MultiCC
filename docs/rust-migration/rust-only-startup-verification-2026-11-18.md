# Rust-only 生产启动验证（2026-11-18）

recover 所有权批次合入 main（提交 `75518375`，merge `67c6710e`）后，按指令开启
生产启动阶段：核对启动命令/容器/部署配置的 Rust-only 切换现状，实际拉起
Rust-only 实例并记录「无 Node 进程」的 ps/端口证据。

## 部署配置切换现状

| 入口 | 现状 | 说明 |
|---|---|---|
| 容器 `node-free-runtime` 阶段 | **已切换** | `docker/task-shell/Dockerfile:51` 默认 CMD 即 `multicc-gateway serve --cwd /srv/multicc --no-node`，镜像内无 Node；构建期跑 `scripts/smoke-no-node-gateway.sh` |
| `scripts/start-rust-only.sh` | **已切换（专用入口）** | 本检出 Rust-only 启动命令：`serve --cwd <检出> --no-node`，本次验证即用它 |
| `./multicc`、`npm start`、独立包启动器、桌面壳 | **不切换（设计如此）** | exit plan 6f：阻塞项 2-7（未迁 HTTP 域、WS 宿主、聊天控制面、multipart、流式宿主回调、插件/适配器托管）未关闭前，默认入口必须保持 `--node`，否则这些路由一律 503 `node_runtime_absent`、产品直接不可用。翻转默认入口是整个迁移的最后一步，不属于本阶段 |

依据：`docs/backend-rust-exit-plan.md`「What deleting the Node process still needs」
与 `docs/gateway.md` §8.1（「默认入口不变……§9 之外的路由与 WS 宿主仍需 Node」）。

## 实际启动证据（本批实测）

构建：rebase 后源码指纹 `82526b28ff978d20e3d9795b`（addon + gateway 同批产物）。
启动命令（隔离数据目录、合成 token、临时回环端口，不触碰在跑服务）：

```
MULTICC_DATA_DIR=/tmp/<隔离目录>/data ACCESS_TOKEN=rust-only-proof-12345 \
  data/rust-source/82526b28ff978d20e3d9795b/darwin-arm64/multicc-gateway \
  serve --cwd <本 worktree> --no-node --ephemeral-loopback
```

启动日志（模式判据行）：

```
[multicc-gateway] listening on 127.0.0.1:60161
[multicc-gateway] node runtime disabled (--no-node): routes not owned by Rust answer 503 node_runtime_absent
[multicc-gateway] authentication runtime owned locally (--no-node)
```

### ps 证据：无 Node 子进程

```
PID  PPID  PGID COMM            ARGS
7681    1  7678 multicc-gateway .../multicc-gateway serve --cwd <worktree> --no-node --ephemeral-loopback

pgrep -P 7681  → (no child processes)
```

单一 Rust 进程，零子进程；进程树中不存在 node（机器上其余 node 进程分属
在跑生产服务 `--node` 实例与无关应用，父链与本实例无关）。

### 端口证据

```
lsof -nP -iTCP:60161 -sTCP:LISTEN
COMMAND    PID   USER   FD   TYPE  ... NODE NAME
multicc-g 7681 Zhuanz    9u  IPv4 ...      TCP 127.0.0.1:60161 (LISTEN)
```

公开端口由 Rust 前门进程直接持有，无 Node 上游、无内部转发端口。

### HTTP 契约证据

| 探针 | 结果 |
|---|---|
| `GET /api/claude/models`（无凭据） | 403 `{"code":"AUTH_REQUIRED",...}`——本地 `AuthRuntime` 按同一份 `http_gate` 规则拒绝 |
| 同请求带 `X-Access-Token: rust-only-proof-12345` | 200 `{"models":[...]}`——需鉴权的原生路由在 `--no-node` 下由前门自持鉴权运行态正常应答 |
| `GET /api/not-owned-by-rust` | 503 `{"error":"This route is served by the Node runtime, which this front door was started without (--no-node).","code":"node_runtime_absent"}`——未迁路由诚实失败关闭，不伪装成功 |

### 停止与隔离

- SIGTERM：日志 `stop signal received; no node to stop, no longer accepting`，进程退出，`ps -p` 复查已消失。
- 数据隔离：`MULTICC_DATA_DIR` 指向 mktemp 目录，实例仅生成 `claude-models-cache.json`；在跑生产服务的数据目录、`.env` 与进程全程未触碰，实例已清理。

## 结论与下一步

- 容器与专用启动命令的 Rust-only 切换已就位并实测可启动、可应答、可停止，进程树无 Node。
- 生产默认入口（`./multicc` / `npm start` / 独立包 / 桌面壳）的翻转被 exit plan 6f
  阻塞项 2-7 卡住：未迁 HTTP 域、WS 宿主、聊天控制面、multipart、流式宿主回调、
  插件/适配器托管。这些未关闭前翻转默认入口等于让产品不可用，本阶段明确不执行。
- 下一步：按 6c/6d 继续迁未覆盖的路由域与聊天编排，每批重测本文件同样的
  ps/端口/契约证据，直至默认入口可翻转且 fallback 分支可删除（而非仅被演示）。
