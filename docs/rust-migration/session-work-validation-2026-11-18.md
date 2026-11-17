# 会话调度与无 Node 启动验证（2026-11-18）

本记录是未完成迁移的阶段结果，不是全 Rust 产品验收。验证使用隔离数据库和临时网关；没有重启正在运行的 MultiCC、修改实际服务配置或迁移真实数据。

## 已完成

- 会话问题的创建、替换、回答和回放接入 Rust SQLite owner；外部投递在首次认领前执行可信状态回填。
- `scheduler.complete` 的状态修改及问题相关队列更新由 Rust 事务完成。调度器不再保留 JavaScript completion 回退。
- 取消链路、无人值守 FIFO 与编排运行时的旧测试夹具切换到 Rust SQLite；需要验证旧 JSON 写入失败行为的独立测试继续使用旧夹具。
- 源码行数守卫已校准到与 `main` 完全相同的两份前端文件当前字节，不修改这些文件；新限制仍按实际值收紧。行数守卫和其 5 项测试通过。
- 功能分支已重放到本地 `main`：工作树清洁时 `HEAD...main` 为 `4 0`，没有冲突。阶段提交为 `d974191b` 和 `584a2496`；另外两个较早提交也被保留。

## 测试和未完成的恢复迁移

重放后，使用源码指纹 `2de25b66a91afbad94233115` 构建的原生模块执行会话调度、完成、认领、定时消息、取消、无人值守 FIFO 和编排运行时集合：**282/283 通过**。唯一失败是 `tests/test-scheduler-worker-order.js` 的恢复迁移守卫：`scheduler.recover` 仍在 JavaScript 草稿中修改状态，还没有可验证地保持原回调观察顺序、外部 SQLite 冲突检测和非阻塞准备的 Rust 事务。该断言未被删除或放宽。

其中取消链路 **28/28**、无人值守 FIFO **21/21**、编排运行时 **54/54**、会话调度器主测试 **71/71**、Rust completion 顺序和事务测试 **6/6** 通过。真实隔离网关及服务的 Codex/OpenCode 聊天测试通过，包含提问、重连回放、回答和回答后的输出。

上述测试并不证明其余产品功能、全部安装包或迁移后数据兼容。行数守卫在重放后再次通过。

## 无 Node 验证和部署现状

隔离 `--no-node` 网关启动后，进程没有子进程，原生测试路由返回 200；`/api/not-owned-by-rust` 和 `/ws/chat` 返回 503 `node_runtime_absent`。SIGTERM 后网关退出码为 0，测试端口连接失败。仓库 `scripts/smoke-no-node-gateway.sh` 也通过，明确验证未迁移路由返回 503。

旧的 `multicc-node-free:local` 镜像 ID `11b0091e467d` 创建于 2026-11-16，**不是本次源码的新构建**。其默认入口为 `multicc-gateway serve --cwd /srv/multicc --no-node`，镜像内找不到 Node，运行时 `docker top` 只有 `multicc-gateway`。默认网关在容器内监听 `127.0.0.1:3000`；经 Docker 发布的端口无法直接转入该容器回环地址。临时容器已停止并自动删除。

从当前源码（导出摘要 `8034a1fe090bee547126187b708204ca36a9c003d79a832f2aae93918ac2e53c`）构建的独立镜像 `multicc-node-free-task-88a:local`，镜像 ID 为 `sha256:c35ffc4a0c19d109bc4ae1dbf7a7dfcc4d5a5454d3677d25757aa6a48a02ed80`。最初构建因缺少 `libclang` 失败；在 Rust 构建阶段安装 `libclang-dev` 后，release 构建与镜像内 `node-free runtime smoke passed` 均通过，最终运行镜像未安装该构建依赖。隔离容器的入口为 `multicc-gateway serve --cwd /srv/multicc --no-node`，`docker top` 只有网关，`command -v node` 未找到 Node。容器监听 `127.0.0.1:3000`，宿主随机映射端口的 HTTP 请求被关闭而未收到响应；容器已停止并删除。

本机生产复核：PID 60839 的 Rust 网关监听端口 3000，其直接子进程 PID 60840 为 Node；系统中还有其他 Node 进程。上述隔离测试只能证明**测试网关及测试容器**没有 Node 子进程，不能证明生产服务或整机无 Node。生产聊天、WebSocket、认证状态及其他未迁移宿主依然需要 Node，详情见 `docs/backend-rust-exit-plan.md`。因此没有将无 Node 模式切为生产默认，也没有删除 `server.js`、生产 `src/`、`package.json`、`node_modules` 或 Node 启动脚本。

保留的 Node 开发工具包括测试运行器、构建脚本和 Electron 客户端工具链；它们与上述仍承担生产职责的 Node 后端是不同的依赖。JavaScript 宿主目前仍负责 WebSocket、回调和平台适配，Rust 承担本批问题状态和 completion 事务。只有完成服务路由、聊天与状态宿主迁移并通过真实客户端、数据恢复和部署测试，才能删除生产 Node 文件。

## 尚未完成

1. 将 recovery 的准备、状态决策和提交迁入 Rust，同时保留回调时序、事务冲突和非阻塞约束，并让完整调度集合全绿。
2. 迁移尚依赖 Node 的 HTTP、认证、WebSocket、聊天协调、持久化和平台宿主，完成数据、回滚和真实客户端验证。
3. 从最终源码构建纯 Rust 生产容器，验证可访问监听地址、完整功能、进程与端口，再决定移除 Node 生产依赖和启动脚本。
4. 完成上述验收后再次同步 `main`、复测并合并。当前阶段没有合并到 `main`。
