# 会话执行环境 Handoff（bundle v2 / v3）

> 目标：**复刻执行环境**。一个会话把任务跑通沉淀之后，团队其他成员能通过一个
> 加密文件把它的记忆、技能、上下文依赖装到自己的机器上——历史只是上下文的一
> 部分，代码只在同一个仓库里才有意义。

## 三层结构

载荷按「换一台机器还成立吗」分三层，导入时各层去向不同：

| 层 | 内容 | 落到哪里 | 何时不落 |
|---|---|---|---|
| **env**（执行环境） | 技能文件夹、记忆瀑布各 scope（machine / cli / shared / task）、CLAUDE.md / AGENTS.md、仓库与分支事实 | **按来源 scope 原样归位**：machine → 本机全局记忆，cli → 该 CLI 的记忆，shared → 目标项目公共记忆，task 等窄 scope → 接收会话的私有记忆（带前缀）；技能 → `~/.agents/skills` | 永不需要会话；`envOnly` 导入只装这一层 |
| **context**（上下文） | 聊天历史、会话私有记忆、对话引用的本地图片/附件 | 新建会话，或 `targetSessionId` 指定的**已有会话**（追加到它自己的历史之后） | 导出时 `context=0` 不带；导入时没有接收会话就不落 |
| **code**（代码） | 源分支独有提交的 `git bundle` | 接收会话的 worktree（cherry-pick 或保留拓扑） | **两边 origin 指向不同仓库时整层跳过**，只留说明；`git=0` 导出不带 |

`meta.layers` / zip 里 `meta.json` 的 `layers` 字段（`{env,context,code}`）
说明这个包实际带了哪几层。

## 概览

两种容器格式，载荷与恢复路径完全相同：

- **JSON 容器（v1/v2）**：`GET /api/sessions/:id/bundle` 导出一个
  AES-256-GCM 加密的 JSON bundle，`POST /api/sessions/import` 导入。
- **zip 容器（v3，推荐）**：`GET /api/sessions/:id/bundle.zip` 导出一个
  真正的 zip 文件，`POST /api/sessions/import-zip` 导入。技能文件夹、
  对话引用的图片/附件、git bundle 以**真实文件**放在 zip 里（deflate 压缩，
  没有	base64 膨胀），聊天历史 / 记忆 / 上下文依赖仍在
  zip 内 `manifest.json` 条目里做 AES-256-GCM 加密。用任意 zip 工具就能
  打开看图片和技能。

v1 携带聊天历史、私有记忆和 worktree 分支的 git bundle；
v2 在此之上补齐「执行环境」；v3 只是换了更顺手的传输容器：

| 载荷 | v1 | v2/v3 |
|---|---|---|
| 聊天历史 / 会话元数据 | ✅ | ✅ |
| 私有记忆文件 | ✅（`memoryFiles`） | ✅（同时进 `memoryScopes.session`） |
| 记忆瀑布其余 scope（shared / task / cli / machine） | ❌ | ✅ `memoryScopes` |
| 被引用的技能（整个技能文件夹） | ❌ | ✅ `skills` |
| 对话引用的本地文件（上传的图片/附件、本地图片引用） | ❌ | ✅ `assets`（导入时重写历史路径） |
| 上下文依赖清单（仓库远端、分支、CLAUDE.md/AGENTS.md） | ❌ | ✅ `contextDeps` |
| git bundle | ✅ | ✅（zip 里是真实 `git.bundle` 文件） |
| provider 状态（源机 provider / env 值 / codex 凭据文件） | ⚠️ 旧包里有 | ❌ **已移除，见下** |
| 分层摘要 `layers`（`{env,context,code}`） | ❌ | ✅ |
| 导入后落 `HANDOFF.md` 移植说明 | ❌ | ✅ |

## 导出

### zip 容器（v3，推荐）

```bash
curl -s "$MULTICC_BASE_URL/api/sessions/<id>/bundle.zip?passphrase=<≥6位口令>" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -o multicc-handoff.zip
```

得到一个标准 zip（任何解压工具可打开）：`skills/`、`assets/`、`git.bundle`
是真实文件；`meta.json` 是明文摘要——格式与版本、导出时间、计数、**CLI 类型**
（接收方据此确认要装哪个 CLI）与 git 说明（基分支名，或「没带 git 载荷」的原因），
但**不含**会话 id、会话标签、磁盘路径与仓库远端；`manifest.json` 是加密的敏感
载荷（聊天历史、记忆、上下文依赖）。下载文件名用导出时间戳（
`multicc-handoff-<yyyymmdd-hhmmss>.zip`）而不是会话 id —— 文件名会流经浏览器
下载历史、代理日志与邮件附件，同样不能在明文里带身份。

### JSON 容器（v1/v2 兼容）

```bash
curl -s "$MULTICC_BASE_URL/api/sessions/<id>/bundle?passphrase=<≥6位口令>" \
  -H "Authorization: Bearer $ACCESS_TOKEN" > bundle.json
```

两种导出共用可选 query：

- `scopes=session,shared,task` — 携带的记忆 scope，默认 `session,shared,task`；
  也可加 `cli,machine`。以复刻执行环境为目的时这两层正是要带的：它们是跨项目、
  跨会话仍然成立的知识。
- `skillsMode=auto|explicit|none` — 技能选择：`auto`（默认）扫描携带的记忆与
  最近 300 轮对话，自动找出被引用的技能名并打包整个技能文件夹；`explicit`
  只打包 `skills=` 列出的；`none` 不带技能。
- `skills=a,b,c` — 显式技能清单（出现时默认切到 `explicit`）。
- `context=0` — 只导 env 层：不带聊天历史、会话私有记忆与对话引用的附件。
  注意技能自动检测仍然读对话（只是不带走），所以 `context=0` 不会削弱
  `skillsMode=auto` 的判断。
- `git=0` — 跳过 code 层（目标机器没有对应代码仓库、只想要
  记忆/技能/历史的场景）。

体积护栏：单文件 512KB、单技能 2MB、最多 20 个技能、git bundle 100MB，
对话引用资产单文件 5MB / 总量 20MB，超限项记入 `meta` 与 skipped 清单而不是
让导出失败。

**对话引用的文件（assets）**：聊天里上传的图片/附件实际存在系统临时目录
（`/tmp/multicc_*`，消息文本里只有路径），助手展示的本地图片
（`![](/path/x.png)`）也只是路径引用。导出时自动扫描消息里的这两类本地
路径，把仍存在的文件以 base64 收进 bundle；导入时恢复到目标机临时目录
（`multicc_handoff_*`），并把**导入后历史消息里的路径重写为新位置**，图片
在队友的会话里照常显示。映射表记入 HANDOFF.md。已不存在的引用（源机器
临时文件被清理）记为 skipped，不会让导出失败。markdown 里引用的非图片
本地文件出于安全不携带（防止把任意本机文件打进可传播包）。

## 导入

### zip 容器

```bash
curl -s -X POST "$MULTICC_BASE_URL/api/sessions/import-zip" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/zip' \
  --data-binary @multicc-handoff.zip \
  "?passphrase=<导出口令>&dirId=<目标目录id>&label=可选标签"
```

只装执行环境（不建会话、不需要目录）：把 query 换成
`?passphrase=<导出口令>&envOnly=1`；并进某个已有会话：换成
`?passphrase=<导出口令>&targetSessionId=<会话id>`。

### JSON 容器

```bash
curl -s -X POST "$MULTICC_BASE_URL/api/sessions/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d @- <<'EOF'
{ "salt": "...", "iv": "...", "ct": "...", "tag": "...",
  "passphrase": "<导出口令>", "dirId": "<目标目录id>",
  "label": "可选标签", "targetProviderId": "可选：挂到本机已配置的 provider" }
EOF
```

同样支持 `"envOnly": true`（此时 `dirId` 可省）与
`"targetSessionId": "<会话id>"`（此时 `dirId` 可省，跟随该会话自己的目录）。

### 三种导入目标

| 参数 | 行为 | 需要的东西 |
|---|---|---|
| （默认）`dirId` | 新建一个会话承接 context 与 code 层 | 目标机器已登记一个目录；带 code 层时它得是同一个仓库 |
| `targetSessionId` | context 层**追加**进一个已有会话，code 层 replay 到它自己的 worktree | 该会话存在且不是 aux / gateway 系统会话 |
| `envOnly`（JSON 用 `true`，zip 用 `1`） | **只装 env 层**：技能 + 记忆归位，不建会话、不动历史 | 什么都不需要（`dirId` 可省；给了就会顺带恢复该项目 shared 记忆） |

`dirId` 只在默认路径上必填；三种目标都不填时返回 400 并说明可选项。

各层落地行为：

- **记忆（env）**：每个 scope 写回它自己的目录——`machine` → 本机全局记忆
  （`<memoryRoot>/_machine`）、`cli` → 该 CLI 的记忆（`<memoryRoot>/_cli/<cli>`）、
  `shared` → 目标项目公共记忆、`task` 等窄 scope → 接收会话私有记忆并加
  `task-` 前缀。**同名文件一律以本地为准**（重复导入幂等，绝不覆盖团队/本机
  已有知识）；无法归位的 scope（比如 `envOnly` 且没给目录时的 `shared`、没有
  接收会话时的 `task`）在报告里记一条 `*` skipped，不静默丢弃。
  写进 machine / cli / shared 的文件会带一行 HTML 注释说明来源会话、CLI 与
  导出时间：这三层是**全局注入**的指令文本，来自另一台机器的内容必须能和本机
  自己写的区分开。
- **技能（env）**：安装到 `~/.agents/skills/<name>/`（规范仓），随即触发
  skill-sync 分发 symlink 到各 CLI。同名且内容相同 → 跳过；同名但内容不同 →
  装为 `<name>-imported`，绝不覆盖本机已有技能；不安全名称 / 路径穿越 / 缺
  SKILL.md → 拒绝。
- **聊天历史（context）**：默认写入新会话；`targetSessionId` 时先读本机已有
  历史再追加导入的条目，用一次 `replace()` 落盘（逐条 `append()` 会按条重写
  整个文件）。导入消息的源 `id` 会被丢掉、由本机重新分配——两台机器的 id
  计数器互相独立，带着源 id 并入可能和已有消息撞号。
- **git（code）**：先比对仓库身份——把两边的 origin 归一成
  `host/owner/repo`（scp / ssh / https 三种写法视为同一个仓库）。**不同仓库
  直接跳过 replay**，`gitNote` 写明 `skipped: this directory is a different
  repository (源 → 目标)`；任何一边没有 origin 时归一失败，视为「判断不了」
  而不是「不同」，仍然尝试 replay，由 git 仲裁（无共同祖先 → 自动 abort，
  worktree 不受影响）。同仓库时源分支独有的提交 replay 到接收会话的 worktree
  （cherry-pick 或保留拓扑），已经 replay 过的提交不会重复落。
- **HANDOFF.md**：有接收会话时写入它的私有记忆，记录来源仓库与远端、分支、
  模型、各 scope 记忆恢复明细、技能安装结果、以及重建上下文的建议步骤。
  `envOnly` 不写清单——没有会话目录可放，而全局记忆目录会被注入每个会话的
  上下文，逐次导入的说明放在那里只是噪音；同样的明细在 HTTP 响应里。
  provider 一律不随包，目标机用自己的 provider 承接（见
  「Provider 不随包传播」）。

返回体带 `mode`（`create` / `merge` / `env`）与 `sessionId`（`env` 时为
`null`）；`restored` 字段给出每一项的落地明细（written/skipped、gitNote 等）。

### Provider 不随包传播

bundle 不带任何 provider 信息：源会话挂在哪个 provider、该 provider 注入的
环境变量（键名与值都不带）、codex 的 `auth.json` / `config.toml` 一律不出源机。
**目标机器用自己的 provider 承接这次 handoff**：导入时 `targetProviderId`
指向本机已配置的 provider；不指定则走 `createSessionRecord` 的常规默认
（该 CLI 的本机默认 provider / 默认登录）。
包里的 `sessionMeta.model` 仍会随包并写进新会话——若源模型在本机 provider
上不存在（源机可能用的是另一家线路），导入后请在会话设置里改成本机可用的
模型，否则会拿跨 provider 的模型名去请求。

要区分清楚的是 **CLI 类型**（`claude` / `codex`）：它仍然随包并在导入时沿用，
因为它不是 provider 选择，而是这次 handoff 要落到哪个 CLI 上；`targetProviderId`
指向的 provider、以及不指定时取的「本机默认 provider」，也都是按这个源 CLI 取的。
两个导入入口目前只有 `targetProviderId`，没有 `targetCli`。

被移除的旧行为：v1 起 payload 里带 `providerState`（`providerId` /
`providerName` / 逐字的 spawn env / codex 凭据文件），导入时又把它明文写成
新会话记忆目录里的 `.handoff-provider.json`。那份文件没有任何代码读回，
却把**凭据值**落在了目标机磁盘上（claude 线路的 `ANTHROPIC_AUTH_TOKEN`、
codex 的 `OPENAI_API_KEY` 与整份 codex home 副本），而生成的 HANDOFF.md 还
声称「凭据不随包传播」——文案与事实相反。旧 bundle 里残留的 `providerState`
字段导入时被直接忽略，不会再落任何文件。

### 导入副本是任务无关的（task-agnostic）

消息上的任务归属字段是**机器本地**的：`taskId`、`taskName`、`taskShortCode`、
`taskStart`、`taskSource`、`taskText`、`auxRunId` 描述的是源机器上发生的活儿。
导入时这一族会被整体剥掉，理由是它们在目标机器上指向不存在的任务，而在
**同实例重导入**时更糟——它们指向本机真实存在的任务，于是历史保留策略
（`TASK_HISTORY_REFERENCED`）拒绝释放这个从未属于那些任务的会话，看板/会话
删除级联都做不完。`force` 永远不绕保留策略，所以只能在导入侧去掉。

去掉 `taskId` 会同时关掉 `isMessageProtected` 的保护，而重试去重
（`normalize()` 的前缀包含折叠）只保护被 taskId 保护的消息——本地留着的一对
前缀包含 assistant 消息（比如一次重试的前后两版）会在导入后静默丢掉一条。
因此导入的 assistant 条目额外打上 `_handoffArchive` 标记，去重判定认这个标记。
它是落盘字段，重启后读路径重跑 `normalize()` 仍然生效（源机器已经决定留下
什么，导入只负责原样搬过来）。

## 安全模型

- 敏感载荷（聊天历史、记忆、上下文依赖文件）无论哪种容器都用
  口令派生密钥（PBKDF2 200k 轮）+ AES-256-GCM 加密，可走邮件/网盘/syncthing。
- zip 容器中技能文件夹、图片附件、git bundle 是明文真实文件——它们本来
  就是要分发给队友的内容；口令保护的是对话与记忆。
- provider 选择、环境变量与凭据都不在包里（见上「Provider 不随包传播」），
  目标机用本机 provider 承接。
- 记忆 scope 采集只收普通文件、跳过点文件（`.handoff-provider.json` 这类
  历史残留不会被再带走一轮）；会话 fork 复制私有记忆目录时用同一规则
  （残留凭据不会在会话之间增殖），导入侧对旧包里的同名点文件同样按名拒绝。
- 记忆归位到 machine / cli / shared 意味着这些文本会被注入**导入者没有挑选的
  会话**当指令用，所以：来自另一台机器的文件一律带来源注释（渲染时不可见、
  读原文时可见，而上下文构建读的正是原文），同名文件本地永远优先，导入不会
  覆盖本机/团队已有记忆。窄 scope 只进接收会话自己的私有目录，不外溢。
- 导入的文件名/路径经过白名单校验，拒绝 `..`、绝对路径、反斜杠与控制字符；
  zip 读取层额外校验每个条目的 CRC32、条目数与总解压体积上限（防压缩炸弹），
  拒绝 zip64。

## 已知边界

- 只有默认（新建会话）目标需要已登记目录；`envOnly` 什么都不需要，
  `targetSessionId` 跟随该会话自己的目录。带 code 层导入到一个**没有 origin
  远端**的目录时，仓库身份判断不了（`repoRemote` 为空），仍会尝试 replay 并
  由 git 仲裁；此时靠目录路径提示人工对齐。
- 自动技能检测基于名称匹配（记忆与近 300 轮对话），内置共享规则种子文本
  已从检测语料中剔除，不会把随发行版自带的 `multicc-artifact` 误打包。
- v1/v2 旧 bundle 仍可导入，但按**当前**分层规则落地：没有 `layers` 字段的包
  按它实际带了什么算，`memoryScopes` 里的 machine/cli 记忆同样归位到全局层
  （不再折进新会话私有目录）。
- JSON 容器（v1/v2）响应体里的 `meta` 是**明文**的：`sessionId`、`label`、
  `repoRemote`、技能名与各项计数都在里面——它是给调用方看的「包里有什么」摘要。
  zip 容器刻意不含这些身份字段（见上文「导出」）。跨机器分发、且明文面越小越好
  时请用 zip 容器。
- CLI 类型随包且导入时强制沿用（导入参数只有 `dirId` / `targetProviderId` /
  `label` / `targetSessionId` / `envOnly`，没有 `targetCli`），导入前也不检查目标机是否装了该 CLI：源机用
  `claude`、目标机只装了 `codex` 时，导入仍会成功并留下一个装好 CLI 之前
  跑不起来的会话。
- zip 容器由内置的最小 zip 实现（`src/session/handoff-zip.js`）读写，支持
  store/deflate；已验证与系统 unzip 互操作。
- 已在两个**真实在线实例**之间跑过双向实测（Docker 任务壳实验环境 ↔ 本机主
  实例，各自 ~1.1 MB 包）：记忆/技能/HANDOFF.md/worktree/图片附件全部落地，
  消息内容逐条比对一致（唯一差异是源会话当时正在进行中的那条流式消息）。
  任务归属剥离是在这次实测里发现并补上的——见上文「导入副本是任务无关的」。

相关实现：`src/routes/session-bundle.js`（路由）、
`src/session/handoff-env.js`（采集/恢复层）、
`src/session/handoff-zip.js`（zip 容器层）、
`tests/test-handoff-env.js`、`tests/test-handoff-zip.js`（单测）、
`tests/test-session-bundle-api.js`（隔离 HTTP 集成测试，两种容器都覆盖）。
