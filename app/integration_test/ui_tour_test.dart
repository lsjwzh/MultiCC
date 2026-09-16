// Drives the real App on a booted device/simulator and dwells on every screen
// long enough for an external `xcrun simctl io booted screenshot` loop to grab
// it. Used for App-vs-web UI parity work: the host has no way to tap the
// simulator window (headless session), so the taps have to come from inside the
// app process.
//
// Run it with:
//   cd app && flutter test integration_test/ui_tour_test.dart \
//     -d <simulator-udid> --dart-define=SKIP_NOTIF_PROMPT=true
//
// It is intentionally not part of the default `flutter test` gate: it needs a
// live server + a booted simulator and it only produces screenshots.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:multicc_app/main.dart' as app;
import 'package:multicc_app/widgets/air/air_panels.dart';

/// How long each screen stays on screen so the host-side capture loop can catch
/// it. Keep in sync with the loop's interval (1.5s).
const Duration _dwell = Duration(seconds: 4);

Future<void> _mark(WidgetTester tester, String name) async {
  // The host correlates this timestamp with its screenshots (same clock).
  debugPrint('SHOT:$name:${DateTime.now().millisecondsSinceEpoch}');
  await tester.pump();
  await Future<void>.delayed(_dwell);
  await tester.pump();
}

Future<bool> _tapText(WidgetTester tester, String text) async {
  final finder = find.text(text);
  if (finder.evaluate().isEmpty) return false;
  try {
    await tester.tap(finder.first, warnIfMissed: false);
    await tester.pump();
    return true;
  } catch (error) {
    debugPrint('TOUR:tap-failed:$text:$error');
    return false;
  }
}

Future<void> _settle(WidgetTester tester, [int seconds = 3]) async {
  await tester.pump();
  await Future<void>.delayed(Duration(seconds: seconds));
  await tester.pump();
}

/// The first-run tour and the notification prompt are both dismissable, and
/// both would otherwise sit on top of every screenshot.
Future<void> _dismissOverlays(WidgetTester tester) async {
  for (final label in const ['跳过', '知道了', '完成', '开始使用', '允许']) {
    await _tapText(tester, label);
    await tester.pump(const Duration(milliseconds: 300));
  }
  await _settle(tester, 1);
}

/// `flutter test` installs the app into a fresh container, so the simulator
/// starts on the "connect to MultiCC" screen. Fill it in from --dart-define
/// values so the tour can reach the real dashboard.
Future<void> _configureIfNeeded(WidgetTester tester) async {
  if (find.text('验证并连接').evaluate().isEmpty) return;
  const url = String.fromEnvironment(
    'MULTICC_SIM_URL',
    defaultValue: 'http://127.0.0.1:3000',
  );
  const token = String.fromEnvironment('MULTICC_SIM_TOKEN');
  final fields = find.byType(TextField);
  if (fields.evaluate().isNotEmpty) {
    await tester.enterText(fields.at(0), url);
    await tester.pump();
  }
  if (fields.evaluate().length > 1 && token.isNotEmpty) {
    await tester.enterText(fields.at(1), token);
    await tester.pump();
  }
  // The software keyboard covers the connect button, so drop focus first.
  FocusManager.instance.primaryFocus?.unfocus();
  await _settle(tester, 1);
  await _tapText(tester, '验证并连接');
  await _settle(tester, 8);
  for (final label in const ['好', '确定', '知道了', 'OK', '跳过']) {
    await _tapText(tester, label);
  }
  await _settle(tester, 3);
}

/// Opens/closes the Air sidebar through the shell's [ScaffoldState].
/// Tapping the AppBar button is unreliable here: once the drawer is open the
/// button sits behind the scrim, so a tap lands on the scrim and closes it
/// again. The tree can hold more than one [Scaffold] (sheets, overlays) and
/// `openDrawer()` is a silent no-op on the ones without a `drawer`, so pick the
/// Scaffold that actually owns the sidebar instead of the first one found.
ScaffoldState? _shellScaffold(WidgetTester tester) {
  for (final element in find.byType(Scaffold).evaluate()) {
    final scaffold = element.widget as Scaffold;
    if (scaffold.drawer == null && scaffold.endDrawer == null) continue;
    final state = (element as StatefulElement).state;
    if (state is ScaffoldState) return state;
  }
  return null;
}

Future<void> _openDrawer(WidgetTester tester) async {
  final scaffold = _shellScaffold(tester);
  if (scaffold == null) {
    debugPrint('TOUR:no-scaffold');
    return;
  }
  scaffold.openDrawer();
  await _settle(tester, 1);
}

Future<void> _closeDrawer(WidgetTester tester) async {
  final scaffold = _shellScaffold(tester);
  if (scaffold == null) return;
  if (!scaffold.isDrawerOpen) return;
  scaffold.closeDrawer();
  await _settle(tester, 1);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('app ui tour', (tester) async {
    app.main();
    await _settle(tester, 8);
    await _configureIfNeeded(tester);
    await _dismissOverlays(tester);
    await _mark(tester, '01-home');

    // Air sidebar (the shell's `drawer:` — works the same way as the workspace
    // drawer did, the destinations just live in the Air sidebar now).
    await _openDrawer(tester);
    await _mark(tester, '02-sidebar');
    await _closeDrawer(tester);

    // 任务详情 bottom sheet, opened from the ⓘ on the first task tile.
    // `.hitTestable()` matters: the list keeps an offstage copy of the other
    // status tab (未完成/全部) in the tree, and `.first` happily picks a tile
    // that cannot be tapped, which silently no-ops the rest of the tour.
    final detailsButton = find.byTooltip('任务详情').hitTestable();
    if (detailsButton.evaluate().isNotEmpty) {
      // Grab the navigator *before* the sheet goes up: once it covers the list,
      // the ⓘ is no longer hit-testable and the finder resolves to nothing.
      final navigator = tester.state<NavigatorState>(
        find.byType(Navigator).first,
      );
      await tester.tap(detailsButton.first, warnIfMissed: false);
      await _settle(tester, 5);
      await _mark(tester, '03-task-details');
      // Dismiss the sheet again.
      navigator.pop();
      await _settle(tester, 3);
    } else {
      debugPrint('TOUR:no-task-details');
    }

    // Tapping a task tile hands off to its chat, which is the App's session UI.
    final taskTile = find.byType(AirTaskTile).hitTestable();
    if (taskTile.evaluate().isNotEmpty) {
      await tester.tap(taskTile.first, warnIfMissed: false);
      await _settle(tester, 12);
      await _mark(tester, '04-chat');

      final headerMenu = find.byIcon(Icons.more_horiz_rounded);
      if (headerMenu.evaluate().isNotEmpty) {
        await tester.tap(headerMenu.last, warnIfMissed: false);
        await _settle(tester, 2);
        await _mark(tester, '05-chat-actions');
      } else {
        debugPrint('TOUR:no-chat-menu');
      }
    } else {
      debugPrint('TOUR:no-task-tile');
    }

    debugPrint('TOUR:done');
  });
}
