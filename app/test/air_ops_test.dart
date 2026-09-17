import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/air_ops_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_ops.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';

/// 主机的读写口替身。测试里绝不真的去 POST /api/update 或 /api/restart ——
/// 这两个请求会改这台机器（拉代码、重启服务），不是能拿来验证的东西。
http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// 侧栏底部那一组。三块共用一个 store，所以一起摆出来才看得出它们是不是同一份
/// 状态（版本行在折叠区外、开机时间在里面、回执又在外面）。
Widget _host(
  AirOpsStore store, {
  VoidCallback? onOpenPush,
  VoidCallback? onLogout,
}) => MaterialApp(
  home: Scaffold(
    body: Column(
      children: [
        AirVersionRow(store: store),
        AirOpsPanel(
          store: store,
          onOpenPush: onOpenPush ?? () {},
          onLogout: onLogout ?? () {},
        ),
        AirOpsReceipt(store: store),
      ],
    ),
  ),
);

/// 每个用例都给一份确定的主机与令牌，不靠上一个用例留下的偏好。
Future<SettingsService> _settings({String token = ''}) async {
  // 没有这一句，偏好就走真插件通道，测试里那通道不存在。
  SharedPreferences.setMockInitialValues(const {});
  final settings = await SettingsService.getInstance();
  await settings.save(host: 'http://localhost:3000', token: token);
  await settings.clearServerHistory();
  return settings;
}

/// store 里有回执自清的 8 秒表、重画的分钟表，收尾必须叫停，否则测试会因为
/// 「还有 Timer 没结束」而红——生产里那由 `dispose()` 负责。
Future<void> _teardown(
  WidgetTester tester,
  AirOpsStore store,
  http.Client client,
) async {
  await tester.pumpWidget(const SizedBox());
  store.dispose();
  client.close();
}

String textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(ValueKey(key))).data ?? '';

AirUpdateRun _run({
  String state = 'running',
  String tail = '',
  int? exitCode,
  bool unreachable = false,
}) => AirUpdateRun(
  state: state,
  running: state == 'running',
  tail: tail,
  exitCode: exitCode,
  unreachable: unreachable,
);

void main() {
  // ── 纯函数 ──────────────────────────────────────────────────────────────

  group('版本行读数的四个态', () {
    // 与 Web `paintVersion` 逐字对齐：还没问过、问失败、有新版、已最新。
    test('还没问过：⏳ + 检查中…', () {
      expect(opsVersionIcon(null, checking: true), '⏳');
      expect(opsVersionHint(null, checking: true), '检查中…');
    });

    test('问过没答复（网络断了）：⏳ + 检查失败', () {
      // 图标分不出「没问过」和「问失败」，文案分得出——Web 也是这么留的。
      expect(opsVersionIcon(null, checking: false), '⏳');
      expect(opsVersionHint(null, checking: false), '检查失败');
    });

    test('有新版：🆕 + 版本号徽标', () {
      const info = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        latest: 'v1.8.0',
        latestVersion: '1.8.0',
        updateAvailable: true,
      );
      expect(opsVersionIcon(info, checking: false), '🆕');
      expect(opsVersionHint(info, checking: false), '有新版');
      expect(opsVersionBadge(info), 'v1.8.0');
    });

    test('已是最新：📦，没有徽标', () {
      const info = AirVersionInfo(current: '1.7.0', channel: 'main', latest: 'v1.7.0');
      expect(opsVersionIcon(info, checking: false), '📦');
      expect(opsVersionHint(info, checking: false), '已是最新');
      expect(opsVersionBadge(info), isNull);
    });

    test('问不到远端 ≠ 已经最新', () {
      const info = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        apiError: true,
      );
      expect(opsVersionIcon(info, checking: false), '📦');
      expect(opsVersionHint(info, checking: false), '已是最新（离线）');
      expect(opsVersionBadge(info), isNull);
    });

    test('远端没报版本号时照样挂一个 v，那是个「点我」的提示', () {
      const info = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        updateAvailable: true,
      );
      expect(opsVersionBadge(info), 'v');
    });
  });

  group('开机时长', () {
    test('粗到只留两个单位', () {
      expect(opsUptimeLabel(0), '<1m');
      expect(opsUptimeLabel(59000), '<1m');
      expect(opsUptimeLabel(60000), '1m');
      expect(opsUptimeLabel(45 * 60 * 1000), '45m');
      expect(opsUptimeLabel((3 * 60 + 12) * 60 * 1000), '3h 12m');
      // 整点的小时尾巴不写出来：'2d 0h' 不是人话。
      expect(opsUptimeLabel(2 * 1440 * 60 * 1000), '2d');
      expect(opsUptimeLabel((2 * 1440 + 300) * 60 * 1000), '2d 5h');
    });

    test('时钟补零到 MM-DD HH:mm', () {
      expect(opsClockLabel(DateTime(2026, 9, 3, 7, 5)), '09-03 07:05');
      expect(opsClockLabel(DateTime(2026, 12, 31, 23, 59)), '12-31 23:59');
    });

    test('开始时刻是从本地的「现在」往回推的', () {
      final labels = opsBootLabels(
        uptimeMs: 3600000,
        now: DateTime(2026, 9, 13, 18, 30),
      );
      expect(labels.started, '09-13 17:30');
      expect(labels.uptime, '已运行 1h 0m');
    });

    test('主机报的数超过一天也能推', () {
      final labels = opsBootLabels(
        uptimeMs: (2 * 1440 + 300) * 60 * 1000,
        now: DateTime(2026, 9, 13, 8, 0),
      );
      expect(labels.started, '09-11 03:00');
      expect(labels.uptime, '已运行 2d 5h');
    });
  });

  group('安装包读数', () {
    test('大小按 KB / MB 两档', () {
      expect(opsPackageSize(0), '—');
      expect(opsPackageSize(512 * 1024), '512 KB');
      expect(opsPackageSize(2.5 * 1024 * 1024 ~/ 1), '2.5 MB');
    });

    test('时间戳为 0 时不假装有个日期', () {
      expect(opsPackageMtime(0), '—');
      expect(
        opsPackageMtime(DateTime(2026, 9, 3, 7, 5).millisecondsSinceEpoch),
        '09-03 07:05',
      );
    });

    test('标题带平台与版本号', () {
      const android = AirPackage(
        platform: 'android',
        versionName: '2.16.0',
        versionCode: 73,
      );
      const ios = AirPackage(platform: 'ios', versionName: '2.17.0');
      expect(android.title, 'Android APK · 2.16.0+73');
      expect(ios.title, 'iOS 安装包 · 2.17.0');
    });
  });

  group('更新过程那句话', () {
    test('服务掉线是过程的一部分，不报成失败', () {
      expect(
        opsUpdateHint(_run(unreachable: true), sawUnreachable: true),
        '服务重启中…',
      );
    });

    test('结束、失败、无响应、超时各说各的', () {
      expect(opsUpdateHint(_run(state: 'succeeded'), sawUnreachable: false), '更新完成，正在重载…');
      expect(
        opsUpdateHint(_run(state: 'failed', exitCode: 1), sawUnreachable: false),
        '更新失败',
      );
      expect(opsUpdateHint(_run(state: 'stale'), sawUnreachable: false), '更新无响应');
      expect(opsUpdateHint(_run(state: 'timeout'), sawUnreachable: false), '更新超时');
    });

    test('跑着的时候把最后一行输出顶上来，长了就截断', () {
      expect(
        opsUpdateHint(_run(tail: '拉取代码\n安装依赖'), sawUnreachable: false),
        '安装依赖',
      );
      final long = List.filled(60, 'x').join();
      expect(opsUpdateHint(_run(tail: long), sawUnreachable: false), long.substring(0, 40));
      expect(opsUpdateHint(_run(tail: '\n\n'), sawUnreachable: false), '正在更新…');
      expect(opsUpdateHint(_run(state: 'scheduled'), sawUnreachable: false), '正在更新…');
    });
  });

  group('确认框里的话', () {
    test('有新版和手动更新是两个标题', () {
      const fresh = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        latest: 'v1.8.0',
        updateAvailable: true,
      );
      const same = AirVersionInfo(current: '1.7.0', channel: 'dev', latest: 'v1.7.0');
      expect(opsUpdateDialogTitle(fresh), '发现新版本');
      expect(opsUpdateDialogTitle(same), '更新 MultiCC');
    });

    test('正文写清从哪到哪、以及会付什么代价', () {
      const info = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        latest: 'v1.8.0',
        updateAvailable: true,
      );
      final body = opsUpdateDialogBody(info);
      expect(body, contains('当前版本：v1.7.0（通道：dev）'));
      expect(body, contains('最新版本：v1.8.0'));
      expect(body, contains('自动重启服务'));
      // 代价要说明白：重启会打断正在输出的会话。
      expect(body, contains('正在输出的会话会被中断'));
    });

    test('离线时不说「最新版本」是什么', () {
      const info = AirVersionInfo(
        current: '1.7.0',
        channel: 'dev',
        apiError: true,
      );
      expect(opsUpdateDialogBody(info), contains('无法连接检查服务（离线）'));
    });

    test('版本号缺失时用占位符，不写一个空的 v', () {
      const info = AirVersionInfo(current: '', channel: '');
      final body = opsUpdateDialogBody(info);
      expect(body, contains('当前版本：v—（通道：dev）'));
      expect(body, contains('最新版本：未知 — 当前已是最新'));
    });
  });

  // ── 读写口 ──────────────────────────────────────────────────────────────

  group('AirOpsService', () {
    test('开机读数：地址与已运行时长', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient(
          (_) async => _json({'url': 'http://192.168.1.9:3000/', 'uptimeMs': 7200000}),
        ),
      );
      final info = await service.fetchServerInfo();
      expect(info.url, 'http://192.168.1.9:3000/');
      expect(info.uptimeMs, 7200000);
      expect(info.known, isTrue);
    });

    test('什么都没报的读数不算读数', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((_) async => _json(const {})),
      );
      expect((await service.fetchServerInfo()).known, isFalse);
    });

    test('令牌跟着请求走', () async {
      final settings = await _settings(token: 'tok-1');
      String? seen;
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((request) async {
          seen = request.headers['X-Access-Token'];
          return _json(const {});
        }),
      );
      await service.fetchServerInfo();
      expect(seen, 'tok-1');
    });

    test('更新状态：问不到是一个状态，不是异常', () async {
      final settings = await _settings();
      // 连接被掐（服务正在重启）与 HTTP 5xx 都落到同一档。
      for (final client in [
        MockClient((_) async => throw const SocketExceptionStub()),
        MockClient((_) async => _json(const {'error': 'boom'}, 500)),
      ]) {
        final run = await AirOpsService(settings: settings, httpClient: client)
            .updateStatus();
        expect(run.unreachable, isTrue);
        expect(run.running, isFalse);
        expect(run.finished, isFalse);
        client.close();
      }
    });

    test('更新状态：正常读数逐字段解析', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient(
          (_) async => _json(const {
            'state': 'failed',
            'running': false,
            'force': true,
            'exitCode': 2,
            'tail': 'error: 本地有改动',
          }),
        ),
      );
      final run = await service.updateStatus();
      expect(run.unreachable, isFalse);
      expect(run.state, 'failed');
      expect(run.broken, isTrue);
      expect(run.force, isTrue);
      expect(run.exitCode, 2);
      expect(run.tail, 'error: 本地有改动');
    });

    test('发起更新：202 算成功、409 算「已经在跑了」、503 带错误码', () async {
      final settings = await _settings();

      Future<AirUpdateStart> startWith(int status, Object body) => AirOpsService(
        settings: settings,
        httpClient: MockClient((_) async => _json(body, status)),
      ).startUpdate();

      final started = await startWith(202, const {
        'ok': true,
        'status': 'started',
        'activeStreaming': 2,
      });
      expect(started.ok, isTrue);
      expect(started.alreadyRunning, isFalse);
      expect(started.activeStreaming, 2);

      final busy = await startWith(409, const {'error': 'update already in progress'});
      expect(busy.ok, isFalse);
      expect(busy.alreadyRunning, isTrue);

      final refused = await startWith(503, const {
        'error': 'cannot update',
        'code': 'DIRTY_WORKTREE',
      });
      expect(refused.ok, isFalse);
      expect(refused.alreadyRunning, isFalse);
      expect(refused.code, 'DIRTY_WORKTREE');
    });

    test('发起更新时把 force 送上去', () async {
      final settings = await _settings();
      String? body;
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((request) async {
          body = request.body;
          return _json(const {'ok': true}, 202);
        }),
      );
      await service.startUpdate(force: true);
      expect(jsonDecode(body!), {'force': true});
    });

    test('两个安装包各查各的：缺一个不影响另一个', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((request) async {
          if (request.url.path == '/api/apk-info') {
            return _json(const {
              'exists': true,
              'versionName': '2.16.0',
              'versionCode': 73,
              'size': 26214400,
              'mtime': 1756800000000,
              'downloadUrl': '/multicc.apk',
            });
          }
          // iOS 这一路整个失败：主机上就没有那个包。
          return _json(const {'error': 'nope'}, 500);
        }),
      );
      final packages = await service.fetchPackages();
      expect(packages, hasLength(1));
      expect(packages.single.platform, 'android');
      expect(packages.single.versionCode, 73);
      // 相对路径补成绝对：那一行是要丢给系统浏览器打开的。
      expect(packages.single.url, 'http://localhost:3000/multicc.apk');
    });

    test('一个包都没有时返回空表，不是 null', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((_) async => _json(const {'exists': false})),
      );
      expect(await service.fetchPackages(), isEmpty);
    });

    test('iOS 用安装页而不是下载地址', () async {
      final settings = await _settings();
      final service = AirOpsService(
        settings: settings,
        httpClient: MockClient((request) async {
          if (request.url.path == '/api/ios-ota-info') {
            return _json(const {
              'exists': true,
              'versionName': '2.17.0',
              'installPage': '/ios-ota',
            });
          }
          return _json(const {'exists': false});
        }),
      );
      final packages = await service.fetchPackages();
      expect(packages.single.platform, 'ios');
      expect(packages.single.url, 'http://localhost:3000/ios-ota');
    });

    test('重启：成功与失败各自的形状', () async {
      final settings = await _settings();
      final ok = await AirOpsService(
        settings: settings,
        httpClient: MockClient(
          (_) async => _json(const {'ok': true, 'status': 'restarting', 'activeStreaming': 0}, 202),
        ),
      ).restart();
      expect(ok.ok, isTrue);
      expect(ok.activeStreaming, 0);

      final refused = await AirOpsService(
        settings: settings,
        httpClient: MockClient(
          (_) async => _json(const {'error': 'restart already in progress'}, 409),
        ),
      ).restart();
      expect(refused.ok, isFalse);
      expect(refused.error, 'restart already in progress');
    });
  });

  // ── store ───────────────────────────────────────────────────────────────

  group('AirOpsStore', () {
    test('还没读到读数之前，开机那两行不写假时间', () async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {'error': 'down'}, 500));
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      expect(store.hasBootReading, isFalse);
      addTearDown(() => expect(store.hasBootReading, isFalse));
      await store.loadBootTime();
      // 连不上就是连不上，占位符留着，不是写一个 1970 年。
      expect(store.hasBootReading, isFalse);
      expect(store.uptimeMs, 0);
    });

    test('读到之后，开机时长随本地时间往前走', () async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {'url': 'http://x/', 'uptimeMs': 600000}),
      );
      var clock = DateTime(2026, 9, 13, 12, 0);
      final store = AirOpsStore(
        settings: settings,
        httpClient: client,
        clock: () => clock,
      );
      addTearDown(store.dispose);
      addTearDown(client.close);

      await store.loadBootTime();
      expect(store.hasBootReading, isTrue);
      expect(store.uptimeMs, 600000);
      // 读数之后又过了一会儿，屏幕上就该显示「读数 + 流逝」，而不是停在读数上。
      clock = clock.add(const Duration(minutes: 5));
      expect(store.uptimeMs, 900000);
    });

    test('查版本失败也是一个结论，不能一直挂在「检查中…」', () async {
      final settings = await _settings();
      final client = MockClient((_) async => throw const SocketExceptionStub());
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      expect(store.versionPending, isTrue);
      expect(await store.checkVersion(), isNull);
      expect(store.versionPending, isFalse);
      expect(store.version, isNull);
    });

    test('正在跟一次更新时，版本行让位给进度', () async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      expect(opsUpdateHintFor(store), isNull);
      store.updateRun = _run(tail: '拉取代码');
      expect(store.updating, isTrue);
      expect(opsUpdateHintFor(store), '拉取代码');
      store.updateRun = _run(state: 'failed');
      expect(store.updating, isFalse);
      expect(opsUpdateHintFor(store), '更新失败');
    });

    test('回执说的是刚才那一下的结果，八秒后自己消失', () async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      store.say('重启请求已发送', tone: 'warn');
      expect(store.receipt, '重启请求已发送');
      expect(store.receiptTone, 'warn');
      store.say('');
      expect(store.receipt, isEmpty);
    });

    test('重启把「有会话在跑」这件事说出来', () async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {'ok': true, 'activeStreaming': 3}, 202),
      );
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      final result = await store.restart();
      expect(result?.ok, isTrue);
      expect(store.receipt, contains('有 3 个会话正在输出'));
      expect(store.receiptTone, 'warn');
    });

    test('重启失败时回执是红的，不是沉默', () async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {'error': 'restart already in progress'}, 409),
      );
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      await store.restart();
      expect(store.receipt, contains('restart already in progress'));
      expect(store.receiptTone, 'err');
    });

    test('退出登录要连历史记录一起忘掉', () async {
      final settings = await _settings(token: 'tok-1');
      await settings.rememberServer('http://other:3000', 'tok-2');
      expect(settings.serverHistory, isNotEmpty);

      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      await store.logout();
      expect(settings.host, isEmpty);
      expect(settings.token, isEmpty);
      // 只清当前那一份等于没退：列表里那一行还带着令牌，点一下就又进去了。
      expect(settings.serverHistory, isEmpty);
    });

    test('推送那一项报的是本机通知通道开着没有', () async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      addTearDown(store.dispose);
      addTearDown(client.close);

      await settings.save(notificationsEnabled: false);
      await settings.save(notificationsEnabled: true);
      expect(store.pushEnabled, settings.notificationsEnabled);
      expect(store.pushEnabled, isTrue);
    });
  });

  group('二维码里放什么', () {
    // 扫的是另一台设备，所以上面这个地址必须是局域网可达的那个。
    test('主机自己报的地址优先，尾巴上那个斜杠去掉', () {
      expect(
        qrAirUrl(serverUrl: 'http://192.168.1.9:3000/', fallbackHost: 'http://x'),
        'http://192.168.1.9:3000/air',
      );
      expect(
        qrAirUrl(serverUrl: 'http://192.168.1.9:3000', fallbackHost: 'http://x'),
        'http://192.168.1.9:3000/air',
      );
    });

    test('问不到就退回配好的主机地址', () {
      expect(
        qrAirUrl(serverUrl: null, fallbackHost: 'http://localhost:3000'),
        'http://localhost:3000/air',
      );
      expect(
        qrAirUrl(serverUrl: '  ', fallbackHost: 'http://localhost:3000/'),
        'http://localhost:3000/air',
      );
    });

    test('两边都没有就返回空串，由界面说清楚', () {
      expect(qrAirUrl(serverUrl: null, fallbackHost: ''), '');
      expect(qrAirUrl(serverUrl: '  ', fallbackHost: '  '), '');
    });
  });

  // ── 界面 ────────────────────────────────────────────────────────────────

  group('侧栏底部', () {
    testWidgets('版本行从「检查中…」走到「有新版」并挂上徽标', (tester) async {
      final settings = await _settings();
      final client = MockClient((request) async {
        if (request.url.path == '/api/version-check') {
          return _json(const {
            'current': '1.7.0',
            'channel': 'dev',
            'latest': 'v1.8.0',
            'latestVersion': '1.8.0',
            'updateAvailable': true,
          });
        }
        return _json(const {'url': 'http://localhost:3000/', 'uptimeMs': 3600000});
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      // 还没问过：先说实话，不是先画一个「已是最新」。
      expect(textOf(tester, 'air-ver-hint'), '检查中…');
      expect(textOf(tester, 'air-ver-current'), 'v—');

      await store.checkVersion();
      await tester.pumpAndSettle();

      expect(textOf(tester, 'air-ver-current'), 'v1.7.0');
      expect(textOf(tester, 'air-ver-hint'), '有新版');
      expect(find.byKey(const ValueKey('air-ver-badge')), findsOneWidget);
      expect(find.text('v1.8.0'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('开机行由服务端读数反推，本地时钟说了算', (tester) async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {'url': 'http://localhost:3000/', 'uptimeMs': 11520000}),
      );
      final clock = DateTime(2026, 9, 13, 18, 30);
      final store = AirOpsStore(
        settings: settings,
        httpClient: client,
        clock: () => clock,
      );
      await tester.pumpWidget(_host(store));
      expect(textOf(tester, 'air-boot-time'), '—');

      await store.loadBootTime();
      await tester.pumpAndSettle();

      // 3h12m 之前是 15:18 —— 由本地时钟往回推，不是读主机的钟。
      expect(textOf(tester, 'air-boot-time'), '09-13 15:18');
      expect(textOf(tester, 'air-boot-uptime'), '已运行 3h 12m');
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('版本行点一下先问要不要更新，取消就不发请求', (tester) async {
      final settings = await _settings();
      final posts = <String>[];
      final client = MockClient((request) async {
        if (request.method == 'POST') posts.add(request.url.path);
        return switch (request.url.path) {
          '/api/update/status' => _json(const {'state': 'idle', 'running': false}),
          '/api/version-check' => _json(const {
            'current': '1.7.0',
            'channel': 'dev',
            'latest': 'v1.8.0',
            'updateAvailable': true,
          }),
          _ => _json(const {}),
        };
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('air-ver-row')));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('air-ops-dialog')), findsOneWidget);
      expect(find.text('发现新版本'), findsOneWidget);
      // 代价写在确认框里，不是等按下去了才说。
      expect(find.textContaining('正在输出的会话会被中断'), findsOneWidget);
      expect(find.byKey(const ValueKey('air-ops-force')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('air-ops-cancel')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('air-ops-dialog')), findsNothing);
      expect(posts, isEmpty);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('确认之后发起更新，跟到完成才收场', (tester) async {
      final settings = await _settings();
      final posts = <String>[];
      var statusCalls = 0;
      final client = MockClient((request) async {
        if (request.method == 'POST') posts.add(request.url.path);
        switch (request.url.path) {
          case '/api/version-check':
            return _json(const {
              'current': '1.7.0',
              'channel': 'dev',
              'latest': 'v1.8.0',
              'latestVersion': '1.8.0',
              'updateAvailable': true,
            });
          case '/api/update/status':
            statusCalls++;
            if (statusCalls == 1) return _json(const {'state': 'idle', 'running': false});
            if (statusCalls == 2) {
              return _json(const {
                'state': 'running',
                'running': true,
                'tail': '拉取代码\n安装依赖',
              });
            }
            return _json(const {
              'state': 'succeeded',
              'running': false,
              'tail': '全部完成',
            });
          default:
            return _json(const {});
        }
      });
      final store = AirOpsStore(
        settings: settings,
        httpClient: client,
        pollInterval: const Duration(milliseconds: 10),
      );
      await tester.pumpWidget(_host(store));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('air-ver-row')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-ops-confirm')));
      await tester.pumpAndSettle();

      expect(posts, ['/api/update']);
      expect(textOf(tester, 'air-ops-title'), '更新完成');
      expect(find.textContaining('App 会自己重连'), findsOneWidget);
      // 结束后补一次开机读数与版本，屏幕上那两个数都来自服务端。
      expect(statusCalls, greaterThanOrEqualTo(3));
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('更新失败时给出「强制更新重试」，重试会带上 force', (tester) async {
      final settings = await _settings();
      final bodies = <String>[];
      var statusCalls = 0;
      final client = MockClient((request) async {
        if (request.url.path == '/api/update' && request.method == 'POST') {
          bodies.add(request.body);
        }
        switch (request.url.path) {
          case '/api/version-check':
            return _json(const {
              'current': '1.7.0',
              'channel': 'dev',
              'latest': 'v1.8.0',
              'updateAvailable': true,
            });
          case '/api/update/status':
            statusCalls++;
            if (statusCalls == 1) return _json(const {'state': 'idle', 'running': false});
            if (statusCalls == 2) {
              return _json(const {
                'state': 'failed',
                'running': false,
                'exitCode': 1,
                'tail': 'error: 本地有改动',
              });
            }
            return _json(const {'state': 'succeeded', 'running': false});
          default:
            return _json(const {});
        }
      });
      final store = AirOpsStore(
        settings: settings,
        httpClient: client,
        pollInterval: const Duration(milliseconds: 10),
      );
      await tester.pumpWidget(_host(store));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('air-ver-row')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-ops-confirm')));
      await tester.pumpAndSettle();

      expect(textOf(tester, 'air-ops-title'), '更新失败');
      expect(find.textContaining('本地有改动'), findsWidgets);
      final retry = find.byKey(const ValueKey('air-ops-force-retry'));
      expect(retry, findsOneWidget);

      await tester.tap(retry);
      await tester.pumpAndSettle();

      expect(bodies, hasLength(2));
      expect(jsonDecode(bodies.first), {'force': false});
      expect(jsonDecode(bodies.last), {'force': true});
      expect(textOf(tester, 'air-ops-title'), '更新完成');
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('已经有一个更新在跑：接管进度，不再发起第二次', (tester) async {
      final settings = await _settings();
      final posts = <String>[];
      final client = MockClient((request) async {
        if (request.method == 'POST') posts.add(request.url.path);
        if (request.url.path == '/api/update/status') {
          return _json(const {'state': 'running', 'running': true, 'tail': '正在编译'});
        }
        return _json(const {});
      });
      // 一次跑不完的更新也不能把这一屏永远占住：等满时限就收场。时限是拿本地钟
      // 比出来的，所以这里的钟得能推着走。
      var clock = DateTime(2026, 9, 13, 12, 0);
      final store = AirOpsStore(
        settings: settings,
        httpClient: client,
        clock: () => clock,
        pollInterval: const Duration(milliseconds: 10),
      );
      await tester.pumpWidget(_host(store));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('air-ver-row')));
      await tester.pumpAndSettle();

      // 每推一段假时钟就多跑一轮轮询，直到越过 20 分钟那条线。
      for (var i = 0; i < 3; i++) {
        clock = clock.add(const Duration(minutes: 8));
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pumpAndSettle();

      expect(textOf(tester, 'air-ops-title'), '更新超时');
      // 接管就是接管：没有第二次 POST /api/update。
      expect(posts, isEmpty);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('安装包对话框：两个包各一行，一点就交给系统浏览器', (tester) async {
      final settings = await _settings();
      final client = MockClient((request) async {
        if (request.url.path == '/api/apk-info') {
          return _json(const {
            'exists': true,
            'versionName': '2.16.0',
            'versionCode': 73,
            'size': 26214400,
            'mtime': 0,
            'downloadUrl': '/multicc.apk',
          });
        }
        return _json(const {
          'exists': true,
          'versionName': '2.17.0',
          'installPage': '/ios-ota',
        });
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      await tester.tap(find.byKey(const ValueKey('air-apk-btn')));
      await tester.pumpAndSettle();

      expect(find.text('Android APK · 2.16.0+73'), findsOneWidget);
      expect(find.text('iOS 安装包 · 2.17.0'), findsOneWidget);
      expect(find.textContaining('25.0 MB'), findsOneWidget);
      // 没发布时间的那一行只写一个横杠，不编一个日期。
      expect(find.textContaining('— · —'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('air-ops-close')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('安装包对话框：主机上什么都没有时说清楚', (tester) async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {'exists': false}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      await tester.tap(find.byKey(const ValueKey('air-apk-btn')));
      await tester.pumpAndSettle();

      expect(find.textContaining('还没有可用的安装包'), findsOneWidget);
      expect(find.byKey(const ValueKey('air-package-android')), findsNothing);
      expect(find.byKey(const ValueKey('air-package-ios')), findsNothing);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('二维码：内容是主机自己报的局域网地址加 /air', (tester) async {
      final settings = await _settings();
      final client = MockClient((request) async {
        if (request.url.path == '/api/server-info') {
          return _json(const {'url': 'http://192.168.1.9:3000/', 'uptimeMs': 1000});
        }
        return _json(const {});
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      await tester.tap(find.byKey(const ValueKey('air-qr-btn')));
      await tester.pumpAndSettle();

      expect(textOf(tester, 'air-ops-title'), '扫码打开 MultiCC Air');
      expect(find.textContaining('用手机相机扫码'), findsOneWidget);
      expect(textOf(tester, 'air-qr-url'), 'http://192.168.1.9:3000/air');
      expect(find.byKey(const ValueKey('air-qr-image')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('二维码：问不到主机地址就退回配好的那个', (tester) async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {'error': 'down'}, 500));
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      await tester.tap(find.byKey(const ValueKey('air-qr-btn')));
      await tester.pumpAndSettle();

      expect(textOf(tester, 'air-qr-url'), 'http://localhost:3000/air');
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('窄屏上二维码对话框放得下', (tester) async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {'url': 'http://192.168.1.9:3000/', 'uptimeMs': 1000}),
      );
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 640);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));
      await tester.tap(find.byKey(const ValueKey('air-qr-btn')));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('air-qr-image')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('重启要先问过：取消不发请求，确认才发，回执落在折叠区外', (tester) async {
      final settings = await _settings();
      final posts = <String>[];
      final client = MockClient((request) async {
        if (request.method == 'POST') posts.add(request.url.path);
        return _json(const {'ok': true, 'status': 'restarting', 'activeStreaming': 0}, 202);
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      await tester.tap(find.byKey(const ValueKey('air-restart-btn')));
      await tester.pumpAndSettle();
      expect(find.text('重启服务'), findsOneWidget);
      expect(find.textContaining('在途消息会先保存'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('air-ops-cancel')));
      await tester.pumpAndSettle();
      expect(posts, isEmpty);

      await tester.tap(find.byKey(const ValueKey('air-restart-btn')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-ops-restart-confirm')));
      await tester.pumpAndSettle();

      expect(posts, ['/api/restart']);
      expect(textOf(tester, 'air-ops-status'), '重启请求已发送，服务即将重启…');
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('回执八秒后自己消失', (tester) async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));

      store.say('重启请求已发送，服务即将重启…');
      await tester.pump();
      expect(textOf(tester, 'air-ops-status'), '重启请求已发送，服务即将重启…');

      await tester.pump(const Duration(seconds: 9));
      expect(textOf(tester, 'air-ops-status'), isEmpty);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('推送通知这一行只报开关并交回宿主，不在侧栏里开关', (tester) async {
      final settings = await _settings();
      await settings.save(notificationsEnabled: false);
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      var opened = 0;
      await tester.pumpWidget(_host(store, onOpenPush: () => opened++));
      await tester.pumpAndSettle();

      expect(store.pushEnabled, isFalse);
      await tester.tap(find.byKey(const ValueKey('air-push-btn')));
      await tester.pumpAndSettle();

      expect(opened, 1);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('退出登录要确认，确认后交回宿主', (tester) async {
      final settings = await _settings();
      final client = MockClient((_) async => _json(const {}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      var logouts = 0;
      // 和 air_tasks_view 里一样接：侧栏只管问，真正清令牌那一步归宿主。
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => Column(
                children: [
                  AirOpsPanel(
                    store: store,
                    onOpenPush: () {},
                    onLogout: () => unawaited(
                      confirmAirLogout(
                        context,
                        onLogout: () async => logouts++,
                      ),
                    ),
                  ),
                  AirOpsReceipt(store: store),
                ],
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.byKey(const ValueKey('air-logout-btn')));
      await tester.pumpAndSettle();
      expect(textOf(tester, 'air-ops-title'), '退出登录');
      // 主机上的东西一律不动，忘的只是这台设备。
      expect(find.textContaining('主机上的任务、会话和数据都不受影响'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('air-ops-cancel')));
      await tester.pumpAndSettle();
      expect(logouts, 0);

      await tester.tap(find.byKey(const ValueKey('air-logout-btn')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('air-ops-logout-confirm')));
      await tester.pumpAndSettle();
      expect(logouts, 1);
      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

    testWidgets('窄屏上版本行与那一排按钮都不溢出', (tester) async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => _json(const {
          'current': '1.7.0',
          'channel': 'dev',
          'latest': 'v1.8.0',
          'latestVersion': '1.8.0',
          'updateAvailable': true,
        }),
      );
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 640);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final store = AirOpsStore(settings: settings, httpClient: client);
      await tester.pumpWidget(_host(store));
      await store.checkVersion();
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      await _teardown(tester, store, client);
    });

  // 关盖运行（macOS 电源）：设置中心 › 全局配置里那个开关，Air 侧栏「常用设置」
  // 里也有一行。状态机只有三种：不知道（读不到）/ 这台主机没这个能力 / 有——界面
  // 只在最后一种情况下摆那一行，所以这三件事必须分得开。
  group('关盖运行（macOS 电源）', () {
    test('这台主机没这个能力：available=false，不是「关着」', () async {
      final settings = await _settings();
      final client = MockClient((request) async {
        expect(request.url.path, '/api/settings/power');
        return _json(const {'available': false, 'enabled': false});
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await store.loadLidSleep();
      expect(store.lidSleepAvailable, isFalse);
      expect(store.lidSleepOn, isFalse);
      client.close();
    });

    test('读不到就保持「不知道」：不能替主机回答它不支持', () async {
      final settings = await _settings();
      final client = MockClient(
        (_) async => throw const SocketExceptionStub(),
      );
      final store = AirOpsStore(settings: settings, httpClient: client);
      await store.loadLidSleep();
      expect(store.lidSleepAvailable, isNull);
      client.close();
    });

    test('点一下先动界面：授权框还弹在 Mac 上，开关已经翻过去了', () async {
      final settings = await _settings();
      final posts = <String>[];
      final client = MockClient((request) async {
        if (request.method == 'POST') {
          posts.add(request.body);
          return _json(const {'ok': true, 'available': true, 'enabled': true});
        }
        return _json(const {'available': true, 'enabled': false});
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await store.loadLidSleep();
      expect(store.lidSleepAvailable, isTrue);
      expect(store.lidSleepOn, isFalse);

      await store.toggleLidSleep();
      expect(posts, ['{"enabled":true}']);
      expect(store.lidSleepOn, isTrue);
      expect(store.receipt, '已开启关盖保持运行');
      store.dispose();
      client.close();
    });

    test('写失败：开关退回原状态，并说清失败在哪一步', () async {
      final settings = await _settings();
      final client = MockClient((request) async => request.method == 'POST'
          ? _json(const {'error': 'Administrator authorization was canceled'}, 500)
          : _json(const {'available': true, 'enabled': false}));
      final store = AirOpsStore(settings: settings, httpClient: client);
      await store.loadLidSleep();
      await store.toggleLidSleep();
      // 失败不能画成一次成功的切换：开关回原位，回执说失败。
      expect(store.lidSleepOn, isFalse);
      expect(store.receiptTone, 'err');
      expect(store.receipt, contains('关盖运行设置失败'));
      store.dispose();
      client.close();
    });

    test('这台主机没这个能力时，点也点不动（一个请求都不发）', () async {
      final settings = await _settings();
      var posts = 0;
      final client = MockClient((request) async {
        if (request.method == 'POST') posts++;
        return _json(const {'available': false, 'enabled': false});
      });
      final store = AirOpsStore(settings: settings, httpClient: client);
      await store.loadLidSleep();
      await store.toggleLidSleep();
      expect(posts, 0);
      expect(store.lidSleepOn, isFalse);
      client.close();
    });
  });
  });
}

/// 测试里没有真的网线可拔，用这个假装「连不上」。`http.Client` 抛什么都会被
/// 当成可达性问题处理，所以是什么异常并不重要，重要的是它抛了。
class SocketExceptionStub implements Exception {
  const SocketExceptionStub();

  @override
  String toString() => 'connection refused';
}
