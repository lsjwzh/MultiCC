# 本地语音识别（Local ASR）

`src/voice/asr-local.js` 用 sherpa-onnx 在 Node 进程内跑 **SenseVoiceSmall int8**（阿里
FunASR/FunAudioLLM 家族模型），替代云端 Whisper API 的跨境往返。

> ⚠️ **平台下限**：`sherpa-onnx-node` 的 `darwin-x64` 预编译二进制要求 **macOS 15+**
> （`darwin-arm64` 同样偏新），而且它是原生 addon，无法在更老的系统上编译回退。
> 因此 macOS 11–14 上本地 ASR 不可用：`isAvailable()` 为 false，语音输入/流式通道
> 自动回退云端 Whisper，其它功能不受影响。独立版（[standalone.md](standalone.md)）在
> 这些老机器上就是走这条回退路径。
>
> 这类机器**不会**去下那 229MB：addon 探测失败时状态直接是 `unsupported`，自动下载跳过，
> 面板上也没有下载按钮（下下来也加载不了）。

## 为什么

| | 云端 whisper-large-v3-turbo (OpenRouter) | 本地 SenseVoice (M4) |
|---|---|---|
| 8-12s 语音延迟 | 400-3700ms（国内网络长尾严重） | **180-280ms** |
| 41s 长语音 | 3.7s | 0.9s |
| 中文准确率 | 相当 | 相当（英文专有名词稍弱，靠词表纠错补） |
| 网络/费用 | 需要 API key，按量计费 | 无 |

RTF ≈ 0.018（M4，2 线程）：1 秒音频约 18ms 推理。

## 安装（新机器）

addon 跟着 `npm install` 一起来（`package.json` 已含 `sherpa-onnx-node`，macOS arm64 有
预编译），**权重不会**：`~/.multicc/asr-models` 里那 ~229MB 需要单独取一次。三条路都通向
同一个目录，取一次就够：

| 路径 | 什么时候用 | 怎么做 |
|---|---|---|
| **① 首次启动自动下载**（默认） | 新机器第一次装完 | 什么都不用做。服务起来 8s 后自己后台拉，拉完自动预热（本机不支持 addon 时自动跳过） |
| **② 语音设置面板一键下载** | 自动那次失败了，或想手动重来 | Air → 语音设置 → 「本地语音模型」→ 下载（可取消、可重试，带进度/速度/剩余时间） |
| **③ 命令行脚本** | 完全离线/受限网络，或没有 web 面板 | `bash scripts/setup-local-asr.sh`（独立包里也在 `app-server/scripts/`） |

三者的下载源与落盘位置完全一致（HuggingFace 主源 → hf-mirror 镜像；VAD 走 GitHub
Release → gh-proxy 镜像），都是**可续传**的：中断后重来会从 `.part` 的断点接着下，不会
从 0 开始。下载器是 `src/voice/asr-model-installer.js`，服务端单飞 + 跨进程锁
（`.download.lock`，6 小时视为陈旧可抢占），所以两个 server 共用一个 `~/.multicc` 也不会
下两份。

关掉自动下载：`ASR_LOCAL_AUTO_DOWNLOAD=off`（`ASR_LOCAL=off` 也会一并关掉，见下表）。
CI 容器正是靠 `ASR_LOCAL=off` 保证门禁不会去拉这 229MB。

验证：`GET /api/settings/voice` → `asr.status.local.ready === true`，同一条里
`asr.status.local.download.state` 是 `ready` / `missing` / `downloading` / `failed` /
`unsupported` / `disabled` 之一；
`POST /api/voice/stt` 返回 `engine: "local"`。
测试：`node tests/test-local-asr.js`（可加 `--typeless 8` 跑真实录音对比基准）；
下载器本身是 `node --test tests/test-asr-model-installer.js`（全部走注入的假 fetch，不联网）。

## 接入点

- **HTTP 批量转写** `POST /api/voice/stt`（web chat 麦克风 + Flutter 通话模式的主路径）：
  本地就绪时优先本地（WAV 直接解析，webm/mp4/ogg 走 ffmpeg 解码 ~20ms），
  任何失败自动回退云端 Whisper（云端路径新增 30s 超时）。
- **流式通道** `WS /ws/voice`：新增 `local` provider（silero-VAD 切句 + 分段出终稿，
  段间静音 250ms 判定）。`ASR_PROVIDER=auto`（新默认）时本地就绪即优先本地。
- 用户纠错词表（whisper_vocab.json）：SenseVoice 无解码期热词，改为转写后
  ASCII 术语正则纠错（"multi cc" → "multicc"），沿用同一份词表。

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASR_LOCAL` | `auto` | `auto`=模型存在即用；`off`=禁用（回到纯云端，同时关掉自动下载） |
| `ASR_LOCAL_AUTO_DOWNLOAD` | `auto` | `off`/`0`/`false`=首次启动不自动下载权重（面板上的手动下载不受影响） |
| `ASR_LOCAL_MODEL_DIR` | `~/.multicc/asr-models` | 模型目录（各 worktree 共享，不进 git） |
| `ASR_LOCAL_THREADS` | `2` | 推理线程数 |
| `ASR_LOCAL_LANGUAGE` | `auto` | `auto` 对中英夹杂最好，可强制 `zh` |

## 实现要点 / 坑

- Recognizer 全局单例（onnxruntime arena 常驻 ~450MB，绝不能 per-request 创建）；
  启动 2s 后自动预热（首次加载 ~520ms）。
- VAD 段起始会截掉第一个音节（"开放时间"→"派饭时间"），已用会话缓冲按
  `segment.start` 前后各补 0.24s 修复——正好小于段间最小静音 0.25s，不会串段。
- sherpa-onnx-node 是 native addon：不能进 worker_threads；需要隔离时用 child_process。
- 模型/addon 缺失时 `isAvailable()` 为 false，一切自动回退云端——本模块任何故障
  都不应让语音功能整体不可用。
