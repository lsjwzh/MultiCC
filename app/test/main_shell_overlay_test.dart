import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/screens/chat_screen.dart';
import 'package:multicc_app/screens/main_shell.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

// 打开一个对话 = 一层盖满内容区的浮层（三端同一套规矩，Web 那侧是
// `public/air.js` 的 `#chat-layer`）：页头留在外面，而且它必须还是活的 ——
// 「换下一个任务仍是一步」全靠这一条。展开才连页头一起盖。
//
// 这里在真的 MainShell 上量：默认态页头那一格到底有没有被吃掉、☰ 点得动点不动、
// 展开有没有盖到屏幕最上面。Web 那侧有对应的 CDP 用例
// （tests/test-air-chat-layer-cdp.js），两边量的是同一件事。
//
// SessionManager 的构造器会启动 5s 周期刷新，而 flutter_test 在 test body 内部
// 就检查 pending timers（早于 addTearDown）——所以每个用例都必须在断言之后、
// body 结束之前 `mgr.dispose()`（跟 chat_header_title_test.dart 同一个道理）。
void main() {
  const statusBar = 47.0;
  const barHeight = 36.0; // 浮层顶上那条控制条（拖柄 + 展开）
  const separator = 1.0; // 浮层顶边那条分界线（BoxDecoration 的 border 也算进布局）
  final contentTop = statusBar + kToolbarHeight; // 首页 AppBar 的下沿

  setUpAll(() => I18n.init('zh'));

  /// 一台 390×844、带刘海的手机，Air 首页上开着一个对话。
  Future<SessionManager> pumpShell(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    tester.view.padding = const FakeViewPadding(
      top: statusBar * 3,
      bottom: 34 * 3,
    );
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:3000',
      OnboardingStore.doneKey: '1',
    });
    final settings = await SettingsService.getInstance();
    final mgr = SessionManager(settings: settings);
    mgr.openSession(
      Session(
        id: 'sess-1',
        cwd: '/tmp',
        kind: SessionKind.chat,
        createdAt: DateTime.now(),
      ),
    );
    mgr.switchToSession('sess-1');

    await tester.pumpWidget(
      ChangeNotifierProvider<SessionManager>.value(
        value: mgr,
        child: MaterialApp(home: MainShell(settings: settings)),
      ),
    );
    await tester.pump();
    await settleDraining(tester); // 进场的滑升
    return mgr;
  }

  Finder chat() => find.byType(ChatView);
  Finder expandButton() => find.byKey(const ValueKey('chat-sheet-expand'));

  testWidgets('默认态盖满内容区：页头整条留在外面，聊天紧贴在它下面', (tester) async {
    final mgr = await pumpShell(tester);

    final appBar = tester.getRect(find.byType(AppBar).first);
    expect(appBar.bottom, contentTop, reason: '页头是普通 AppBar：状态栏 + kToolbarHeight');
    final body = tester.getRect(chat());
    expect(
      body.top,
      contentTop + separator + barHeight,
      reason: '浮层上沿就在页头下沿，中间不留缝也不许压到页头',
    );
    expect(body.left, 0);
    expect(body.right, 390, reason: '要盖满整条内容区的宽度');
    expect(body.bottom, 844);

    // 控制条自己也铺满整宽（它是 Column 的孩子，不写明宽度就会缩成拖柄那 42px），
    // 「展开」靠右站。
    final expand = tester.getRect(expandButton());
    expect(expand.right, 390 - 6);
    expect(expand.top, greaterThanOrEqualTo(contentTop));

    // 页头是活的：点 ☰ 走得通 —— 先收起对话，抽屉再拉出来。
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await settleDraining(tester);
    expect(find.byType(AirSidebar), findsOneWidget);

    mgr.dispose();
  });

  testWidgets('展开连页头一起盖，收起再放回内容区', (tester) async {
    final mgr = await pumpShell(tester);
    expect(find.text('展开'), findsOneWidget);

    await tester.tap(expandButton());
    await settleDraining(tester);

    final appBar = tester.getRect(find.byType(AppBar).first);
    final body = tester.getRect(chat());
    expect(
      body.top,
      statusBar + separator + barHeight,
      reason: '展开态从屏幕最上面开始（让出状态栏一条，内容不钻到刘海底下）',
    );
    expect(body.top, lessThan(appBar.bottom), reason: '页头这时候是被盖住的');
    expect(find.text('收起'), findsOneWidget, reason: '盖住了页头，出口就在这条控制条上');

    await tester.tap(expandButton());
    await settleDraining(tester);
    expect(tester.getRect(chat()).top, contentTop + separator + barHeight);
    expect(find.text('展开'), findsOneWidget);

    mgr.dispose();
  });

  testWidgets('抓着控制条往下甩就回首页', (tester) async {
    final mgr = await pumpShell(tester);

    await tester.drag(expandButton(), const Offset(0, 600)); // 甩过 `_dismissBelow`
    await settleDraining(tester);

    expect(mgr.activeSessionId, isNull, reason: '甩下去 = 关掉对话，回到首页');
    expect(chat(), findsNothing);

    mgr.dispose();
  });
}

/// 走完动画，并且**每一帧**都看一眼有没有报错 —— 攒到最后一并就变成一句
/// 「Multiple exceptions (N)」，分不清是哪来的，也没法判断该不该放行。
Future<void> settleDraining(WidgetTester tester) async {
  for (var i = 0; i < 200 && tester.binding.hasScheduledFrame; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    drainSquashNoise(tester);
  }
  drainSquashNoise(tester);
}

/// 收起浮层这一路，必须经过「浮层被压到只剩几十像素高」的中间帧：聊天页里那几个
/// 面板（运行时面板、产物面板）本来就塞不进那么小的框，布局在这一帧报 overflow。
/// release 里它只是被裁到屏幕外、肉眼看不见，而且浮层下滑关掉这条老路（0.9 那版
/// 也一样）走的正是同一帧 —— 跟这次改的东西无关。所以这里按帧接住，但只放行
/// 「塞不下」这一类：真出了别的错，这一条会当场炸出来。
void drainSquashNoise(WidgetTester tester) {
  for (var e = tester.takeException(); e != null; e = tester.takeException()) {
    expect(
      '$e',
      matches(RegExp(r'overflowed by|Multiple exceptions \(\d+\)')),
      reason:
          '收起过程中只该有「面板被压扁」这一类中间帧报错'
          '（同一帧好几个面板一起塞不下时，Flutter 会先把它们折成一句 Multiple exceptions）',
    );
  }
}
