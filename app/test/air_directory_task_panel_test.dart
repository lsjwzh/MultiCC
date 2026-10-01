import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_directory_task_panel.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';

/// 目录任务卡与宿主共用一个滚动层；筛选、当前页和分页仍保持完整。
///
/// 这一组钉的是用户点名要的三件事：
/// * 筛选**默认就摆着**（从前藏在「查看全部」那颗按钮后面）；
/// * 从任务行反向滚动可返回真实表头；
/// * 条数多了走翻页（上一页 / 第 x / y 页 / 下一页），不再有「查看全部」那条
///   无限长的路。
AirTask _task(int i) => AirTask(
  id: 't$i',
  dirId: 'd1',
  title: '任务 $i',
  status: 'active',
  recordType: 'planned',
  updatedAt: 1000 + i,
  lastMessageAt: 1000 + i,
  readOnly: false,
  resource: const {'residency': 'planned', 'lease': 'idle'},
);

Widget _host({
  required List<AirTask> rows,
  required int filteredCount,
  required int totalCount,
  required int page,
  required int pageCount,
  ValueChanged<int>? onPage,
  ValueChanged<AirDirectoryTaskFilter>? onStatus,
  ValueChanged<String>? onSearch,
  ValueChanged<bool>? onScope,
  TextEditingController? controller,
}) => MaterialApp(
  home: Scaffold(
    body: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: AirDirectoryTaskPanel(
          rows: rows,
          filteredCount: filteredCount,
          totalCount: totalCount,
          page: page,
          pageCount: pageCount,
          sort: AirDirectoryTaskSort.message,
          searchController: controller ?? TextEditingController(),
          status: AirDirectoryTaskFilter.open,
          fullText: true,
          searching: false,
          searchFailed: false,
          onSort: (_) {},
          onSearch: onSearch ?? (_) {},
          onStatus: onStatus ?? (_) {},
          onScope: onScope ?? (_) {},
          onPage: onPage ?? (_) {},
          rowBuilder: (task) => SizedBox(
            key: ValueKey('row-${task.id}'),
            height: 48,
            child: Text(task.title),
          ),
        ),
      ),
    ),
  ),
);

void main() {
  setUpAll(() => I18n.init('zh'));

  testWidgets('筛选默认就摆着，抬头说的是「全部任务」与 x / y 个任务', (tester) async {
    await tester.pumpWidget(
      _host(
        rows: [_task(1), _task(2)],
        filteredCount: 2,
        totalCount: 8,
        page: 1,
        pageCount: 1,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-tasks-heading')), findsOneWidget);
    expect(find.text('全部任务'), findsOneWidget);
    expect(find.text('2 / 8 个任务'), findsOneWidget);
    // 三件筛选都在，不用先点开什么。
    expect(
      find.byKey(const ValueKey('air-directory-task-search')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-directory-task-status')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-directory-search-scope')),
      findsOneWidget,
    );
    // 一页装得下就不摆翻页条。
    expect(find.byKey(const ValueKey('air-tasks-page-prev')), findsNothing);
    expect(find.byKey(const ValueKey('air-tasks-page-next')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('改筛选/搜索都会往宿主报一次（值由宿主端着）', (tester) async {
    final searched = <String>[];
    final statuses = <AirDirectoryTaskFilter>[];
    final scopes = <bool>[];
    await tester.pumpWidget(
      _host(
        rows: [_task(1)],
        filteredCount: 1,
        totalCount: 8,
        page: 1,
        pageCount: 1,
        onSearch: searched.add,
        onStatus: statuses.add,
        onScope: scopes.add,
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('air-directory-task-search')),
      '登录',
    );
    expect(searched, ['登录']);

    await tester.tap(find.byKey(const ValueKey('air-directory-task-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('已归档').last);
    await tester.pumpAndSettle();
    expect(statuses, [AirDirectoryTaskFilter.archived]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('条数多了走翻页：上一页在第 1 页禁用，下一页报第 2 页', (tester) async {
    final pages = <int>[];
    await tester.pumpWidget(
      _host(
        rows: [for (var i = 1; i <= 20; i++) _task(i)],
        filteredCount: 25,
        totalCount: 25,
        page: 1,
        pageCount: 2,
        onPage: pages.add,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('第 1 / 2 页'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('air-tasks-page-prev')))
          .onPressed,
      isNull,
      reason: '已经在第 1 页，没有上一页可去',
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('air-tasks-page-next')),
    );
    await tester.tap(find.byKey(const ValueKey('air-tasks-page-next')));
    expect(pages, [2]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('最后一页上「下一页」禁用，上一页报前一页', (tester) async {
    final pages = <int>[];
    await tester.pumpWidget(
      _host(
        rows: [for (var i = 21; i <= 25; i++) _task(i)],
        filteredCount: 25,
        totalCount: 25,
        page: 2,
        pageCount: 2,
        onPage: pages.add,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('第 2 / 2 页'), findsOneWidget);
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('air-tasks-page-next')))
          .onPressed,
      isNull,
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('air-tasks-page-prev')),
    );
    await tester.tap(find.byKey(const ValueKey('air-tasks-page-prev')));
    expect(pages, [1]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('清单与抬头同属宿主滚动层，反向可回到页首', (tester) async {
    await tester.pumpWidget(
      _host(
        rows: [for (var i = 1; i <= 20; i++) _task(i)],
        filteredCount: 25,
        totalCount: 25,
        page: 1,
        pageCount: 2,
      ),
    );
    await tester.pumpAndSettle();

    final list = find.byKey(const ValueKey('air-directory-task-scroll'));
    expect(list, findsOneWidget);
    expect(
      find.descendant(of: list, matching: find.byType(Scrollable)),
      findsNothing,
    );
    final verticalScroll = find.byWidgetPredicate(
      (widget) =>
          widget is Scrollable && widget.axisDirection == AxisDirection.down,
    );
    expect(verticalScroll, findsOneWidget);
    // 真实抬头、筛选、当前页与分页按顺序排列。
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-tasks-heading'))).dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('air-directory-task-search')))
            .dy,
      ),
    );
    expect(
      tester
          .getTopLeft(find.byKey(const ValueKey('air-directory-task-search')))
          .dy,
      lessThan(tester.getTopLeft(list).dy),
    );
    expect(
      tester.getTopLeft(list).dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('air-tasks-page-label')))
            .dy,
      ),
    );
    final scroll = tester.state<ScrollableState>(verticalScroll);
    scroll.position.jumpTo(scroll.position.maxScrollExtent);
    await tester.pump();
    expect(scroll.position.pixels, greaterThan(0));
    scroll.position.jumpTo(0);
    await tester.pump();
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-tasks-heading'))).dy,
      lessThan(tester.getTopLeft(list).dy),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('筛完一条都没有时说清楚是筛选的事，不是这一页坏了', (tester) async {
    await tester.pumpWidget(
      _host(
        rows: const [],
        filteredCount: 0,
        totalCount: 8,
        page: 1,
        pageCount: 1,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('0 / 8 个任务'), findsOneWidget);
    expect(find.textContaining('没有匹配的任务'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
