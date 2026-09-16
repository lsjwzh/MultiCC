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

/// 只记改名调用，不发请求：真 SessionManager 的 renameSession 会 PATCH 到
/// 上面那个不可达端口，测试关心的是「头部把哪一对 (id, label) 交出去了」。
class _RecordingManager extends SessionManager {
  final List<String> renamedIds = [];
  final List<String?> renamedLabels = [];

  _RecordingManager({required super.settings});

  @override
  Future<void> renameSession(String id, String? label) async {
    renamedIds.add(id);
    renamedLabels.add(label);
  }
}

Widget _host(
  SessionManager mgr,
  SettingsService settings,
  ChatProvider provider, {
  String cwd = '',
  String? branch,
  int behind = 0,
  VoidCallback? onForceSync,
  VoidCallback? onChatWidth,
  VoidCallback? onAutoCommit,
  VoidCallback? onDebug,
  String? artifactsLabel,
  VoidCallback? onArtifacts,
  bool forceSyncing = false,
  bool autoCommit = true,
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
                onForceSync: onForceSync ?? () {},
                forceSyncing: forceSyncing,
                onChatWidth: onChatWidth ?? () {},
                autoCommit: autoCommit,
                onAutoCommit: onAutoCommit ?? () {},
                onDebug: onDebug ?? () {},
                artifactsLabel: artifactsLabel,
                onArtifacts: onArtifacts ?? () {},
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

  // 双击标题改名（对齐 web 双击 #session-title → renameSessionFromChat）。
  // renameSession 走真实 HTTP 会打不通本机不可达端口，所以只记调用。
  group('双击标题改名', () {
    testWidgets('双击标题弹出改名框，预填当前别名并提交给 SessionManager', (
      tester,
    ) async {
      final settings = await _settings();
      final mgr = _RecordingManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-dblclick',
        displayName: '全栈工程师3',
        dirName: 'multicc',
        sessionCwd: '/tmp',
      );

      await tester.pumpWidget(_host(mgr, settings, provider));

      final title = find.text('multicc / 全栈工程师3');
      await tester.tap(title);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(title);
      await tester.pump();

      expect(find.text(t('renameSessionTitle')), findsOneWidget);
      // 预填的是别名本身，不是「目录 / 别名」那串 —— 改名改的就是别名。
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, '全栈工程师3');

      await tester.enterText(find.byType(TextField), '后端工程师');
      await tester.pump();
      await tester.tap(find.text(t('save')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(mgr.renamedIds, ['s-dblclick']);
      expect(mgr.renamedLabels, ['后端工程师']);
      expect(find.text(t('renameSessionSaved')), findsOneWidget);

      provider.dispose();
      mgr.dispose();
    });

    testWidgets('取消不改名', (tester) async {
      final settings = await _settings();
      final mgr = _RecordingManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-cancel',
        displayName: '原名',
        sessionCwd: '/tmp',
      );

      await tester.pumpWidget(_host(mgr, settings, provider));

      final title = find.text('原名');
      await tester.tap(title);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(title);
      await tester.pump();

      await tester.tap(find.text(t('cancel')));
      // 关闭动画要走完再收场，否则 route 的动画 timer 会活过 widget tree。
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(mgr.renamedIds, isEmpty);
      expect(find.text(t('renameSessionSaved')), findsNothing);

      provider.dispose();
      mgr.dispose();
    });
  });

  // ⋯ 菜单里的工作树/布局入口（对齐 web 的 #force-sync-btn 与聊天宽度设置）。
  // 这两项在窄屏菜单里是唯一入口，所以菜单项必须在。
  group('ChatHeader worktree + width entries', () {
    testWidgets('⋯ 菜单里有「强制同步」和「聊天宽度」，点了各自回调', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-menu',
        sessionCwd: '/tmp',
      );
      var forced = 0;
      var width = 0;

      await tester.pumpWidget(_host(
        mgr,
        settings,
        provider,
        onForceSync: () => forced++,
        onChatWidth: () => width++,
      ));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      expect(find.text(t('worktreeForceSync')), findsOneWidget);
      expect(find.text(t('chatWidthTitle')), findsOneWidget);

      // 菜单比屏幕高（web 那套顺序里这两项排在语言/提醒/角色/… 之后），
      // 先滚到可见处再点 —— 否则点击落在可视区外，菜单只是被关掉。
      await tester.ensureVisible(find.text(t('worktreeForceSync')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(t('worktreeForceSync')));
      await tester.pumpAndSettle();
      expect(forced, 1);

      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(t('chatWidthTitle')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(t('chatWidthTitle')));
      await tester.pumpAndSettle();
      expect(width, 1);

      provider.dispose();
      mgr.dispose();
    });

    testWidgets('同步中菜单项改成「正在发送…」', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-menu-busy',
        sessionCwd: '/tmp',
      );

      await tester.pumpWidget(_host(mgr, settings, provider, forceSyncing: true));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      expect(find.text(t('worktreeForceSyncSending')), findsOneWidget);
      expect(find.text(t('worktreeForceSync')), findsNothing);

      provider.dispose();
      mgr.dispose();
    });
  });

  // 「自动提交」入口：web 是页头常驻的 `#auto-commit-btn`，移动端那排图标已经
  // 排满，所以收进 ⋯ 菜单；开关状态直接写在文案里（✓/✕），没有别的地方能表达。
  group('ChatHeader auto-commit entry', () {
    testWidgets('开/关两态文案不同，点了走回调', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-autocommit',
        sessionCwd: '/tmp',
      );
      var toggled = 0;

      await tester.pumpWidget(_host(
        mgr,
        settings,
        provider,
        autoCommit: true,
        onAutoCommit: () => toggled++,
      ));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();
      expect(find.text(t('autoCommitOn')), findsOneWidget);
      expect(find.text(t('autoCommitOff')), findsNothing);

      await tester.tap(find.text(t('autoCommitOn')));
      await tester.pumpAndSettle();
      expect(toggled, 1);

      // 关掉之后同一位置应该显示「自动提交✕」。
      await tester.pumpWidget(_host(
        mgr,
        settings,
        provider,
        autoCommit: false,
        onAutoCommit: () => toggled++,
      ));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();
      expect(find.text(t('autoCommitOff')), findsOneWidget);
      expect(find.text(t('autoCommitOn')), findsNothing);

      provider.dispose();
      mgr.dispose();
    });
  });

  // Web 聊天页（Air 模式）的 ⋯ 菜单头两项是 lang-btn / notify-btn
  // （public/chat.js:257），App 此前两项都缺 —— 这一组钉住「入口在、点了按
  // Web 的语义变状态」。
  group('ChatHeader language + task-notify entries', () {
    testWidgets('语言入口用 Web 的 t(language) 文案，点了翻转持久化语言', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-lang',
        sessionCwd: '/tmp',
      );
      expect(settings.lang, 'zh');

      await tester.pumpWidget(_host(mgr, settings, provider));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();

      // Web 的按钮文字就是 t('language')（zh '中/EN' / en 'EN/中'）。
      expect(find.byKey(const Key('chat-header-language')), findsOneWidget);
      expect(find.text('中/EN'), findsOneWidget);

      await tester.tap(find.byKey(const Key('chat-header-language')));
      await tester.pumpAndSettle();

      // Web 的 toggleLang() 把新语言写进 `multicc_lang` 再重载页面；
      // App 写的是同一个键（SettingsService.setLanguage → prefs）。
      expect(settings.lang, 'en');
      expect(settings.language.value, 'en');

      provider.dispose();
      mgr.dispose();
    });

    testWidgets('任务提醒入口按开/关显示 ✓/✕，点了写 Web 那套本地键', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-notify',
        sessionCwd: '/tmp',
      );
      expect(settings.taskNotifyEnabled('s-notify'), isTrue);

      await tester.pumpWidget(_host(mgr, settings, provider));
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-header-task-notify')), findsOneWidget);
      expect(find.text(t('taskNotifyOn')), findsOneWidget);
      expect(find.text(t('taskNotifyOff')), findsNothing);

      await tester.tap(find.byKey(const Key('chat-header-task-notify')));
      await tester.pumpAndSettle();
      // 落的是 Web 同一个键 `multicc_notify:<sessionId>`，值 'off'。
      expect(settings.taskNotifyEnabled('s-notify'), isFalse);

      // 菜单每次展开都重读偏好，所以再开一次就该是 ✕。
      await tester.tap(find.byIcon(Icons.more_vert));
      await tester.pumpAndSettle();
      expect(find.text(t('taskNotifyOff')), findsOneWidget);
      expect(find.text(t('taskNotifyOn')), findsNothing);

      provider.dispose();
      mgr.dispose();
    });
  });

  // 「只读历史」标识：对齐 web 归档模式的 #status 文案。只在归档态出现 ——
  // 平时挂个锁图标会让「能改历史」的普通会话看着像被限制。
  group('ChatHeader read-only history badge', () {
    testWidgets('归档模式显示只读历史标识，普通会话不显示', (tester) async {
      final settings = await _settings();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-archive',
        displayName: '归档会话',
        sessionCwd: '/tmp',
      );

      await tester.pumpWidget(_host(mgr, settings, provider));
      expect(find.byKey(const Key('chat-read-only-badge')), findsNothing);

      // 走真实入口（裸赋字段不会通知监听者，头部也就不会重建）。
      provider.setHistoryArchive(true);
      await tester.pump();
      expect(find.byKey(const Key('chat-read-only-badge')), findsOneWidget);
      expect(find.text(t('readOnlyHistory')), findsOneWidget);
      // 提示语要讲清「还能聊，只是历史改不动」这层差别。
      expect(find.byTooltip(t('readOnlyHistoryHint')), findsOneWidget);
      // 标识不该把标题挤没：标题仍在（不钉具体文案 —— setHistoryArchive 会重建
      // service，displayName 可能在这条路径上回退成会话 id）。
      expect(find.text(provider.titleLabel), findsOneWidget);

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
