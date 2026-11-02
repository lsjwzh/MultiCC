import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/context_source_details.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await I18n.init('zh');
  });
  testWidgets(
    'memory sources show scope, version, truncation and managed budget omissions',
    (tester) async {
      expect(contextSourceLabel('memory:skill'), '记忆·技能');
      expect(
        contextSourceMeta({'version': 'abcdef', 'truncated': true}),
        contains('已截断'),
      );
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: ContextBudgetDetails(
              trace: {
                'budget': {'used': 300, 'limit': 8000},
                'omitted': [
                  {'id': 'memory:large', 'reason': 'budget'},
                ],
                'retained': [
                  {'id': 'memory:prior', 'taskName': '沿用资料'},
                ],
              },
            ),
          ),
        ),
      );
      expect(find.text('托管上下文：约 300 / 8000 tokens'), findsOneWidget);
      expect(find.text('沿用 1 项 · 省略 1 项'), findsOneWidget);
      await tester.tap(find.byType(ExpansionTile));
      await tester.pumpAndSettle();
      expect(find.text('budget'), findsOneWidget);
      expect(find.text('此前已注入，本轮未重复发送'), findsOneWidget);
    },
  );

  group('contextTrace 摘要 / 完整两种形态', () {
    tearDown(() => I18n.switchLang('zh'));

    Map<String, dynamic> currentTask() => {
      'taskId': 'tsk-now',
      'taskName': '当前任务',
      'mode': 'native',
    };

    // 旧消息内嵌的完整对象：sources/retained/omitted/diagnostics 全在。
    Map<String, dynamic> fullTrace() => {
      'version': 1,
      'traceId': 'sr-1',
      'currentTask': currentTask(),
      'sources': [
        {
          'taskId': 'tsk-a',
          'taskName': '来源甲',
          'mode': 'refilled',
          'messageCount': 2,
          'estimatedTokens': 1500,
          'messages': [
            {'role': 'user', 'content': '甲的提问'},
            {'role': 'assistant', 'content': '甲的回答'},
          ],
        },
        {
          'id': 'memory:shared/a',
          'taskName': '记忆甲',
          'mode': 'memory:shared',
          'path': 'shared/a.md',
          'version': 'abcdef123456789',
          'truncated': true,
        },
      ],
      'managedOnly': true,
      'budget': {'used': 300, 'limit': 8000},
      'contextStatus': 'committed',
      'retained': [],
      'omitted': [
        {'id': 'memory:big', 'reason': 'budget'},
      ],
      'diagnostics': [],
    };

    // 新消息内嵌的摘要：没有任何数组，数量只能读 count。
    Map<String, dynamic> summaryTrace({Object? count = 7}) => {
      'version': 1,
      'traceId': 'sr-9',
      'currentTask': currentTask(),
      'managedOnly': true,
      'summary': true,
      if (count != null) 'count': count,
      'budget': {'limit': 8000, 'used': 1200, 'managedOnly': true},
      'contextStatus': 'committed',
    };

    Future<void> pumpSection(
      WidgetTester tester,
      Map<String, dynamic> trace, {
      bool loading = false,
      String error = '',
    }) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ContextTraceSection(
              trace: trace,
              loading: loading,
              error: error,
            ),
          ),
        ),
      ),
    );

    test('数量：摘要读 count，完整对象数 sources，缺 count 时退回数 sources', () {
      expect(contextTraceCount(null), 0);
      expect(contextTraceCount(summaryTrace()), 7);
      expect(contextTraceCount(summaryTrace(count: '5')), 5);
      expect(contextTraceCount(summaryTrace(count: null)), 1);
      expect(contextTraceCount(fullTrace()), 3);
      // count 只在摘要态才算数：完整对象里的任何 count 字段都不覆盖 sources。
      expect(contextTraceCount({...fullTrace(), 'count': 99}), 3);
    });

    test('只有摘要，或完整对象带 sources 时才需要去拉明细', () {
      expect(contextTraceNeedsDetail(null), isFalse);
      expect(contextTraceNeedsDetail(summaryTrace()), isTrue);
      expect(contextTraceNeedsDetail(fullTrace()), isTrue);
      expect(
        contextTraceNeedsDetail({
          'traceId': 'x',
          'currentTask': currentTask(),
          'sources': [],
        }),
        isFalse,
      );
    });

    test('省略总数不重复计 omittedCounts 里已逐条列出的原因', () {
      final omitted = [
        {'id': 'memory:big', 'reason': 'budget'},
      ];
      expect(contextOmittedTotal(omitted, const {}), 1);
      // 只统计未列出的原因
      expect(contextOmittedTotal(omitted, {'not_relevant': 12}), 13);
      // 统计里把已列出的原因也算上
      expect(contextOmittedTotal(omitted, {'not_relevant': 12, 'budget': 1}), 13);
      expect(
        contextOmittedCounts({
          'omittedCounts': {'not_relevant': 3, 'bad': 0, 'x': 'oops'},
        }),
        {'not_relevant': 3},
      );
    });

    testWidgets('摘要：来源数用 count，不画逐条来源，也不伪造「沿用 0 项」', (tester) async {
      await pumpSection(tester, summaryTrace(), loading: true);
      expect(find.text('引用 7'), findsOneWidget);
      expect(find.text('当前任务'), findsOneWidget);
      expect(find.text('tsk-now'), findsOneWidget);
      expect(find.text('托管上下文：约 1200 / 8000 tokens'), findsOneWidget);
      expect(find.textContaining('沿用'), findsNothing);
      expect(find.byType(ExpansionTile), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      expect(find.text(t('usageContextDetailExpired')), findsNothing);
    });

    testWidgets('摘要拉取失败：数量与错误文案都还在', (tester) async {
      await pumpSection(
        tester,
        summaryTrace(),
        error: t('usageContextLoadFailed'),
      );
      expect(find.text('引用 7'), findsOneWidget);
      expect(find.text('引用内容读取失败，请稍后重试。'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
    });

    testWidgets('旧的完整 trace 显示不变：数量、来源行、预算与省略', (tester) async {
      await pumpSection(tester, fullTrace());
      expect(find.text('引用 3'), findsOneWidget);
      expect(find.text('来源甲'), findsOneWidget);
      expect(find.text('按需补取 · 2 条消息 · 约 1.5K tokens'), findsOneWidget);
      expect(find.text('记忆甲'), findsOneWidget);
      expect(find.text('记忆·目录 · 已截断 · v abcdef123456'), findsOneWidget);
      expect(find.text('托管上下文：约 300 / 8000 tokens'), findsOneWidget);
      expect(find.text('沿用 0 项 · 省略 1 项'), findsOneWidget);
      expect(find.text(t('usageContextDetailExpired')), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsNothing);

      // 展开来源甲：消息正文照旧在。
      await tester.tap(find.text('来源甲'));
      await tester.pumpAndSettle();
      expect(find.text('甲的提问'), findsOneWidget);
      expect(find.text('甲的回答'), findsOneWidget);

      // 展开预算：省略原因仍是原样的原因码，且没有 omittedCounts 行。
      await tester.tap(find.text('托管上下文：约 300 / 8000 tokens'));
      await tester.pumpAndSettle();
      expect(find.text('memory:big'), findsOneWidget);
      expect(find.text('budget'), findsOneWidget);
      expect(find.textContaining('与本轮无关'), findsNothing);
    });

    Map<String, dynamic> expiredTrace() => {
      ...fullTrace(),
      'detailExpired': true,
      'sources': [
        {
          'taskId': 'tsk-a',
          'taskName': '来源甲',
          'mode': 'refilled',
          'messageCount': 2,
        },
        // 过期后沿用来源只剩 id/version/reason。
        {
          'id': 'memory:old',
          'version': 'abcdef123456789',
          'reason': 'retained',
          'retained': true,
        },
      ],
      'omittedCounts': {'not_relevant': 12, 'budget': 1},
    };

    testWidgets('detailExpired：顶部有提示，只剩 id 的来源不崩也不冒充导入', (tester) async {
      await pumpSection(tester, expiredTrace());
      expect(
        find.text('这一轮较早，沿用与省略明细已清理，仅保留实际注入的来源'),
        findsOneWidget,
      );
      expect(find.text('引用 3'), findsOneWidget);
      expect(find.text('来源甲'), findsOneWidget);
      // 没 taskName/taskId 的来源用 id 当标题，副标题只留还剩的元信息。
      expect(find.text('memory:old'), findsOneWidget);
      expect(
        find.text('此前已注入，本轮未重复发送 · v abcdef123456'),
        findsOneWidget,
      );
      expect(find.textContaining('初始化导入'), findsNothing);
      expect(find.textContaining('0 条消息'), findsNothing);
    });

    testWidgets('omittedCounts：省略总数与按原因计数都显示', (tester) async {
      await pumpSection(tester, expiredTrace());
      // 逐条 1 个 budget + 只在统计里的 12 个 not_relevant
      expect(find.text('沿用 0 项 · 省略 13 项'), findsOneWidget);
      await tester.tap(find.text('托管上下文：约 300 / 8000 tokens'));
      await tester.pumpAndSettle();
      expect(find.text('与本轮无关 12 条'), findsOneWidget);
      expect(find.text('超出上下文预算 1 条'), findsOneWidget);
      // 逐条列出的 omitted 仍是原样。
      expect(find.text('memory:big'), findsOneWidget);
    });

    testWidgets('detailExpired 提示与计数文案有英文', (tester) async {
      I18n.switchLang('en');
      await pumpSection(tester, expiredTrace());
      final hint = t('usageContextDetailExpired');
      expect(hint, isNot('usageContextDetailExpired'));
      expect(hint.contains('这一轮'), isFalse);
      expect(find.text(hint), findsOneWidget);
      expect(find.text('Sources 3'), findsOneWidget);
      await tester.tap(find.text('Managed context: ~300 / 8000 tokens'));
      await tester.pumpAndSettle();
      expect(find.text('Not relevant to this turn: 12'), findsOneWidget);
    });

    group('ContextTraceLoader', () {
      Future<void> pumpLoader(
        WidgetTester tester,
        Map<String, dynamic> trace,
        Future<Map<String, dynamic>> Function() load,
      ) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ContextTraceLoader(trace: trace, load: load),
            ),
          ),
        ),
      );

      testWidgets('摘要：先显示 count 与进度条，明细回来后换成完整来源，只拉一次', (tester) async {
        final done = Completer<Map<String, dynamic>>();
        var calls = 0;
        Future<Map<String, dynamic>> load() {
          calls += 1;
          return done.future;
        }

        await pumpLoader(tester, summaryTrace(), load);
        expect(calls, 1);
        expect(find.text('引用 7'), findsOneWidget);
        expect(find.byType(LinearProgressIndicator), findsOneWidget);
        expect(find.text('来源甲'), findsNothing);

        done.complete(expiredTrace());
        await tester.pump();
        await tester.pump();
        expect(find.byType(LinearProgressIndicator), findsNothing);
        // 明细是权威的：数量按拉回来的 sources 数。
        expect(find.text('引用 3'), findsOneWidget);
        expect(find.text('来源甲'), findsOneWidget);
        expect(find.text('memory:old'), findsOneWidget);
        expect(find.text(t('usageContextDetailExpired')), findsOneWidget);
        // 摘要态那一行预算被可展开的完整版取代。
        expect(find.byType(ExpansionTile), findsWidgets);

        // 父级重建不重发请求。
        await pumpLoader(tester, summaryTrace(), load);
        await tester.pump();
        expect(calls, 1);
      });

      testWidgets('摘要拉取失败：保留 count 与当前任务，显示读取失败', (tester) async {
        await pumpLoader(
          tester,
          summaryTrace(),
          () => Future<Map<String, dynamic>>.error(Exception('boom')),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('引用 7'), findsOneWidget);
        expect(find.text('当前任务'), findsOneWidget);
        expect(find.text('引用内容读取失败，请稍后重试。'), findsOneWidget);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });

      testWidgets('旧的完整 trace 照旧：先画内嵌的，再用拉回的明细（带消息）替换', (tester) async {
        final done = Completer<Map<String, dynamic>>();
        await pumpLoader(tester, fullTrace(), () => done.future);
        expect(find.text('引用 3'), findsOneWidget);
        expect(find.text('来源甲'), findsOneWidget);
        expect(find.byType(LinearProgressIndicator), findsOneWidget);

        done.complete(fullTrace());
        await tester.pump();
        await tester.pump();
        expect(find.byType(LinearProgressIndicator), findsNothing);
        expect(find.text('引用 3'), findsOneWidget);
        expect(find.text('沿用 0 项 · 省略 1 项'), findsOneWidget);
        expect(find.text(t('usageContextDetailExpired')), findsNothing);
      });

      testWidgets('没有 sources 的完整对象不发请求', (tester) async {
        var calls = 0;
        await pumpLoader(
          tester,
          {'traceId': 'sr-0', 'currentTask': currentTask(), 'sources': []},
          () {
            calls += 1;
            return Future<Map<String, dynamic>>.value({});
          },
        );
        await tester.pump();
        expect(calls, 0);
        expect(find.text('引用 1'), findsOneWidget);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    });
  });
}
