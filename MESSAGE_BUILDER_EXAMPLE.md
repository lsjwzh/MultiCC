# 统一消息构建模块 -- 详细消息构造与举例

## 1. 一句话总览

**今天**：`runChatTurn`（server.js:9035）以 `promptText = text` 起步，按 notes → dispatch/gateway → goal-limit 的顺序逐层内联 prepend（gateway 特殊：wrap），最后追加 ultracode suffix，得到最终 `promptText`；streaming 路径经 `runChatTurnStreaming` → `chatStream.send` → `userMessageLine` 包成 JSON 行写 stdin。

**新设计**：`composeMessage` 产出 `MessageEnvelope`（`contextLayers` 按 order 排序 + `userText` + `suffix`），`renderPrompt(envelope) = layers.map(text).join('') + userText + suffix` 还原同一字符串；各 CLI 的 `shape(envelope)` 产出 `{args, payload}`，`spawnProc` 追加 session 句柄后 spawn。

**等价结论**：真实会话 multicc-claude-chat-08 下，payload（stdin 内容）逐字节等价；spawn argv 存在 1 处 intentional bugfix（streaming `--settings` drift 修复）和 1 处行为中性的 flag 顺序互换，不影响 CLI 行为。

---

## 2. 真实会话举例：今天内联拼装的全过程

真实会话 multicc-claude-chat-08：`cli=claude`, `type=null`（正常会话）, `effort=ultracode`, `streaming=true`, `cliSessionId=ca88a4d8-fcc7-414c-b735-bdb475cf62f0`, `_streamSessionId=56788db0-8012-4aeb-bd1a-4a9b73a92603`, `model=fable`。

用户消息 `text = "调用api进行重启"`（已在 server.js:8883 trim，无前后空白）。

### 逐步演变

**Step 0 — 初始化**（server.js:9035）

```
let promptText = text;
```

确切字节：
```
调用api进行重启
```

**Step 1 — cross-agent-notes 检查**（server.js:9036-9053）

条件：`pendingNotesFor(sessionName).slice(0, 10)` → `[]`（真实会话当前无待投递留言）→ `if (pendingNotes.length)` 为 false → **不触发**。

promptText 不变：
```
调用api进行重启
```

**Step 2 — dispatch-context / gateway 检查**（server.js:9055-9060）

`persisted.type = null`（既非 `'gateway'` 也非 `'aux'`）→ 进入 `else if (persisted.type !== 'aux')` 分支 → 调用 `buildDispatchContextPrompt(sessionName)`（server.js:1141）。

该函数有两道早退守卫：
- server.js:1143 `if (!targets.length) return ''`
- server.js:1145 `if (!current?.autoDispatch) return ''`

真实会话 persisted 配置无 `autoDispatch` 字段，`createSessionRecord` 默认 `autoDispatch: false`（server.js:2462），磁盘加载 `loadPersistedState` 不补默认值（server.js:942-943），故 `current?.autoDispatch` 为 `undefined`（falsy）→ 返回 `''`。

server.js:9059 `if (dispatchContext)` 为 false → **不触发**，不 prepend。

promptText 不变：
```
调用api进行重启
```

> 关键事实：dispatch 分支**被进入**（`type !== 'aux'` 为 true），但因 `autoDispatch` 缺省 false 使 `buildDispatchContextPrompt` 返回空串，**层文本产出 0 字节**。分支进入 ≠ 层文本非空。

**Step 3 — goal-limit 检查**（server.js:9064-9068）

`goalLimits` 来源：server.js:10157 `msg.goal ? { goalLimits: resolveGoalLimits(msg.goalLimits) } : {}`。真实会话 `msg.goal` 为 falsy（普通聊天 turn）→ `turnOpts = {}` → `runChatTurn` 内 `goalLimits = undefined` → `if (goalLimits)` 为 false → **不触发**。

promptText 不变：
```
调用api进行重启
```

**Step 4 — ultracode suffix 追加**（server.js:9073-9075）

```js
if (persisted.type !== 'aux' && normalizeEffort(persisted.effort) === 'ultracode') {
  promptText = promptText + '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]';
}
```

条件：`type !== 'aux'`（true）&& `normalizeEffort('ultracode') === 'ultracode'`（true，`EFFORT_LEVELS` 含 `'ultracode'`，server.js:490）→ **触发**。

promptText 变为（⏎ 标真实换行 0x0A）：
```
调用api进行重启⏎⏎[Use ultracode mode: orchestrate this task with the Workflow tool.]
```

即 `调用api进行重启` + `\n` + `\n` + `[Use ultracode mode: orchestrate this task with the Workflow tool.]`（恰好 2 个 `\n`）。

### 进入 streaming 路径

server.js:9085-9087：`persisted.streaming && cs.cli === 'claude'` → true → `return runChatTurnStreaming(sessionName, cs, persisted, promptText, rolePrompt)`。

**runChatTurnStreaming**（server.js:9777-9839）关键步骤：

1. `sysPrompt = rolePrompt ? MULTICC_IMG_HINT + '\n\n' + rolePrompt : MULTICC_IMG_HINT`（server.js:9778）。真实会话 `rolePrompt = resolveRolePrompt(persisted) = buildFolderMemoryBlock(persisted)`（非空，因 own/shared memory 文件夹有内容）→ `sysPrompt = MULTICC_IMG_HINT + '\n\n' + folderMemoryBlock`。

2. `model = resolveSessionWireModel('fable', ...)` → `'fable'`（`'fable'` ∈ `ALIAS_TIER_KEYS`，解析为自身）。

3. `extraArgs`（server.js:9801-9806）：
   ```js
   const extraArgs = [];
   const effort = cliEffortLevel(persisted);  // 'ultracode' -> 'xhigh' (server.js:504)
   if (effort) extraArgs.push('--effort', effort);  // ['--effort', 'xhigh']
   if (CLAUDE_CHAT_DISALLOWED_TOOLS.length) {
     extraArgs.push('--disallowedTools', CLAUDE_CHAT_DISALLOWED_TOOLS.join(','));  // ['--disallowedTools', 'AskUserQuestion']
   }
   // 注意：无 --settings（ultracode --settings drift bug）
   ```

4. `chatStream.ensure(sessionName, { cmd, cwd, sessionId: persisted._streamSessionId, model, sysPrompt, extraArgs, env, onBackgroundEvent })`（server.js:9817-9824）→ 触发 `spawnProc`（若进程未启动）。

5. `chatStream.send(sessionName, promptText, callback)`（server.js:9839）。

**spawnProc**（src/chat-stream.js:55-71）拼装 args：

```js
const sessionArgs = s.started
  ? ['--resume', s.sessionId]
  : ['--session-id', s.sessionId];
// s.started = false（首次/重启后）-> ['--session-id', '56788db0-8012-4aeb-bd1a-4a9b73a92603']

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
  ...(s.model ? ['--model', s.model] : []),               // --model fable
  ...(s.sysPrompt ? ['--append-system-prompt', s.sysPrompt] : []),  // --append-system-prompt <SYS>
  ...(s.extraArgs || []),                                   // --effort xhigh --disallowedTools AskUserQuestion
  ...sessionArgs,                                           // --session-id 56788db0-...
];
```

**最终 spawn 命令行**（`<SYS>` = `MULTICC_IMG_HINT + '\n\n' + folderMemoryBlock`，两路径同值）：

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --model fable --append-system-prompt <SYS> --effort xhigh --disallowedTools AskUserQuestion --session-id 56788db0-8012-4aeb-bd1a-4a9b73a92603
```

**stdin 第一行**（`userMessageLine` 包装，src/chat-stream.js:46-51；JSON 中 `\n` 是转义序列 backslash+n 共 2 字符，`⏎` 是行尾真实换行 0x0A）：

```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"调用api进行重启\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]"}]}}⏎
```

> 注意：JSON `text` 值里的 `\n\n` 是 4 个字符（`backslash` `n` `backslash` `n`），编码了 promptText 中的 2 个真实换行。行尾 `⏎` 是 stdin 的行分隔符。

---

## 3. 真实会话举例：新设计 envelope 的全过程

### composeMessage 产出的 MessageEnvelope

```js
const envelope = {
  // 用户原始文本
  userText: "调用api进行重启",

  // 上下文层（本会话全部不触发 -> 空数组）
  contextLayers: [],
  // 逐层核实：
  //   goal-limit:   goalLimits=undefined -> if(goalLimits) false -> 不 push
  //   gateway:      type!=='gateway' -> 不 push
  //   dispatch:     type!=='aux' -> dc=buildDispatchContextPrompt('')='' -> if(dc) false -> 不 push
  //   cross-agent-notes: pendingNotesFor('')=[] -> 不 push

  // ultracode 后缀（唯一触发的上下文构造）
  suffix: '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]',
  // 触发条件：!bare(true) && type!=='aux'(true) && normalizeEffort('ultracode')==='ultracode'(true)

  // 系统提示（与今天 runChatTurnStreaming 同公式）
  systemPrompt: MULTICC_IMG_HINT + '\n\n' + folderMemoryBlock,  // === <SYS>
  imgHint: MULTICC_IMG_HINT,
  rolePrompt: buildFolderMemoryBlock(persisted),

  // spawn 选项
  spawnOpts: {
    mode: 'streaming',
    model: 'fable',          // resolveSessionWireModel('fable', ...) -> 'fable'
    effort: 'xhigh',         // cliEffortLevel('ultracode') -> 'xhigh' (server.js:504)
    ultracode: true,         // normalizeEffort(persisted.effort)==='ultracode'
    disallowedTools: ['AskUserQuestion'],
    maxTurns: 0,             // 无 goalLimits -> 0
  },

  // 历史句柄（streaming 模式下 shape 不直接使用，spawnProc 读 s.started 决定）
  historyHandle: {
    mode: 'streaming',
    isFirstTurn: false,
    cliSessionId: '56788db0-8012-4aeb-bd1a-4a9b73a92603',  // = _streamSessionId
  },
};
```

### contextLayers 实际内容

```js
envelope.contextLayers = []
// 空数组。真实会话下四层上下文均不触发：
//   1. goal-limit   (order:10) — msg.goal falsy -> goalLimits undefined
//   2. dispatch-context (order:20) — autoDispatch falsy -> buildDispatchContextPrompt 返回 ''
//   3. gateway      (order:20) — type=null, 非 'gateway'
//   4. cross-agent-notes (order:30) — 无 pending notes
```

### renderPrompt(envelope) 产物

```js
function renderPrompt(envelope) {
  return envelope.contextLayers.map(l => l.text).join('') + envelope.userText + envelope.suffix;
}
// = [].join('') + "调用api进行重启" + '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]'
// = "调用api进行重启" + '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]'
```

确切字节（⏎ 标换行）：
```
调用api进行重启⏎⏎[Use ultracode mode: orchestrate this task with the Workflow tool.]
```

**与第 2 节 Step 4 最终 promptText 逐字节相同。**

### claude.shape(envelope) 的 {args, payload}

```js
shape(envelope) {
  const so = envelope.spawnOpts;
  const args = [
    '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json',  // mode='streaming'
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
    '--append-system-prompt', envelope.systemPrompt,   // <SYS>
  ];
  if (so.model) args.push('--model', so.model);                    // --model fable
  if (so.effort) args.push('--effort', so.effort);                 // --effort xhigh
  if (so.ultracode) args.push('--settings', '{"ultracode":true}'); // --settings {"ultracode":true} ← 修 drift
  if (so.disallowedTools.length) args.push('--disallowedTools', so.disallowedTools.join(','));
  // so.maxTurns=0 -> if(so.maxTurns>0) false -> 不加 --max-turns
  // mode='streaming' -> 不加 --session-id/--resume（由 spawnProc 追加）
  const payload = renderPrompt(envelope);
  return { args, payload };
}
```

`payload` = `renderPrompt(envelope)` = `调用api进行重启⏎⏎[Use ultracode mode: orchestrate this task with the Workflow tool.]`

`args`（shape 产出，**不含** session 句柄）：
```
-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <SYS> --model fable --effort xhigh --settings {"ultracode":true} --disallowedTools AskUserQuestion
```

### chat-stream spawnProc 最终 spawn 的完整命令行 + stdin

spawnProc 改造后用 `[...s.spawnArgs, ...sessionArgs]`：

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <SYS> --model fable --effort xhigh --settings {"ultracode":true} --disallowedTools AskUserQuestion --session-id 56788db0-8012-4aeb-bd1a-4a9b73a92603
```

stdin 第一行（`chatStream.send(sessionName, payload, ...)` → `userMessageLine(payload)`）：
```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"调用api进行重启\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]"}]}}⏎
```

### 与第 2 节一一对照

| 维度 | 今天（第 2 节） | envelope（第 3 节） | 是否等价 |
|------|----------------|---------------------|----------|
| payload / stdin 内容 | `调用api进行重启⏎⏎[Use ultracode...]` | `调用api进行重启⏎⏎[Use ultracode...]` | **逐字节相同** |
| stdin JSON 行 | `{"type":"user",...,"text":"调用api进行重启\n\n[...]"}⏎` | 同左 | **逐字节相同** |
| `--settings {"ultracode":true}` | **缺失**（drift bug） | **存在**（bugfix） | **intentional 差异** |
| `--model` 与 `--append-system-prompt` 顺序 | `--model` 在前 | `--append-system-prompt` 在前 | 行为中性差异（CLI flag 无序） |
| session 句柄 | `--session-id 56788db0-...`（spawnProc 读 `s.started`） | `--session-id 56788db0-...`（spawnProc 读 `s.started`） | **相同**（shape 不触碰） |
| `<SYS>` 内容 | `MULTICC_IMG_HINT + '\n\n' + folderMemoryBlock` | 同左（同公式同源） | **相同** |

---

## 4. 上下文层逐层详解

> 以下对四层上下文 + ultracode suffix 逐层分析。真实会话 multicc-claude-chat-08 下，仅 ultracode suffix 触发（`firesForRealSession=true`），其余三层因各自守卫条件不满足而不触发。每层同时给出"若触发"的字节示例以验证等价性。

### 总览表

| 层 | order | 触发条件（真实会话） | 来源函数 file:line | 尾部分隔符 | 今天方向 | envelope renderPrompt | 真实会话是否触发 | 字节等价 |
|----|-------|---------------------|---------------------|-----------|---------|----------------------|-----------------|---------|
| goal-limit | 10 | `goalLimits` 非 falsy | `buildGoalLimitNote` server.js:5688-5693 | `\n\n` | PREFIX（`note + promptText`） | `layer(order:10).text` 最先拼 | 否（msg.goal falsy） | 是 |
| dispatch-context | 20 | `type!=='aux'` && `autoDispatch` && 有可派发目标 | `buildDispatchContextPrompt` server.js:1141-1182 | `\n`（单换行） | PREFIX（`dc + promptText`） | `layer(order:20).text` | 否（autoDispatch falsy） | 是 |
| gateway | 20 | `type==='gateway'` | `buildGatewayPrompt` server.js:1220-1251 | `\n\n`（尾部 `['',userText].join('\n')` 产 2 个 `\n`） | **WRAP**（`buildGatewayPrompt(promptText)`） | `layer(order:20).text = buildGatewayPrompt('')` | 否（type=null） | 是 |
| cross-agent-notes | 30 | `pendingNotesFor(sessionName).length > 0` | runChatTurn 内联 server.js:9036-9053 | `\n\n` | PREFIX（`block + promptText`） | `layer(order:30).text` | 否（无 pending notes） | 是 |
| ultracode suffix | — | `!bare && type!=='aux' && normalizeEffort(effort)==='ultracode'` | server.js:9073-9075 | `'\n\n'` 起头 | SUFFIX（`promptText + suffix`） | `envelope.suffix` 接在 userText 后 | **是** | 是 |

### 4.1 goal-limit 层（order:10）

**触发条件**：`msg.goal` 为 truthy → `turnOpts = { goalLimits: resolveGoalLimits(msg.goalLimits) }` → `runChatTurn` 内 `goalLimits` 非 undefined → `if (goalLimits)` 为 true。

真实会话：`msg.goal` falsy → `turnOpts = {}` → `goalLimits = undefined` → **不触发**。

**来源函数**：`buildGoalLimitNote`（server.js:5688-5693），调用点 server.js:9064-9068。

**尾部分隔符**：`\n\n`（note 自带 `[限制结束]\n\n`）。

**今天方向**：PREFIX — `promptText = note + promptText`（server.js:9067）。goal 是 prepend 链最后一步，故位于最外层。

**envelope**：`contextLayers.push({ kind:'goal-limit', order:10, text: note })`（MESSAGE_BUILDER_DESIGN.md:524-526）。`renderPrompt` 的 `layers.sort(order).map(text).join('')` 中 order:10 最低 = 最先拼 = 最外层，正复刻今日 prepend 链。

**若触发的字节示例**（样本 `goalLimits={maxRounds:5, maxBudget:'500k'}`）：

```
[Goal 模式限制]⏎本次为 Goal 模式自主任务，自主执行的轮次（agent turns）上限为 5 轮，请在该轮次内完成；接近上限时先收敛、给出当前结论与未尽事项，不要无限发散。⏎[限制结束]⏎⏎
```

今天（`note + promptText`，note 尾部自带 `\n\n`）与 envelope（`layer.text` + 下一层，`join('')` 无额外分隔符，`\n\n` 由 note 自带）逐字节相同。

> **附带发现（非 today-vs-envelope 分歧）**：`buildGoalLimitNote` 用 `limits.maxBudget > 0` 守卫预算行，而样本 `maxBudget='500k'` 是字符串，`'500k' > 0` 因 `ToNumber('500k')=NaN` → `NaN > 0 = false`（已 node 实测），预算行被静默丢弃。此缺陷对 today 与 envelope 两条路径同等生效，不构成分歧。

### 4.2 dispatch-context 层（order:20）

**触发条件**：`persisted.type !== 'gateway'` && `persisted.type !== 'aux'` && `buildDispatchContextPrompt(sessionName)` 返回非空。后者要求：(1) `dispatchableSessionsFor` 有同目录可派发目标（`targets.length > 0`），(2) `current.autoDispatch === true`。

真实会话：`type=null` → 进入 `else if (type !== 'aux')` 分支 → `buildDispatchContextPrompt` → `autoDispatch` 缺省 false（server.js:2462 `createSessionRecord` 默认值；server.js:942-943 磁盘加载不补默认值）→ server.js:1145 `if (!current?.autoDispatch) return ''` → 返回 `''` → `if (dispatchContext)` false → **不触发**。

**来源函数**：`buildDispatchContextPrompt`（server.js:1141-1182），调用点 server.js:9058-9059。

**尾部分隔符**：`\n`（单换行）。`buildDispatchContextPrompt` 内部数组末元素 `''` 经 `.join('\n')` 产生尾部单个 `\n`。

**今天方向**：PREFIX — `promptText = dispatchContext + promptText`（server.js:9059）。dispatch 文本直接前置于 promptText，无额外分隔符。

**envelope**：`contextLayers.push({ kind:'dispatch-context', order:20, text: dc })`（MESSAGE_BUILDER_DESIGN.md:530-533）。`dc` 是 `buildDispatchContextPrompt` 原样返回值，未做任何变换。`renderPrompt` 的 `join('')` 直接拼接，无额外分隔符。

**字节等价结论**：today `dc + promptText`（dc 尾部单 `\n`，与后续 text 间无额外符）=== envelope `layer.text(=dc) + nextLayer.text/userText`（`join('')` 无额外符）。逐字节相同。

**方向**：PREFIX（与 gateway 的 WRAP 不同，见 4.3）。

### 4.3 gateway 层（order:20，与 dispatch 互斥）

**触发条件**：`persisted.type === 'gateway'`。

真实会话：`type=null` → **不触发**（走 dispatch 分支）。以下用 gateway 示例会话 `__gateway__`（`type='gateway'`, `cli='claude'`, `label='WeChat Gateway'`）+ `userText="调用api进行重启"` 验证。

**来源函数**：`buildGatewayPrompt`（server.js:1220-1251），调用点 server.js:9055-9056。

**关键结构**：

```js
function buildGatewayPrompt(userText) {
  // ... 构造 sessionsForPrompt ...
  return [
    '[MultiCC Gateway system prompt]',
    '你是 MultiCC 的微信 Gateway 会话。...',
    // ... 9 个固定 system block 元素 ...
    '当前可见 sessions: ${context}',
    '[Gateway system prompt end]',
    '',          // ← 空字符串
    userText,    // ← 用户文本作为末元素
  ].join('\n');
}
```

尾部 `['', userText].join('\n')` = `'\n' + '' + '\n' + userText`？不——`.join('\n')` 在 `'[Gateway system prompt end]'` 与 `''` 与 `userText` 三者间插入 `\n`：`'[Gateway system prompt end]' + '\n' + '' + '\n' + userText` = `'[Gateway system prompt end]\n\n' + userText`。

故 `buildGatewayPrompt(x) ≡ systemBlock + '\n\n' + x`，推论 `buildGatewayPrompt(x) ≡ buildGatewayPrompt('') + x`（脚本验证 818===818 字节，`===true`）。

**尾部分隔符**：`\n\n`（`buildGatewayPrompt('')` 尾部正好 2 个 `\n`）。

**今天方向**：**WRAP** — `promptText = buildGatewayPrompt(promptText)`（server.js:9056）。把已含 notes 的 promptText 整体作为 `userText` 形参塞进 system block 尾部。这与 dispatch 的 PREFIX 不同：dispatch 是「在外面加前缀」，gateway 是「把整体塞进 block 内部」。

**envelope**：`contextLayers.push({ kind:'gateway', order:20, text: buildGatewayPrompt('') })`（MESSAGE_BUILDER_DESIGN.md:528-529）。layer.text 只含 system block（尾部 `\n\n`），userText 经 `renderPrompt` 接在层后。

**字节等价证明**：

| 场景 | 今天 | envelope |
|------|------|---------|
| 无 notes | `buildGatewayPrompt(text)` = `buildGatewayPrompt('') + text` | `buildGatewayPrompt('') + text`（layer + userText） |
| 有 notes | `buildGatewayPrompt(notes + text)` = `buildGatewayPrompt('') + notes + text` | `buildGatewayPrompt('')(order:20) + notes(order:30) + text`（layer + layer + userText） |

两种场景均逐字节相同。`buildGatewayPrompt('')` 的 layer 尾部 `\n\n` + userText === wrapped userText，完美还原 wrap 结构。

**若触发的字节示例**（gateway 示例会话 + 单条 mock chat session 作 context）：

```
[MultiCC Gateway system prompt]⏎你是 MultiCC 的微信 Gateway 会话。所有微信消息都统一进入这个会话。⏎你负责基于用户消息和可用 session 上下文判断如何回应：可以直接回答、追问澄清，或把任务分发给某个具体 session。⏎当你判断需要某个 session 来处理任务时，在回复的最后单独输出一行分发标记：⏎<<dispatch target="真实 session id">要交给该 session 执行的完整、自包含指令</dispatch>>⏎其中 target 必须逐字使用上面可见 sessions 列表里的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。dispatch 内的指令要完整到该 session 无需追问即可执行。⏎分发不会立即生效--系统会先向用户复述并等待用户回复「确认」后才真正投递，所以你可以在标记前用自然语言说明你打算交给谁、做什么。⏎只有真的需要某个 session 干活时才输出该标记；纯聊天、答疑、澄清类回复不要输出标记。每条回复最多一个 dispatch 标记。⏎当用户问 Gateway/Router/会话管理相关问题时，直接以 Gateway 身份回答，不要输出标记。⏎当前可见 sessions: [{"id":"multicc-claude-chat-08","label":"发布相关","cli":"claude","kind":"chat","cwd":"/Users/Zhuanz/Downloads/gapasea-all-in-one/code/claudecode/multicc/.multicc-worktrees/multicc-claude-chat-08","active":false}]⏎[Gateway system prompt end]⏎⏎调用api进行重启
```

today（`buildGatewayPrompt("调用api进行重启")`）与 envelope（`buildGatewayPrompt('')` layer + `"调用api进行重启"` userText）产出完全相同。

> **gateway WRAP vs dispatch PREFIX 方向差异总结**：
> - dispatch 是**前缀拼接**：`dc + promptText`，dispatch 文本在 promptText 前面，两者并列。
> - gateway 是**包裹**：`buildGatewayPrompt(promptText)`，promptText 被塞进 system block 内部作为末元素。
> - envelope 对两者的建模不同：dispatch 的 layer.text = dc 本身（前缀），gateway 的 layer.text = `buildGatewayPrompt('')`（仅 system block，不含 userText）。但经 `renderPrompt` 拼接后，`buildGatewayPrompt('') + userText === buildGatewayPrompt(userText)`，逐字节还原 wrap。

### 4.4 cross-agent-notes 层（order:30 + 副作用）

**触发条件**：`pendingNotesFor(sessionName).slice(0, 10).length > 0`。

真实会话：无 pending notes → **不触发**。以下用样本留言 `fromLabel='multicc-claude-chat-05', body='请先 sync 再动手'` 验证。

**来源函数**：runChatTurn 内联块（server.js:9036-9053），envelope 对应 MESSAGE_BUILDER_DESIGN.md:534-548。

**尾部分隔符**：`\n\n`（`[留言结束]\n\n`）。

**今天方向**：PREFIX — `promptText = block + text`（server.js:9042）。

**envelope**：`contextLayers.push({ kind:'cross-agent-notes', order:30, text: block })`（MESSAGE_BUILDER_DESIGN.md:540）。`renderPrompt` 的 `join('')` 直接拼接。

**若触发的字节示例**：

```
[multicc 跨 agent 留言 - 来自同目录下的其他 agent]⏎- 来自「multicc-claude-chat-05」：请先 sync 再动手⏎[留言结束]⏎⏎
```

逐字节相同——头部行、每条 `- 来自「fromLabel」：body\n`、`[留言结束]\n\n` 尾分隔符、4000 截断阈值与 `…(截断)` 标记（U+2026）全等。

**副作用**（按分歧 3 裁决留在 composeMessage 内，非纯函数）：在构造 block 之后同步执行，顺序与今天一致：

| 步骤 | 今天（server.js:9043-9053） | envelope（MESSAGE_BUILDER_DESIGN.md:542-547） |
|------|---------------------------|-----------------------------------------------|
| 1 | `n.delivered = true; n.deliveredAt = now` | 同 |
| 2 | `saveNotes()` | 同 |
| 3 | `appendEvent(dirId, 'note_delivered', ...)` | 同 |
| 4 | `workspaceBroadcast(dirId, {type:'note_pending', count:...})` | 同（投递后重查 → 0） |
| 5 | `chatBroadcast(sessionName, {type:'system', subtype:'agent_notes', ...})` | 同 |

### 4.5 ultracode suffix

**触发条件**：`!bare && persisted.type !== 'aux' && normalizeEffort(persisted.effort) === 'ultracode'`。

真实会话：`bare=false` && `type=null !== 'aux'`（true）&& `normalizeEffort('ultracode') === 'ultracode'`（true）→ **触发**。

**来源函数**：server.js:9073-9075（追加点）；envelope MESSAGE_BUILDER_DESIGN.md:552-553（suffix 计算点）。

**尾部分隔符**：suffix 以 `\n\n` 起头。

**今天方向**：SUFFIX — `promptText = promptText + '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]'`。

**envelope**：`envelope.suffix = '\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]'`，`renderPrompt = layers.join('') + userText + suffix`。

**字节等价**：

```
调用api进行重启⏎⏎[Use ultracode mode: orchestrate this task with the Workflow tool.]
```

今天（`promptText + '\n\n[…]'`）与 envelope（`userText + suffix`，suffix 字面以 `\n\n` 起头）逐字节相同。两侧均产生恰好 2 个 `\n`。

---

## 5. 每 CLI shape 对照

> 真实会话 cli=claude，仅 claude streaming shape 触发。其余 CLI 列出"假设同配置运行"的对照以验证 shape 层等价性。

### 5.1 claude per-turn（真实会话不触发，streaming=true 提前 return）

| 维度 | 今天 `buildChatSpawnArgs`（claude.js:30-60） | envelope `claude.shape`（mode='per-turn'） |
|------|---------------------------------------------|---------------------------------------------|
| args 顺序 | `-p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <SYS> --model fable --effort xhigh --settings {"ultracode":true} --disallowedTools AskUserQuestion --resume ca88a4d8-... <payload>` | `-p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <SYS> --model fable --effort xhigh --settings {"ultracode":true} --disallowedTools AskUserQuestion --resume ca88a4d8-...` |
| payload | `promptText`（runChatTurn 拼装） | `renderPrompt(envelope)` |
| 差异 | — | 无 |
| 等价 | **逐字节等价** | |

### 5.2 claude streaming（真实会话触发路径）

| 维度 | 今天 `runChatTurnStreaming` + `spawnProc` | envelope `claude.shape`(streaming) + `spawnProc` |
|------|------------------------------------------|--------------------------------------------------|
| args | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --model fable --append-system-prompt <SYS> --effort xhigh --disallowedTools AskUserQuestion --session-id 56788db0-...` | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --append-system-prompt <SYS> --model fable --effort xhigh --settings {"ultracode":true} --disallowedTools AskUserQuestion --session-id 56788db0-...` |
| payload / stdin | `调用api进行重启⏎⏎[Use ultracode mode: orchestrate this task with the Workflow tool.]` | 同左 |
| session 句柄 | `--session-id 56788db0-...`（spawnProc 读 `s.started`） | `--session-id 56788db0-...`（spawnProc 读 `s.started`） |

**差异**（2 处）：

| # | 差异 | 严重性 | 说明 |
|---|------|--------|------|
| A | envelope 新增 `--settings {"ultracode":true}` | **intentional bugfix** | 今天 streaming 路径（server.js:9801-9806 extraArgs）从不 push `--settings`，而 per-turn（claude.js:48-50）有。envelope `claude.shape` 的 `if (so.ultracode) args.push('--settings', '{"ultracode":true}')` 不分 mode，补齐 drift。注：`--settings` 单独不触发 Workflow（实测），真正触发靠 payload 里的 ultracode 关键词后缀（两路径都加），故此 flag 对 Workflow 激活是 cosmetic；但 per-turn 已带、streaming 漏带属不一致 drift，设计修之为 intentional。 |
| B | `--model` 与 `--append-system-prompt` 顺序互换 | **minor（行为中性）** | 今天 spawnProc 先 `--model` 后 `--append-system-prompt`；envelope shape 先 `--append-system-prompt` 后 `--model`。claude CLI 对 flag 顺序不敏感，功能等价但 args 数组字节序列不同。 |

> **streaming ultracode --settings drift bug**：这是本次重构唯一被标记为 intentional bugfix 的差异。今天 per-turn 路径（claude.js:48-50）在 `normalizeEffort(session?.effort) === 'ultracode'` 时 push `--settings '{"ultracode":true}'`，但 streaming 路径（server.js:9801-9806 runChatTurnStreaming extraArgs）只 push `--effort` 和 `--disallowedTools`，遗漏 `--settings`。envelope 的 `claude.shape` 统一补齐，消除 drift。

### 5.3 codex（firstTurn + 续轮，真实会话不触发）

| 维度 | 今天 `codex.buildChatSpawnArgs`（codex.js:36-50） | envelope `codex.shape`（MESSAGE_BUILDER_DESIGN.md:240-257） |
|------|--------------------------------------------------|-------------------------------------------------------------|
| 首轮 args | `exec -c model="fable" --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <PAYLOAD>` | `exec -c model_reasoning_effort="xhigh" -c model="fable" --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <PAYLOAD>` |
| 续轮 args | `exec -c model="fable" resume ca88a4d8-... --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <PAYLOAD>` | `exec -c model_reasoning_effort="xhigh" -c model="fable" resume ca88a4d8-... --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <PAYLOAD>` |
| 首轮 PAYLOAD | `firstTurnPrompt` = `[imgHint, envConstraint, [角色设定]\nrolePrompt\n[角色设定结束]].join('\n\n') + '\n\n' + prompt` + `\n` + stayAlivePrompt | `prefixes.join('\n\n') + '\n\n' + renderPrompt(envelope)` + `\n` + stayAlivePrompt（结构相同） |
| 续轮 PAYLOAD | 裸 prompt + `\n` + stayAlivePrompt | 同 |

**差异**（2 处）：

| # | 差异 | 严重性 | 说明 |
|---|------|--------|------|
| C | envelope 新增 `-c model_reasoning_effort="xhigh"` | **major** | 今天 `configArgsFor(session)` 调 `codexReasoningLevel` → `normalizeEffort('ultracode')` = `'ultracode'`，但 `'ultracode'` ∉ `CODEX_REASONING_LEVELS`（`{'low','medium','high','xhigh','max','ultra'}`）→ 返回 null → filter(Boolean) 丢弃 → 无 reasoning 参数。envelope `so.effort = cliEffortLevel(persisted)` 把 `'ultracode'` 映射为 `'xhigh'`（server.js:504），`'xhigh'` ∈ `CODEX_REASONING_LEVELS` → 产出 `model_reasoning_effort="xhigh"`。多出 2 个数组元素。 |
| D | model 来源从原始 `session.model` 改为解析后 `so.model` | **major** | 今天 `codexModelConfigArg(session)` 读 `session.model`（原始 persisted.model，如 `'fable'` 原样进 `model="fable"`）。envelope `codexModelConfigArg({model: so.model})`，`so.model = resolveSessionWireModel(persisted.model, ...)`，当 persisted.model 非 tier 别名且不在 provider served 列表时会被替换成 providerModel。对样本（`model='fable'` ∈ `ALIAS_TIER_KEYS` → 解析为自身）无影响，但可能改变其他 codex 会话的模型路由。设计 risk#5 明确写「从 envelope.spawnOpts 取 effort/model」是 deliberate，但未论证为 bugfix。 |

> 附注：codex 首轮 systemBlock 重建——envelope 通过独立 `imgHint` 字段（嫁接自方案 A3）成功重建 codex.js:19 的 `[multiccImgHint, envConstraint, [角色设定]rolePrompt]` 分块结构，修复了方案 A1 把 imgHint 合进 systemPrompt 无法重建的缺口。首轮 prefixes 三块间各 2 个 `\n`，块内 `[角色设定]` 标签 1 个 `\n`，ultracode→stayAlive 间 2 个 `\n`，PAYLOAD 零差异。

### 5.4 opencode / zcode（真实会话不触发，两者除 name 外一字不差）

| 维度 | 今天 `buildChatSpawnArgs`（opencode.js:13-24 / zcode.js:13-24） | envelope `opencode.shape` / `zcode.shape` |
|------|----------------------------------------------------------------|--------------------------------------------|
| 续轮 args | `run --format json --auto --model fable --session ca88a4d8-... <PAYLOAD>` | `run --format json --auto --model fable --session ca88a4d8-... <PAYLOAD>`（wrapper `[...args, payload]`） |
| 首轮 args | `run --format json --auto --model fable [角色设定]⏎<rolePrompt>⏎[角色设定结束]⏎⏎<PAYLOAD>` | 同（首轮 `rolePrompt` 包裹，不内联 imgHint） |
| 差异 | — | model 来源同 codex 差异 D（raw → resolved），对样本无影响 |

shape 层字节等价（args 构造逻辑、`--session`/`--continue` 决策、`[角色设定]` 包裹公式、不内联 imgHint 全部一致）。唯一结构差异：shape 返回 `{args, payload}` 二元组，今天返回单数组（`args.push(promptText)`），但 wrapper 用 `[...args, payload]` 拼回，最终 spawn argv 字节相同。

---

## 6. history handle 如何不丢

| CLI / 路径 | 今天句柄机制 | envelope 句柄机制 | 是否触碰 |
|------------|-------------|-------------------|---------|
| claude per-turn | `--session-id`（首轮）/ `--resume`（续轮），用 `cliSessionId`（claude.js:55-56） | `shape` 内 `if (so.mode === 'per-turn')` push `--session-id`/`--resume` + `envelope.historyHandle.cliSessionId` | shape 直接产出，值同源 |
| **claude streaming** | `_streamSessionId` + `s.started` 实时决定 `--session-id`/`--resume`（spawnProc chat-stream.js:57-59） | **shape 不产出句柄**（`if (so.mode === 'per-turn')` 不触发）；spawnProc 仍读 `s.started` 实时追加 | **envelope 不触碰** |
| codex | `resume <cliSessionId>`（续轮，codex.js:44-45）；首轮不加 | `shape` 内 `if (!isFirstTurn) args.push('resume', cliSessionId)` | 同源 |
| opencode / zcode | `--session <cliSessionId>`（续轮有 id）/ `--continue`（续轮无 id）（opencode.js:16-17） | `shape` 内 `if (!isFirstTurn) { if (cliSessionId) --session else --continue }` | 同源 |

**核心保证**：envelope 的 `claude.shape` 在 streaming 模式下**省略 session 句柄**（`if (so.mode === 'per-turn')` 块不执行），session 句柄决策（`s.started` → `--session-id` / `--resume`）完全由 `spawnProc` 实时决定——与今天完全相同。`_streamSessionId` 的生成（server.js:9813-9815 `if (!persisted._streamSessionId) { persisted._streamSessionId = crypto.randomUUID(); savePersistedSessions(); }`）也在 `runChatTurnStreaming` 改造版中保留，envelope 不触碰。

真实会话对照：

| 维度 | 今天 | envelope |
|------|------|---------|
| 句柄值 | `_streamSessionId = 56788db0-8012-4aeb-bd1a-4a9b73a92603` | 同（`envelope.historyHandle.cliSessionId` = `_streamSessionId`） |
| 决策标志 | `s.started = false` → `--session-id` | `s.started = false` → `--session-id`（spawnProc 读同一 `s` 对象） |
| 产出位置 | `spawnProc` 内联拼装 | `spawnProc` 用 `[...s.spawnArgs, ...sessionArgs]` |

---

## 7. 对抗验证裁决汇总

### 三个验证者裁决

| # | 验证者 | verdict | divergences | 核心结论 |
|---|--------|---------|-------------|---------|
| 1 | promptText-equiv | **EQUIVALENT** | 0 | 独立从 server.js:9035-9075 重建今日 promptText，与 `renderPrompt(envelope)` 对真实会话逐字节比对，完全相同。稳健性结论：即便 autoDispatch 为真、dispatchContext 非空，两路径仍等价（同函数同拼法）。 |
| 2 | shape-equiv | **DIVERGENCE_FOUND** | 4 | payload 逐字节等价；spawn argv 存在 4 处差异（详见下表）。 |
| 3 | sideeffects-ordering | **EQUIVALENT** | 0（3 不变量全通过） | 副作用等价（notes 5 项副作用逐项一致）、顺序不变量（goal>dispatch/gateway>notes>userText>suffix）、互斥（gateway/dispatch 由 type 单选）全部通过。 |

### 验证者 2 的 4 处 divergences

| # | 位置 | 严重性 | 类型 | 说明 |
|---|------|--------|------|------|
| A | claude streaming spawn args — `--settings` | **intentional** | bugfix | 今天 streaming 缺 `--settings '{"ultracode":true}'`，envelope 补齐。Step 0 认定的真 bug，对 Workflow 激活是 cosmetic（靠 payload 关键词），但消除 per-turn/streaming 不一致。 |
| B | claude streaming spawn args — flag 顺序 | **minor** | 行为中性 | `--model` 与 `--append-system-prompt` 互换。claude CLI flag 无序，功能等价但字节序列不同。golden 测试若只断言 payload/sysPrompt 会漏掉。 |
| C | codex/opencode/zcode — model 来源 | **major** | 行为变更 | 从原始 `session.model` 改为解析后 `so.model = resolveSessionWireModel(...)`。对样本（`'fable'` 解析为自身）无影响，但可能改变非 claude CLI 的模型路由。设计 risk#5 标注为 deliberate，但未论证为 bugfix。 |
| D | claude streaming — `--max-turns` | **minor** | 行为变更 | 今天 streaming 从不加 `--max-turns`；envelope shape 的 `if (so.maxTurns > 0)` 不分 mode，streaming+goal 会话会加。对样本（无 goal）不触发。shape 代码与设计散文（未列 `--max-turns`）不一致。 |

### independentReconstruction 摘要

**验证者 1**（promptText-equiv）独立重建的事实链：
1. `type=null` → 进 dispatch 分支但 `autoDispatch` 缺省 false → `buildDispatchContextPrompt` 返回 `''` → 不 prepend
2. `goalLimits=undefined` → skip
3. `pendingNotes=[]` → skip
4. `normalizeEffort('ultracode')==='ultracode'` → 追加 suffix
5. 最终 promptText = `调用api进行重启` + `\n\n[Use ultracode mode: orchestrate this task with the Workflow tool.]`
6. envelope `renderPrompt` = `[].join('') + userText + suffix` = 同串
7. 逐字节相同

**验证者 3**（sideeffects-ordering）独立重建确认：
- 今日 prepend 链逐步追踪：`text` → notes:block+text → dispatch:dc+block+text（或 gateway:GW_PREFIX+block+text）→ goal:goalNote+... → suffix:...+suffix
- 设计 `renderPrompt` = `layers.sort(order).map(text).join('') + userText + suffix` = `goal(10) + (dispatch|gateway)(20) + notes(30) + userText + suffix`
- 两者逐字节相同
- `buildGatewayPrompt(x) = GW_PREFIX + x`（纯前缀），`buildGatewayPrompt('') + notes + text === buildGatewayPrompt(notes + text)`，wrap 还原正确

### 总等价结论

**payload（stdin 内容）**：真实会话下逐字节等价。若各上下文层触发（autoDispatch=true / 有 pendingNotes / 有 goalLimits / type=gateway），仍逐字节等价（同函数、同拼法、同尾分隔符、`join('')` 无额外分隔符）。

**spawn argv**：除 intentional bugfix（streaming `--settings` drift 修复）外，存在 1 处行为中性差异（flag 顺序互换）和 2 处仅影响非真实会话的差异（codex reasoning effort / model 来源、streaming `--max-turns`）。codex/opencode/zcode 的 model raw→resolved 是 major 行为变更，需在设计文档显式标注为 bugfix 或回退。

---

## 8. 用户审阅清单

以下 5 条是"最该仔细看的点"，按重要性排序：

1. **顺序不变量**：`renderPrompt` 的 `layers.sort(order).map(text).join('') + userText + suffix` 是否忠实复刻今天的 prepend 链？关键验证点——今天的 prepend 顺序是 notes（最先，变 block+text）→ dispatch/gateway（其次，前置或 wrap）→ goal（最后前置，最左）→ suffix（末尾追加），最终 = `goalNote + (dc|GW_PREFIX) + notesBlock + text + suffix`。envelope 的 order 排序（goal:10 < dispatch/gateway:20 < notes:30 < userText < suffix）与此一致。特别注意 gateway 的 wrap 还原：`buildGatewayPrompt('') + notes + text === buildGatewayPrompt(notes + text)`（因 `buildGatewayPrompt(x) ≡ buildGatewayPrompt('') + x`）。

2. **gateway WRAP vs dispatch PREFIX 方向差异**：今天对 gateway 用 `buildGatewayPrompt(promptText)`（WRAP，promptText 塞进 block 尾部），对 dispatch 用 `dispatchContext + promptText`（PREFIX，外部前缀）。envelope 对两者建模不同——gateway 的 layer.text = `buildGatewayPrompt('')`（仅 system block），dispatch 的 layer.text = `dc` 本身——但经 `renderPrompt` 拼接后均逐字节还原。审阅时确认 gateway layer 不含 userText（userText 由 renderPrompt 的 `+ envelope.userText` 提供），而 dispatch layer 也不含 userText（同理）。

3. **streaming 句柄不变**：envelope 的 `claude.shape` 在 streaming 模式下**省略 session 句柄**（`if (so.mode === 'per-turn')` 块不执行）。`_streamSessionId` 的生成、`s.started` 标志的读写、`--session-id`/`--resume` 的决策全部留在 `spawnProc`，与今天完全相同。审阅时确认 `runChatTurnStreaming` 改造版（MESSAGE_BUILDER_DESIGN.md:302-338）仍调用 `chatStream.ensure` 且 `spawnProc` 仍用 `[...s.spawnArgs, ...sessionArgs]` 追加句柄。

4. **副作用位置**：cross-agent-notes 的 5 项副作用（mark delivered → saveNotes → appendEvent → workspaceBroadcast → chatBroadcast）留在 `composeMessage` 内（非纯函数），在构造 notes 层 text 之后同步执行。审阅时确认：(a) 副作用未拆到调用方；(b) `bare=true` 路径（codex-continue / retry）跳过 `composeMessage` 故不执行副作用；(c) golden 测试只验 text，副作用由集成测试覆盖。

5. **codex 首轮 systemBlock 重建**：envelope 通过独立 `imgHint` 字段（嫁接自方案 A3）重建 codex.js:19 的 `[multiccImgHint, envConstraint, [角色设定]rolePrompt]` 分块结构。审阅时确认：(a) `envelope.imgHint` 与 `envelope.systemPrompt` 是独立字段（imgHint 不被合进 systemPrompt，否则 codex 无法重建分块）；(b)首轮 `prefixes.join('\n\n') + '\n\n' + renderPrompt(envelope)` 与今天 `firstTurnPrompt` 逐字节一致；(c) 同时关注 codex 的 `model_reasoning_effort` 与 model 来源两处 major divergence（差异 C/D），确认是否为有意的 bugfix。