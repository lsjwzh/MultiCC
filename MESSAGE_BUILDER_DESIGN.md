# 统一消息构建模块设计（Message Builder）

> 现状：主流程 promptText 内联拼装(server.js:9005-9045) + 4 CLI 各自 buildChatSpawnArgs + streaming 裸 userMessageLine(chat-stream.js:46-51) + codex 代理转码，4 个散点；rolePrompt 不一致、streaming 绕过工厂。
> 目标：主流程 `composeMessage()` 产出归一化 `MessageEnvelope` + 各 CLI `shape(envelope)` 工厂收敛。
> 来源：ultracode judge-panel workflow（4 设计 → 3 评审 → 综合，2026-07-12）。

# 最终统一消息构建模块设计

## 一、裁决：获胜方案与嫁接

### 获胜方案：A1（模板方法 + 归一化 Envelope）

**聚合排名**（3 份评审 ordinal 汇总）：
- A1：评审1 排名#1、评审2 排名#2、评审3 排名#1 → **第一**
- A2：评审1 #2、评审2 #1、评审3 #3 → 第二
- A4：评审1 #4、评审2 #3、评审3 #2 → 第三
- A3：评审1 #3、评审2 #4、评审3 #4 → 第四（三份评审一致垫底或倒数第二）

**选 A1 的理由**：它是唯一同时满足全部 4 个设计目标的方案——(1) `composeMessage` 收敛主流程内联拼装；(2) `shape(envelope)` 收敛 4 个 CLI 工厂；(3) `claude.shape(mode='streaming')` 让 streaming 走同一工厂；(4) `rolePrompt` 双字段（`systemPrompt` + `rolePrompt`）统一 source of truth。且结构最克制：只新增 1 个文件 `src/message-composer.js`，不建目录树（对比 A3 的 8+ 文件）。

**为何不选 A2 作终点**：A2 迁移成本最低（评审2 给 fit=10/migration=9），但明确只覆盖 2/4 组装点——streaming 的 `chat-stream.js:55-71` `spawnProc` 仍手搓 args、`codex/opencode/zcode` 仍把 `rolePrompt` 塞 text。两份评审指出它是好的 phase-1 踏石但作为终点不完整。A2 的技术手段作为嫁接保留。

**为何不选 A3**：过度抽象（三份评审一致指出）。layer registry + register/unregister + order + placement + 7+ 文件对 6 注入点 + 4 CLI 的规模偏重，YAGNI。

**为何不选 A4**：两处已核实的 correctness 硬伤——(1) `contextLayers` push 顺序反了（应为 `goal>dispatch>notes`，A4 写成 `notes>dispatch>goal`）；(2) `assemblePayload` 用 `join('\n\n')` 在层间加分隔符，但今日各层自带尾部分隔符直接拼接（已核实 `buildDispatchContextPrompt` 尾部是单 `\n`，`join('\n\n')` 会多一个 `\n`）。其 `validateEnvelope` 和 history-handle 模块作为嫁接保留。

### 嫁接清单

| 来源 | 嫁接内容 | 解决的问题 |
|------|---------|-----------|
| A2 | `composeSysPrompt(rolePrompt)` 闭包作 do-it-first 零风险首步 | 迁移前先用 1 行闭包消除 `claude.js:31-33` 与 `server.js:9745` 的 sysPrompt 重复 |
| A2 | 机械抽取 `composePromptText` 作零行为变化安全网 | 引入 envelope 前先逐行搬进函数跑 diff=0，降低热路径首改风险 |
| A2 | `ultracode --settings` streaming drift 显式修复（已核实真 bug） | `server.js:9768-9773` 缺 `--settings`，无论结构方案都应先修 |
| A3 | golden byte-for-byte 等价测试前置门控 | 任何 call-site 改动前先锁死 `renderPrompt(envelope)===今日promptText` |
| A3 | `contextLayers` 加显式 `order` 排序键 | 防止数组顺序被误改导致字节差异，golden 测试可断言 order 值 |
| A3 | envelope 暴露独立 `imgHint` 字段（修 A1 codex 缺口） | `codex.js:19` 需独立 `multiccImgHint` 块，A1 合并的 `systemPrompt` 无法重建 |
| A4 | `validateEnvelope()` 运行时不变量检查 | dev 抛错 prod warn，早捕获 `userText` 空 / kind 重复 / `ultracode` 无 suffix |
| A4 | `_streamStarted` 持久化 + `resolveStartedState`（直击根因） | 比 A1 的 `_streamHasHistory` 间接校正更直接，修 `chat-stream.js:261` 重启丢历史 |
| A4 | already-in-use 改 `--resume` 优先 + **重试计数器**（A4 自认遗漏） | 修 `chat-stream.js:175-187` 丢历史，但必须带 max-3 计数器防死循环 |
| A4 | `shape` 返回一致的 `{args, payload}`（修 A1 条件返回） | A1 的 `{args, promptText?}` 条件返回增加心智负担，统一为始终有 payload |

### 评审分歧裁决

**分歧 1：shape 返回 `{args, promptText?}`（A1 条件返回）vs `{args, payload}`（A4 一致返回）**
评审3 指出 A1 条件返回是 clarity 弱点。**裁决：采用 A4 的 `{args, payload}` 一致返回**。`args` = 所有 CLI flag（mode 决定是否含 session 句柄），`payload` = `renderPrompt(envelope)`（始终有值）。per-turn 调用方 `spawnChat([...args, payload])`；streaming 调用方 `ensure({spawnArgs: args}) + send(payload)`。bridge wrapper `buildChatSpawnArgs` 内部 `[...shape.args, shape.payload]` 拼回单数组保持旧签名。

**分歧 2：gateway 处理——A1 的 `buildGatewayPrompt('')` vs A4 的 `lastIndexOf` 拆分**
已核实 A1 的方法字节正确（`buildGatewayPrompt('')` 返回 system block 尾部自带 `\n\n`，直接拼接下一层即还原 wrap 结构）。A4 的 `lastIndexOf(userText)` 在 userText 于 instructions 中重复时拆错位。**裁决：采用 A1 的 `buildGatewayPrompt('')`**。

**分歧 3：notes 副作用位置——A1 在 `composeMessage` 内 vs A3 拆到调用方**
A3 拆分切断今日同处完成的逻辑（拼 text 同时 mark delivered+broadcast），后人加层易误把副作用写进 layer。**裁决：副作用留在 `composeMessage` 内**（与今日 `server.js:9014-9023` 内联一致），`composeMessage` 非纯函数，JSDoc 显式标注 SIDE EFFECTS。golden 测试只验证 text 输出，副作用由集成测试覆盖。

**分歧 4：history-loss——A1 的 `_streamHasHistory`（间接校正 isFirstTurn）vs A4 的 `_streamStarted`（直接持久化 started）**
`chat-stream.js:57-59` 的 `--session-id`/`--resume` 决策由 `s.started` 驱动，A4 直接持久化 `started` 直击根因。**裁决：采用 A4 的 `_streamStarted`**，但列为可选 phase-4（独立于消息构建核心）。

**分歧 5：streaming stdin 是否需要 factory-owned `buildStdinLine`（A4）vs 保留 `userMessageLine`（A1/A2）**
已核实：streaming 的 stdin 内容**早已是富文本**（`runChatTurn` 在 9056 把含 notes/dispatch/goal/ultracode 的 `promptText` 透传给 `runChatTurnStreaming` → `chatStream.send`）。"裸 user 行"批评实际针对的是 **spawn 配置**（sysPrompt 手算、args 手搓），而非 stdin 内容。`userMessageLine` 是 stream-json 协议包装器（JSON 行格式），不是内容组装器。**裁决：保留 `userMessageLine` 作协议包装器**，factory 通过 `payload`（`renderPrompt` 产物）own 内容。`buildStdinLine` 是 YAGNI（streaming 仅 claude），若未来支持其他 CLI streaming 再加。

---

## 二、模块文件布局

```
新增（1 个文件，不建目录）：
  src/message-composer.js
    - composeMessage({text, persisted, sessionName, opts, deps}) -> MessageEnvelope
    - renderPrompt(envelope) -> string          // contextLayers.join('') + userText + suffix
    - validateEnvelope(envelope) -> void|throw  // 运行时不变量（嫁接自 A4）
    - MessageEnvelope / ContextLayer / HistoryHandle JSDoc typedef

修改（增量，不新建目录）：
  src/cli-adapters/claude.js    + shape(envelope)；buildChatSpawnArgs 降级为 thin wrapper
  src/cli-adapters/codex.js     + shape(envelope)；buildChatSpawnArgs 降级为 wrapper
  src/cli-adapters/opencode.js  + shape(envelope)；buildChatSpawnArgs 降级为 wrapper
  src/cli-adapters/zcode.js     + shape(envelope)；buildChatSpawnArgs 降级为 wrapper
  src/chat-stream.js            ensure 接受 spawnArgs（向后兼容回退）；spawnProc 用 s.spawnArgs
  server.js                     runChatTurn(9005-9062) + runChatTurnStreaming(9744-9806) 改调 composeMessage+shape

不改：
  src/cli-adapters/index.js / core.js   registry 透传 shape（与 buildChatSpawnArgs 并存，签名不变）
  codex-proxy-transform.js              CLI->上游 wire 协议转码，方向相反，不纳入
```

`message-composer.js` 只依赖传入的 `deps` 参数，不 `require server.js`，无循环引用，可独立单测。

---

## 三、MessageEnvelope 数据模型

```js
/**
 * @typedef {Object} ContextLayer
 * @property {'cross-agent-notes'|'gateway'|'dispatch-context'|'goal-limit'} kind
 * @property {number} order   // 10=goal-limit, 20=gateway/dispatch, 30=notes。显式排序键（嫁接自 A3）
 * @property {string} text    // 含尾部分隔符的完整块，concat 即用，无额外分隔符
 *
 * @typedef {Object} HistoryHandle
 * @property {boolean} isFirstTurn   // true->--session-id, false->--resume（per-turn 用）
 * @property {string|null} cliSessionId
 *
 * @typedef {Object} SpawnOpts
 * @property {'per-turn'|'streaming'} mode
 * @property {string|null} model          // resolveSessionWireModel 结果（已解析）
 * @property {string|null} effort         // cliEffortLevel(persisted)
 * @property {number} maxTurns            // goalLimits.maxRounds || 0
 * @property {boolean} ultracode          // normalizeEffort(persisted.effort)==='ultracode'
 * @property {string[]} disallowedTools   // claude 专用
 * @property {string|undefined} providerModel
 * @property {string[]|undefined} providerModels
 * @property {boolean|undefined} skipDefaultModel
 *
 * @typedef {Object} MessageEnvelope
 * @property {string} imgHint             // = MULTICC_IMG_HINT（独立字段，codex shape 用。嫁接自 A3）
 * @property {string|null} rolePrompt     // = resolveRolePrompt(persisted)，codex/opencode/zcode shape 用
 * @property {string} systemPrompt        // = rolePrompt ? imgHint+'\n\n'+rolePrompt : imgHint（claude shape 用，派生字段）
 * @property {ContextLayer[]} contextLayers  // 有序前缀层
 * @property {string} userText            // 原始用户消息
 * @property {string} suffix              // ultracode 触发词，或 ''
 * @property {HistoryHandle} historyHandle
 * @property {SpawnOpts} spawnOpts
 */
```

**不变量（`validateEnvelope` 检查，dev 抛错 / prod `console.warn`）：**
1. `userText` 非空字符串
2. `contextLayers` 每项 `text` 非空、`kind` 不重复
3. `contextLayers` 按 `order` 升序排列
4. `ultracode===true` 时 `suffix` 非空
5. `systemPrompt === (rolePrompt ? imgHint+'\n\n'+rolePrompt : imgHint)`（派生一致性）

**contextLayers 拼接顺序**（复刻今日 prepend 链，`renderPrompt` = `layers.sort(order).map(l=>l.text).join('') + userText + suffix`，逐字节等价已核实）：

| order | kind | 来源函数 | 尾部分隔符（已核实） |
|-------|------|---------|-------------------|
| 10 | goal-limit | `buildGoalLimitNote` (server.js:5688) | `\n\n` |
| 20 | gateway | `buildGatewayPrompt('')` (server.js:1220) | `\n\n` |
| 20 | dispatch-context | `buildDispatchContextPrompt` (server.js:1141) | `\n` |
| 30 | cross-agent-notes | 内联构造 (server.js:9008-9011) | `\n\n` |

gateway 与 dispatch 互斥（由 `persisted.type` 决定），不会同时出现。

---

## 四、composeMessage() 签名与行为

```js
/**
 * 模板方法：从所有来源组装 MessageEnvelope。替换 runChatTurn 内联拼装 (server.js:9005-9047)。
 *
 * SIDE EFFECTS: 有跨 agent 留言时标记 delivered + 3 路 broadcast（与 server.js:9014-9023 一致，非幂等）。
 *
 * @param {Object} input
 * @param {string} input.text                     - 原始用户消息
 * @param {Object} input.persisted                - persistedSessions.get(name)
 * @param {string} input.sessionName
 * @param {Object} input.opts
 * @param {boolean} input.opts.isFirstTurn
 * @param {Object|undefined} input.opts.goalLimits  - { maxRounds, maxBudget }
 * @param {'per-turn'|'streaming'} [input.opts.mode='per-turn']
 * @param {boolean} [input.opts.bare=false]         - true: 跳过 contextLayers+suffix（continue/retry 路径）
 * @param {string|undefined} input.opts.resolvedModel
 * @param {string|undefined} input.opts.providerModel
 * @param {string[]|undefined} input.opts.providerModels
 * @param {boolean|undefined} input.opts.skipDefaultModel
 * @param {string[]} [input.opts.disallowedTools=[]]
 * @param {Object} input.deps  - 注入依赖（见下）
 * @returns {MessageEnvelope}
 */
function composeMessage({ text, persisted, sessionName, opts, deps }) { ... }
```

**deps（注入，避免循环引用，12 项）**：
```js
deps = {
  resolveRolePrompt,            // (persisted) -> string|null
  multiccImgHint,               // = MULTICC_IMG_HINT
  buildGatewayPrompt,           // (userText) -> string
  buildDispatchContextPrompt,   // (sessionName) -> string
  buildGoalLimitNote,           // (limits) -> string
  pendingNotesFor,              // (sessionName) -> Note[]
  saveNotes,                    // () -> void
  appendEvent,                  // (dirId, type, msg, sessionId) -> void
  workspaceBroadcast,           // (dirId, evt) -> void
  chatBroadcast,                // (sessionName, evt) -> void
  normalizeEffort,              // (effort) -> string
  cliEffortLevel,               // (persisted) -> string|null
}
```

**行为**（与今日 `server.js:9005-9045` 逐行对应）：
1. 解析 `rolePrompt = deps.resolveRolePrompt(persisted)`（唯一计算点，原 9047）
2. 计算 `systemPrompt` / `imgHint` / `rolePrompt` 三字段
3. `bare=false` 时按 order 构造 `contextLayers`：goal(10) → gateway/dispatch(20) → notes(30)。notes 层构造时同步执行 mark-delivered + broadcast 副作用（原 9014-9023）
4. 构造 `suffix`：`!bare && persisted.type!=='aux' && normalizeEffort==='ultracode'` 时为触发词，否则 `''`
5. 构造 `historyHandle`：`{ isFirstTurn: opts.isFirstTurn, cliSessionId: persisted.cliSessionId || null }`
6. 构造 `spawnOpts`：model/effort/maxTurns/ultracode/disallowedTools/provider*
7. `validateEnvelope(envelope)`，返回

---

## 五、每 CLI 工厂 shape(envelope) 契约

每个 adapter 新增 `shape(envelope) -> { args: string[], payload: string }`。

**shape 职责（纯函数，无副作用，闭包持有 adapter deps）**：
1. `args`：CLI flags（mode 决定是否含 session 句柄；streaming 额外加 `--input-format stream-json`，不含 session 句柄、不含 prompt）
2. `payload`：完整 prompt 文本。若该 CLI 首轮需内联系统提示（codex/opencode/zcode），shape 在 `renderPrompt(envelope)` 前拼接 systemBlock；claude 的系统提示走 flag 不进 payload

### claude.shape（claude.js）

```js
shape(envelope) {
  const so = envelope.spawnOpts;
  const args = [
    '-p',
    ...(so.mode === 'streaming'
      ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
      : ['--output-format', 'stream-json']),
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
    '--append-system-prompt', envelope.systemPrompt,   // ← 唯一系统提示来源（消除 claude.js:31-33 + server.js:9745 重复）
  ];
  if (so.model) args.push('--model', so.model);
  if (so.effort) args.push('--effort', so.effort);
  if (so.ultracode) args.push('--settings', '{"ultracode":true}');  // ← 修 streaming drift（server.js:9768-9773 原缺此行）
  if (so.disallowedTools.length) args.push('--disallowedTools', so.disallowedTools.join(','));
  if (so.maxTurns > 0) args.push('--max-turns', String(so.maxTurns));
  if (so.mode === 'per-turn') {
    // streaming: 不放 session 句柄（chat-stream spawnProc 追加）
    args.push(envelope.historyHandle.isFirstTurn ? '--session-id' : '--resume', envelope.historyHandle.cliSessionId);
  }
  const payload = renderPrompt(envelope);   // systemPrompt 不进 payload（走 flag）
  debugLogClaudeInvoke({ cliSessionId: envelope.historyHandle.cliSessionId }, [...args, payload]);
  return { args, payload };
}
```

### codex.shape（codex.js）

```js
shape(envelope) {
  const so = envelope.spawnOpts;
  const args = ['exec'];
  for (const a of configArgsFor({ effort: so.effort, model: so.model })) args.push('-c', a);
  if (!envelope.historyHandle.isFirstTurn) args.push('resume', envelope.historyHandle.cliSessionId);
  args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');

  // 首轮内联 systemBlock（重建 codex.js:19-24 的分块结构）
  let payload = renderPrompt(envelope);   // contextLayers + userText + suffix
  if (envelope.historyHandle.isFirstTurn) {
    const prefixes = [envelope.imgHint];                  // ← 独立 imgHint（嫁接自 A3，修 A1 缺口）
    if (envConstraint) prefixes.push(envConstraint);
    if (envelope.rolePrompt) prefixes.push(`[角色设定]\n${envelope.rolePrompt}\n[角色设定结束]`);
    payload = prefixes.join('\n\n') + '\n\n' + payload;
  }
  if (stayAlivePrompt) payload += `\n${stayAlivePrompt}`;
  return { args, payload };
}
```

### opencode.shape / zcode.shape（opencode.js / zcode.js）

```js
shape(envelope) {
  const args = ['run', '--format', 'json', '--auto'];
  if (envelope.spawnOpts.model) args.push('--model', envelope.spawnOpts.model);
  if (!envelope.historyHandle.isFirstTurn) {
    if (envelope.historyHandle.cliSessionId) args.push('--session', envelope.historyHandle.cliSessionId);
    else args.push('--continue');
  }
  let payload = renderPrompt(envelope);
  if (envelope.historyHandle.isFirstTurn && envelope.rolePrompt) {
    payload = `[角色设定]\n${envelope.rolePrompt}\n[角色设定结束]\n\n${payload}`;
    // 注意：不内联 imgHint（保持今日 opencode/zcode 不含 imgHint 的行为，避免行为变更）
  }
  return { args, payload };
}
```

### buildChatSpawnArgs 降级为 bridge wrapper（迁移期安全网）

```js
buildChatSpawnArgs(session, prompt, opts) {
  const envelope = envelopeFromLegacy(session, prompt, opts);  // 构造最小 envelope
  const { args, payload } = this.shape(envelope);
  return [...args, payload];   // 拼回单数组，保持旧签名
}
```

---

## 六、streaming 路径接入同一工厂

**当前问题（已核实）**：
- `server.js:9745` 手算 `sysPrompt`（与 `claude.js:31-33` 重复）
- `server.js:9768-9773` 手搓 `extraArgs`（缺 `ultracode --settings`，真 bug）
- `chat-stream.js:55-71` `spawnProc` 手搓完整 args 数组（与工厂平行实现）
- stdin 内容（`payload`）已是富文本（`promptText` 透传），**非裸 user 行**——问题在 spawn 配置不在 stdin

**改造后**（`runChatTurnStreaming` 签名改为收 `envelope`）：

```js
function runChatTurnStreaming(sessionName, cs, persisted, envelope) {  // 收 envelope 而非 promptText+rolePrompt
  const { env: childEnv } = providers.buildChildEnv(process.env, persisted, { /* 不变 */ });
  providers.applyClaudeProxyEnv(childEnv, { /* 不变 */ });

  if (!persisted._streamSessionId) {
    persisted._streamSessionId = crypto.randomUUID();
    savePersistedSessions();
  }

  const { args, payload } = cliProviders.claude.shape(envelope);
  // args 含 --append-system-prompt(envelope.systemPrompt)、--model、--effort、--settings(ultracode)、
  //       --disallowedTools、--input-format stream-json；不含 session 句柄、不含 prompt
  // payload = renderPrompt(envelope) = contextLayers + userText + suffix（stdin 内容）

  chatStream.ensure(sessionName, {
    cmd: cliProviders.claude.cmd,
    cwd: cs.cwd,
    sessionId: persisted._streamSessionId,
    spawnArgs: args,           // ← 新：预构建 spawn 参数（替代 model/sysPrompt/extraArgs 三字段）
    env: childEnv,
    onBackgroundEvent: (evt) => handleBackgroundTaskEvent(sessionName, cs, evt),
  });

  const mySeq = cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1;
  const forward = (evt) => { /* 不变 */ };

  chatStream.send(sessionName, payload, (evt) => {   // payload 经 userMessageLine 包成 JSON 行写 stdin
    if (evt.type === 'system' && evt.subtype === 'init') { noteReportedModel(sessionName, evt.model); return; }
    applyClaudeChatEvent(cs, sessionName, evt, forward);
  })
    .then(() => finalizeStreamingTurn(sessionName, cs, persisted, mySeq))
    .catch((err) => {
      console.warn(`[multicc/chat] [${sessionName}] (streaming) turn ended early: ${err.message}`);
      finalizeStreamingTurn(sessionName, cs, persisted, mySeq);
    });
  return true;
}
```

**chat-stream.js 改动（最小化，向后兼容）**：

```js
// ensure() (chat-stream.js:247) — 新增 spawnArgs 字段
function ensure(name, cfg) {
  let s = sessions.get(name);
  if (!s) {
    s = {
      cmd: cfg.cmd, cwd: cfg.cwd, sessionId: cfg.sessionId,
      spawnArgs: cfg.spawnArgs || null,   // ← 新：shape 产物（优先于 model/sysPrompt/extraArgs）
      model: cfg.model || null, sysPrompt: cfg.sysPrompt || null,  // 保留作回退（test-chat-stream.js 兼容）
      extraArgs: cfg.extraArgs || [], env: cfg.env || {},
      idleMs: cfg.idleMs || DEFAULT_IDLE_MS,
      onExit: cfg.onExit || null, onBackgroundEvent: cfg.onBackgroundEvent || null,
      onTurnComplete: cfg.onTurnComplete || null,   // ← phase-4 history-loss 用
      proc: null, started: cfg.started || false,    // ← phase-4 持久化 started 恢复
      busy: false, queue: [], current: null, lineBuf: '', stderrTail: '', idleTimer: null,
    };
    sessions.set(name, s);
  } else {
    // 允许 per-turn override（model/sysPrompt/spawnArgs 可能变）
    if (cfg.spawnArgs !== undefined) s.spawnArgs = cfg.spawnArgs;   // ← 新（修原 else 分支不更新 extraArgs 的隐患）
    if (cfg.model !== undefined) s.model = cfg.model;
    if (cfg.sysPrompt !== undefined) s.sysPrompt = cfg.sysPrompt;
    if (cfg.env !== undefined) s.env = cfg.env;
    if (cfg.onBackgroundEvent !== undefined) s.onBackgroundEvent = cfg.onBackgroundEvent;
  }
  return s;
}

// spawnProc() (chat-stream.js:55) — 优先用 s.spawnArgs，回退原拼装
function spawnProc(name) {
  const s = sessions.get(name);
  const sessionArgs = s.started ? ['--resume', s.sessionId] : ['--session-id', s.sessionId];
  let args;
  if (s.spawnArgs) {
    args = [...s.spawnArgs, ...sessionArgs];   // shape 产物 + session 句柄
  } else {
    // 回退：原内联拼装（test-chat-stream.js 旧路径兼容）
    args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
      ...(s.model ? ['--model', s.model] : []),
      ...(s.sysPrompt ? ['--append-system-prompt', s.sysPrompt] : []),
      ...(s.extraArgs || []), ...sessionArgs];
  }
  // ... spawn(s.cmd, args, ...) 不变 ...
}
```

`send` / `pump` / `userMessageLine` / `inject` / `onExit` / `finishTurn` **不变**（`payload` 已是富文本，`userMessageLine` 作协议包装器保留）。

**效果**：streaming 的 sysPrompt 来自 `envelope.systemPrompt`（`composeMessage` 唯一计算），spawn args 来自 `shape`（含 `ultracode --settings`，修 drift），`spawnProc` 不再手搓。stdin 内容（`payload`）来自 `renderPrompt(envelope)`，与 per-turn 同源。

---

## 七、rolePrompt 不一致如何统一

**根因**：`rolePrompt` 的来源（`resolveRolePrompt`）和 `systemPrompt` 公式分散在 `claude.js:31-33` + `server.js:9745` 两处手算；投递方式因 CLI 而异（claude 走 `--append-system-prompt`，codex/opencode/zcode 内联 text），无统一契约。

**统一方案**：
1. `composeMessage` 是 `systemPrompt` / `imgHint` / `rolePrompt` 的**唯一计算点**。三字段关系：`systemPrompt = rolePrompt ? imgHint+'\n\n'+rolePrompt : imgHint`，由 `validateEnvelope` 校验。
2. 各 `shape` 按 CLI 能力取用（**只决定编码，不决定内容**）：
   - **claude**：`args.push('--append-system-prompt', envelope.systemPrompt)`（系统提示原生支持，每轮都带因 `--resume` 不保留上轮 append）
   - **codex**：首轮用 `envelope.imgHint`（独立块）+ `envConstraint` + `envelope.rolePrompt`（`[角色设定]` 包裹）`.join('\n\n')` 内联到 `payload` 前缀；续轮不内联（resume 带上下文）
   - **opencode/zcode**：首轮仅用 `envelope.rolePrompt`（`[角色设定]` 包裹）内联到 `payload` 前缀；**不用 `imgHint`**（保持今日行为，避免行为变更）
3. `[角色设定]` 包裹保留在 codex/opencode/zcode 的 `shape` 内（CLI 特定编码，非通用语义）

**消除的重复**：`claude.js:31-33` 和 `server.js:9745` 的 `${multiccImgHint}\n\n${rolePrompt}` 公式不再两处存在。`codex.js:19-24` 的 `[multiccImgHint, envConstraint, [角色设定]rolePrompt]` 分块结构从 `envelope.imgHint` + `envelope.rolePrompt` 重建，source of truth 统一。

---

## 八、--resume 历史句柄不被破坏的保证

**per-turn（claude）**：`historyHandle.isFirstTurn` → `--session-id` / `--resume`，`cliSessionId` 来自 `persisted.cliSessionId`。`shape` 直接放入 args。与今日 `claude.js:55-57` 完全一致。

**per-turn（codex）**：`!isFirstTurn` → `resume <id>`；首轮不加 resume（codex 异步分配 id，`needsAsyncSessionIdCapture=true`）。与今日 `codex.js:42` 一致。

**per-turn（opencode/zcode）**：`!isFirstTurn` → `--session <id>` 或 `--continue`。与今日 `opencode.js:16-17` / `zcode.js:16-17` 一致。

**streaming（claude）**：session 句柄**不在 shape args 中**（streaming shape 省略 session 句柄），由 `chat-stream.js:57-59` `spawnProc` 基于 `s.started` 实时追加 `--resume`/`--session-id`。`_streamSessionId` 持久化在 `persisted`（`server.js:9780-9782`），`ensure` 每轮传入。**此逻辑完全不变**——envelope 不触碰 streaming 的 session 句柄决策，`spawnProc` 保持运行时读 `s.started`。

**续跑/重试路径**：
- `codex disconnect continue`（原 `server.js:9479`）：`composeMessage({text:continuePrompt, opts:{bare:true, isFirstTurn:false}})` → `shape` 产出 `resume <id>`，不重复注入 notes/gateway/dispatch（`bare=true`）
- `fallback retry`（原 `server.js:9519`）：`const retryEnv = {...cs._lastEnvelope, historyHandle:{...cs._lastEnvelope.historyHandle, isFirstTurn:true}}; shape(retryEnv)` → `--session-id`（新会话）。`cs._lastEnvelope` 在 `runChatTurn` 开头赋值（早于 spawn），`close handler` 同步执行，同 turn 内不被覆盖。

---

## 九、（可选）history-loss 失效模式缓解

独立于消息构建核心，列为 phase-4，可单独提交/回滚。

**模式 1（server 重启 started=false）**：根因 `chat-stream.js:261` 新建条目 `started:false`，重启后丢失内存态。
- 修法：新增 `persisted._streamStarted` 布尔。`finishTurn`（`chat-stream.js:149`）时经 `onTurnComplete` 回调置 `true` + `savePersistedSessions`。`ensure` 接受 `cfg.started`，server 传入 `persisted._streamStarted || false`。分配新 `_streamSessionId` 时重置 `_streamStarted=false`。
- 向后兼容：旧 `persisted` 记录无此字段，`resolveStartedState` 返回 `false`（行为同今日），修复只对修复后新跑过的会话生效。

**模式 2（already-in-use 换 UUID 丢历史）**：根因 `chat-stream.js:175-187` 无脑生成新 UUID + `started=false`。
- 修法：改为 `s.started=true`（强制下次 `spawnProc` 用 `--resume <same-id>`），不换 UUID。若 `--resume` 仍报 already-in-use，经**重试计数器**（max 3，嫁接自 A4 但补 A4 遗漏的护栏）后 `surface` 错误（`onExit` 回调通知 server），防 `pump→spawnProc→onExit→already-in-use→pump` 死循环。

---

## 十、迁移路径（分 6 步，每步可独立提交/回滚）

**Step 0 [独立 bugfix，零行为变化风险]**
- 修 `ultracode --settings` streaming drift：`server.js:9768-9773` 补 `if (normalizeEffort(persisted.effort)==='ultracode') extraArgs.push('--settings', '{"ultracode":true}')`，与 `claude.js:48-50` 对齐
- 加回归测试：`streaming+ultracode` 断言 `--settings` 出现在 spawn args
- 回滚：删 2 行

**Step 1 [纯抽取，零行为变化]**
- `server.js`：把 `9005-9045` 逐行搬入 `composePromptText({text,sessionName,persisted,goalLimits})`（与 `buildGoalLimitNote` 同级）。`runChatTurn` 改一行调用。`rolePrompt`（9047）和 `goalMaxTurns`（9034）留在 `runChatTurn`
- `claude.js`：提 `composeSysPrompt(rolePrompt)` 闭包，`31-33` 改调用
- 验证：`console.log` `promptText` 前 200 字符与改前 `diff` 为空；claude spawn args `diff` 为空
- 回滚：函数体贴回原位

**Step 2 [golden 测试前置门控]**
- 写单测：构造 `gateway+notes+goal+ultracode` 组合场景，捕获今日 `promptText` 和 `sysPrompt` 作 golden
- 这一步**先于**任何 envelope 代码，是后续 `byte-for-byte` 等价的硬保障

**Step 3 [新建 message-composer + shape，per-turn only]**
- 新建 `src/message-composer.js`：`composeMessage` + `renderPrompt` + `validateEnvelope` + `typedef`
- `server.js` 顶部构造 `messageComposerDeps`（12 项），`require message-composer`
- 4 个 adapter 各加 `shape(envelope)`。`buildChatSpawnArgs` 降级为 bridge wrapper
- 改造 `runChatTurn` 主路径（`9005-9062`）：`const envelope = composeMessage({...}); cs._lastEnvelope = envelope; if (envelope.spawnOpts.mode==='streaming') return runChatTurnStreaming(sessionName, cs, persisted, envelope); const {args, payload} = provider.shape(envelope); spawnChat([...args, payload], false)`
- 改造 `9479`（codex continue）：`composeMessage({text:continuePrompt, opts:{bare:true, isFirstTurn:false}})` + `shape`
- 改造 `9519`（fallback retry）：`{...cs._lastEnvelope, historyHandle:{...isFirstTurn:true}}` + `shape`
- golden 测试断言 `renderPrompt(envelope) === Step 2 捕获的 promptText`
- 回滚：`buildChatSpawnArgs` wrapper 仍在，`shape` 可整体删除

**Step 4 [streaming 走同一工厂]**
- `runChatTurnStreaming`（`9744-9806`）签名改收 `envelope`，删 `9745`（sysPrompt）、`9765-9773`（model/extraArgs 内联）
- `const {args, payload} = cliProviders.claude.shape(envelope); chatStream.ensure({...,spawnArgs:args}); chatStream.send(name, payload, ...)`
- `chat-stream.js`：`ensure` 接受 `spawnArgs`（含 `else` 分支更新）；`spawnProc` 优先 `s.spawnArgs` 回退原拼装
- 验证：`test-chat-stream.js`（不传 `spawnArgs` 走回退）仍跑通；streaming 手测一轮
- 回滚：恢复 `9745`+`9765-9773` 内联，`ensure` 忽略 `spawnArgs`

**Step 5 [history-loss 缓解，可选]**
- `persisted._streamStarted` 持久化 + `onTurnComplete` 回调 + `ensure cfg.started`
- `onExit already-in-use` 改 `--resume` + 重试计数器
- 验证：手动测 server 重启场景
- 回滚：删 `_streamStarted` 字段 + 恢复 `onExit` 原 logic

**Step 6 [清理]**
- 删 4 个 adapter 的 `buildChatSpawnArgs` bridge wrapper（确认无调用点）
- 删 `chat-stream.js spawnProc` 的 `model/sysPrompt/extraArgs` 回退分支
- 删 `runChatTurnStreaming` 已迁移的旧注释

---

## 十一、关键代码骨架

```js
// ════════════════════════════════════════════════════════════════════
// src/message-composer.js
// ════════════════════════════════════════════════════════════════════
'use strict';

function validateEnvelope(env) {
  if (!env || typeof env.userText !== 'string' || !env.userText)
    throw new Error('envelope.userText must be non-empty');
  if (!Array.isArray(env.contextLayers)) throw new Error('contextLayers must be array');
  const seen = new Set();
  for (const l of env.contextLayers) {
    if (!l.text) throw new Error(`empty layer text: ${l.kind}`);
    if (seen.has(l.kind)) throw new Error(`duplicate layer kind: ${l.kind}`);
    seen.add(l.kind);
  }
  const expected = env.rolePrompt ? `${env.imgHint}\n\n${env.rolePrompt}` : env.imgHint;
  if (env.systemPrompt !== expected) throw new Error('systemPrompt derivation mismatch');
  if (env.spawnOpts.ultracode && !env.suffix) throw new Error('ultracode requires suffix');
}

function composeMessage({ text, persisted, sessionName, opts, deps }) {
  const { isFirstTurn, goalLimits, mode = 'per-turn', bare = false,
    resolvedModel, providerModel, providerModels, skipDefaultModel,
    disallowedTools = [] } = opts;

  // ── 系统提示（唯一计算点）──
  const rolePrompt = deps.resolveRolePrompt(persisted);
  const imgHint = deps.multiccImgHint;
  const systemPrompt = rolePrompt ? `${imgHint}\n\n${rolePrompt}` : imgHint;

  // ── 上下文层（order 复刻今日 prepend 链）──
  const contextLayers = [];
  if (!bare) {
    if (goalLimits) {
      const note = deps.buildGoalLimitNote(goalLimits);
      if (note) contextLayers.push({ kind: 'goal-limit', order: 10, text: note });
    }
    if (persisted.type === 'gateway') {
      contextLayers.push({ kind: 'gateway', order: 20, text: deps.buildGatewayPrompt('') });
    } else if (persisted.type !== 'aux') {
      const dc = deps.buildDispatchContextPrompt(sessionName);
      if (dc) contextLayers.push({ kind: 'dispatch-context', order: 20, text: dc });
    }
    const pendingNotes = deps.pendingNotesFor(sessionName).slice(0, 10);
    if (pendingNotes.length) {
      let block = '[multicc 跨 agent 留言 - 来自同目录下的其他 agent]\n';
      for (const n of pendingNotes) block += `- 来自「${n.fromLabel}」：${n.body}\n`;
      block += '[留言结束]\n\n';
      if (block.length > 4000) block = block.slice(0, 4000) + '\n…(截断)\n\n';
      contextLayers.push({ kind: 'cross-agent-notes', order: 30, text: block });
      // SIDE EFFECTS（与 server.js:9014-9023 一致）
      const now = Date.now();
      for (const n of pendingNotes) { n.delivered = true; n.deliveredAt = now; }
      deps.saveNotes();
      deps.appendEvent(persisted.dirId, 'note_delivered', `${pendingNotes.length} 条留言已送达`, sessionName);
      deps.workspaceBroadcast(persisted.dirId, { type: 'note_pending', sessionId: sessionName, count: deps.pendingNotesFor(sessionName).length });
      deps.chatBroadcast(sessionName, { type: 'system', subtype: 'agent_notes', notes: pendingNotes.map(n => ({ from: n.fromLabel, body: n.body })) });
    }
  }

  // ── 后缀 ──
  const ultracode = !bare && persisted.type !== 'aux' && deps.normalizeEffort(persisted.effort) === 'ultracode';
  const suffix = ultracode ? '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]' : '';

  const envelope = {
    imgHint, rolePrompt, systemPrompt,
    contextLayers: contextLayers.sort((a, b) => a.order - b.order),
    userText: text, suffix,
    historyHandle: { isFirstTurn, cliSessionId: persisted.cliSessionId || null },
    spawnOpts: { mode, model: resolvedModel || null, effort: deps.cliEffortLevel(persisted),
      maxTurns: goalLimits ? (goalLimits.maxRounds || 0) : 0, ultracode, disallowedTools,
      providerModel, providerModels, skipDefaultModel },
  };
  validateEnvelope(envelope);
  return envelope;
}

function renderPrompt(envelope) {
  return envelope.contextLayers.map(l => l.text).join('') + envelope.userText + envelope.suffix;
}

module.exports = { composeMessage, renderPrompt, validateEnvelope };

// ════════════════════════════════════════════════════════════════════
// src/cli-adapters/claude.js — shape()（加到 createClaudeAdapter 返回对象）
// ════════════════════════════════════════════════════════════════════
const { renderPrompt } = require('../message-composer');

// 在 return 对象内新增：
shape(envelope) {
  const so = envelope.spawnOpts;
  const args = [
    '-p',
    ...(so.mode === 'streaming'
      ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
      : ['--output-format', 'stream-json']),
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
    '--append-system-prompt', envelope.systemPrompt,
  ];
  if (so.model) args.push('--model', so.model);
  if (so.effort) args.push('--effort', so.effort);
  if (so.ultracode) args.push('--settings', '{"ultracode":true}');
  if (so.disallowedTools.length) args.push('--disallowedTools', so.disallowedTools.join(','));
  if (so.maxTurns > 0) args.push('--max-turns', String(so.maxTurns));
  if (so.mode === 'per-turn') {
    args.push(envelope.historyHandle.isFirstTurn ? '--session-id' : '--resume', envelope.historyHandle.cliSessionId);
  }
  const payload = renderPrompt(envelope);
  debugLogClaudeInvoke({ cliSessionId: envelope.historyHandle.cliSessionId }, [...args, payload]);
  return { args, payload };
},
// bridge wrapper（迁移期保留，Step 6 删）
buildChatSpawnArgs(session, prompt, opts) {
  const envelope = {
    imgHint: multiccImgHint,
    rolePrompt: opts.rolePrompt || null,
    systemPrompt: opts.rolePrompt ? `${multiccImgHint}\n\n${opts.rolePrompt}` : multiccImgHint,
    contextLayers: [], userText: prompt, suffix: '',
    historyHandle: { isFirstTurn: opts.isFirstTurn, cliSessionId: session.cliSessionId },
    spawnOpts: { mode: 'per-turn', model: providers.resolveSessionWireModel(session.model, {
      providerModel: opts.providerModel, providerModels: opts.providerModels,
      skipDefaultModel: opts.skipDefaultModel, defaultModel: claudeDefaultModel() }),
      effort: cliEffortLevel(session), maxTurns: opts.maxTurns || 0,
      ultracode: normalizeEffort(session?.effort) === 'ultracode',
      disallowedTools: chatDisallowedTools, providerModel: opts.providerModel,
      providerModels: opts.providerModels, skipDefaultModel: opts.skipDefaultModel },
  };
  const { args, payload } = this.shape(envelope);
  return [...args, payload];
},

// ════════════════════════════════════════════════════════════════════
// server.js runChatTurn 主路径改造（替换 9005-9062）
// ════════════════════════════════════════════════════════════════════
const isFirstTurn = (typeof forceFirstTurn === 'boolean') ? forceFirstTurn : (cs.chatTurnCount === 0 || !persisted.cliSessionId);
const goalMaxTurns = goalLimits ? (goalLimits.maxRounds || 0) : 0;
const provEnv = providers.resolveSpawnEnv(persisted);
const resolvedModel = providers.resolveSessionWireModel(persisted.model, {
  providerModel: provEnv.providerModel, providerModels: provEnv.providerModels,
  skipDefaultModel: provEnv.skipDefaultModel, defaultModel: claudeDefaultModel(),
});

const envelope = composeMessage({
  text, persisted, sessionName,
  opts: { isFirstTurn, goalLimits,
    mode: (persisted.streaming && cs.cli === 'claude') ? 'streaming' : 'per-turn',
    resolvedModel, disallowedTools: CLAUDE_CHAT_DISALLOWED_TOOLS,
    providerModel: provEnv.providerModel, providerModels: provEnv.providerModels,
    skipDefaultModel: provEnv.skipDefaultModel },
  deps: messageComposerDeps,
});
cs._lastEnvelope = envelope;

if (envelope.spawnOpts.mode === 'streaming') {
  return runChatTurnStreaming(sessionName, cs, persisted, envelope);
}
const { args, payload } = provider.shape(envelope);
console.log(`[multicc/chat] Spawning ${cs.cli} ...`);
cs.claudeProc = spawnChat([...args, payload], false);
```

---

## 十二、风险与取舍

1. **`contextLayers` 顺序必须逐字节等价**：已核实今日 prepend 链为 `goal > gateway/dispatch > notes`（`goal` 最外层），envelope 用显式 `order` 锁定（`10/20/30`）。`renderPrompt` 用 `sort(order).map(text).join('')` 无额外分隔符，与今日各层自带尾部分隔符直接拼接一致。golden 测试（`Step 2`）是硬保障，必须先于 `call-site` 改动落地。

2. **`buildGatewayPrompt('')` 尾部处理**：已核实返回 `...[Gateway system prompt end]\n\n`（尾部两个 `\n` 来自 `['', ''].join('\n')`），拼接下一层即还原 `wrap` 结构。但 `gateway` 层 `text` 含动态 `sessions JSON`（`server.js:1246`），每轮重新计算（`composeMessage` 调 `buildGatewayPrompt('')`），不可缓存。

3. **`chat-stream.js ensure else 分支`（266-272）**：原代码不更新 `extraArgs`，是隐患。改造后 `else` 分支须加 `if (cfg.spawnArgs !== undefined) s.spawnArgs = cfg.spawnArgs`（已在骨架中体现），否则 `turn 2+` 的 `model/effort/sysPrompt` 变更不生效。这是改造中**最易遗漏的点**。

4. **`cs._lastEnvelope` 异步竞态**：`fallback retry`（`server.js:9519`）复用 `cs._lastEnvelope`。需确认 `cs._lastEnvelope` 赋值早于 `spawn`（`runChatTurn` 开头同步赋值），且 `close handler` 同步执行（Node.js `proc.on('close')` 是同步回调），同 `turn` 内不被覆盖。`worktree` 集成测试常环境性失败，判回归只看单测+`smoke+server` 启动。

5. **`codex configArgsFor` 重构**：`codex shape` 需要 `configArgsFor`，原签名收 `session`，envelope 无完整 `session`。需重构为 `configArgsFor({effort, model})` 或从 `envelope.spawnOpts` 取 `effort/model`。这是 `codex.js` 内部的微小重构，不跨文件。

6. **`opencode/zcode` 不引入 `imgHint`**：envelope 暴露 `imgHint` 但 `opencode/zcode shape` 选择不消费（保持今日行为）。若未来想加，是一行改动。这是有意的保守取舍，避免行为变更风险。

7. **`validateEnvelope` 在 `prod` 的开销**：每轮一次轻量断言（`userText` 空 / `kind` 重复 / 派生一致性），开销可忽略。`dev` 抛错、`prod console.warn`（不阻断），用 `process.env.NODE_ENV` 区分。

8. **`codex-proxy-transform.js` 不纳入**：`responsesToChat`（`codex-proxy-transform.js:25-70`）是 `CLI→上游 wire` 方向的协议转码，与 `server→CLI` 方向的消息组装正交。强行合并会引入方向耦合。保持独立，文档标注其与 `envelope.systemPrompt` 的关系（`proxy` 看到的是 `user message` 而非 `system message`，若未来想让 `DeepSeek` 上游区分 `system/user` 需另设计）。

9. **`deps bag`（12 项）较重但必要**：`composeMessage` 需 `server.js` 的 8 个 `helper` + 4 个常量/函数。`deps` 注入是避免循环引用的唯一方式（`message-composer` 不 `require server.js`）。`wiring` 在 `server.js` 顶部一次性完成，后续不变。

10. **分 2 `commit` 改热路径**：`runChatTurn`（`Step 3`）和 `runChatTurnStreaming`（`Step 4`）是热路径，分两次提交，各自跑 `smoke` + 单测确认，不要一次性改两条路径。
