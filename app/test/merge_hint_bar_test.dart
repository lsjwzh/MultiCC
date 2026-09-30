import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/merge_hint_dock.dart';

/// 「有可合并内容」提示的两半：琥珀色横幅（查看 Diff / 合并 / 收起）与收起后的
/// 悬浮球。对齐 web 的 `#merge-hint` + `#merge-hint-fab`（chat-merge-hint.js）。
///
/// 收起态以前是输入区上方一颗贴边药丸，位置由布局定死；现在与派发 / 后台任务 /
/// 定时发送三个球同一套 primitive（拖动 / 吸附 / 持久化），所以这里锁的是那颗球的
/// 行为：拖走不展开、松手吸到最近的边、位置写自己的 key、点开才是横幅。
Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: 360, child: Column(children: [child])),
  ),
);

/// 悬浮球要一个有限的 Stack（它按约束算吸附点），所以单独一个宿主。
Widget _dockHost(Widget child) =>
    MaterialApp(home: Scaffold(body: Stack(children: [child])));

final Finder _ball = find.byKey(const Key('merge-hint-fab'));

void main() {
  // Default test surface: 800×600 logical px.
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  setUp(() => SharedPreferences.setMockInitialValues(const {}));

  testWidgets('展开态给查看 Diff / 合并 / 收起三个动作', (tester) async {
    var merges = 0;
    var diffs = 0;
    var collapses = 0;
    await tester.pumpWidget(
      _host(
        MergeHintBar(
          text: '有未提交改动，可合并回 main',
          onMerge: () => merges++,
          onDiff: () => diffs++,
          onCollapse: () => collapses++,
        ),
      ),
    );

    expect(find.text('有未提交改动，可合并回 main'), findsOneWidget);
    expect(_ball, findsNothing);

    await tester.tap(find.text('查看 Diff'));
    await tester.pump();
    await tester.tap(find.text('合并'));
    await tester.pump();
    expect(diffs, 1);
    expect(merges, 1);

    // 收起是外面的事：横幅自己只回调，不持有收起状态。
    await tester.tap(find.byKey(const Key('merge-hint-collapse')));
    await tester.pump();
    expect(collapses, 1);
    expect(find.text('有未提交改动，可合并回 main'), findsOneWidget);
  });

  testWidgets('收起后是颗能拖的悬浮球：拖动不展开，点开才是横幅', (tester) async {
    var diffs = 0;
    await tester.pumpWidget(
      _dockHost(
        MergeHintDock(
          text: '有未提交改动，可合并回 main',
          onMerge: () {},
          onDiff: () => diffs++,
        ),
      ),
    );
    await tester.pump(); // prefs resolve

    // 默认落在左边缘、可用带的下沿（与其它三个悬浮球同一条基准线）。
    expect(_ball, findsOneWidget);
    expect(tester.getTopLeft(_ball), const Offset(10, 456));

    // 拖到右半边：吸附右边缘，而且**不展开**（拖动 ≠ 点开）。
    await tester.drag(_ball, const Offset(500, -100));
    await tester.pump();
    expect(tester.getTopLeft(_ball).dx, 742);
    expect(find.text('查看 Diff'), findsNothing);
    expect(find.text('有未提交改动，可合并回 main'), findsNothing);

    // 位置写自己的 key，不碰别的悬浮球。
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('multicc_merge_dock_side'), 'right');
    expect(prefs.getDouble('multicc_merge_dock_dy'), isNotNull);
    expect(prefs.getString('multicc_dispatch_dock_side'), isNull);
    expect(prefs.getString('multicc_bg_dock_side'), isNull);

    // 点一下：横幅展开在球旁边。
    await tester.tap(_ball);
    await tester.pump();
    expect(find.text('有未提交改动，可合并回 main'), findsOneWidget);
    await tester.tap(find.text('查看 Diff'));
    await tester.pump();
    expect(diffs, 1);

    // 横幅上的收起把它折回球，球还在原处。
    await tester.tap(find.byKey(const Key('merge-hint-collapse')));
    await tester.pump();
    expect(find.text('查看 Diff'), findsNothing);
    expect(_ball, findsOneWidget);
    expect(tester.getTopLeft(_ball).dx, 742);
  });
}
