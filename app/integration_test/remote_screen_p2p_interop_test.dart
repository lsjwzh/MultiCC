// 「🖥 屏幕」WebRTC P2P 直连互通（真协议栈）：模拟器里的真 flutter_webrtc
// ⇄ 真 server.js 转发到的 Rust 进程 multicc-remote（native/remote/src/p2p.rs +
// h264.rs，契约见 docs/remote-screen-process.md）。
//
// 这条测试证明的是「直连真的能通」，不是假对端的单元测试（那个在
// app/test/remote_screen_p2p_test.dart）：App 用真的 RemoteScreenService（真
// PlatformH264Decoder、真 FlutterRtcPeer）、真 WsTicketClient、真 WebSocket；
// 服务端是隔离数据目录下的真 server.js，帧来自假 Agent 回放的真 VideoToolbox
// 码流（tests/fixtures/remote-screen-h264/agent-stream.bin）。
//
// 断言：
//   1. 收到 rtc-hello → 真 flutter_webrtc 出 offer → Rust 进程（webrtc-rs）回 answer，DataChannel
//      打开、服务端发 rtc-active，App 的 linkPath 从 lan 变成 p2p；
//   2. 切直连后服务端补关键帧，仍有新帧解出来；
//   3. 悬停 PointerEvent（mask 0）逐字节到达假 Agent，且同一时间窗内中继 WS 上
//      没有出现任何客户端二进制帧 —— 这笔输入走的是 DataChannel。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
// 集成测试跑在模拟器进程里，不能自己 spawn node，所以测试台要在 Mac 上先起，
// 再用 --dart-define 把地址传进来。在 worktree 根：
//
//   # 1) 起测试台。MULTICC_REMOTE_STUN= 空串 = 只用本机/局域网候选，不连外部 STUN；
//   #    --p2p-stats 打开只读观测口 /p2p（桥的 stats.transport/p2pOpened 与 WS 二进制帧数）。
//   mkdir -p /tmp/rs-p2p && MULTICC_REMOTE_STUN= MULTICC_AGENT_AUTO_INSTALL=0 \
//     node tests/helpers/remote-screen-e2e-harness.js --p2p-stats \
//     > /tmp/rs-p2p/ready.json &
//   # 等这一行出现：{"ready":true,"server":"http://127.0.0.1:...","control":"http://127.0.0.1:...",...}
//
//   # 2) 在 app/ 下跑（模拟器与宿主共享 loopback，127.0.0.1 直接可用）。
//   #    CocoaPods 需要 UTF-8 locale；UDID 用 `xcrun simctl list devices` 取。
//   LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 flutter test \
//     integration_test/remote_screen_p2p_interop_test.dart \
//     -d 527A6F1A-4605-4E8A-B8CD-833CB7AF4FB8 \
//     --dart-define=RS_SERVER_URL=http://127.0.0.1:<tunnel-port> \
//     --dart-define=RS_CONTROL_URL=http://127.0.0.1:<control-port> \
//     --dart-define=RS_TOKEN=<token>
//
//   # 3) 收尾：停掉测试台（kill %1 或关它的 stdin），必要时 xcrun simctl shutdown <UDID>。
//
// 三个 --dart-define 缺一个就跳过（+0），这样没起测试台时整套 integration_test 仍能跑。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:multicc_app/services/remote_link.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/settings_service.dart';

const String _serverUrl = String.fromEnvironment('RS_SERVER_URL');
const String _controlUrl = String.fromEnvironment('RS_CONTROL_URL');
const String _token = String.fromEnvironment('RS_TOKEN');

String? _skipReason() {
  if (_serverUrl.isEmpty || _controlUrl.isEmpty || _token.isEmpty) {
    return 'need --dart-define=RS_SERVER_URL/RS_CONTROL_URL/RS_TOKEN '
        '(start tests/helpers/remote-screen-e2e-harness.js --p2p-stats first)';
  }
  return null;
}

// ── 工具 ──────────────────────────────────────────────────────────────────

/// 条件里的网络/定时器一律跑在真实时钟上（IntegrationTest 的 runAsync）。
/// 条件自己可以用普通 async（_getJson 不碰 runAsync），整个条件被一层
/// runAsync 包住 —— 别在条件里再调 runAsync（会 reentrant）。
Future<void> _waitFor(
  WidgetTester tester,
  FutureOr<bool> Function() condition,
  Duration limit,
  String what, {
  String Function()? detail,
}) async {
  final deadline = DateTime.now().add(limit);
  while (DateTime.now().isBefore(deadline)) {
    final ok = await tester.runAsync(() async => condition());
    if (ok == true) return;
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  }
  fail(
    'timed out after ${limit.inSeconds}s waiting for $what'
    '${detail == null ? '' : '\n${detail()}'}',
  );
}

Future<Map<String, dynamic>> _getJson(http.Client client, String url) async {
  final res = await client.get(Uri.parse(url));
  return jsonDecode(res.body) as Map<String, dynamic>;
}

Future<Uint8List> _getBytes(
  WidgetTester tester,
  http.Client client,
  String url,
) async {
  final res = await tester.runAsync(() => client.get(Uri.parse(url)));
  expect(res!.statusCode, 200, reason: 'GET $url');
  return res.bodyBytes;
}

String _hex(Iterable<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

// agent-stream.bin = [type u8][len u32 BE][payload]…；第一条是 config JSON。
Map<String, dynamic> _readConfig(Uint8List stream) {
  expect(stream.length, greaterThan(5));
  final type = stream[0];
  expect(type, 1, reason: 'fixture 的第一条消息必须是 config');
  final length =
      (stream[1] << 24) | (stream[2] << 16) | (stream[3] << 8) | stream[4];
  return jsonDecode(utf8.decode(Uint8List.sublistView(stream, 5, 5 + length)))
      as Map<String, dynamic>;
}

// ── 测试 ──────────────────────────────────────────────────────────────────

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    '真 flutter_webrtc ⇄ 真 server.js(werift)：linkPath→p2p、直连继续出帧、'
    '悬停输入经 DataChannel 逐字节到达 Agent',
    (tester) async {
      final settings = (await tester.runAsync(SettingsService.getInstance))!;
      // 演示模式只覆盖内存里的 host/token，不写 SharedPreferences。
      settings.enterDemo(host: _serverUrl, token: _token);
      addTearDown(settings.exitDemo);
      debugPrint(
        '[rs-p2p] server=$_serverUrl control=$_controlUrl token=${_token.substring(0, 6)}…',
      );

      final client = http.Client();
      addTearDown(client.close);

      // 编码尺寸 / 输入坐标域（旧 Agent 的 config 没有 input*，App 回落到编码尺寸）。
      final config = _readConfig(
        await _getBytes(
          tester,
          client,
          '$_controlUrl/fixture/agent-stream.bin',
        ),
      );
      final encodedW = (config['width'] as num).toInt();
      final encodedH = (config['height'] as num).toInt();
      final inputW = (config['inputWidth'] as num?)?.toInt() ?? encodedW;
      final inputH = (config['inputHeight'] as num?)?.toInt() ?? encodedH;

      final service = RemoteScreenService(settings: settings);
      var frames = 0;
      final frameSub = service.onFrame.listen((_) => frames += 1);
      final paths = <RemoteLinkPath>[];
      void onLink() => paths.add(service.linkPath.value);
      service.linkPath.addListener(onLink);
      addTearDown(() async {
        service.linkPath.removeListener(onLink);
        await frameSub.cancel();
        service.dispose();
      });

      // ── 1. 中继 / LAN 起流，真解码器解出第一帧 ────────────────────────
      service.connectLive();
      await _waitFor(
        tester,
        () =>
            service.mode == RemoteScreenMode.live &&
            service.h264Active &&
            service.source != null &&
            frames > 0,
        const Duration(seconds: 60),
        'live H.264 + first decoded frame',
        detail: () =>
            'mode=${service.mode} h264Active=${service.h264Active} '
            'error=${service.error} frames=$frames',
      );
      debugPrint(
        '[rs-p2p] relay live: ${service.source!.width}x${service.source!.height}, frames=$frames, '
        'linkPath=${service.linkPath.value.name}',
      );

      // ── 2. 真 WebRTC 握手：linkPath → p2p ────────────────────────────
      await _waitFor(
        tester,
        () => service.linkPath.value == RemoteLinkPath.p2p,
        const Duration(seconds: 30),
        'WebRTC DataChannel active (linkPath=p2p)',
        detail: () => 'mode=${service.mode} paths=$paths frames=$frames',
      );
      expect(paths, contains(RemoteLinkPath.p2p));

      // 服务端切换时会向 Agent 要关键帧；假 Agent 收到 'K' 就重放整段码流。
      final framesAtP2p = frames;
      await _waitFor(
        tester,
        () => frames > framesAtP2p,
        const Duration(seconds: 30),
        'new decoded frames over the DataChannel',
        detail: () => 'frames=$frames (at p2p ${framesAtP2p})',
      );
      debugPrint(
        '[rs-p2p] p2p live: frames $framesAtP2p → $frames, '
        '${service.source!.width}x${service.source!.height}',
      );

      // ── 3. 服务端侧确认：桥的出口是 p2p ──────────────────────────────
      Map<String, dynamic> p2pStats = const <String, dynamic>{};
      await _waitFor(
        tester,
        () async {
          p2pStats = await _getJson(client, '$_controlUrl/p2p');
          final stats = p2pStats['stats'];
          return stats is Map &&
              stats['transport'] == 'p2p' &&
              (stats['p2pOpened'] as num? ?? 0) >= 1;
        },
        const Duration(seconds: 10),
        'server bridge stats.transport == p2p',
        detail: () => 'p2p stats: ${jsonEncode(p2pStats)}',
      );
      final openedBefore = (p2pStats['stats'] as Map)['p2pOpened'] as num;

      // ── 4. 悬停 PointerEvent 经 DataChannel 逐字节到达 Agent ─────────
      final src = service.source!;
      expect(src.width, greaterThan(0));
      expect(src.height, greaterThan(0));
      const hoverX = 700;
      const hoverY = 300;
      // App 的 pointerEvent 会在「输入坐标域 ≠ 解码尺寸」时缩放（remote_screen_h264.dart）。
      var px = hoverX;
      var py = hoverY;
      if (inputW > 0 &&
          inputH > 0 &&
          (inputW != src.width || inputH != src.height)) {
        px = (hoverX * inputW / src.width).round().clamp(0, inputW - 1);
        py = (hoverY * inputH / src.height).round().clamp(0, inputH - 1);
      }
      final wantHex = _hex([
        5,
        0,
        (px >> 8) & 0xFF,
        px & 0xFF,
        (py >> 8) & 0xFF,
        py & 0xFF,
      ]);

      await tester.runAsync(
        () => client.post(Uri.parse('$_controlUrl/agent/reset')),
      );
      // 让观测文件的心跳落一次盘，避免把切换前的旧计数当成基线。
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      final before = (await tester.runAsync(
        () => _getJson(client, '$_controlUrl/p2p'),
      ))!;
      final wsBinaryBefore = (before['wsBinary'] as num?)?.toInt() ?? 0;

      src.pointerEvent(0, hoverX, hoverY);

      Map<String, dynamic> agent = const <String, dynamic>{};
      await _waitFor(
        tester,
        () async {
          agent = await _getJson(client, '$_controlUrl/agent');
          final raw = ((agent['connections'] as List?) ?? const [])
              .cast<Map<String, dynamic>>()
              .map((c) => c['raw'] as String)
              .join();
          return raw.contains(wantHex);
        },
        const Duration(seconds: 20),
        'hover PointerEvent bytes at the agent',
        detail: () =>
            'want=$wantHex agent=${jsonEncode(agent)}\n'
            'p2p=${jsonEncode(p2pStats)}',
      );

      // 假 Agent 的事件级别也要看到同一个 (mask, x, y)。
      final pointers = <List<dynamic>>[];
      for (final conn
          in ((agent['connections'] as List?) ?? const [])
              .cast<Map<String, dynamic>>()) {
        for (final event in ((conn['events'] as List?) ?? const [])) {
          if (event is List && event.isNotEmpty && event[0] == 'pointer') {
            pointers.add(event);
          }
        }
      }
      expect(
        pointers,
        contains(equals(<dynamic>['pointer', 0, px, py])),
        reason: 'agent events: ${jsonEncode(agent)}',
      );

      // ── 5. 同一时间窗内中继 WS 上没有任何客户端二进制帧 ──────────────
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      final after = (await tester.runAsync(
        () => _getJson(client, '$_controlUrl/p2p'),
      ))!;
      final afterStats = after['stats'] as Map<String, dynamic>? ?? const {};
      final wsBinaryAfter = (after['wsBinary'] as num?)?.toInt() ?? 0;
      debugPrint(
        '[rs-p2p] input: want=$wantHex sent(0,$hoverX,$hoverY)→($px,$py); '
        'p2pOpened=$openedBefore→${afterStats['p2pOpened']} '
        'wsBinary=$wsBinaryBefore→$wsBinaryAfter',
      );
      expect(afterStats['transport'], 'p2p');
      expect(afterStats['p2pOpened'], openedBefore, reason: '直连会话不应在发送输入期间重连');
      expect(
        wsBinaryAfter,
        wsBinaryBefore,
        reason:
            '输入已到达 Agent，但中继 WS 上又出现了二进制帧：这笔输入没有走 DataChannel'
            '（before=$wsBinaryBefore after=$wsBinaryAfter）',
      );

      debugPrint('[rs-p2p] OK: p2p interop verified');
    },
    skip: _skipReason() != null,
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
