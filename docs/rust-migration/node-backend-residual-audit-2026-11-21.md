# Node 后端残留审计（2026-11-21）

订阅入口批次合入 `a04f0565` 后，按下述固定口径仍有 **586 个 Node 后端候选文件、137,250 行**。默认启动、后台宿主、SDK 适配及发布包仍依赖 Node。Rust 已持有多项业务和存储规则，独立兼容入口的退出不等于整块宿主退出；整体 Node 后端清零尚未完成。

## 快照与计数口径

统计 Git 跟踪的 `server.js`、`ecosystem.config.js`、`scripts/start-gateway.js`，以及 `src/`、`plugins/` 下 JS/CJS/MJS；排除插件的 test/tests/extension/ui 路径。按 LF 物理行计数，包含注释、空行及兼容绑定，未以换行结尾的最后一行计入。前端、测试、其余构建工具和依赖包不计入后端源文件总数；构建和发布入口另行检查。

| 快照 | 文件 | 物理行 | 相对基线净减行 |
| --- | ---: | ---: | ---: |
| 同口径基线 `b20db311` | 612 | 139,099 | — |
| 已验收并合入的订阅批次 `a04f0565`，树 `8724e574` | 586 | 137,250 | 1,849（1.329%） |
| 任务提醒入口工作树，待完整验收 | 585 | 137,248 | 1,851（1.331%） |

基线逐个 Git blob 重算，未使用旧报告的估计数字。已交付区间退出 26 个文件、2,182 行，存量文件合计增加 333 行，新增候选文件为 0，净减 1,849 行。此数字覆盖整个基线区间，不能全归于订阅批次，也不能当作迁移完成率。

订阅批次删除原 15 行入口，向共享原生绑定增加原函数正文，生产 Node 净减 8 行。随后任务提醒批次删除原 15 行入口，向共享任务域增加 13 行绑定，净减 2 行；后一批当前仅完成定向验证，未合入，不能计入已交付减行数。

## 已交付树的主要残留

| 目录或入口 | 文件 | 行数 | 后续需退出的职责 |
| --- | ---: | ---: | --- |
| `src/routes/` | 95 | 24,609 | 路由组合、宿主端口与副作用 |
| `src/` 根目录文件 | 88 | 20,584 | 服务组合、进程和配置宿主 |
| `src/chat/` | 60 | 14,020 | 回合、流、会话与后台通知 |
| `src/providers/` | 28 | 7,150 | 供应商路由、SDK 与执行适配 |
| `src/voice/` | 17 | 5,274 | 语音服务、SDK 与进程生命周期 |
| `src/cli-adapters/` | 29 | 4,995 | 在册 CLI 的启动、流和停止 |
| `src/task-shell/` | 24 | 4,542 | 任务壳宿主与运行协议 |
| `src/orchestration/` | 6 | 3,690 | 编排宿主、调度与回调 |
| `server.js` | 1 | 3,080 | 主服务组合和剩余消费者 |
| `src/session-work/` | 2 | 2,268 | 会话工作宿主和队列 |

最大的残留文件包括 `server.js` 3,080 行、`src/chat/turn-engine.js` 2,988 行、`src/providers/core.js` 2,390 行、`src/routes/task-board.js` 1,854 行、`src/classify/state-machine.js` 1,765 行、`src/orchestration/runtime.js` 1,690 行、`src/unattended/host.js` 1,379 行及 `src/session-work/host.js` 1,360 行。完整文件、SHA-256、依赖和调用方见机器可读快照。

这些文件包含业务、平台/SDK 宿主和薄绑定，不能只按文件行数判断可删范围。后续新增业务仍应放在 Rust；保留 Node 的原因应落在必要 SDK、进程或迁移协议，并随对应调用方一起退出。

## 运行入口、依赖与发布链路

| 核查项 | 当前证据与结论 |
| --- | --- |
| npm | `package.json` 的 main 为 `server.js`，Node 引擎为 `>=22.16.0`；`start` 与 `start:gateway` 均执行 `node scripts/start-gateway.js`。 |
| 网关启动 | `scripts/start-gateway.js:37` 显式传入 `--node process.execPath` 和 `server.js`；Rust 前门仍监督 Node 子进程。 |
| shell / 服务 | `multicc` 的启动与服务安装路径仍传 `--node "$NODE"`；`ecosystem.config.js` 使用同一 Node 启动器。 |
| 桌面包 | `scripts/desktop-bundle-server.js` 打包 `server.js`、`src/` 和 `plugins/`，生成的后端启动脚本仍使用 Node。 |
| standalone | `scripts/standalone-bundle.js` 与 `scripts/standalone-launcher.js` 仍分发、选择 Node runtime 并启动 Node 宿主。 |
| 运行时依赖 | package.json 有 19 个直接运行时依赖，包括 Express、ws、Claude/ACP SDK、CPR、飞书/Slack/Discord/Telegram SDK、语音及推送库；devDependencies 为 better-sqlite3、werift。这些是直接声明数，不是传递依赖数。 |
| SQLite | 当前统计范围未发现直接加载 `node:sqlite` 或 `better-sqlite3` 的字面量导入；`src/sqlite/driver.js` 加载 RustDatabase N-API。仍有 Node 同步回调、错误映射及生命周期，不能据此宣称存储调用方已退出 Node。 |

发现旧说明残留：`scripts/desktop-bundle-server.js` 的注释/日志和 `scripts/standalone-launcher.js` 的说明仍称存储为 `node:sqlite`，与当前 Rust 驱动不符。本轮仅记录，未将其混入入口退休源码改动。

## 路由与动态入口的证据边界

已交付树从 `server.js` 沿字面量相对依赖保守扫描可达 570 个候选文件，有 8 个非行注释动态加载候选、311 个静态 HTTP/中间件注册候选，以及 35 个不同的 `/api/__host/*` 路径字面量。提醒入口工作树对应可达文件为 569，其余候选数相同。

这是源码候选扫描，未启动生产服务做本轮路由捕获。条件分支、注释、局部同名函数、字符串中的代码可能产生误报，计算型加载可能漏报；原始 npm 导入候选同样需要人工核对，以 package.json 的直接依赖声明为可靠计数。311 不是实时路由总数，35 也不是当前活跃宿主端口总数。可达既不证明实际运行，也不授权删除。

`scripts/smoke-no-node-gateway.sh` 的 PASS 包含对 Node 所有者、鉴权快照和 metrics 返回 503 `node_runtime_absent` 的明确断言。它证明 Rust 前门可独立启动并正确拒绝缺失宿主的路径，不代表完整产品功能已在无 Node 时可用。

## 验证状态与下一步

订阅批次完整 37 门禁中 36 项退出 0，订阅与官方账号 80/80、零跳过，Rust 2,736 项及四组 HTTP 对拍通过。标准 npm test 如实为 FAIL，完整归一化报告只包含干净 `bf99c686` 已证明的 fleet-sharing-routes 第 249 行 false/true 与第 514 行 0/4；短路后的阶段未记为通过。原始编排启动竞态和慢读失败证据继续保留，不增加基线例外。已通过授权会话 API 合入；合入时主仓与本工作区干净，双方相对 main 为 0/0。后续提醒入口工作树属于尚未验收的新批次。

任务提醒入口已保留原 `call`、`mutate`、默认时钟、原生异常和 Proxy 写回，旧任务板/Air 对拍独立冻结原入口；现有四文件定向测试 62/62、零跳过。下一次完整门禁须保留前 37 项，只增加该定向项；完整结果出来前不作合入结论。

继续按业务所有者切换调用方和副作用，核销默认/条件挂载、动态插件、HTTP 宿主、WS/SSE 与后台进程；最后用真实发布入口的隔离安装包验证完整功能和进程树、监听端口、升级与回退。当前没有完成上述最终闭环，也没有切换生产配置或重启服务。

## 证据位置

- [订阅合入收据](/artifacts/cb22793be35ae2cf/subscription-entry-merge-receipt.json)
- [37 门禁验收收据](/artifacts/dcd9731389b7aed6/subscription-entry-verification-receipt.json)
- [37 门禁完整证据](/artifacts/94bb939138375e65/subscription-entry-full-evidence.zip)
- [编排启动竞态诊断](/artifacts/285e74387c8fe0ac/orchestration-startup-diagnosis.md)

持久原始证据位于主仓 `data/rust-migration/2026-11-21/provider-cli-batch3/`。订阅交付态快照与审计工具在 `subscription-entry-gates/repository-audit/`；提醒待验收快照、逐项证明和后续完整门禁在 `attention-entry-gates/`。本报告是正式仓库文档；登记预览和下载产物为临时副本。
