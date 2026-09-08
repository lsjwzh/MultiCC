# Task shell Docker 测试环境

本环境用于任务会话壳的 Linux 回归和手动验收。普通 Web 会话、真实模型额度、生产数据库和宿主项目工作区均不参与测试。普通发送续接服务端当前任务，只有显式“新任务”才创建独立执行；内部 API 仍可验证已完成上下文快照。

## 启动

需要 Docker Engine / Docker Desktop、Compose v2、宿主 Node.js 与 Git。首次构建需要联网下载 Debian 软件包和 npm 锁定依赖。macOS 首次使用前启动 Docker Desktop。

```sh
npm run lab:build
npm run lab:test
npm run lab:up
```

`lab:up` 在前台运行，终端会打印两个壳的直接链接。等待日志出现 `[Docker lab] Ready` 后打开 <http://127.0.0.1:3300/manage>，密码为 `multicc-docker-lab`。两个预置会话是 Docker shell A / B，可从会话的任务壳入口进入。

如果由 MultiCC「服务与文档」面板托管，登记启动命令为 `node scripts/task-shell-lab-service.js`，cwd 为当前 checkout 的绝对路径，port 为 3300。面板启动后可以关掉操作终端。服务停止会停止这个 Compose 沙盒，保留数据卷。

```sh
npm run lab:logs
npm run lab:down
# 对已启动的沙盒再跑一次端到端检查（会留下 3 个测试任务）
docker compose -f docker/task-shell/compose.yaml exec -T lab node docker/task-shell/smoke-lab.js
```

`lab:down` 删除本环境容器和网络，保留数据卷；不影响其他 Docker 项目。需要删除测试数据时，先确认数据可丢弃，再由操作者运行 `docker compose -f docker/task-shell/compose.yaml down --volumes`。没有自动清理、重置或改写生产数据的脚本。

端口冲突时同时指定两个不同端口，例如 `MULTICC_LAB_PORT=3400 MULTICC_LAB_BACKEND_PORT=3401 npm run lab:up`。默认 3300 为宿主 Node 转发入口，3301 为 Docker 后端发布端口，二者都只监听 127.0.0.1。宿主入口使服务管理器只停止本环境的 Node 进程，避免把 Docker Desktop 的共享端口转发进程当作可终止服务。

浏览器请始终使用 3300 入口。入口使用独立的 `multicc_docker_lab_auth` Cookie，并在 HTTP / WebSocket 转发时只传递沙盒 Cookie，避免与同一主机上正式 MultiCC 的登录 Cookie 相互覆盖；3301 是内部转发端口，不作为浏览器入口。

## 全新安装发布门槛

发布前运行 `npm run test:release:clean-install`。它在一次性容器内从空目录调用真实安装脚本，再验证首次启动、配置、任务切换、手动 Fork、工作区隔离、Chromium 与重启恢复。安装期间需要联网获取 npm 依赖；不挂载宿主源码、凭据或数据卷。候选源码经本地 Git 镜像克隆，不从 GitHub 下载旧版本。

详细步骤与 SW/FK 用例见 [发布测试矩阵](task-shell-release-tests.md#发布前必须执行全新-docker-安装)。Android 与桌面发布工作流均强制依赖该门槛。

下面的 `lab:test` 是较快的开发回归，复用镜像内已装依赖，不能替代全新安装测试。

## 自动回归范围

`lab:test` 创建无网络、无宿主挂载的一次性容器，失败返回非零状态，成功后删除容器。它运行：

| 层次 | 覆盖 |
| --- | --- |
| 构建隔离 | 只导出 Git 跟踪文件，保留当前修改，拒绝符号链接，排除凭据与运行时文件 |
| 单元与 HTTP | 当前任务排队、显式新任务、回执幂等、跨项目限制、按需上下文、容量、控制消息 |
| 调度回归 | scheduler、session work host、问题回答、task context、task-bound session |
| 真实服务集成 | 独立 SQLite、Git worktree、模拟 CLI、WebSocket 防绕过、取消、关实验后的读取 |
| Chromium | 真实生产页面脚本；路由由测试夹具提供；重试、问题归属、移动布局、输出转义 |

Chromium 必须存在，否则测试失败，不能静默跳过。真实服务器集成和浏览器夹具分别验证；另用 `smoke-lab.js` 验证持续运行沙盒的真实 API 链路。

构建上下文来自 `git ls-files` 所列的当前文件内容，新增文件须先 `git add` 才会进入镜像。镜像内 `/opt/multicc/docker-source.json` 记录源码提交、内容摘要和文件数；提交号不是未提交改动的替代证明。构建不复制 `.git`、宿主 `node_modules`、未跟踪文件、`.env`、CLI 凭据目录、生产会话或数据库。仓库 `.dockerignore` 默认排除全部内容，直接从 checkout 构建会失败；只有 `lab:build` 生成的受控临时上下文包含源码。

## 手动用例

1. 在壳 A 单独一行发送 `LAB_WAIT 30`，任务保持运行约 30 秒（上限 120 秒）。
2. 在壳 A 再发送普通工作。应排入同一 taskId，不创建另一个任务或工作区。
3. 在壳 B 点击“新任务”后发送普通工作。应创建独立任务，A 的执行保持不变。
4. 切回 A，点击取消。只应取消 A；B 已完成的输出保持可见。
5. 单独一行发送 `LAB_FAIL`，验证执行失败展示；点击“新任务”创建的后续任务仍可完成。
6. 用 `lab:down` 停止后重新 `lab:up`，两个壳的 ID、历史、当前任务指针应保留，重复启动不增加预置会话。

按需回补 MCP 和内部快照引用由自动 API 用例验证；模拟 CLI 不具备自主工具调用能力，手动页面验收不能替代真实模型 A/B 测试。

模拟 CLI 只输出固定消息与用量，没有模型推理和工具执行能力。`fake-cli-invocations.jsonl` 只记录模拟执行身份、cwd、时间与 prompt 摘要，不用来动态修改原生会话历史。

## 隔离与边界

- 镜像基于 Node 22 / Debian bookworm，容器内重新安装 Linux 原生依赖；不复用 macOS 二进制。
- 回归容器无外网；应用沙盒只连接 internal Docker 网络，不能直接访问模型服务。独立 TCP 网关连接入口网络，只转发到固定的 `lab:3000`；网关不执行任务。宿主浏览器仍可能加载页面已有的 CDN 资源。
- 数据和 Git 项目只放在专用 `lab-data` named volume；不挂载宿主项目、CLI 登录目录或 Docker socket。
- 非 root 用户、禁用提权、移除 Linux capabilities。应用和回归容器各限制 3 GiB 内存、512 个进程；入口容器限制 128 MiB、32 个进程。
- 固定密码仅供本机模拟测试；此配置不用于生产部署或公网暴露。Docker 隔离不等同于对任意恶意代码的安全沙箱。
- 本轮覆盖任务壳实验相关发布门禁；不替代完整 macOS / App / 真实 Claude、Codex 与供应商兼容性验收。
- 镜像包含浏览器和编译工具，首次下载与磁盘占用较大。基础镜像和 apt 仓库随上游更新；源码摘要与 lockfile 可追踪本次输入，不宣称位级可重现。
- 更新源码后重新 `lab:build` 并重启本沙盒。生产 MultiCC 不需要为此重启。

## 本次验收记录（2026-09-06）

- Docker Desktop 28.2.2，Linux arm64，Node v22.23.2。
- 自动容器回归 139 个 Node 测试用例通过、0 失败、0 跳过，另有真实服务/SQLite/Git 集成脚本通过。
- 持续运行沙盒 API 用例通过：两个壳、显式新任务、相同回执重试、取消、完成上下文引用。
- 宿主 Chromium 访问真实容器页面，完成登录交换、提交、任务执行、结果呈现；地址栏凭据已清除。
- 重启后原有壳 ID 和任务保留，预置会话不重复；应用容器 `/proc/net/route` 无默认外网路由。
- 服务面板停止命令已验证只停止本沙盒；Docker Engine 仍可正常使用。服务管理器观察到 3300 的监听进程为本沙盒 Node 进程。
- 仓库制品治理、运行时写入清单、源码行数预算通过。
