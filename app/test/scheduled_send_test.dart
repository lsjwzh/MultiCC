// 定时发送（Web `public/chat-scheduled-send.js` 的 App 复刻）。
//
// 分四层锁行为，都是照着 Web 那份实现逐条对的：
//   * 三个纯函数：延迟换算（1 秒 ~ 7 天、单位、四舍五入）、剩余时间四档措辞、
//     到点时刻的写法、幂等键形状；
//   * ScheduledSendService：请求方法与路径、幂等头、正文形、错误码 → 异常；
//   * ScheduledSendStore：校验顺序（先时间后正文）、解密装饰与附件、同草稿复用
//     幂等键、成功清草稿、撤销失败保留、1 秒节拍与每 15 拍对表；
//   * 控件：⏱ 角标口径、面板提交与撤销、悬浮球的显隐。
//
// 全程 MockClient，绝不打真服务端 —— 这里没有任何一条用例会真的建定时消息。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/scheduled_send_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/scheduled_send_dock.dart';
import 'package:multicc_app/widgets/scheduled_send_store.dart';

/// 每次请求都会落这儿，用例自己去看发了什么。[setUp] 里清空。
final List<http.Request> _sent = [];

http.Client _mock(http.Response Function(http.Request request) reply) =>
    MockClient((request) async {
      _sent.add(request);
      return reply(request);
    });

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Map<String, dynamic> _message({
  String id = 'm1',
  String message = '到点提醒我',
  int dueAt = 0,
}) => {
  'id': id,
  'sessionId': 's1',
  'message': message,
  'dueAt': dueAt,
  'delaySeconds': 600,
  'status': 'pending',
  'createdAt': 0,
};

http.Response _created(Object scheduled) => _json({
  'ok': true,
  'scheduledMessage': scheduled,
});

http.Response _listed(List<Object> items) => _json({
  'ok': true,
  'scheduledMessages': items,
  'count': items.length,
});

/// 只看 POST 的那几条（列表的 GET 也走同一个 mock）。
List<http.Request> _posts() =>
    [for (final request in _sent) if (request.method == 'POST') request];

void main() {
  // 面板上每个字都得有词典。
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  late SettingsService settings;

  setUp(() async {
    _sent.clear();
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    settings = await SettingsService.getInstance();
  });

  group('延迟换算', () {
    test('四个单位各算各的', () {
      expect(parseScheduleDelaySeconds('10', 'minutes'), 600);
      expect(parseScheduleDelaySeconds('30', 'seconds'), 30);
      expect(parseScheduleDelaySeconds('2', 'hours'), 7200);
      expect(parseScheduleDelaySeconds('1', 'days'), 86400);
      // 前后空格是手输难免的。
      expect(parseScheduleDelaySeconds(' 10 ', 'minutes'), 600);
    });

    test('1 秒到 7 天之间闭区间，越界一律 null', () {
      expect(parseScheduleDelaySeconds('1', 'seconds'), 1);
      expect(parseScheduleDelaySeconds('604800', 'seconds'), 604800);
      expect(parseScheduleDelaySeconds('7', 'days'), 604800);
      // 多一秒都不行 —— 服务端就是这么卡的。
      expect(parseScheduleDelaySeconds('604801', 'seconds'), isNull);
      expect(parseScheduleDelaySeconds('8', 'days'), isNull);
      expect(parseScheduleDelaySeconds('0', 'seconds'), isNull);
      expect(parseScheduleDelaySeconds('0', 'days'), isNull);
      expect(parseScheduleDelaySeconds('-5', 'minutes'), isNull);
    });

    test('认不出来的输入给 null，绝不替用户猜', () {
      expect(parseScheduleDelaySeconds('', 'minutes'), isNull);
      expect(parseScheduleDelaySeconds('abc', 'minutes'), isNull);
      expect(parseScheduleDelaySeconds('NaN', 'minutes'), isNull);
      expect(parseScheduleDelaySeconds('Infinity', 'minutes'), isNull);
      expect(parseScheduleDelaySeconds('10', 'weeks'), isNull);
      expect(parseScheduleDelaySeconds('10', ''), isNull);
    });

    test('小数四舍五入到整秒，凑不满 1 秒算不合法', () {
      expect(parseScheduleDelaySeconds('1.5', 'seconds'), 2);
      expect(parseScheduleDelaySeconds('1.4', 'seconds'), 1);
      expect(parseScheduleDelaySeconds('0.4', 'seconds'), isNull);
      expect(parseScheduleDelaySeconds('1.9', 'minutes'), 114);
    });
  });

  group('剩余时间那句话', () {
    const now = 1000000000000;

    test('秒 / 分 / 时 / 天，一律向上取整', () {
      expect(
        formatScheduleRemaining(now + 500, nowMs: now),
        '1 秒后', // 剩 1 毫秒也是「1 秒后」，不写 0
      );
      expect(formatScheduleRemaining(now + 59000, nowMs: now), '59 秒后');
      expect(
        formatScheduleRemaining(now + 59500, nowMs: now),
        '1 分钟后', // 59.5 秒进位到 60，走分钟档
      );
      expect(formatScheduleRemaining(now + 60000, nowMs: now), '1 分钟后');
      expect(formatScheduleRemaining(now + 3600000, nowMs: now), '1 小时后');
      expect(formatScheduleRemaining(now + 86400000, nowMs: now), '1 天后');
      // 25 小时是「2 天后」，不是「1 天后」。
      expect(formatScheduleRemaining(now + 90000000, nowMs: now), '2 天后');
    });

    test('到点了 / 已经过点了都说「即将投递」', () {
      expect(formatScheduleRemaining(now, nowMs: now), '即将投递');
      expect(formatScheduleRemaining(now - 1, nowMs: now), '即将投递');
      expect(formatScheduleRemaining(now - 86400000, nowMs: now), '即将投递');
    });
  });

  group('到点时刻的写法', () {
    test('MM/DD HH:mm:ss，本地时区，一位数补零', () {
      final at = DateTime(2026, 9, 13, 8, 5, 7).millisecondsSinceEpoch;
      expect(formatScheduleDueAt(at), '09/13 08:05:07');
    });
  });

  group('幂等键', () {
    test('同一时刻同一个随机数，键也一样', () {
      expect(
        scheduledClientId(nowMs: 1757000000000, random: 0.42),
        scheduledClientId(nowMs: 1757000000000, random: 0.42),
      );
    });

    test('形状是 schedule-<36 进制时间戳>-<36 进制熵>', () {
      final id = scheduledClientId(nowMs: 1757000000000, random: 0.42);
      expect(id, matches(RegExp(r'^schedule-[0-9a-z]+-[0-9a-z]+$')));
      expect(id.startsWith('schedule-'), isTrue);
    });

    test('随机数不同就不是同一个键（否则服务端会当成重复提交）', () {
      expect(
        scheduledClientId(nowMs: 1757000000000, random: 0.42),
        isNot(scheduledClientId(nowMs: 1757000000000, random: 0.43)),
      );
    });
  });

  group('服务端那三个动作', () {
    test('建：POST 到会话自己的路径，带幂等头和 token', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock((_) => _created(_message(dueAt: 1757000000000))),
      );

      final created = await service.create(
        sessionId: 'session/a',
        message: '十分钟后提醒我',
        delaySeconds: 600,
        clientScheduleId: 'schedule-abc-def',
      );

      expect(created.id, 'm1');
      expect(created.message, '到点提醒我');
      expect(created.dueAt, 1757000000000);

      final request = _sent.single;
      expect(request.method, 'POST');
      expect(request.url.path, '/api/sessions/session%2Fa/scheduled-messages');
      expect(request.headers['x-access-token'], 'secret');
      expect(request.headers['Idempotency-Key'], 'schedule-abc-def');
      expect(jsonDecode(request.body), {
        'message': '十分钟后提醒我',
        'delaySeconds': 600,
      });
    });

    test('服务端认出重复提交（200 + duplicate）当成功收下', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock(
          (_) => _json({
            'ok': true,
            'duplicate': true,
            'scheduledMessage': _message(dueAt: 1757000000000),
          }),
        ),
      );

      final created = await service.create(
        sessionId: 's1',
        message: '到点提醒我',
        delaySeconds: 600,
        clientScheduleId: 'k1',
      );
      expect(created.id, 'm1');
    });

    test('服务端拒绝时抛带 code 的异常，原话留着', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock(
          (_) => _json({
            'ok': false,
            'code': 'message_required',
            'error': '消息不能为空',
          }, 400),
        ),
      );

      await expectLater(
        service.create(
          sessionId: 's1',
          message: '',
          delaySeconds: 600,
          clientScheduleId: 'k1',
        ),
        throwsA(
          isA<ScheduledSendException>()
              .having((e) => e.code, 'code', 'message_required')
              .having((e) => e.message, 'message', '消息不能为空'),
        ),
      );
    });

    test('列：GET 同一个路径，按 scheduledMessages 解析', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock(
          (_) => _listed([
            _message(id: 'm1', message: '甲', dueAt: 111),
            _message(id: 'm2', message: '乙', dueAt: 222),
          ]),
        ),
      );

      final items = await service.list('s1');

      expect(_sent.single.method, 'GET');
      expect(_sent.single.url.path, '/api/sessions/s1/scheduled-messages');
      expect(items.map((item) => item.id), ['m1', 'm2']);
      expect(items.map((item) => item.dueAt), [111, 222]);
    });

    test('列：ok=false 即使 200 也算失败', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock(
          (_) => _json({'ok': false, 'code': 'session_not_found'}, 200),
        ),
      );
      await expectLater(
        service.list('s1'),
        throwsA(isA<ScheduledSendException>()),
      );
    });

    test('撤：DELETE 到消息自己的路径，不带 body', () async {
      final service = ScheduledSendService(
        settings: settings,
        httpClient: _mock((_) => _json({'ok': true})),
      );

      await service.cancel(sessionId: 's1', messageId: 'm 1');

      final request = _sent.single;
      expect(request.method, 'DELETE');
      expect(request.url.path, '/api/sessions/s1/scheduled-messages/m%201');
      expect(request.body, isEmpty);
    });
  });

  group('草稿排上队（Store）', () {
    ScheduledSendStore build(
      http.Response Function(http.Request request) reply, {
      String Function()? makeId,
      DateTime Function()? clock,
      int refreshEveryTicks = 15,
    }) => ScheduledSendStore(
      service: ScheduledSendService(
        settings: settings,
        httpClient: _mock(reply),
      ),
      sessionId: 's1',
      makeId: makeId,
      clock: clock,
      refreshEveryTicks: refreshEveryTicks,
    );

    test('成功：状态行说到点时刻，列表跟着刷新', () async {
      final at = DateTime(2026, 9, 13, 8, 5, 7).millisecondsSinceEpoch;
      var listed = <Object>[];
      final store = build((request) {
        if (request.method == 'GET') return _listed(listed);
        listed = [_message(id: 'm1', message: '到点提醒我', dueAt: at)];
        return _created(_message(id: 'm1', message: '到点提醒我', dueAt: at));
      });

      final ok = await store.submit(
        amount: '10',
        unit: 'minutes',
        typedText: '到点提醒我',
      );

      expect(ok, isTrue);
      expect(store.status, '已安排在 09/13 08:05:07 自动投递');
      expect(store.statusIsError, isFalse);
      expect(store.items.single.id, 'm1');
      expect(store.badgeText, '1');
      expect(store.submitting, isFalse);
    });

    test('时间不合法：先抱怨时间，一条请求都不发', () async {
      final store = build((_) => _created(_message()));

      final ok = await store.submit(
        amount: '9',
        unit: 'days',
        typedText: '到点提醒我',
      );

      expect(ok, isFalse);
      expect(store.status, '请输入 1 秒到 7 天之间的时间');
      expect(store.statusIsError, isTrue);
      expect(_sent, isEmpty);
    });

    test('正文空：说清是没填消息 —— 顺序上时间先过', () async {
      final store = build((_) => _created(_message()));

      final ok = await store.submit(
        amount: '0',
        unit: 'seconds', // 时间也不合法
        typedText: '   ',
      );

      expect(ok, isFalse);
      // 时间坏的时候不该先说「请填写消息」。
      expect(store.status, '请输入 1 秒到 7 天之间的时间');
      expect(_sent, isEmpty);
    });

    test('正文空：时间合法才轮到它', () async {
      final store = build((_) => _created(_message()));

      final ok = await store.submit(
        amount: '10',
        unit: 'minutes',
        typedText: '   ',
      );

      expect(ok, isFalse);
      expect(store.status, '请先在输入框填写要发送的消息');
      expect(_sent, isEmpty);
    });

    test('附件路径拼在正文后面，再走那层装饰（派发提示）', () async {
      final store = build((_) => _created(_message(dueAt: 111)));

      await store.submit(
        amount: '10',
        unit: 'minutes',
        typedText: '看看这个',
        attachmentPaths: const ['/tmp/a.png', '/tmp/b.png'],
        decorate: (text) => '【派发】$text',
      );

      expect(jsonDecode(_posts().single.body), {
        'message': '【派发】看看这个 /tmp/a.png /tmp/b.png',
        'delaySeconds': 600,
      });
    });

    test('同一份草稿复用同一个幂等键；换了草稿才换键', () async {
      var seq = 0;
      // 只有第一次会成功，后面两次留着失败态，用来验「同草稿重试不换键」。
      var calls = 0;
      final store = build((request) {
        if (request.method == 'GET') return _listed(const []);
        calls++;
        if (calls == 1) return _created(_message(dueAt: 111));
        return _json({'ok': false, 'code': 'boom', 'error': '炸了'}, 500);
      }, makeId: () => 'id-${++seq}');

      // 第一次成功 → 键用完就丢。
      await store.submit(amount: '10', unit: 'minutes', typedText: '甲');
      // 之后两次同样的草稿：第一次失败留着键，第二次重试得是同一个键。
      await store.submit(amount: '10', unit: 'minutes', typedText: '甲');
      await store.submit(amount: '10', unit: 'minutes', typedText: '甲');
      // 换了正文 → 换键。
      await store.submit(amount: '10', unit: 'minutes', typedText: '乙');
      // 只换延迟 → 也是新的一份。
      await store.submit(amount: '20', unit: 'minutes', typedText: '乙');

      final keys = [
        for (final request in _posts()) request.headers['Idempotency-Key'],
      ];
      expect(keys, ['id-1', 'id-2', 'id-2', 'id-3', 'id-4']);
    });

    test('服务端说时间不合法，翻成同一句人话', () async {
      final store = build(
        (_) => _json({
          'ok': false,
          'code': 'invalid_delay',
          'error': 'invalid_delay',
        }, 400),
      );

      final ok = await store.submit(
        amount: '10',
        unit: 'minutes',
        typedText: '到点提醒我',
      );

      expect(ok, isFalse);
      expect(store.status, '请输入 1 秒到 7 天之间的时间');
    });

    test('其它失败：报创建失败并带上原话', () async {
      final store = build(
        (_) => _json({'ok': false, 'code': 'x', 'error': '磁盘满了'}, 500),
      );

      await store.submit(amount: '10', unit: 'minutes', typedText: '到点提醒我');

      expect(store.status, '创建定时消息失败：磁盘满了');
      expect(store.statusIsError, isTrue);
    });

    test('拉列表失败：静默时不动状态行，不静默时贴红字', () async {
      final store = build(
        (_) => _json({'ok': false, 'code': 'x', 'error': '网络不通'}, 500),
      );

      await store.refresh(showError: false);
      expect(store.status, isEmpty);

      await store.refresh();
      expect(store.status, '读取定时消息失败：网络不通');
      expect(store.statusIsError, isTrue);
    });

    test('撤销成功就从列表里拿掉', () async {
      var listed = <Object>[_message(id: 'm1'), _message(id: 'm2')];
      final store = build((request) {
        if (request.method == 'DELETE') {
          listed = [_message(id: 'm2')];
          return _json({'ok': true});
        }
        return _listed(listed);
      });

      await store.refresh();
      expect(store.items.length, 2);

      await store.cancel(store.items.first);

      expect(_sent.last.method, 'DELETE');
      expect(store.items.single.id, 'm2');
      expect(store.status, isEmpty);
    });

    test('撤销失败：列表不动，红字说清哪一步坏了', () async {
      final store = build((request) {
        if (request.method == 'DELETE') {
          return _json({'ok': false, 'code': 'x', 'error': '撤不掉'}, 409);
        }
        return _listed([_message(id: 'm1')]);
      });

      await store.refresh();
      await store.cancel(store.items.single);

      expect(store.items.single.id, 'm1'); // 服务端说撤不掉就别装作撤掉了
      expect(store.status, '取消失败：撤不掉');
      expect(store.isCancelling('m1'), isFalse);
    });

    test('角标：99 条以上不数了', () async {
      final store = build(
        (_) => _listed([
          for (var i = 0; i < 120; i++) _message(id: 'm$i'),
        ]),
      );
      await store.refresh();
      expect(store.badgeText, '99+');
      expect(store.hasItems, isTrue);
    });

    test('空列表时没有角标也没有球', () async {
      final store = build((_) => _listed(const []));
      await store.refresh();
      expect(store.hasItems, isFalse);
      expect(store.badgeText, '0');
    });

    // 节拍：每秒推进一次 nowMs，每 refreshEveryTicks 拍回服务端对一次表。
    // flutter_test 的 FakeAsync 不会伪造 DateTime.now()，所以时钟从外面注入。
    testWidgets('1 秒一拍，每 15 拍对一次表', (tester) async {
      var nowMs = DateTime(2026, 9, 13, 12).millisecondsSinceEpoch;
      final store = build(
        (_) => _listed([_message(id: 'm1', dueAt: nowMs + 3600000)]),
        clock: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
      );

      store.start();
      await tester.pump(); // 首次对表落地
      expect(_sent.where((r) => r.method == 'GET').length, 1);
      expect(store.nowMs, nowMs);

      nowMs += 1000;
      await tester.pump(const Duration(seconds: 1));
      expect(store.nowMs, nowMs);
      // 还没到第 15 拍，不该再打服务端。
      expect(_sent.where((r) => r.method == 'GET').length, 1);

      for (var i = 0; i < 14; i++) {
        nowMs += 1000;
        await tester.pump(const Duration(seconds: 1));
      }
      await tester.pump();
      expect(_sent.where((r) => r.method == 'GET').length, 2);
      expect(store.nowMs, nowMs);

      store.dispose(); // 别把 periodic timer 留到测试结束时
    });
  });

  group('界面上看得见的那部分', () {
    ScheduledSendStore build(
      http.Response Function(http.Request request) reply, {
      DateTime Function()? clock,
    }) => ScheduledSendStore(
      service: ScheduledSendService(
        settings: settings,
        httpClient: _mock(reply),
      ),
      sessionId: 's1',
      clock: clock,
    );

    Widget host(Widget child) => MaterialApp(home: Scaffold(body: child));

    testWidgets('⏱ 平时没有角标，有待执行才挂条数', (tester) async {
      final store = build((_) => _listed(const []));
      await tester.pumpWidget(
        host(
          Row(
            children: [
              ScheduledSendButton(store: store, onTap: () {}),
            ],
          ),
        ),
      );
      expect(find.byKey(const Key('schedule-send-btn')), findsOneWidget);
      expect(find.byKey(const Key('schedule-send-badge')), findsNothing);

      await store.refresh();
      await tester.pump();
      expect(find.byKey(const Key('schedule-send-badge')), findsNothing);

      // 服务端现在有一条了。
      final withItems = build((_) => _listed([_message(id: 'm1')]));
      await withItems.refresh();
      await tester.pumpWidget(
        host(
          Row(
            children: [
              ScheduledSendButton(store: withItems, onTap: () {}),
            ],
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('schedule-send-badge')), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
    });

    testWidgets('面板：填好点创建 → 状态行说到点时刻，列表里出现一条', (tester) async {
      final at = DateTime(2026, 9, 13, 8, 5, 7).millisecondsSinceEpoch;
      var listed = <Object>[];
      final store = build((request) {
        if (request.method == 'GET') return _listed(listed);
        listed = [_message(id: 'm1', message: '到点提醒我', dueAt: at)];
        return _created(_message(id: 'm1', message: '到点提醒我', dueAt: at));
      });
      var cleared = false;

      await tester.pumpWidget(
        host(
          ScheduledSendPanel(
            store: store,
            onDraft: () => ScheduledSendDraft(
              text: '到点提醒我',
              clearAfterSchedule: () => cleared = true,
            ),
          ),
        ),
      );
      await tester.pump(); // 面板 initState 里那次对表 + prefs

      expect(find.text('暂无定时消息'), findsOneWidget);

      await tester.tap(find.byKey(const Key('schedule-send-create')));
      await tester.pump();
      await tester.pump();

      expect(find.text('已安排在 09/13 08:05:07 自动投递'), findsOneWidget);
      expect(find.byKey(const ValueKey('schedule-send-item-m1')), findsOneWidget);
      expect(find.byKey(const Key('schedule-send-empty')), findsNothing);
      // 排上队了，输入框得清干净。
      expect(cleared, isTrue);
    });

    testWidgets('面板：剩余时间挂着往下掉', (tester) async {
      final nowMs = DateTime(2026, 9, 13, 8).millisecondsSinceEpoch;
      final store = build(
        (_) => _listed([
          _message(id: 'm1', dueAt: nowMs + 62000),
        ]),
        clock: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
      );

      await tester.pumpWidget(host(ScheduledSendPanel(store: store)));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('schedule-send-remaining-m1')),
        findsOneWidget,
      );
      expect(find.text('2 分钟后'), findsOneWidget);
    });

    testWidgets('面板：撤销那一条', (tester) async {
      var listed = <Object>[_message(id: 'm1')];
      final store = build((request) {
        if (request.method == 'DELETE') {
          listed = const [];
          return _json({'ok': true});
        }
        return _listed(listed);
      });

      await tester.pumpWidget(host(ScheduledSendPanel(store: store)));
      await tester.pump();
      expect(find.byKey(const ValueKey('schedule-send-item-m1')), findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('schedule-send-cancel-m1')),
      );
      await tester.pump();
      await tester.pump();

      expect(find.byKey(const ValueKey('schedule-send-item-m1')), findsNothing);
      expect(find.text('暂无定时消息'), findsOneWidget);
    });

    testWidgets('悬浮球：没有待执行就不存在，有了才出现并带条数', (tester) async {
      final empty = build((_) => _listed(const []));
      await empty.refresh();
      await tester.pumpWidget(host(ScheduledSendDock(store: empty)));
      await tester.pump(); // prefs 落地
      expect(find.byKey(const Key('schedule-dock-icon')), findsNothing);

      final withItems = build(
        (_) => _listed([_message(id: 'm1'), _message(id: 'm2')]),
      );
      await withItems.refresh();
      await tester.pumpWidget(host(ScheduledSendDock(store: withItems)));
      await tester.pump();

      expect(find.byKey(const Key('schedule-dock-icon')), findsOneWidget);
      expect(find.byKey(const Key('schedule-dock-badge')), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('悬浮球：点开是同一块面板，点空白收起', (tester) async {
      final store = build((_) => _listed([_message(id: 'm1')]));
      await store.refresh();
      var expanded = false;

      await tester.pumpWidget(
        host(
          ScheduledSendDock(
            store: store,
            onExpandedChanged: (value) => expanded = value,
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.byKey(const Key('schedule-dock-icon')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('schedule-dock-panel')), findsOneWidget);
      expect(find.text('定时发送消息'), findsOneWidget);
      expect(expanded, isTrue);

      // 点面板外面那块空白 → 收起。
      await tester.tapAt(const Offset(20, 20));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('schedule-dock-panel')), findsNothing);
      expect(expanded, isFalse);
    });
  });
}
