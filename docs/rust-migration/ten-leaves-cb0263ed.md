# 十个 Node 叶文件的 Rust 边界

基线为本地 main 的 `cb0263ed`。从 server.js 递归追踪本地加载和脚本路径，以下十个文件均可达，彼此无引用，没有项目内文件下游。差分使用该提交的逐字节副本。

| 原文件 | Rust 模块、类型与所有权 | 对外错误及宿主边界 |
|---|---|---|
| macos-unlock-password | unlock_keychain 将操作、平台、UTF-16 长度与进程结果映射到命令参数或错误。密码保持为 V8 原值。 | 只有数值 44 代表条目不存在。Node 提供用户配置、execFile 与 Promise。 |
| macos-unlock-probe | unlock_probe 根据状态与探测回包构造权限记录。每次请求独立，无共享状态。 | 缺少二进制、执行权限、协议版本与待用户操作分别报告；JSON 解析和进程回调沿用宿主。 |
| runtime-homes-janitor | runtime_homes 管理保留期、白名单和每轮删除计数。扫描借用注入文件系统。 | 根路径非法抛 TypeError；读取集合失败向上传播，子目录消失和移除失败跳过。 |
| upload-middleware | voice_upload 负责 MIME、文件名、错误映射和每个 gate 的准入状态。 | 保留 UploadPolicyError 身份，单次释放名额；Multer、Express 事件和响应由宿主连接。 |
| ios-ota | ios_distribution 管理侧录元数据、请求来源、安装条件与 plist。UTF-16 文本保留孤立代理项。 | IPA 或侧录不可读按旧规则降级，缺少安装元数据返回 404；fs、日期和响应仍走宿主。 |
| workspace/orphan-scan | worktree_orphans 解析 Git porcelain、筛选声明路径、判定删除资格和生成扫描记录。 | repo actor 串行执行命令，保留读取失败时的旧回退、逐项错误码与 Promise 去重。 |
| routes/ark-quota | ark_quota 拆分首个配对 JSON 对象、规范化额度周期并分类查询结果。 | 区分缺 CLI、需认证、不可用；宿主提供 execFile、Date.parse 和 JSON.parse。 |
| push/fcm-transport | fcm_transport 管理凭据资格、到期策略、FCM 消息与状态码。实例拥有自己的 token 和在途请求。 | 401 清缓存，明确 UNREGISTERED 才标旧 token，传输异常映射为 unavailable；签名和 fetch 使用 Node 端口。 |
| tunnel-sakurafrp | sakura_launcher 负责查找、进程及重试策略、日志优先级和诊断记录。 | Node 提供文件系统、LaunchServices 子进程与等待，不可读日志返回 null，重启错误仍抛出。 |
| task-routing/facts | task_facts 管理事实与提案的不可变约束、版本检查、事件投递与事务返回值。 | 用户注入同步事务；保留冲突 code、异常对象、回滚、幂等重放身份及 JSON 深拷贝。 |

## 实现后的逐文件复核

| 模块 | 核对结果与保留接口 |
|---|---|
| unlock_keychain | 不保存密码，不跨 Promise 保存 Rust 引用。前缀和结果策略共用一个模块，Node 仅拼接不透明账户及密码值、等待原有子进程并抛出原形状的 Error。可在钥匙串执行端迁移后移除宿主接口。 |
| unlock_probe | 桌面权限和解锁回包使用两个入口，共用进程错误描述。保留 Agent 回包优先于部分退出错误的分支。进程探测、ping 和 V8 JSON 解析随 Agent 客户端迁移。 |
| runtime_homes | 一轮扫描借用文件系统回调；不在原生模块中长期持有文件或计时器。集合、单个 home 和临时消失的子项分别处理异常。同步入口沿用调用方原有同步契约。 |
| voice_upload | 每个 gate 有一个独立计数，每个响应有一个只释放一次的回调；重入比较后读取最新计数。Multer 的 fileFilter 继续保有原来的错误类，Express 持有 finish/close 回调。 |
| ios_distribution | 独立分发模块拥有字段规则、URL 策略、信息 DTO 和 plist 模板；清理标题与 XML 转义使用 UTF-16。宿主保留公开正则、文件系统、日期解析和 Express 的响应顺序。 |
| worktree_orphans | 声明集合保留 JS Set 原值，逐条判定与异步 git 调用交错；Rust 负责报告冻结和删除资格。repo actor、扫描 Promise 和定时器保持原有所有权，等待仓库执行端迁移。 |
| ark_quota | 流分帧与认证匹配放在 core；addon 使用 V8 JSON 和日期语义产生返回值。成功解析 stdout 后不再解析 stderr；不可用、需要安装及需要登录的结果独立验证。 |
| fcm_transport | 每个 transport 单独持有原生缓存；401 在解析错误详情前清缓存。V8 持有待完成 Promise，RSA 私钥只由签名端口处理。结果分类与签名载荷归原生模块。 |
| sakura_launcher | 每次重启独占原生状态机，状态包括当前二进制、启动/停止阶段与重试次数。终态显式携带成功标记或错误文案；宿主负责定时与子进程。日志匹配单独放 core，按 UTF-16 单元计数。 |
| task_facts | 仓库按注入 store 隔离；Rust 维护事务顺序、JSON 值限制、事件幂等和异常 code。同步回放直接返回存储对象。生产调用方经 binding 访问，原文件保留兼容导出。Node 仅提供深比较、JS 加法与参数解构。 |
