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
import 'package:multicc_app/screens/chat_screen.dart';
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

/// Taps a row inside the sidebar. The sidebar scrolls (and 「更多与系统」is a
/// collapsed section by default), so bring the row into view first — a plain
/// `find.text` can resolve to an off-screen row that the tap silently misses.
Future<bool> _tapInDrawer(WidgetTester tester, String label) async {
  final target = find.text(label);
  if (target.evaluate().isEmpty) return false;
  try {
    await tester.ensureVisible(target.first);
    await tester.pump();
  } catch (_) {}
  return _tapText(tester, label);
}


/// Polls until [finder] matches, pumping between attempts. The chat page is a
/// draggable sheet that mounts *after* `AirService.openTask()` round-trips the
/// server, so a fixed delay is a coin flip: this waits for the real thing.
Future<bool> _waitFor(
  WidgetTester tester,
  Finder finder, {
  int seconds = 20,
}) async {
  for (var i = 0; i < seconds; i++) {
    await tester.pump();
    if (finder.evaluate().isNotEmpty) return true;
    await Future<void>.delayed(const Duration(seconds: 1));
    await tester.pump();
  }
  return finder.evaluate().isNotEmpty;
}

/// The visible error copy, if any. When a step silently no-ops, this is the
/// difference between "the tour is broken" and "the server said no".
String _visibleError(WidgetTester tester) {
  final hits = <String>[];
  for (final element in find.byType(Text).evaluate()) {
    final data = (element.widget as Text).data;
    if (data == null || data.isEmpty) continue;
    if (data.contains('失败') ||
        data.contains('无法') ||
        data.contains('错误') ||
        data.contains('异常') ||
        data.contains('不能')) {
      hits.add(data);
    }
  }
  return hits.take(3).join(' | ');
}

/// The tile the tour should open. The home list carries archived rows, and an
/// archived/observed record has no resumable session of its own — tapping it
/// used to land on an error toast instead of the chat page. Prefer a row that
/// is bound to a live session, fall back to whatever is there.
Finder _openableTaskTile() {
  final bound = find
      .byWidgetPredicate(
        (w) => w is AirTaskTile && !w.task.readOnly && w.task.sessionId != null,
      )
      .hitTestable();
  if (bound.evaluate().isNotEmpty) return bound.first;
  return find.byType(AirTaskTile).hitTestable().first;
}

/// The guided tour re-appears *inside* the chat sheet (step 3/4 covers the
/// composer and the message list), so the first-run dismissal has to run again
/// once the chat is up — otherwise every chat frame is half overlay.
Future<void> _skipOnboarding(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    if (!await _tapText(tester, '跳过')) break;
    await _settle(tester, 1);
  }
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

    // 原生任务图谱（Web `#side-more` 里的 `data-air-view="taskgraph"`）。它是
    // 一个 push 出来的整页，所以先取好 Navigator 再 pop 回来。
    await _openDrawer(tester);
    await _tapInDrawer(tester, '更多与系统');
    await _settle(tester, 1);
    final graphNavigator = tester.state<NavigatorState>(
      find.byType(Navigator).first,
    );
    if (await _tapInDrawer(tester, '任务图谱')) {
      final graphUp = await _waitFor(
        tester,
        find.byKey(const ValueKey('task-graph-canvas')),
        seconds: 15,
      );
      debugPrint('TOUR:task-graph-up:$graphUp');
      await _settle(tester, 3);
      await _mark(tester, '06-task-graph');
      graphNavigator.pop();
      await _settle(tester, 2);
    } else {
      debugPrint('TOUR:no-task-graph-entry');
    }
    await _closeDrawer(tester);

    // Tapping a task tile hands off to its chat, which is the App's session UI.
    // The chat is a sheet that slides up over the home once the open round-trip
    // finishes, so wait for [ChatView] instead of guessing a delay.
    final taskTile = _openableTaskTile();
    if (taskTile.evaluate().isNotEmpty) {
      final opened = (taskTile.evaluate().first.widget as AirTaskTile).task;
      debugPrint('TOUR:opening-task:${opened.id}:${opened.title}');
      await tester.tap(taskTile, warnIfMissed: false);
      final chatUp = await _waitFor(tester, find.byType(ChatView), seconds: 25);
      debugPrint('TOUR:chat-up:$chatUp');
      if (!chatUp) {
        final err = _visibleError(tester);
        debugPrint('TOUR:chat-error:${err.isEmpty ? "(no visible error)" : err}');
      }
      await _settle(tester, 3);
      await _skipOnboarding(tester);
      await _mark(tester, '04-chat');

      // 聊天页头那颗 overflow 菜单是 ⋯（`Icons.more_vert`，`chat_header.dart`
      // 的 `_HeaderOverflowMenu`）—— 不是横排的 more_horiz。首页页头也有一颗
      // 同款图标压在下层，所以取 hitTestable 里的最后一颗。
      final headerMenu = find.byIcon(Icons.more_vert).hitTestable();
      if (headerMenu.evaluate().isNotEmpty) {
        await tester.tap(headerMenu.last, warnIfMissed: false);
        await _settle(tester, 2);
        await _mark(tester, '05-chat-actions');
        // Close the menu again so the next step starts from a clean sheet.
        await tester.tapAt(const Offset(20, 120));
        await _settle(tester, 1);
      } else {
        debugPrint('TOUR:no-chat-menu');
      }
    } else {
      debugPrint('TOUR:no-task-tile');
    }

    debugPrint('TOUR:done');
  });
}
