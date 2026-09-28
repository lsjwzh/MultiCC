# 定时脚本任务示例

「定时任务中心」（Air 侧栏 → 定时任务）里有两种规则：

- **大模型任务**（`kind: 'agent'`，默认）—— 每次触发把 prompt 投给一条固定的 Air 任务，
  跑的是模型；
- **脚本任务**（`kind: 'script'`）—— 不建任务、不经过任何模型，cron 到点就在规则的工作
  目录里跑一条本地命令，退出码与输出末尾进执行记录。

脚本这一类是为了「盯一下状态、不对就发条消息」这种纯粹的轮询：没必要为此养一个常驻
大模型会话。本目录放的就是这类规则的参考用例。

## wechat-alert.py —— 异常任务微信提醒

一条三步链路，全程不碰大模型：

| 步骤 | 做什么 | 打到哪 |
| --- | --- | --- |
| 1 | 取任务状态 | `GET /api/air` → 挑出 `runState` 落在 `watchStates` 里的活任务 |
| 2 | 调会话接口 | `POST /api/sessions/<relaySessionId>/scheduled-messages` |
| 3 | 发微信提醒 | 中转任务收到工单，用 computer use 把「---」之间的正文原样发进微信群 |

只用 Python 标准库，没有依赖。

### 装

```bash
mkdir -p ~/.multicc/wechat-alert
cp wechat-alert.py ~/.multicc/wechat-alert/
chmod +x ~/.multicc/wechat-alert/wechat-alert.py
```

配置写在脚本外面（`~/.multicc` 不会随 worktree 回收）：

```json
{
  "baseUrl": "http://127.0.0.1:3000",
  "relayTaskId": "tsk_...",
  "relaySessionId": "task-...",
  "wechatGroup": "all in one",
  "watchStates": { "error": { "label": "出错了" }, "waiting": { "label": "在等你回答" } },
  "reAlertAfterMinutes": 0,
  "minDispatchIntervalMs": 120000,
  "maxAlertsPerHour": 12,
  "excludeTaskIds": [],
  "excludeSessionIds": [],
  "excludeTitlePrefixes": ["微信提醒"],
  "dispatchDelaySeconds": 1,
  "stateFile": "state-cron.json"
}
```

`relayTaskId` / `relaySessionId` 是那条「收到工单就去发微信群」的中转任务；把中转任务自己
排掉（`relayTaskId` / `relaySessionId` 两种写法都认）很重要，否则它一出错就会提醒自己。

### 登记成一条规则

在 Air 的定时任务中心「新建定时任务」里把类型切成**脚本任务**，命令填：

```
/usr/bin/python3 ~/.multicc/wechat-alert/wechat-alert.py --config ~/.multicc/wechat-alert/config-cron.json
```

或者走 API：

```bash
curl -s "$MULTICC_BASE_URL/api/cron" -H 'Content-Type: application/json' \
  -d '{"name":"异常任务微信提醒","dirPath":"'"$PWD"'","kind":"script",
       "command":"/usr/bin/python3 '"$HOME"'/.multicc/wechat-alert/wechat-alert.py --config '"$HOME"'/.multicc/wechat-alert/config-cron.json",
       "cron":"* * * * *"}'
```

cron 用 `* * * * *`（每分钟一轮）。**别在脚本里自己 sleep 循环** —— 循环交给 cron
表达式，脚本一轮就退出，否则规则会卡在「执行中」永不结算。

### 命令行开关

| 开关 | 作用 |
| --- | --- |
| `--config <path>` | 配置文件；不给就纯靠下面的开关 |
| `--base-url` / `--relay-task-id` / `--relay-session-id` / `--group` | 临时覆盖配置 |
| `--state <path>` | 状态文件；默认取配置里的 `stateFile`（相对配置文件所在目录） |
| `--disabled` | 只记录不投递（不影响 priming） |
| `--dry-run` | 只打印这一轮会发什么，不改状态、不投递 |

### 行为约定

- **首轮只登记不补发**：第一次跑时机器上多半已经堆着一批历史 error，直接发就是往群里刷屏。
  所以第一轮只记状态，从第二轮起才报「变化」。
- **一轮最多一条**：同一轮里所有到点的提醒合并成一条消息（摘不下就写「等 N 个」）。
- **频率闸只推迟、不丢弃**：`minDispatchIntervalMs` / `maxAlertsPerHour` 拦住的那一批**不
  推进状态**，下一轮原样端上来 —— 宁可晚到，也不能悄悄丢掉。
- **退出码**：0 = 正常（含「没有要提醒的」「被闸压住」），1 = 取状态或投递失败。失败会体现
  在定时任务卡片的错误态与最近一次运行的输出里。

### 和 launchd 版 watcher 的关系

`~/.multicc/wechat-alert/watcher.js` 是同一套逻辑的常驻版（launchd 拉起、自己轮询）。
**两者同时开着会对同一件事发两条消息**，所以只能留一个：要么用它，要么用这条 cron 规则
（把 launchd 那份 `launchctl unload` 掉）。本用例的判定与去重口径与它逐条对齐，实测在
同一份 `/api/air` 上得到完全相同的提醒集合。
