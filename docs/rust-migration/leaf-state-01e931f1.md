# 六个 Node 叶模块的 Rust 结构复核

迁移基线为 `01e931f1`。在该提交的 `server.js` 可达依赖图中，下表六个文件互不引用，均没有项目内模块或脚本路径下游。逐字节取自该提交的差分基准位于 `tests/helpers/frozen-state-leaves/`。

| 基线文件 | 模块划分与所有权结论 | 保留的行为与错误边界 |
|---|---|---|
| `src/chat/workspace-residency.js` | 独立的 `addon/workspace_residency` 管理驻留记录。记录持有活动回调，回调可以通过 `this` 访问和修改同一个记录，因此保留 V8 Map 与对象身份。 | 关闭前标记 parked，等待 close 时保留关闭异常。严格赋值仍经过宿主，调用方通过 setter 抛出的原异常继续传播。 |
| `src/chat/error-persistence.js` | 重连文本分类进入 `core/chat_error_history`。认领表、历史行与消息投影在同名 addon 模块内，每个持久化器独占一张表。服务入口直接使用原生持久化器，旧模块保留兼容导出。 | 写入前先认领，同步抛错后返回原消息；异步失败只撤回同一份认领。Node 接入 SHA-1、可注入时钟、日志与自定义 thenable。 |
| `src/quota/claude-usage-queue.js` | `addon/claude_usage_queue` 负责读数复用、并发合并和容量淘汰。缓存跟随 CommonJS 模块实例，账号键、返回读数与进行中的 Promise 保留原始身份。 | 只有成功读数受一分钟缓存保护，抓取失败转为 unavailable，可以立即重试。Node 等待外部抓取并提供原有的时钟与比较运算。 |
| `src/battery-guard.js` | 独立的 `addon/battery_guard` 持有每个实例的检查状态和闩锁。它消费电池观测结果，与已有的电量读取模块分开。 | 并发检查读取当前快照，睡眠操作返回后才置闩并计数。探测或睡眠抛错时记录 error，finally 释放检查状态。定时器和异步电源调用由 Node 接入。 |
| `src/memory/task-distill.js` | `core/memory_distill` 使用项目已有的 `JsString` 处理 UTF-16 清洗、二元组相似度和 Markdown 小节；同名 addon 模块只负责 V8 输入输出和延迟类型转换。 | 保留孤立代理项、空文件开头的换行和容量的 slice 语义。写入端口沿用临时文件及 rename；写入失败记录日志并返回 false。 |
| `src/notes-store.js` | `addon/workspace_notes` 持有当前便笺集合。事件环继续归现有 workspace socket owner，便笺模块通过该 owner 加载和追加事件。 | 保留坏 JSONL 行跳过、落盘失败后继续广播的顺序。过滤结果的 length getter 可以重入；持久化时重新读取当前集合。 |

上述宿主接口在同步调用方、Node 回调或 Promise 仍存在期间保留。后续迁移这些调用方时，可以分别撤下对应适配。纯文本算法已可直接在 Rust 中调用。
