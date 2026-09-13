import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_new_task_dialog.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 「新任务」对话框（Web `air.html:252-262` 的 `#new-task-dialog`）。
///
/// 这里盯的是两件事：
/// ① 四个字段都在，且**建在哪**这个目录是只读显示的（对话框没有选目录的控件）；
/// ② 交出去的请求体跟 Web 一样 —— 空的 model / rolePrompt 不发（Web 那句
///    `if (!values.model) delete values.model`），因为空串会把目录默认值顶掉。
Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 记下每一个写请求的路径与请求体。
MockClient _client(List<Map<String, dynamic>> posts) => MockClient((
  request,
) async {
  if (request.method == 'POST') {
    posts.add({
      'path': request.url.path,
      'body': jsonDecode(request.body) as Map<String, dynamic>,
    });
  }
  return http.Response(
    jsonEncode({'ok': true, 'taskId': 'task-new-1'}),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// 从一颗按钮进真对话框，把返回值交给测试。
Widget _host({
  required SettingsService settings,
  required AirService service,
  required void Function(String?) onClosed,
  List<String> clis = const ['claude', 'codex'],
}) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: ElevatedButton(
          key: const ValueKey('open'),
          onPressed: () async {
            onClosed(
              await showAirNewTaskDialog(
                context,
                directory: const AirDirectory(
                  id: 'd1',
                  name: '工作目录 A',
                  path: '/project/a',
                ),
                clis: clis,
                settings: settings,
                service: service,
              ),
            );
          },
          child: const Text('打开'),
        ),
      ),
    ),
  ),
);

Future<void> _open(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('open')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('四个字段都在，目录是只读显示的，角色区默认收起', (tester) async {
    final settings = await _settings();
    final posts = <Map<String, dynamic>>[];
    final service = AirService(settings: settings, httpClient: _client(posts));

    await tester.pumpWidget(
      _host(settings: settings, service: service, onClosed: (_) {}),
    );
    await _open(tester);

    expect(find.text('新任务'), findsOneWidget);
    expect(find.text('NEW TASK'), findsOneWidget);
    // 建在哪个目录：Web 的 `#create-directory`。它只是一句话，不是选择器。
    expect(find.text('/project/a'), findsOneWidget);
    expect(find.text('任务名称'), findsOneWidget);
    expect(find.text('AI 工具'), findsOneWidget);
    expect(find.text('模型（可选）'), findsOneWidget);
    expect(find.text('角色上下文（可选）'), findsOneWidget);
    // 角色说明在折叠层里 —— 没展开就不该有那个输入框（Web 那边是 <details>）。
    expect(find.byKey(const ValueKey('air-new-task-role')), findsNothing);
    expect(find.byKey(const ValueKey('air-new-task-title')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('提交把四个字段一起交出去，成功后回传 taskId', (tester) async {
    final settings = await _settings();
    final posts = <Map<String, dynamic>>[];
    final service = AirService(settings: settings, httpClient: _client(posts));
    String? closed;

    await tester.pumpWidget(
      _host(settings: settings, service: service, onClosed: (v) => closed = v),
    );
    await _open(tester);

    await tester.enterText(
      find.byKey(const ValueKey('air-new-task-title')),
      '  完善登录页面  ',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-new-task-model')),
      'claude-sonnet-5',
    );
    await tester.tap(find.byKey(const ValueKey('air-new-task-role-header')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('air-new-task-role')),
      '以移动端体验设计师的视角检查交互',
    );

    // AI 工具：默认落在 clis 的第一条上（Web 的 <option> 第一项即默认值）。
    await tester.tap(find.byKey(const ValueKey('air-new-task-cli')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('codex').last);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-new-task-submit')));
    await tester.pumpAndSettle();

    expect(posts, hasLength(1));
    expect(posts.single['path'], '/api/air/tasks');
    final body = posts.single['body']!;
    expect(body['dirId'], 'd1');
    expect(body['title'], '完善登录页面', reason: '首尾空白要去掉');
    expect(body['cli'], 'codex');
    expect(body['model'], 'claude-sonnet-5');
    expect(body['rolePrompt'], '以移动端体验设计师的视角检查交互');
    expect((body['clientMsgId'] as String).isNotEmpty, isTrue);
    expect(closed, 'task-new-1');
  });

  testWidgets('空的模型与角色说明不发 —— 传空串会把目录默认值顶掉', (tester) async {
    final settings = await _settings();
    final posts = <Map<String, dynamic>>[];
    final service = AirService(settings: settings, httpClient: _client(posts));

    await tester.pumpWidget(
      _host(settings: settings, service: service, onClosed: (_) {}),
    );
    await _open(tester);
    await tester.tap(find.byKey(const ValueKey('air-new-task-role-header')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('air-new-task-title')),
      '只给个名字',
    );
    await tester.tap(find.byKey(const ValueKey('air-new-task-submit')));
    await tester.pumpAndSettle();

    final body = posts.single['body']!;
    expect(body.containsKey('model'), isFalse);
    expect(body.containsKey('rolePrompt'), isFalse);
    expect(body['cli'], 'claude', reason: '没动下拉就是第一条');
  });

  testWidgets('没起名字就点创建：就地报错，一个请求都不发', (tester) async {
    final settings = await _settings();
    final posts = <Map<String, dynamic>>[];
    final service = AirService(settings: settings, httpClient: _client(posts));

    await tester.pumpWidget(
      _host(settings: settings, service: service, onClosed: (_) {}),
    );
    await _open(tester);
    await tester.tap(find.byKey(const ValueKey('air-new-task-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-new-task-error')), findsOneWidget);
    expect(find.text('请先给任务起个名字。'), findsOneWidget);
    expect(posts, isEmpty);
    // 对话框自己留着，用户改完还能接着提交。
    expect(find.byKey(const ValueKey('air-new-task-title')), findsOneWidget);
  });

  testWidgets('一个 CLI 都不给时退化成一句说明，不给空下拉', (tester) async {
    final settings = await _settings();
    final service = AirService(
      settings: settings,
      httpClient: _client(<Map<String, dynamic>>[]),
    );

    await tester.pumpWidget(
      _host(
        settings: settings,
        service: service,
        onClosed: (_) {},
        clis: const [],
      ),
    );
    await _open(tester);

    expect(find.byKey(const ValueKey('air-new-task-cli')), findsNothing);
    expect(
      find.text('暂时读不到可用的 AI 工具，创建时会用目录的默认值。'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('取消就把对话框收回去，什么都不创建', (tester) async {
    final settings = await _settings();
    final posts = <Map<String, dynamic>>[];
    final service = AirService(settings: settings, httpClient: _client(posts));
    String? closed = '没被回调过';

    await tester.pumpWidget(
      _host(settings: settings, service: service, onClosed: (v) => closed = v),
    );
    await _open(tester);
    await tester.tap(find.byKey(const ValueKey('air-new-task-close')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-new-task-title')), findsNothing);
    expect(closed, isNull);
    expect(posts, isEmpty);
  });
}
