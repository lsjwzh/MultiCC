import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/agent_preset_service.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_role_editor.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 角色库：索引只给 id 和名字，说明要等选中之后再拉 —— 和真接口一样分两步，
/// 这样「附加一个角色」才是在测两条请求，而不是一条。
MockClient _presetClient(List<String> requests) => MockClient((request) async {
  requests.add(request.url.path);
  if (request.url.path == '/api/agent-presets') {
    return http.Response(
      jsonEncode({
        'ok': true,
        'presets': [
          {'id': 'p1', 'name': '移动端体验设计师'},
          {'id': 'p2', 'name': '后端接口审查'},
        ],
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'id': 'p1',
      'name': '移动端体验设计师',
      'prompt': '以移动端体验设计师的视角检查交互。',
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// Air 那边只关心 `POST /api/air/tasks/:id/roles`：状态码和 code 由测试决定。
MockClient _airClient(
  List<String> requests,
  List<Map<String, dynamic>> bodies, {
  int status = 200,
  String code = '',
}) => MockClient((request) async {
  requests.add('${request.method} ${request.url.path}');
  bodies.add(
    request.body.isEmpty
        ? const {}
        : (jsonDecode(request.body) as Map).cast<String, dynamic>(),
  );
  if (status >= 400) {
    return http.Response(
      jsonEncode({'ok': false, 'code': code, 'message': code}),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'roleBindings': {'version': 3, 'bindings': bodies.last['bindings']},
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

void main() {
  setUp(AgentPresetService.clearCache);

  testWidgets('草稿模式：编辑结果交回调用方，不写任何任务', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];
    List<AirRoleBinding>? saved;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  saved = await showAirRoleEditor(
                    context,
                    settings: settings,
                    presetService: AgentPresetService(
                      settings: settings,
                      httpClient: _presetClient(requests),
                    ),
                    service: AirService(
                      settings: settings,
                      httpClient: _airClient(requests, bodies),
                    ),
                    initial: const [
                      AirRoleBinding(name: '原有角色', prompt: '按现有约定协作。'),
                    ],
                  );
                },
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-role-editor')), findsOneWidget);
    expect(find.text('创建任务时会写入这些角色，第一条消息即按此执行。'), findsOneWidget);
    expect(find.text('使用这些角色'), findsOneWidget);
    // 已经有一个角色了，行里是它的名字和说明。
    expect(
      find.widgetWithText(TextField, '按现有约定协作。'),
      findsOneWidget,
    );

    await tester.enterText(
      find.byKey(const ValueKey('air-role-name-0')),
      '性能审查',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-role-prompt-0')),
      '关注首屏与滚动性能。',
    );
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();

    expect(saved, isNotNull);
    expect(saved!.single.name, '性能审查');
    expect(saved!.single.prompt, '关注首屏与滚动性能。');
    // 任务还不存在，所以一个写请求都不该发出去。
    expect(requests.where((r) => r.startsWith('POST')), isEmpty);
    expect(bodies, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('已有任务：带上版本号和幂等键写回，并回调刷新', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];
    var refreshed = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(requests, bodies),
                  ),
                  taskId: 't1',
                  version: 2,
                  initial: const [],
                  onSaved: () async => refreshed++,
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    expect(find.text('保存角色'), findsOneWidget);
    expect(
      find.text('保存后对下一条新消息生效。正在执行和已经排队的消息保留原角色。'),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('air-role-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('air-role-name-0')), '代码审查');
    await tester.enterText(
      find.byKey(const ValueKey('air-role-prompt-0')),
      '只改必要的地方。',
    );
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();

    expect(requests, contains('POST /api/air/tasks/t1/roles'));
    expect(bodies.last['expectedVersion'], 2);
    expect(bodies.last['clientMsgId'], isA<String>());
    expect((bodies.last['bindings'] as List).single, {
      'name': '代码审查',
      'prompt': '只改必要的地方。',
    });
    expect(refreshed, 1);
    expect(find.byKey(const ValueKey('air-role-editor')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('幂等键只看内容：同样内容重试沿用旧 id，改了内容才换新的', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    // 第一次保存被挡下（版本冲突），编辑器留在原地。
                    httpClient: _airClient(
                      requests,
                      bodies,
                      status: 409,
                      code: 'role_version_conflict',
                    ),
                  ),
                  taskId: 't1',
                  version: 0,
                  initial: const [],
                  onSaved: () async {},
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-role-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('air-role-name-0')), 'A');
    await tester.enterText(find.byKey(const ValueKey('air-role-prompt-0')), 'B');
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();
    // 内容没动，再点一次是「重试同一次修改」，不能变成第二次修改。
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();
    // 改了内容，那才是另一次修改。
    await tester.enterText(find.byKey(const ValueKey('air-role-prompt-0')), 'C');
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();

    expect(bodies, hasLength(3));
    expect(bodies[1]['clientMsgId'], bodies[0]['clientMsgId']);
    expect(bodies[2]['clientMsgId'], isNot(bodies[0]['clientMsgId']));
    expect(tester.takeException(), isNull);
  });

  testWidgets('版本冲突说人话：让别人先关掉重开，而不是回一个错误码', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(
                      requests,
                      bodies,
                      status: 409,
                      code: 'role_version_conflict',
                    ),
                  ),
                  taskId: 't1',
                  version: 1,
                  initial: const [
                    AirRoleBinding(name: 'A', prompt: 'B'),
                  ],
                  onSaved: () async {},
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-role-error')), findsOneWidget);
    expect(find.text('角色已在其他页面更新，请关闭后重新打开。'), findsOneWidget);
    // 冲突不能顺手把编辑器的内容关掉，否则那些字就白打了。
    expect(find.byKey(const ValueKey('air-role-editor')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('名字或说明空着就不发请求，先说清楚缺什么', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(requests, bodies),
                  ),
                  taskId: 't1',
                  version: 0,
                  initial: const [],
                  onSaved: () async {},
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-role-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('air-role-name-0')), '只有名字');
    await tester.tap(find.byKey(const ValueKey('air-role-save')));
    await tester.pumpAndSettle();

    expect(find.text('每个角色都要有名称和说明。'), findsOneWidget);
    expect(bodies, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('从角色库附加一个：索引给名字，说明要再拉一次', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(requests, bodies),
                  ),
                  initial: const [],
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    expect(requests, contains('/api/agent-presets'));
    await tester.tap(find.byKey(const ValueKey('air-role-preset')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('移动端体验设计师').last);
    await tester.pumpAndSettle();

    // 说明是选中之后才拉的，索引里没有它。
    expect(requests, contains('/api/agent-presets/p1'));
    expect(
      find.widgetWithText(TextField, '以移动端体验设计师的视角检查交互。'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('最多 8 个角色，到了上限就给按钮换个说法', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];
    // 8 行在默认的 800×600 画布上装不下，ListView 不会构建看不见的那几行。
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(800, 2200);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(requests, bodies),
                  ),
                  initial: [
                    for (var i = 0; i < 8; i++)
                      AirRoleBinding(name: '角色$i', prompt: '说明$i'),
                  ],
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-role-row-7')), findsOneWidget);
    expect(find.text('最多 8 个角色'), findsOneWidget);
    expect(
      tester.widget<TextButton>(find.byKey(const ValueKey('air-role-add'))).onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('移除一个角色，剩下的行跟着往前挪', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final bodies = <Map<String, dynamic>>[];

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAirRoleEditor(
                  context,
                  settings: settings,
                  presetService: AgentPresetService(
                    settings: settings,
                    httpClient: _presetClient(requests),
                  ),
                  service: AirService(
                    settings: settings,
                    httpClient: _airClient(requests, bodies),
                  ),
                  initial: const [
                    AirRoleBinding(name: '第一个', prompt: '甲'),
                    AirRoleBinding(name: '第二个', prompt: '乙'),
                  ],
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-role-remove-0')));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(TextField, '第二个'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-role-row-1')), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
