import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/widgets/chat_composer_fold.dart';

/// 聊天页那一柱：上面是随手指滚动的记录，下面是输入区。折叠要按「离底边还有
/// 多远」来算，所以测试里必须有一个真能滚的列表，不能拿假高度糊过去。
class _Harness {
  _Harness(this.tester, {this.composerHeight = childHeight, this.physics});

  final WidgetTester tester;
  final double composerHeight;
  final ScrollPhysics? physics;
  final scrollCtrl = ChatComposerScrollController();
  final inputCtrl = TextEditingController();
  final inputFocus = FocusNode();

  static const childHeight = 120.0;

  Future<void> pump({required double width}) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = Size(width, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(scrollCtrl.dispose);
    addTearDown(inputCtrl.dispose);
    addTearDown(inputFocus.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Expanded(
                child: ListView.builder(
                  controller: scrollCtrl,
                  physics: physics,
                  itemCount: 120,
                  itemBuilder: (_, i) =>
                      SizedBox(height: 60, child: Text('历史消息 $i')),
                ),
              ),
              ChatComposerFold(
                scrollController: scrollCtrl,
                inputController: inputCtrl,
                inputFocusNode: inputFocus,
                child: SizedBox(
                  height: composerHeight,
                  child: TextField(
                    controller: inputCtrl,
                    focusNode: inputFocus,
                    decoration: const InputDecoration(labelText: '输入消息'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder get pill => find.byKey(const ValueKey('chat-composer-pill'));
  Finder get fold => find.byType(ChatComposerFold);
  double get height => tester.getSize(fold).height;

  /// 把记录拉到底：贴底时任何折叠看起来都像是自己动了一下。
  Future<void> scrollToBottom() async {
    scrollCtrl.jumpTo(scrollCtrl.position.maxScrollExtent);
    await tester.pumpAndSettle();
  }
}

void main() {
  testWidgets('桌面宽度下输入区不折 —— 放得下就没有理由折', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 1000);

    expect(h.height, _Harness.childHeight);
    expect(h.pill, findsNothing);

    // 就算翻到最上面也一样：宽屏不走这条路。
    h.scrollCtrl.jumpTo(0);
    await tester.pumpAndSettle();
    expect(h.height, _Harness.childHeight);
    expect(h.pill, findsNothing);
  });

  testWidgets('手机上贴着底边时输入区是完整的', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 390);
    await h.scrollToBottom();

    expect(h.pill, findsNothing);
    expect(h.height, _Harness.childHeight);
    expect(tester.takeException(), isNull);
  });

  for (final physics in const [
    ClampingScrollPhysics(),
    BouncingScrollPhysics(),
  ]) {
    testWidgets('接近底部时输入区不反复跳动：${physics.runtimeType}', (tester) async {
      // 无人值守横幅、暂存消息和配置行会让真实输入区远高于普通文本框。
      final h = _Harness(tester, composerHeight: 300, physics: physics);
      await h.pump(width: 390);

      for (final distance in [0.0, 40.0, 80.0, 120.0, 160.0]) {
        h.scrollCtrl.jumpTo(h.scrollCtrl.position.maxScrollExtent - distance);
        // 按帧采样，不能靠 pumpAndSettle 掩盖持续反转或等它超时。
        final samples = <double>[];
        for (var frame = 0; frame < 150; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          if (frame >= 120) samples.add(h.height);
        }
        final spread =
            samples.reduce((a, b) => a > b ? a : b) -
            samples.reduce((a, b) => a < b ? a : b);
        expect(spread, lessThan(1), reason: '$distance px 离底时高度仍在变化：$samples');
        expect(h.height, 300, reason: '折叠使列表贴底后应保持完整输入区');
        expect(
          h.scrollCtrl.position.extentAfter,
          lessThanOrEqualTo(2),
          reason: '展开输入区时应继续保持最新消息可见',
        );
      }

      // 底部锁定必须让位给下一次真实上翻，不能把自动折叠整个禁掉。
      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();
      expect(h.pill, findsOneWidget);
      expect(h.height, closeTo(42, 1e-9));
      expect(tester.takeException(), isNull);
    });

    testWidgets('输入区展开时开始慢拖仍能翻阅历史：${physics.runtimeType}', (tester) async {
      final h = _Harness(tester, composerHeight: 300, physics: physics);
      await h.pump(width: 390);
      h.scrollCtrl.jumpTo(h.scrollCtrl.position.maxScrollExtent);
      await tester.pump(const Duration(milliseconds: 16));

      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(ListView)),
      );
      await gesture.moveBy(const Offset(0, 25));
      await tester.pump(const Duration(milliseconds: 16));
      // 高刷新率屏幕上的慢拖会产生不足一个逻辑像素的逐帧位移。
      for (var frame = 0; frame < 100; frame++) {
        await gesture.moveBy(const Offset(0, 0.5));
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(
        h.scrollCtrl.position.extentAfter,
        greaterThan(20),
        reason: '展开动画不得把手指拉回底部或取消拖动',
      );
      final releasedAt = h.scrollCtrl.position.pixels;
      await gesture.up();
      await tester.pumpAndSettle();
      expect(
        h.scrollCtrl.position.extentAfter,
        greaterThan(20),
        reason: '松手后也不能重新吸回底部',
      );
      expect(
        h.scrollCtrl.position.pixels,
        lessThanOrEqualTo(releasedAt + 1),
        reason: '保留用户正在阅读的历史位置',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('展开时按住再快速滑动不会被校准取消：${physics.runtimeType}', (tester) async {
      final h = _Harness(tester, composerHeight: 300, physics: physics);
      await h.pump(width: 390);
      h.scrollCtrl.jumpTo(h.scrollCtrl.position.maxScrollExtent);
      await tester.pump(const Duration(milliseconds: 16));
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(ListView)),
      );
      // 按住时尚未产生滚动位移，同样必须让位给手势。
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        h.scrollCtrl.position.activity,
        anyOf(isA<HoldScrollActivity>(), isA<DragScrollActivity>()),
        reason: '按住时不得被 jumpTo 取消为 IdleScrollActivity',
      );
      await gesture.moveBy(const Offset(0, 25));
      await gesture.moveBy(const Offset(0, 300));
      await tester.pump(const Duration(milliseconds: 16));
      expect(h.scrollCtrl.position.activity, isA<DragScrollActivity>());
      final releasedAt = h.scrollCtrl.position.pixels;
      await gesture.up();
      await tester.pumpAndSettle();
      expect(h.scrollCtrl.position.pixels, lessThanOrEqualTo(releasedAt + 1));
      expect(h.scrollCtrl.position.extentAfter, greaterThan(20));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('手机上往回翻就折起来，折到底只剩一条胶囊', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 390);
    await h.scrollToBottom();
    expect(h.height, _Harness.childHeight);

    // 翻回最上面，离底边远过 FOLD_AT（220px），折到底。
    h.scrollCtrl.jumpTo(0);
    await tester.pumpAndSettle();

    expect(h.pill, findsOneWidget);
    expect(h.height, lessThan(60));
    expect(tester.takeException(), isNull);
  });

  testWidgets('折起来时没发出去的草稿显示在胶囊上，不被藏起来', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 390);
    h.inputCtrl.text = '这段是我打了一半的';
    await h.scrollToBottom();
    h.scrollCtrl.jumpTo(0);
    await tester.pumpAndSettle();

    expect(h.pill, findsOneWidget);
    // 输入框本身还在树里（只是被裁掉了），所以要看胶囊里那一个。
    expect(
      find.descendant(of: h.pill, matching: find.text('这段是我打了一半的')),
      findsOneWidget,
    );
  });

  testWidgets('输入区里一有焦点就钉住不折 —— 不然会从手指底下抽走', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 390);
    await h.scrollToBottom();
    h.scrollCtrl.jumpTo(0);
    await tester.pumpAndSettle();
    expect(h.pill, findsOneWidget);

    h.inputFocus.requestFocus();
    await tester.pumpAndSettle();

    expect(h.inputFocus.hasFocus, isTrue);
    expect(h.pill, findsNothing);
    expect(h.height, _Harness.childHeight);
  });

  testWidgets('点胶囊把输入区还回来，光标已经在里面', (tester) async {
    final h = _Harness(tester);
    await h.pump(width: 390);
    await h.scrollToBottom();
    h.scrollCtrl.jumpTo(0);
    await tester.pumpAndSettle();
    expect(h.pill, findsOneWidget);

    await tester.tap(h.pill);
    await tester.pumpAndSettle();

    expect(h.pill, findsNothing);
    expect(h.height, _Harness.childHeight);
    // 展开之后光标就在输入框里，不用再点一次。
    expect(h.inputFocus.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ChatComposerScrollController.isUserActive 区分用户手势与程序滚动', (
    tester,
  ) async {
    final h = _Harness(tester, physics: const BouncingScrollPhysics());
    await h.pump(width: 390);
    await h.scrollToBottom();
    expect(h.scrollCtrl.isUserActive, isFalse);

    // 按住与拖动期间必须标记为 isUserActive，避免自动滚底抢占用户手势。
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(ListView)),
    );
    await tester.pump(const Duration(milliseconds: 16));
    expect(h.scrollCtrl.isUserActive, isTrue);

    await gesture.moveBy(const Offset(0, 60));
    await tester.pump(const Duration(milliseconds: 16));
    expect(h.scrollCtrl.isUserActive, isTrue);

    await gesture.up();
    await tester.pumpAndSettle();
    expect(h.scrollCtrl.isUserActive, isFalse);

    // 程序 animateTo 属于 DrivenScrollActivity，不应被当成用户手势。
    h.scrollCtrl.animateTo(
      h.scrollCtrl.position.maxScrollExtent,
      duration: const Duration(milliseconds: 150),
      curve: Curves.easeOut,
    );
    await tester.pump(const Duration(milliseconds: 16));
    expect(h.scrollCtrl.isUserActive, isFalse);
    await tester.pumpAndSettle();
    expect(h.scrollCtrl.isUserActive, isFalse);
  });
}
