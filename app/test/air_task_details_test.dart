import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_task_details.dart';

/// 交付卡那一整段判断是「本轮 ≠ 任务完成 ≠ 归属生效」这条规则的唯一出口，
/// 每种组合都得说一句对得上号的话，所以这些分支直接对着纯函数测。
void main() {
  Map<String, dynamic> value({
    Map<String, dynamic>? task,
    Map<String, dynamic>? execution,
    Map<String, dynamic>? attribution,
    Map<String, dynamic>? resource,
    List<dynamic>? messages,
    bool readOnly = false,
  }) => {
    'task': {'id': 't1', 'title': '登录页面', 'status': 'active', ...?task},
    'execution': {'status': 'idle', 'busy': false, 'pending': false, ...?execution},
    'attribution': attribution ?? const {},
    'resource': resource ?? const {'residency': 'resident', 'lease': 'idle'},
    'messages': messages ?? const [{}],
    'readOnly': readOnly,
    'sessionId': 'sess-1',
  };

  group('交付卡', () {
    test('计划任务还没发第一条消息时说「计划尚未执行」', () {
      final copy = airDeliveryCopy(
        value(
          task: {'recordType': 'planned'},
          resource: {'residency': 'planned'},
          messages: const [],
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 计划任务');
      expect(copy.title, '计划尚未执行');
      expect(copy.stage, 0);
    });

    test('资源没到位时先报资源，不报本轮结果', () {
      final copy = airDeliveryCopy(
        value(resource: {'capacityReason': 'workspace_resident_capacity'}),
      );
      expect(copy.eyebrow, 'MULTICC · 执行资源');
      expect(copy.title, '等待目录容量 · 现有工作现场正在保留');
    });

    test('等待回答优先于执行中', () {
      final copy = airDeliveryCopy(
        value(execution: {'status': 'running', 'busy': true, 'pending': true}),
      );
      expect(copy.eyebrow, 'MULTICC · 等待回答');
      expect(copy.title, '本轮需要你的回答');
    });

    test('过期的归属建议不改投已接受的消息', () {
      final copy = airDeliveryCopy(
        value(attribution: {'candidate': {'state': 'stale'}}),
      );
      expect(copy.eyebrow, 'MULTICC · 归属建议未应用');
      expect(copy.currentStep, isFalse);
    });

    test('执行中带归属建议：仍留在当前任务，交付后才确认', () {
      final copy = airDeliveryCopy(
        value(
          task: {'title': '登录页面'},
          execution: {'status': 'running', 'busy': true},
          attribution: {
            'candidate': {'title': '账号体系'},
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 本轮执行中');
      expect(copy.text, '可能关联「账号体系」，当前仍在「登录页面」中执行。');
      expect(copy.currentStep, isTrue);
    });

    test('本轮成功但还没交付：停在第一步', () {
      final copy = airDeliveryCopy(
        value(
          attribution: {
            'run': {'outcome': 'succeeded'},
            'candidate': {'title': '账号体系'},
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 本轮成功，等待交付');
      expect(copy.stage, 1);
      expect(copy.currentStep, isTrue);
    });

    test('有合并记录但基分支变了：交付步骤回到「待核验」', () {
      final copy = airDeliveryCopy(
        value(
          attribution: {
            'run': {'outcome': 'succeeded'},
            'candidate': {'title': '账号体系'},
            'integration': {'baselineCurrent': false},
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 交付记录待核验');
      expect(copy.stage, 2);
    });

    test('交付已核验：四步走完三步，仍等源现场稳定', () {
      final copy = airDeliveryCopy(
        value(
          attribution: {
            'run': {'outcome': 'succeeded'},
            'candidate': {'title': '账号体系'},
            'integration': {'baselineCurrent': true},
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 交付已核验');
      expect(copy.stage, 3);
      expect(copy.title, contains('等待源现场稳定'));
    });

    test('本轮失败不会被写成任务完成', () {
      final copy = airDeliveryCopy(
        value(attribution: {
          'run': {'outcome': 'failed'},
        }),
      );
      expect(copy.eyebrow, 'MULTICC · 本轮未成功');
      expect(copy.title, '任务保持进行中');
    });
  });

  group('详情分组', () {
    test('角色附件来自角色绑定，没有绑定时说「本任务配置」', () {
      final withBindings = airDetailGroups({
        'task': {'id': 't1', 'recordType': 'execution', 'status': 'active'},
        'roleBindings': {
          'version': 3,
          'bindings': [
            {'name': '移动端体验'},
          ],
        },
        'resource': const {},
        'configuration': const {},
      });
      final roles = withBindings.firstWhere((g) => g.title == '角色与上下文');
      expect(roles.rows.first.$2, '移动端体验 · 版本 3');

      final without = airDetailGroups({
        'task': {'id': 't1', 'recordType': 'execution', 'status': 'active'},
        'roleBindings': {'version': 0, 'bindings': const []},
        'resource': const {},
        'configuration': const {},
      });
      expect(
        without.firstWhere((g) => g.title == '角色与上下文').rows.first.$2,
        '无附加角色 · 版本 0',
      );
    });

    test('归属建议的拦截原因译成中文，未知原因原样保留', () {
      final groups = airDetailGroups({
        'task': {'id': 't1', 'recordType': 'execution', 'status': 'active'},
        'attribution': {
          'candidate': {
            'blockers': ['integration_receipt_required', 'something_new'],
          },
        },
        'resource': const {},
        'configuration': const {},
      });
      expect(groups.map((g) => g.title), [
        '计划与任务生命周期',
        '代码与交付',
        '角色与上下文',
        '执行资源',
      ]);
      final code = groups.firstWhere((g) => g.title == '代码与交付');
      expect(code.footer, isNotNull);
      expect(
        airBlockerNames['integration_receipt_required'],
        '等待本轮代码按项目流程合入基分支。',
      );
    });
  });

  testWidgets('任务详情面板：交付卡说清本轮发生了什么，核验按钮只交付时出现', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final requests = <String>[];
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      return http.Response(
        jsonEncode({
          'ok': true,
          'task': {
            'id': 't1',
            'title': '登录页面',
            'status': 'active',
            'recordType': 'execution',
          },
          'status': 'active',
          'execution': {'status': 'idle', 'busy': false},
          'messages': [
            {'id': 'm1'},
          ],
          'attribution': {
            'run': {'outcome': 'succeeded'},
            'candidate': {'title': '账号体系'},
            'integration': {'baselineCurrent': true},
          },
          'resource': {'residency': 'resident', 'lease': 'running'},
          'configuration': const {},
          'sessionId': 'sess-1',
          'readOnly': false,
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirTaskDetailsPanel(
            taskId: 't1',
            service: AirService(settings: settings, httpClient: client),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(requests, ['GET /api/air/tasks/t1']);
    expect(find.text('MULTICC · 交付已核验'), findsOneWidget);
    // 状态那一行跟交付卡分工不同：它说的是「走到哪一步了」。
    expect(find.text('本轮 空闲 · 任务 进行中'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-delivery-title')), findsOneWidget);
    expect(find.text('下一条消息仍发送到「登录页面」'), findsOneWidget);
    // 有 integration 才有核验入口 —— 没有合并记录时点它没有任何意义。
    expect(find.byKey(const ValueKey('air-delivery-reconcile')), findsOneWidget);
    expect(find.text('计划与任务生命周期'), findsOneWidget);
    expect(find.text('代码与交付'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey('air-delivery-reconcile')));
    await tester.pumpAndSettle();
    // 核验之后再拉一次详情，所以 POST 后面还跟着一个 GET。
    expect(requests, contains('POST /api/air/tasks/t1/delivery/reconcile'));
    expect(requests.last, 'GET /api/air/tasks/t1');

    // 手机上一屏放不下四组，剩下的滚下去看。
    await tester.drag(
      find.byKey(const ValueKey('air-details-panel')),
      const Offset(0, -600),
    );
    await tester.pumpAndSettle();
    expect(find.text('角色与上下文'), findsOneWidget);
    expect(find.text('执行资源'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
