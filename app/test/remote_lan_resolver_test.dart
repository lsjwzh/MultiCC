// 同一 Wi‑Fi 直连的探测：同网段过滤、startedAt 校验、超时回落、缓存与失效。
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/remote_lan_resolver.dart';

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: const {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('配置地址本身就是局域网/回环时不需要探测', () {
    expect(RemoteLanResolver.isLocalOrigin('http://192.168.1.5:3000'), isTrue);
    expect(RemoteLanResolver.isLocalOrigin('10.0.0.8'), isTrue);
    expect(RemoteLanResolver.isLocalOrigin('http://localhost:3000'), isTrue);
    expect(RemoteLanResolver.isLocalOrigin('http://127.0.0.1:9000'), isTrue);
    expect(RemoteLanResolver.isLocalOrigin('http://172.16.5.4:3000'), isTrue);
    expect(RemoteLanResolver.isLocalOrigin('https://example.com'), isFalse);
    expect(RemoteLanResolver.isLocalOrigin('http://8.8.8.8'), isFalse);
  });

  test('只采用同网段 + 同一服务进程（startedAt 一致）的局域网地址', () async {
    final requested = <String>[];
    final headers = <String, String?>{};
    final client = MockClient((request) async {
      requested.add('${request.url.host}:${request.url.port}');
      headers[request.url.host] = request.headers['X-Access-Token'];
      switch (request.url.host) {
        case 'vps.example.com':
          return _json({
            'product': 'multicc',
            'startedAt': '2026-10-25T10:00:00.000Z',
            'lanUrls': [
              'http://192.168.1.50:3000', // 同网段，同一个进程 → 采用
              'http://192.168.1.51:3000', // 同网段但 startedAt 不同 → 拒绝
              'http://10.0.0.9:3000', // 不同网段 → 连探测都不发
              'http://8.8.8.1:3000', // 公网地址 → 拒绝
            ],
          });
        case '192.168.1.50':
          return _json({'startedAt': '2026-10-25T10:00:00.000Z'});
        case '192.168.1.51':
          return _json({'startedAt': '2026-10-24T22:00:00.000Z'});
        default:
          return http.Response('not found', 404);
      }
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => ['192.168.1.10'],
    );
    addTearDown(resolver.close);

    final origin = await resolver.resolve(
      configuredHost: 'https://vps.example.com',
      token: 'secret-token',
    );

    expect(origin, 'http://192.168.1.50:3000');
    expect(
      requested,
      isNot(contains('10.0.0.9:3000')),
      reason: '不同网段的地址不能拿到令牌',
    );
    expect(requested, isNot(contains('8.8.8.1:3000')));
    expect(headers['192.168.1.50'], 'secret-token');
    expect(headers['vps.example.com'], 'secret-token');
  });

  test('startedAt 不一致（别的 Wi‑Fi 上同 IP 的陌生设备）→ 不采用', () async {
    final client = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        return _json({
          'startedAt': 'T1',
          'lanUrls': ['http://192.168.1.50:3000'],
        });
      }
      if (request.url.host == '192.168.1.50') {
        return _json({'startedAt': 'T2'});
      }
      return http.Response('', 404);
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => ['192.168.1.10'],
    );
    addTearDown(resolver.close);

    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      isNull,
    );
  });

  test('局域网探测超时（单个 1s / 总预算 1.2s）→ 立刻回落', () async {
    var landed = 0;
    final client = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        return _json({
          'startedAt': 'T1',
          'lanUrls': ['http://192.168.1.50:3000', 'http://192.168.1.51:3000'],
        });
      }
      landed += 1;
      // 永远回不来：靠 resolver 自己的预算收尾。
      await Future<void>.delayed(const Duration(milliseconds: 300));
      return _json({'startedAt': 'T1'});
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => ['192.168.1.10'],
      probeTimeout: const Duration(milliseconds: 60),
      totalBudget: const Duration(milliseconds: 80),
    );
    addTearDown(resolver.close);

    final watch = Stopwatch()..start();
    final origin = await resolver.resolve(
      configuredHost: 'https://vps.example.com',
      token: 't',
    );
    watch.stop();

    expect(origin, isNull);
    expect(landed, 2, reason: '两个候选是并行探测的');
    expect(
      watch.elapsedMilliseconds,
      lessThan(250),
      reason: '总预算内必须收尾，不能等每个候选自己的超时',
    );
  });

  test('探测结果按网卡指纹缓存；网络变了才重新探测', () async {
    var configuredCalls = 0;
    var lanCalls = 0;
    var local = ['192.168.1.10'];
    final client = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        configuredCalls += 1;
        return _json({
          'startedAt': 'T1',
          'lanUrls': ['http://192.168.1.50:3000'],
        });
      }
      lanCalls += 1;
      return _json({'startedAt': 'T1'});
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => local,
    );
    addTearDown(resolver.close);

    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      'http://192.168.1.50:3000',
    );
    expect(configuredCalls, 1);
    expect(lanCalls, 1);

    // 同一网络再问一次：命中缓存，一个请求都不发。
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      'http://192.168.1.50:3000',
    );
    expect(configuredCalls, 1);
    expect(lanCalls, 1);

    // 换了 Wi‑Fi（本机地址变了）：缓存失效，重新探测。
    local = ['10.9.9.10'];
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      isNull,
      reason: '192.168.1.50 与新的 10.9.9.0/24 不同网段',
    );
    expect(configuredCalls, 2);
    expect(lanCalls, 1, reason: '不同网段的候选根本不该被探测');
  });

  test('invalidate() 后重新探测；探测全败不采用', () async {
    var respond = false;
    var configuredCalls = 0;
    final client = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        configuredCalls += 1;
        return _json({
          'startedAt': 'T1',
          'lanUrls': ['http://192.168.1.50:3000'],
        });
      }
      if (!respond) return http.Response('', 503);
      return _json({'startedAt': 'T1'});
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => ['192.168.1.10'],
    );
    addTearDown(resolver.close);

    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      isNull,
    );
    resolver.invalidate();
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      isNull,
    );
    expect(configuredCalls, 2, reason: 'invalidate 之后必须重探');

    respond = true;
    resolver.invalidate();
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: 't'),
      'http://192.168.1.50:3000',
    );
  });

  test('配置地址不可达（server-info 拿不到）就不缓存结论', () async {
    var up = false;
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      if (!up) throw http.ClientException('unreachable');
      return _json({'startedAt': 'T1', 'lanUrls': const []});
    });
    final resolver = RemoteLanResolver(client: client);
    addTearDown(resolver.close);

    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: ''),
      isNull,
    );
    up = true;
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: ''),
      isNull,
    );
    expect(calls, 2, reason: '网络抖动不能变成「以后都不探」的缓存');
  });

  test('网络接口读不到时安静回落', () async {
    final client = MockClient((request) async {
      return _json({
        'startedAt': 'T1',
        'lanUrls': ['http://192.168.1.50:3000'],
      });
    });
    final resolver = RemoteLanResolver(
      client: client,
      localAddresses: () async => throw StateError('no interfaces'),
    );
    addTearDown(resolver.close);
    expect(
      await resolver.resolve(configuredHost: 'https://vps.example.com', token: ''),
      isNull,
    );
  });
}
