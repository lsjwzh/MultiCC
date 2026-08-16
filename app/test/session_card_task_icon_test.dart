// 卡片级回归测试：Fleet 面板会话卡片顶部，任务状态 icon 只渲染一处、只出现一次。
//
// 历史 bug：SessionCard 顶部同时渲染「主状态 icon」（statusSpec.icon）与
// 「classify 状态徽章」（classifyChip 的 emoji 取自同一张 statusPresentation 表）。
// 当 session 状态与 classify 字母映射到同一个 canonical 状态（succeeded+D 都是
// ✅、running+P 都是 🔄、error+E 都是 ❌、waiting+W/B 都是 ⏸️）时，卡片顶部出现
// 两个相同的状态 icon。
//
// 修复：删掉 classify 徽章在会话卡片顶部的渲染，只保留主状态 icon 这一路——
// 每张卡天然只有一个任务状态 icon，不再需要去重判断。classify 徽章仍在会话
// 弹窗里展示（main_shell 的 classifyChip 保留）。
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
  bool active = false,
  double? width,
}) async {
  final settings = await SettingsService.getInstance();
  final mgr = SessionManager(settings: settings);
  final session = Session(
    id: 'sess-$status',
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
    liveStatus: SessionStatus(status: status),
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
    testWidgets('running — 🔄 exactly once', (tester) async {
      final mgr = await _pumpCard(tester, status: 'running');
      expect(find.text('🔄'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('succeeded — ✅ exactly once（此前重复的场景）', (tester) async {
      final mgr = await _pumpCard(tester, status: 'succeeded');
      expect(find.text('✅'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('done — ✅ exactly once', (tester) async {
      final mgr = await _pumpCard(tester, status: 'done');
      expect(find.text('✅'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('error — ❌ exactly once（此前重复的场景）', (tester) async {
      final mgr = await _pumpCard(tester, status: 'error');
      expect(find.text('❌'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('waiting — ⏸️ exactly once（此前重复的场景）', (tester) async {
      final mgr = await _pumpCard(tester, status: 'waiting');
      expect(find.text('⏸️'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('blocked — 🔒 exactly once', (tester) async {
      final mgr = await _pumpCard(tester, status: 'blocked');
      expect(find.text('🔒'), findsOneWidget);
      mgr.dispose();
    });

    testWidgets('idle — 无任何状态 icon（回归 dashboard 声明）', (tester) async {
      final mgr = await _pumpCard(tester, status: 'idle', active: true);
      expect(find.text('⚪'), findsNothing);
      expect(find.text('🔄'), findsNothing);
      expect(find.text('⏸️'), findsNothing);
      expect(find.text('✅'), findsNothing);
      mgr.dispose();
    });

    testWidgets('每个状态 icon 唯一 + ⋯ 操作菜单保留', (tester) async {
      final mgr = await _pumpCard(tester, status: 'running');
      expect(find.text('🔄'), findsOneWidget);
      // 操作按钮不受影响。
      expect(find.byType(PopupMenuButton<String>), findsOneWidget);
      mgr.dispose();
    });
  });

  group('SessionCard narrow-layout regression', () {
    testWidgets('running 在窄卡上不抛溢出异常', (tester) async {
      final mgr = await _pumpCard(tester, status: 'running', width: 320);
      expect(tester.takeException(), isNull);
      expect(find.text('🔄'), findsOneWidget);
      mgr.dispose();
    });
  });
}
