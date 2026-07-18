import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/workspace_service.dart';
import 'package:multicc_app/widgets/home_task_scroller.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 900, height: 300, child: child)),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('shows only today non-aux sessions and delegates taps', (
    tester,
  ) async {
    final now = DateTime.now();
    final todayStart = DateTime(now.year, now.month, now.day);
    final yesterday = todayStart.subtract(const Duration(microseconds: 1));
    final directories = [
      Directory(
        id: 'dir-1',
        name: 'Fleet One',
        path: '/tmp/fleet-one',
        createdAt: now,
      ),
    ];
    final recent = Session(
      id: 'recent',
      label: 'Recent task',
      kind: SessionKind.chat,
      dirId: 'dir-1',
      createdAt: now,
      lastActivity: now,
      active: true,
    );
    final olderToday = Session(
      id: 'older',
      label: 'Older task',
      kind: SessionKind.chat,
      dirId: 'dir-1',
      createdAt: todayStart,
      lastActivity: todayStart,
    );
    final old = Session(
      id: 'old',
      label: 'Yesterday task',
      kind: SessionKind.chat,
      dirId: 'dir-1',
      createdAt: yesterday,
      lastActivity: yesterday,
    );
    final aux = Session(
      id: 'aux',
      label: 'Aux task',
      kind: SessionKind.chat,
      dirId: 'dir-1',
      createdAt: now,
      lastActivity: now,
      type: 'aux',
    );
    final liveLookups = <String>[];
    Session? tapped;

    await tester.pumpWidget(
      _host(
        HomeTaskScroller(
          key: const Key('home-task-scroller'),
          sessions: [old, olderToday, aux, recent],
          directories: directories,
          liveStatusFor: (sessionId) {
            liveLookups.add(sessionId);
            return sessionId == 'recent'
                ? const SessionStatus(status: 'running', classifyState: 'C')
                : null;
          },
          onSessionTap: (session) => tapped = session,
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('home-task-scroller')), findsOneWidget);
    expect(
      find.textContaining('Recent task', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('Older task', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('Yesterday task', findRichText: true),
      findsNothing,
    );
    expect(find.textContaining('Aux task', findRichText: true), findsNothing);
    expect(
      find.textContaining('Fleet One', findRichText: true),
      findsNWidgets(2),
    );
    expect(liveLookups, containsAllInOrder(['older', 'recent']));

    final recentTop = tester.getTopLeft(
      find.textContaining('Recent task', findRichText: true),
    );
    final olderTop = tester.getTopLeft(
      find.textContaining('Older task', findRichText: true),
    );
    expect(recentTop.dy, lessThan(olderTop.dy));

    await tester.tap(find.textContaining('Recent task', findRichText: true));
    await tester.pump();
    expect(tapped, same(recent));
  });

  testWidgets('renders the unchanged empty state without manager state', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        HomeTaskScroller(
          sessions: const [],
          directories: const [],
          liveStatusFor: (_) => null,
        ),
      ),
    );
    expect(find.text(t('noActiveTask')), findsOneWidget);
  });
}
