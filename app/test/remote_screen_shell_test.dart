import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/remote_screen_screen.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_source.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/remote_key_sheet.dart';
import 'package:multicc_app/widgets/remote_rail.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Source with ScreenInputMixin implements ScreenSource {
  _Source([this.width = 400, this.height = 300])
    : framebuffer = Uint8List(width * height * 4);
  final events = <List<int>>[];
  @override
  final int width;
  @override
  final int height;
  @override
  Uint8List framebuffer;
  @override
  void sendInput(Uint8List bytes) => events.add(bytes.toList());
}

class _Service extends RemoteScreenService {
  _Service(SettingsService settings, {this.clipboard = ''})
    : input = _Source(),
      super(settings: settings);
  final String clipboard;
  final requests = <Map<String, dynamic>>[];
  final _Source input;
  final frames = StreamController<void>.broadcast();
  final modes = StreamController<void>.broadcast();
  @override
  ScreenSource? get source => input;
  @override
  Stream<void> get onFrame => frames.stream;
  @override
  Stream<void> get onModeChange => modes.stream;
  @override
  Future<bool?> supportsRemoteScreen() async => true;
  @override
  Future<Map<String, dynamic>> agentPermissions() async => {
    'ok': true,
    'applicable': true,
    'accessibility': true,
    'screenRecording': true,
  };
  @override
  Future<Map<String, dynamic>> wakeScreen({bool request = false}) async => {};
  @override
  Future<Map<String, dynamic>> inputOp(Map<String, dynamic> body) async {
    requests.add(body);
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> readClipboard() async => {
    'ok': true,
    'text': clipboard,
  };

  @override
  Future<Map<String, dynamic>> writeClipboard(String text) async {
    requests.add({'op': 'clipboard-write', 'text': text});
    return {'ok': true};
  }

  @override
  void connectLive() {
    mode = RemoteScreenMode.live;
    frames.add(null);
  }

  @override
  void dispose() {
    unawaited(frames.close());
    unawaited(modes.close());
    super.dispose();
  }
}

Future<_Service> _open(
  WidgetTester tester, {
  String clipboard = '',
  Size viewport = const Size(800, 600),
  double dpr = 1,
  bool seen = true,
  bool control = true,
}) async {
  tester.view.physicalSize = viewport * dpr;
  tester.view.devicePixelRatio = dpr;
  addTearDown(tester.view.reset);
  // seen=false 走首次进入那条路（侧栏带文字标签三秒）；其余用例固定走「见过」，
  // 免得前三秒的宽侧栏影响命中。
  SharedPreferences.setMockInitialValues({'remote_screen_seen': seen});
  final settings = await SettingsService.getInstance();
  final service = _Service(settings, clipboard: clipboard);
  await tester.pumpWidget(
    MaterialApp(
      home: RemoteScreenScreen(
        settings: settings,
        service: service,
        initialControl: control,
      ),
    ),
  );
  await tester.pump();
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 30)),
  );
  await tester.pump();
  return service;
}

Future<void> _rail(WidgetTester tester, String id) async {
  if (find.byKey(const ValueKey('rs-rail-handle')).evaluate().isNotEmpty) {
    await tester.tap(find.byKey(const ValueKey('rs-rail-handle')));
    await tester.pump();
  }
  await tester.tap(find.byKey(ValueKey('rs-rail-$id')));
  await tester.pumpAndSettle();
}

/// 「更多」面板是个滚动卡片：下半部分的按钮要先滚进视口再点。
Future<void> _tapInPanel(WidgetTester tester, String label) async {
  final target = find.text(label);
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

List<(bool, int)> _keys(_Service service) => [
  for (final e in service.input.events)
    if (e.length >= 8 && e[0] == 4)
      (e[1] != 0, (e[4] << 24) | (e[6] << 8) | e[7]),
];

Future<void> _close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  setUpAll(() => I18n.init('zh'));

  testWidgets('the picture is the page: no app bar, chrome only as overlays', (
    tester,
  ) async {
    await _open(tester);
    expect(find.byType(AppBar), findsNothing);
    // 舞台吃满整个 body，不再被标题栏 / 状态行 / 键盘条压缩。
    expect(
      tester.getSize(find.byType(InteractiveViewer)),
      const Size(800, 600),
    );
    expect(find.byKey(const ValueKey('rs-hud')), findsOneWidget);
    expect(find.byKey(const ValueKey('rs-pod')), findsOneWidget);
    await _close(tester);
  });

  testWidgets('the rail hides when a finger lands and returns after a pause', (
    tester,
  ) async {
    await _open(tester);
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    // 摸画面 = 开始操作远端，chrome 让位。不是「6 秒无操作」那种计时器：
    // 计时器会在读屏思考时把栏收掉，又不会在要用时送回来。
    final gesture = await tester.startGesture(const Offset(300, 200));
    await tester.pump();
    expect(find.byKey(const ValueKey('rs-rail')), findsNothing);
    expect(find.byKey(const ValueKey('rs-rail-handle')), findsOneWidget);
    // 操作中一直不回来
    await gesture.moveBy(const Offset(10, 10));
    await tester.pump(const Duration(seconds: 3));
    expect(find.byKey(const ValueKey('rs-rail')), findsNothing);
    // 抬手静止之后自己回来
    await gesture.up();
    await tester.pump();
    expect(find.byKey(const ValueKey('rs-rail')), findsNothing);
    await tester.pump(const Duration(milliseconds: 1300));
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    await _close(tester);
  });

  testWidgets('the collapsed handle is a 44dp target, not a 10dp sliver', (
    tester,
  ) async {
    await _open(tester);
    final gesture = await tester.startGesture(const Offset(300, 200));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    // 画的是 10dp 的线，摸的是 Material 的最小可点尺寸 —— 否则收起之后要在
    // 动着的画面边缘戳一条 10dp 的线才能回来。
    final size = tester.getSize(find.byKey(const ValueKey('rs-rail-handle')));
    expect(size.width, greaterThanOrEqualTo(44));
    expect(size.height, greaterThanOrEqualTo(44));
    // 往里一划也展开（手机上「拉抽屉」的肌肉记忆）
    await tester.fling(
      find.byKey(const ValueKey('rs-rail-handle')),
      const Offset(-40, 0),
      600,
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    await _close(tester);
  });

  testWidgets('four rail items fit a landscape phone without shrinking', (
    tester,
  ) async {
    // 七项要靠 FittedBox 等比缩到约 36dp，低于自己定的 44dp 命中区底线；
    // 四项在横屏手机上原尺寸就放得下。
    await _open(tester, viewport: const Size(727, 340));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    expect(find.byType(RemoteRail), findsOneWidget);
    expect(
      tester.widget<RemoteRail>(find.byType(RemoteRail)).entries.length,
      4,
    );
    // getRect 带上 FittedBox 的变换：没被缩小才会正好是 48dp 宽。
    expect(
      tester.getRect(find.byKey(const ValueKey('rs-rail'))).width,
      closeTo(remoteRailWidth, 0.5),
    );
    await _close(tester);
  });

  testWidgets('the pointer item toggles the floating pad, not a global mode', (
    tester,
  ) async {
    await _open(tester);
    await _rail(tester, 'pointer');
    expect(find.byKey(const ValueKey('rs-pod')), findsNothing);
    await _rail(tester, 'pointer');
    expect(find.byKey(const ValueKey('rs-pod')), findsOneWidget);
    // 画面上的单指仍然是直接操作（操作台隐藏与否都不影响）。
    await _close(tester);
  });

  testWidgets('one "more" entry carries view, clipboard, host and status', (
    tester,
  ) async {
    await _open(tester);
    await _rail(tester, 'more');
    expect(find.byKey(const ValueKey('rs-panel')), findsOneWidget);
    expect(find.text('适应'), findsOneWidget); // 视图
    expect(find.text('取回远端剪贴板'), findsOneWidget); // 剪贴板
    expect(find.text('显示桌面'), findsOneWidget); // 宿主
    expect(find.text('切到只看（不发送操作）'), findsOneWidget); // 状态
    // 四个独立入口是照抄结构：用户心里只有一个「工具」对象。
    expect(find.byKey(const ValueKey('rs-rail-view')), findsNothing);
    expect(find.byKey(const ValueKey('rs-rail-status')), findsNothing);
    await _close(tester);
  });

  testWidgets('the view section zooms the visible area and can fit again', (
    tester,
  ) async {
    await _open(tester);
    final transform = tester
        .widget<InteractiveViewer>(find.byType(InteractiveViewer))
        .transformationController!;
    await _rail(tester, 'more');
    await tester.tap(find.text('2×'));
    await tester.pump();
    expect(transform.value.getMaxScaleOnAxis(), closeTo(2.0, 0.01));
    await tester.tap(find.text('适应'));
    await tester.pump();
    expect(transform.value.getMaxScaleOnAxis(), closeTo(1.0, 1e-9));
    await _close(tester);
  });

  testWidgets('host actions send the documented chords', (tester) async {
    final service = await _open(tester);
    await _rail(tester, 'more');
    service.input.events.clear();
    await _tapInPanel(tester, '显示桌面');
    // 流畅模式下按键直接走 RFB：F11 = 0xFFC8。
    expect(_keys(service), contains((true, 0xFFC8)));
    await _close(tester);
  });

  testWidgets('clipboard comes over only when the user taps', (tester) async {
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        if (call.method == 'Clipboard.getData') {
          return {'text': '从手机剪贴板来'};
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final service = await _open(tester, clipboard: '从远端来');
    await _rail(tester, 'more');
    await _tapInPanel(tester, '取回远端剪贴板');
    final set = calls.lastWhere((c) => c.method == 'Clipboard.setData');
    expect((set.arguments as Map)['text'], '从远端来');

    // 面板还开着：直接点主动作，不再开关一次侧栏。
    await _tapInPanel(tester, '粘贴到远端（⌘V）');
    expect(
      service.requests
          .where((r) => r['op'] == 'clipboard-write')
          .single['text'],
      '从手机剪贴板来',
    );
    // 写入之后还要真的按一次 ⌘V（live 模式走 RFB 键事件）。
    expect(_keys(service), contains((true, 0x76)));
    await _close(tester);
  });

  testWidgets('long-pressing paste only sets the remote clipboard', (
    tester,
  ) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async =>
          call.method == 'Clipboard.getData' ? {'text': '只写不粘贴'} : null,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final service = await _open(tester);
    await _rail(tester, 'more');
    final target = find.text('粘贴到远端（⌘V）');
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    service.input.events.clear();
    await tester.longPress(target);
    await tester.pumpAndSettle();
    expect(
      service.requests
          .where((r) => r['op'] == 'clipboard-write')
          .single['text'],
      '只写不粘贴',
    );
    // 弱版（只写入、不按 ⌘V）收成了主按钮的长按，不再单占一个按钮。
    expect(_keys(service).where((k) => k.$2 == 0x76), isEmpty);
    await _close(tester);
  });

  testWidgets('the key panel is not modal: the picture stays clickable', (
    tester,
  ) async {
    final service = await _open(tester);
    await _rail(tester, 'keys');
    expect(find.byKey(const ValueKey('rs-key-text')), findsOneWidget);
    // 舞台**让出**面板那点高度，而不是被遮罩盖住。
    final stage = tester.getSize(find.byType(InteractiveViewer));
    expect(stage.width, 800);
    expect(stage.height, 600 - remoteKeyPanelHeight(gridOpen: false));
    service.input.events.clear();
    // 关键回归：键盘开着的时候点远端输入框还要能点中。早期版本用的是
    // showModalBottomSheet，这一下只会关掉面板，根本到不了远端。
    await tester.tapAt(const Offset(300, 150));
    await tester.pump();
    expect(service.input.events, isNotEmpty);
    expect(find.byKey(const ValueKey('rs-key-text')), findsOneWidget);
    await _close(tester);
  });

  testWidgets('view-only keeps a pinned HUD that hands over control', (
    tester,
  ) async {
    await _open(tester, control: false);
    expect(find.byKey(const ValueKey('rs-pod')), findsNothing);
    // 「只看 / 操作」是状态，所以开关长在状态上，而且不随 4 秒淡出消失。
    await tester.pump(const Duration(seconds: 6));
    expect(find.byKey(const ValueKey('rs-hud')), findsOneWidget);
    expect(find.textContaining('只看模式'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('rs-hud')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('rs-pod')), findsOneWidget);
    await _close(tester);
  });

  testWidgets(
    'a phone gets the panel from the bottom, a tablet beside the rail',
    (tester) async {
      await _open(tester, viewport: const Size(390, 844));
      await _rail(tester, 'more');
      final sheet = tester.getRect(find.byKey(const ValueKey('rs-panel')));
      // 手机：底部弹出 + 遮罩。顶部锚定的卡片正好落在单手拇指到不了的那块。
      expect(sheet.bottom, closeTo(844, 0.5));
      expect(sheet.left, closeTo(0, 0.5));
      expect(find.byKey(const ValueKey('rs-panel-scrim')), findsOneWidget);
      await tester.tapAt(const Offset(195, 60));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('rs-panel')), findsNothing);
      await _close(tester);
    },
  );

  testWidgets('a tablet anchors the panel next to the rail, with no scrim', (
    tester,
  ) async {
    await _open(tester, viewport: const Size(1024, 768));
    await _rail(tester, 'more');
    final card = tester.getRect(find.byKey(const ValueKey('rs-panel')));
    expect(card.top, closeTo(56, 0.5));
    expect(card.right, closeTo(1024 - 58, 0.5));
    expect(find.byKey(const ValueKey('rs-panel-scrim')), findsNothing);
    await _close(tester);
  });

  testWidgets('the first visit labels the rail, then collapses to icons', (
    tester,
  ) async {
    await _open(tester, seen: false);
    // 用一次演示代替说明书：提示卡没人看。
    expect(find.text('返回'), findsOneWidget);
    expect(find.text('键盘'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    expect(find.text('返回'), findsNothing);
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    await _close(tester);
  });
}
