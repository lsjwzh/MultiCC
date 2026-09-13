import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/widgets/chat_composer_fold.dart';

/// 聊天页那一柱：上面是随手指滚动的记录，下面是输入区。折叠要按「离底边还有
/// 多远」来算，所以测试里必须有一个真能滚的列表，不能拿假高度糊过去。
class _Harness {
  _Harness(this.tester);

  final WidgetTester tester;
  final scrollCtrl = ScrollController();
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
                  itemCount: 120,
                  itemBuilder: (_, i) => SizedBox(
                    height: 60,
                    child: Text('历史消息 $i'),
                  ),
                ),
              ),
              ChatComposerFold(
                scrollController: scrollCtrl,
                inputController: inputCtrl,
                inputFocusNode: inputFocus,
                child: SizedBox(
                  height: childHeight,
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
}
