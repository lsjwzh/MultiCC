# 剩余 Node 后端清单

## Gemini、Grok 启动参数与受管聊天上下文（2026-11-25）

| 整份退出的生产文件 | 唯一生产调用方 | 迁前行数 | 冻结的 Git blob |
|---|---|---:|---|
| `src/cli-adapters/gemini.js` | `src/cli-adapters/index.js` | 26 | `54766d1c` |
| `src/cli-adapters/grok.js` | `src/cli-adapters/index.js` | 33 | `d476dea8` |
| `src/chat/managed-context.js` | `src/chat/turn-engine.js` | 34 | `9986a5cc` |

Rust 接管两个 CLI 的启动参数、终端续跑标志，以及受管上下文的首次准备、重试重建、提示词更新和完成判定。Node 的 ACP 适配器仍调用 V8 拼接终端命令，聊天宿主仍持有每次尝试使用的闭包并提供记忆和回执接口，以保留宿主对象身份、类型转换和回调行为。相应宿主迁出后可移除这部分接线。[CLI 启动策略](../../native/addon/src/acp_launch.rs) · [上下文实现](../../native/addon/src/message_composer/managed_context.rs)

以第三批提交 `e66dec58` 为基线，生产入口可达的 Node 由 492 个文件、126,506 行降至 489 个文件、126,440 行。三份旧文件合计 93 行，其余生产文件接线净增 27 行，本批净减 66 行。以 `dc0df5fe` 为起点，前三批已提交，累计退出 3 份、净减 187 行；计入本批工作树，累计退出 6 份、净减 253 行。统计包含根 `server.js` 和从它或其宿主脚本可达的 `src/` 文件，排除测试、前端与离线工具。[生产依赖清单](node-module-dependencies.md)

三份测试副本只调整了依赖路径。迁前定向回归 144/144，迁后 145/145，追加的一项覆盖重建失败后的重试和回执身份。Gemini 和 Grok 共比对 256 组启动或终端输入，受管上下文比对 24 组回执、首次计划、阻塞和成功状态组合。macOS ARM64 发布构建的五份产物均通过源码指纹和文件摘要校验，指纹为 `ac53c9ba37db0e657fa9e24a`。隔离网关聊天回合、API 契约和原生产物回归共 40/40。[CLI 差分](../../tests/test-acp-adapter.js) · [上下文差分](../../tests/test-context-plan.js)

## CLI 中继启动参数（2026-11-25）

`src/chat/cli-relay-spawn.js` 已从生产目录整份删除。唯一生产调用方是聊天回合引擎。Rust 接管 Claude/Codex 中继选择、参数顺序和续跑标志，首次 Claude 会话使用现有 Rust UUID v4 生成器，并依次调用宿主的状态登记和保存接口。Node 兼容入口传递宿主对象和回调，待聊天引擎直接持有这些状态后可移除。[Rust 实现](../../native/addon/src/process_spawn_args.rs) · [生产调用方](../../src/chat/turn-engine.js)

相对任务分支 `755e5a18`，生产入口可达的 Node 从 493 个文件、126,561 行降至 492 个文件、126,506 行。删除 65 行，兼容接线净增 10 行，本批整份退出 1 个文件、净减 55 行。从 `dc0df5fe` 起三批累计整份退出 3 个文件、净减 187 行。[生产依赖清单](node-module-dependencies.md)

旧 JS 冻结副本与原文件的 Git blob 均为 `f98d1ba92151c10afebfc8a3976c1a96ac064215`。迁前、迁后定向回归各 123/123，覆盖 16 组目标选择、81 组启动配置和 5 处失败时的状态；新 UUID 先校验格式和传递一致性，再归一化比较。macOS ARM64 发布构建的 5 份产物均匹配指纹 `39ac02c70c5f5a94c7101fb7`。另通过适配器参数回归 22/22，以及隔离聊天回合、API 契约与原生产物回归 40/40。[冻结差分](../../tests/test-agy-remote-bridge.js)

## 聊天适配器收尾（2026-11-25）

`src/chat/adapter-completion.js` 的唯一生产调用方是聊天回合引擎。43 行旧实现已从生产目录整份删除。Rust 负责记录完成证据、处理缺失跟踪器，以及决定发送失败和收尾失败分别调用哪个回调。兼容入口保留 V8 的 Promise 回调和严格属性写入，待运行器和流的生命周期迁入 Rust 后可移除。[Rust 实现](../../native/addon/src/cli_completion/adapter.rs) · [聊天回合入口](../../src/chat/turn-engine.js)

基线为任务分支提交 `1c4f66ea`。排除测试和离线工具后，生产入口可达的 Node 代码从 494 个文件、126,584 行降至 493 个文件、126,561 行，整份退出 1 个文件，净减 23 行。旧实现的 Git blob 为 `d475a8038c2447e6b25add4b93ad03d748c3a67a`，测试副本仅调整了两处依赖路径。迁前 222/222，迁后 223/223，覆盖 36 组成功与失败组合，并校验同步回调顺序、异常身份、冻结对象的错误文案及收尾次数。macOS ARM64 发布构建指纹为 `f3d2264231d18d96c6d73aed`。隔离网关聊天回合、聊天宿主、原生产物和 API 契约回归共 75/75。[定向回归](../../tests/test-cli-completion.js) · [生产依赖清单](node-module-dependencies.md)

## 按文件迁移：回合结束路由（2026-11-25）

生产文件 `src/chat/post-turn-router.js` 的 111 行已整份移除。Rust 生成有序的交接、派发和网关投递效果，按已有回执去重，并验证投递证明。聊天宿主仍负责实际投递和持久化，通过三个同步原生接口传递活动对象，保留 getter 顺序与标识引用。这些调用随宿主迁出后即可移除。[路由实现](../../native/addon/src/post_turn_router.rs) · [调用方](../../src/chat/host-coordinator.js)

以 `dc0df5fe` 为基线，排除测试和离线工具，从 `server.js` 或其宿主脚本路径可达的后端代码由 495 个文件、126,693 行降至 494 个文件、126,584 行，净减 109 行。旧文件冻结于测试目录，Git blob 为 `8b24e283eb580b1f125946026d33f37a4aaf3564`。迁前定向 97/97，迁后 100/100，含 480 组逐字节路由差分；隔离网关和聊天宿主回合通过。本机 macOS ARM64 发布构建中，同时生成交接与网关两项效果，7 组各 20,000 次，每组单次平均耗时的中位数为旧 JS 0.268 微秒、Rust 兼容入口 6.336 微秒。[冻结差分与回归](../../tests/test-chat-turn-core.js) · [依赖清单](node-module-dependencies.md)

## 会话公开文本脱敏（2026-11-25）

公开会话说明与错误详情复用 Rust 的凭据和路径脱敏规则。兼容宿主按原顺序转换输入、调用原生接口，再以 UTF-16 码元截断。DTO 属性遍历、敏感字段检查和对象投影仍在 JavaScript 中执行，以保留自定义数组遍历、动态属性和对象引用。其余部分迁移前须验证这些行为，包括自定义遍历器暴露的敏感字段和调用方传入的对象身份。[原生入口](../../native/addon/src/session_dto.rs) · [公开会话边界测试](../../tests/test-session-domain.js)

冻结输入 6,668 例在迁移前后均无差异，两次定向回归各通过 251 项。在 macOS ARM64 发布构建上，12 个 UTF-16 码元的单次处理耗时中位数从 0.268 增至 0.923 微秒，9,216 个码元从 63.04 增至 121.28 微秒。

## 产物引用识别（2026-11-25）

产物保留、产物路由、文档登记和任务产物收集共用 Rust 的路径规则、引用识别、去重和排序。原生桥在 V8 上按读取顺序遍历活动对象，保留 getter、Proxy、循环引用与迭代器关闭行为。冻结实现的 Git blob 为 `38c65090`。[原生桥](../../native/addon/src/artifact_reference.rs) · [差分用例](../../tests/test-task-artifacts.js)

macOS ARM64 release 中，迁前和迁后定向各 52/52，扩大范围后各 138/138。229 条冻结记录逐字节相同，三个种子的各 20,000 轮随机差分均无差异，Rust 内核测试 8/8。共用迭代器的事件回放另经 5,404 例差分和磁盘日志重连复验。82,390 字节文本含 1,250 处引用，旧 JS 和整合版单次耗时中位数分别为 0.172 和 0.286 毫秒。1,000 个字符串的数组分别为 0.111 和 0.470 毫秒。调用方仍同步消费结果。

## 回合事件回放（2026-11-25）

聊天引擎重连和报告 CLI 共用 Rust 的工具计时、日志与记录差分和未结束任务恢复。CommonJS 入口传递 V8 值以保留 getter、异常、迭代顺序和对象身份，待两个调用方迁出后可移除。[回放入口](../../src/chat/turn-event-replay.js) · [冻结差分](../../tests/test-turn-event-replay.js)

子任务补丁基线 `eaf9f829`。整合时同时保留语音和回放的 addon 探针。CommonJS 薄桥恢复普通函数声明，三个导出均可按冻结版构造调用，省略差分选项时会读取默认对象继承的阈值。整合源码的迁前、迁后各 181/181，均通过 5,404 例冻结差分，摘要 `a0743527`，Rust 定向测试 6/6。以磁盘日志驱动实际 WebSocket 重连处理器，只有近期未结束的任务补发中断帧，已有活跃任务时跳过日志。macOS ARM64、Node v26.8.1 下，2390 条事件、1,024 个字符串 ID 的同步恢复耗时从 0.121 到 2.222 ms（七轮中位数）。同规模对象 ID 从 0.133 增至 19.240 ms，Symbol ID 从 0.125 增至 18.360 ms。这是初版按引用逐项比较的量测。

重连从磁盘日志恢复未结束任务时，Rust 负责事件顺序，每次调用使用独立的 V8 Map 索引任务。键可以是字符串、对象、函数或 Symbol。任务删除后重开时保留冻结实现的输出顺序与对象身份。在主线 `5cddb37f` 上，修订前后各通过 5,404 例冻结差分，定向回归分别通过 181 项和 184 项。macOS ARM64、2,390 条事件、1,024 个不同标识下，公开入口的单次耗时中位数（冻结 JavaScript／修订前 Rust／最终 Rust，单位为毫秒）为字符串 0.336／4.923／6.440，对象 0.253／50.737／6.851，Symbol 0.355／46.099／5.993。本次量测仅覆盖未结束任务恢复。 全部编译作业结束后用相同二进制复测，分别为字符串 0.219／2.374／2.139，对象 0.097／18.719／2.152，Symbol 0.122／18.189／2.116 毫秒。两次量测中对象和 Symbol 均得到改善，字符串相对上一版 Rust 的变化方向不同。

## 语音历史扫描中的重复模板（2026-11-25）

Rust 以每条消息的前 24 个 UTF-16 码元为键，按用户和助手分别计数。同一前缀达到三次后，剔除该组全部消息，保留其他消息的原始顺序。原生模块从 V8 读取有界前缀，在工作线程计数。Node 保留文件读取和按结果选回原消息对象的适配，待历史读取和消费方迁出后可移除。[学习器与落盘测试](../../tests/test-hotword-learner.js)

冻结学习器 Git blob `ae4ce062`。迁前、迁后各 44/44，集成 86/86，Rust 语音测试 52/52。128 组前缀差分和 30 组完整刷新均吻合，包括孤立代理码元和尾部 NUL。6 个会话的完整刷新从 9.89 到 10.57 ms，80 个会话从 24.48 到 22.72 ms（macOS ARM64，七轮中位数）。1,710 条消息单测筛选阶段，冻结 Node、缓存前缀的 Node、release Rust 分别为 0.412、0.314、0.674 ms。

## 语音历史扫描的词汇筛选与排名（2026-11-25）

语音学习器按用户和助手两份词频表生成最多 80 个热词。Rust 直接使用词频表中的出现次数、拼写和会话数，按来源筛选，保留用户拼写并按次数稳定排序。兼容宿主继续读取历史文件、清理正文、识别拼写形态和保存学习器状态。这样现有调用方仍可从 `mineTypedTerms` 取得原会话对象、Set 和 Map。历史读取与拼写接口迁出后可移除相应的 Node 适配。[排序实现](../../native/core/src/voice_typed_terms.rs) · [学习器回归](../../tests/test-hotword-learner.js)

冻结学习器 Git blob `7a37787f`，词频模块 `54017195`。三套定向测试迁前、迁后各 43/43，集成 86/86，Rust 语音测试 51/51。30 组隔离历史目录覆盖空结果至 80 项上限，刷新后的状态文件逐字节一致，快照与日志也相同。以 macOS ARM64 release 交替运行完整刷新，去掉预热后取七轮中位数，6 个会话从 9.63 降至 9.17 ms，80 个会话从 17.79 降至 16.17 ms。相对前八批，生产 Node 净减 16 行。

## 任务板计划错误的 HTTP 状态（2026-11-25）

Rust 网关将 11 个计划错误码和默认状态 400 的状态表编入二进制。兼容宿主从同一份表读取状态，以精确的字符串键查找；这样缺少 addon 时仍可返回原有拒绝状态。宿主端口显式返回的 409、423 等状态照常保留。等最后的计划宿主端口迁出后，可移除 Node 的查询适配。桌面与独立包暂存器携带这份表，源码缓存将它的内容计入指纹。[共享状态表](../../native/core/src/task_planning_status.json) · [回环端口测试](../../tests/test-task-routes-host.js)

旧宿主 Git blob `d933ec13`。迁前、迁后定向各 139/139，正常及缺模块环境分别通过 114 组冻结差分。Rust 状态映射 1/1，公开 HTTP 路由 4/4，源码与边界回归 48/48，桌面和独立包共用的暂存副本验证 1/1，npm 包清单包含该表。较前七批候选减少 3 行生产 Node，仍有 498 个 src 脚本、309 个业务或宿主编排文件。

## 看板搜索的查询词排序（2026-11-25）

兼容宿主和独立网关共用 Rust 的查询词选择。分词仍沿用原有顺序，按 UTF-16 长度稳定降序取前 12 个词，单个汉字等单码元词的权重为 0.34。兼容宿主保留 V8 的输入转换、ICU 规范化、短语空白处理和高亮数组引用。待调用方迁出后可移除这些端口。[共享排序实现](../../native/core/src/search_tokens.rs) · [冻结差分](../../tests/test-task-search.js)

冻结旧文件为 `1047470d`。搜索与归属等四套测试迁前、迁后各 95/95，另有 609 组输入及转换异常检查。集成首次 152/153，补齐同源 release 网关后全组 153/153，Rust 搜索相关测试 24/24。新旧独立网关在隔离数据目录上的 8 组搜索 HTTP 响应一致。本机交替采样的查询解析耗时中位数（微秒，旧／新）为短查询 5.18／4.52，长查询 111.58／39.26。较前六批候选减少 12 行 Node，候选仍有 498 个 src 脚本，其中 309 个为业务或宿主编排文件。

## OpenCode 自定义供应商的模型上限（2026-11-25）

旧模块 Git blob `cd7c16de1a86800b89691aede9b6189a6d391d4a`。生成 `OPENCODE_CONFIG_CONTENT` 时，Rust 按完整模型 ID 查询各供应商，分别取正整数 context、output 的最小值，并返回匹配数。只声明其中一项也有效；未知值沿用 128000/8192。上下文轮换读取器仍按自己的策略尝试去掉供应商前缀且要求 context。兼容宿主保留同步配置生成入口、可注入的文件端口和 V8 JSON 解析。私有文件快照最多保留 256 个查询答案，调用方每次获取独立对象。活动继承字段与自定义解析器绕过答案缓存。Rust 维护修改时间与上次有效目录的关联，stat 失败时仅本次使用缺省值；待同步 spawn 接口迁出后可移除这些宿主端口。[原生解析](../../native/addon/src/provider_registry/opencode_limits.rs) · [配置调用方](../../src/providers/core.js)

同一组迁前、迁后用例均为 78/78，含实际生成的配置、245 组目录与模型 ID 组合、活动 getter、字段身份、重入重置以及同一修改时间的读取轨迹。集成首次为 106/107，Monitor 用例在 100 毫秒时尚未观察到释放回调。同一 release、同参数整组复跑 107/107，该断言在前五批和本批 addon 上单跑各 3/3。Rust 定向测试 2/2。本机使用 120 个供应商、19,200 条模型记录轮换采样。P50 按冻结 Node、相同缓存策略 Node、Rust 排列，重置后首次查询为 43.58 / 43.40 / 39.43 毫秒，重复模型 ID 为 14.76 / 5.47 / 10.31 微秒，文件已加载时首次查询新的模型 ID 为 31.39 / 41.64 / 169.49 微秒。相对前五批候选再退出 1 个业务文件，净减 63 行 Node；候选 src 共 498 个脚本、309 个业务或宿主编排文件。[冻结差分](../../tests/test-opencode-model-limits.js)

## 聊天投递与后台等待通知（2026-11-25）

聊天引擎通过 Rust 生成投递失败、排队等待、后台任务占用及超时提醒。投递失败先取完整的处理说明，再取消息首行，最后回退到错误码。原生接口按需读取字段，在 V8 中拼接原始文本，以保留 UTF-16 码元和异常。兼容宿主保留异步写入、广播、告警及调用方对象的字符串或数字转换，待持久化与广播端口由 Rust 直接承接后可移除该文件。[通知文案](../../native/core/src/chat_notices.rs) · [错误详情读取](../../native/addon/src/chat_notices.rs)

冻结旧模块 `33ee8ae4fd2a32dabac90f827ec5e7c160caeb62`。同一批定向用例迁前、迁后均通过 90/90，含 140 组文案与调用轨迹差分；覆盖半分钟进位、未配对码元、符号、二次转换及原始异常。另用 2,048 组固定种子文本比较两个通知入口，4,096 个输出均相同。最终 release 上，回合收尾 314/314、既有四批入口与 API/语义边界 93/93、Rust 通知单测 2/2。本机仅生成含 65,536 个字符详情的通知时，P50 旧版 0.15 微秒、候选 1.55 微秒。较前四批候选再净减 48 行 Node，宿主文件仍计入业务或宿主编排；当前候选共 499 个 src 脚本、310 个业务或宿主编排文件。[冻结差分](../../tests/test-chat-admit-error-feedback.js)

## Monitor 通知准入与批次投递（2026-11-25）

旧实现 Git blob `743d9912ea3704f4e2ce21198689d00393a1246e`。Rust 核对通知来源、UTF-16 长度和 CLI 通知块，逐批决定探测、投递和回复。只有整批任务的归属都已确认才开始投递。Node 端口等待原宿主的 Promise、调用归属回调并保留活动 getter 的 V8 异常；在 SDK 与 stream-json 的异步宿主迁出后可移除该接线。[核心规则](../../native/core/src/monitor_admission.rs) · [原生调用](../../native/addon/src/monitor_admission.rs)

迁前后各 51/51，含 156 组来源、混合批次、字段剪裁和拒绝轨迹，及 SDK/流宿主联测。另跑 API 与边界 34/34、Rust 2/2，四批入口交叉回归 58/58。最终 release 上的五套 Claude SDK 测试通过 39/39，覆盖宿主、跨进程恢复、路由、流及凭据更新。收尾信号的两次属性读取、动态 includes 调用及原异常对象另以 5 个输入对拍。普通 64 KiB 提示的本机 P50 旧/新为 0.00049 / 0.00263 ms，一条合法通知为 0.00706 / 0.01965 ms。相对 OpenCode 目录候选退出一个业务文件，净减 28 行；候选 src 共 499 个脚本，业务或宿主编排 310 个，server.js 加 src 为 127,268 行。[差分与集成测试](../../tests/test-monitor-admission.js)

## OpenCode 原生供应商目录（2026-11-25）

旧实现 Git blob `cd60a9160fcee6544911a20db766edfa0dd8d109`。Rust 复用供应商注册表的前缀并保留原始 UTF-16 后缀，生成内置和第三方供应商名称、已去重的模型清单与默认模型。宿主保留 V8 数组 `map/filter` 与元素字符串转换、迭代器展开、加号的默认强制转换提示；自定义数组、抛错对象和旧目录身份在六个调用点保持一致。原生调用按供应商批量处理模型，待这些 JavaScript 调用方迁出即可移除宿主转换。[原生实现](../../native/addon/src/provider_registry/opencode.rs)

同输入定向迁前后 164/164，包含 272 种 id、模型选项、强制转换组合和自定义集合。profile 47/47，OpenCode Go 和第三方显示名都通过真实 PATCH 入口；跨网关的会话路由 126/126，副作用一致。原差分脚本引用已退役的鉴权文件，补回原有冻结替身后完成迁前和迁后验证。Rust 注册表 33/33，API、JS 边界及外部冻结语料 34/34。本机配对 P50，6 个模型旧/新为 0.00062/0.00314 ms，1,200 个为 0.12233/0.12660 ms。与语音候选相比，退出一个业务文件并净减 32 行 Node，候选共 500 个 src 脚本、311 个业务或宿主编排文件。[冻结对拍](../../tests/test-provider-id-validation-differential.js) · [依赖清单](node-module-dependencies.md)

## 语音播报文本清理（2026-11-25）

冻结 Git blob `f630eb5ce118b8a379d3e907b2fc96b123e05536`。派发网关与语音 ACP 使用同一 Rust 规则清理控制标记、私有值和路径，保留 UTF-16 码元。V8 端口保留字符串转换和调用方迭代器。Qwen 主管进程向 ACP 传递宿主的原生模块位置；待语音出口改由 Rust 进程直接承接，这些 Node 接线即可退出。[文本规则](../../native/core/src/voice_speech.rs)

迁前后同组 67/67，含 315 组固定输入。额外 3,000 组固定种子输入在两个公开方法上均与旧实现一致。真实子进程环境的回归先复现了原生模块路径丢失，修正后含主管进程的四个套件通过 77/77。Qwen 自带 Node v24.15.0 通过两种自定义路径加载了同一个 release addon 并从 ACP 输出“你好”。升级进度、仓储、API 和 JS 边界联测 44/44，Rust 播报单测 2/2。[网关与文本差分](../../tests/test-voice-gateway.js) · [主管进程环境](../../tests/test-qwen-audio-runtime.js)

本机配对采样各 200 次，39 字节短句 P50 旧/新为 0.00075/0.00146 ms，5,025 字节混合文本为 0.06575/0.06383 ms。相对前一升级进度候选再减 1 个业务文件、44 行 Node；两批累计较主线 `11074dcd` 减 2 个文件、89 行，候选共 501 个 src 脚本，业务或宿主编排 312 个。[依赖清单](node-module-dependencies.md)

## 兼容宿主的任务仓储升级进度（2026-11-25）

旧模块 Git blob `2135ed0db8b4c6544ee7c734cd0e5187cb0bd87b`。Rust 读取各阶段权重、计数、备份半成品大小和整理耗时，生成升级进度与磁盘错误详情。兼容 worker 仍负责 HTTP、读进度文件、文件大小和时钟；纯 Rust 安装包不走这条启动路径。[实现](../../native/addon/src/task_store/progress.rs)

迁前和迁后各通过 11/11，包含 380 组冻结输入和真实 worker 的 503 JSON、HTML、失败处理、端口交还。相对 `11074dcd`，此候选退出一个宿主脚本依赖，业务或宿主编排仍为 313 个，server.js 加 src 净减 45 行。[差分与端口测试](../../tests/test-task-store-migration-gate.js)

## 会话任务归属设置的运行时状态（2026-11-25）

旧模块 Git blob `ebbf73b31408052f35d644e59f8db80406e50184`。每个任务宿主在 Rust 中独立保存归属模式，并复用已有模式表与规范化规则。无效写入抛出原有 400 错误；发生变更时返回此前的模式供持久化失败时回滚。V8 提供环境变量和可解构调用的兼容方法；环境文件写入仍经写路由。[Rust 接口](../../native/addon/src/task_routing.rs)

迁前后定向测试均为 65/65，包含 882 组初始化和连续更新对拍，检查相同模式、无效输入、错误字段以及结果键序；另跑 API 与 JS 边界 33/33、Rust 归属路由 6/6。相对 `90fc5d63`，退出一个生产文件，src 共 503 个脚本，业务或宿主编排 313 个。server.js 加 src 净减 34 行，余 127,417 行。[差分测试](../../tests/test-attribution-mode.js) · [依赖清单](node-module-dependencies.md)

## 当前模型尝试的超时恢复（2026-11-25）

冻结旧模块 Git blob `00e0e2184ba600805028cc1a5f617eace55940af`。Rust 根据已接收的失败、运行中的会话及尝试的七个身份字段判定是否中止，区分流取消和子进程停止，保留先记录原失败后检查子进程的次序。Node 端口保留现有停滞码识别、V8 严格赋值、子进程信号与计时器，随进程和流宿主迁出后可删除。[Rust 实现](../../native/addon/src/model_timeout_recovery.rs)

原实现首次迁前 50/51，其中连接定时器用例记录到零次回调。相同输入迁前整套复跑与迁后各 51/51，包含 128 组尝试身份、拒绝、超时、进程与流错误的冻结差分。API 与 JS 边界 33/33，Rust 请求测试 10/10。相对 `4ace0f42`，退出一个生产文件；src 共 504 个脚本，业务或宿主编排 314 个，server.js 加 src 净减 14 行，余 127,451 行。[差分测试](../../tests/test-proxy-stall-watch.js) · [依赖清单](node-module-dependencies.md)

## 语音热词清单及别名否决（2026-11-25）

冻结旧模块 Git blob `9af5875d169cb5cd8f45afdf2ad0ce3b673858a4`。语音学习器通过 Rust 按出现顺序筛选拒绝、待确认、否决与激活条目，首次激活的拼写和原始条目身份均保留。V8 承担实时属性读取、UTF-16 字符串查找、大小写转换、动态计数比较、迭代器与清单字符串格式化，后续可随 JS 学习器调用方迁出。[Rust 实现](../../native/addon/src/voice_hotword_list.rs)

同输入迁前、迁后三套定向各 42/42，含 96 组清单组合和逐项原对象断言。另核对 4 种带 getter 或迭代异常的调用轨迹与 40 组别名边界和 7 组损坏状态的精确异常。初版在空条目与不可迭代输入上改变了 V8 的错误消息，已补回属性读取和迭代端口。API 与 JS 边界 33/33、Rust 2/2。小样本旧/新 0.0052/0.0260 ms，90 个候选对 500 条正文 0.8916/1.2459 ms（交替运行七轮的每次耗时中位数）。相对 `5d53a61e`，src 共 505 个脚本，业务或宿主编排 315 个，server.js 加 src 净减 8 行，余 127,465 行。[差分测试](../../tests/test-hotword-learner.js) · [依赖清单](node-module-dependencies.md)

## 语音输入词汇的出现次数与拼写选择（2026-11-25）

旧模块 Git blob 为 `b7e9a263ea334c3426e29b773262f9f308099d5b`。语音学习器扫描用户和模型消息时，Rust 逐条统计候选词的拼写频次、消息数和去重会话，按首次出现顺序处理平票。V8 保留消息迭代、正文抽取、词形判断以及公开 Map 和 Set 中的会话引用；这些端口随兼容调用方迁出后可移除。[Rust 实现](../../native/core/src/voice_typed_terms.rs)

迁前与迁后三套定向测试各 41/41，另有 100 组固定语料逐项核对拼写、计数、键序及集合成员身份。API 与 JS 边界 33/33，Rust 2/2。小语料的旧版/候选耗时为 0.0696/0.1030 ms，合成消息扫描为 14.1265/13.3164 ms（交替运行后七轮平均单次耗时中位数）。相对 `bfc85a2d`，本批保留原模块，src 共 505 个文件，业务或宿主编排 315 个，server.js 加 src 净减 14 行，余 127,473 行。[差分测试](../../tests/test-hotword-learner.js) · [依赖清单](node-module-dependencies.md)

## 语音纠错片段的对齐与筛选（2026-11-25）

语音学习器在保存纠错样本时调用 `minePairs`。旧 Git blob 为 `27b3aba981a091dd88fc4a91c499878ef1a2f78e`。Rust 按最多 600 个 UTF-16 码元划分词元，通过最长公共子序列定位替换片段，处理平局、中文相邻字扩展、大小写修正和重写幅度。V8 提供当前宿主的大小写转换与可选拼音字典回调；用户用词统计、候选持久化和现有分词导出仍由兼容宿主提供。[Rust 算法](../../native/core/src/voice_hotword_pairs.rs)

三套定向测试使用同一语料，迁前后各 40/40，另有 900 组长度和 Unicode 边界输入逐项相等；API 和 JS 边界 33/33，Rust 2/2。合成短句的旧版/候选耗时分别为 0.0030/0.0018 ms，接近上限的重复字样本为 2.2157/1.5185 ms，均为交替运行后七轮平均单次耗时的中位数。相对 `6a1519a9`，src 共 505 个 JS/CJS/MJS 文件，业务或宿主编排 315 个。该批保留语音学习模块，server.js 加 src 净减 86 行，余 127,487 行。[冻结差分](../../tests/test-hotword-learner.js) · [依赖清单](node-module-dependencies.md)

## 看板计划变更的回写（2026-11-25）

冻结的计划模块 Git blob 为 `5d2e1b24ae127b25f1b28d386931396d041b88a1`。Rust 按顺序把计划结果写回看板，并把返回的任务重新关联到调用方持有的对象。更新已有任务时保留其引用，创建任务时保存新对象。日期解析、ICU 排序、UUID 与稀疏数组映射继续使用 V8，待这些兼容调用方迁出后可移除。计划模块仍计入业务或宿主编排。[Rust 实现](../../native/addon/src/task_board_planning.rs)

同一组定向测试迁前与迁后各通过 131/131，视图集成 88/88，架构、API 与语义边界 45/45，Rust 任务域 26/26。另用常驻看板端口核对变更顺序、对象引用与迭代器异常，并固定时钟和 UUID 比较创建及移动结果。在上一批视图代码之上，src 仍有 505 个脚本文件，业务或宿主编排 315 个，server.js 加 src 从 127,576 降至 127,573 行，本批净减 3 行。[差分测试](../../tests/test-task-planning.js) · [逐文件依赖](node-module-dependencies.md)

## 看板卡片视图的会话状态采集（2026-11-25）

旧视图 Git blob 为 `002c4a04b0d1c8aad249fdb7a17aaccdbbbf1db4`。V8 遍历实时看板、去重会话 ID、读取日期并按 ICU 顺序排列组 ID。Rust 为每个待查询的会话依次采集受理与运行状态并处理端口异常，普通看板与常驻看板共用原有投影内核。宿主调用点迁出后可移除这些接线。[原生实现](../../native/addon/src/task_board_view.rs)

冻结差分及定向测试迁前与迁后各 87/87，架构、API 和语义边界 45/45，Rust 任务域 26/26。按 7 轮平均单次耗时的中位数，1 个任务的旧版/候选为 0.0331/0.0455 ms，128 个任务为 4.9364/4.7363 ms。相对 `d399c394`，本批代码使 src 从 506 降至 505 个文件（500 JS、2 CJS、3 MJS），业务或宿主编排从 316 降至 315，server.js 加 src 净减 5 行至 127,576 行。[差分测试](../../tests/test-task-board.js) · [依赖清单](node-module-dependencies.md)

## OpenCode 上下文轮换交接（2026-11-25）

读取器和准入模块的旧 Git blob 为 `b659c82bc585047fc5d32feb1362a0994b133494` 和 `91e2b4543c95c896e271399432ea0b87e7175ca0`。Rust 复用未完成的跨 CLI 交接，选择原有或新建的摘要，按需生成 ID 并构造下一份交接记录。读取器和回合引擎共用一个入口。宿主继续处理 V8 数值转换、路径、Promise、会话变更复核、保存及广播，这个入口继续计入业务或宿主编排文件，待兼容调用方迁出后移除。[轮换实现](../../native/addon/src/opencode_context.rs)

三套定向测试迁前与迁后均为 89/89。相同的 66 组轮换场景核对交接属性与嵌套引用、读取及回调顺序、各阶段抛错后的状态。另核对缺少原生模块时仍可创建读取器，首次读取返回既有失败原因。API 与 JS 边界 33/33，Rust 交接摘要 4/4。相对 `eaf9f829`，src 由 507 降至 506 个文件（501 JS、2 CJS、3 MJS），业务或宿主编排由 317 降至 316，server.js 加 src 由 127,594 降至 127,581 行，净减 13 行。[差分测试](../../tests/test-opencode-context-guard.js) · [依赖清单](node-module-dependencies.md)

## 聊天回合收尾计划与宿主端口（2026-11-25）

生产计划门面与执行宿主的旧 Git blob 分别为 `610b4936428b1b9c3ac8f354ae93bce2b85475b6` 和 `10d9a99c20dbbb2144ae1a71293a2456c121c3a4`。Rust 选择重试时钟、冻结计划及其成员，并校验 13 个执行端口的名称、类型和读取顺序。已有调用方可以继续通过聊天模块取得同一个计划函数。Node 宿主仍等待实际写入的 Promise，将写入结果和原始错误交回 Rust，并在需要时等待问题状态同步；因此 `finalize-host.js` 仍列入宿主编排，待异步持久化和问题状态所有者迁出后再移除。[计划入口](../../native/addon/src/chat_finalize.rs) · [执行端口](../../native/addon/src/chat_finalize_execution.rs)

同一组迁前与迁后十套定向测试各通过 314/314，含隔离网关测试。固定输入核对冻结计划、宿主对象身份、端口异常、时钟及副作用顺序。另验证早期交付的计划中，原始类型的 facts 和 append 字段可原样返回。以紧前的上下文选择批次为基准，src 从 508 降至 507 个文件（502 JS、2 CJS、3 MJS），业务或宿主编排从 318 降至 317。server.js 加 src 从 127,668 降至 127,594 行，本批净减 74 行。[差分回归](../../tests/test-chat-finalize-differential.js) · [逐文件清单](node-module-dependencies.md)

## 上下文候选选择（2026-11-25）

冻结的生产门面 Git blob 为 `8263ade757ddc0a01d3cc9fe75e4e92cc8496c68`。任务上下文计划、快照和关联任务复用同一 Rust 接口。Rust 处理分词、相关度阈值、裁剪、预算默认值、非有限数和未定义值，并恢复返回结果的预算上限。兼容宿主保留 V8 的可迭代对象展开、带 getter 的排序比较、ICU 的 `localeCompare` 顺序，以及 JavaScript 异常类型映射。调用方移出 V8 后可移除这段接线。[原生接口](../../native/addon/src/selection.rs)

迁前与迁后三套定向测试各通过 42/42。差分用同一组输入核对五个入口，并检查相同优先级时的排序、预算与省略字段、错误类型、原对象和迭代器抛出的异常。依聊天历史帧、上下文选择的批次顺序计，src 从 509 降至 508 个文件（503 JS、2 CJS、3 MJS），业务或宿主编排从 319 降至 318。server.js 加 src 从 127,732 降至 127,668 行，本批净减 64 行。[差分测试](../../tests/test-context-plan.js) · [实时依赖表](node-module-dependencies.md)

## 聊天重连历史帧（2026-11-25）

冻结的生产门面 Git blob 为 `abadda7b01f4834a31cfd5b6b21170f38bdcf185`。Rust 按每条消息的序列化字节数执行原有预算规则，决定是否切去页首、裁剪工具内容，以及向重连客户端返回哪个数组。V8 接线保留真实消息的 JSON 字节测量和选项访问语义，传入 Rust 的常规请求只包含数字和上限。仅在需要裁剪时才序列化保留下来的消息。重连运行时迁出后可移除这处接线。[Rust 接口](../../native/addon/src/chat_connect_frames.rs)

三套定向回归迁前与迁后均通过 23/23，包含 144 个冻结预算场景、getter 顺序、循环与稀疏输入、未裁剪页的数组和元素引用，以及大历史文件分页。相对 `1e3afa22`，src 文件由 510 降至 509（504 JS、2 CJS、3 MJS），业务或宿主编排由 320 降至 319，server.js 加 src 从 127,803 降至 127,732 行，净减 71 行。[差分用例](../../tests/test-history-frame-budget.js) · [实时依赖表](node-module-dependencies.md)

## 首页持久化告警（2026-11-25）

冻结 `air-sync-issue.js` 的 Git blob 为 `9e87bfa162e03ce54055db1c6198f7273cae92f3`，`air-storage-notice.js` 为 `8fd890d1a9232acdcdd2b97cec66920879b88105`。Rust 在最多五层错误链中选择公开诊断，识别需要发布的磁盘写满告警，生成带时间戳的告警并指定五分钟有效期。Node 保留 V8 字符串转换和截断、可变告警对象的引用、模块无法加载时的固定文案，以及 StateStore、会话写入、日志和推送回调的接线。这些回调与对象身份随宿主调用方迁出后可移除。[Rust 实现](../../native/addon/src/air_storage_notice.rs)

两个定向套件迁前与迁后均通过 52/52。另用相同输入核对 UTF-16 截断边界、getter 异常、时钟回退、告警引用修改，以及原生模块加载失败后的指标和日志。相对 `eec9c9e3`，src 从 512 个文件降至 510 个（505 JS、2 CJS、3 MJS），业务或宿主编排从 322 降至 320。server.js 加 src 从 127,822 降至 127,803 行，净减 19 行。[差分用例](../../tests/test-air-sync.js) · [实时依赖清单](node-module-dependencies.md)

## Air 待办忽略状态（2026-11-25）

旧实现的 Git blob 为 `a70c9b85bdd82b8a360f5d34fc73e9dda2b4f961`。Rust 按任务与问题发生时刻判断忽略是否有效，读取时仅在用到对应任务时查询问题状态。状态所有者暂不可用时，读取保留已有条目，写入则传播原错误。只有保存成功后才更新内存。为避免每个任务多次跨越 N-API，宿主把任务引用和时间整理为一次调用可用的 V8 Map。兼容宿主仍提供问题状态、手动待办、StateStore 与 Express 接线，宿主调用方迁出后可移除这些端口。[Rust 实现](../../native/addon/src/air_todo_ignore.rs)

迁前与迁后四个定向套件各通过 61/61。差分覆盖问题类别和时间变化、旧存档、异常与回滚、读取顺序及返回对象引用。相对 `acf8d9a5`，src 文件由 513 降至 512（507 JS、2 CJS、3 MJS），业务或宿主编排由 323 降至 322，server.js 加 src 从 128,012 降至 127,822 行，净减 190 行。[冻结差分](../../tests/test-air-todo-ignores.js) · [实时清单](node-module-dependencies.md)

本机隔离读操作量测（1,500 个内存任务、3 条忽略记录，新旧各 800 次，交替采样）中，旧实现 P50/P95 为 0.0232/0.0707 毫秒，候选实现为 0.0290/0.0667 毫秒。

## Air 置顶与手动待办（2026-11-25）

冻结的 Git blob 分别为 `4967f6324d789b66525afcd200f8f01abb7243f0`（置顶）和 `ab6b09c8ebe495aeef8157adb542a042c218dd6c`（待办）。两类清单的规范化、100/500 项上限、按任务表剪枝、替换、切换、缓存和失败回滚已迁入 Rust。宿主保留 StateStore 的文件及备份接口、动态任务表和旧 Express 挂载接线。兼容调用方迁出后可移除这些端口。[Rust 清单状态机](../../native/addon/src/air_task_list.rs)

迁前和迁后三套定向回归均通过 48/48。差分核对动作序列、每次任务表读取、错误状态和消息、磁盘状态、损坏恢复、失败回滚与回调重入，另覆盖 UTF-16、动态上限和迭代器关闭。搜索排序合入 `6d0e2d79` 时 src 有 515 个 JS/CJS/MJS 文件，本批降至 513（508 JS、2 CJS、3 MJS），业务或宿主编排由 325 降至 323，server.js 加 src 的物理行由 128,133 降至 128,012，净减 121 行。[差分用例](../../tests/test-air-pins.js) · [实时清单](node-module-dependencies.md)

## 消息搜索结果排序（2026-11-25）

搜索运行时仍从同一索引读取命中。候选字段投影和原始对象选择现经原生接口，排序复用原有 Rust 内核。宿主保留空输入与零额度的提前返回、V8 数组 map 和加载原生模块的时点。兼容宿主的搜索调用方退役后可移除这段接线。旧实现的 Git blob 为 `37f8e334c937c92cc0227a0bb8ea588be6d1f74e`。迁前与迁后四个定向套件均通过 71/71，涵盖 126 组额度、配额和去重组合，另核对 21 个异常与读取顺序场景，以及运行时出错后返回原始相关性顺序、递增失败计数的行为。[冻结差分](../../tests/test-search-runtime.js) · [Rust 接口](../../native/addon/src/search_diversity.rs)

相对归属模式合并提交 `c74e8601`，src 的 JS/CJS/MJS 由 516 降至 515（510 JS、2 CJS、3 MJS），业务或宿主编排文件由 326 降至 325。server.js 加 src 的物理行数由 128,186 降至 128,133，净减 53 行。[实时盘点](node-module-dependencies.md)

## 任务归属模式（2026-11-25）

任务设置与归属决策现在直接调用原生输入适配层，复用 Rust 的模式校验和动作规划。Node 保留参数解构、共享冻结目录和宿主接线，设置及决策调用方迁出时可一并移除。旧实现的 Git blob 为 `26bb5c1eeb3ef4306935010f6f63d36bc4cf7746`。迁前与迁后五个定向套件均为 97/97。差分含 1260 组规划输入，并比对无效模式的回退对象引用、字段读取顺序、键顺序和异常。[原生接口](../../native/addon/src/task_routing.rs) · [冻结实现与差分](../../tests/test-attribution-mode.js)

相对短码合并提交 `3c234a5d`，src 中的 JS/CJS/MJS 文件由 517 降至 516（511 JS、2 CJS、3 MJS），业务或宿主编排文件由 327 降至 326。server.js 加 src 由 128,219 行降至 128,186 行，净减 33 行。[实时盘点](node-module-dependencies.md)

## 任务短码注册表（2026-11-25）

旧实现的 Git blob 为 `45827ebc511cbdc40ac8fa5505a3d7bc3369ac2c`。迁前与迁后使用同一组输入和断言，六个定向套件各通过 116/116。对象候选的首次返回、再次读取、按原对象和按字符串反查，都在每次运行内核验。覆盖 4096 次碰撞上限、状态恢复和保存失败后的可见性。另有 24 个异常和重入场景与冻结实现一致，Rust 短码单测 1/1 通过。[冻结实现](../../tests/helpers/legacy-task-short-code.js) · [差分用例](../../tests/test-task-short-code.js)

默认短码的 SHA-256、四位编码、有效性检查在 Rust 核心中。兼容宿主通过原生模块执行注册、反查和标签格式化。宿主保留原有 StateStore 的备份与恢复接口、进程内注册表引用和 V8 Map，以维持注入对象作为键的语义。StateStore 迁移后可替换文件读写端口。[短码核心](../../native/core/src/task_short_code.rs) · [原生模块](../../native/addon/src/task_short_code.rs)

相对 `0e710ba0`，src 的 JS/CJS/MJS 文件由 518 降至 517（512 JS、2 CJS、3 MJS），业务或宿主编排文件由 328 降至 327。server.js 加 src 的物理行数由 128,353 降至 128,219，净减 134 行。[实时盘点](node-module-dependencies.md)

## 事件引擎的目录、规则、通知与状态转换（2026-11-25）

额度批次 `21105b9b` 经 MultiCC 合入 `e4ebc062`，任务分支同步后工作区干净、差距 0/0。事件引擎、触发器和通知接线现在共用 Rust 对事件输入的处理，包括惰性读取任务状态、限制对外字段、规则校验后才分配 ID 和时间、按顺序检查渠道并返回第一个问题。宿主提供时钟和 ID 工厂、渠道验证回调及系统家目录。四个旧业务文件已从 src 删除。[Rust 实现](../../native/addon/src/event_host.rs) · [冻结实现同输入差分](../../tests/test-event-system.js)

| 旧文件（src/events 下） | 迁前 Git blob |
|---|---|
| catalog | `deceb5ecf2ee39b8bcaa20ab5fb53de4a47d505e` |
| rules | `2902477343f97c51a90c196399a1b097fb7a463c` |
| task-transitions | `4e10d745b7bbbc4f5776417a8a78df8dad75f084` |
| envelope | `adbb4eac0fc00c8fb19264296a8f2ab7d83344a4` |

迁前两个定向套件 65/65。release 原生模块预检通过，迁后连同宿主端口和会话触发器共 80/80。Rust 事件相关测试 19/19。历史结论差分 35/35、语义断言 20/20、分支见证 24/24，格式与源码行数检查通过。

src 内的 JS/CJS/MJS 文件 522 → 518（513 JS、2 CJS、3 MJS），业务或宿主编排文件 332 → 328。server.js 加 src 的物理行数 128,533 → 128,353，净减 180 行。[实时盘点](node-module-dependencies.md)

## 额度展示与会话广播（2026-11-25）

以推送文案合并提交 `80bed22d` 为基线，两个旧入口已从生产目录删除。展示入口的 Git blob 为 `46298904b4987a6e0a050764ec27206031cbf8ad`，广播入口为 `e97dd0b1d8ed136a343d1be2de1cc7e136f63740`。Rust 负责展示对象的冻结、过期判定、对外字段选择以及按供应商和 CLI 筛选订阅会话。兼容宿主传入缓存订阅、时钟和广播回调。[展示实现](../../native/addon/src/quota_bar_view.rs) · [广播实现](../../native/addon/src/provider_limit_sync.rs)

第一次 release 构建因回调移动 `ctx.env` 报 E0382。改为共享再借用后，release 构建退出码 0，指纹 `4652eb1eee4766694a86042b` 的原生模块预检通过。独立基线检出使用上一批已验收的插件重跑 105/105，通过哈希核对两份冻结源码。新插件在同样的 7 份套件通过 105/105，另 8 份调用方套件通过 163/163，Rust 展示测试 4/4。差分在相同时间和缓存行下核对 38 次快照和 70 种广播情形，覆盖阈值边界、旧窗口、多个接收方、广播失败与隐私字段。格式与行数检查通过。[差分与回归](../../tests/test-quota-bar-parity.js)

src 的 JS/CJS/MJS 文件 524 → 522（517 JS、2 CJS、3 MJS），分类清单中的后端业务或宿主编排 334 → 332。server.js 加 src 的物理行数 128,600 → 128,533，本批净减 67 行。[实时盘点](node-module-dependencies.md)

## 推送通知文案（2026-11-25）

上一批状态帧提交 `a17d2b67` 通过 MultiCC 合入 `16ba5fb7`，任务分支同步后干净、差距 0/0。本批沿兼容宿主的 `notify()` 入口迁移通知类型归一化、语言选择和目标子状态标题。Rust 从既有分类词表读取中文，区分等待用户和后台等待，并兼容存量 C 状态。Node 仅缓存每个进程内使用的原生词表并传入调用参数。浏览器和 App 继续沿用各自的渲染入口。[Rust 实现](../../native/addon/src/push_notification_copy.rs)

旧实现 Git blob 为 `17f994ffc4c1fd9b12ca9367ecf3bf5eb66b9eec`，SHA-256 为 `e3540df5b2aa7520c2ec6a8663bfe064be16f501f943aac50cf678787d3469cd`。在迁移前固定同一组输入，分别比较 30 个键和值、4 种语言输入、8 种目标子状态，共 30 次取键和 960 次通知结果或异常比较。测试覆盖旧状态、UTF-16 长度、继承属性名和转换异常。生产文件已经删除。[冻结源码](../../tests/helpers/legacy-push-notification-copy.js) · [差分与多端词表测试](../../tests/test-notification-copy.js)

release 原生模块指纹 `432efdfb7e34ca5e6ae2f94b` 通过接口预检。五份 JS 定向套件 65/65，Rust 分类词表测试 13/13，格式、源码行数及差异检查通过。src 的 JS/CJS/MJS 文件 525 → 524（519 JS、2 CJS、3 MJS），其中后端业务或其宿主编排 335 → 334。server.js 加 src 的物理行数 128,677 → 128,600，净减 77 行。[逐文件清单](node-module-dependencies.md)

## 聊天连接与实时广播的任务状态帧（2026-11-25）

上一批 Aux 提交 `559fdc9a` 经 MultiCC 合入 `2274441e`，第二父提交、工作区干净和任务分支与 main 差距 0/0 均已核验。本批以该合并提交为基线。

连接时的任务状态首帧和运行时的状态广播共同使用 Rust 原生入口。Rust 在需要首帧时先判断有无可展示的任务，随后才读取可能写入注册表的任务短码和当时的 Aux 健康状态。两类帧使用同一个核心生成字段；JSON 序列化钩子、错误信封的原始引用和注册表的可见副作用均保留。兼容宿主提供短码与 Aux 的进程内回调。两个原 Node 文件已删除。[原生入口](../../native/addon/src/chat_connect_frames.rs) · [生产入口差分](../../tests/test-chat-connect-frames-wiring.js)

两份旧实现已固定在基线 Git 树中。payload 的 blob 为 `85be3adead1f5ec6b3e4652b1cff74478a8ce39e`，seed 为 `7b2ee5802e6abf318db869a8464b21edf3bca128`。迁移前后分别运行同一语料中的 678 例，每例均比较 seed 和 payload 两个入口。另覆盖 getter 与 toJSON 调用顺序、对象引用和循环输入。语料 SHA-256 为 `a16b2b170ebcd3b010527a9a9a7e6a3ac36ec8e12ccc93ac14451e03a6e0d0a6`。

release 原生模块指纹 `fe9850b141f37967757a3914` 通过预检。Rust 核心测试 6/6。定向回归首次 66/85，取消流程 19 项均在建库时因测试目录缺少配套网关退出。补齐同一工作树构建的网关后，原六个测试文件 85/85 通过。两次日志分别留存。

从基线到本批，src 的 JS/CJS/MJS 文件 527 → 525（520 JS、2 CJS、3 MJS），其中按 530 项分类清单标为后端业务或其宿主编排的文件 337 → 335。server.js 加 src 内上述扩展名的物理行数 128,743 → 128,677，净减 66 行。HTTP、CLI 等混合职责项仍需逐件审查。[逐文件清单](node-module-dependencies.md)

## Aux 判定时效与会话广播（2026-11-25）

语音就绪提交 `fcd74d42` 经 MultiCC 操作 `merge-back_mwv252x5_e648c3a739c1` 合入本地 main。合并提交 `23d90b47` 的第二父提交为该批次，合入后任务工作区干净，分支差距为 0/0。以下统计以此提交为基线。

服务在 Aux 队列健康状态变化时广播判定是否过期，聊天连接帧、会话档案和管理接口也读取这两个字段。宿主保存进程内队列回调，Rust 从回调取数、投影 `auxUnhealthy` 和 `auxUnhealthySince`，并为已有判定的会话选择聊天与工作区接收方。队列的诊断详情留在宿主。迁移前冻结了 81 行旧实现，Git blob 为 `2d74d48d827acd14a302338f8cb596b2b7cdb92c`，SHA-256 为 `df7ff6861160f62d513dd3d7a3aa34704af53c1b909d0987a66a7cab341b353e`。[Rust 实现](../../native/addon/src/aux_verdict_health.rs) · [冻结的旧实现](../../tests/helpers/legacy-aux-verdict-health.js) · [同输入差分](../../tests/test-aux-verdict-health.js)

迁移前用旧生产入口运行固定用例；迁移后使用新编译并通过预检的 release 原生模块（源码指纹 `d9101d314ff19631ee462fea`）。56 组状态和时间值、6 组缺失或异常来源、8 组广播和读取故障，共 70 组输入与旧实现结果一致。对照包括字段与读取顺序、消息对象共享与复制、广播计数和迭代器关闭。Aux、聊天连接帧、会话管理、API 契约和工作区定向测试 82/82 通过，Rust 聊天状态帧测试 6/6 通过。

src 的 JS/CJS/MJS 文件从 528 降至 527，现有 522 JS、2 CJS、3 MJS。515 个可从 server.js 的模块依赖到达，9 个经宿主脚本路径到达，2 个用于离线工具，1 个仅发现测试调用。按 server.js 加 src 下 JS/CJS/MJS 的物理行（含注释和空行），128,818 降至 128,743，净减 75 行。[工作树逐文件清单](node-module-dependencies.md)

## 语音输入就绪判断（2026-11-25）

本地 main 的 `eeff0a8c` 已包含 Codex 终端查找器提交 `2a5f837c`。MultiCC 合并回执为 `merge-back_mwv1p0fs_f27d81feb034`，任务工作区在合并完成时干净，与主线差距为 0/0。

兼容宿主的 `POST /api/voice/stt` 在语音不可用时返回 503、`voice_not_ready` 和就绪详情。原先此处使用 `src/voice/readiness.js`，而 `GET /api/voice/readiness` 在 Rust 网关里另外计算。两个入口现共用 Rust 的引擎选择、流式提供方判定和安装状态映射。Node 仍负责调用进程内 ASR、安装器与流式服务，读取云端凭据是否存在并保留原始下载进度对象。旧文件已移出生产目录。[Rust 规则](../../native/core/src/voice_routes.rs) · [STT 接线](../../src/routes/voice.js)

相对 `eeff0a8c` 重新扫描，src 从 529 个文件降至 528 个（523 JS、2 CJS、3 MJS）。其中 516 个沿 server.js 模块导入可达、9 个经宿主脚本路径可达、2 个供离线工具使用、1 个仅见测试引用。按 server.js 加 src 下 JS/CJS/MJS 的物理行（含注释和空行），128,854 降至 128,818，净减 36 行。旧文件删除 45 行，现有路由净增 9 行。测试副本单独存放。[实时依赖清单](node-module-dependencies.md) · [差分测试](../../tests/test-voice-readiness.js)

原生模块源码指纹为 `81a1c763f12774edb1bf5699`，release 构建通过接口预检。旧实现的 Git blob 为 `586ddd3484b4139e3186d13156af1940a58f4cfe`。180 组固定输入的返回值、字段顺序、下载对象引用和探针调用顺序均与旧实现一致，另有按需读取和异常传递检查。语音宿主与 STT 路由测试 31/31 通过，Rust 语音内核 19/19 通过，真实 Rust 网关的就绪路由集成测试 1/1 通过。

## Codex 终端会话 ID 查找（2026-11-25）

在合入版本 `a94bf826`，src 内 530 个 JS/CJS/MJS 文件中有 527 个可从兼容宿主到达，2 个供离线工具使用，1 个仅见测试引用。逐文件职责和直接调用方已固定在[530 项基线清单](src-classification-2026-11-25.md)。本批删除 Codex rollout 查找器后，工作树 src 内为 529 个文件（524 JS、2 CJS、3 MJS），其中 517 个沿模块导入可达，9 个沿宿主脚本路径可达。终端创建和保存仍经兼容宿主，rollout 读取、筛选和 ID 匹配已交给 Rust 工作线程。[工作树实时依赖](node-module-dependencies.md)

旧查找器逐字节冻结在 tests/helpers/legacy-codex-session-file.js。tests/test-codex-session-file.js 的 12 组差分场景把相同目录、cwd、时间阈值同时交给旧实现和生产入口，32 次比较均一致，另有 2 项轮询生命周期测试通过。与会话策略和生命周期路由一起执行共 59/59 通过。Rust 共享 JSON 读取回归 2/2 通过，release 原生模块通过接口预检，指纹为 `c1b062cf6e2211e63188c36c`。本批验证范围为定向回归。[差分测试](../../tests/test-codex-session-file.js) · [Rust 实现](../../native/core/src/codex_session_file.rs)

## 默认构建与部署路径（2026-11-24）

| 默认生产服务中逐项计数 | 数量 |
|---|---:|
| 后端 `.js` / `.cjs` / `.mjs` 文件 | 0 |
| Node、npm 可执行文件及 N-API 扩展 | 0 |
| 随服务安装的 npm 包、Node 运行依赖 | 0 |
| 程序目录中的 npm 依赖清单 | 0 |
| Rust 程序 | 5 |

清点范围为 `make stage` 的目录、由它生成的服务归档和根 Dockerfile 最终层。`public/` 及插件的 `ui/`、`public/` 供浏览器执行。根源码分发包的 npm 清单仅用于开发及打包，生产依赖图为零。默认 Cargo 成员的普通依赖图中没有 Node 绑定。[实测结果](production-entry-2026-11-24.md)

| 入口或功能 | 当前所有者与验证 |
|---|---|
| 构建与启动 | `make production` 使用 Cargo；`make start`、源码管理器、launchd 和根镜像直接运行网关。服务归档的入口为 `bin/multicc-gateway`。 |
| cron | 网关解析五字段规则，持久化触发分钟、在途记录和运行历史。脚本与固定任务投递均有手动及恢复覆盖。 |
| Aux | Rust 消费 SQLite 队列，管理并发与取消，发送 Messages、Chat Completions 或 Responses 请求，保留终态、健康信息和历史。服务原生接入手动入队、Goal 预检及语音进度摘要。 |
| 兼容发行物 | 带 Electron 的客户端和由安装器下载的 `multicc-standalone-*` 仍包含 Node 管理程序与兼容宿主文件，在目录/会话写操作迁完前默认挂载随包兼容宿主（支持 `MULTICC_NO_NODE=1` 显式切纯 Rust）。要部署零 Node 的服务，使用 `multicc-service-*`、根镜像或 `make stage`。 |
| 其他产品功能 | 渠道消息投递、部分会话及仓库写操作仍依赖兼容宿主。旧宿主的记忆复盘、终端意图分类和任务板分类仍由各自的宿主模块发起。 |

[源码兼容宿主清单](node-module-dependencies.md) · [旧式安装包盘点](packaged-backend-darwin-arm64.md)

## 2026-11-24 独立生产网关（上一批基线）

- 根源码包和根镜像只启动 Rust。源码管理器、launchd、desktop 和 standalone 仍加载兼容宿主。
- 23 个读请求中状态码一致 20 个，状态码和正文一致 12 个；两端各通过 19/19 项带数据检查，旧会话首次启动的搜索结果也一致。网关可读任务搜索和文档登记，提供四个运行指标及目录探针操作历史。旧会话首次领养复用 SQLite 身份事务，电源读接口直接查询平台状态。目前仍需迁移会话及 Aux、cron、渠道插件和后台消费者，并验证写入及重启。
- 静态盘点共 530 个 `src/` JS/CJS/MJS 文件，518 个可经根宿主导入，9 个经脚本路径引用，另计根宿主。根包生产 Node 依赖为 0。动态加载点及每个文件的归类见[逐文件清单](node-module-dependencies.md)。带数据验收和未迁功能见[生产入口报告](production-entry-2026-11-24.md)。


## 推送订阅、目录和分享入口（2026-11-24）

纯 Rust 入口已接管订阅存储、VAPID 公钥、推送健康、目录列表和分享入口及口令校验。隔离双实例的 23 条读请求中，状态码一致 15 条，仍有 8 条有差异；两端各通过 15 项预置数据检查。本批沿用已有 JS/CJS/MJS 文件清单，`src/` 为 525 + 2 + 3 个，另有根宿主。源码包生产 Node 依赖为 0。部署范围与逐域缺口见[入口验收记录](production-entry-2026-11-24.md)。

## 2026-11-24 根包生产启动入口

`npm start`、`npm run start:gateway` 和 PM2 改为直接执行 Rust release 网关；根包运行依赖从 18 项降为 0 项。旧宿主依赖仍用于开发、对照测试和原安装包。当前 `src/` 留有 525 个 JS、2 个 CJS 和 3 个 MJS；另有 `server.js`。逐文件依赖、未迁路由以及入口差分分别见[依赖盘点](node-module-dependencies.md)和[本批验收](production-entry-2026-11-24.md)。

## 2026-11-24 通知地址的读取与保存

删除 `src/notify-settings.js` 后，`GET /api/settings/notify` 与 `POST /api/settings/notify` 在 Rust 共用地址掩码规则。写入仍通过宿主的同步配置事务比较当前值、持久化并更新推送服务。当前 `src/` 有 525 个 JS、2 个 CJS、3 个 MJS，根包有 18 项直接运行依赖。静态扫描含入口在内共 531 个文件、223 处注册候选。本批原生构建隔离启动后捕获了 128 个 Node 路由和 25 层中间件。 [批次记录](node-retirement-batches.md) · [部署说明](../gateway.md)

## 2026-11-24 人机协助截图清理

截图的启动扫描与周期扫描已迁至 Rust，删除生产文件 `src/assist-snapshots.js`。纯 Rust 网关和带 Node 子进程的网关均在自身进程内执行扫描；单独运行 `server.js` 使用同一 Rust 内核。当前 `src/` 为 526 个 JS、2 个 CJS、3 个 MJS，根包有 18 个直接运行依赖。静态注册扫描覆盖含 `server.js` 的 532 个文件，找到 223 个候选。默认启动和安装包仍需要 Node。 [批次记录](node-retirement-batches.md) · [逐文件清单](node-module-dependencies.md)

## 2026-11-24 会话与环境诊断

`src/routes/doctor.js` 和 `src/routes/env-doctor.js` 已从生产目录移除。七条公开路由在 Rust 网关里选择服务参数，生成状态码与 JSON。Node 仍持有诊断任务、取消句柄、会话历史与 Aux 执行器。端到端迁移需接管这些服务。新旧路由的对照程序为 `docs/rust-migration/differential/host-ops-routes.js`。

当前 `src/` 有 527 个 JS、2 个 CJS 和 3 个 MJS。根包有 18 个直接运行依赖。静态扫描含 `server.js` 共 533 个文件和 223 处 HTTP 注册候选。隔离启动捕获了 128 个 Node 路由注册和 25 层中间件。源码默认入口由 Rust 网关拉起 Node，npm 包清单仍含 `server.js` 和 532 个 `src/` JS/CJS/MJS 文件。 [逐文件运行依赖](node-module-dependencies.md)

## 2026-11-24 分享页、请求计时器与 Grok 配置

`src/` 剩 531 个 JS/CJS（529 + 2），另有 3 个 MJS 入口。根包 `dependencies` 有 18 项。静态 HTTP 盘点覆盖含 `server.js` 的 535 个文件，列出 230 处注册候选。默认启动仍使用 `scripts/start-gateway.js` 的 `--node … server.js`。分享页模板已由 Rust 提供，分享数据接口仍需要宿主。

隔离启动 `--no-node`、配置本地认证后，分享页 GET / HEAD 返回 200，带 ETag 的条件请求返回 304；同一网关的 `GET /api/share/example/entry` 返回 503（`rust_backend_unavailable`）。含 Node 宿主的隔离运行捕获到 128 个 Express 路由注册和 25 层中间件。`npm pack --dry-run --ignore-scripts` 列出全部 534 个 `src/` JS/CJS/MJS 文件以及 `server.js`。 [运行时捕获](../backend-runtime-inventory.md)

从 `server.js` 沿字面量模块依赖可达 522 个文件，加上脚本路径可再达 9 个。两个独立运维和回测模块分别由 `scripts/task-workspace-inventory.js` 和 `scripts/backtest-task-attribution.js` 使用。`src/http/error-presenter.js` 目前只查到两个测试调用，仍单列在文件清单里。后续仍依赖任务壳和会话状态所有者、后台投递和恢复、Provider 执行及插件 SDK。切换默认入口需验证其 HTTP、WS、进程生命周期与安装包启动。 [逐文件依赖](node-module-dependencies.md) · [迁移顺序和批次记录](node-retirement-batches.md)

## 2026-11-24 任务板与任务壳更新

任务板依赖校验和分组已移出 `src/task-board/runtime-helpers.js`，任务板与任务壳三处短码展示已移出 `src/task-display-attribution.js`。这两个生产文件均已删除，旧实现保留在测试目录。此时 `src/` 剩 531 个 JS、2 个 CJS 文件，根包有 19 个直接 Node 运行依赖。默认 `npm start` 启动 Rust 网关，再由网关运行 Node 子进程。 [批次与剩余宿主端口](node-retirement-batches.md#任务板分组与任务短码展示2026-11-24)

## 2026-11-17 调度读模型基础（当时的工作区快照）

本阶段新增 Rust 版本绑定元数据缓存和后台快照构建基础。独立所有者的
现有写入口已接入共享缓存失效；后台构建和提交复核尚未接入生产调度，
也没有移除 Node 模块。该阶段统计为 607 个 `src/` JS/CJS/MJS 文件、
132,456 行；调度 `scheduler.js` / `host.js` 以及准入、完成、重排、恢复
的事务所有权仍未迁移。限制和后续前置条件详见
[`scheduler-read-model-next.md`](scheduler-read-model-next.md)。

最近按 Git 跟踪且磁盘存在的文件重新核对：`src/` 为 607 文件、
132,481 行（含新增状态传输桥），另有 `server.js` 3,099 行。已冻结恢复宿主并增加值投影对照；
问题、活动轮次和分类尚未接入独立 Rust 数据所有者。当前源码构建的隔离
模块下，准入和完成所有权门禁各失败一项；调度、投递和聊天定向回归
274 项通过，重排和恢复的两项原有所有权门禁失败。这些数字不代表迁移完成。
全工作区 Rust 测试第三次串行运行通过，严格 Clippy 和格式检查通过；前两次
全量分别因网关代理测试超时及临时端口占用失败，两项均单独重跑通过。

## 用户输入判定批次

删除 `src/session-work/user-input.js`（28 行）：直接输入和带任务壳回执的
输入判定迁到 `native/addon/src/session_work_selection.rs`，调度器与编排
运行时仅保留对原生函数的调用。因为调度器和编排宿主仍在 Node，N-API 桥
暂时必要；待两个调用方迁至 Rust 后才能移除。调用时按原顺序读取 live
对象，包括任务壳分支对 `source` 的第二次读取，并传播 getter 异常。

迁前原件备份在工作树外；冻结对照
`tests/helpers/legacy-session-work-user-input.js` 的 SHA-256 为
`55b2e49a792f2fa1439eb92ee485e0e100614126d6910ea43bb0571cd7155626`。
调度器冻结快照通过测试加载器接入该旧实现，不从当前 Rust 路径取值。
调度、投递和无人值守 FIFO 三套定向测试共 137 项通过，其中包含 SQLite
独立所有者对照。测试中的网关和 addon 使用同一工作树源码编译。
全工作区串行 Rust 测试重跑通过 75 个目标、2,405 项，严格 Clippy 和
`cargo fmt --check` 通过；此前一次全量因测试端口 `EADDRINUSE` 中断，
对应测试独立复跑通过。完整 Node 套件的部分启动流程尚未确认隔离，
未在本批运行，不能据此声称全量 Node 验收通过。

移除后按 Git 已跟踪且磁盘存在的 `src/` JS/CJS/MJS 文件重新统计：
608 文件、132,501 行；路由 96 文件/24,792 行，根目录 94/21,632，
聊天 68/14,336，线路 32/7,328，CLI 适配 38/6,475，语音 17/5,274，
任务壳 27/4,844，编排 7/3,279，会话调度 2/2,511。统计含必要桥接，
不是可直接删除的文件数。以下更新继续使用相同统计口径；不得以删除小
模块宣称调度器迁移完成。

## 投递类别判定批次

删除 `src/orchestration/delivery-classes.js`（54 行），类别映射及条件判定
迁入 `native/addon/src/delivery_class.rs`。`src/native/runtime.js` 留一处
共享 N-API 调用桥，避免重复创建查找对象；编排运行时与聊天引擎仍由 Node
持有，待迁走后才能删除该桥。冻结副本
`tests/helpers/legacy-delivery-classes.js` 与工作树外原始备份 SHA-256 均为
`721fdf513a3c9307ac327fa2342d719bbfd199e45e8bba0f16d21dcefdda8451`。
差分覆盖未知类型、原型链、查找对象身份、类型转换、副作用 getter、
动态变化和异常；调度、投递、聊天协调、无人值守定向测试合计 281 项通过。
全工作区串行 Rust 测试通过 75 个目标、2,405 项，严格 Clippy 和格式检查通过。

本批后 `src/` 为 607 文件、132,456 行：路由 96/24,792，根目录 94/21,632，
聊天 68/14,335，线路 32/7,328，CLI 适配 38/6,475，语音 17/5,274，
任务壳 27/4,844，编排 6/3,224，会话调度 2/2,511。下一依赖仍是调度
读模型及准入、完成、重排、恢复的事务所有权；这些尚未迁移。

统计基线是本批开始时的 `b9d8ef9b`，只统计 Git 跟踪的 `src/` 下
`.js`、`.cjs`、`.mjs`，按文本行计数：610 个文件、132,585 行；另有
`server.js` 3,099 行。这里包括已迁入 Rust 后保留的宿主适配、进程和
SDK 接口，以及不属于核心后端迁移的插件入口，因此不是待删除行数。
测试、构建工具、Web 前端和 Flutter 不在此统计中。

本批删除 `src/providers/claude-proxy-policy.js` 并缩减 `core.js` 后，
同口径为 609 个文件、132,526 行；`server.js` 不变。Rust 策略位于
`native/addon/src/provider_claude_proxy_policy.rs`，对照冻结的
`tests/helpers/legacy-claude-proxy-policy.js`。原件和冻结副本的 SHA-256
均为 `0aed74ce2b178a6febd9c4a7914bf2bb8d852a6873d42e4f1cd3741064d10001`。
`src/providers/core.js` 保留两行惰性原生调用桥：现有 provider 和 CLI
执行器仍由 Node 承载，在这些调用方迁走后才能删除桥接；策略与失败
决策已在 Rust。debug 与 release addon 均通过 207 项定向回归，覆盖
普通路径、强制代理失败、旧实现差分、属性访问顺序、异常对象和字符串
代码生成禁用场景；release addon 探针、格式检查与 addon clippy 通过。
release 全工作区 Rust 测试通过 75 个目标、2,403 项，0 失败。
上述 Claude 验证时的源码指纹是 `988cded42fdf9df070fcf73a`；之后调度器
实验接口改动已产生新指纹，须使用与当前源码匹配的产物。在 release 网关与 addon 下，
隔离的真实聊天启动测试以合成 provider 和替身 CLI 经本地 SDK 中继、
网关及 provider 代理访问本地上游，确认子进程不获得 provider 凭据。
策略单测在禁止字符串代码生成时通过；将同一限制施加于整个服务时，
服务在启动阶段加载第三方 `depd` 的 `new Function` 处失败，尚未到达
本批策略。`npm test` 核心批次有 2,533 项通过、10 项失败、3 项跳过：
三项进程测试因沙箱不允许执行 setuid `/bin/ps`，审查其临时进程夹具后
单独复跑通过；另有三项 SQLite 跨驱动行为和四项调度器所有权门禁失败。
另外，真实 Claude trace 未提供而跳过，行数预算仍未通过。两个重启
集成测试现已登记为 `flow / isolated`，分级及治理检查通过；release
重启监督器与三种本机地址场景分段通过，测试侧以非 setuid 的同字节
`ps` 副本绕过 macOS 沙箱对 `/bin/ps` 的限制。契约测试 163/163 通过；
native 测试的 319 项通过，重启场景另行以 release 程序验证；独立包
分段测试通过 74 项，因未安装 PowerShell 跳过一项。三项 SQLite 跨驱动
失败在沙箱外使用临时数据库复现。桌面测试因缺少 Electron 工具链跳过
一项。全量验收尚未通过，不能据定向结果提交或合并。

| 源码分布 | 文件 | 文本行 | 主要工作 |
|---|---:|---:|---|
| `src/routes` | 96 | 24,801 | 宿主事实、剩余路由与流；按领域和状态所有者迁移 |
| `src` 根目录 | 94 | 21,635 | 启动、共享基础设施、分类和集成，需逐个判断 |
| `src/chat` | 68 | 14,320 | 回合协调、流、取消、完成和恢复 |
| `src/providers` | 33 | 7,369 | 线路状态、代理和宿主事实；本批迁出 Claude 防直连规则 |
| `src/cli-adapters` | 38 | 6,475 | 外部 CLI 协议和子进程生命周期 |
| `src/voice` | 17 | 5,274 | 音频、进程和设备适配 |
| `src/task-shell` | 27 | 4,836 | 任务运行态与宿主副作用 |
| `src/session` | 24 | 3,414 | 会话生命周期与宿主侧行为 |
| `src/codex` | 13 | 3,401 | Codex 进程、会话目录和协议 |
| `src/workspace` | 17 | 3,308 | 工作区运行态、同步和宿主端口 |
| `src/orchestration` | 7 | 3,279 | 调度协调和存储桥接 |
| `src/classify` | 9 | 3,220 | 分类状态机及宿主协调 |
| `src/session-work` | 3 | 2,540 | 准入、完成、队列重排和恢复 |
| 其他 `src` 目录 | 164 | 28,713 | 配额、搜索、通知、浏览器及其他集成 |

路由口径来自既有启动捕获和台账对账，**不是本批重新启动捕获**：
131 条 Node 路由注册中，35 条是前门的宿主端口，71 条是插件，6 条的
状态已在 Rust，19 条仍驻留 Node；另有 31 层中间件。数字不能相加推断
剩余独立模块数，宿主端口还需逐个迁移其背后的事实和状态。捕获存在
家目录隔离限制，详见 `docs/backend-runtime-inventory.md`。

## 后续优先顺序

1. 调度准入、完成、队列重排和恢复：**已完成（2026-11-19 复核）**。四个入口的
   决策与事务都在 Rust：准入 `schedule_admit_live`、完成 `schedule_settle_live`、
   重排 `schedule_admit_live::reorder`、恢复 `schedule_lifecycle_live`；Node 侧
   `src/orchestration/native-store-host.js` 只剩串行化队列、JSON 编组与时钟端口，
   按原守卫顺序调用，不做调度决策。实测门禁全绿：
   `test-scheduler-admit-rust-required` 3、`test-scheduler-complete-rust-required` 3、
   `test-scheduler-recovery-rust` 4、`test-scheduler-complete-order` 3、
   `test-scheduler-insert-native` 4、`test-scheduler-note-native` 3、
   `test-scheduler-worker-order` 5、`test-session-work-scheduler` 73、
   `test-session-work-host` 64、`test-migrated-command-ownership` 2，合计 164 项 0 失败。
   本文件此前一直写着「现有静态门禁仍未通过」，那是 2026-11-17 的状态，在 11-18
   恢复所有权收尾后就已过期；该说法已据实订正。
   `src/session-work/scheduler.js`（1,108 行）与 `host.js`（1,294 行）仍在 Node，
   但承载的是宿主副作用与事件广播，不是调度状态所有权。
2. 聊天回合与会话所有权：迁移 `turn-engine` 的状态机和效果协调，
   补齐取消、重试、后台任务、完成和恢复的真实事件样本。
3. 状态与持久化：逐个迁移会话记录、任务运行态和仍在 Node 的领域
   写入；保持单一写入所有者、旧数据读取和事务语义。
4. 剩余核心路由：插件管理 8、OAuth 登录 2、会话压缩包 2、provider
   代理 2、Air 同步 2、内部工具/语音 2、APK 下载 1；对应流、子进程
   和共享同步屏障必须随其状态一起处理。
5. 前门依赖的宿主端口、中间件、静态文件、WS/SSE：按具体事实和
   持有的句柄逐簇迁移，不以单纯删除路由注册代表完成。
   WS 部分的进度（2026-11-19）：共享连接路由的连接注册、心跳判定与每连接发送
   队列已由 addon 的 `RustWsHost` 持有，`src/ws-backpressure.js` 已删除；
   详见 `ws-host-registry-2026-11-19.md`。同日第一条**生产** WS 路径
   `/ws/machines/<id>` 的升级终结已迁入前门（`native/gateway/src/ws_machines.rs`
   与 `ws_tls.rs`），`src/ws/machines.js` 与连接路由分支已删除，8 项逐字节差分
   与 5 个变异通过，详见 `ws-machines-cutover-2026-11-19.md`；该路径是 9 类 WS 中
   唯一零共享状态的一条，`wss://` 的真实 TLS 握手尚未本地实测。仍在 Node 的是
   `/ws/chat` 的 upgrade 终结与回合引擎状态（快照/重放/聊天编排）以及其余 WS
   路径的连接注册。
6. CLI、浏览器、音频及外部 SDK 集成：迁移业务和状态，按平台保留
   必要兼容桥；插件的独立发布模型另行处理。

整体完成仍要求 Rust 独立启动能够承载完整产品、无生产 Node 后端、
契约与全量测试通过，并验证打包和回滚；当前均未达到。

调度器第一阶段已冻结四个迁前入口并建立内存和独立 SQLite 所有者对拍；
实验性元数据读取可显式准备至多 16 MiB 的记录，详见
`scheduler-read-model-next.md`。这仍不构成非阻塞读模型；但四个调度入口本身
及其所有权门禁已在 2026-11-19 复核中全部通过（证据见上文第 1 条）。
