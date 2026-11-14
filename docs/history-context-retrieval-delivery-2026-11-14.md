# 历史检索与存读 review 改进 · 交付说明（2026-11-14）

对应 review 原文 `history-context-retrieval-review-2026-11-14.md`。本文只记录已落盘的改动、
取舍理由、实测结果与未做项。分支 `multicc/task-88a969353c0b716636b714b302483a39`，
HEAD `bc6ff79d`，本批未提交、未合并、未重启服务。

验证用原生模块指纹 `d1cde46cfffbc66ec54aa96c`（等于当前源码指纹，
`scripts/rust-source-cache.js` 的 `sourceFingerprint(cwd)` 实测）。

---

## 1. 检索后端：索引写真值 + 多样性重排

### 问题

索引写入侧把 `dir_id` / `task_id` 写成占位空值，`updated_at` 写的是**文件 mtime**
而不是消息时间；检索只按相关度返回，所以一个话多的会话能占满整个答案。实测
同一语料同一查询，top-10 全部来自单个会话。

### 改动

索引写入与读取（Node I/O 层）：

- `src/search/message-corpus.js:75` `messageTime()`、`:87` `messageTaskId()`：
  消息时间取 `ts`（number/ISO 可解析且 > 0），否则回退文件 mtime
- `src/search/message-corpus.js:129` `sessionChunkRows()`：每行带 `dirId` / `taskId` /
  `updatedAt`（消息 ts）/ `sourceMtime`（文件 mtime），落值在 `:138`、`:154`
- `src/search/message-corpus.js:181` `createMessageCorpus({ resolveDirId })`：宿主注入，
  取不到时写 `''`；流式 `handleLine` 的对应落值在 `:429`、`:445`，
  目录搬迁追平在 `:345-346`
- `src/search/index-store.js:50` `SCHEMA_VERSION = 2`，`:248` 旧库 DROP/重建条件
- `src/search/index-store.js:261` `search_chunk.task_id`、`:265` `source_mtime`，
  索引 `search_chunk_dir` / `search_chunk_task` 在 `:272-273`
- `src/search/index-store.js:379` `updateChunkMeta`：内容 hash 未变但归属变了只刷元数据
- `src/search/index-store.js:348` `refList` 改用 `source_mtime` 判新鲜度，`:483` `filtersFor`
  支持 `dirId` / `taskId`
- `src/search/runtime.js:261` `findMessages()`：SQL 级过滤 + 过取 `limit * 4` + 送 Rust 重排
  + 失败回退原始顺序；`:353` `defaultResolveDirId()` 调用时读 `state.persistedSessions`
- `src/routes/task-search.js:133` `dirId` / `taskId` 入参校验（> 200 字符 → 400
  `filter_too_long`），响应字段未变

多样性内核（Rust）：

- `native/core/src/search_diversity.rs:113` `order_of()`：稳定排序 + 原始索引做最终
  tie-break（答案不依赖排序实现）；跨会话同 `content_hash` 折叠；超配额进补位池，
  结果不足时按相关度回填 —— 所以**总条数不变，答案不会变短**
- `native/core/src/search_diversity.rs:197` `rerank()`，`native/core/src/lib.rs:60` 挂载
- `native/addon/src/search_diversity.rs` `#[napi] search_diversity_rerank`，
  `native/addon/src/lib.rs:66` 挂载
- `src/search/diversity.js:37` `rerank()`：JS ↔ napi 桥

### 实测效果

同一语料、同一查询，原始 SQL 相关度顺序 vs `findMessages`：

```
top-10 before: loud:10
top-10 after:  loud:3 quiet-0:1 quiet-1:1 quiet-2:1 quiet-3:1 quiet-4:1 quiet-5:1 quiet-6:1
```

before 全 20 条里 13 条属 `loud`；after top-10 内无会话超配额 3、8 个会话都有代表，
总条数仍为 20（`loud` 的 13 条全部保留在补位池）。同段落复制到两个会话折叠成 1 条，
较新者胜出。过滤实测：`dirId=dir-odd` → 3 条；`taskId=task-loud` → 3 条且全为 `loud`。

### 取舍

- `dirId` 走**注入式**而不是改 `server.js`：`chat_history` 的 JSONL 本身不带目录，
  映射在会话记录里（`src/session/create-record.js:104`）。默认实现调用时读共享状态
  注册表，避免持有引用，也避免与并行工作抢 `server.js`。
- 新增 `source_mtime` 单独存文件 mtime：`updated_at` 改成消息时间后，
  `listRefs().updatedAt === mtime` 这条新鲜度快路径否则会被破坏。
- 重排放 Rust、回退留 Node：规则只有一份实现，但「后处理失败导致拿不到答案」
  比「只按相关度排」更糟，所以失败时返回原始顺序并计数。

---

## 2. 显示字节预算（32 MiB）

### 问题

显示路径只有**条数**上限。事故级会话是少量超大消息，条数闸完全无效：
`chat_history/marketing-claude-chat-23.json` 实测 158,034,916 字节（150.71 MiB）
但只有 **2,738 条**，「最后 10000 条」等于整份文件（158,032,178 字节）。
单条最大 281,296 字节。

### 改动

- `native/core/src/chat_history_index.rs:56` `DEFAULT_DISPLAY_MAX_BYTES = 32 MiB`，
  `:60` 环境变量名，`:69` `TrailingByteBudget`（newest-first 增量累加器），
  `:108` `fit_trailing_bytes`；单测在 `:425-489`
- `native/addon/src/chat_history_runtime.rs:113` `configured_display_max_bytes`
  （port → env → 默认），`:627` `message_display_bytes`（口径），
  `:635` `byte_budget_window`（未超预算时原样返回同一数组），
  `:657` `filter_values`，`:2049` `project_messages`，`:2090` `freeze_page`
- `src/routes/chat-history.js:184` 透传可选 `maxBytes` port，`:532` reset 广播、
  `:779` `/history` 响应按需带 `byteBudgetTruncated`

32 MiB 预算对上述会话：保留最新 **1,238 条**（33,554,400 字节），丢弃较旧 1,500 条。

### 取舍

- 口径 = `JSON.stringify(message)` 的 UTF-8 字节：等于下行文本、也是磁盘 JSONL 行
  减去换行，并且能安全**上界**估计 V8 堆（ASCII 1:1，CJK 按 3 字节算 vs 2 个
  UTF-16 单元，只会多算）。
- 只在**真被截断时**追加 `byteBudgetTruncated: true`：不足预算时键、条数、顺序、
  字段与旧实现完全一致，差分与 `Object.keys` 断言都通过。
- `projectedMessages` 保持裸数组、不加标记：`displayHistory` 等消费方要数组；
  它是内部任务索引路径，不是客户端契约。这是唯一没有显式截断信号的入口。
- 磁盘原文零改动：Rust 只读 + 内存窗口 `slice`；测试断言读后文件逐字节不变。

---

## 3. contextTrace 存量（只交付工具，未执行）

- `scripts/history-trace-compact.js`（349 行，默认 dry-run）
- `tests/test-history-trace-compact.js`
- `docs/chat-history-retention.md`（+22 行：存量与兼容验证两节）
- `src/chat/turn-engine.js`

全量 dry-run 实测：440 文件 / 6,563 条消息 / **可回收 740.9 MB**，
99.4% 的 receipt 仍在库，代价仅 0.6% 面板明细。写入侧早已是 304 B 摘要，
这 740.9 MB 是历史遗留的完整 trace。

**本批未执行 `--apply`**：涉及用户数据且需服务停止，由你决定何时跑。

---

## 4. 测试结果（全部第一手实测）

Rust（worktree 根，`native/Cargo.toml`）：

| 命令 | 结果 |
|---|---|
| `cargo build --locked --workspace` | warning/error 行数 0 |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | 零警告 |
| `cargo test --locked --workspace --no-fail-fast -- --test-threads=1` | **52 套件 / 1527 通过 / 1 失败** |

其中 `search_diversity` 14 条、`chat_history_index` 10 条全通过。

唯一失败：`workspace_sharing::control::tests::create_reads_live_context_and_timed_out_context_never_mutates`。
**不是回归**：`git diff main -- native/core/src/workspace_sharing` 为空；空闲机器串行
重跑 3/3 通过，但耗时 4.29 / 4.25 / 4.26 秒而超时是 5 秒 —— 这条用例本来就贴着
超时线跑，任何负载都会把它压过线（整模块 17/17，45.71 秒）。

Node（带原生模块，指纹 `d1cde46cfffbc66ec54aa96c`）：

| 套件 | 结果 |
|---|---|
| `test:architecture` | 148 / 0 |
| `test:security` | 1156 / 0 |
| `test:core` | 352 / 1（见下） |
| `test:rust` | 300 / 0 |
| `test:governance` | 20 / 0 |
| 检索 4 套（index / runtime / task-search / message-context） | 82 / 0 |
| 历史存读 10 套（routes / 三个 differential / tail-append / oversize / frame-budget / view / ordering / trace-compact） | 185 / 0 |

治理门禁：`check-test-tiers`、`check-source-line-budget`、`check-repository-artifacts`
全部 exit 0；`test-release-version-consistency` 5/0（核心集计数 447 未变）；
`test-repository-artifacts` 12/0。

无 Node 前门冒烟：`scripts/smoke-no-node-gateway.sh` 对 release 二进制 **PASS**
（隔离 PATH 无 node、Rust 路由 200、两条需 Node 的路由 503 `node_runtime_absent`、
SIGTERM exit 0）。

### `test:core` 的那 1 红

`differential: real captured Claude traces`（`tests/test-chat-events-differential.js:545`），
断言「expected at least one real trace」。**既有环境红，与本批无关**：

- 该测试文件与 `main` 字节一致（`git diff --stat main` 无输出）
- 语料 `/tmp/claude-lane-capture/real/<scenario>/trace.jsonl` 不在仓库里，
  由曾放在同一 `/tmp` 目录下的临时脚本生成（`docs/claude-lane-protocol.md:773`），
  那些脚本现已不存在
- 8 个场景目录都还在但**全是空的**，而测试的守卫
  （`if (!fs.existsSync(root)) return`）只检查父目录，所以兜不住这种半清理状态

重建语料需要真实 Claude 上游流量。若希望这条红消失，应把守卫改成「至少有一个
`trace.jsonl` 才继续」—— 这与作者本来的「无语料则跳过」意图一致；本批未改，
因为它不属于本次范围，且红本身是「该重新采集语料」的提醒。

### 环境提醒

`test:architecture` 不带原生模块环境变量时是 **145 / 3**，三个红全是字节预算的新
测试 —— 它们依赖新建的 addon。跑这批测试必须两行分开 export：

```sh
P=<主仓>/data/rust-source/d1cde46cfffbc66ec54aa96c
export MULTICC_RUST_ADDON=$P/darwin-arm64/multicc_core.node
export MULTICC_RUST_PREBUILT_DIR=$P
```

---

## 5. 治理与入库

- `tests/test-tiers.json`：两个新测试按既有惯例登记为 `other` + `owner: npm:test:core`
  （与 `test-search-index.js` / `test-search-runtime.js` 同档），所以**不动发布门禁的
  447 核心集计数**
- `package.json`：两个新测试接进 `test:core` 已有的检索分段，确保 CI 会跑
  （没进 `package.json` 的测试 CI 永远不跑）
- 8 个新文件已 `git add -N`（intent-to-add，不产生提交）。其中 7 个被模块声明或
  `package.json` 引用，不入索引会让 Node-free 镜像的 Rust 构建**直接缺模块**
  （`scripts/build-task-shell-image.js` 用 `git ls-files` 导出，只导已跟踪文件）

---

## 6. 未做项 / 需要你决定

1. **重启后搜索索引会全量重建**。线上库是 `user_version = 1`（79,097 块、701 来源、
   98.5 MB），新代码是 2，启动时会 DROP 重建。重建走既有的渐进 sweep，但期间搜索
   结果不完整。顺序建议：先清 contextTrace 再重启，重建要扫的字节能少一半。
2. **740.9 MB 清理未执行**（见第 3 节），需停服务后跑 `--apply`。
3. **`maxBytes` port 未在 `server.js` 顶层接线**：当前运维旋钮是环境变量
   `MULTICC_CHAT_HISTORY_DISPLAY_MAX_BYTES`，port 已预留。要不要接进 config 由你定。
4. **落盘侧按字节淘汰 / `tools` 裁剪未做**：按约定不动原文与 `tools` 字段。
5. **服务未重启**：第 1、2 条都要你手动执行。
6. **未提交、未合并**：AutoCommit 本轮为关闭状态。
