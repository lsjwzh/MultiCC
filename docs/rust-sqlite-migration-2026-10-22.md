# SQLite 读写接入 Rust（2026-10-22）

本轮将 MultiCC 自有 SQLite 访问入口统一接到 Rust，默认驱动为 Rust。代码已在当前工作树完成，线上进程尚未切换；没有重启服务，也没有手动提交或合并。部署须提供与操作系统、CPU 架构匹配的新原生模块，旧搜索/Token 模块不包含数据库接口，不能代用。

## 已覆盖范围

| 入口 | 接入后的路径 |
| --- | --- |
| 任务壳、任务和持久化记录 | `src/task-shell/store.js` → 统一驱动 → Rust |
| 调度状态、等待、操作及 outbox | `src/orchestration/sqlite-store.js` → 统一驱动 → Rust |
| 历史全文检索 FTS5 | `src/search/index-store.js` → 统一驱动 → Rust |
| Provider 配额缓存 | `src/quota/provider-limit-cache.js` → 统一驱动 → Rust |
| CC-Switch 数据库只读导入 | `src/sqlite-runtime.js` → 统一驱动 → Rust |
| OpenCode 上下文和原生会话存在性查询 | 两处直接使用旧驱动的入口已改为统一驱动；保持只读 |

Rust 管理数据库连接、参数绑定、SQL 执行、256 项预备语句缓存、超时、事务与嵌套保存点、提交失败回滚和关闭。SQLite 引擎继续使用成熟的 C 实现，由 `rusqlite` 静态打包进入已有 napi-rs 原生模块。

当前业务层的 SQL 定义、JSON 序列化、JavaScript 业务回调和任务卡片组装仍在原模块中。JSON 配置文件存储、第三方依赖内部数据库不属于这次 SQLite 驱动迁移。此前读模型模拟实验保持独立，没有因本轮驱动迁移就切换到实验读模型。

## Node 桥接例外与行为边界

保留 `src/sqlite/driver.js`，仅适配既有 `prepare/run/get/all/pragma/transaction` 调用、JavaScript 回调及错误形状。存量调用依赖同步事务，直接改成 Promise 会破坏调用链及事务边界，因此这一轮保留同步调用；数据库操作不会因为改用 Rust 就自动释放 Node 主线程。

后续把业务事务改为显式命令后，应由 Rust 一次执行整批读写，并在后台线程运行。届时缩小同步桥接范围，而不是在桥接文件里新增业务逻辑。

- Rust 是唯一驱动。模块缺失、错误架构或缺少 `RustDatabase` 时明确失败，绝不因一次写入失败而自动换驱动重试，也没有 Node 应急回退实现。
- 只读路径仍不创建缺失的数据库文件；WAL、外键、busy timeout 继续有效。
- 超出 JavaScript 安全整数范围的读取明确报错；64 位 BigInt 绑定和 Blob 按类型传递。
- 当前业务调用使用 `get/all`。兼容 `iterate` 会先物化结果，不适用于无上限导出；大批量导出应通过独立 Rust 命令实现。

## 性能实测

Apple M4、macOS ARM64、Node 26.8.1，合成数据每条正文约 8 KiB，100/3000 条规模；预热两轮，15 轮交替执行取中位数。两个实现使用同样的表、预备语句、WAL 和 `synchronous=NORMAL`，包含跨语言调用开销。两边 SQLite 版本分别为 Node 3.53.4、Rust 3.50.2，结果不能视为纯语言差异。

3000 条记录的数据集：

| 操作 | 旧 Node 驱动 | Rust 驱动 | 结果 |
| --- | ---: | ---: | --- |
| 全量读取 | 38.1040 ms | 37.9270 ms | 基本持平 |
| 1000 次按主键读取 | 12.1013 ms | 12.9831 ms | Rust 约慢 7% |
| 单事务 100 次同值更新 | 0.1497 ms | 1.1177 ms | Rust 约慢 7.47 倍 |
| 单事务实际更新 100 条 | 0.2869 ms | 1.2979 ms | Rust 约慢 4.52 倍，绝对增加约 1.01 ms |

补充与安装包相同的 Node 22.23.2（ARM64，官方 SHA-256 校验）实测，Node 内置 SQLite 为 3.51.3：

| 操作（3000 条记录） | Node 22 旧驱动 | 同一个 Rust 模块 |
| --- | ---: | ---: |
| 全量读取 | 24.5578 ms | 27.4211 ms |
| 1000 次按主键读取 | 8.2140 ms | 9.8934 ms |
| 单事务 100 次同值更新 | 0.3459 ms | 0.6810 ms |
| 单事务实际更新 100 条 | 0.3894 ms | 0.7203 ms |

Node 22 下实际事务写入约慢 1.85 倍，绝对增加约 0.33 ms；结论仍是没有加速收益。不同 Node 版本的结果分开报告，不混算比例。

已减少参数复制及常见文本参数转换的开销，逐条调用仍有显著额外成本。该结果支持将此变更定位为后端语言迁移基础，不能宣称性能提升。以性能为目标的上线，应继续把整批数据库操作和摘要计算留在 Rust 内部，并对照同等批处理的 Node 实现重新测量。

Node 对照基准脚本已随 Node 驱动的删除一并移除；当前仅保留 Rust 驱动，重新测性能需另写只含 Rust 的基准。

## 验证证据

- Node 26 最终数据库相关测试 134/134 通过，含旧数据库读取、跨驱动互读、写后重开、只读保护、损坏文件拒绝、锁竞争、外键提交失败回滚、嵌套事务、FTS5、JSON、数值和 Blob 边界。
- Node 22 的 Rust 驱动、FTS 和任务壳测试 84/84 通过。同一组合初次补测有 6 项因开发测试用 better-sqlite3 只编译了 Node 26 ABI 而失败；没有修改共享依赖或将这些失败计为 Node 22 的通过项。
- 任务壳测试 273/273、任务相关测试 352/352、调度/等待/outbox/只读边界等测试 206/206 通过。
- 打包、运行时及既有 Rust 内核等组合测试 147 项通过、1 项跳过；跳过项目不计入验证覆盖。
- 两组真实隔离服务测试通过：任务执行、WebSocket、幂等重放、跨任务隔离及重启后的持久化；数据全部来自隔离测试目录。
- 真实打包副本可加载自身 Rust 模块；删除包内模块后，即使宿主配置了有效原生模块，打包检查也必须失败。此项包含在最终 134 项中。
- Cargo fmt、Clippy `-D warnings`、JavaScript 语法、工作流 YAML 解析、测试分层、产物治理、运行时写入清单与 `git diff --check` 均通过。
- 行数闸门仍失败：`server.js` 3020 行、上限 3000。已逐字节核对该文件与 HEAD 相同，是既有基线问题。

本轮完成本机 ARM64 构建，并在 Node 26 与 Node 22 验证同一个 N-API 模块。Intel 构建尝试因当前工具链缺少 `x86_64-apple-darwin` 标准库而未完成；Windows/Linux 尚未在本机执行，已将相关测试纳入跨平台 Rust CI。此前交付的 Intel 安装包包含旧搜索/Token 内核，不能当成本轮数据库模块的验证结果。

收尾时主分支新增前端提交 `9bb29d4b`，当前工作树相对 main 为 `0 1`。新增提交没有修改本轮数据库文件；因当前树含未提交成果，没有执行重基或覆盖，后续交由 AutoCommit/合并流程处理。上述测试对应当前工作树。

## 构建与部署

原生模块为必需打包产物：standalone 和 Electron 打包缺少目标模块时直接失败；运行时检查实际打开 Rust SQLite。CI 和 Docker 构建链已补充 Rust 构建步骤，用户机器无需安装 Cargo。

源码运行时，构建目录应放在主仓库 `data/` 或工作树外的临时目录，避免 ignored 文件随任务工作树回收而丢失：

```sh
MULTICC_RUST_PREBUILT_DIR=/absolute/persistent/native-output npm run build:rust
```

运行进程配置同一个 `MULTICC_RUST_PREBUILT_DIR`，或通过 `MULTICC_RUST_ADDON` 指定完整 `.node` 文件。正式安装包使用包内 `native/prebuilt/<platform>-<arch>/multicc_core.node`。

本机最终 ARM64 模块与基准结果保存在主仓库 `data/rust-sqlite/2026-10-22/`，包含 `provenance.json` 和 SHA-256。没有覆盖旧模块，也没有修改服务配置或重启线上服务。部署匹配模块后，服务重启仍由用户手动触发。
