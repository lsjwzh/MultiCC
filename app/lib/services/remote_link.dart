/// 「🖥 屏幕」画面当前走的那条路，页面状态栏据此显示「中继 / 局域网 / 直连」。
///
///   · [relay] —— 经配置的服务器地址（外网隧道等）上的 /ws/remote-screen
///   · [lan]   —— 同一 Wi‑Fi 下改连服务端自报的局域网地址
///   · [p2p]   —— WebRTC DataChannel 直连（UDP），信令仍走上面任一条 WS
enum RemoteLinkPath { relay, lan, p2p }
