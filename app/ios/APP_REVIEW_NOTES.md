# App Review Notes (App Store Connect → App Review Information → Notes)

Paste the English block below into **Notes**. In **Sign-In Information**, uncheck
"Sign-in required" (the demo needs no account).

---

Thank you for reviewing MultiCC.

HOW TO REVIEW WITHOUT A SERVER (no account, no network setup needed)
1. Launch the app. On the first screen, tap "Try the demo (no server needed)",
   directly under the language selector.
2. You are now in the main console with a built-in sample project, "weather-app",
   containing three example tasks.
3. Tap "weather-app", then tap any task (for example "Add a dark mode toggle")
   to open its conversation: the full history, the agent's file edits and
   commands ("Technical details"), and code blocks.
4. Type any message and tap Send. A reply streams in live, and a notification
   appears when it finishes. This is the same chat flow a real user sees.
5. To leave the demo: menu (top left) → More & system → Log out. This returns
   to the connect screen.

WHAT THE APP IS
MultiCC is a mobile client for MultiCC, an open-source tool that developers run
on their own computer to manage several AI coding agents (Claude Code, Codex,
and others) at once. The app lets them follow and steer those agents from
their phone: see each task's progress, read replies, and send new
instructions.

WHY THERE IS NO DEMO ACCOUNT
MultiCC has no cloud service and no user accounts. Each user connects the app
to the MultiCC server running on their own computer, entering its address and
an optional access token they set themselves. To make every feature reachable
without that setup, the app includes the demo mode above. It needs no server
and no internet connection; all sample data is built into the app.

EXTERNAL SERVICES
The app connects to the server address the user enters. Apart from checking
the App Store for a newer version of itself, it only contacts another service
if the user turns on an optional integration (for example Bark push
notifications). It has no analytics, no ads, no in-app purchases, and no
third-party login. Features are the same in every region.

Privacy policy: https://github.com/lsjwzh/multicc/blob/main/PRIVACY.md

---

## 中文对照（不要粘贴，仅供核对）

1. 首屏语言选择下方有「体验演示（无需服务器）」，点它进入。
2. 进入内置示例项目 weather-app，里面有 3 个示例任务。
3. 点任务可以看到完整对话、工具调用和代码块。
4. 随便发一条消息，会收到流式回复和完成通知。
5. 左上角菜单 → 更多与系统 → 退出登录，即可离开演示。
没有演示账号的原因：MultiCC 没有云端和账号体系，用户连接的是自己电脑上的服务端；
演示模式不需要服务器也不需要联网，示例数据都内置在 App 里。
