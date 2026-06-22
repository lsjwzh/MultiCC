// Widget tests for the Part 2 dashboard declutter:
//   * EventTimeline is collapsed by default and expands on tap.
//   * SessionCard collapses its former 6-icon action row into a single ⋯ menu.
//
// These lock in the lean layout so a future change can't silently bring back the
// always-expanded timeline or the row of icon buttons.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/screens/main_shell.dart';

Future<Widget> _wrap(Widget child) async => MaterialApp(home: Scaffold(body: child));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

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
}
