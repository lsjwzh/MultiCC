// Repro for 「输入框被遮挡，看不到正在输入的内容」: opens a real chat, focuses the
// composer, injects text, lets the software keyboard rise, then prints the
// geometry (composer rect vs visible bottom vs floating docks) and dwells so
// the host can `simctl io screenshot` the exact frame.
//
//   cd app && flutter test integration_test/keyboard_occlusion_repro_test.dart \
//     -d <simulator-udid> --dart-define=SKIP_NOTIF_PROMPT=true
//
// Needs the simulator's I/O > Keyboard > Connect Hardware Keyboard turned OFF,
// otherwise no software keyboard (and no viewInsets) ever appears.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:multicc_app/main.dart' as app;
import 'package:multicc_app/screens/chat_screen.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/floating_dock.dart';
import 'package:multicc_app/widgets/dispatch_floating_dock.dart';
import 'package:multicc_app/widgets/scheduled_send_dock.dart';
import 'package:multicc_app/widgets/background_tasks_dock.dart';

const _composerKey = Key('chat-message-input');

Future<void> _settle(WidgetTester tester, [int seconds = 3]) async {
  await tester.pump();
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester.pump();
}

Future<bool> _tapText(WidgetTester tester, String text) async {
  final finder = find.text(text);
  if (finder.evaluate().isEmpty) return false;
  try {
    await tester.tap(finder.first, warnIfMissed: false);
    await tester.pump();
    return true;
  } catch (_) {
    return false;
  }
}

Future<void> _dismissOverlays(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    var tapped = false;
    for (final label in const ['跳过', '知道了', '完成', '开始使用', '允许']) {
      if (await _tapText(tester, label)) tapped = true;
    }
    if (!tapped) break;
    await _settle(tester, 1);
  }
}

Future<void> _configureIfNeeded(WidgetTester tester) async {
  if (find.text('验证并连接').evaluate().isEmpty) return;
  const url = String.fromEnvironment(
    'MULTICC_SIM_URL',
    defaultValue: 'http://127.0.0.1:3000',
  );
  final fields = find.byType(TextField);
  if (fields.evaluate().isNotEmpty) {
    await tester.enterText(fields.at(0), url);
    await tester.pump();
  }
  FocusManager.instance.primaryFocus?.unfocus();
  await _settle(tester, 1);
  await _tapText(tester, '验证并连接');
  await _settle(tester, 8);
  for (final label in const ['好', '确定', '知道了', 'OK', '跳过']) {
    await _tapText(tester, label);
  }
  await _settle(tester, 3);
}

Future<bool> _waitFor(WidgetTester tester, Finder finder, {int seconds = 25}) async {
  for (var i = 0; i < seconds; i++) {
    await tester.pump();
    if (finder.evaluate().isNotEmpty) return true;
    await Future<void>.delayed(const Duration(seconds: 1));
    await tester.pump();
  }
  return finder.evaluate().isNotEmpty;
}

Finder _openableTaskTile() {
  final bound = find
      .byWidgetPredicate(
        (w) => w is AirTaskTile && !w.task.readOnly && w.task.sessionId != null,
      )
      .hitTestable();
  if (bound.evaluate().isNotEmpty) return bound.first;
  return find.byType(AirTaskTile).hitTestable().first;
}

void _reportGeometry(WidgetTester tester, String tag) {
  final composer = find.byKey(_composerKey);
  if (composer.evaluate().isEmpty) {
    debugPrint('REPRO:$tag:composer-missing');
    return;
  }
  final context = tester.element(composer.first);
  final mq = MediaQuery.of(context);
  final rect = tester.getRect(composer.first);
  final visibleBottom = mq.size.height - mq.viewInsets.bottom;
  debugPrint(
    'REPRO:$tag:view=${mq.size.width}x${mq.size.height} '
    'viewInsets.bottom=${mq.viewInsets.bottom} '
    'padding.bottom=${mq.padding.bottom} '
    'composerRect=${rect.left.toStringAsFixed(1)},${rect.top.toStringAsFixed(1)},${rect.right.toStringAsFixed(1)},${rect.bottom.toStringAsFixed(1)} '
    'visibleBottom=${visibleBottom.toStringAsFixed(1)} '
    'composerBelowVisibleBottom=${rect.bottom > visibleBottom + 1}',
  );
  for (final type in <Type>[
    FloatingDock,
    DispatchFloatingDock,
    ScheduledSendDock,
    BackgroundTasksFloatingDock,
  ]) {
    final dock = find.byType(type);
    if (dock.evaluate().isEmpty) continue;
    final dr = tester.getRect(dock.first);
    final overlaps =
        dr.left < rect.right && dr.right > rect.left && dr.top < rect.bottom && dr.bottom > rect.top;
    debugPrint(
      'REPRO:$tag:dock=$type rect=${dr.left.toStringAsFixed(1)},${dr.top.toStringAsFixed(1)},${dr.right.toStringAsFixed(1)},${dr.bottom.toStringAsFixed(1)} overlapsComposer=$overlaps',
    );
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('composer keyboard occlusion repro', (tester) async {
    app.main();
    await _settle(tester, 8);
    await _configureIfNeeded(tester);
    await _dismissOverlays(tester);

    final tile = _openableTaskTile();
    if (tile.evaluate().isEmpty) {
      debugPrint('REPRO:no-task-tile');
      return;
    }
    await tester.tap(tile, warnIfMissed: false);
    final chatUp = await _waitFor(tester, find.byType(ChatView));
    debugPrint('REPRO:chat-up:$chatUp');
    await _settle(tester, 3);
    for (var i = 0; i < 3; i++) {
      if (!await _tapText(tester, '跳过')) break;
      await _settle(tester, 1);
    }

    _reportGeometry(tester, 'before-focus');

    final composer = find.byKey(_composerKey);
    if (composer.evaluate().isEmpty) {
      debugPrint('REPRO:composer-missing');
      return;
    }
    await tester.tap(composer.first, warnIfMissed: false);
    await tester.pump();
    await tester.enterText(
      composer.first,
      '遮挡复现：正在输入的内容 hello world 1234567890',
    );
    // Let the real software keyboard finish its slide-in animation.
    await _settle(tester, 4);
    _reportGeometry(tester, 'keyboard-up');

    debugPrint('SHOT:keyboard-up:${DateTime.now().millisecondsSinceEpoch}');
    await Future<void>.delayed(const Duration(seconds: 20));
    await tester.pump();
    debugPrint('REPRO:done');
  });
}
