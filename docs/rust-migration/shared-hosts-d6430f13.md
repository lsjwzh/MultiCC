# 共享 Node 入口迁移（基线 d6430f13）

从 server.js 追踪盘点脚本的 local 和 scriptPaths；包含入口，以实际换行计数。基线 404 个文件、102208 行。割点收益按「删除该点后，从入口不可再达的节点数」计算。仍需注入的下游必须继续计数。下表为改接前的设计。

| 原 src/ 文件 | Rust 边界、类型和所有权 | 失败与宿主接口 |
|---|---|---|
| request-locality.js | http_gate 与 request_locality 操作借用原始 req；每个环境保持两份冻结的 Set | 保留 header/socket getter 异常与短路顺序 |
| cli-adapters/result-completion.js | cli_completion 直接借 event，返回判定对象；每次构造独立 tracker | 保留无终止事件、协议错误与原对象 |
| cli-adapters/completion.js | cli_completion 分派 adapter、协议和 step tracker，接收活对象 | 回调使用 adapter 作 this，保留默认值、TypeError |
| cli/cli-capability.js | cli_catalog_views 持有目录及动态 efforts 快照 | Node 持有文件监听、模块解析与 disposer，保留刷新告警 |
| repo-actor/index.js | repo_actor_api 按实例拥有串行队列；RepoActor 构造器由同一模块实例共享 | 保留 PATH 初始化、子进程错误与 JS Promise |
| git/service/index.js | git_service_api 持有同一个仓库 actor | AsyncResource.bind 保留异步调用上下文，错误原样传播 |
| task-board/core/index.js | task_board_core_api 组合 planning、normalize、bridge、routing，保留同一 board 的记录身份 | 注入已有领域方法，保留变更、分类及异常 |
| session-work/index.js | Rust 组合 scheduler 与 host API，后者的同名属性按原序覆盖 | 注入 crypto、账号端口和提问所有者，工厂失败原样传播 |
| providers/codex-history-hooks.js | responses_history 按工厂捕获可选 logger，返回冻结 hooks | 不处理未交给原方法处理的 getter/回调异常 |
| model-history-converter.js | responses_history 接收原始 body、错误和 extraIds，沿用原地修复 | 保留缺省选项、新数组与 null 选项异常 |
| state/container.js | Rust 构造每环境唯一的可写三字段对象，Map 仍属服务启动器 | 初始化为 null，读写共享引用 |
| bus.js | Rust 构造每环境唯一的 EventEmitter 并设置 50 个监听器阈值 | 同步调用、监听器异常及 once/off 仍由 EventEmitter 提供 |
| workspace/air-routes.js | Air 挂载入口借 app 与 deps，创建 runtime、调用 mount 并返回同一 liveSync | 创建或挂载异常直接传播 |
| session/chat-history-service/index.js | history_service 按工厂管理变更和返回值；消息快照按实例持有 | 第一次读 messages 时克隆，可枚举 getter、异常和冻结性保持 |
| voice/router.js | voice_router 构造 provisioner，借 Map、mutate、时钟与文件系统端口 | 校验类型并保留错误文案，mkdir 延迟执行 |
| liveness/rollout-path.js | rollout_resolver 每实例拥有命中/未命中缓存及有效期，借注入的 FS/时钟 | 按旧顺序验证依赖并传播宿主文件系统异常 |
| tunnel/index.js | tunnel_monitor_api 组合进程、文件、网络及厂商接口 | 同步加载与异步探测沿用既有错误边界 |
| orchestration/host.js | orchestration_runtime_api 按环境组合存储、等待、操作服务；每 runtime 独立异步上下文 | V8 包装 async 方法，保留异常拒绝及函数签名 |
| chat/index.js | Rust 按旧顺序合成各模块的 API，仅复制可枚举属性，保留函数及记录身份 | 按顺序加载与读取，getter 异常直接传播 |
| task-board/routing.js | 路由核心借 board、Map、Set、候选和可用性端口，返回原始会话记录 | ICU/Date、迭代语义和外部回调留在 V8，可用性异常沿用 false |

## 实施后逐项复核

下表依照实际改接顺序。基线对应切点的理论剪枝规模不等于实减：例如看板核心理论覆盖 3 个，改接时仍需 normalize 和 routing，首步只减 1 个；随后 routing 单独迁移再减 1 个。CLI 注册总入口和任务壳宿主各覆盖 15 个，但包含仍在工作的 SDK、进程或存储子图。11 项审计草稿单独保存，避开了必须改写这些草稿调用方的 paths 和 runtime-security。

| 顺序 | 文件 | 直接引用方（改接时） | 剩余 | 所有权和错误模型复核 |
|---:|---|---:|---:|---|
| 1 | `src/request-locality.js` | 31 | 403 | 沿用 http_gate 判定；两个 Set 仅构造一次，六个查询借用请求，不保留 header。 |
| 2 | `src/cli-adapters/result-completion.js` | 6 | 402 | 协议判定复用 cli_completion；独立工厂创建跟踪器，无跨进程状态。 |
| 3 | `src/cli-adapters/completion.js` | 9 | 401 | 适配器回调保持 this 和第二次属性读取，未提供回调用原生 fallback tracker。 |
| 4 | `src/cli/cli-capability.js` | 30 | 400 | 查询留在 cli_catalog_views；为 watcher 保留 V8 Promise 和同一个 listener，平台包从原 cli 目录解析。 |
| 5 | `src/repo-actor/index.js` | 6 | 399 | 已有 repo_actor 工厂拥有队列；仅 class 包装、随机数和 promisify(execFile) 属 Node。 |
| 6 | `src/git/service/index.js` | 8 | 398 | 已有 git_service 直接使用同一个 defaultRepoActor；回调仍绑定 MultiCCGitOperation 异步上下文。 |
| 7 | `src/task-board/core/index.js` | 8 | 397 | 复用 task_board_runtime/core.rs，向工厂传活的四组端口；其所需下游分别统计。 |
| 8 | `src/session-work/index.js` | 2 | 396 | 在 session_work_host 组合 scheduler 和 host 两份对象，先求值并复制调度器，再加载宿主端口。 |
| 9 | `src/providers/codex-history-hooks.js` | 1 | 395 | 在 responses_history 下持有对应工厂的 logger，保留冻结对象及 warn getter 的读取顺序。 |
| 10 | `src/model-history-converter.js` | 1 | 394 | 选项解构交给 V8；原生模块支持默认新数组、原对象共享及错误原样抛出。 |
| 11 | `src/state/container.js` | 4 | 393 | 三张 Map 仍由 server 启动时注入，Rust 构造共享容器并保留普通可写字段。 |
| 12 | `src/bus.js` | 2 | 392 | EventEmitter 保留监听器身份、顺序和同步抛错；Rust 设置阈值，同一环境复用同一对象。 |
| 13 | `src/workspace/air-routes.js` | 1 | 391 | 借 mount 的 receiver，传 app 原值；经过真实宿主端口注册后返回 liveSync。 |
| 14 | `src/session/chat-history-service/index.js` | 1 | 390 | 在 history_host/service 保存按调用复制的数组，首次读取时才 JSON 克隆；getter 失败可以重试。 |
| 15 | `src/voice/router.js` | 3 | 389 | voice_router 拥有入口校验并复用已有 provisioner；Map、FS、时钟保留可注入端口，依赖解构保留 V8 异常。 |
| 16 | `src/liveness/rollout-path.js` | 1 | 388 | 在 liveness/rollout 复用扫描及过期策略，按解析器分配 Map；保留 V8 依赖解构及路径拼接。 |
| 17 | `src/tunnel/index.js` | 1 | 387 | 直接复用 tunnelMonitorApi；网络、子进程与目录端口继续按原顺序装配，独立加载能获得新的数据目录。 |
| 18 | `src/orchestration/host.js` | 1 | 386 | 复用 orchestrationRuntimeApi 的默认参数和公共方法；保留 AsyncLocalStorage、async 函数签名及只读 DEFAULTS 访问器。 |
| 19 | `src/chat/index.js` | 2 | 385 | 按旧序逐个获取并复制源对象自身可枚举属性；避免提前读取后续模块和 Symbol 或 getter 丢失。 |
| 20 | `src/task-board/routing.js` | 1 | 384 | 任务域路由留在 task_board_runtime/routing；只向 V8 借 iterable 展开、带接收者的回调及 Date.parse。导出顺序纳入差分。 |

旧 CommonJS 路径保留兼容导出供外部工具及既有调用者使用。生产调用方从共享绑定直接取对应领域 API。原生工厂已存在的模块在本批完成调用方改接；需要 Node 的进程、监听、包解析、异步上下文和日期等端口保留在绑定层。文件、行数仍按原 server.js + src 静态可达口径统计。

在逐项改接后，缺少 addon 的独立进程差分发现了导入时机差异。新增可达文件 `src/native/bootstrap-apis.js`，只保留缺少平台二进制时原本就能使用的状态对象、事件总线、参数校验和延迟绑定；需要原生实现的方法在调用时重试并传播加载失败。20 个旧入口退出，新增 1 个兼容入口，总计 385。普通加载和缺失 addon 两种进程均以 d6430f13 的实际源代码为基准。

## 验收

macOS ARM64 Release 构建、定向和完整 npm test 退出码均为 0。定向通过 687 项。完整 Node 测试摘要共 8292 项，通过 8285，失败 0，跳过 6，TODO 1。Air 路由合约改为检查 Rust 挂载链及内部 Node 宿主端口，26/26 通过。首次差分发现的导出枚举顺序、null 解构、缺失 addon 的模块加载时机均有基线用例；加入差分测试后同步更新了发布门禁的套件登记及总数。
