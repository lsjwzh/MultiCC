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
    'execution': {
      'status': 'idle',
      'busy': false,
      'pending': false,
      ...?execution,
    },
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
      expect(copy.steps.map((step) => step.status), everyElement('pending'));
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
        value(
          attribution: {
            'candidate': {'state': 'stale'},
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 归属建议未应用');
      expect(copy.steps.first.status, 'pending');
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
      expect(copy.steps.first.status, 'pending');
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
      expect(copy.steps.map((step) => step.status), [
        'done',
        'pending',
        'pending',
        'pending',
      ]);
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
      expect(copy.steps.where((step) => step.status == 'done').length, 2);
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
      expect(copy.steps.where((step) => step.status == 'done').length, 3);
      expect(copy.title, contains('等待源现场稳定'));
    });

    test('服务端四个事实独立渲染，分离阻断不会伪装第 4 步生效', () {
      final copy = airDeliveryCopy(
        value(
          attribution: {
            'steps': const [
              {'key': 'run', 'label': '本轮成功', 'status': 'done'},
              {'key': 'delivery', 'label': '代码交付', 'status': 'done'},
              {'key': 'barrier', 'label': '源现场稳定', 'status': 'blocked'},
              {'key': 'attribution', 'label': '分离生效', 'status': 'pending'},
            ],
            'blockers': const [
              'workspace_busy',
              'separation_application_required',
            ],
            'separation': {
              'state': 'pending',
              'phase': 'blocked',
              'targetTitle': '独立目标',
            },
          },
        ),
      );
      expect(copy.eyebrow, 'MULTICC · 分离暂未生效');
      expect(copy.text, airBlockerNames['workspace_busy']);
      expect(copy.steps.map((step) => step.status), [
        'done',
        'done',
        'blocked',
        'pending',
      ]);
      expect(copy.steps.last.label, '分离生效');
    });

    test('保留与分离生效是两种不同结果', () {
      final kept = airDeliveryCopy(
        value(
          attribution: {
            'steps': const [
              {'label': '本轮成功', 'status': 'done'},
              {'label': '代码交付', 'status': 'done'},
              {'label': '源现场稳定', 'status': 'done'},
              {'label': '分离生效', 'status': 'skipped'},
            ],
            'separation': {'state': 'kept', 'targetTitle': '独立目标'},
          },
        ),
      );
      expect(kept.title, '本轮保留在当前任务');
      expect(kept.steps.last.status, 'skipped');
      final applied = airDeliveryCopy(
        value(
          attribution: {
            'steps': const [
              {'label': '本轮成功', 'status': 'done'},
              {'label': '代码交付', 'status': 'done'},
              {'label': '源现场稳定', 'status': 'done'},
              {'label': '分离生效', 'status': 'done'},
            ],
            'separation': {'state': 'separated', 'targetTitle': '独立目标'},
          },
        ),
      );
      expect(applied.eyebrow, 'MULTICC · 分离已生效');
      expect(applied.steps.last.status, 'done');
    });

    test('本轮失败不会被写成任务完成', () {
      final copy = airDeliveryCopy(
        value(
          attribution: {
            'run': {'outcome': 'failed'},
          },
        ),
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
          'blockers': ['integration_receipt_required', 'something_new'],
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
          'roleBindings': {
            'version': 2,
            'bindings': [
              {'name': '代码审查', 'prompt': '只改必要的地方。'},
            ],
          },
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
    expect(
      find.byKey(const ValueKey('air-delivery-reconcile')),
      findsOneWidget,
    );
    // 任务有自己的角色才谈得上编辑 —— 观察来的只读任务没有这一项。
    expect(
      find.byKey(const ValueKey('air-details-edit-roles')),
      findsOneWidget,
    );
    expect(find.text('计划与任务生命周期'), findsOneWidget);
    // 生命周期动作条（归档/移动/删除）紧跟在编辑角色之后，所以它也在首屏里。
    expect(find.byKey(const ValueKey('air-details-archive')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-details-delete')), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey('air-delivery-reconcile')));
    await tester.pumpAndSettle();
    // 核验之后再拉一次详情，所以 POST 后面还跟着一个 GET。
    expect(requests, contains('POST /api/air/tasks/t1/delivery/reconcile'));
    expect(requests.last, 'GET /api/air/tasks/t1');

    // 手机上一屏放不下动作条加四组，剩下的滚下去看。
    await tester.drag(
      find.byKey(const ValueKey('air-details-panel')),
      const Offset(0, -600),
    );
    await tester.pumpAndSettle();
    expect(find.text('代码与交付'), findsOneWidget);
    expect(find.text('角色与上下文'), findsOneWidget);
    expect(find.text('执行资源'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('分离应用凭证到位后可从详情直接打开独立任务', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final client = MockClient(
      (request) async => http.Response(
        jsonEncode({
          'ok': true,
          'task': {'id': 'source', 'title': '源任务', 'status': 'active'},
          'status': 'active',
          'execution': {'status': 'idle', 'busy': false},
          'messages': const [{}],
          'attribution': {
            'steps': const [
              {'label': '本轮成功', 'status': 'done'},
              {'label': '代码交付', 'status': 'done'},
              {'label': '源现场稳定', 'status': 'done'},
              {'label': '分离生效', 'status': 'done'},
            ],
            'separation': {
              'state': 'separated',
              'targetTaskId': 'target',
              'targetTitle': '独立任务',
            },
            'application': {'id': 'application-1', 'targetTaskId': 'target'},
          },
          'resource': {'residency': 'resident', 'lease': 'idle'},
          'configuration': const {},
          'sessionId': 'source-session',
          'readOnly': false,
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );
    String? opened;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirTaskDetailsPanel(
            taskId: 'source',
            service: AirService(settings: settings, httpClient: client),
            onOpenSeparatedTask: (taskId) => opened = taskId,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('MULTICC · 分离已生效'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('air-delivery-open-separated')));
    expect(opened, 'target');
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('观察来的只读任务没有角色可编辑，就不摆这个按钮', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final client = MockClient((request) async {
      return http.Response(
        jsonEncode({
          'ok': true,
          'task': {'id': 't2', 'title': '别人的任务', 'status': 'active'},
          'status': 'active',
          'execution': {'status': 'idle', 'busy': false},
          'messages': const [],
          'attribution': const {},
          'resource': {'residency': 'resident', 'lease': 'idle'},
          'configuration': const {},
          'sessionId': 'sess-9',
          'readOnly': true,
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirTaskDetailsPanel(
            taskId: 't2',
            service: AirService(settings: settings, httpClient: client),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-details-edit-roles')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  /// 详情面板的生命周期动作条（Web `detail-actions`）：归档/恢复、移动、删除。
  /// 三个动作都直接改服务端状态，所以断言落在「发了哪个请求」上，而不是按钮有
  /// 没有画出来。
  group('生命周期动作', () {
    /// 一条最小可用的详情响应；[task] 覆盖任务那层，[readOnly] 决定移动和角色
    /// 编辑在不在。
    String details({
      Map<String, dynamic>? task,
      bool readOnly = false,
    }) => jsonEncode({
      'ok': true,
      'task': {
        'id': 't1',
        'title': '登录页面',
        'status': 'active',
        'recordType': 'execution',
        ...?task,
      },
      'status': 'active',
      'execution': {'status': 'idle', 'busy': false},
      'messages': const [{}],
      'attribution': const {},
      'resource': {'residency': 'resident', 'lease': 'idle'},
      'configuration': const {},
      'sessionId': 'sess-1',
      'readOnly': readOnly,
    });

    Future<SettingsService> settingsFor() async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://localhost:3000',
      });
      return SettingsService.getInstance();
    }

    /// 详情响应必须是 UTF-8 的 JSON —— `http.Response(String, ...)` 默认按
    /// latin-1 编码 body，而 `AirService` 是按 UTF-8 解 `bodyBytes` 的，少了这行
    /// 标题，中文标题会解成乱码、整份详情都读不出来。
    http.Response ok(String body) => http.Response(
      body,
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

    const directories = [
      AirDirectory(id: 'dir-a', name: '主仓库', path: '/code/main'),
      AirDirectory(id: 'dir-b', name: '实验仓库', path: '/code/lab'),
    ];

    testWidgets('归档任务写 archived，恢复任务写回 active', (tester) async {
      final settings = await settingsFor();
      final writes = <String>[];
      final client = MockClient((request) async {
        if (request.method != 'GET') {
          writes.add('${request.method} ${request.url.path} ${request.body}');
        }
        return ok(details());
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirTaskDetailsPanel(
              taskId: 't1',
              service: AirService(settings: settings, httpClient: client),
              directories: directories,
              dirId: 'dir-a',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 进行中的任务，按钮就是「归档任务」。
      expect(find.text('归档任务'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('air-details-archive')));
      await tester.pumpAndSettle();
      expect(writes, [
        'POST /api/task-board/tasks/t1/status {"status":"archived"}',
      ]);

      // 归档过之后同一个按钮翻成「恢复任务」，写回 active。
      // 换一次 key 才会重建 State：同一个 taskId、同一个 widget 类型，光换
      // httpClient 不会让面板重新 initState（旧的 _value 还在）。
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: KeyedSubtree(
              key: const ValueKey('archived'),
              child: AirTaskDetailsPanel(
                taskId: 't1',
                service: AirService(
                  settings: settings,
                  httpClient: MockClient(
                    (request) async => ok(
                      details(
                        task: {'status': 'archived'},
                      ),
                    ),
                  ),
                ),
                directories: directories,
                dirId: 'dir-a',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('恢复任务'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      client.close();
    });

    testWidgets('移动只列别的目录，选中后发 relocate', (tester) async {
      final settings = await settingsFor();
      final writes = <String>[];
      final client = MockClient((request) async {
        if (request.method != 'GET') {
          writes.add('${request.method} ${request.url.path} ${request.body}');
        }
        return ok(details());
      });
      String? movedTo;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirTaskDetailsPanel(
              taskId: 't1',
              service: AirService(settings: settings, httpClient: client),
              directories: directories,
              dirId: 'dir-a',
              onTaskMoved: (dirId) => movedTo = dirId,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('air-details-move')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('air-details-move-dialog')), findsOneWidget);
      // 当前目录不能是目的地 —— 不然「移动」会变成一次空操作。
      expect(
        find.byKey(const ValueKey('air-details-move-target-dir-a')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('air-details-move-target-dir-b')),
        findsOneWidget,
      );

      // 没选之前确认按钮是灰的。
      final confirm = tester.widget<TextButton>(
        find.byKey(const ValueKey('air-details-move-confirm')),
      );
      expect(confirm.onPressed, isNull);

      await tester.tap(find.byKey(const ValueKey('air-details-move-target-dir-b')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-details-move-confirm')));
      await tester.pumpAndSettle();

      expect(writes, [
        'POST /api/task-board/tasks/t1/relocate {"dirId":"dir-b"}',
      ]);
      // 移动成功后宿主得知道该跟着去哪儿。
      expect(movedTo, 'dir-b');

      await tester.pumpWidget(const SizedBox());
      client.close();
    });

    testWidgets('只读任务不给移动入口，删除要先确认', (tester) async {
      final settings = await settingsFor();
      final writes = <String>[];
      final client = MockClient((request) async {
        if (request.method != 'GET') {
          writes.add('${request.method} ${request.url.path}');
        }
        return ok(details(readOnly: true));
      });
      var removed = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirTaskDetailsPanel(
              taskId: 't1',
              service: AirService(settings: settings, httpClient: client),
              directories: directories,
              dirId: 'dir-a',
              onTaskRemoved: () => removed = true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('air-details-move')), findsNothing);
      expect(find.byKey(const ValueKey('air-details-delete')), findsOneWidget);

      // 先取消：什么也不该发生 —— 「此操作不可撤销」那句得有地方反悔。
      await tester.tap(find.byKey(const ValueKey('air-details-delete')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('air-details-delete-confirm')),
        findsOneWidget,
      );
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(writes, isEmpty);
      expect(removed, isFalse);

      await tester.tap(find.byKey(const ValueKey('air-details-delete')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-details-delete-confirm-ok')));
      await tester.pumpAndSettle();
      expect(writes, ['DELETE /api/task-board/tasks/t1']);
      expect(removed, isTrue);

      await tester.pumpWidget(const SizedBox());
      client.close();
    });

    testWidgets('服务端拒绝时说的是原因，不是 HTTP 状态码', (tester) async {
      final settings = await settingsFor();
      final client = MockClient((request) async {
        if (request.method == 'GET') return ok(details());
        return http.Response(
          jsonEncode({'ok': false, 'error': 'task_workspace_dirty'}),
          409,
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirTaskDetailsPanel(
              taskId: 't1',
              service: AirService(settings: settings, httpClient: client),
              directories: directories,
              dirId: 'dir-a',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-details-archive')));
      await tester.pumpAndSettle();

      expect(
        find.textContaining(airTaskActionErrors['task_workspace_dirty']!),
        findsOneWidget,
      );
      expect(find.textContaining('HTTP 409'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      client.close();
    });
  });
}
