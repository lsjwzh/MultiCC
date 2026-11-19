# turn-engine 拆解：第一刀与可验证基线（2026-11-19）

`/ws/chat` 的升级终结不能迁，是因为连接语义仍由 Node 的回合引擎持有。本文件
记录实测后的真实边界，以及本批落下的第一刀。

## 实测：很多回合逻辑已经在 Rust

`src/chat/turn-engine.js` 2,998 行，但它不是一整块状态机。已有 Rust 所有者：
`chat_turn_lifecycle`（21 个入口）、`chat_turn_effects`（7）、`chat_events`（6）、
`chat_finalize`（7）、`chat_runtime`、`active_turns`、`turn_progress`、
`chat_context_rotation`、`chat_ws_control`。turn-engine 里对应的部分已经是
「收集事实 → 调 Rust → 发事件」。

因此阻塞 `/ws/chat` 的不是「回合状态机」整体，而是**连接语义**：
`cs.clients`（socket 集合）、`cs.streamReplay`（上限 500 的重放缓冲）、
`cs.isStreaming`，以及连接时按什么顺序把它们发给客户端。

## 调度所有权：已完成（本批复核）

迁移清单此前写着调度四入口「门禁仍未通过」，实测已过期。准入
`schedule_admit_live`、完成 `schedule_settle_live`、重排
`schedule_admit_live::reorder`、恢复 `schedule_lifecycle_live` 的决策与事务
都在 Rust；`src/orchestration/native-store-host.js` 只剩串行化队列、JSON 编组
与时钟端口，按原守卫顺序调用。164 项调度测试 0 失败（清单已据实订正）。

## 本批第一刀：连接重放顺序

`native/core/src/chat_connect_replay.rs`：把连接时「发什么、按什么顺序发、
缓冲留成什么样」提成纯内核。两条规则是易错点，也是这刀的意义：

- 页内已含进行中的 assistant 消息时，必须**清空会话缓冲**（`cs.streamReplay = []`）
  而不是「跳过这次发送」。两者客户端可见帧相同，但后者给会话留下陈旧缓冲。
- 重放是最多 500 帧的同步突发，必须走 `sendImmediate` 绕过队列的**条数**上限，
  否则 `queue_overflow` → 1013 → 客户端重连 → 再灌 → 无限重连（长流式回合踩过）。
  字节上限与拥塞计时仍然生效。

差分基线：冻结实现 `tests/helpers/legacy-chat-connect-replay.js`（SHA-256
`9cb7d2f45c863ba9a85ca24ab3cfb242787e931da9a49ac249cfb9363bb83720`）按语句逐条
转写自 turn-engine 的连接块；
`docs/rust-migration/differential/chat-connect-replay-oracle.js` 用它**穷举**
事实空间生成 144 例语料，Rust 侧逐例比对步骤序列与收尾缓冲长度。

变异 `chat-connect-replay-mutations.py`：基线通过 + 5 个变异全部必红（清空空缓冲、
跳过而不清空、重放已结束回合的缓冲、要求有消息才发历史帧、种子与历史帧换序）。

### 一处不声称的覆盖

`replay_messages > 0 && last_message_is_assistant` 里的前半个合取项在类型不变量
下不可达：`last_message_is_assistant` 只有在存在最后一条消息时才为真。内核保留
该合取项以与冻结实现控制流一致，但语料**无法**表达那个非法组合，所以变异集不把
它算作已覆盖——这一点写在内核注释与变异脚本里，不以假覆盖充数。

## 还差什么（下一刀的前置件）

本批只迁了连接时的**顺序决策**，turn-engine 仍然持有：socket 集合本身、
缓冲的写入侧（`forward()` 里的 push 与 500 上限裁剪）、取消/重试/后台任务/
完成/恢复的效果编排，以及 `/ws/chat` 的升级握手。要让前门终结 `/ws/chat`，
下一刀应是缓冲写入侧与 `cs.clients` 的所有权，并且需要先采集真实事件样本
（取消、重试、后台任务完成、崩溃恢复各自的事件序列）作为差分基线——本批
没有采集这些样本，不能据此声称回合引擎已可迁移。
