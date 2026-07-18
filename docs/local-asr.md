# 本地语音识别（Local ASR）

`src/asr-local.js` 用 sherpa-onnx 在 Node 进程内跑 **SenseVoiceSmall int8**（阿里
FunASR/FunAudioLLM 家族模型），替代云端 Whisper API 的跨境往返。

## 为什么

| | 云端 whisper-large-v3-turbo (OpenRouter) | 本地 SenseVoice (M4) |
|---|---|---|
| 8-12s 语音延迟 | 400-3700ms（国内网络长尾严重） | **180-280ms** |
| 41s 长语音 | 3.7s | 0.9s |
| 中文准确率 | 相当 | 相当（英文专有名词稍弱，靠词表纠错补） |
| 网络/费用 | 需要 API key，按量计费 | 无 |

RTF ≈ 0.018（M4，2 线程）：1 秒音频约 18ms 推理。

## 安装（新机器）

```bash
npm install                      # package.json 已含 sherpa-onnx-node（macOS arm64 预编译）
bash scripts/setup-local-asr.sh  # 下载模型到 ~/.multicc/asr-models（~240MB，github/ghproxy）
# 重启 multicc server 即生效
```

验证：`GET /api/settings/voice` → `asr.status.local.ready === true`；
`POST /api/voice/stt` 返回 `engine: "local"`。
测试：`node tests/test-local-asr.js`（可加 `--typeless 8` 跑真实录音对比基准）。

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
| `ASR_LOCAL` | `auto` | `auto`=模型存在即用；`off`=禁用（回到纯云端） |
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
