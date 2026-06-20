---
name: multicc-artifact
description: multicc 自带「临时产物」技能。把一段 HTML 网页或任意文件发布成一个临时链接，用户在 multicc 聊天里点一下就能打开（网页直接渲染、文件可预览或下载），无需登录、手机经隧道也能开。当你想给用户一个「可视化网页 / 报表 / 图表 / 预览页」，或产出 csv/json/pdf/zip 等文件并给下载链接，或用户说「做个网页给我看」「生成个临时页面/文件」「给我个能打开的链接」时使用。仅用于临时、可丢弃的产物；正式文件请直接写进项目目录。
---

# multicc-artifact

本技能由 multicc 随安装自动铺设到 `~/.claude/skills/`。它让你把内容发布成一个**临时链接**交给用户。

运行环境由 multicc 注入：
- `MULTICC_BASE_URL` — multicc 本机 API 地址（默认 `http://127.0.0.1:3000`）

原理：内容写到 `~/.multicc/artifacts/<随机id>/<文件名>`，multicc 服务端在 `/artifacts/<id>/<文件名>` 提供访问。随机 id 本身就是访问凭证（像分享链接），所以链接**免登录**、本机和隧道外网都能打开。产物会在 7 天后自动清理——只用于临时、可丢弃的东西。

## 工具

技能目录下的 `bin/artifact`（Node 脚本，用 Bash 调用）。若不确定路径，先 `ls` 本技能目录；常见为 `"$CLAUDE_SKILL_DIR"/bin/artifact`。

```bash
# 发布一个网页（HTML）。内容从 stdin 或 --from 文件读取。
echo '<h1>销售周报</h1><p>本周 GMV…</p>' | artifact page --title 周报
artifact page --from /tmp/report.html          # 已是完整 HTML 文件

# 发布一个文件（下载/预览）。--download 让点击直接下载。
artifact file --from /tmp/data.csv --name data.csv --download
cat result.json | artifact file --name result.json

# 管理
artifact list          # 列出现有临时产物
artifact rm <id>       # 删除某个
```

要点：
- `page`：发布 .html，浏览器直接渲染。若传入的是 HTML 片段（没有 `<html>`），脚本会自动套一个带 UTF-8、移动端适配、浅/深色样式的外壳；传入完整 HTML 则原样发布。
- `file`：发布任意文件，浏览器内联预览；加 `--download` 则点链接直接下载。图片类（png/jpg/svg…）也可以选择用图片内联（见下）。
- 多文件网页：命令会打印**素材目录**路径，把 `style.css`、`app.js`、图片等放进同一目录，HTML 里用相对路径（如 `./style.css`）引用即可一起被访问。复用同一目录用 `--id <id>`。

## 把链接交给用户

命令会打印一条可直接粘贴的 Markdown，**用相对 URL**（如 `/artifacts/<id>/index.html`）。把它放进你给用户的回复里即可：

- 网页 → `[👉 打开网页](/artifacts/<id>/index.html)`
- 文件 → `[⬇️ 下载 data.csv](/artifacts/<id>/data.csv?download=1)`

务必用打印出来的**相对路径**（以 `/artifacts/` 开头），不要用 `http://127.0.0.1:3000/...` 的绝对地址——那样用户在手机/外网点不开。

## 什么时候用哪种方式

- 要给用户**看**一个页面（图表、看板、富文本报表、HTML 预览）→ `artifact page`。
- 要给用户一个**文件**（导出 csv/json、生成 pdf/zip）→ `artifact file`。
- 只是给用户**看一张本地图片**（截图、生成的图）→ 不必用本技能，直接在回复里写 `![说明](图片绝对路径)`，multicc 前端会自动内联显示。
- 是项目里要长期保留的正式文件 → 直接写进项目目录，不要用本技能（产物会被自动清理）。
