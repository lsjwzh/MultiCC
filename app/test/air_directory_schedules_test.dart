import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_directory_schedules.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 目录首页那颗「定时任务」开的底部弹层。
///
/// 它和全局定时任务中心是**同一个** [AirSchedulePanel]（那边那套字、卡片、动作、
/// 编辑器都另有一份测试在守着），所以这里只测这一层多出来的四件事：
///   1. 只列**这个**目录的规则（过滤在客户端做，不为它多打一次接口）；
///   2. 一条都没有时说的是「这个目录」还没有，不是全局那句；
///   3. 动作的结果说在弹层自己那一行 —— SnackBar 会落在弹层背后，等于没说；
///   4. 头脚钉住、中间那张清单自己滚（手机上拇指不用先滚到底才够得着按钮）。
///
/// 四条规则，三种处境：c1 绑好了 · c2 在**别的**目录 · c3 绑定坏了 · c4 刚建好还没跑。
/// c2 是这里的关键：它必须只出现在全局那张表上。
const List<Map<String, dynamic>> _rules = [
  {
    'id': 'c1',
    'name': '每日投放数据',
    'dirId': 'd1',
    'dirName': '工作目录 A',
    'cli': 'claude',
    'prompt': '整理昨天的投放数据，给出预算建议',
    'cron': '0 9 * * *',
    'enabled': true,
    'runCount': 0,
    'taskId': 't1',
    'taskTitle': '每日投放数据',
    'taskBindingError': '',
  },
  {
    'id': 'c2',
    'name': '每周复盘',
    'dirId': 'd2',
    'dirName': '工作目录 B',
    'cli': 'codex',
    'prompt': '写一份周报',
    'cron': '0 9 * * 1',
    'enabled': false,
    'lastStatus': 'ok',
    'runCount': 3,
    'taskId': 't2',
    'taskTitle': '每周复盘',
    'taskBindingError': '',
  },
  {
    'id': 'c3',
    'name': '坏掉的规则',
    'dirId': 'd1',
    'dirName': '工作目录 A',
    'cli': 'claude',
    'prompt': '做点什么',
    'cron': '0 3 * * *',
    'enabled': true,
    'lastStatus': 'error',
    'lastError': '发送失败',
    'runCount': 1,
    'taskId': null,
    'taskBindingError': '固定任务绑定失败',
  },
  {
    'id': 'c4',
    'name': '周报归档',
    'dirId': 'd1',
    'dirName': '工作目录 A',
    'cli': 'claude',
    'prompt': '把本周周报归档',
    'cron': '0 20 * * 5',
    'enabled': true,
    'runCount': 0,
    'taskId': 't4',
    'taskTitle': '周报归档',
    'taskBindingError': '',
  },
];

const List<AirDirectory> _directories = [
  AirDirectory(id: 'd1', name: '工作目录 A', path: '/p/a'),
  AirDirectory(id: 'd2', name: '工作目录 B', path: '/p/b'),
  AirDirectory(id: 'd3', name: '空目录', path: '/p/empty'),
];

const AirDirectory _dirA = AirDirectory(
  id: 'd1',
  name: '工作目录 A',
  path: '/p/a',
);
const AirDirectory _dirEmpty = AirDirectory(
  id: 'd3',
  name: '空目录',
  path: '/p/empty',
);

class _Calls {
  final List<String> log = [];
  final List<Map<String, dynamic>> bodies = [];

  List<String> get paths =>
      log.map((entry) => entry.split(' ').last).toList(growable: false);
}

MockClient _client(_Calls calls) => MockClient((request) async {
  calls.log.add('${request.method} ${request.url.path}');
  if (request.body.isNotEmpty) {
    calls.bodies.add((jsonDecode(request.body) as Map).cast<String, dynamic>());
  }
  final path = request.url.path;
  if (path == '/api/cron' && request.method == 'GET') {
    return _ok(_rules);
  }
  if (path == '/api/cron' && request.method == 'POST') {
    return _ok({..._rules[0], 'id': 'new', 'taskId': 't9'});
  }
  if (path.endsWith('/run')) {
    return _ok({'ok': true, 'decision': 'delivered'});
  }
  if (request.method == 'PATCH') return _ok(_rules[0]);
  if (request.method == 'DELETE') return _ok({'ok': true});
  return http.Response('not found', 404);
});

http.Response _ok(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 一张卡两三百像素高，三张就顶出默认画布了；点击落在看不见的地方会静默落空。
void _tallCanvas(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(900, 2400);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// 从目录首页那颗入口打开这层弹层 —— 生产上就是这条路径（[showAirDirectorySchedules]）。
Future<void> _openSheet(
  WidgetTester tester,
  MockClient client, {
  AirDirectory directory = _dirA,
  List<String>? opened,
  List<String>? openedAll,
}) async {
  final settings = await _settings();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: ElevatedButton(
              key: const ValueKey('open-dir-schedules'),
              onPressed: () => showAirDirectorySchedules(
                context,
                directory: directory,
                settings: settings,
                directories: _directories,
                httpClient: client,
                onOpenTask: (dirId, taskId) => opened?.add('$dirId/$taskId'),
                onOpenAll: () => openedAll?.add('all'),
              ),
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('open-dir-schedules')));
  await tester.pumpAndSettle();
}

/// 弹层自己那一行状态。键就挂在那个 Text 上，所以读它本身而不是往下找。
String? _statusLine(WidgetTester tester) => tester
    .widget<Text>(find.byKey(const ValueKey('air-dir-schedule-status')))
    .data;

void main() {
  setUpAll(() => I18n.init('zh'));

  testWidgets('只列本目录的规则，别的目录一条都不进来', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _openSheet(tester, client);

    expect(find.text('工作目录 A 的定时任务'), findsOneWidget);
    // d1 的三条在，d2 那条不在 —— 过滤是这一层唯一多做的事。
    for (final id in ['c1', 'c3', 'c4']) {
      expect(find.byKey(ValueKey('air-schedule-$id')), findsOneWidget);
    }
    expect(find.byKey(const ValueKey('air-schedule-c2')), findsNothing);

    // 摘要是这**一列**的账：3 条规则、3 条启用、1 条要处理。
    expect(find.text('3 条规则'), findsOneWidget);
    expect(find.text('3 条启用'), findsOneWidget);
    expect(find.text('1 条需处理'), findsOneWidget);
    expect(find.text('4 条规则'), findsNothing);

    // 过滤在客户端做：不为一个目录多打一次接口。
    expect(calls.paths, ['/api/cron']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('这个目录一条都没有，说的就是「这个目录」还没有', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _openSheet(tester, client, directory: _dirEmpty);

    expect(find.text('空目录 的定时任务'), findsOneWidget);
    expect(find.text('这个目录还没有定时任务'), findsOneWidget);
    // 全局那句在这里是不对的：别的目录有规则，只是不归这一页管。
    expect(find.text('还没有定时任务'), findsNothing);
    expect(find.text('0 条规则'), findsOneWidget);
    expect(find.text('固定任务均正常'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('立即运行的结果说在弹层自己那一行，不在背后的 SnackBar', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _openSheet(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedule-run-c1')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron/c1/run', '/api/cron']);
    expect(_statusLine(tester), '执行指令已经送入固定 Air 任务。');
    // 这句话不能走 SnackBar：它落在弹层背后，用户看不到。
    expect(find.byType(SnackBar), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('在这儿新建：目录已经替用户选好，建完那句话也在这层', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _openSheet(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-dir-schedule-new')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-schedule-editor')), findsOneWidget);
    expect(find.text('新建定时任务'), findsWidgets);
    expect(
      tester
          .widget<DropdownButtonFormField<String>>(
            find.byKey(const ValueKey('air-schedule-dir')),
          )
          .initialValue,
      'd1',
    );

    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-name')),
      '月度结算',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-cron')),
      '0 4 1 * *',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-prompt')),
      '结算上个月的费用',
    );
    await tester.tap(find.byKey(const ValueKey('air-schedule-save')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron', '/api/cron']);
    expect(calls.bodies.single['dirId'], 'd1');
    expect(_statusLine(tester), '定时任务已创建，并绑定到唯一的 Air 任务。');
    expect(find.byType(SnackBar), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('点固定任务：先收掉这层，再把目录和任务 id 带出去', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    final opened = <String>[];
    await _openSheet(tester, client, opened: opened);

    await tester.tap(find.byKey(const ValueKey('air-schedule-task-c1')));
    await tester.pumpAndSettle();
    expect(opened, ['d1/t1']);
    // 人已经进那条任务了，板子不能压在聊天页上面。
    expect(find.byKey(const ValueKey('air-dir-schedule-title')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('全部定时任务：收掉这层，把人送回全局那张表', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    final openedAll = <String>[];
    await _openSheet(tester, client, openedAll: openedAll);

    await tester.tap(find.byKey(const ValueKey('air-dir-schedule-center')));
    await tester.pumpAndSettle();
    expect(openedAll, ['all']);
    expect(find.byKey(const ValueKey('air-dir-schedule-title')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('手机上：头脚钉住不动，滚的是中间那张清单', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final calls = _Calls();
    final client = _client(calls);
    await _openSheet(tester, client);

    // 从底部升起来，不是居中一个框：贴着屏幕下沿，上头留着背后那一页。
    final sheet = tester.getRect(find.byKey(const ValueKey('air-dir-schedule-title')));
    expect(sheet.left, lessThan(40));
    expect(sheet.top, greaterThan(844 * 0.08));

    // 头和脚都在屏幕上（脚上的「新建」是这一层的主要动作，拇指够得着）。
    final foot = tester.getRect(
      find.byKey(const ValueKey('air-dir-schedule-new')),
    );
    expect(foot.bottom, lessThanOrEqualTo(844));
    expect(foot.top, greaterThan(0));

    // 滚一下：清单往上走，脚一动不动。
    final cardBefore = tester.getTopLeft(
      find.byKey(const ValueKey('air-schedule-c1')),
    );
    await tester.drag(
      find.byKey(const ValueKey('air-schedule-c1')),
      const Offset(0, -260),
    );
    await tester.pumpAndSettle();
    final cardAfter = tester.getTopLeft(
      find.byKey(const ValueKey('air-schedule-c1')),
    );
    expect(cardAfter.dy, lessThan(cardBefore.dy));
    expect(
      tester.getRect(find.byKey(const ValueKey('air-dir-schedule-new'))),
      foot,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
