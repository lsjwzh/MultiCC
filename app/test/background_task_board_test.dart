import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/background_task_board.dart';
import 'package:multicc_app/widgets/background_task_panel.dart';

/// Background-task board state machine (web chat-live-ui.js danmaku parity):
/// foreground gate, lifecycle, snapshot reconcile, turn-end settle, stale
/// sweep, row cap, dismiss stickiness — plus the panel widget itself.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  group('BackgroundTaskBoard', () {
    test('monitor_started creates a spinning row keyed by task id', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({
        'task_id': 't1',
        'description': 'npm test',
        'background': true,
      }, now: 100);

      final rows = board.rows();
      expect(rows, hasLength(1));
      expect(rows.first.key, 't:t1');
      expect(rows.first.state, BackgroundTaskState.start);
      expect(rows.first.description, 'npm test');
      expect(board.hasSpinning, isTrue);
    });

    test('foreground (background:false) commands never spawn rows', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({
        'task_id': 't2',
        'description': 'git status',
        'background': false,
      }, now: 100);
      board.onMonitorProgress({
        'task_id': 't2',
        'background': false,
      }, now: 110);
      board.onMonitorDone({
        'task_id': 't2',
        'background': false,
      }, now: 120);

      expect(board.rows(), isEmpty);
    });

    test('same task id updates in place instead of duplicating', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 't1', 'description': 'build'}, now: 1);
      board.onMonitorStarted({'task_id': 't1', 'description': 'build'}, now: 2);
      expect(board.rows(), hasLength(1));
    });

    test('monitor_done settles into done / fail by status', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 'ok', 'description': 'a'}, now: 1);
      board.onMonitorStarted({'task_id': 'bad', 'description': 'b'}, now: 1);
      board.onMonitorDone({'task_id': 'ok', 'status': 'done'}, now: 2);
      board.onMonitorDone({'task_id': 'bad', 'status': 'fail'}, now: 2);

      final byKey = {for (final r in board.rows()) r.key: r};
      expect(byKey['t:ok']!.state, BackgroundTaskState.done);
      expect(byKey['t:bad']!.state, BackgroundTaskState.fail);
      expect(board.hasSpinning, isFalse);
    });

    test('background_tasks snapshot confirms rows and settles dropped ones',
        () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 'keep', 'description': 'a'}, now: 1);
      board.onMonitorStarted({'task_id': 'gone', 'description': 'b'}, now: 1);

      board.onBackgroundTasksSnapshot({
        'tasks': [
          {'id': 'x1', 'task_id': 'keep', 'description': 'a'},
        ],
      }, now: 2);

      final byKey = {for (final r in board.rows()) r.key: r};
      expect(byKey['t:keep']!.confirmedBg, isTrue);
      expect(byKey['t:keep']!.state, BackgroundTaskState.start);
      // Dropped from the authoritative active set → settled, not spinning.
      expect(byKey['t:gone']!.state, BackgroundTaskState.done);
    });

    test('turn end settles unconfirmed rows; confirmed rows keep spinning', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 'unconfirmed'}, now: 1);
      board.onMonitorStarted({'task_id': 'real'}, now: 1);
      board.onBackgroundTasksSnapshot({
        'tasks': [
          {'task_id': 'real'},
        ],
      }, now: 2);

      board.settleAtTurnEnd(now: 3, turnId: 'turn-9');

      final byKey = {for (final r in board.rows()) r.key: r};
      expect(byKey['t:unconfirmed']!.state, BackgroundTaskState.done);
      expect(byKey['t:real']!.state, BackgroundTaskState.start);
    });

    test('heartbeat is one in-place row per turn with phase text', () {
      final board = BackgroundTaskBoard();
      board.onHeartbeat({
        'turnId': 'turn-1',
        'phase': 'tool',
        'toolKind': 'monitor',
        'elapsedMs': 8300,
      }, now: 1);
      board.onHeartbeat({
        'turnId': 'turn-1',
        'phase': 'thinking',
        'elapsedMs': 20000,
      }, now: 2);

      expect(board.rows(), hasLength(1));
      expect(board.rows().first.key, 'turn:turn-1');
      // With a toolKind the label prefixes the phase; a later phase-only
      // heartbeat refreshes the same row in place.
      board.onHeartbeat({
        'turnId': 'turn-1',
        'phase': 'tool',
        'toolKind': 'monitor',
        'elapsedMs': 9000,
      }, now: 3);
      expect(board.rows().first.description, contains('后台监控'));
      expect(board.rows().first.description, contains('正在调用工具'));
      expect(board.rows().first.description, contains('9s'));

      board.settleAtTurnEnd(now: 3, turnId: 'turn-1');
      expect(board.rows().first.state, BackgroundTaskState.done);
    });

    test('disconnect marks spinning rows stale', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 't1'}, now: 1);
      board.markStaleAll(now: 2);
      expect(board.rows().first.state, BackgroundTaskState.stale);
      expect(board.hasSpinning, isFalse);
    });

    test('sweep turns silent spinning rows stale after staleMs', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 't1'}, now: 1000);
      // Not yet stale.
      expect(board.sweep(now: 1000 + BackgroundTaskBoard.staleMs - 1), isFalse);
      // Past the window.
      expect(board.sweep(now: 1000 + BackgroundTaskBoard.staleMs + 1), isTrue);
      expect(board.rows().first.state, BackgroundTaskState.stale);
    });

    test('finished rows auto-hide at read time', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 't1'}, now: 1000);
      board.onMonitorDone({'task_id': 't1'}, now: 1000);

      // Immediately after finishing: still visible.
      expect(board.rows(now: 1000), hasLength(1));
      // Past auto-hide: gone without any mutation.
      expect(
        board.rows(now: 1000 + BackgroundTaskBoard.autoHideMs + 1),
        isEmpty,
      );
      // Spinning rows never auto-hide.
      board.onMonitorStarted({'task_id': 't2'}, now: 2000);
      expect(
        board.rows(now: 2000 + BackgroundTaskBoard.autoHideMs + 1),
        hasLength(1),
      );
    });

    test('dismissed rows stay hidden even when refreshed later', () {
      final board = BackgroundTaskBoard();
      board.onMonitorStarted({'task_id': 't1', 'description': 'a'}, now: 1);
      board.dismiss('t:t1');
      expect(board.rows(), isEmpty);

      board.onMonitorProgress({'task_id': 't1'}, now: 2);
      board.onMonitorDone({'task_id': 't1'}, now: 3);
      expect(board.rows(), isEmpty);
    });

    test('row cap: at most 8 rows, finished evicted first', () {
      final board = BackgroundTaskBoard();
      for (var i = 0; i < 10; i++) {
        board.onMonitorStarted({'task_id': 't$i'}, now: i);
      }
      // 8 spinning is exactly the cap.
      expect(board.rows(), hasLength(8));
      // Finishing old rows lets them be evicted as new ones arrive.
      board.onMonitorDone({'task_id': 't0'}, now: 100);
      board.onMonitorStarted({'task_id': 't99'}, now: 101);
      expect(board.rows(), hasLength(8));
      expect(
        board.rows().map((r) => r.taskId).toList(),
        isNot(contains('t0')),
      );
    });
  });

  group('BackgroundTaskPanel widget', () {
    Widget host(Widget child) => MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 360, child: Align(
              alignment: Alignment.bottomRight,
              child: child,
            )),
          ),
        );

    List<BackgroundTaskRow> rowsOf(List<(String, BackgroundTaskState)> spec) =>
        [
          for (var i = 0; i < spec.length; i++)
            BackgroundTaskRow(
              key: spec[i].$1,
              taskId: spec[i].$1.startsWith('t:') ? spec[i].$1.substring(2) : '',
              description: '任务 $i',
              state: spec[i].$2,
              updatedAt: i,
            ),
        ];

    testWidgets('collapsed pill shows the row count', (tester) async {
      await tester.pumpWidget(host(BackgroundTaskPanel(
        rows: rowsOf([
          ('t:1', BackgroundTaskState.start),
          ('t:2', BackgroundTaskState.done),
        ]),
        onDismiss: (_) {},
      )));
      expect(find.byKey(const Key('bg-task-pill')), findsOneWidget);
      expect(find.textContaining('2'), findsWidgets);
      expect(find.byKey(const Key('bg-task-panel')), findsNothing);
    });

    testWidgets('tap expands; rows render; ✕ dismisses locally', (tester) async {
      final dismissed = <String>[];
      await tester.pumpWidget(host(BackgroundTaskPanel(
        rows: rowsOf([
          ('t:1', BackgroundTaskState.start),
          ('t:2', BackgroundTaskState.fail),
        ]),
        onDismiss: dismissed.add,
      )));

      await tester.tap(find.byKey(const Key('bg-task-pill')));
      // A spinning row animates forever — pump one frame, don't settle.
      await tester.pump();

      expect(find.byKey(const Key('bg-task-panel')), findsOneWidget);
      expect(find.textContaining('任务 0'), findsOneWidget);
      expect(find.textContaining('任务 1'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.close).first);
      expect(dismissed, isNotEmpty);
    });

    testWidgets('empty rows render nothing', (tester) async {
      await tester.pumpWidget(host(BackgroundTaskPanel(
        rows: const [],
        onDismiss: (_) {},
      )));
      expect(find.byType(BackgroundTaskPanel), findsOneWidget);
      expect(find.byKey(const Key('bg-task-pill')), findsNothing);
    });
  });
}
