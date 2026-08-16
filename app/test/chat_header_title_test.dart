import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';
import 'package:multicc_app/widgets/chat_header.dart';

/// ChatHeader 在真实 ChatProvider 上渲染。设置指向本机不可达端口：
/// WS/HTTP 全部快速失败并被 service 吞掉，标题渲染是纯同步路径。
///
/// SessionManager 也必须是真的：ModelChip 在 build 里 watch 它（切 AI 配置
/// 的入口）。注意它的构造器会启动 5s 周期刷新并调 loadDashboard()——
/// flutter_test 在 test body 内部就检查 pending timers（早于 addTearDown），
/// 所以两个对象都必须在断言之后、body 结束之前显式 dispose。
Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host(
  SessionManager mgr,
  SettingsService settings,
  ChatProvider provider, {
  String cwd = '',
  String? branch,
  int behind = 0,
}) => MultiProvider(
      providers: [
        ChangeNotifierProvider<SessionManager>.value(value: mgr),
        ChangeNotifierProvider<ChatProvider>.value(value: provider),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topCenter,
            child: SizedBox(
              width: 360,
              child: ChatHeader(
                settings: settings,
                mergeReady: false,
                cwd: cwd,
                branch: branch,
                behind: behind,
                onCwd: () {},
                onMerge: () {},
                onRole: () {},
                onMemory: () {},
                onMemo: () {},
                onShare: () {},
              ),
            ),
          ),
        ),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ⋯ 菜单断言用 zh 文案（「切换」「角色提示词」…），必须先装载词条。
  setUpAll(() => I18n.init('zh'));

  testWidgets('narrow header keeps the title visible on its own full-width line', (
    tester,
  ) async {
    final settings = await _settings();
    final mgr = SessionManager(settings: settings);
    final provider = ChatProvider(
      settings: settings,
      sessionName: 'multicc-claude-chat-06',
      displayName: '全栈工程师3',
      dirName: 'multicc',
      sessionCwd: '/tmp',
    );

    await tester.pumpWidget(_host(mgr, settings, provider));

    // 回归点：旧布局里标题被固定宽度的 chrome 挤到 0 宽（手机上完全看不到）。
    // 现在窄屏标题独占第二行，必须拿到真实宽度。
    final title = find.text('multicc / 全栈工程师3');
    expect(title, findsOneWidget);
    final box = tester.renderObject<RenderBox>(title);
    expect(box.size.width, greaterThan(100));

    provider.dispose();
    mgr.dispose();
  });

  testWidgets('long title ellipsizes to one line but stays fully readable to semantics', (
    tester,
  ) async {
    final settings = await _settings();
    final mgr = SessionManager(settings: settings);
    final longLabel = 'multicc / 这是一个非常长的会话标题用来验证窄屏省略号行为的测试样例数据';
    final provider = ChatProvider(
      settings: settings,
      sessionName: 's-long',
      displayName: longLabel.substring('multicc / '.length),
      dirName: 'multicc',
      sessionCwd: '/tmp',
    );

    await tester.pumpWidget(_host(mgr, settings, provider));

    final text = tester.widget<Text>(find.text(longLabel));
    expect(text.maxLines, 1);
    expect(text.overflow, TextOverflow.ellipsis);
    // 无障碍：视觉省略了，语义标签仍朗读完整标题。
    final handle = tester.ensureSemantics();
    expect(find.bySemanticsLabel(longLabel), findsWidgets);
    handle.dispose();

    provider.dispose();
    mgr.dispose();
  });

  testWidgets('session_updated-style rename reflects immediately via setDisplayName', (
    tester,
  ) async {
    final settings = await _settings();
    final mgr = SessionManager(settings: settings);
    final provider = ChatProvider(
      settings: settings,
      sessionName: 's-rename',
      displayName: 's-rename', // label 为空 → 回退 id
      dirName: '',
      sessionCwd: '/tmp',
    );
    expect(provider.titleLabel, 's-rename');

    // 服务端 session_updated 分支最终调用的就是 setDisplayName：
    // 新 label 生效；label 清空时回退 id，绝不残留旧标题。
    provider.setDisplayName('新标题');
    expect(provider.titleLabel, '新标题');
    provider.setDisplayName('s-rename');
    expect(provider.titleLabel, 's-rename');

    // dirName 后到（先开会话、后加载目录）：titleLabel 立即带上目录前缀。
    provider.setDisplayName('新标题', dirName: 'gapasea');
    expect(provider.titleLabel, 'gapasea / 新标题');

    await tester.pumpWidget(_host(mgr, settings, provider));
    expect(find.text('gapasea / 新标题'), findsOneWidget);

    provider.dispose();
    mgr.dispose();
  });

  // 聊天页原来的 working 目录条（_CwdBar）整行删掉，目录/分支收进 ⋯ 菜单：
  // 信息行只读、短目录名 inline + 全路径在 Tooltip，「切换」仍是动作项。
  group('ChatHeader cwd in ⋯ menu', () {
    testWidgets('menu leads with cwd + branch info rows and a change-dir action', (
      tester,
    ) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 'multicc-claude-chat-06',
        sessionCwd: '/repo/.multicc-worktrees/wt-alpha',
      );

      await tester.pumpWidget(_host(
        mgr,
        settings,
        provider,
        cwd: '/repo/.multicc-worktrees/wt-alpha',
        branch: 'multicc/multicc-claude-chat-06',
        behind: 2,
      ));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      // 短目录名 inline（全路径在 Tooltip），分支行带落后警示 ↓2。
      final cwdRow = find.byKey(const Key('chat-header-cwd'));
      expect(cwdRow, findsOneWidget);
      expect(tester.widget<Text>(cwdRow).data, 'wt-alpha');
      final branchRow = find.byKey(const Key('chat-header-branch'));
      expect(tester.widget<Text>(branchRow).data, 'multicc/multicc-claude-chat-06');
      expect(find.text('↓2'), findsOneWidget);
      // 「切换」动作项排在信息行后面，原有动作项不丢。
      expect(find.text('切换'), findsOneWidget);
      expect(find.text('角色提示词'), findsOneWidget);

      provider.dispose();
      mgr.dispose();
    });

    testWidgets('omits the info rows when cwd/branch are unknown', (
      tester,
    ) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-fresh',
        sessionCwd: '',
      );

      await tester.pumpWidget(_host(mgr, settings, provider));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      // 连接早期 cwd/branch 未知：两条信息行都不渲染，
      // 但「切换」动作仍在（旧目录条 '(unknown)' 时代的等价能力）。
      expect(find.byKey(const Key('chat-header-cwd')), findsNothing);
      expect(find.byKey(const Key('chat-header-branch')), findsNothing);
      expect(find.text('切换'), findsOneWidget);

      provider.dispose();
      mgr.dispose();
    });
  });

  // 聊天页 liveness 徽章的成行策略：working/stalled 有信息量（在跑/卡住）；
  // idle 🟡 曾常年独占一行「空闲」，属于默认态噪音，回归点锁死不再渲染。
  test('chatLivenessDeservesLine: only working/stalled earn a line', () {
    expect(chatLivenessDeservesLine('working'), isTrue);
    expect(chatLivenessDeservesLine('stalled'), isTrue);
    expect(chatLivenessDeservesLine('idle'), isFalse);
    expect(chatLivenessDeservesLine('unknown'), isFalse);
    expect(chatLivenessDeservesLine(null), isFalse);
    expect(chatLivenessDeservesLine(''), isFalse);
  });
}
