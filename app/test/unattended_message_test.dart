import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/admission_notes.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

// 契约 docs/unattended-mode.md 的 Backend notes：
//   监督器插话 = role=user 的 `🔇[无人值守 Unattended] <instruction>` → 「🤖 无人值守」小卡；
//   UI-only 轨迹 = role=system / kind=unattended_trace，正文同样以标记开头 → 居中静音行。
// 解析放在模型层，历史与实时两条路径共用（historyRecordMessage / systemLineMessage）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test('parseUnattendedText：认带 🔇 和不带 🔇 的标记，剥掉前缀只留正文', () {
    expect(parseUnattendedText('🔇$kUnattendedTag 继续跑测试'), '继续跑测试');
    expect(parseUnattendedText('$kUnattendedTag   补一句  '), '补一句');
    expect(parseUnattendedText('  $kUnattendedTag 带空白的正文'), '带空白的正文');
    // 只有前缀没有正文：空串（不是 null），渲染层据此决定不画。
    expect(parseUnattendedText('🔇$kUnattendedTag'), '');
  });

  test('parseUnattendedText：普通注入 / 空值不误判', () {
    expect(parseUnattendedText('🔇[后台进程检查] 已结束'), isNull);
    expect(parseUnattendedText('普通用户消息'), isNull);
    expect(parseUnattendedText(null), isNull);
    expect(parseUnattendedText(''), isNull);
  });

  test('unattendedTraceMessage：system + 标记（无 kind）也认，正文剥掉标记', () {
    final message = unattendedTraceMessage(const {
      'id': 'trace-1',
      'role': 'system',
      'content': '$kUnattendedTag 第 2 轮判定：继续',
      'ts': 1724000000000,
    });
    expect(message, isNotNull);
    expect(message!.role, MessageRole.system);
    expect(message.unattendedTrace, isTrue);
    expect(message.content, '第 2 轮判定：继续');
    expect(message.id, 'trace-1');
  });

  test('unattendedTraceMessage：user 的标记消息是插话，不是轨迹', () {
    // 监督器插话（role=user）要落在「🤖 无人值守」小卡，不能变成系统行。
    expect(
      unattendedTraceMessage(const {
        'role': 'user',
        'content': '🔇$kUnattendedTag 继续跑测试',
      }),
      isNull,
    );
  });

  test('unattendedTraceMessage：显式 kind 优先于角色；正文没标记就不算轨迹', () {
    final explicit = unattendedTraceMessage(const {
      'role': 'user',
      'kind': 'unattended_trace',
      'content': '$kUnattendedTag AI 已代为回答',
    });
    expect(explicit, isNotNull);
    expect(explicit!.role, MessageRole.system);
    expect(explicit.content, 'AI 已代为回答');

    // 没有标记的普通 system 行（哪怕 kind 说是轨迹）也不接管。
    expect(
      unattendedTraceMessage(const {
        'role': 'system',
        'kind': 'unattended_trace',
        'content': '普通系统提示',
      }),
      isNull,
    );
  });

  test('historyRecordMessage：轨迹 record 走同一条路径，普通记录不受影响', () {
    final trace = historyRecordMessage(const {
      'id': 'trace-2',
      'role': 'system',
      'kind': 'unattended_trace',
      'content': '$kUnattendedTag 判定：继续',
    })!;
    expect(trace.unattendedTrace, isTrue);
    expect(trace.content, '判定：继续');

    final plain = historyRecordMessage(const {
      'id': 'm-1',
      'role': 'assistant',
      'content': '普通回答',
    })!;
    expect(plain.unattendedTrace, isFalse);
    expect(plain.content, '普通回答');
  });

  test('systemLineMessage：带标记的本地系统行落成轨迹，普通行不受影响', () {
    final trace = systemLineMessage('🔇$kUnattendedTag 继续跑测试');
    expect(trace.unattendedTrace, isTrue);
    expect(trace.role, MessageRole.system);
    expect(trace.content, '继续跑测试');

    final plain = systemLineMessage('/help');
    expect(plain.unattendedTrace, isFalse);
    expect(plain.content, '/help');
  });

  testWidgets('插话渲染成「🤖 无人值守」小卡，正文不带标记', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageBubble(
            message: ChatMessage(
              role: MessageRole.user,
              content: '🔇$kUnattendedTag 继续跑测试',
            ),
          ),
        ),
      ),
    );

    expect(find.byKey(const ValueKey('unattended-mark')), findsOneWidget);
    expect(find.text(t('unattendedBadge')), findsOneWidget);
    expect(find.text('继续跑测试'), findsOneWidget);
    // 用户气泡不再出现，标记字面量也不会漏到界面上。
    expect(find.textContaining(kUnattendedTag), findsNothing);
  });

  testWidgets('轨迹渲染成居中静音行，同样带徽标', (tester) async {
    final trace = unattendedTraceMessage(const {
      'role': 'system',
      'kind': 'unattended_trace',
      'content': '$kUnattendedTag 第 2 轮判定：继续',
    })!;
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: MessageBubble(message: trace))),
    );

    expect(find.byKey(const ValueKey('unattended-trace-line')), findsOneWidget);
    expect(find.byKey(const ValueKey('unattended-mark')), findsNothing);
    expect(find.text(t('unattendedBadge')), findsOneWidget);
    expect(find.text('第 2 轮判定：继续'), findsOneWidget);
  });
}
