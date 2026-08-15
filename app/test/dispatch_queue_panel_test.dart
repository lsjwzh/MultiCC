import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/dispatch_queue.dart';
import 'package:multicc_app/widgets/chat_runtime_panels.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: 360, child: SingleChildScrollView(child: child)),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  // 模拟 SessionManager.sessionDisplayName：label 优先、回退 id。
  String resolve(String id) => switch (id) {
    's-worker' => '全栈工程师 1',
    _ => id,
  };

  testWidgets('empty queue hides the panel entirely (空态不占位)', (tester) async {
    await tester.pumpWidget(
      _host(
        DispatchQueuePanel(entries: const [], resolveName: resolve),
      ),
    );
    expect(find.byKey(const Key('dispatch-queue-panel')), findsNothing);
  });

  testWidgets('rows show direction + readable name + mode + queue position/length', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DispatchQueuePanel(
          entries: const [
            DispatchQueueEntry(
              operationId: 'op-out',
              relation: 'owner',
              ownerSessionId: 'me',
              targetSessionId: 's-worker',
              mode: 'sync',
              queueState: 'queued',
              queuePosition: 2,
              queueLength: 3,
              createdAt: 10,
            ),
            DispatchQueueEntry(
              operationId: 'op-in',
              relation: 'target',
              ownerSessionId: 'commander-x',
              targetSessionId: 'me',
              mode: 'one_way',
              queueState: 'started',
              createdAt: 20,
            ),
          ],
          resolveName: resolve,
        ),
      ),
    );

    // Outgoing row: readable target name (not the raw id), sync mode chip,
    // queued position with the queue depth.
    final outRow = find.byKey(const Key('dispatch-row-op-out'));
    expect(outRow, findsOneWidget);
    expect(find.text('派给 全栈工程师 1 · 同步'), findsOneWidget);
    expect(find.text('第 2 位（共 3 条）'), findsOneWidget);
    // Incoming row: counterpart is the commander, single-way mode, running.
    expect(find.byKey(const Key('dispatch-row-op-in')), findsOneWidget);
    expect(find.text('来自 commander-x · 单向'), findsOneWidget);
    expect(find.text('运行中'), findsOneWidget);
    // No prompt text is ever rendered — the DTO does not carry it either.
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('long queues cap at six rows with a "more" note', (tester) async {
    final entries = List.generate(
      8,
      (i) => DispatchQueueEntry(
        operationId: 'op-$i',
        relation: 'owner',
        targetSessionId: 's-worker',
        queueState: 'queued',
        queuePosition: i + 1,
        createdAt: i,
      ),
    );
    await tester.pumpWidget(
      _host(DispatchQueuePanel(entries: entries, resolveName: resolve)),
    );
    expect(find.byKey(const Key('dispatch-row-op-7')), findsNothing);
    expect(find.byKey(const Key('dispatch-row-op-5')), findsOneWidget);
    expect(find.text('还有 2 条'), findsOneWidget);
  });
}
