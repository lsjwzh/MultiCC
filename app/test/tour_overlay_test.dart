import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/widgets/tour_overlay.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 四步新手引导（Web `public/tour.js`，562 行）。
///
/// 这一组盯的是「引导自己那套状态机」：什么时候自动开始、哪一步归哪一页、
/// 第 2 步怎样把进度交给聊天页、第 3 步什么时候自动跳到第 4 步、跳过与 × 是不是
/// 都算走完。四步的文案有没有抄对由 i18n 那边保证，这里只挑几条钉一下。

/// 一页的替身：四个带尺寸的锚点 + 一层引导。四个都在，方便同一台机器上把四步
/// 都走一遍（真机上第 1/2 步在首页、第 3/4 步在聊天页）。
class _Host extends StatelessWidget {
  const _Host({
    required this.page,
    required this.tourKey,
    required this.anchors,
    this.probe,
    this.onFill,
    this.onStepShown,
  });

  final TourPage page;
  final GlobalKey<TourOverlayState> tourKey;
  final Map<int, GlobalKey> anchors;
  final TourResultCounts Function()? probe;
  final VoidCallback? onFill;
  final ValueChanged<int>? onStepShown;

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: Stack(
        children: [
          Column(
            children: [
              for (final entry in anchors.entries)
                SizedBox(
                  key: entry.value,
                  width: double.infinity,
                  height: 60,
                  child: Text('锚点 ${entry.key}'),
                ),
            ],
          ),
          TourOverlay(
            key: tourKey,
            page: page,
            anchors: anchors,
            onFillExample: onFill,
            onStepShown: onStepShown,
            resultProbe: probe,
          ),
        ],
      ),
    ),
  );
}

/// 四个锚点各一份，测试之间不共享 GlobalKey。
Map<int, GlobalKey> _anchors() => {
  1: GlobalKey(),
  2: GlobalKey(),
  3: GlobalKey(),
  4: GlobalKey(),
};

Future<OnboardingStore> _store({String? step, bool done = false}) async {
  SharedPreferences.setMockInitialValues({
    if (step != null) OnboardingStore.stepKey: step,
    if (done) OnboardingStore.doneKey: '1',
  });
  return OnboardingStore.load();
}

/// 让宿主重建一帧 —— 第 3 步的观察探针是在重建之后才被问的（真实 App 里那次
/// 重建来自 provider 的通知）。
Future<void> _rebuild(WidgetTester tester, Widget Function() build) async {
  await tester.pumpWidget(build());
  await tester.pump();
}

void main() {
  setUpAll(() => I18n.init('zh'));

  group('进度存储', () {
    test('没存过就是第 1 步、没走完', () async {
      final store = await _store();
      expect(store.step, 1);
      expect(store.done, isFalse);
    });

    test('存坏了、越界了都夹回 1..4', () async {
      expect((await _store(step: 'abc')).step, 1);
      expect((await _store(step: '0')).step, 1);
      expect((await _store(step: '9')).step, 4);
      expect((await _store(step: '3')).step, 3);
    });

    test('markDone / restart 一来一回', () async {
      SharedPreferences.setMockInitialValues({});
      final store = await OnboardingStore.load();
      await store.setStep(4);
      await store.markDone();
      expect(store.done, isTrue);
      expect(store.step, 4, reason: '标完成不该顺手把进度也清了');
      await store.restart();
      expect(store.done, isFalse);
    });
  });

  group('首页的两步', () {
    testWidgets('没走完就从第 1 步开始，卡片落在目标下面', (tester) async {
      await _store(step: '1');
      final tourKey = GlobalKey<TourOverlayState>();
      final anchors = _anchors();

      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: anchors),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);

      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();

      expect(find.text('新手引导 1/4'), findsOneWidget);
      expect(find.text('选择一个工作区'), findsOneWidget);
      expect(find.byKey(const ValueKey('tour-skip')), findsOneWidget);
      expect(find.byKey(const ValueKey('tour-next')), findsOneWidget);
      expect(find.text('下一步'), findsOneWidget);
      // 第 1 步没有「上一步」。
      expect(find.byKey(const ValueKey('tour-prev')), findsNothing);
      // 卡片摆在目标下方（Web 的 `below = rect.bottom + 22`）。
      final anchor = tester.getRect(find.byKey(anchors[1]!));
      final eyebrow = tester.getRect(find.byKey(const ValueKey('tour-eyebrow')));
      expect(eyebrow.top, greaterThan(anchor.bottom));
      // 而且整张卡都在屏幕里。
      expect(
        tester.getRect(find.byKey(const ValueKey('tour-next'))).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(Scaffold)).bottom),
      );
    });

    testWidgets('第 2 步：按钮写「打开对话后继续」，按下去只把进度存成 3', (tester) async {
      final store = await _store(step: '1');
      final tourKey = GlobalKey<TourOverlayState>();
      final anchors = _anchors();
      final steps = <int>[];

      await tester.pumpWidget(
        _Host(
          page: TourPage.home,
          tourKey: tourKey,
          anchors: anchors,
          onStepShown: steps.add,
        ),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('tour-next')));
      await tester.pumpAndSettle();

      expect(steps, [1, 2]);
      expect(find.text('开始一段对话'), findsOneWidget);
      expect(find.text('打开对话后继续'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('tour-next')));
      await tester.pumpAndSettle();

      // 引导退场、进度留在 3，等聊天页自己接上（Web `next()` 里那一段）。
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
      expect(store.step, 3);
      expect(store.done, isFalse, reason: '还没走完，不能标完成');
    });

    testWidgets('进度已经是 3 时首页不再弹引导', (tester) async {
      await _store(step: '3');
      final tourKey = GlobalKey<TourOverlayState>();
      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: _anchors()),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
    });

    testWidgets('跳过与 × 都算走完，走完之后不再打扰', (tester) async {
      final store = await _store(step: '1');
      final tourKey = GlobalKey<TourOverlayState>();

      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: _anchors()),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('tour-skip')));
      await tester.pumpAndSettle();
      expect(store.done, isTrue);
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);

      // 再来一次 autoStart 也不弹 —— Web 的 `isDone()` 就是这个作用。
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
    });

    testWidgets('菜单里的「新手引导」把完成标记摘掉，从头重放', (tester) async {
      final store = await _store(done: true);
      final tourKey = GlobalKey<TourOverlayState>();

      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: _anchors()),
      );
      await tester.pumpAndSettle();
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);

      await tourKey.currentState!.restart();
      await tester.pumpAndSettle();
      expect(find.text('选择一个工作区'), findsOneWidget);
      expect(store.done, isFalse);
    });
  });

  group('聊天页的两步', () {
    testWidgets('进度 3 进聊天页就接着走，第 3 步不给「上一步」', (tester) async {
      await _store(step: '3');
      final tourKey = GlobalKey<TourOverlayState>();
      final anchors = _anchors();

      await tester.pumpWidget(
        _Host(page: TourPage.chat, tourKey: tourKey, anchors: anchors),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();

      expect(find.text('新手引导 3/4'), findsOneWidget);
      expect(find.text('获取第一份安全结果'), findsOneWidget);
      // 上一步在首页上，这里没有可去的地方（Web `showPrev` 那个条件）。
      expect(find.byKey(const ValueKey('tour-prev')), findsNothing);
      expect(find.byKey(const ValueKey('tour-fill')), findsOneWidget);
    });

    testWidgets('「填入只读示例」交给宿主去写输入框', (tester) async {
      await _store(step: '3');
      final tourKey = GlobalKey<TourOverlayState>();
      var filled = 0;

      await tester.pumpWidget(
        _Host(
          page: TourPage.chat,
          tourKey: tourKey,
          anchors: _anchors(),
          onFill: () => filled += 1,
        ),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('tour-fill')));
      await tester.pumpAndSettle();

      expect(filled, 1);
      // 填完还停在第 3 步 —— 得等真的发出消息、真的收到回复才走。
      expect(find.text('获取第一份安全结果'), findsOneWidget);
      expect(find.text('填入只读示例'), findsOneWidget);
    });

    testWidgets('发出消息且收到有正文的回复之后，自动进第 4 步', (tester) async {
      final store = await _store(step: '3');
      final tourKey = GlobalKey<TourOverlayState>();
      var users = 2;
      var assistants = 1;
      var last = '上一轮的回复';
      TourResultCounts probe() =>
          (users: users, assistants: assistants, lastAssistant: last);
      Widget build() => _Host(
        page: TourPage.chat,
        tourKey: tourKey,
        anchors: _anchors(),
        probe: probe,
      );

      await tester.pumpWidget(build());
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.text('获取第一份安全结果'), findsOneWidget);

      // 只有助手那边涨（上一轮的回复还在往外吐字）：不算。
      assistants += 1;
      last = '正在写';
      await _rebuild(tester, build);
      expect(find.text('获取第一份安全结果'), findsOneWidget);

      // 用户发了、助手也回了，但回复还空着：也不算。
      users += 1;
      last = '   ';
      await _rebuild(tester, build);
      expect(find.text('获取第一份安全结果'), findsOneWidget);

      // 真回复到了。
      last = '这个工作区里有三份文档……';
      await _rebuild(tester, build);
      await tester.pumpAndSettle();

      expect(find.text('第一份结果已经完成'), findsOneWidget);
      expect(find.text('完成'), findsOneWidget);
      expect(store.step, 4);

      // 「完成」收场并标完成。
      await tester.tap(find.byKey(const ValueKey('tour-next')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
      expect(store.done, isTrue);
    });
  });

  group('把引导交给聊天页', () {
    testWidgets('停在第 2 步时打开对话：进度存 3、自己退场', (tester) async {
      final store = await _store(step: '2');
      final tourKey = GlobalKey<TourOverlayState>();

      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: _anchors()),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.text('开始一段对话'), findsOneWidget);

      tourKey.currentState!.handOffToChat();
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
      expect(store.step, 3);
      expect(store.done, isFalse);
    });

    testWidgets('还停在第 1 步时打开对话：什么都不动', (tester) async {
      final store = await _store(step: '1');
      final tourKey = GlobalKey<TourOverlayState>();

      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: _anchors()),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();

      tourKey.currentState!.handOffToChat();
      await tester.pumpAndSettle();

      // 引导只是被聊天页盖住了，退出对话还在原地。
      expect(find.text('选择一个工作区'), findsOneWidget);
      expect(store.step, 1);
    });
  });

  group('锚点迟迟不来', () {
    testWidgets('3 秒找不到目标就让位，别把人晾住', (tester) async {
      final store = await _store(step: '1');
      final tourKey = GlobalKey<TourOverlayState>();

      // 只给第 1 步的锚点，第 2 步的目标压根不存在。
      await tester.pumpWidget(
        _Host(page: TourPage.home, tourKey: tourKey, anchors: {1: GlobalKey()}),
      );
      tourKey.currentState!.autoStart();
      await tester.pumpAndSettle();
      expect(find.text('选择一个工作区'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('tour-next')));
      await tester.pump();
      expect(find.text('开始一段对话'), findsOneWidget);

      // 第 2 步是首页最后一步：等满 3 秒就按「打开对话后继续」收场。
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
      expect(store.step, 3);
    });
  });

  group('聊天页那层接线', () {
    testWidgets('TourAnchor 从层里取锚点；没有就把孩子原样放出去', (tester) async {
      final keys = <int, GlobalKey>{3: GlobalKey()};
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TourAnchorScope(
              anchors: keys,
              child: Column(
                children: [
                  TourAnchor(step: 3, child: const Text('输入区')),
                  // 这一步没有锚点（第 4 步那份没给）。
                  TourAnchor(step: 4, child: const Text('消息区')),
                ],
              ),
            ),
          ),
        ),
      );
      expect(find.byKey(keys[3]!), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(keys[3]!),
          matching: find.text('输入区'),
        ),
        findsOneWidget,
      );
      // 没锚点的那一处不该凭空多出 key，孩子还在。
      expect(find.text('消息区'), findsOneWidget);
    });

    testWidgets('套上引导层的聊天页：孩子照常在，进度没到 3 就不弹', (tester) async {
      await _store(step: '2');
      final controller = TextEditingController();
      final focus = FocusNode();
      addTearDown(controller.dispose);
      addTearDown(focus.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatTourLayer(
              composerController: controller,
              composerFocus: focus,
              child: const Text('聊天页正文'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 第 3 步归聊天页，进度还在 2（首页那一步）时聊天页不该抢着弹。
      expect(find.text('聊天页正文'), findsOneWidget);
      expect(find.byKey(const ValueKey('tour-title')), findsNothing);
    });
  });
}
