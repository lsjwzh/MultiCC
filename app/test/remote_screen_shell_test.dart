import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/remote_screen_screen.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_source.dart';
import 'package:multicc_app/services/settings_service.dart';
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
}) async {
  tester.view.physicalSize = viewport * dpr;
  tester.view.devicePixelRatio = dpr;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final settings = await SettingsService.getInstance();
  final service = _Service(settings, clipboard: clipboard);
  await tester.pumpWidget(
    MaterialApp(
      home: RemoteScreenScreen(
        settings: settings,
        service: service,
        initialControl: true,
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
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the rail collapses after 6s and comes back from its handle', (
    tester,
  ) async {
    await _open(tester);
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    await tester.pump(const Duration(seconds: 7));
    expect(find.byKey(const ValueKey('rs-rail')), findsNothing);
    expect(find.byKey(const ValueKey('rs-rail-handle')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('rs-rail-handle')));
    await tester.pump();
    expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
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
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the view panel zooms the visible area and can fit again', (
    tester,
  ) async {
    await _open(tester);
    final transform = tester
        .widget<InteractiveViewer>(find.byType(InteractiveViewer))
        .transformationController!;
    await _rail(tester, 'view');
    await tester.tap(find.text('2×'));
    await tester.pump();
    expect(transform.value.getMaxScaleOnAxis(), closeTo(2.0, 0.01));
    await tester.tap(find.text('适应'));
    await tester.pump();
    expect(transform.value.getMaxScaleOnAxis(), closeTo(1.0, 1e-9));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('host actions send the documented chords', (tester) async {
    final service = await _open(tester);
    await _rail(tester, 'host');
    service.input.events.clear();
    await tester.tap(find.text('显示桌面'));
    await tester.pump();
    // 流畅模式下按键直接走 RFB：F11 = 0xFFBE。
    final keys = [
      for (final e in service.input.events)
        if (e.length >= 8 && e[0] == 4)
          (e[1] != 0, (e[4] << 24) | (e[6] << 8) | e[7]),
    ];
    expect(keys, contains((true, 0xFFC8))); // F11
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
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
    await _rail(tester, 'clipboard');
    await tester.tap(find.text('复制远端剪贴板到本机'));
    await tester.pumpAndSettle();
    final set = calls.lastWhere((c) => c.method == 'Clipboard.setData');
    expect((set.arguments as Map)['text'], '从远端来');

    // 面板还开着：直接点第二个动作，不再开关一次侧栏。
    await tester.tap(find.text('写入并粘贴到远端（⌘V）'));
    await tester.pumpAndSettle();
    expect(
      service.requests
          .where((r) => r['op'] == 'clipboard-write')
          .single['text'],
      '从手机剪贴板来',
    );
    // 写入之后还要真的按一次 ⌘V（live 模式走 RFB 键事件）。
    final keys = [
      for (final e in service.input.events)
        if (e.length >= 8 && e[0] == 4)
          (e[1] != 0, (e[4] << 24) | (e[6] << 8) | e[7]),
    ];
    expect(keys, contains((true, 0x76)));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets(
    'a short landscape screen shrinks the rail instead of overflowing',
    (tester) async {
      await _open(tester, viewport: const Size(727, 340));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('rs-rail')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
