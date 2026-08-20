<p align="center">
  <img src="public/icon.svg" width="120" height="120" alt="MultiCC Logo" />
</p>

<h1 align="center">MultiCC</h1>

<p align="center">
  <strong>一个对话，六个 AI 编程 CLI。任务进行到一半也能随时切换，上下文不丢。</strong>
</p>

<p align="center">
  <em>Claude Code · Codex · OpenCode · ZCode · Kimi Code · Qoder —— 同一个聊天、同一个仓库、同一件事。<br/>
  多个会话并行跑在互不干扰的 git worktree 里，桌面、手机、微信都能操控。</em>
</p>

<p align="center">
  <a href="README.md">English README</a>
</p>

---

> 这是一份**中文导引**，不是英文 README 的逐句翻译。完整的技术细节都在 [`docs/`](docs/) 下的分主题文档里（目前以英文为主）。

## 一句话定位

MultiCC 是一个自托管的编排层：把你本机已经装好的 AI 编程 CLI，变成可以**并行、可切换、跨设备访问**的会话平台。

## 核心卖点：多 CLI 同上下文切换

你已经和 Claude Code 聊了三个小时做重构。这时你想让 Codex 给个第二意见，或者 Anthropic 额度用完了，又或者接下来那段机械活儿用 GLM 更便宜。

通常这意味着：开新终端、开新会话、把来龙去脉再讲一遍。

在 MultiCC 里这是一次点击。**对话是你的**，CLI 只是当前驱动它的引擎。

### 切过去时，什么会带走

MultiCC **不会**把一家厂商的对话记录翻译成另一家的格式——那种做法的信息损失无法审计。它的做法是：每个 CLI 保留**自己的原生会话**，会话之间的连续性由一份**有界的、纯可见文本的 checkpoint** 提供。

| ✅ 会带走 | ❌ 不会带走 |
|---|---|
| 最近 16 条消息 / 12000 字符以内的可见对话 | 源 CLI 的隐藏内部状态 |
| 任务状态：目标、阶段、最新摘要 | 另一家厂商的 system prompt、缓存推理 |
| Git 快照：HEAD、分支、工作区改动 | 源 CLI 从未打印出来的任何东西 |
| 你的工作目录和 git worktree（不变） | |

接收方 CLI 会在 prompt 里被明确告知：**不要声称自己能访问源 CLI 的隐藏状态**。

### 切回来时，会接着原来的会话

每个 CLI 都记着自己的原生会话 id、模型、思考强度、provider、子 agent 路由。Claude → Codex → Claude 切回来，回到的是**那个已经存在的 Claude 会话**，并补上一份涵盖这期间发生了什么的新 checkpoint —— 而不是一张白纸。想要白纸就传 `fresh: true`。

清空对话会同时作废**全部六个** CLI 的原生会话，所以切换永远不会把你刚删掉的上下文又捞回来。

### 缺哪个 CLI，切换弹窗里一键装

切换弹窗会显示：哪些 CLI 已安装、哪些已有会话，并为缺失的提供一键安装（`claude`、`codex`、`opencode`、`kimi`、`qoder`；ZCode 的 CLI 内置在其桌面版里，需要手动装）。

**→ 完整说明：[Multi-CLI switching](docs/cli-switching.md)**

> 多 CLI 切换只适用于**聊天（chat）会话**。终端会话创建时用的哪个 CLI 就固定是哪个。

---

## 还有什么

| | |
|---|---|
| 🧵 **真并行** | 每个会话独占一个 git worktree，分支 `multicc/<会话id>`。六个 agent 同仓库互不打架，合回主分支时有语法校验把关，合并后自动同步兄弟 worktree。 |
| 💸 **子 agent 省钱** | 主 agent 用前沿模型，子 agent 通过本地 provider router 路由到 DeepSeek / GLM / Qwen。同一个仓库、并行跑、成本只有零头。 |
| 📱 **会话比客户端活得久** | 合上笔记本，手机上接着看。终端会话跑在 `tmux` 里，聊天会话是有状态的轮次。 |
| 🗣️ **语音，包括全双工** | 可以口述 prompt，也可以像打电话一样和 agent 实时语音对话（支持插话打断）。本地 ASR 用 sherpa-onnx SenseVoice，不走云端。 |
| 🔔 **它会来找你** | Web Push、Bark、Webhook，以及微信、飞书、Telegram、Discord、Slack 五个 IM 桥接。 |
| 🌐 **多端一个后端** | 桌面终端、网页聊天、PWA、原生 Flutter App（Android / iOS）。 |

---

## 快速上手

### 1. 安装

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v1.3.0/install.sh | bash -s -- --branch v1.3.0
```

脚本会自动识别系统、检查依赖、克隆仓库、现场构建可下载的 Android APK、装依赖、生成 `ACCESS_TOKEN`，并可选注册为后台服务（macOS `launchd`）。纯服务器安装可传 `--no-apk`。

**前置要求**：Node.js **>= 20.19**、`tmux`（仅终端模式需要）、以及至少一个已登录的编程 CLI 在 `PATH` 上。默认安装还需要 Flutter >= 3.8 及 Android 工具链；不需要 APK 时传 `--no-apk`，以后可运行 `./multicc apk` 补建。

### 2. 启动

```bash
cd MultiCC
./multicc start
```

打开 **<http://localhost:3000/manage>**。

> MultiCC 默认只绑定 `127.0.0.1`。想让别的设备访问，必须在 `.env` 里**同时**设置 `HOST=0.0.0.0` 和 `MULTICC_ALLOW_REMOTE=1`，否则服务会拒绝启动（这是刻意的 fail-closed 设计）。

### 3. 30 秒体验到「多 CLI 切换」

1. 在 `/manage` 里**添加一个目录**，指向任意 git 仓库。
2. **新建聊天会话**，选 `claude`（或你装了的任意一个 CLI）。
3. 问一个真实问题：*「总结这个项目是干什么的，并列出三个风险最高的文件。」*
4. 等它回答完，点聊天头部的 **CLI 徽标**，换一个 CLI。
5. 追问：*「你现在是另一个模型了——你同意刚才那个判断吗？」*

第二个 CLI 会带着完整上下文回答，仍在同一个分支和 worktree 上，并且会说明自己是基于交接 checkpoint 在工作。切回去，第一个 CLI 会接着它自己的会话继续。

然后在手机上打开同一个地址，或装上 [Flutter App](docs/installation.md#build-the-flutter-app)——会话就在那儿，对话还在半路上。

### 4. 后续更新

```bash
./multicc update           # 拉最新代码、按需重装依赖、重启
./multicc update --force   # 无论工作区什么样，都落到远端那份代码上
```

日常的脏工作区不带参数的 `update` 自己就能处理：dev 渠道下它会先把改动 stash 成 `multicc-auto-update`，快进 `main`，再 pop 回来。`--force` 是给这样处理不了的情况准备的——pop 回来时和刚拉下来的代码冲突、stable 渠道的 `git checkout <tag>` 因为本地改动而拒绝、或者你的分支上有本地提交、不带参数的 `update` 只会说一句「nothing to update」。加上它就一定落到远端那份代码：工作区的全部改动（**包括未跟踪文件**）先备份进一个带标签的 `multicc-force-update-<时间戳>` stash，然后强制切换（dev 渠道是 `git reset --hard origin/main`，stable 渠道是 `git checkout -f <tag>`）。**不会删任何东西，但也不会自动恢复** —— 更新后你拿到的是一个干净的检出，本地改动请自己用 `git stash list` / `git stash pop` 取回。唯一的例外：stable 渠道下 `--force` 仍然只在有更新的 release 时才动手，已经在最新 tag 上时它会停下，并打印出让你手动执行的 `git checkout -f`。

也可以在网页里点：`/manage` **左侧栏底部的版本号** → 弹窗显示当前版本、最新版本和一个「强制更新」勾选框 → 确认后 MultiCC 就在后台跑同一个更新，日志实时显示在弹窗里，跑完自动重启服务、服务回来后自动刷新页面。更新失败时弹窗会保留完整输出，并提供「强制更新重试」。

**→ 安装参数、`./multicc` 服务管理命令、systemd 配置、App 编译：[Installation](docs/installation.md)**

---

## 配置速览

所有配置都在仓库根目录的 `.env` 里，安装脚本会帮你写好 `ACCESS_TOKEN` 和 `PORT`。

```env
PORT=3000
ACCESS_TOKEN=<安装脚本生成>

# 仅当需要被其它设备访问时——两个都必须设置
# HOST=0.0.0.0
# MULTICC_ALLOW_REMOTE=1
```

来自本机回环地址的请求会跳过 `ACCESS_TOKEN` 校验。MultiCC 只提供**明文 HTTP**，不自己做 TLS —— 公网访问请用 Tailscale Funnel（`/manage` → 隧道里内置）、ngrok 或你自己的反向代理。

Provider、子 agent 路由、语音、TTS/ASR、通知都在 `/manage` 里配；底层环境变量见 **[Configuration](docs/configuration.md)**。

---

## 常见问题

**MultiCC 提供 HTTPS 吗？**
不提供，它只在回环地址上跑明文 HTTP。麦克风、PWA 安装这类需要安全上下文的功能，请用 `http://localhost` 访问，或者走一个真正做了 TLS 的隧道。

**「此浏览器不支持录音」怎么办？**
`MediaRecorder` 需要安全上下文。本机用 `http://localhost:3000`，远程用 Tailscale Funnel / ngrok。直接用 `http://<局域网IP>:3000` 在任何现代浏览器里都拿不到麦克风权限。

**不用 Claude Code 行不行？**
行。六个支持的 CLI 里有任意一个就够了。

**切换 CLI 会立刻消耗 token 吗？**
不会。checkpoint 是排队等待的，随你的**下一条消息**一起送出。所以切完又反悔，一分钱不花。

**端口被占用了？**
在 `.env` 里换一个 `PORT`。自动顺延到下一个空闲端口只在开发模式（`NODE_ENV=development` / `MULTICC_DEV=true`）下发生。

**怎么更新？`update` 停下了 / 明明落后却说没得更新怎么办？**
`cd MultiCC && ./multicc update`；它停下来（stash pop 冲突、stable 渠道 checkout 被拒），或者你本地有提交、它只回一句「nothing to update」时，加 `--force`（`-f` 亦可）：

```bash
cd MultiCC && ./multicc update --force
```

它不会删东西——本地改动（含未跟踪文件）先进一个叫 `multicc-force-update-<时间戳>` 的 stash；但也**不会自动恢复**，更新后你拿到干净检出，改动用 `git stash list` / `git stash pop` 自己取回。更新末尾会重启服务。详见 **[后续更新](#4-后续更新)**。

**→ 完整 FAQ（英文）：[docs/faq.md](docs/faq.md)**

---

## 文档索引

| 文档 | 内容 |
|---|---|
| **[Multi-CLI switching](docs/cli-switching.md)** | 核心卖点：checkpoint 格式、会话复用语义、API、一键安装 |
| [Installation](docs/installation.md) | 安装参数、升级、`./multicc` 命令、systemd、App 编译 |
| [Configuration](docs/configuration.md) | 全部环境变量、provider、语音、通知 |
| [Features](docs/features.md) | 完整功能参考 |
| [Architecture](docs/architecture.md) | 仓库结构、消息流、设计决策 |
| [API reference](docs/api-reference.md) | REST 端点 + WebSocket 协议 |
| [Ecosystem comparison](docs/ecosystem-comparison.md) | 12 个同类项目横评，以及 MultiCC **不擅长**什么 |
| [FAQ](docs/faq.md) | 排错与常见问题 |
| [Tech stack](docs/tech-stack.md) | 运行时依赖及其用途 |

完整的文档索引（34 篇，含设计契约、语音、provider 路由、治理评审、模块化历史）在 **[docs/README.md](docs/README.md)**。

界面本身支持中英文切换，默认中文。

---

## 许可证

MIT。

---

<p align="center">
  <sub>为 Claude Code、Codex、OpenCode、ZCode、Kimi Code、Qoder 打造 · <a href="https://github.com/lsjwzh/MultiCC">github.com/lsjwzh/MultiCC</a></sub>
</p>
