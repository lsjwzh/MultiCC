import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/utils/context_level.dart';
import 'package:multicc_app/widgets/chat_header.dart';

/// 上下文水位（web `chat-context-controls.js` 的 `showContextLevel`）：措辞和
/// 分叉必须逐字对齐 —— 这句话的全部价值就在于把「prompt too long」提前变成
/// 一个能读的数字，两端说法不一致就没法互相对照。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  Map<String, dynamic> payload({
    bool found = true,
    num liveBytes = 1048576,
    num fileBytes = 2097152,
    num liveTurns = 12,
    num? estimatedTokens = 12345,
    bool compacted = false,
    bool overWatermark = false,
    bool wouldPrune = false,
    Map<String, dynamic>? plan,
  }) => {
    'ok': true,
    'supported': true,
    'transcript': {
      'found': found,
      'liveBytes': liveBytes,
      'fileBytes': fileBytes,
      'liveTurns': liveTurns,
      'estimatedTokens': estimatedTokens,
      'compactBoundary': {'present': compacted},
      'overWatermark': overWatermark,
      'wouldPrune': wouldPrune,
    },
    if (plan != null) 'plan': plan,
  };

  group('contextLevelMessage', () {
    test('只说水位时给一句话，MB 两位小数 + token 千分位', () {
      final msg = contextLevelMessage(payload());
      expect(msg, isNotNull);
      expect(msg, contains('1.00 MB'));
      expect(msg, contains('2.00 MB'));
      expect(msg, contains('12 轮对话'));
      expect(msg, contains('12,345'));
    });

    test('估算不出 token 时显示 ?，绝不编一个数出来', () {
      final msg = contextLevelMessage(payload(estimatedTokens: null));
      expect(msg, contains('?'));
      expect(msg, isNot(contains('0 tokens')));
    });

    test('压缩过 / 超过高水位各自补一句', () {
      final msg = contextLevelMessage(
        payload(compacted: true, overWatermark: true),
      );
      expect(msg, contains(t('contextLevelCompacted')));
      expect(msg, contains(t('contextLevelOverWatermark')));
    });

    test('没超水位也不压缩时不提这两件事', () {
      final msg = contextLevelMessage(payload())!;
      expect(msg, isNot(contains(t('contextLevelCompacted'))));
      expect(msg, isNot(contains(t('contextLevelOverWatermark'))));
    });

    test('dry-run 整理会丢轮次时，把代价说清楚（含实质轮次）', () {
      final msg = contextLevelMessage(
        payload(
          plan: {
            'afterBytes': 524288,
            'lostTurns': 6,
            'lostSubstantiveTurns': 2,
          },
        ),
      )!;
      expect(msg, contains('0.50 MB'));
      expect(msg, contains('6 轮对话'));
      expect(msg, contains('2 轮有实质内容'));
    });

    test('lostSubstantiveTurns 缺失时退回 lostTurns，不显示 null', () {
      final msg = contextLevelMessage(
        payload(
          plan: {'afterBytes': 0, 'lostTurns': 3},
        ),
      )!;
      expect(msg, isNot(contains('null')));
      expect(msg, contains('3 轮有实质内容'));
    });

    test('整理无损时明确说不会丢对话', () {
      final msg = contextLevelMessage(
        payload(plan: {'afterBytes': 1048576, 'lostTurns': 0}),
      )!;
      expect(msg, contains(t('contextLevelPlanSafe', {'after': '1.00 MB'})));
    });

    test('闸门会跑但没东西可整时，补一句免得读成「马上要剪」', () {
      final msg = contextLevelMessage(payload(wouldPrune: true))!;
      expect(msg, contains(t('contextLevelPlanNone')));
    });

    test('非 claude 会话 / 读不到转录 -> null（调用方显示「此会话没有」）', () {
      expect(contextLevelMessage({'supported': false}), isNull);
      expect(contextLevelMessage(payload(found: false)), isNull);
      expect(contextLevelMessage({'ok': true, 'supported': true}), isNull);
    });
  });

  group('清除上下文菜单', () {
    testWidgets('菜单里有「轮转原生上下文」和「查看上下文水位」', (tester) async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:1',
        'multicc_token': '',
      });
      final settings = await SettingsService.getInstance();
      final mgr = SessionManager(settings: settings);
      final provider = ChatProvider(
        settings: settings,
        sessionName: 's-ctx',
        sessionCwd: '/tmp',
      );

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<SessionManager>.value(value: mgr),
            ChangeNotifierProvider<ChatProvider>.value(value: provider),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: ChatHeader(
                settings: settings,
                mergeReady: false,
                cwd: '',
                onCwd: () {},
                onMerge: () {},
                onRole: () {},
                onMemory: () {},
                onMemo: () {},
                onShare: () {},
                onForceSync: () {},
                onChatWidth: () {},
                autoCommit: true,
                onAutoCommit: () {},
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text(t('clearCtx')));
      await tester.pumpAndSettle();

      // 回归点：这两项此前要么缺失、要么被写成一整行转义注释（永远不渲染）。
      expect(find.text(t('rotateNativeContext')), findsOneWidget);
      expect(find.text(t('contextLevel')), findsOneWidget);

      provider.dispose();
      mgr.dispose();
    });
  });
}
