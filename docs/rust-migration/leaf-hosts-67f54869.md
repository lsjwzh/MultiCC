# 67f54869 之后的叶模块与兼容入口

基线取自本地 main 的 67f54869。以下十个文件在入口依赖表中均从 server.js 可达，项目内直接依赖和脚本路径两列均为空。宿主注入端口在差分中可替换。冻结源取自 Git 对象。

| 基线文件 | 实施前确定的 Rust 边界与所有权 | 必须保留的错误语义 |
|---|---|---|
| network/proxy-policy | 复用 core/outbound_proxy 的 CIDR、macOS 代理解析与旁路规则。addon 与 V8 活对象交互，实例保有最近一次系统配置。 | 显式空环境变量生效，本地地址可在系统发现失败时直连，发现失败继续使用已有缓存。 |
| chat/turn-event-journal | journal 模块构造序列化记录、裁剪超大事件、解析分代 JSONL。按会话隔离序号和写入队列。 | 记录序列化的同步异常向外传播；异步追加失败记数，读到损坏行继续读取。 |
| classify/aux-run-log | aux_log 借用注入的同步文件系统，投影审计字段、截断 UTF-16、筛选和旋转 JSONL。 | 缺文件返回空，写失败仍返构造好的记录；保留日志回调的时点。 |
| codex/proxy-trace | 每个 trace 独占有限条记录、计数器与 logger；Rust 负责 URL 脱敏、路由分段与状态分类。 | 关闭和结束最多结算一次，诊断日志异常被吞。 |
| voice/hotword-corrector | 匹配器按词表缓存；Rust 处理词条、别名、拼音近音预算与重叠候选；宿主提供 pinyin-pro 与 V8 正则。 | 拼音不可用时 ASCII 规则仍生效，保留 UTF-16 偏移及 JS 替换串语义。 |
| dispatch/progress | 每个订阅独占快照、有界去重集合与推理文本；Rust 判定事件投影和外发次序。 | 进度回调异常吞掉；首次历史回放保留同步异常。 |
| ws/native-queue | 扩展现有 WS 原生队列，按连接绑定 send、完成回调与统计。宿主 socket 保持原身份。 | 发送同步异常交给原回调，断开后返回新建的关闭快照，重复安装返回同一接口。 |
| task-board/relocate | Rust 判定任务迁移的前置条件、目录与引用归属并生成提交结果。异步工作区移动和事务均使用原端口。 | 拒绝前不移动工作区，移动失败保留 status/body，提交失败不通知。 |
| task-shell/task-first | Rust 管领养与补索引资格、推广及任务结果。同步 store 对象保持身份，异步请求按单个 flight 合并。 | 批量墓碑查询异常回退到逐项查询，每个任务的错误独立收集。 |
| routes/voice-gateway-proxy | Rust 管上游目标、路径、请求头与升级回包头。HTTP 流与双向 socket 继续借用 Node 对象。 | 无子服务为 503；上游失败按 headersSent 分支，拒绝升级时去掉 transfer-encoding。 |

## 新叶实施后复核

| 模块 | 实际所有权及错误边界 | 结构结论 |
|---|---|---|
| proxy-policy | Rust 共享 CIDR、旁路、环境合并及配置拒绝规则，按 UTF-16 比较主机名。JS 持有最近的系统配置及进行中的刷新。 | 同步规则复用网关 core。保留 scutil、原 V8 正则、公用 URL 构造器和 Promise 刷新时序。 |
| turn-event-journal | Rust 构造普通记录和超限存根，调用注入时钟、解码损坏行；宿主管理会话序号、异步写队列、文件轮换。 | 与 Aux 共用记录和 UTF-16 文件名模块，独立保留两种读写失败行为。 |
| aux-run-log | Rust 依次读取运行记录的字段，保留嵌套对象身份和 UTF-16 截断。JS 持有同步文件系统、分代和查询。 | 不合并两套日志的队列与轮换协议。 |
| proxy-trace | Rust 脱敏、解析路由、结算状态；JS 持有有界窗口、事件监听器、可替换 logger。 | 按请求借用响应，保持 finish/close 只结算一次，以及日志异常被吞。 |
| hotword-corrector | Rust 持有按优先级排列的 UTF-16 音节向量，产生不重叠匹配区间。 | 复用 core 计算；宿主保留词典的惰性加载、JS 正则替换及非字符串对象的自定义方法。 |
| dispatch/progress | 原生 reducer 通过 V8 托管单个订阅的快照、去重与回调，读取可能重入的 getter 后才取相应快照。 | 每个订阅单独创建状态；总线订阅和取消在事件宿主。 |
| ws/native-queue | 连接路由直接调用原生绑定；V8 的绑定回调保持 socket、原始 send 和端口存活，按连接注册。 | 传输抛错通过同一回调交还，严格属性赋值通过宿主端口保留原错误。旧入口退出图。 |
| task-board/relocate | Rust 生成决定并在提交回调内逐项更新同一任务对象；宿主负责 await 移动和提交后的通知。 | 失败返回仍属于原 HTTP 和持久化事务，Rust 不保留跨 await 的可变引用。 |
| task-shell/task-first | 领养、推广及索引资格使用 Rust，同一轮共享 map、set 及原 store 对象。JS 持有 single-flight Promise 和批量墓碑查询。 | 保留逐项错误、两次查询与回退，成功写索引后才把 id 加入集合。 |
| voice-gateway-proxy | Rust 计算目标、请求头、升级路径及回包。Node 持有请求、响应及双向 socket。 | 同步策略独立于异步字节流，保留 503、502 以及上游拒绝升级的原路径。 |

## 上轮九个入口

| 旧入口 | 改接后的生产调用方与 Rust 所有权 | 保留的宿主能力与退出条件 |
|---|---|---|
| macos-unlock-password | host-power 经 binding 调用 unlock_keychain，原生计划决定参数、校验和错误。 | security 的 execFile 和 Promise 返回由宿主提供，非 macOS 查询或清除短路。 |
| macos-unlock-probe | host-power 改接 unlock_probe，原生生成命令并判读结果。 | 子进程、超时、JSON 解析及两个授权阶段的 await 仍在宿主。 |
| runtime-homes-janitor | server 启动 runtime_homes 的清理实例，Rust 管筛选、TTL 与计数。 | 采用原 lstat/readdir/rm 和服务计时器。 |
| upload-middleware | server 直接构建绑定提供的上传套件，Rust 持有 gate、lease、异常映射。 | Multer、Express response、JS 错误类及严格赋值保留原身份。 |
| ios-ota | server 直接创建 iosOtaApi；ios-udid 直连来源与 XML 转义绑定。 | 传入当前请求、真实 fs/path，保留 lstat 和 sidecar 的独立失败范围。 |
| routes/ark-quota | quota-host 经 binding 使用 ark_quota 原生 CLI 实例；兼容入口单独实例化。 | PATH 检查与 execFile 仍由 Node 执行，缓存按加载实例隔离。 |
| tunnel-sakurafrp | tunnel/index 通过 binding 接入原生 Sakura 状态机、命令生成和日志读模型。 | 注入 run/wait 及文件访问，保留有限次探测和原始诊断回包。 |
| push/fcm-transport | fcm-devices 经 binding 创建原生 transport，Rust 持有凭据、缓存及进行中的刷新 Promise。 | Node 提供 RSA 签名、URLSearchParams、fetch、AbortSignal 及异步发送。差分使用测试密钥和假 HTTP。 |
| workspace/orphan-scan | server 经 binding 创建原生扫描器；Rust 持有扫描 flight、上次报告、计时器与停止标记。 | repoActor 继续独占异步 Git 序列；保留 remove/prune 的次序与失败处理。测试仅使用临时仓库或注入的 Git 端口。 |

九个旧文件继续提供 CommonJS 兼容导出。其生产调用方均已改接；今后宿主迁出 Node 事件循环、SDK 或 repoActor 时，才可撤下相应的 Node 端口。盘点采用原脚本的换行数，从 server.js 出发计入入口与可达的 src 文件；兼容层仍在依赖图中时计作一个文件。
