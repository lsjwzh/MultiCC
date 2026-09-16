import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/workspace_service.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';
import 'package:multicc_app/widgets/aux_classify_bar.dart';

/// 判定冻结的 App 侧（服务端同源事实见 tests/test-aux-verdict-health.js）。
///
/// 屏幕上那条「目标 · 阶段 · 状态」是分类器（aux）最后一次说话的结果。分类器自己
/// 挂掉之后它不再变，但页面照旧把它当「助手现在认为你在做的事」显示 —— 用户于是
/// 问「怎么还是 #6TFD · 排查电量消耗增加原因」。判定不擦掉（仍是最好的描述），
/// 只停止冒充当前判定。
///
/// 这里钉三件事：两帧（task_state 携带 / 健康变迁专帧）把事实送到，
/// 以及共享渲染面（分类徽章、聊天页分类条）真的把它显示出来。
class _TestWorkspaceService extends WorkspaceService {
  _TestWorkspaceService({required super.settings, required super.dirId});

  @override
  void connect() {}
}

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SizedBox(width: 360, child: child)),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  late SettingsService settings;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
  });

  _TestWorkspaceService service() =>
      _TestWorkspaceService(settings: settings, dirId: 'dir-a');

  void frame(WorkspaceService s, Map<String, dynamic> msg) =>
      s.handleSocketMessage(jsonEncode(msg));

  group('传输层', () {
    test('task_state 带上判定新鲜度；缺字段沿用，显式 false 才落下', () {
      final s = service();
      frame(s, {
        'type': 'task_state',
        'sessionId': 's1',
        'goal': '排查电量消耗增加原因',
        'phase': 'implementation',
        'classifyState': 'C',
        'taskShortCode': '6TFD',
        'auxUnhealthy': true,
        'auxUnhealthySince': 1700000000000,
      });
      var st = s.statuses['s1']!;
      expect(st.goal, '排查电量消耗增加原因', reason: '判定本身照旧显示');
      expect(st.taskShortCode, '6TFD');
      expect(st.auxUnhealthy, isTrue);
      expect(st.auxUnhealthySince, 1700000000000);

      // 不带该字段的帧（老服务端）不能把标记抹掉 —— 那会让标记凭一次 tick 闪掉。
      frame(s, {'type': 'task_state', 'sessionId': 's1', 'classifyState': 'D'});
      st = s.statuses['s1']!;
      expect(st.classifyState, 'D');
      expect(st.auxUnhealthy, isTrue);
      expect(st.auxUnhealthySince, 1700000000000);

      // 恢复帧显式带 false：标记落下，且不留上一次的起始时间（否则下次故障
      // 一开始就会显示一个早于本次故障的时间）。
      frame(s, {
        'type': 'task_state',
        'sessionId': 's1',
        'classifyState': 'D',
        'auxUnhealthy': false,
        'auxUnhealthySince': null,
      });
      st = s.statuses['s1']!;
      expect(st.auxUnhealthy, isFalse);
      expect(st.auxUnhealthySince, 0);
    });

    test('status 快照整对读，健康时不留旧起始时间', () {
      final s = service();
      frame(s, {
        'type': 'status',
        'sessionId': 's1',
        'status': 'running',
        'classifyState': 'P',
        'goal': 'g',
        'auxUnhealthy': true,
        'auxUnhealthySince': 42,
      });
      expect(s.statuses['s1']!.auxUnhealthy, isTrue);
      expect(s.statuses['s1']!.auxUnhealthySince, 42);

      // 健康 + 带陈旧 since：since 必须归零，而不是被照单收下。
      frame(s, {
        'type': 'status',
        'sessionId': 's1',
        'status': 'running',
        'auxUnhealthy': false,
        'auxUnhealthySince': 42,
      });
      expect(s.statuses['s1']!.auxUnhealthy, isFalse);
      expect(s.statuses['s1']!.auxUnhealthySince, 0);

      // 两样都不带的 status tick 沿用上一次（classify 字段同规矩）。
      frame(s, {
        'type': 'status',
        'sessionId': 's1',
        'status': 'running',
        'classifyState': 'P',
        'goal': 'g',
        'auxUnhealthy': true,
        'auxUnhealthySince': 7,
      });
      frame(s, {'type': 'status', 'sessionId': 's1', 'status': 'running'});
      expect(s.statuses['s1']!.auxUnhealthy, isTrue);
      expect(s.statuses['s1']!.auxUnhealthySince, 7);
    });

    test('健康变迁专帧：点名一个会话时只动它，恢复帧把标记撤掉', () {
      final s = service();
      frame(s, {
        'type': 'task_state',
        'sessionId': 's1',
        'goal': 'g1',
        'classifyState': 'P',
      });
      frame(s, {
        'type': 'task_state',
        'sessionId': 's2',
        'goal': 'g2',
        'classifyState': 'P',
      });

      frame(s, {
        'type': 'aux_verdict_staleness',
        'sessionId': 's1',
        'auxUnhealthy': true,
        'auxUnhealthySince': 99,
      });
      expect(s.statuses['s1']!.auxUnhealthy, isTrue);
      expect(s.statuses['s1']!.auxUnhealthySince, 99);
      expect(s.statuses['s2']!.auxUnhealthy, isFalse, reason: '只动点名的那个');

      // 恢复是同一帧把标志清掉 —— 页面必须能自己把标记拿下来，而不是只有置位。
      frame(s, {
        'type': 'aux_verdict_staleness',
        'sessionId': 's1',
        'auxUnhealthy': false,
      });
      expect(s.statuses['s1']!.auxUnhealthy, isFalse);
      expect(s.statuses['s1']!.auxUnhealthySince, 0);
    });

    test('不带 sessionId 的专帧覆盖所有在展示判定的会话', () {
      final s = service();
      frame(s, {
        'type': 'task_state',
        'sessionId': 'judged',
        'goal': 'g',
        'classifyState': 'P',
      });
      frame(s, {
        'type': 'task_state',
        'sessionId': 'phase-only',
        'phase': 'implementation',
      });
      frame(s, {
        'type': 'task_state',
        'sessionId': 'bare',
        'classifyState': '',
        'goal': '',
      });

      frame(s, {'type': 'aux_verdict_staleness', 'auxUnhealthy': true});
      expect(s.statuses['judged']!.auxUnhealthy, isTrue);
      expect(
        s.statuses['phase-only']!.auxUnhealthy,
        isFalse,
        reason: '没有判定就没有可冻结的判定，不必涂标记',
      );
      expect(s.statuses['bare']!.auxUnhealthy, isFalse);
    });
  });

  group('展示层', () {
    testWidgets('分类徽章在冻结时挂「判定已暂停」，健康时不挂', (tester) async {
      await tester.pumpWidget(
        _host(
          classifyChip(
            const SessionStatus(
              status: 'running',
              classifyState: 'P',
              goal: '排查电量消耗增加原因',
              auxUnhealthy: true,
            ),
          ),
        ),
      );
      expect(find.textContaining('判定已暂停'), findsOneWidget);
      // 判定本身留在屏幕上：它仍是最好的描述，只是不再冒充当前判定。
      expect(find.textContaining('处理'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          classifyChip(
            const SessionStatus(
              status: 'running',
              classifyState: 'P',
              goal: '排查电量消耗增加原因',
            ),
          ),
        ),
      );
      expect(find.textContaining('判定已暂停'), findsNothing);
    });

    testWidgets('聊天页分类条在冻结时把目标降调并挂上标记', (tester) async {
      await tester.pumpWidget(
        _host(
          const AuxClassifyBar(
            goal: '排查电量消耗增加原因',
            phase: 'implementation',
            classifyState: 'P',
            stale: true,
          ),
        ),
      );
      expect(find.text('排查电量消耗增加原因'), findsOneWidget);
      expect(find.textContaining('判定已暂停'), findsOneWidget);
      final Text goalText = tester.widget(find.text('排查电量消耗增加原因'));
      expect(goalText.style?.fontStyle, FontStyle.italic);

      await tester.pumpWidget(
        _host(
          const AuxClassifyBar(
            goal: '排查电量消耗增加原因',
            phase: 'implementation',
            classifyState: 'P',
          ),
        ),
      );
      expect(find.textContaining('判定已暂停'), findsNothing);
      final Text fresh = tester.widget(find.text('排查电量消耗增加原因'));
      expect(fresh.style?.fontStyle, FontStyle.normal);
    });
  });
}
