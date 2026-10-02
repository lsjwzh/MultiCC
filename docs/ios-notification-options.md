# iOS 前台通知与强提醒方案

核实日期：2026-10-02。范围：MultiCC Flutter App 的前台通知实现，以及后台、来电式强提醒的技术选型。

## 本轮实现

- AppDelegate 注册 UNUserNotificationCenter delegate，由 FlutterAppDelegate 转发前台展示与点击事件。
- iOS 当前正在查看的会话也可显示系统横幅、通知中心记录并播放通知音；任务运行中的状态更新仍不提醒。
- 聊天与工作区两条路径共用开关策略，均遵守全局通知开关与会话级任务提醒开关。Android 保持当前会话不提醒的行为。
- 保留同一会话六秒窗口的双通道去重，清理过期记录；原生通知调用失败不影响聊天，允许后续重试。
- 原有点击通知进入对应会话的 payload 保留；首次启动不主动申请权限，仍由聊天页「⋯ → 任务提醒」触发授权。

这是普通系统通知，不包含持续响铃、绕过静音、全屏来电或后台 APNs 接入。显示与声音受用户的系统通知设置控制。安装重新构建的 App 后，需在真机验收前台横幅、声音和点击跳转。

## 现状

App 当前通过聊天及工作区 WebSocket 收到任务事件后调用本地通知。iOS 进入后台后可能挂起进程与网络连接，所以不能靠该链路保证锁屏后及时提醒。

服务端已有 Web Push、Bark、Webhook（src/push/service.js）；它们不等于 MultiCC 原生 App 已接 APNs。当前 iOS 工程没有原生推送 token 注册、设备订阅接口和 APNs 提交通道。UIBackgroundModes 中的 audio 也不是普通任务通知的保活授权。

## 方案比较

| 方式 | 提醒效果 | 适用范围及限制 |
| --- | --- | --- |
| 前台本地通知（本轮） | 系统横幅 + 通知音，点击打开会话 | App 运行且收到事件；声音/横幅服从系统设置，无持续响铃 |
| 前台 App 内响铃面板 | 可做确认弹层、循环音频、触感反馈，确认后停止 | 可以下一阶段实现；只保证前台，需要暂停语音播放/录音冲突处理、超时、去重和停止控制 |
| 原生 APNs 普通通知 | 后台/锁屏由系统展示，支持声音与点击跳转 | 长期推荐的基础通道；需要推送能力、签名配置、设备 token 生命周期、服务端鉴权及发送实现；推送送达不保证 |
| APNs 时效性通知 | 用户允许时可突破通知摘要和部分专注模式限制 | 不能绕过静音，也不等于持续响铃；应只用于确需及时处理的事件，需相应能力配置 |
| Critical Alerts 重要警告 | 可越过静音与勿扰，指定声音和音量 | 自有 App 必须获得 Apple 特殊 entitlement，并取得用户授权；不能假定普通任务助手一定获批 |
| Bark 强提醒 | 官方支持 call=1 重复播放 30 秒；level=critical 为重要警告 | 最快的短期方案。需安装 Bark 并允许对应通知/重要警告；提醒显示在 Bark 名下。没有真正的接听/挂断通话界面，具体表现需真机验证 |
| PushKit + CallKit | 系统来电 UI 与真实呼叫生命周期 | 适用于真实 VoIP 来电；不能将任务完成事件伪装成电话。当前 App 有语音功能不代表任务通知自动满足 VoIP 条件；CallKit 也尊重勿扰 |
| AlarmKit（iOS 26+） | 系统闹钟，获授权后可越过静音与专注 | 适合预先安排的时间提醒/倒计时，需独立授权；不能直接把服务端任意事件转成可靠即时闹钟。依赖静默推送唤醒再安排闹钟仍受唤醒不保证限制。当前本机 Xcode 16.4 也需升级才能开发该 API |

## 推荐落地顺序

1. 本轮前台通知代码上线后，在真机开启「任务提醒」验收。
2. 若最优先目标是后台明显响铃，先增强现有 Bark 通道，增加用户可选的 call=1、sound、level 参数。当前实现只拼接 url/group，不能宣称强提醒已经接好。Bark 设备 URL 属于凭证，应通过保险箱配置，不写入聊天或文档。
3. 长期补原生 APNs，让通知显示为 MultiCC；完成普通通知、设备权限/订阅管理、前后台去重及点击路由，再按事件紧急程度启用时效性通知。
4. 前台持续响铃可作为单独的显式选项，建议只用于「等待回答/需要处理」；任务成功默认短提示，避免每条运行状态都响。
5. 有「N 分钟后提醒我检查任务」的明确产品场景时再加 AlarmKit。真正的远程语音呼叫才进入 CallKit 方案。

后台推送基础实现应包含：Apple 推送 capability 与 provisioning 配套、注册/刷新/撤销设备 token、认证后的按用户订阅、服务端 APNs 凭证安全保存、失效 token 清理、通知偏好同步、事件 ID 去重与冷启动路由。普通 alert 推送不需要靠静默推送执行代码才能由系统显示。

## 验证

2026-10-02 验证结果：三份通知测试文件共 11 项全部通过；使用 UTF-8 终端环境执行 `flutter build ios --debug --no-codesign` 成功生成 Runner.app。这是未签名编译验证，不代表已安装到真机。Dart 定向静态检查无 error/warning，仅所检 provider 文件原有两条花括号风格 info；本轮新增的风格提示已消除。

自动化覆盖 iOS 前台允许提醒、Android 原有前台抑制、全局/会话关闭、插件收到横幅与声音参数及会话 payload、双通道去重、原生失败重试，并回归现有权限申请及偏好测试。

真机验收：开启系统通知并在 App 中开启任务提醒；分别保持当前会话、返回任务列表、关闭会话提醒、关闭全局通知，触发完成/等待状态；检查显示、声音、只提醒一次、点击回到正确会话。锁屏背景送达不作为本轮已实现能力。

## 一手资料

- Flutter 通知插件 iOS 配置：https://pub.dev/packages/flutter_local_notifications#-ios-setup
- Apple PushKit/CallKit 的 VoIP 要求：https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit
- Apple 重要警告与特殊权限：https://developer.apple.com/documentation/usernotifications/unauthorizationoptions/criticalalert
- Apple 时效性通知：https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive
- Apple 后台静默通知不保证送达：https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- Apple AlarmKit 的调度、授权与闹钟行为：https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit
- Bark 官方参数（call、sound、level）：https://github.com/Finb/Bark#parameters
