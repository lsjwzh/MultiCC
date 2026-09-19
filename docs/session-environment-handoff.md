# 会话执行环境 Handoff（bundle v2）

> 目标：一个会话把任务跑通沉淀之后，团队其他成员能通过一个加密文件导入
> 必要的执行环境——记忆、技能、上下文依赖——直接在他们的机器上继续任务。

## 概览

`GET /api/sessions/:id/bundle` 导出一个 AES-256-GCM 加密的 JSON bundle，
`POST /api/sessions/import` 在目标机器上重建会话。v1 携带聊天历史、私有记忆、
provider 状态和 worktree 分支的 git bundle；v2 在此之上补齐「执行环境」：

| 载荷 | v1 | v2 |
|---|---|---|
| 聊天历史 / 会话元数据 | ✅ | ✅ |
| 私有记忆文件 | ✅（`memoryFiles`） | ✅（同时进 `memoryScopes.session`） |
| 记忆瀑布其余 scope（shared / task / cli / machine） | ❌ | ✅ `memoryScopes` |
| 被引用的技能（整个技能文件夹） | ❌ | ✅ `skills` |
| 对话引用的本地文件（上传的图片/附件、本地图片引用） | ❌ | ✅ `assets`（导入时重写历史路径） |
| 上下文依赖清单（仓库远端、分支、CLAUDE.md/AGENTS.md、provider env 键名） | ❌ | ✅ `contextDeps` |
| provider 状态 / git bundle | ✅ | ✅ |
| 导入后落 `HANDOFF.md` 移植说明 | ❌ | ✅ |

## 导出

```bash
curl -s "$MULTICC_BASE_URL/api/sessions/<id>/bundle?passphrase=<≥6位口令>" \
  -H "Authorization: Bearer $ACCESS_TOKEN" > bundle.json
```

可选 query：

- `scopes=session,shared,task` — 携带的记忆 scope，默认 `session,shared,task`；
  也可加 `cli,machine`（机器特有层，跨机器移植时通常不需要）。
- `skillsMode=auto|explicit|none` — 技能选择：`auto`（默认）扫描携带的记忆与
  最近 300 轮对话，自动找出被引用的技能名并打包整个技能文件夹；`explicit`
  只打包 `skills=` 列出的；`none` 不带技能。
- `skills=a,b,c` — 显式技能清单（出现时默认切到 `explicit`）。

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

```bash
curl -s -X POST "$MULTICC_BASE_URL/api/sessions/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d @- <<'EOF'
{ "salt": "...", "iv": "...", "ct": "...", "tag": "...",
  "passphrase": "<导出口令>", "dirId": "<目标目录id>",
  "label": "可选标签", "targetProviderId": "可选：挂到本机已配置的 provider" }
EOF
```

前置条件：目标机器已登记同仓库的目录（git fetch 需要落脚点）。导入行为：

- **聊天历史**：写入新会话。
- **记忆**：`shared` scope 写入目标项目的公共记忆文件夹，**同名文件以本地为准**
  （绝不覆盖团队已有知识）；`task`/`cli`/`machine` 折进新会话私有记忆文件夹，
  加 `task-`/`cli-`/`machine-` 前缀，下一次原生会话构建上下文即可见。
- **技能**：安装到 `~/.agents/skills/<name>/`（规范仓），随即触发 skill-sync
  分发 symlink 到各 CLI。同名且内容相同 → 跳过；同名但内容不同 → 装为
  `<name>-imported`，绝不覆盖本机已有技能；不安全名称 / 路径穿越 / 缺
  SKILL.md → 拒绝。
- **git**：源分支独有的提交 replay 到新 worktree（cherry-pick 或保留拓扑）。
- **HANDOFF.md**：写入新会话私有记忆，记录来源仓库与远端、分支、provider
  线索（凭据不随包传播，见 `.handoff-provider.json`）、各 scope 记忆恢复
  明细、技能安装结果、以及重建上下文的建议步骤。

返回的 `restored` 字段给出每一项的落地明细（written/skipped、gitNote 等）。

## 安全模型

- bundle 整体用口令派生密钥（PBKDF2 200k 轮）加密，可走邮件/网盘/syncthing。
- provider 凭据不会自动注入目标机器的 provider 池；codex 的 auth/config 只
  存进会话记忆里的 `.handoff-provider.json` 供手动接线。
- `contextDeps.envKeys` 只带环境变量**名称**，不带值。
- 导入的文件名/路径经过白名单校验，拒绝 `..`、绝对路径、反斜杠与控制字符。

## 已知边界

- 目标机器需已登记同仓库目录；无 origin 远端时 `repoRemote` 为空，靠目录
  路径提示人工对齐。
- 自动技能检测基于名称匹配（记忆与近 300 轮对话），内置共享规则种子文本
  已从检测语料中剔除，不会把随发行版自带的 `multicc-artifact` 误打包。
- v1 旧 bundle 仍可导入（按 v1 行为恢复，无 scope/技能/HANDOFF.md）。

相关实现：`src/routes/session-bundle.js`（路由）、
`src/session/handoff-env.js`（采集/恢复层）、
`tests/test-handoff-env.js`（单测）、`tests/test-session-bundle-api.js`
（隔离 HTTP 集成测试）。
