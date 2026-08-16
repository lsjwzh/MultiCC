// Widget tests for the Part 2 dashboard declutter:
//   * EventTimeline is collapsed by default and expands on tap.
//   * SessionCard collapses its former 6-icon action row into a single ⋯ menu.
//
// These lock in the lean layout so a future change can't silently bring back the
// always-expanded timeline or the row of icon buttons.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/screens/main_shell.dart';
import 'package:multicc_app/widgets/session_card.dart';

Future<Widget> _wrap(Widget child) async => MaterialApp(home: Scaffold(body: child));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('EventTimeline', () {
    final events = [
      {'type': 'merged', 'sessionLabel': 's1', 'detail': '1 commit', 'ts': 1},
      {'type': 'note', 'sessionLabel': 's2', 'detail': 'hi', 'ts': 2},
    ];

    testWidgets('collapsed by default — shows the bar, hides event rows',
        (tester) async {
      await tester.pumpWidget(await _wrap(EventTimeline(events: events)));
      // The "活动 (N)" header bar is visible…
      expect(find.textContaining('活动'), findsOneWidget);
      // …but the individual event labels are not rendered yet.
      expect(find.textContaining('合并'), findsNothing);
      // A chevron-down affordance indicates it can expand.
      expect(find.byIcon(Icons.expand_more_rounded), findsOneWidget);
    });

    testWidgets('expands on tap to reveal events', (tester) async {
      await tester.pumpWidget(await _wrap(EventTimeline(events: events)));
      await tester.tap(find.textContaining('活动'));
      await tester.pumpAndSettle();
      // Now an event row is shown and the chevron flips to "up".
      expect(find.byIcon(Icons.expand_less_rounded), findsOneWidget);
      expect(find.textContaining('合并'), findsOneWidget);
    });

    testWidgets('renders nothing when there are no events', (tester) async {
      await tester.pumpWidget(await _wrap(const EventTimeline(events: [])));
      expect(find.textContaining('活动'), findsNothing);
    });
  });

  group('SessionCard action row', () {
    testWidgets('collapses the 6-icon row into a single ⋯ menu', (tester) async {
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final session = Session(
        id: 'sess-1',
        label: 'My Session',
        cli: SessionCli.claude,
        kind: SessionKind.chat,
        dirId: 'dir-1',
        createdAt: DateTime(2026, 1, 1),
        active: false,
      );

      await tester.pumpWidget(await _wrap(
        SessionCard(session: session, mgr: mgr, settings: settings),
      ));
      await tester.pump();

      // Exactly one overflow menu, holding the moved-in actions.
      expect(find.byType(PopupMenuButton<String>), findsOneWidget);
      expect(find.byIcon(Icons.more_horiz_rounded), findsOneWidget);

      // The old always-visible action icons are gone from the card surface
      // (they now live inside the popup, only shown when opened).
      expect(find.byIcon(Icons.difference_outlined), findsNothing);
      expect(find.byIcon(Icons.mail_outline_rounded), findsNothing);
      expect(find.byIcon(Icons.delete_outline_rounded), findsNothing);

      mgr.dispose();
    });

    testWidgets('⋯ menu opens with rename / diff / note / delete', (tester) async {
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final session = Session(
        id: 'sess-2',
        label: 'Another',
        cli: SessionCli.claude,
        kind: SessionKind.chat,
        dirId: 'dir-1',
        createdAt: DateTime(2026, 1, 1),
      );

      await tester.pumpWidget(await _wrap(
        SessionCard(session: session, mgr: mgr, settings: settings),
      ));
      await tester.pump();
      await tester.tap(find.byIcon(Icons.more_horiz_rounded));
      await tester.pumpAndSettle();

      expect(find.text('改名'), findsOneWidget);
      expect(find.text('查看 Diff'), findsOneWidget);
      expect(find.text('留言'), findsOneWidget);
      expect(find.text('删除'), findsOneWidget);

      mgr.dispose();
    });
  });

  group('SessionCard compact layout', () {
    // 空闲（idle）会话：状态图标与空闲文案都不渲染——⚪ 摆在行首只是噪音；
    // working 目录不再独占副标题行（fleet 面板本就按目录分组，目录名收进 ⋯ 菜单）。
    testWidgets('idle session renders no status icon and no cwd subtitle line', (
      tester,
    ) async {
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final session = Session(
        id: 'sess-idle',
        cli: SessionCli.claude,
        kind: SessionKind.chat,
        dirId: 'dir-1',
        cwd: '/repo/.multicc-worktrees/wt-alpha',
        createdAt: DateTime(2026, 1, 1),
        active: true,
      );

      await tester.pumpWidget(await _wrap(
        SessionCard(session: session, mgr: mgr, settings: settings),
      ));
      await tester.pump();

      // No ⚪ glyph — idle is the default state, not news worth an icon.
      expect(find.text('⚪'), findsNothing);
      // No 「空闲」 label either (pre-existing behaviour, locked in here).
      expect(find.text('空闲'), findsNothing);
      // The worktree dir name is not shown on the card surface…
      expect(find.text('wt-alpha'), findsNothing);
      // …but the id-as-title still identifies the session.
      expect(find.text('sess-idle'), findsOneWidget);

      mgr.dispose();
    });

    testWidgets('labeled session keeps the id subtitle line', (tester) async {
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final session = Session(
        id: 'sess-labeled',
        label: '全栈工程师1',
        cli: SessionCli.claude,
        kind: SessionKind.chat,
        dirId: 'dir-1',
        createdAt: DateTime(2026, 1, 1),
      );

      await tester.pumpWidget(await _wrap(
        SessionCard(session: session, mgr: mgr, settings: settings),
      ));
      await tester.pump();

      expect(find.text('全栈工程师1'), findsOneWidget);
      expect(find.text('sess-labeled'), findsOneWidget);

      mgr.dispose();
    });

    testWidgets('⋯ menu leads with a read-only working-directory row', (
      tester,
    ) async {
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final session = Session(
        id: 'sess-cwd',
        cli: SessionCli.claude,
        kind: SessionKind.chat,
        dirId: 'dir-1',
        cwd: '/Users/z/repo/.multicc-worktrees/sess-cwd',
        createdAt: DateTime(2026, 1, 1),
      );

      await tester.pumpWidget(await _wrap(
        SessionCard(session: session, mgr: mgr, settings: settings),
      ));
      await tester.pump();
      await tester.tap(find.byIcon(Icons.more_horiz_rounded));
      await tester.pumpAndSettle();

      // Short dir name inline, full path in the tooltip.
      final cwdRow = find.byKey(const Key('session-card-cwd'));
      expect(cwdRow, findsOneWidget);
      expect(
        tester.widget<Text>(cwdRow).data,
        'sess-cwd',
      );
      // The info row sits above the actionable items, which stay intact.
      expect(find.text('改名'), findsOneWidget);
      expect(find.text('删除'), findsOneWidget);

      mgr.dispose();
    });
  });
}
