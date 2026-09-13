import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/task_artifact.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/task_artifacts_service.dart';
import 'package:multicc_app/widgets/task_artifacts_panel.dart';

/// `http.Response(String, …)` 默认按 latin1 编码 body，中文标题会直接抛
/// 「Contains invalid characters」；统一走这个构造带上 utf-8 的 content-type。
http.Response jsonResponse(Object payload, [int status = 200]) => http.Response(
  jsonEncode(payload),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 产物边栏（Web `public/task-artifacts.js`）。
///
/// 重点在两件容易出错的事上：**URL 白名单**（列表里的链接是模型自己写下的
/// 文本，渲染成可点链接之前必须过一遍）和**换任务时的状态清理**（搜索词、
/// 展开偏好都是按任务记的，串了就会拿 A 任务的搜索结果去看 B 任务的产物）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // SettingsService 是按进程缓存的单例，host 只读一次；整个文件共用一份
  // 指向不可达端口的设置（真请求全被 MockClient 截住，不会打网络）。
  late SettingsService settings;

  setUpAll(() async {
    I18n.init('zh');
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:9',
      'multicc_token': '',
    });
    settings = await SettingsService.getInstance();
  });

  group('isArtifactUrl', () {
    test('接受 /artifacts/<id>/... 的各种形态', () {
      expect(isArtifactUrl('/artifacts/abc123/index.html'), isTrue);
      expect(isArtifactUrl('/artifacts/ab-12_c/file.pdf'), isTrue);
      expect(isArtifactUrl('/artifacts/abc123'), isTrue);
      expect(isArtifactUrl('/artifacts/abc123/a/b/c.txt'), isTrue);
      expect(isArtifactUrl('/artifacts/abc123/index.html?v=2'), isTrue);
      expect(isArtifactUrl('/artifacts/abc123/index.html#top'), isTrue);
    });

    test('拒绝站外地址和其它路径', () {
      expect(isArtifactUrl('https://example.com/artifacts/x/y.html'), isFalse);
      expect(isArtifactUrl('/files/abc/x.txt'), isFalse);
      expect(isArtifactUrl('/artifacts/a b/x.txt'), isFalse);
      expect(isArtifactUrl('artifacts/abc/x.txt'), isFalse);
      expect(isArtifactUrl('/artifacts//x.txt'), isFalse);
      expect(isArtifactUrl(''), isFalse);
    });

    test('路径穿越一律拒绝（正则放行，第二道必须拦住）', () {
      expect(isArtifactUrl('/artifacts/abc/../../etc/passwd'), isFalse);
      expect(isArtifactUrl('/artifacts/abc/./x.txt'), isFalse);
    });
  });

  group('TaskArtifact', () {
    test('非白名单 url 的整条被丢掉', () {
      final list = TaskArtifactList.fromJson({
        'taskId': 'tsk_1',
        'title': '任务',
        'items': [
          {'url': '/artifacts/a/index.html', 'title': 'A', 'kind': 'page'},
          {'url': 'https://evil.example/x', 'title': 'B'},
          {'url': '/artifacts/b/../../x', 'title': 'C'},
        ],
      });
      expect(list.items.map((a) => a.title), ['A']);
      expect(list.taskId, 'tsk_1');
    });

    test('空 taskId 当成没有任务', () {
      expect(
        TaskArtifactList.fromJson({'taskId': '', 'items': []}).taskId,
        isNull,
      );
      expect(TaskArtifactList.fromJson({}).taskId, isNull);
    });

    test('日期按本地时区显示，解析不了就留空', () {
      TaskArtifact? parse(String? createdAt) => TaskArtifact.fromJson({
        'url': '/artifacts/a/index.html',
        'title': 'A',
        if (createdAt != null) 'createdAt': createdAt,
      });

      expect(
        parse('2026-09-13T10:00:00.000Z')!.dateLabel,
        matches(RegExp(r'^\d{4}/\d{1,2}/\d{1,2}$')),
      );
      // 解析不了就给空串 —— 列表那行只拼得出「网页」，绝不显示半截时间。
      expect(parse('not-a-date')!.dateLabel, '');
      expect(parse(null)!.dateLabel, '');
    });
  });

  group('TaskArtifactsController', () {
    /// 每个用例一个独立 taskId：展开偏好是按 taskId 记在 SharedPreferences
    /// 里的，串了就会让后一个用例继承前一个的展开状态。
    var seq = 0;

    TaskArtifactsController controllerWith(
      Future<http.Response> Function(http.Request) handler, {
      List<String>? urls,
    }) => TaskArtifactsController(
      settings: settings,
      service: TaskArtifactsService(
        settings: settings,
        httpClient: MockClient((req) {
          urls?.add(req.url.toString());
          return handler(req);
        }),
      ),
    );

    http.Response ok({
      String? taskId,
      String title = '做个页面',
      List<Map<String, dynamic>> items = const [],
    }) => jsonResponse({
      'taskId': taskId ?? 'tsk_${++seq}',
      'title': title,
      'items': items,
    });

    /// 一次 HTTP + 落库都是纯微任务链，两个 tick 足够。
    Future<void> settle() =>
        Future<void>.delayed(const Duration(milliseconds: 5));

    test('拿到 shell 之前没有入口，拿到之后拉一次列表', () async {
      final c = controllerWith((_) async => ok(title: '做个页面'));
      expect(c.available, isFalse);
      c.syncScope(null);
      c.syncScope('');
      expect(c.available, isFalse);
      expect(c.items, isEmpty);

      c.syncScope('shell-1');
      expect(c.available, isTrue);
      expect(c.loaded, isFalse);
      expect(c.status, TaskArtifactsStatus.loading);
      await settle();
      expect(c.loaded, isTrue);
      expect(c.title, '做个页面');
      expect(c.status, TaskArtifactsStatus.none);
      c.dispose();
    });

    test('请求走 task-shells 的 artifacts 端点，shellId 要转义', () async {
      final urls = <String>[];
      final c = controllerWith((_) async => ok(), urls: urls);
      c.syncScope('shell 1');
      await settle();
      expect(urls.single, contains('/api/task-shells/shell%201/artifacts'));
      c.dispose();
    });

    test('搜索同时匹配标题和链接（对齐 web 在 title + url 上的包含匹配）', () async {
      final c = controllerWith(
        (_) async => ok(
          items: [
            {'url': '/artifacts/a/index.html', 'title': '报表页面'},
            {'url': '/artifacts/b/report.csv', 'title': '数据'},
          ],
        ),
      );
      c.syncScope('shell-1');
      await settle();
      expect(c.visible.length, 2);

      c.setQuery('报表');
      expect(c.visible.single.title, '报表页面');
      c.setQuery('report.csv');
      expect(c.visible.single.title, '数据');
      c.setQuery('没有这个');
      expect(c.visible, isEmpty);
      expect(c.hasQuery, isTrue);
      c.dispose();
    });

    test('展开状态按任务记住，重开还开着', () async {
      final taskId = 'tsk_pref_${++seq}';
      final c = controllerWith((_) async => ok(taskId: taskId));
      c.syncScope('shell-1');
      await settle();
      expect(c.open, isFalse);

      unawaited(c.setOpen(true));
      await settle();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool('task-artifacts:$taskId'), isTrue);

      // 同一个任务重开一份 controller：读回展开偏好。
      final again = controllerWith((_) async => ok(taskId: taskId));
      again.syncScope('shell-1');
      await settle();
      expect(again.open, isTrue);
      c.dispose();
      again.dispose();
    });

    test('换 scope 清空列表、搜索词并收起面板', () async {
      final c = controllerWith(
        (_) async => ok(
          items: [
            {'url': '/artifacts/a/index.html', 'title': 'A'},
          ],
        ),
      );
      c.syncScope('shell-1');
      await settle();
      c.setQuery('A');
      expect(c.visible, isNotEmpty);

      c.syncScope('shell-2');
      expect(c.items, isEmpty);
      expect(c.hasQuery, isFalse);
      expect(c.open, isFalse);
      expect(c.loaded, isFalse);
      c.dispose();
    });

    test('拉失败给 failed 状态（面板显示「产物加载失败」）', () async {
      final c = controllerWith((_) async => http.Response('nope', 500));
      c.syncScope('shell-1');
      await settle();
      expect(c.status, TaskArtifactsStatus.failed);
      expect(c.loaded, isFalse);
      c.dispose();
    });

    test('复制结果落到状态行，下一次刷新清掉', () async {
      final c = controllerWith((_) async => ok());
      c.syncScope('shell-1');
      await settle();
      c.markCopied(true);
      expect(c.status, TaskArtifactsStatus.copied);
      await c.refresh();
      expect(c.status, TaskArtifactsStatus.none);

      c.markCopied(false);
      expect(c.status, TaskArtifactsStatus.copyFailed);
      c.dispose();
    });

    test('销毁之后在途请求回来也不许再通知（页面当时可能已经没了）', () async {
      final c = controllerWith((_) async => ok());
      var notified = 0;
      c.addListener(() => notified++);
      c.syncScope('shell-1');
      final afterSync = notified; // syncScope 自己会通知一次，这是基线
      // 请求还没落地就销毁；dispose 之后再被 notify 会直接踩断言。
      c.dispose();
      await settle();
      expect(notified, afterSync);
    });
  });

  group('TaskArtifactsPanel', () {
    /// 取数走真 HTTP 管线（MockClient），在 testWidgets 的假时钟里得放到
    /// `runAsync` 里跑，否则 `Future.delayed` 永远等不到。
    Future<TaskArtifactsController> pumpPanel(
      WidgetTester tester, {
      required List<Map<String, dynamic>> items,
    }) async {
      final c = TaskArtifactsController(
        settings: settings,
        service: TaskArtifactsService(
          settings: settings,
          httpClient: MockClient(
            (_) async => jsonResponse({
              'taskId': 'tsk_panel',
              'title': '做个页面',
              'items': items,
            }),
          ),
        ),
      );
      addTearDown(c.dispose);
      await tester.runAsync(() async {
        c.syncScope('shell-1');
        await Future<void>.delayed(const Duration(milliseconds: 20));
        unawaited(c.setOpen(true));
        await Future<void>.delayed(const Duration(milliseconds: 20));
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TaskArtifactsPanel(
              controller: c,
              settings: settings,
              onClose: () {},
              panelWidth: 310,
            ),
          ),
        ),
      );
      await tester.pump();
      return c;
    }

    testWidgets('列表渲染标题、链接、类型与日期；失效的标「已失效」', (tester) async {
      await pumpPanel(
        tester,
        items: [
          {
            'url': '/artifacts/a/index.html',
            'title': '报表页面',
            'kind': 'page',
            'createdAt': '2026-09-13T10:00:00.000Z',
          },
          {
            'url': '/artifacts/b/old.csv',
            'title': '旧报告',
            'kind': 'file',
            'expired': true,
          },
        ],
      );

      expect(find.text('报表页面'), findsOneWidget);
      expect(find.text('/artifacts/a/index.html'), findsOneWidget);
      expect(find.textContaining(t('taskArtifactsPage')), findsOneWidget);
      // 没有 createdAt 的那条 meta 就只有类型本身。
      expect(find.text(t('taskArtifactsFile')), findsOneWidget);
      expect(find.text(t('taskArtifactsExpired')), findsOneWidget);
      expect(find.text(t('taskArtifactsCopy')), findsNWidgets(2));
    });

    testWidgets('空列表与「搜不到」是两句话，别把搜索无果读成「没有产物」', (tester) async {
      final c = await pumpPanel(tester, items: const []);
      expect(find.text(t('taskArtifactsEmpty')), findsOneWidget);
      expect(find.text(t('taskArtifactsNoMatch')), findsNothing);

      c.setQuery('找不到的东西');
      await tester.pump();
      expect(find.text(t('taskArtifactsNoMatch')), findsOneWidget);
      expect(find.text(t('taskArtifactsEmpty')), findsNothing);
    });

    testWidgets('点「复制链接」把绝对地址写进剪贴板并报「链接已复制」', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await pumpPanel(
        tester,
        items: [
          {'url': '/artifacts/a/index.html', 'title': '报表页面'},
        ],
      );
      await tester.tap(find.text(t('taskArtifactsCopy')));
      await tester.pump();

      // 相对路径要拼成能直接粘到浏览器里的绝对地址。
      expect(copied, 'http://127.0.0.1:9/artifacts/a/index.html');
      await tester.pump();
      expect(find.text(t('taskArtifactsCopied')), findsOneWidget);
    });

    testWidgets('收起时滑出屏幕、不吃点击', (tester) async {
      final c = await pumpPanel(tester, items: const []);
      expect(
        tester.widget<AnimatedSlide>(find.byType(AnimatedSlide)).offset,
        Offset.zero,
      );

      unawaited(c.setOpen(false));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(
        tester.widget<AnimatedSlide>(find.byType(AnimatedSlide)).offset,
        const Offset(1.05, 0),
      );
      expect(
        tester.widget<IgnorePointer>(find.byKey(TaskArtifactsPanel.ignoreKey)).ignoring,
        isTrue,
      );
    });
  });
}
