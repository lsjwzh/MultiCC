import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/run_config/run_config_presets.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';

// 本机缓存 + 服务端同步的预设存储。服务端契约：
// GET/PUT /api/run-config/presets，POST /api/run-config/presets/merge。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> mockSettings([
    Map<String, Object> extra = const {},
  ]) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
      ...extra,
    });
    return SettingsService.getInstance();
  }

  Map<String, dynamic> presetJson({
    required String id,
    required String name,
    bool withCli = true,
    List<String> providerIds = const ['cheap', 'strong'],
    String? model,
  }) => {
    'id': id,
    'name': name,
    'protocol': 'anthropic',
    'pick': 'order',
    'tiering': 'price',
    'maxAttempts': 2,
    'sticky': true,
    'savedAt': 1,
    // App 不认识的字段：写回时必须原样保留。
    'recent': true,
    'candidates': [
      for (var index = 0; index < providerIds.length; index++)
        {
          'providerId': providerIds[index],
          if (withCli) 'cli': 'claude',
          'model': model,
          'priority': index + 1,
        },
    ],
  };

  http.Response jsonResponse(int status, Object body) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json'},
  );

  Future<List<dynamic>> storedRaw() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(runConfigPresetKey);
    if (raw == null) return const [];
    return jsonDecode(raw) as List<dynamic>;
  }

  test('candidate 缺 cli 时用 fallbackLane 解析', () async {
    SharedPreferences.setMockInitialValues({
      runConfigPresetKey: jsonEncode([
        presetJson(id: 'web', name: 'Web 预设', withCli: false),
      ]),
    });

    final store = RunConfigPresetStore(fallbackLane: 'codex');
    final presets = await store.load();

    expect(presets, hasLength(1));
    expect(presets.single.id, 'web');
    expect(presets.single.rows.map((row) => row.lane), ['codex', 'codex']);
    // fallbackLane 也没给时，缺车道依旧判无效。
    final strict = await RunConfigPresetStore().load();
    expect(strict, isEmpty);
  });

  test('load 把本地条目 POST 到 merge，并用响应覆盖本地缓存', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([
        presetJson(id: 'local', name: '本机'),
      ]),
    });
    late http.Request mergeRequest;
    final store = RunConfigPresetStore(
      settings: settings,
      httpClient: MockClient((request) async {
        mergeRequest = request;
        return jsonResponse(200, {
          'ok': true,
          'presets': [
            presetJson(id: 'server', name: '服务端'),
            presetJson(id: 'local', name: '本机'),
          ],
        });
      }),
    );

    final presets = await store.load();

    expect(mergeRequest.method, 'POST');
    expect(mergeRequest.url.path, '/api/run-config/presets/merge');
    expect(mergeRequest.headers['x-access-token'], 'secret');
    final sent = jsonDecode(mergeRequest.body) as Map<String, dynamic>;
    expect((sent['presets'] as List).map((item) => item['id']), ['local']);

    // 返回给 UI 的是合并后的表，本机缓存也被覆盖。
    expect(presets.map((preset) => preset.id), ['server', 'local']);
    final cached = await storedRaw();
    expect(cached.map((item) => item['id']), ['server', 'local']);
  });

  test('网络失败时 load 退回本地且不改缓存', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([
        presetJson(id: 'local', name: '本机'),
      ]),
    });
    final store = RunConfigPresetStore(
      settings: settings,
      httpClient: MockClient(
        (_) async => throw http.ClientException('offline'),
      ),
    );

    final presets = await store.load();

    expect(presets.map((preset) => preset.id), ['local']);
    final cached = await storedRaw();
    expect(cached.map((item) => item['id']), ['local']);
    // 原始未知字段没有被解析再回写抹掉。
    expect(cached.single['recent'], isTrue);
  });

  test('save PUT 完整列表：同名（大小写不敏感）覆盖、最多 20 条', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([
        presetJson(id: 'old', name: 'Alpha'),
        presetJson(id: 'beta', name: 'Beta'),
      ]),
    });
    late http.Request putRequest;
    final store = RunConfigPresetStore(
      settings: settings,
      httpClient: MockClient((request) async {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        if (request.method == 'POST') {
          // merge：服务端原样保留本机条目。
          return jsonResponse(200, {'ok': true, 'presets': body['presets']});
        }
        putRequest = request;
        return jsonResponse(200, {'ok': true, 'presets': body['presets']});
      }),
    );

    final saved = await store.save(
      RunConfigPreset(
        id: 'new',
        name: 'alpha',
        protocol: 'anthropic',
        rows: [
          RunPoolRow(lane: 'claude', providerId: 'cheap'),
          RunPoolRow(lane: 'claude', providerId: 'strong'),
        ],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: true,
        savedAt: 2,
      ),
    );

    expect(saved.map((preset) => preset.id), ['new', 'beta']);
    expect(putRequest.method, 'PUT');
    expect(putRequest.url.path, '/api/run-config/presets');
    final sent = jsonDecode(putRequest.body) as Map<String, dynamic>;
    final ids = (sent['presets'] as List).map((item) => item['id']).toList();
    expect(ids, ['new', 'beta']);

    // PUT 的是完整表，本机缓存同步更新，Beta 的未知字段原样保留。
    final cached = await storedRaw();
    expect(cached.map((item) => item['id']), ['new', 'beta']);
    expect(cached[1]['recent'], isTrue);
  });

  test('save 只保留最多 20 条', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([
        for (var index = 0; index < 25; index++)
          presetJson(id: 'p$index', name: '预设 $index'),
      ]),
    });
    final store = RunConfigPresetStore(
      settings: settings,
      httpClient: MockClient((request) async {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        return jsonResponse(200, {'ok': true, 'presets': body['presets']});
      }),
    );

    final saved = await store.save(
      RunConfigPreset(
        id: 'new',
        name: '新预设',
        protocol: 'anthropic',
        rows: [
          RunPoolRow(lane: 'claude', providerId: 'cheap'),
          RunPoolRow(lane: 'claude', providerId: 'strong'),
        ],
        pickOrder: RunPickOrder.order,
        tiering: RunTiering.jev,
        maxAttempts: 2,
        sticky: true,
        savedAt: 2,
      ),
    );

    expect(saved, hasLength(20));
    expect(saved.first.id, 'new');
  });

  test('delete 从本地移除并 PUT 剩余列表', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([
        presetJson(id: 'a', name: 'A'),
        presetJson(id: 'b', name: 'B'),
      ]),
    });
    late http.Request putRequest;
    final store = RunConfigPresetStore(
      settings: settings,
      httpClient: MockClient((request) async {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        if (request.method == 'POST') {
          return jsonResponse(200, {'ok': true, 'presets': body['presets']});
        }
        putRequest = request;
        return jsonResponse(200, {'ok': true, 'presets': body['presets']});
      }),
    );

    final remaining = await store.delete('a');

    expect(remaining.map((preset) => preset.id), ['b']);
    expect(putRequest.method, 'PUT');
    final sent = jsonDecode(putRequest.body) as Map<String, dynamic>;
    expect(
      (sent['presets'] as List).map((item) => item['id']),
      ['b'],
    );
    final cached = await storedRaw();
    expect(cached.map((item) => item['id']), ['b']);
  });
}
