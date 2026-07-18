import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/workspace_service.dart';
import 'package:multicc_app/widgets/directory_card.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      height: 800,
      child: SingleChildScrollView(child: child),
    ),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test('view model narrows domain data and derives live task state', () {
    final now = DateTime(2026, 7, 18, 12);
    final directory = Directory(
      id: 'dir-1',
      name: 'Fleet One',
      path: '/tmp/fleet-one',
      createdAt: now,
      claudeChatCount: 1,
      codexTerminalCount: 1,
      opencodeChatCount: 1,
      pushState: const DirectoryPushState(hasRemote: true, ahead: 2, dirty: 3),
    );
    final summarized = Session(
      id: 'summary-session',
      dirId: 'dir-1',
      label: 'Architect',
      kind: SessionKind.chat,
      createdAt: now.subtract(const Duration(hours: 2)),
      lastActivity: now.subtract(const Duration(minutes: 5)),
      active: true,
    );
    final otherDirectory = Session(
      id: 'other',
      dirId: 'dir-2',
      kind: SessionKind.chat,
      createdAt: now,
      active: true,
    );
    final statuses = <String, SessionStatus>{
      summarized.id: const SessionStatus(
        status: 'running',
        summary: 'Refactor directory boundary',
        summaryTs: 1234,
      ),
    };

    final view = DirectoryCardViewModel.fromModels(
      directory: directory,
      sessions: [summarized, otherDirectory],
      statuses: statuses,
      events: const [
        {'type': 'session_created', 'sessionLabel': 'Old'},
        {'type': 'synced', 'sessionLabel': 'Architect', 'detail': 'main'},
        {'type': 'merged', 'sessionLabel': 'Architect', 'detail': 'clean'},
      ],
      now: now,
    );

    expect(view.id, 'dir-1');
    expect(view.totalSessions, 3);
    expect(view.activeSessions, 1);
    expect(view.claudeSessions, 1);
    expect(view.codexSessions, 1);
    expect(view.opencodeSessions, 1);
    expect(view.running, isTrue);
    expect(view.latestTask?.who, 'Architect');
    expect(view.latestTask?.summary, 'Refactor directory boundary');
    expect(view.latestTask?.timestamp, 1234);
    expect(view.recentEventLabels, [
      '🔀 Architect 合并：clean',
      '🔄 Architect 同步：main',
    ]);
    expect(() => view.recentEventLabels.add('mutate'), throwsUnsupportedError);
  });

  test('view model keeps the previous fallback task wording', () {
    final now = DateTime(2026, 7, 18, 12);
    final session = Session(
      id: 'editing',
      dirId: 'dir-1',
      label: 'Editor',
      createdAt: now.subtract(const Duration(hours: 1)),
    );
    final view = DirectoryCardViewModel.fromModels(
      directory: Directory(
        id: 'dir-1',
        name: 'Fleet',
        path: '/tmp/fleet',
        createdAt: now,
      ),
      sessions: [session],
      statuses: const {
        'editing': SessionStatus(
          status: 'editing',
          currentFile: '/tmp/fleet/lib/router.dart',
        ),
      },
      events: const [],
      now: now,
    );

    expect(view.latestTask?.summary, '正在编辑 router.dart');
  });

  testWidgets('delegates navigation, menu, dirty, and drag intents', (
    tester,
  ) async {
    var opened = 0;
    var memoOpened = 0;
    var uncommittedOpened = 0;
    var renamed = 0;
    var deleted = 0;
    var dragEnded = 0;
    final hoverTargets = <String>[];
    final leaveTargets = <String>[];
    final drops = <String>[];

    await tester.pumpWidget(
      _host(
        DirectoryCard(
          view: const DirectoryCardViewModel(
            id: 'dir-1',
            name: 'Fleet One',
            path: '/tmp/fleet-one',
            totalSessions: 2,
            activeSessions: 1,
            claudeSessions: 1,
            codexSessions: 1,
            opencodeSessions: 0,
            zcodeSessions: 0,
            pushState: DirectoryPushState(hasRemote: true, ahead: 1, dirty: 2),
            running: false,
            recentEventLabels: ['🔄 Agent 同步：main'],
            latestTask: DirectoryTaskPreview(
              who: 'Agent',
              summary: 'Testing callbacks',
              timestamp: 123,
            ),
          ),
          callbacks: DirectoryCardCallbacks(
            onOpen: () => opened++,
            onOpenMemo: () => memoOpened++,
            onShowUncommitted: () => uncommittedOpened++,
            onRename: () => renamed++,
            onDelete: () => deleted++,
            onDragHover: hoverTargets.add,
            onDragLeave: leaveTargets.add,
            onDrop: (source, target) => drops.add('$source->$target'),
            onDragEnd: () => dragEnded++,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Fleet One'), findsOneWidget);
    expect(find.text('/tmp/fleet-one'), findsOneWidget);
    expect(find.text('🗒 Agent  Testing callbacks'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('directory-card-open-dir-1')));
    await tester.pump();
    expect(opened, 1);

    await tester.tap(find.byKey(const ValueKey('directory-card-memo-dir-1')));
    await tester.pump();
    expect(memoOpened, 1);

    await tester.tap(find.byKey(const ValueKey('directory-card-dirty-dir-1')));
    await tester.pump();
    expect(uncommittedOpened, 1);

    await tester.tap(find.byKey(const ValueKey('directory-card-menu-dir-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(t('rename')).last);
    await tester.pumpAndSettle();
    expect(renamed, 1);

    await tester.tap(find.byKey(const ValueKey('directory-card-menu-dir-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(t('deleteDirectory')).last);
    await tester.pumpAndSettle();
    expect(deleted, 1);

    final target = tester.widget<DragTarget<String>>(
      find.byWidgetPredicate((widget) => widget is DragTarget<String>),
    );
    expect(
      target.onWillAcceptWithDetails!(
        DragTargetDetails(data: 'source', offset: Offset.zero),
      ),
      isTrue,
    );
    expect(
      target.onWillAcceptWithDetails!(
        DragTargetDetails(data: 'dir-1', offset: Offset.zero),
      ),
      isFalse,
    );
    target.onLeave!('source');
    target.onAcceptWithDetails!(
      DragTargetDetails(data: 'source', offset: Offset.zero),
    );
    final draggable = tester.widget<LongPressDraggable<String>>(
      find.byWidgetPredicate((widget) => widget is LongPressDraggable<String>),
    );
    draggable.onDragEnd!(
      DraggableDetails(
        wasAccepted: true,
        velocity: Velocity.zero,
        offset: Offset.zero,
      ),
    );

    expect(hoverTargets, ['dir-1']);
    expect(leaveTargets, ['dir-1']);
    expect(drops, ['source->dir-1']);
    expect(dragEnded, 1);
  });
}
