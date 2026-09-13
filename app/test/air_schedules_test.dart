import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_schedules.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 下次运行 / 最近触发那两个时间用本地时区造的，断言的写法与机器时区无关。
final int _next = DateTime(2026, 9, 13, 8, 5).millisecondsSinceEpoch;
final int _last = DateTime(2026, 9, 12, 7, 1).millisecondsSinceEpoch;

/// 三条规则，三种处境：
///   c1 绑好了、还没跑过（enabled）· c2 停用了、最近一次成功 ·
///   c3 绑定坏了（没有 taskId）。
const List<Map<String, dynamic>> _rules = [
  {
    'id': 'c1',
    'name': '每日投放数据',
    'dirId': 'd1',
    'dirName': '工作目录 A',
    'cli': 'claude',
    'provider': 'anthropic',
    'model': 'claude-sonnet-5',
    'effort': 'high',
    'prompt': '整理昨天的投放数据，给出预算建议',
    'cron': '0 9 * * *',
    'enabled': true,
    'lastRunAt': null,
    'lastStatus': null,
    'lastError': '',
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
    'lastRunAt': null,
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
];

/// 带着 _next / _last 的那份规则表（时间得在上面的 const 之外补）。
List<Map<String, dynamic>> _rulesWithTimes() => [
  {..._rules[0], 'nextRunAt': _next},
  {..._rules[1], 'lastRunAt': _last},
  _rules[2],
];

class _Calls {
  final List<String> log = [];
  final List<Map<String, dynamic>> bodies = [];

  List<String> get paths =>
      log.map((entry) => entry.split(' ').last).toList(growable: false);
}

MockClient _client(
  _Calls calls, {
  List<Map<String, dynamic>>? rules,
  Map<String, dynamic>? runResult,
}) => MockClient((request) async {
  calls.log.add('${request.method} ${request.url.path}');
  if (request.body.isNotEmpty) {
    calls.bodies.add(
      (jsonDecode(request.body) as Map).cast<String, dynamic>(),
    );
  }
  Map<String, dynamic> json(Object body) =>
      body is List ? body as Map<String, dynamic> : body as Map<String, dynamic>;
  final path = request.url.path;
  if (path == '/api/cron' && request.method == 'GET') {
    return _ok(rules ?? _rulesWithTimes());
  }
  if (path == '/api/cron' && request.method == 'POST') {
    return _ok({..._rules[0], 'id': 'new'});
  }
  if (path.endsWith('/run')) {
    return _ok(runResult ?? {'ok': true, 'decision': 'delivered'});
  }
  if (request.method == 'PATCH') {
    return _ok({..._rules[0], ...json(_rules[0])});
  }
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

const List<AirDirectory> _directories = [
  AirDirectory(id: 'd1', name: '工作目录 A', path: '/p/a'),
  AirDirectory(id: 'd2', name: '工作目录 B', path: '/p/b'),
];

/// 一张卡两三百像素高，三张就顶出默认画布了；点击落在看不见的地方会静默落空。
void _tallCanvas(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(900, 2400);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _pump(
  WidgetTester tester,
  MockClient client, {
  void Function(String dirId, String taskId)? onOpenTask,
}) async {
  final settings = await _settings();
  await tester.pumpWidget(
    MaterialApp(
      home: AirSchedulesScreen(
        settings: settings,
        httpClient: client,
        directories: _directories,
        onOpenTask: onOpenTask,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// 让 SnackBar 自己走完，别把计时器留给下一个测试。
Future<void> _drain(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 5));
  await tester.pumpAndSettle();
}

CronTask _task({
  String? taskId,
  String cli = 'claude',
  String? lastStatus,
  String lastError = '',
  bool enabled = true,
  String provider = '',
  String model = '',
  String effort = '',
  int? nextRunAt,
  int? lastRunAt,
  String bindingError = '',
}) => CronTask(
  id: 'c1',
  name: '每日投放数据',
  dirId: 'd1',
  dirName: '工作目录 A',
  cli: cli,
  provider: provider.isEmpty ? null : provider,
  model: model.isEmpty ? null : model,
  effort: effort.isEmpty ? null : effort,
  prompt: 'p',
  cron: '0 9 * * *',
  enabled: enabled,
  lastStatus: lastStatus,
  lastError: lastError,
  nextRunAt: nextRunAt,
  lastRunAt: lastRunAt,
  taskId: taskId,
  taskBindingError: bindingError,
);

void main() {
  // 摘要里的「条」和状态行的字都得有词典；不加载就只有 key。
  setUpAll(() => I18n.init('zh'));

  group('卡片上的字', () {
    test('执行配置说的是固定任务那套配置，一样都没有才说跟随', () {
      expect(airScheduleRuntime(_task()), 'claude');
      expect(
        airScheduleRuntime(
          _task(provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high'),
        ),
        'claude · anthropic · claude-sonnet-5 · high',
      );
      expect(airScheduleRuntime(_task(cli: '')), '跟随任务配置');
    });

    test('时间：没有就说没有，不编一个 1970', () {
      expect(airScheduleTime(null), '—');
      expect(airScheduleTime(0), '—');
      expect(airScheduleTime(_next), '9/13 08:05');
    });

    test('上一次运行落在哪一步：queued / ok / error / 还没跑过', () {
      expect(airScheduleStateLabel(_task()), '等待首次运行');
      expect(
        airScheduleStateLabel(_task(lastStatus: 'queued')),
        '已进入固定任务队列',
      );
      expect(airScheduleStateLabel(_task(lastStatus: 'ok')), '最近一次已接收');
      expect(
        airScheduleStateLabel(_task(lastStatus: 'error', lastError: '发送失败')),
        '发送失败',
      );
      // 服务端没给原话时也得有话说。
      expect(
        airScheduleStateLabel(_task(lastStatus: 'error')),
        '最近一次运行失败',
      );
    });

    test('绑定行：有任务就报任务和配置，没绑定就说正在绑定，坏了就报坏在哪', () {
      expect(airScheduleFixedDetail(_task(taskId: 't1')), 't1 · claude');
      expect(
        airScheduleFixedDetail(_task()),
        '正在建立任务绑定',
      );
      expect(
        airScheduleFixedDetail(
          _task(taskId: 't1', bindingError: '固定任务绑定失败'),
        ),
        '固定任务绑定失败',
      );
    });

    test('要我去处理的条数：跑挂的和绑定坏的各算一条，重叠只算一次', () {
      expect(airScheduleIssues([_task(), _task(taskId: 't1')]), 0);
      expect(
        airScheduleIssues([
          _task(taskId: 't1', lastStatus: 'error'),
          _task(taskId: 't2', bindingError: '绑定失败', lastStatus: 'error'),
          _task(taskId: 't3', bindingError: '绑定失败'),
        ]),
        3,
      );
      expect(airScheduleHealth(0), '固定任务均正常');
      expect(airScheduleHealth(2), '2 条需处理');
    });
  });

  testWidgets('摘要说清几条规则、几条启用、几条要我去看', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    expect(calls.paths, ['/api/cron']);
    Finder summary(String text) => find.descendant(
      of: find.byKey(const ValueKey('air-schedules-summary')),
      matching: find.text(text),
    );
    expect(summary('3 条规则'), findsOneWidget);
    // c1 和 c3 开着，c2 停用。
    expect(summary('2 条启用'), findsOneWidget);
    // 只有 c3 要我去处理，而它「跑挂了」和「绑定坏了」是同一件事：算一条。
    expect(summary('1 条需处理'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('每条规则说清什么时候跑、跑进哪个任务、上一次结果', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    Finder inCard(String id, String text) => find.descendant(
      of: find.byKey(ValueKey('air-schedule-$id')),
      matching: find.text(text),
    );

    // c1：启用中，下次运行有值，还没跑过，绑定行报任务和它那套执行配置。
    expect(inCard('c1', '每日投放数据'), findsWidgets);
    expect(inCard('c1', '已启用'), findsOneWidget);
    expect(inCard('c1', '0 9 * * *'), findsOneWidget);
    expect(inCard('c1', '9/13 08:05'), findsOneWidget);
    expect(inCard('c1', '尚未运行'), findsOneWidget);
    expect(inCard('c1', '等待首次运行'), findsOneWidget);
    expect(inCard('c1', 't1 · claude · anthropic · claude-sonnet-5 · high'), findsOneWidget);
    expect(inCard('c1', '工作目录 A · 已触发 0 次'), findsOneWidget);
    expect(inCard('c1', '整理昨天的投放数据，给出预算建议'), findsOneWidget);

    // c2：停用了，下次运行就不报时间而是说实话「已暂停」，最近触发仍是真时间。
    expect(inCard('c2', '已停用'), findsOneWidget);
    expect(inCard('c2', '已暂停'), findsOneWidget);
    expect(inCard('c2', '9/12 07:01'), findsOneWidget);
    expect(inCard('c2', '最近一次已接收'), findsOneWidget);

    // c3：绑定坏了，坏在哪写在卡上，不是只留一个感叹号。
    expect(inCard('c3', '固定任务绑定失败'), findsOneWidget);
    expect(inCard('c3', '发送失败'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('点固定 Air 任务：带着它自己的目录和任务 id 出去', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    final opened = <String>[];
    await _pump(
      tester,
      client,
      onOpenTask: (dirId, taskId) => opened.add('$dirId/$taskId'),
    );

    await tester.tap(find.byKey(const ValueKey('air-schedule-task-c1')));
    await tester.pumpAndSettle();
    expect(opened, ['d1/t1']);

    // c3 还没绑上任务：没有可去的地方，点了也不该假装跳走。
    await tester.tap(
      find.byKey(const ValueKey('air-schedule-task-c3')),
      warnIfMissed: false,
    );
    await tester.pumpAndSettle();
    expect(opened, ['d1/t1']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('立即运行把指令送进固定任务，队列里排着就明说在排队', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls, runResult: {'ok': true, 'decision': 'queued'});
    await _pump(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedule-run-c1')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron/c1/run', '/api/cron']);
    expect(find.text('固定任务正在忙碌，本次执行已经排队。'), findsOneWidget);
    await _drain(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('暂停一条启用中的规则：PATCH 只带 enabled', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedule-toggle-c2')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron/c2', '/api/cron']);
    expect(calls.bodies.single, {'enabled': true});
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('删除先问一句，并且说清固定任务不会被删掉', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedule-delete-c3')));
    await tester.pumpAndSettle();
    expect(find.text('删除这条定时规则？固定 Air 任务及其历史会继续保留。'), findsOneWidget);
    // 先取消：什么都不该发生。
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron']);

    await tester.tap(find.byKey(const ValueKey('air-schedule-delete-c3')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('air-schedule-delete-confirm')),
    );
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron/c3', '/api/cron']);
    expect(find.text('定时规则已删除；固定 Air 任务和历史没有删除。'), findsOneWidget);
    await _drain(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('编辑已绑定的规则：工作目录和 CLI 归任务管，这里锁着', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedule-edit-c1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-schedule-editor')), findsOneWidget);
    expect(find.text('编辑定时规则'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-schedule-fixed-note')), findsOneWidget);
    // 两个下拉都点不动 —— 归属已经不在规则这里了。
    final dir = tester.widget<DropdownButtonFormField<String>>(
      find.byKey(const ValueKey('air-schedule-dir')),
    );
    final cli = tester.widget<DropdownButtonFormField<String>>(
      find.byKey(const ValueKey('air-schedule-cli')),
    );
    expect(dir.onChanged, isNull);
    expect(cli.onChanged, isNull);

    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-cron')),
      '0 8 * * *',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-schedule-save')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron/c1', '/api/cron']);
    // 归属那两样一个字都不许发出去。
    expect(calls.bodies.single, {
      'name': '每日投放数据',
      'prompt': '整理昨天的投放数据，给出预算建议',
      'cron': '0 8 * * *',
      'enabled': true,
    });
    expect(find.text('定时规则已更新；固定任务和历史保持不变。'), findsOneWidget);
    await _drain(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('新建规则：填完就发，cron 段数不对先拦下', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    await tester.tap(find.byKey(const ValueKey('air-schedules-new')));
    await tester.pumpAndSettle();
    final title = tester.widget<Text>(
      find.byKey(const ValueKey('air-schedule-editor-title')),
    );
    expect(title.data, '新建定时任务');
    expect(find.text('创建并绑定任务'), findsOneWidget);

    // 名字空着就不发请求，先在表单里说清楚。
    await tester.tap(find.byKey(const ValueKey('air-schedule-save')));
    await tester.pumpAndSettle();
    expect(find.text('任务名不能为空'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-name')),
      '夜间巡检',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-cron')),
      '0 3 * *',
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-schedule-prompt')),
      '检查一遍线上日志',
    );
    await tester.tap(find.byKey(const ValueKey('air-schedule-save')));
    await tester.pumpAndSettle();
    expect(find.text('cron 表达式无效（需 5 段：分 时 日 月 周）'), findsOneWidget);

    // 常用时间一点就填进去，省得手打。
    await tester.tap(
      find.byKey(const ValueKey('air-schedule-preset-0 * * * *')),
    );
    await tester.pumpAndSettle();
    final cron = tester.widget<TextField>(
      find.byKey(const ValueKey('air-schedule-cron')),
    );
    expect(cron.controller?.text, '0 * * * *');

    await tester.tap(find.byKey(const ValueKey('air-schedule-save')));
    await tester.pumpAndSettle();
    expect(calls.paths, ['/api/cron', '/api/cron', '/api/cron']);
    expect(calls.bodies.single, {
      'name': '夜间巡检',
      'dirId': 'd1',
      'prompt': '检查一遍线上日志',
      'cron': '0 * * * *',
      'cli': 'claude',
      'enabled': true,
      'createdBy': 'app',
    });
    expect(find.text('定时任务已创建，并绑定到唯一的 Air 任务。'), findsOneWidget);
    await _drain(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('一条规则都没有时，说的是没有规则和新建会发生什么', (tester) async {
    _tallCanvas(tester);
    final calls = _Calls();
    final client = _client(calls, rules: const []);
    await _pump(tester, client);

    expect(find.text('0 条规则'), findsOneWidget);
    expect(find.text('固定任务均正常'), findsOneWidget);
    expect(find.text('还没有定时任务'), findsOneWidget);
    expect(
      find.text('新建规则时会同时创建一个固定 Air 任务，后续运行都在该任务中继续。'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('读不到就直说是读不到，不摆一张空规则表', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = MockClient(
      (request) async => http.Response('nope', 500),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: AirSchedulesScreen(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-schedules-error')), findsOneWidget);
    expect(find.textContaining('定时任务读取失败'), findsOneWidget);
    expect(find.text('还没有定时任务'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('320px 上排得下：摘要、三段时间和四个动作都不横向溢出', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 1800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final calls = _Calls();
    final client = _client(calls);
    await _pump(tester, client);

    expect(tester.takeException(), isNull);
    expect(
      find.byKey(const ValueKey('air-schedules-summary')),
      findsOneWidget,
    );
    // 动作按钮横向排不下就换行，四个都在。
    for (final action in ['run', 'toggle', 'edit', 'delete']) {
      expect(
        find.byKey(ValueKey('air-schedule-$action-c1')),
        findsOneWidget,
      );
    }
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
