# 超长聊天历史导致 Node 主进程 OOM（2026-11-13）

> 本文是交接给「根源修复」会话的问题清单与触发路径。所有 `file:line` 锚点
> 均在 2026-11-13 于 main 核验过。止血已完成（归档大历史），**根因未修**。

## 一句话结论

聊天历史的内存护栏**按消息条数计、不按字节计**，而 assistant 消息会把每次
工具调用的完整输出原样存进 `tools` 字段且无任何体积上限。两者相乘，让
工具密集的长期任务（每小时触发的巡检类 cron）必然把单会话历史推到百 MB
级；读取侧又是整份读入并解析成对象图，于是撞破 Node 默认 ~2GB 堆。

## 问题清单

### P0-1 限额按条数算，不按字节算

常量链（三处同为 10000，含义都是「条」）：

| 位置 | 内容 |
|---|---|
| `server.js:2232` | `const CHAT_HISTORY_SOFT_CAP = 10000;` |
| `server.js:2252` | `retentionPolicy` —— 全仓**唯一**一处非 null 实现 |
| `src/session/chat-history-service.js:43` | `maxMessages = 10000` |
| `native/addon/src/chat_history_runtime.rs:26` | `DEFAULT_HISTORY_LIMIT: f64 = 10000.0` |

`retentionPolicy` 只给 `__aux__` 特殊待遇（`src/routes/aux-goal.js:7`
`AUX_HISTORY_MAX = 200`），其余所有会话一律 10000 条。

**反证（重要）**：`__aux__` 限额已收紧到 200 条（比别人严格 50 倍），实测
仍涨到 **186MB**，平均每条 930KB。**收紧条数不解决问题**——限额量的是
「几条」，失控的是「每条多大」。

### P0-2 `tools` 字段落盘无体积上限

事故会话最大单条 564KB 的构成：

```
tools         403 KB   ← 工具调用完整输入+输出
contextTrace  147 KB
timeline        9 KB
content         5 KB   ← 界面上唯一可见的正文
```

比例约 80:1。两个渲染端本来都只显示工具结果的前 2000 字符，也就是说
存下来的绝大部分字节**没有任何消费者**。

**裁剪能力早就存在，只是从未接到落盘路径**：
- `src/chat/history-frame-budget.js:43` `clipMessageTools(message, maxChars)`
- `src/chat/history-frame-budget.js:21` `DEFAULT_TOOL_STRING_CHARS = 16 * 1024`
- 唯一调用方 `src/chat/turn-engine.js:2728`，作用于 **WS 连接重放的副本**
  （模块头注释明确写了「The persisted transcript is never touched」）

落盘侧目前唯一的裁剪是 `chat_history_runtime.rs:174` 的 `bgToolUseIds`，
与 `tools` 无关。

### P1 读取侧整份读入 + 连续多次复制

`native/addon/src/chat_history_repository.rs`：

```
:1047  fn read_text()
:1053    file.read_to_end(&mut bytes)                  ← 整个文件进内存
:1055    String::from_utf8_lossy(&bytes).into_owned()  ← 再复制一份
:1221  fn read_strict() → :108 parse_transcript()      ← 整份解析成对象数组
```

再加上转 JS 字符串时 UTF-8 → UTF-16 体积翻倍。实测 **135MB 文件 =
434MB 堆对象（3.2 倍）**，峰值接近 1GB。

### P2 分页省的是传输，不是内存

`CHAT_HISTORY_PAGE = 5`（`server.js:2233`）看着很小，但分页是在**已经
全量读进内存的数组**上切片（`chat_history_runtime.rs:2046-2049`）：先把
整份读完解析完，再取 5 条。一个字节的内存都没省。

### P3 崩溃无痕迹，轮次静默丢失

Node FATAL OOM 瞬间来不及写任何错误消息；Rust 网关 2 秒内 respawn，
服务始终「活着」（网页能开、状态绿），但正在跑的那一轮被连带杀掉。
用户侧表现为：**有指令、无回复、也无错误**。事故期间 39 次 OOM，
对应任务 `runState=error` 却查不到任何原因。这类静默失败需要一个
「进程重启导致轮次中断」的显式落账。

## Bug 触发路径

```
1. 每小时触发的 cron 任务，每轮跑若干工具调用（python/CDP/文件读写）
        ↓
2. 每次工具调用的完整输出原样写进该轮 assistant 消息的 tools 字段
   → assistant 平均 154KB/条（普通会话 3KB，50 倍）
        ↓
3. 追加到同一个会话，951 轮累积：882 条 assistant = 132MB
   （user 955 条仅 2MB，占比 1.5%）
        ↓
4. 条数护栏完全不触发：1953 / 10000 = 19.5%，系统视为「健康」
        ↓
5. 下一轮启动要读历史 → read_to_end 整份读 → 多次复制 → 解析成对象图
   → 135MB 文件 = 434MB 堆
        ↓
6. 叠加 403 张任务卡的 air 快照重建，20 秒内 heap 576MB → 1787MB
        ↓
7. 触顶 2036MB（Node 默认 ~2096MB old-space）→ FATAL OOM，无错误消息
        ↓
8. Rust 网关 respawn，正在跑的轮次被杀 → runState=error、无回复无报错
        ↓
9. 下一小时重复 —— 事故期间 39 次
```

## 已修 / 未修

| 环节 | 状态 | 锚点 |
|---|---|---|
| 写入侧增量追加（只写尾巴，不重写整份） | ✅ 已修 | `chat_history_repository.rs:624` `keep_bytes`、`:711` `replace_tail_cow` |
| 限额按字节计 | ❌ 未修 | 见 P0-1 |
| `tools` 落盘体积上限 | ❌ 未修 | 见 P0-2 |
| 读取侧避免整份读 | ❌ 未修 | 见 P1 |
| OOM 重启导致轮次中断的显式落账 | ❌ 未修 | 见 P3 |

注意：写入侧那条修复解决的是磁盘 IO，与内存无关，**挡不住本 OOM**。

## 修复建议

**方向 A（最对症，建议先做）**：给 `tools`（及 `contextTrace`）在**落盘前**
设体积上限，复用已有的 `clipMessageTools` 语义。切入点在 Rust 落盘路径：
`chat_history_runtime.rs:290 chat_history_public_committed_message` /
`:298 chat_history_build_replay_messages`。注意区分「持久化副本」与
「重放副本」，现有注释承诺了持久化副本不被改写，改语义要同步更新注释与
`src/chat/history-frame-budget.js` 的模块头说明。

**方向 B**：限额改成字节维度，或条数/字节双闸取先到者。改 `retentionPolicy`
契约时注意它目前是 `sessionId => number`，加字节维度等于改签名，
`server.js:2252` 与 `chat-history-service.js` 的校验都要跟。

**方向 C（可选）**：读取侧按尾部增量读，避免整份 `read_to_end`。收益最大但
改动面也最大，建议在 A 之后单独评估。

### 约束

- **Node 已冻结，新补丁只进 Rust**（2026-11-06 定调）。上述落盘路径本就在
  Rust，符合该约定；`src/chat/history-frame-budget.js` 仅作为语义参考，
  不要在 Node 侧新增落盘逻辑。
- 历史文件是 **JSONL**（每行一条）但扩展名为 `.json`。
- 改动放大倍数后**必须更新门禁棘轮**，见下节。

## 已有门禁测试（勿重复造）

`tests/test-chat-history-oversize-session.js`（core / deterministic，
owner `npm:test:architecture`，已在 main）已钉住三条不变量：

1. 整份读 15MB 工具密集历史必须留在有界堆内
2. 超长会话只服务一页，落盘文件分毫不动
3. 真会话构造的重放帧必须压在 WS 单帧上限内

子进程探针：`tests/helpers/oversize-history-probe.js`。

**它守的是「不许更糟」，不是「已经修好」**——故意没有断言字节限额，
否则核心门禁会挂一条必红的测试（一红则永不创建 Release）。

修复后请注意：
- 放大倍数若下降，把测试里 `heapUsedMB <= fileMB * 6` 的棘轮**往下收**，
  否则护栏会松掉。基线实测 3.2 倍，闸门取 6 倍。
- 若实现了字节限额，第 2 个测试里
  `load(...) === 80` 那条「当前语义」断言需要改写。
- 合成样本的填充必须混中文：纯 ASCII 会被 V8 存成单字节串，
  量不出 UTF-8 → UTF-16 翻倍。

## 实测数据附录

事故会话 `task-216a6bdb10a24ab41599fb9cd7ca5bf2`（已归档）：

| 角色 | 条数 | 体积 | 平均 |
|---|---|---|---|
| user | 955 | 2 MB | 3 KB |
| **assistant** | **882** | **132 MB** | **154 KB** |
| system | 116 | 0 MB | 1 KB |

- 全部 1953 条 / 135 MB，**中位数仅 3 KB**（不是普遍偏大，是少数极大）
- 135 MB 文件 → 434 MB 堆对象（3.2 倍），峰值近 1 GB
- 条数占限额 19.5%
- `__aux__`：限额 200 条，实测 186 MB，平均 930 KB/条
- 生产堆曲线：触发后 20 秒 576 MB → 1787 MB → 触顶 2036 MB
- 止血后同机 heap 稳定在 282~458 MB，新日志 0 次 OOM
