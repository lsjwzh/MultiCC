import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 创建与第一条消息这两个请求体 —— 它们是最不应该出错、出错又最不容易被发现
/// 的地方：字段名写错不会报错，只会被服务端静默丢掉，界面上看着一切正常。
///
/// 这一组测试就是钉住那几个键名：
/// * `createTask` 的空字段不发（Web `air.js:1584-1585`）；
/// * `sendFirstMessage` 的 Goal 上限叫 `maxRounds` / `maxBudget`
///   （`src/chat/turn-request.js:51-58` 的 `normalizeGoalLimits`），不是
///   `rounds` / `tokenBudget`。
Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

List<Map<String, dynamic>> _sink() => <Map<String, dynamic>>[];

AirService _service(
  SettingsService settings,
  List<Map<String, dynamic>> posts,
) => AirService(
  settings: settings,
  httpClient: MockClient((request) async {
    if (request.method == 'POST') {
      posts.add({
        'path': request.url.path,
        'body': jsonDecode(request.body) as Map<String, dynamic>,
      });
    }
    return http.Response(
      jsonEncode({'ok': true, 'taskId': 't1'}),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }),
);

void main() {
  group('renameTask', () {
    test('任务标题写入任务身份端点，任务 id 会安全编码', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).renameTask('a/b', '手动标题');
      expect(posts.single, {
        'path': '/api/task-board/tasks/a%2Fb/title',
        'body': {'title': '手动标题'},
      });
    });
  });

  group('reclaimWorktrees', () {
    test('默认只带 dirId：不过阈值就不该替用户做「连最近用过的也收」的决定', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).reclaimWorktrees('d1');
      expect(posts.single, {
        'path': '/api/air/worktrees/reclaim',
        'body': {'dirId': 'd1'},
      });
    });

    test('force 只在用户点头之后才出现（Web air-worktrees.js 同一条）', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).reclaimWorktrees('d1', force: true);
      expect(posts.single['body'], {'dirId': 'd1', 'force': true});
    });
  });

  group('worktree 生命周期 DTO', () {
    test('三个数分开读，本地 = resident + retained（服务端已经算好）', () {
      final directory = AirDirectory.fromJson({
        'id': 'd1',
        'name': '仓库',
        'path': '/tmp/repo',
        'worktreeCount': 12,
        'worktreeLifecycle': {
          'resident': 2,
          'retained': 1,
          'hibernated': 8,
          'planned': 1,
          'leased': 3,
          'onDisk': 3,
          'total': 12,
        },
      });
      final life = directory.worktreeLifecycle!;
      expect(
        [life.onDisk, life.hibernated, life.planned, life.leased],
        [3, 8, 1, 3],
      );
      expect(life.total, 12);
      expect(
        airWorktreeSummary(directory),
        '12 个 Worktree · 本地 3 · 休眠 8 · 计划 1',
      );
    });

    test('旧服务没有这一格：只说总数，不编一个「全是本地」出来', () {
      final directory = AirDirectory.fromJson({
        'id': 'd1',
        'name': '仓库',
        'path': '/tmp/repo',
        'worktreeCount': 4,
      });
      expect(directory.worktreeLifecycle, isNull);
      expect(directory.visibleWorktreeLifecycle, isNull);
      expect(airWorktreeSummary(directory), '4 个 Worktree');
    });

    test('一个 worktree 都没有：也只说总数，三个 0 摆出来只是噪声', () {
      final empty = AirDirectory.fromJson({
        'id': 'd1',
        'name': '仓库',
        'path': '/tmp/repo',
        'worktreeCount': 0,
        'worktreeLifecycle': {
          'resident': 0,
          'retained': 0,
          'hibernated': 0,
          'planned': 0,
          'leased': 0,
          'onDisk': 0,
          'total': 0,
        },
      });
      expect(empty.visibleWorktreeLifecycle, isNull);
      expect(airWorktreeSummary(empty), '0 个 Worktree');
    });

    test('自动回收的阈值跟着快照下来，客户端不猜默认值', () {
      final snapshot = AirSnapshot.fromJson({
        'directories': const [],
        'tasks': const [],
        'clis': const [],
        'sessions': const [],
        'worktreePolicy': {'idleMs': 3600000},
      });
      expect(snapshot.worktreePolicy.idleMs, 3600000);
      // 旧服务连这一格都没有：0 读作「自动回收已关闭」，不编一个 24 小时出来。
      expect(AirSnapshot.fromJson(const {}).worktreePolicy.idleMs, 0);
    });
  });

  group('createTask', () {
    test('只给必填项时，可选字段一个都不出现', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(
        settings,
        posts,
      ).createTask(dirId: 'd1', title: '登录页面', clientMsgId: 'c1');
      expect(posts.single['body'], {
        'dirId': 'd1',
        'title': '登录页面',
        'clientMsgId': 'c1',
      });
    });

    test('空串等于没给 —— 传空串会把目录的默认 CLI / 模型顶掉', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).createTask(
        dirId: 'd1',
        title: '登录页面',
        clientMsgId: 'c1',
        cli: '',
        model: '',
        rolePrompt: '',
      );
      final body = posts.single['body']!;
      expect(body.containsKey('cli'), isFalse);
      expect(body.containsKey('model'), isFalse);
      expect(body.containsKey('rolePrompt'), isFalse);
    });

    test('四个字段都给了就原样发下去', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).createTask(
        dirId: 'd1',
        title: '登录页面',
        clientMsgId: 'c1',
        cli: 'codex',
        model: 'm1',
        rolePrompt: '检查交互',
      );
      expect(posts.single['body'], {
        'dirId': 'd1',
        'title': '登录页面',
        'clientMsgId': 'c1',
        'cli': 'codex',
        'model': 'm1',
        'rolePrompt': '检查交互',
      });
    });

    test('线路（runtime）与 model 同时有时，以 runtime 里的为准', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).createTask(
        dirId: 'd1',
        title: '登录页面',
        clientMsgId: 'c1',
        model: '外面那个',
        runtime: const {'provider': 'p1', 'model': 'runtime 里那个'},
      );
      final body = posts.single['body']!;
      expect(body['provider'], 'p1');
      expect(body['model'], 'runtime 里那个');
    });
  });

  group('sendFirstMessage', () {
    test('普通消息不带 goal 相关的键', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(
        settings,
        posts,
      ).sendFirstMessage(taskId: 't1', text: '开始吧', clientMsgId: 'c1');
      expect(posts.single['path'], '/api/task-shell-tasks/t1/messages');
      expect(posts.single['body'], {
        'text': '开始吧',
        'clientMsgId': 'c1',
        'intent': 'work',
      });
    });

    test('Goal 的两个上限用服务端认的键名：maxRounds / maxBudget', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).sendFirstMessage(
        taskId: 't1',
        text: '开始吧',
        clientMsgId: 'c1',
        goal: true,
        goalRounds: 200,
        goalBudget: 5000,
      );
      final body = posts.single['body']!;
      expect(body['goal'], isTrue);
      expect(body['goalLimits'], {'maxRounds': 200, 'maxBudget': 5000});
      // 老键名不能再出现 —— 服务端根本不认，只会在界面上假装生效。
      expect((body['goalLimits'] as Map).containsKey('rounds'), isFalse);
      expect((body['goalLimits'] as Map).containsKey('tokenBudget'), isFalse);
    });

    test('只给一个上限时，另一个键不出现（服务端按缺省解成不限）', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(settings, posts).sendFirstMessage(
        taskId: 't1',
        text: '开始吧',
        clientMsgId: 'c1',
        goal: true,
        goalRounds: 50,
      );
      expect(posts.single['body']!['goalLimits'], {'maxRounds': 50});
    });

    test('任务 id 里带斜杠也不会把路径拼坏', () async {
      final settings = await _settings();
      final posts = _sink();
      await _service(
        settings,
        posts,
      ).sendFirstMessage(taskId: 'a/b', text: '开始吧', clientMsgId: 'c1');
      expect(posts.single['path'], '/api/task-shell-tasks/a%2Fb/messages');
    });
  });
}
