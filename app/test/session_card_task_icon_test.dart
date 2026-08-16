// 卡片级回归测试：Fleet 面板会话卡片顶部，任务状态 icon 必须只渲染一次。
//
// 历史 bug：SessionCard 顶部同时渲染主状态 icon（statusSpec.icon，来自
// statusPresentation）与 classify 徽章 chip（classifyChip 的 emoji 也取自同一张
// statusPresentation 表）。当 session 状态与 classify 字母映射到同一个 canonical
// 状态时——running🔄+P🔄、succeeded✅+D✅、error❌+E❌、waiting⏸️+W/B⏸️——两个相同
// 图标并排出现在卡片顶部。
//
// 修复：主状态 icon 与 classify 徽章同 glyph 时，classify chip 只保留更细的
// 文字（「等待用户」vs「等待中」），不再重复渲染 emoji；不同状态才两者并排
// （语义不同，天然可区分）。本文件直接断言每张卡的任务状态 icon 只出现一次，
// 并覆盖此前会重复的全部状态，以及「不同语义不误删」的对照用例。
//
// 注意：SessionManager 构造会启一个 5s 周期轮询 timer，flutter_test 会在 body
// 结束时断言无 pending timer，因此 dispose 必须放进 body 末尾（addTearDown /
// tearDownAll 都太晚，会导致 12 个测试全挂）。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/workspace_service.dart';
import 'package:multicc_app/widgets/session_card.dart';

Future<Widget> _wrap(Widget child) async =>
    MaterialApp(home: Scaffold(body: child));

/// pump 一张 SessionCard，返回它的 SessionManager 供 body 末尾 dispose。
Future<SessionManager> _pumpCard(
  WidgetTester tester, {
  String status = 'idle',
  String? classifyState,
  bool active = false,
  double? width,
}) async {
  final settings = await SettingsService.getInstance();
  final mgr = SessionManager(settings: settings);
  final session = Session(
    id: 'sess-$status-$classifyState',
    cli: SessionCli.claude,
    kind: SessionKind.chat,
    dirId: 'dir-1',
    createdAt: DateTime(2026, 1, 1),
    active: active,
  );
  final card = SessionCard(
    session: session,
    mgr: mgr,
    settings: settings,
    liveStatus: SessionStatus(status: status, classifyState: classifyState),
  );
  await tester.pumpWidget(await _wrap(
    width == null ? card : SizedBox(width: width, child: card),
  ));
  await tester.pump();
  return mgr;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('SessionCard single task-status icon', () {
    testWidgets('running + classify P — 🔄 exactly once, 细分文案保留', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'running', classifyState: 'P');
      expect(find.text('🔄'), findsOneWidget);
      // classify 徽章降级为纯文字，细分语义「处理中」仍可见。
      expect(find.text('处理中'), findsOneWidget);
      // 操作按钮（⋯ 菜单）不因去重而丢失。
      expect(find.byType(PopupMenuButton<String>), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('succeeded + classify D — ✅ exactly once', (tester) async {
      final mgr = await _pumpCard(tester, status: 'succeeded', classifyState: 'D');
      expect(find.text('✅'), findsOneWidget);
      // 主 label 与 classify 文案同为「执行成功」，chip 整体隐藏——文案也只一次。
      expect(find.text('执行成功'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('done + classify D — ✅ exactly once', (tester) async {
      final mgr = await _pumpCard(tester, status: 'done', classifyState: 'D');
      expect(find.text('✅'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('error + classify E — ❌ exactly once, 「API 异常」保留', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'error', classifyState: 'E');
      expect(find.text('❌'), findsOneWidget);
      expect(find.text('API 异常'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('waiting + classify W — ⏸️ exactly once, 「等待用户」保留', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'waiting', classifyState: 'W');
      expect(find.text('⏸️'), findsOneWidget);
      expect(find.text('等待用户'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('waiting + classify B — ⏸️ exactly once, 「后台等待」保留', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'waiting', classifyState: 'B');
      expect(find.text('⏸️'), findsOneWidget);
      expect(find.text('后台等待'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('不同语义不误删 — running + classify W 两个 icon 各一次', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'running', classifyState: 'W');
      expect(find.text('🔄'), findsOneWidget);
      expect(find.text('⏸️'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('不同语义不误删 — waiting + classify P 两个 icon 各一次', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'waiting', classifyState: 'P');
      expect(find.text('⏸️'), findsOneWidget);
      expect(find.text('🔄'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('idle + classify W — 主 icon 不渲染，classify ⏸️ 仍显示', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, active: true, classifyState: 'W');
      expect(find.text('⚪'), findsNothing);
      expect(find.text('⏸️'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('idle 无 classify — 无任何状态 icon（回归 dashboard 声明）', (
      tester,
    ) async {
      final mgr = await _pumpCard(tester, status: 'idle', active: true);
      expect(find.text('⚪'), findsNothing);
      expect(find.text('🔄'), findsNothing);
      expect(find.text('⏸️'), findsNothing);
      mgr.dispose();
    });

    testWidgets('无 classify — 主 icon 一次、无 chip', (tester) async {
      final mgr = await _pumpCard(tester, status: 'running');
      expect(find.text('🔄'), findsOneWidget);
      expect(find.text('处理中'), findsNothing); // 无 classify 判定 → 无 chip
      mgr.dispose();
    });
  });

  group('SessionCard narrow-layout regression', () {
    testWidgets('running + classify P 在窄卡上不抛溢出异常', (tester) async {
      // 320dp 是手机纵向最窄的可用卡片宽度档位；去重后 chip 降级为纯文字，
      // 仍不得撑破 Row 的约束。
      final mgr = await _pumpCard(
        tester,
        status: 'running',
        classifyState: 'P',
        width: 320,
      );
      expect(tester.takeException(), isNull);
      expect(find.text('🔄'), findsOneWidget);
      mgr.dispose();
    });
  });
}
