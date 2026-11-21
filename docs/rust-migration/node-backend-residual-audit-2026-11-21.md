# Node 后端残留审计：提醒入口交付后（2026-11-21）

提醒入口以验收树 `2b63c501` 原样提交为 `92b917df`，经授权会话 API 合入 `2803ab1b`。主仓与本工作区均干净，双方相对 main 为 0/0。当前统计仍有 **585 个 Node 后端候选文件、137,248 行**；默认启动、运行时依赖和发布包仍需要 Node，整体迁移尚未完成。

| 同口径快照 | 文件 | 物理行 | 相对上一交付态 |
| --- | ---: | ---: | --- |
| 原始 Git 基线 b20db311 | 612 | 139,099 | — |
| 用户指定的订阅已交付基线 a04f0565 | 586 | 137,250 | — |
| 当前提醒入口已交付 2803ab1b | 585 | 137,248 | 净减 1 文件、2 行 |

整个 b20db311 区间共退出 27 个文件、2,197 行，存量文件净增 346 行，无新增候选文件，合计净减 1,851 行（1.331%）。这是源码净变化，不是迁移完成率，也不能全归因本批。提醒入口删除原 15 行文件，在共享原生绑定增加 13 行，实际净减 2 行；策略原本已由 Rust 持有。

## 统计范围与残留

范围为 Git 跟踪的 server.js、ecosystem.config.js、scripts/start-gateway.js，以及 src/、plugins/ 下 JS/CJS/MJS，排除插件 test/tests/extension/ui。按 LF 物理行统计，包含注释、空行与绑定；末行非空且无换行也计一行。基线已逐 Git blob 重算。前端、测试和其它构建工具未计入后端源文件总数，但启动与发布入口另行核对。

主要残留仍包括 routes 95 文件/24,609 行、src 根目录 88/20,584、chat 60/14,020、providers 28/7,150、voice 17/5,274、cli-adapters 29/4,995、task-shell 24/4,542、orchestration 6/3,690。server.js 为 3,080 行，turn-engine 为 2,988 行，providers/core 为 2,390 行。这些代码混合业务、SDK/进程宿主和薄绑定，不能按行数直接判断可删范围。

从 server.js 沿字面量相对依赖保守扫描可达 569 个文件，有 8 个动态加载候选、311 个静态 HTTP/中间件注册候选、35 个不同的 /api/__host/* 路径字面量。它们是静态候选数，不是实时路由或活跃宿主数；注释、条件分支、局部同名函数可能误报，计算型导入可能漏报。本轮没有重启生产或捕获完整条件插件运行路径。

## 启动、依赖与发布仍包含 Node

- package.json 的 main 为 server.js，Node 引擎要求 >=22.16.0；npm start 和 start:gateway 仍运行 node scripts/start-gateway.js。
- 启动器显式把 --node process.execPath 和 server.js 交给 Rust 网关；multicc shell、服务安装和 PM2 配置也保留 Node 宿主路径。
- 桌面包仍打包 server.js/src/plugins；standalone 仍分发并启动 Node runtime。发布入口没有整体退出 Node。
- package.json 有 19 个直接运行时依赖，包含 Express、ws、Claude/ACP SDK、CPR、飞书/Slack/Discord/Telegram SDK、语音及推送库；这不是传递依赖数。better-sqlite3 与 werift 仍为开发依赖。
- 当前范围未见直接加载 node:sqlite 或 better-sqlite3 的字面量导入；src/sqlite/driver.js 实际加载 RustDatabase N-API。Node 仍持有调用回调、错误映射及生命周期。打包脚本中残留“storage is node:sqlite”的旧注释/日志，本轮仅记录未改动。
- no-node 冒烟包含 Node 所有者、鉴权快照和 metrics 返回 503 node_runtime_absent 的断言；PASS 不证明完整产品可无 Node 运行。

## 本批验证及补证限制

完整 38 门禁仅运行一次：37 项退出 0，Rust 2,736 项、提醒 62/62 零跳过及四组 HTTP 对拍通过。npm test 仍如实记录 FAIL，完整归一化失败报告仅有干净 bf99c686 已证明的 fleet-sharing-routes 第 249 行 false/true、第 514 行 0/4；短路阶段未记作通过。

原父进程采样被观察器 5 秒等待截断，历史样本缺失记录保留。用户授权单点补采后，仅单独运行同一个慢读用例一次，父进程 sample 命令退出 0，生成有效调用图；与原运行的网关/Node 样本构成三份有效证据，来源逐项区分，不声称来自同一次进程树。补采包装器的附加进程观察器因缺少 pathlib 导入而报错，包装器退出 1 的原记录保留；这次 Node 退出事件未由该辅助观察器捕获，原完整运行的子进程退出证据仍完整。

原冻结验收脚本没有被改动，也不声称原严格历史采样检查通过。新增补证验收保留源码树、冻结 oracle、产品断言、所有门禁、权限、HTTP 副作用和 npm 精确基线检查，只用经授权补采的调用图满足缺失的父进程诊断要求。没有新增产品失败基线例外；源码和启动探针未变，服务未重启。

## 下一模块仅做只读预检

候选为 11 行 src/network/official-fetch.js，唯一生产消费点为 Codex 官方中继。相关 11 个源码/测试文件哈希在当前合入树重新核对一致，没有实施或测试下一模块。

验证计划先锁定默认 fetch 惰性获取、模块缓存与替身装载时点，保持共享函数别名、两个原函数体、close/取消、NO_PROXY、代理发现刷新和请求不重放。若这些边界不能仅靠原样绑定保留，就暂缓该候选，再评估 19 行 task-board/repository.js 工厂。后续实施须保留全部 38 门禁并增加独立定向验证；本轮只交付候选和计划。

## 收据与证据

- [验收与合入、双方 clean0/0 收据](/artifacts/f29a447441bafefb/attention-entry-merge-receipt.json)
- [补证验收收据](/artifacts/af159301faee9630/attention-entry-supplemented-verification-receipt.json)
- [完整 38 门禁与单点补采证据](/artifacts/2ef91326712fce50/attention-entry-supplemented-full-evidence.zip)
- [采样超时诊断及工具错误说明](/artifacts/2a5f95328ec0f82a/attention-parent-sampling-diagnosis.md)
- [原阻塞收据，保留不覆盖](/artifacts/c611611045f18ed1/attention-entry-incomplete-diagnostics-receipt.json)

本次交付态 JSON、完整文件/依赖/调用方/哈希表和审计工具位于主仓 data/rust-migration/2026-11-21/provider-cli-batch3/attention-entry-gates/post-merge/。本文件更新 official-fetch 验收前的已交付基线，未改写之前验收树。最终默认/条件入口、动态插件、WS/SSE、后台进程及真实安装包的无 Node 闭环仍未完成。

## official-fetch 本批候选（待完整验收）

退休 11 行门面，现有 SDK 适配器增加 12 行惰性捕获，生产 Node 净增 1 行、少 1 文件；候选 584 文件/137,249 行，尚未交付。唯一生产消费点只改导入。两个函数仅统一缩进，原工厂/Dispatcher/代理策略及 Rust/启动探针未变。Node 例外仅为 Undici/proxy-agent SDK 适配与装载桥接，无新增业务策略。87/87 定向零跳过和旧门面缓存对拍已通过，完整门禁尚待验收。没有把减少文件数宣称为整体 Node 退休。
