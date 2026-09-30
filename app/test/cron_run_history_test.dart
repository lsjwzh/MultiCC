import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/cron_run_history.dart';

/// 执行记录这块：数据（服务端 recentRuns → 模型）与界面（默认收起的那一小块）。
/// 为什么值得单独测：它存在的唯一理由是回答「今天到底跑没跑、哪次失败」，所以
/// 「没有记录时不摆空壳」「默认收起但入口说得清条数」「失败要把原文说出来」这三条
/// 就是它的全部契约。
final int _ranAt = DateTime(2026, 9, 23, 9, 0).millisecondsSinceEpoch;
final int _ranAt2 = DateTime(2026, 9, 22, 9, 0).millisecondsSinceEpoch;

Map<String, dynamic> _rule({List<dynamic>? recentRuns}) => {
  'id': 'c1',
  'name': '每日投放数据',
  'dirId': 'd1',
  'dirName': '工作目录 A',
  'cli': 'claude',
  'prompt': '整理昨天的投放数据',
  'cron': '0 9 * * *',
  'enabled': true,
  'runCount': 12,
  if (recentRuns != null) 'recentRuns': recentRuns,
};

const List<Map<String, dynamic>> _twoRuns = [
  {'at': 0, 'reason': 'schedule', 'status': 'ok', 'error': ''},
  {'at': 0, 'reason': 'manual', 'status': 'error', 'error': '发送失败：会话冻结'},
];

void main() {
  group('执行记录这条数据', () {
    test('recentRuns 原样进模型，顺序就是服务端给的（最近的在前）', () {
      final task = CronTask.fromJson(
        _rule(
          recentRuns: [
            {'at': _ranAt, 'reason': 'schedule', 'status': 'ok', 'error': ''},
            {
              'at': _ranAt2,
              'reason': 'manual',
              'status': 'error',
              'error': '发送失败：会话冻结',
            },
          ],
        ),
      );
      expect(task.runs.map((run) => run.at).toList(), [_ranAt, _ranAt2]);
      expect(task.runs.first.source, '定时');
      expect(task.runs.last.source, '手动');
      expect(task.runs.last.failed, isTrue);
      expect(task.runs.last.outcome, '发送失败：会话冻结');
    });

    test('旧服务端没有这一格、或有脏数据，都不炸：认不出来的条目直接丢掉', () {
      expect(CronTask.fromJson(_rule()).runs, isEmpty);
      final task = CronTask.fromJson(
        _rule(recentRuns: ['垃圾', 42, {'at': 'x', 'status': 'queued'}]),
      );
      expect(task.runs.length, 1);
      expect(task.runs.single.at, 0);
      expect(task.runs.single.outcome, '已入队');
    });

    test('三种结局各有各的说法，失败优先报原因原文', () {
      expect(const CronRun(at: 1, status: 'ok').outcome, '成功');
      expect(const CronRun(at: 1, status: 'queued').outcome, '已入队');
      expect(
        const CronRun(at: 1, status: 'error', error: '发送失败').outcome,
        '发送失败',
      );
      expect(const CronRun(at: 1, status: 'error').outcome, '失败');
      expect(const CronRun(at: 1, status: '').outcome, '失败');
    });

    test('时间：0 / 缺失说「—」，有值按本地时区报', () {
      expect(cronRunTime(0), '—');
      expect(cronRunTime(-1), '—');
      expect(cronRunTime(_ranAt), '9/23 09:00');
    });
  });

  group('执行记录这块界面', () {
    Future<void> pump(
      WidgetTester tester,
      CronTask task, {
      int visible = 8,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CronRunHistory(task: task, visible: visible),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('没有记录就什么都不摆 —— 这里不摆空壳', (tester) async {
      await pump(tester, CronTask.fromJson(_rule()));
      expect(find.textContaining('执行记录'), findsNothing);
      expect(find.byKey(const ValueKey('cron-runs-head-c1')), findsNothing);
    });

    testWidgets('默认收起：只说「最近 N 次 / 共 M 次」，点开才列明细', (tester) async {
      await pump(tester, CronTask.fromJson(_rule(recentRuns: _twoRuns)));
      expect(find.text('执行记录（最近 2 次 / 共 12 次）'), findsOneWidget);
      expect(find.text('发送失败：会话冻结'), findsNothing);
      expect(find.text('成功'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('cron-runs-head-c1')));
      await tester.pump();
      expect(find.byKey(const ValueKey('cron-run-c1-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('cron-run-c1-1')), findsOneWidget);
      expect(find.text('成功'), findsOneWidget);
      expect(find.text('发送失败：会话冻结'), findsOneWidget);
      expect(find.text('定时'), findsOneWidget);
      expect(find.text('手动'), findsOneWidget);

      // 再点一次收回去：这块的默认状态就是收起。
      await tester.tap(find.byKey(const ValueKey('cron-runs-head-c1')));
      await tester.pump();
      expect(find.text('成功'), findsNothing);
    });

    testWidgets('条数超过展示上限：只列最近几次，并说清只列了这么多', (tester) async {
      final runs = [
        for (var i = 0; i < 10; i++)
          {
            'at': _ranAt - i * 60000,
            'reason': 'schedule',
            'status': 'ok',
            'error': '',
          },
      ];
      await pump(
        tester,
        CronTask.fromJson(_rule(recentRuns: runs)),
        visible: 3,
      );
      expect(find.text('执行记录（最近 10 次 / 共 12 次）'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('cron-runs-head-c1')));
      await tester.pump();
      expect(find.byKey(const ValueKey('cron-run-c1-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('cron-run-c1-2')), findsOneWidget);
      expect(find.byKey(const ValueKey('cron-run-c1-3')), findsNothing);
      expect(find.text('只列最近 3 次'), findsOneWidget);
    });
  });
}
