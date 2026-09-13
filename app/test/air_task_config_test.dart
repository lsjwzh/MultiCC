import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_config.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 线路面板要的那一份 Provider 池。其余请求（模型清单那些预热）给一个空壳就行
/// —— 面板那边本来就用 try/catch 兜着，拉不到就退回内置表。
MockClient _providerClient(
  List<String> requests,
  List<Map<String, dynamic>> providers,
) => MockClient((request) async {
  requests.add('${request.method} ${request.url.path}');
  if (request.url.path.startsWith('/api/providers')) {
    return http.Response(
      jsonEncode({'ok': true, 'providers': providers}),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({'ok': true}),
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

/// 从一颗「打开」按钮进真面板，把结果交给测试 —— 和调用点（输入区那颗药丸）
/// 走同一条路径，都只带一份当前线路。
Widget _editorHost({
  required SettingsService settings,
  required AirTaskRuntime initial,
  required void Function(AirTaskRuntime?) onPicked,
  http.Client? httpClient,
}) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: ElevatedButton(
          key: const ValueKey('open'),
          onPressed: () async {
            onPicked(
              await showAirTaskRuntimeEditor(
                context,
                settings: settings,
                httpClient: httpClient,
                initial: initial,
              ),
            );
          },
          child: const Text('打开'),
        ),
      ),
    ),
  ),
);

void main() {
  group('线路这一份选择', () {
    test('手选线路时药丸写「名字 · 模型」，整句仍是 CLI · 线路 · 模型', () {
      const runtime = AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        providerName: '火山方舟',
        model: 'claude-sonnet-5',
      );
      expect(runtime.routeLabel, '火山方舟 · claude-sonnet-5');
      expect(runtime.summary, 'claude · 火山方舟 · claude-sonnet-5');
    });

    test('Auto 池子报协议名，池子里的模型跟着第一条线路', () {
      final runtime = AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        model: 'm1',
        providerSelection: SessionProviderSelection(
          protocol: 'anthropic',
          candidates: const [
            SessionProviderCandidate(providerId: 'p1', model: 'm1', priority: 1),
            SessionProviderCandidate(providerId: 'p2', model: 'm2', priority: 2),
          ],
          maxAttempts: 2,
        ),
      );
      expect(runtime.isAuto, isTrue);
      expect(runtime.routeLabel, 'Auto Anthropic · m1');
    });

    test('什么都没选就说默认，不把空字符串当成一个选择', () {
      const runtime = AirTaskRuntime(cli: 'codex');
      expect(runtime.routeLabel, '默认线路 · 默认模型');
      expect(runtime.summary, 'codex · 默认线路 · 默认模型');
    });

    test('创建请求里空字段不发 —— 传空串会把目录默认值顶掉', () {
      expect(const AirTaskRuntime(cli: 'claude').toCreateBody(), {
        'cli': 'claude',
      });
      expect(
        const AirTaskRuntime(
          cli: 'claude',
          provider: 'p1',
          model: 'm1',
          effort: 'high',
        ).toCreateBody(),
        {'cli': 'claude', 'provider': 'p1', 'model': 'm1', 'effort': 'high'},
      );
    });

    test('Auto 要连候选池一起发下去，不能只发解析出来的那一条', () {
      final body = AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        model: 'm1',
        providerSelection: SessionProviderSelection(
          protocol: 'anthropic',
          candidates: const [
            SessionProviderCandidate(providerId: 'p1', model: 'm1', priority: 1),
            SessionProviderCandidate(providerId: 'p2', priority: 2),
          ],
          maxAttempts: 2,
        ),
      ).toCreateBody();
      expect(body['provider'], 'p1');
      expect((body['providerSelection'] as Map)['protocol'], 'anthropic');
      expect(
        ((body['providerSelection'] as Map)['candidates'] as List).length,
        2,
      );
    });

    test('换 CLI 等于换了一整池 Provider 和模型，旧的线路不能带过去', () {
      const runtime = AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        providerName: '火山方舟',
        model: 'claude-sonnet-5',
        effort: 'high',
      );
      final switched = runtime.withCli('codex');
      expect(switched.cli, 'codex');
      expect(switched.provider, isEmpty);
      expect(switched.model, isEmpty);
      expect(switched.effort, isEmpty);
      // 同一个 CLI 再点一次不算换，原样返回。
      expect(identical(runtime.withCli('claude'), runtime), isTrue);
    });
  });

  testWidgets('草稿模式：线路先留在输入区，药丸上写得出来，提交时一起交出去', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    AirTaskRuntime? submitted;
    String? submittedText;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirQuickComposer(
            settings: settings,
            httpClient: _providerClient(requests, const [
              {'id': 'p1', 'name': '火山方舟', 'protocol': 'anthropic'},
            ]),
            clis: const ['claude'],
            busy: false,
            onSubmit: ({
              required String text,
              required String cli,
              required AirTaskRuntime runtime,
              required List<AirRoleBinding> roles,
              required bool goal,
            }) async {
              submittedText = text;
              submitted = runtime;
              return true;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 还没挑过：药丸说的是「按目录默认走」。
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-quick-ai')),
        matching: find.text('默认线路 · 默认模型'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('air-quick-ai')));
    await tester.pumpAndSettle();

    // 面板开在这颗药丸说的那个 CLI 上，Provider 池是现拉的。
    expect(requests, contains('GET /api/providers'));
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('火山方舟').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    // 挑完先留在输入区 —— 任务还不存在，写请求一个都不该发出去。
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-quick-ai')),
        matching: find.text('火山方舟 · 默认模型'),
      ),
      findsOneWidget,
    );
    expect(requests.where((r) => r.contains('/api/air/tasks')), isEmpty);

    await tester.enterText(
      find.byKey(const ValueKey('air-quick-input')),
      '把登录页的错误提示改清楚',
    );
    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    await tester.pumpAndSettle();

    expect(submittedText, '把登录页的错误提示改清楚');
    expect(submitted!.provider, 'p1');
    expect(submitted!.providerName, '火山方舟');
    // 没动过推理强度，就带上这个 CLI 的默认值 —— 面板里显示的也是它。
    expect(submitted!.effort, 'medium');
    expect(submitted!.toCreateBody()['provider'], 'p1');
    expect(tester.takeException(), isNull);
  });

  testWidgets('面板上取消，药丸还是原来那句话', (tester) async {
    final settings = await _settings();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirQuickComposer(
            settings: settings,
            httpClient: _providerClient(<String>[], const []),
            clis: const ['claude'],
            busy: false,
            onSubmit: ({
              required String text,
              required String cli,
              required AirTaskRuntime runtime,
              required List<AirRoleBinding> roles,
              required bool goal,
            }) async => true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-quick-ai')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-quick-ai')),
        matching: find.text('默认线路 · 默认模型'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Auto 池子：药丸报协议名，任务记录存池子里第一条真正执行的线路', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    AirTaskRuntime? picked;
    // Auto 那一段把面板撑得比默认的 800×600 还高，保存按钮会被挤到画布外面。
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(800, 1600);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final initial = AirTaskRuntime(
      cli: 'claude',
      providerSelection: SessionProviderSelection(
        protocol: 'anthropic',
        candidates: const [
          SessionProviderCandidate(providerId: 'p1', model: 'm1', priority: 1),
          SessionProviderCandidate(providerId: 'p2', model: 'm2', priority: 2),
        ],
        maxAttempts: 2,
      ),
    );

    await tester.pumpWidget(
      _editorHost(
        settings: settings,
        initial: initial,
        httpClient: _providerClient(requests, const [
          {'id': 'p1', 'name': 'A 家', 'protocol': 'anthropic'},
          {'id': 'p2', 'name': 'B 家', 'protocol': 'anthropic'},
        ]),
        onPicked: (value) => picked = value,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(picked, isNotNull);
    expect(picked!.isAuto, isTrue);
    // 药丸报协议名，任务记录存第一条 —— 两者说的必须是同一条线路。
    expect(picked!.routeLabel, 'Auto Anthropic · m1');
    expect(picked!.provider, 'p1');
    expect(picked!.model, 'm1');
    expect(picked!.toCreateBody()['provider'], 'p1');
    expect(tester.takeException(), isNull);
  });

  testWidgets('创建请求把线路一起带上，不是建完任务再补', (tester) async {
    final settings = await _settings();
    final bodies = <Map<String, dynamic>>[];
    final client = MockClient((request) async {
      bodies.add((jsonDecode(request.body) as Map).cast<String, dynamic>());
      return http.Response(
        jsonEncode({'ok': true, 'taskId': 't1'}),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final service = AirService(settings: settings, httpClient: client);

    await service.createTask(
      dirId: 'd1',
      title: '登录页面',
      clientMsgId: 'c1',
      cli: 'claude',
      runtime: const AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        model: 'm1',
        effort: 'high',
      ).toCreateBody(),
    );

    expect(bodies.single, {
      'dirId': 'd1',
      'title': '登录页面',
      'clientMsgId': 'c1',
      'cli': 'claude',
      'provider': 'p1',
      'model': 'm1',
      'effort': 'high',
    });
    client.close();
  });

  test('子任务尾巴：模型为空就是没设，不为空才跟着任务一起发下去', () {
    // 没设过尾巴 —— 一个字段都不多发。
    expect(
      const AirTaskRuntime(cli: 'claude', provider: 'p1', model: 'm1').toCreateBody(),
      {'cli': 'claude', 'provider': 'p1', 'model': 'm1'},
    );
    // 只挑了线路没挑模型 = 没设：空壳也不发，否则服务端会当成「设了」拒掉。
    expect(
      const AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        model: 'm1',
        subagent: SessionSubagent(providerId: 'p2'),
      ).toCreateBody().containsKey('subagent'),
      isFalse,
    );
    expect(
      const AirTaskRuntime(
        cli: 'claude',
        provider: 'p1',
        model: 'm1',
        subagent: SessionSubagent(providerId: 'p2', model: 'm2'),
      ).toCreateBody()['subagent'],
      {'providerId': 'p2', 'model': 'm2'},
    );
  });

  testWidgets('子任务尾巴：面板上读得回来，也交得回去', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    AirTaskRuntime? picked;
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(800, 1400);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _editorHost(
        settings: settings,
        initial: const AirTaskRuntime(
          cli: 'claude',
          provider: 'p1',
          model: 'm1',
          subagent: SessionSubagent(providerId: 'p2', model: 'm2'),
        ),
        httpClient: _providerClient(requests, const [
          {'id': 'p1', 'name': 'A 家', 'protocol': 'anthropic'},
          {
            'id': 'p2',
            'name': 'B 家',
            'protocol': 'anthropic',
            'model': 'm2',
            'modelOptions': ['m2'],
          },
        ]),
        onPicked: (value) => picked = value,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pumpAndSettle();

    // 存过的子任务线路要显示回来，否则再打开面板存一次就把它清掉了。
    expect(
      find.descendant(
        of: find.byKey(const Key('subagent-provider')),
        matching: find.text('B 家 · m2'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(picked!.subagent?.providerId, 'p2');
    expect(picked!.subagent?.model, 'm2');
    expect(picked!.toCreateBody()['subagent'], {
      'providerId': 'p2',
      'model': 'm2',
    });
    expect(tester.takeException(), isNull);
  });
}
