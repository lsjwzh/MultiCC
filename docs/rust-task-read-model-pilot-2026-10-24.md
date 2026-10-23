# Rust 任务摘要读模型试点 · 2026-10-24

本轮用户已授权默认接入 Rust 并提交合并，最新接入范围见 [Air 摘要读模型默认使用 Rust](rust-air-read-model-2026-10-24.md)。下文保留为接入前的阶段记录。


后续：[热路径优化与 Air 契约隔离验证](rust-task-read-model-hot-air-2026-10-24.md)。下文记录首轮试点的实现与测量，后续变化以该补充报告为准。


本轮完成只读 Rust 试点及隔离对照，没有切换生产任务列表入口。结论是继续推进重型读取有价值，但当前实现不适合整体接管 Air：冷读、数据库变更后刷新和主线程响应性改善，热缓存、纯分页缓存与仅元数据变化的路径仍慢于 Node。

## 已实现边界

- `native/core/src/task_read_model/`：Rust 拥有只读 SQLite 连接、选择性 JSON 解析、摘要快照、分页、筛选、排序、统计与有界查询缓存。上下文正文、交接快照等不需要的字段不构造成通用 JSON 对象。
- `native/addon/src/task_read_model.rs`：通过已有 N-API 模块的后台任务执行文件读取和计算，导出 `RustTaskReadModel`。
- `src/native/task-read-model.js`：试点桥接，保证受理顺序、限制最多 16 个未结束调用，复用全局原生并发限制。单次失败不污染队列，关闭等待已受理命令结束，关闭失败可重试。
- 新增 `tests/test-task-read-model.js`、测试专用 Node 对照及 `scripts/benchmark-task-read-model.js`，纳入 `npm run test:rust` 和测试分层清单。

生产路由没有导入试点桥接文件；原有任务写入者、权限规则、调度、Git 状态、运行配置和 WebSocket 增量协议保持原有入口。

## 数据与接口契约

数据库必须已经存在，`user_version=1`，源表为 `shell_records(kind,id,body)`。只查询 `kind='task'`，不接受任意 SQL，不创建源库、不修改其 schema、不增加正式索引，也不承接业务写入。

Rust 从源记录提取 id、目录、标题、可选生命周期、消息时间、会话及工作流元数据。`updatedAt` 缺省时使用 `createdAt`，消息时间采用引用时间最大值及既有回退顺序。源行 id 必须等于正文 id。状态字段缺省和显式 null 保持区别。时间字段要求有限且在 JavaScript 安全数值范围内，未支持的类型、损坏 JSON、孤立 surrogate 均明确报错。

`refresh` 接受 metadata 与按任务 id 分组的 overlays。overlays 只接收既有宿主提供的目录/会话修正、权限、线路、运行状态、目标状态、资源、Git 变化与提醒等摘要字段；本轮没有重新实现这些字段的业务判定。数据库任务壳记录本身不等于任务板卡片：真实记录缺少生命周期、引用列表等信息，不能据此推断完整 Air 行为已经等价。

数据库读取在同一只读事务中完成，候选快照全部成功后才替换旧快照。缓存使用持久读取连接的 `PRAGMA data_version`、metadata、overlays 与 ID 顺序共同失效。所有写入都来自其他连接；不能把这套判断直接复制到一个同时写入的连接。当前任何数据库提交都可能使快照重建，尚未实现逐任务数据库增量读取。

刷新失败直接返回错误，不标记新鲜、不自动回退。上次完整快照仍可用于明确请求旧快照的诊断；调用者必须先成功刷新，再把查询结果当成本轮状态。源文件被移走或原子替换时拒绝继续刷新，要求重新打开。`revision` 是试点快照版本，不是生产 WebSocket cursor，未实现生产重放协议。

## Node 桥接例外

Node 保留 N-API 调用、JSON 边界、异步排队和 ICU 排序适配。真实记录检查中发现 159 个历史 ID 不符合标准小写字母/数字任务 ID 格式；其同时间排序必须沿用现有 `localeCompare`。Rust 检测到需要排序适配时只返回 ID，Node 用当前运行时的 ICU 排序后传回顺序，不接收完整上下文。Rust 校验顺序完整性，遇到新增或删除导致的陈旧顺序时最多重新获取并重试一次。

保留这部分 Node 的具体原因是兼容现有 V8/ICU 排序契约；不是在桥接层新增任务业务。后续独立 Rust 后端应先固定排序 locale 与 Unicode/ICU 兼容契约，再移除这个适配。测试辅助中的 Node 投影只作为差分判据，不被产品入口引用。

## 实测方法

- Apple M4，macOS ARM64，Node v26.8.1，release 原生模块。测试时间为 2026-10-23T17:02:39Z 起，即北京时间 2026-10-24。
- 100、3000、10000 条合成任务，每条附带 8192 字符上下文；另以源数据库单个读取事务捕获 1130 条真实任务壳原始记录，共 11,220,478 字节，生成任务表隔离副本。
- 真实副本只包含任务行，重新建立相同表和查询索引，不保留生产库中其他 kind 的物理布局。生产数据库仅只读捕获，所有计时写入、改名及缓存失效测试都发生在临时副本。临时数据库已清理，公开结果不包含任务标题、正文或 ID 列表。
- 三种方案各使用独立进程：现有 Node 业务及行缓存配 Rust SQLite；相同 Node 业务配旧 Node SQLite；Rust 直接读取及摘要模型。当前驱动与 Rust 模型均使用 SQLite 3.50.2，旧 Node 驱动为 3.53.4。
- Node 对照复用生产 `createTaskShellStore().cachedList/epoch` 和 `createAirReadIndex`，同样具有不变快照检查、分页及统计缓存。权限、Git、容量等卡片底稿字段作为固定覆盖输入提供，未将完整生产卡片签名或底稿组装计入语言收益；卡片缓存本身另有相邻回归覆盖。
- 每种方案预热 2 次、计时 11 次。4 组数据、3 个后端、5 个场景，共 660 个计时样本。包含参数编码、排队、原生边界、结果解码、分页与统计。冷读在已打开、尚未加载摘要的连接上计时；不是磁盘冷缓存，也不包含连接打开。
- 每轮核对刚变更的任务，防止未失效缓存产生假快结果；每个场景结束再逐字段比对整份摘要快照、分页和统计。计时期间未并行运行本轮的编译和回归测试。后端按固定顺序运行，仍可能受其他本机进程和测量顺序影响。
- JSON 中保留样本、P95、CPU 和进程峰值 RSS。11 个样本的 P95 不能当作生产服务指标，RSS 包含数据夹具与全部运行时，不能据此承诺省内存。

## 冷读与数据库变更

以下均为中位数，单位 ms。“当前 Node”指 Node 业务配当前 Rust SQLite 驱动，“旧驱动 Node”指同样优化的 Node 业务配 Node SQLite。

| 数据 | 场景 | 当前 Node | 旧驱动 Node | Rust 摘要模型 |
| --- | --- | ---: | ---: | ---: |
| 合成 100 条 | 冷读＋分页＋统计 | 2.233 | 2.257 | 0.936 |
| 合成 100 条 | 改一条后刷新＋分页＋统计 | 2.136 | 2.203 | 1.401 |
| 合成 3000 条 | 冷读＋分页＋统计 | 65.632 | 66.189 | 26.849 |
| 合成 3000 条 | 改一条后刷新＋分页＋统计 | 59.863 | 59.163 | 33.068 |
| 合成 10000 条 | 冷读＋分页＋统计 | 239.716 | 258.989 | 101.980 |
| 合成 10000 条 | 改一条后刷新＋分页＋统计 | 224.475 | 247.788 | 121.078 |
| 真实记录副本 1130 条 | 冷读＋分页＋统计 | 33.210 | 31.657 | 17.876 |
| 真实记录副本 1130 条 | 改一条后刷新＋分页＋统计 | 31.171 | 29.778 | 10.076 |

真实副本相对当前 Node 的冷读约快 1.9 倍，变更后刷新约快 3.1 倍。相对已测更快的旧驱动 Node，冷读约快 1.8 倍。包含历史 ID 的 Rust 冷读需要首次获取 ICU 顺序，开销也在上述计时中。收益来自只解析需要的字段并留在后台，不是仅仅更换 SQLite 驱动。

## 热路径的退步

| 数据 | 场景 | 当前 Node | 旧驱动 Node | Rust 摘要模型 |
| --- | --- | ---: | ---: | ---: |
| 合成 3000 条 | 不变快照刷新＋分页＋统计 | 1.528 | 1.487 | 7.181 |
| 合成 3000 条 | 仅置顶元数据变化＋分页＋统计 | 5.435 | 5.675 | 29.835 |
| 合成 3000 条 | 缓存分页＋统计 | 0.009 | 0.007 | 0.123 |
| 真实记录副本 1130 条 | 不变快照刷新＋分页＋统计 | 0.041 | 0.046 | 0.213 |
| 真实记录副本 1130 条 | 仅置顶元数据变化＋分页＋统计 | 0.896 | 0.878 | 9.429 |
| 真实记录副本 1130 条 | 缓存分页＋统计 | 0.005 | 0.008 | 0.121 |

Rust 仍需传递、解析和比对整份 overlays/metadata；仅元数据变化也会重读源记录。Node 行缓存能够复用已解析源对象。这些问题需要用可靠的输入增量、摘要缓存和批量接口解决，不能用旧 Node 的全量重建作为唯一对照来掩盖。

## 主线程响应性

1ms 心跳记录每次运行中的最大回调间隔，再对 11 次取中位数。它是事件循环探针，不是页面帧率或 HTTP/WebSocket 端到端指标。

| 场景 | 当前 Node / ms | Rust / ms |
| --- | ---: | ---: |
| 合成 3000 条冷读 | 66.971 | 4.808 |
| 合成 10000 条冷读 | 239.779 | 12.831 |
| 真实记录副本冷读 | 34.349 | 1.850 |
| 真实记录副本变更后刷新 | 32.560 | 1.388 |

大份 overlays 的 Node 编码仍会造成停顿，Rust 后台读取没有消除这部分主线程工作。

## 验证与限制

- 最新 `npm run test:rust`：122/122，通过且零跳过；其中读模型 20 项，包含 132 组查询对照、历史 ID 的 ICU 顺序、缺省/null、跨连接增删改、损坏行恢复、只读保护、schema 拒绝、源文件替换、独立进程锁竞争、并发整批提交、关闭重试与队列顺序。
- Air、卡片缓存、任务壳行缓存/查询索引、任务搜索和全文检索相邻回归：116/116，通过且零跳过。
- Cargo fmt、Clippy 全目标 `-D warnings`、JavaScript 语法、测试分层、产物治理、运行时写入清单、`git diff --check` 均通过。
- 全仓行数门禁仍失败：`scripts/macos-agent/MultiCCAgent.swift` 为 3061 行，上限 3015。已用字节比较核实它与 HEAD 相同，本轮没有修改；不宣称全仓门禁全绿。
- 本机仅验证 macOS ARM64 / Node 26。Node 22、Windows、Linux、其他 CPU 架构及完整安装包尚未在本轮执行验证。
- 真实记录副本等价验证只证明约定摘要投影、分页和统计；未验证完整 Air 可见性/权属/任务板合并、动态容量、派发宽限、生产 WebSocket 游标及重放，也没有进行真实请求分布的持续影子运行。

## 复现

构建和输出目录应位于主仓数据目录或工作树外，不要放进可回收任务工作树的 ignored 目录。

```sh
RUN_DIR=/absolute/primary-repo/data/rust-task-read-model/my-run
npm run build:rust -- --out "$RUN_DIR/prebuilt"
export MULTICC_RUST_PREBUILT_DIR="$RUN_DIR/prebuilt"
export MULTICC_RUST_ADDON="$RUN_DIR/prebuilt/darwin-arm64/multicc_core.node"
MULTICC_REQUIRE_RUST_TESTS=1 npm run test:rust
npm run benchmark:task-read-model -- --sizes 100,3000,10000 --rounds 11 --out "$RUN_DIR/comparison.json"
# 可选：SOURCE_DB 指向现有任务壳数据库；程序只读捕获，并在临时副本上计时。
npm run benchmark:task-read-model -- --sizes 100,3000,10000 --rounds 11 --source "$SOURCE_DB" --out "$RUN_DIR/source-comparison.json"
```

平台目录按实际架构替换。两个原生模块环境变量应指向同一份新构建，避免部分既有测试优先采用继承的旧预编译目录。

调用示例仅用于隔离副本：

```js
const { createTaskReadModel } = require('./src/native/task-read-model');
const model = createTaskReadModel();
try {
  await model.run({ op: 'open', file: '/absolute/isolated/tasks.sqlite' });
  await model.run({ op: 'refresh', metadata: {}, overlays: {} });
  const page = await model.run({ op: 'page', options: { status: 'all', limit: 20 } });
  const stats = await model.run({ op: 'stats', dayStart: 0 });
} finally {
  await model.close();
}
```

本机原生模块、原始计时 JSON 与日志保存在主仓 `data/rust-task-read-model/2026-10-24/`。最终计时文件 `comparison-final.json` SHA-256 为 `f3f6fc5b341d36f39831f24595a835e4fe4969b9232138b88052e95aaf2deca3`；模块 SHA-256 为 `b52c82e2cc5bbe5aab6f5c810da775fedeb26134e954be5c620e5e8d47159891`。

[下载完整计时数据](/artifacts/22a8b2a93325725f/task-read-model-comparison.json?download=1)。这是默认保留 7 天的临时下载副本，正式报告及主仓数据目录才是本次记录的保存位置。

## 下一阶段

先减少热路径跨语言复制，令 metadata/overlay 变更能够复用 Rust 内的已读摘要，再补齐真实 Air 拼接、可见性、状态与重放契约，进行真实请求分布的只读影子比对。达到一致性和延迟门槛后，才另行评估生产启用；本轮没有增加默认切换开关，没有修改生产配置、重启服务、提交、合并或推送。
