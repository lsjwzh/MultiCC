import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/run_config/run_config_presets.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';

// 本机缓存 + 服务端同步的预设存储。服务端契约：
// GET/PUT /api/run-config/presets，POST /api/run-config/presets/merge。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // 预设名缓存是进程内的：每个用例从空表起步。
  setUp(resetRunConfigPresetCatalogForTest);

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

  // 具名预设（presetJson 默认带 recent —— 那是 Web 的「最近用过」，不参与认名）。
  Map<String, dynamic> namedPreset({
    required String id,
    required String name,
    bool withCli = true,
    List<String> providerIds = const ['cheap', 'strong'],
  }) => presetJson(
    id: id,
    name: name,
    withCli: withCli,
    providerIds: providerIds,
  )..remove('recent');

  // ── 认出池子来自哪份预设（App 的线路药丸 / chip 要说预设名） ──────────────

  SessionProviderSelection selectionOf(
    List<String> providerIds, {
    String? presetId,
    String? model,
    String cli = 'claude',
  }) => SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      for (var index = 0; index < providerIds.length; index++)
        SessionProviderCandidate(
          providerId: providerIds[index],
          model: model,
          priority: index + 1,
          cli: cli,
        ),
    ],
    maxAttempts: 2,
    presetId: presetId,
  );

  test('认预设：presetId 优先（改过名、换过线路也认得出）', () {
    final presets = [
      namedPreset(id: 'p1', name: '日常', providerIds: ['a', 'b']),
      namedPreset(id: 'p2', name: '省钱', providerIds: ['c', 'd']),
    ];
    // 池子已经和 p1 对不上了，但 presetId 还指着它。
    expect(
      runConfigPresetNameFor(selectionOf(['x', 'y'], presetId: 'p1'), presets),
      '日常',
    );
    // presetId 指着已删的预设：退回池子指纹。
    expect(
      runConfigPresetNameFor(selectionOf(['c', 'd'], presetId: 'gone'), presets),
      '省钱',
    );
    expect(
      runConfigPresetNameFor(selectionOf(['x', 'y'], presetId: 'gone'), presets),
      isNull,
      reason: '预设删了、池子也对不上：不编名字',
    );
    expect(runConfigPresetNameFor(null, presets), isNull);
  });

  test('认预设：老数据没有 presetId，按池子指纹认；车道只在两边都写了才比', () {
    final presets = [
      // Web 老编辑器存的预设没有 cli。
      namedPreset(id: 'web', name: 'Web 预设', withCli: false),
    ];
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong']), presets), 'Web 预设');
    expect(
      runConfigPresetNameFor(selectionOf(['strong', 'cheap']), presets),
      isNull,
      reason: '顺序也是池子的一部分',
    );
    final withCli = [namedPreset(id: 'p', name: '带车道')];
    expect(
      runConfigPresetNameFor(selectionOf(['cheap', 'strong'], cli: 'codex'), withCli),
      isNull,
      reason: '两边都写了车道就得一致',
    );
  });

  test('认预设：删过线路的池子只在唯一包含它时才认', () {
    final one = [
      namedPreset(id: 'p1', name: '三条', providerIds: ['a', 'b', 'c']),
    ];
    expect(runConfigPresetNameFor(selectionOf(['a', 'c']), one), '三条');
    final two = [
      ...one,
      namedPreset(id: 'p2', name: '另一份', providerIds: ['a', 'c', 'd']),
    ];
    expect(
      runConfigPresetNameFor(selectionOf(['a', 'c']), two),
      isNull,
      reason: '两份预设都包含它就宁可不说名字',
    );
  });

  test('认预设：「最近用过」和没名字的条目不算预设', () {
    final presets = [
      {...namedPreset(id: 'r', name: '最近'), 'recent': true},
      namedPreset(id: 'n', name: '具名', providerIds: ['x', 'y']),
    ];
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong'], presetId: 'r'), presets), isNull);
  });

  test('出处：套用过的优先；没套用就按池子认；都不中不写', () {
    final presets = [
      namedPreset(id: 'p1', name: '日常'),
      namedPreset(id: 'p2', name: '别的', providerIds: ['x', 'y']),
    ];
    final pool = selectionOf(['cheap', 'strong']);
    expect(runConfigPresetProvenance(pool, 'p2', presets), 'p2');
    expect(runConfigPresetProvenance(pool, '', presets), 'p1');
    expect(runConfigPresetProvenance(pool, 'deleted', presets), 'p1');
    expect(runConfigPresetProvenance(selectionOf(['m', 'n']), '', presets), '');
  });

  test('名字缓存：只读刷新 = 本机 + 服务端 GET，不 merge 也不 PUT', () async {
    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([namedPreset(id: 'local', name: '本机')]),
    });
    final calls = <String>[];
    final client = MockClient((request) async {
      calls.add('${request.method} ${request.url.path}');
      expect(request.headers['X-Access-Token'], 'secret');
      return jsonResponse(200, {
        'ok': true,
        'presets': [
          namedPreset(id: 'remote', name: '服务端', providerIds: ['x', 'y']),
        ],
      });
    });

    await refreshRunConfigPresetCatalog(settings: settings, httpClient: client);

    expect(calls, ['GET /api/run-config/presets']);
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong'])), '本机');
    expect(runConfigPresetNameFor(selectionOf(['x', 'y'])), '服务端');
    // 节流：刚取过就不再取。
    await refreshRunConfigPresetCatalog(settings: settings, httpClient: client);
    expect(calls, hasLength(1));
  });

  test('名字缓存：服务端不可用时用本机那份；store 存 / 删会同步刷新', () async {
    SharedPreferences.setMockInitialValues({});
    final store = RunConfigPresetStore();
    final preset = RunConfigPreset.fromJson(namedPreset(id: 'p1', name: '日常'))!;
    await store.save(preset);
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong'])), '日常');
    await store.delete('p1');
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong'])), isNull);

    final settings = await mockSettings({
      runConfigPresetKey: jsonEncode([namedPreset(id: 'p2', name: '离线')]),
    });
    final client = MockClient((request) async => jsonResponse(503, {}));
    await refreshRunConfigPresetCatalog(settings: settings, httpClient: client);
    expect(runConfigPresetNameFor(selectionOf(['cheap', 'strong'])), '离线');
  });

  test('退役车道 claude-exp 读成 claude：套用不再被判车道不可用，写回只写新 id', () async {
    // 11-10 之后服务端不再下发 claude-exp 的可用性；老预设（cnmodel）里存的
    // 还是旧 id，按原样比对会在非 claude 会话里被拒绝套用。
    final raw = presetJson(id: 'cn', name: 'cnmodel')..remove('recent');
    (raw['candidates'] as List)[0]['cli'] = 'claude-exp';
    (raw['candidates'] as List)[1]['cli'] = ' claude-exp ';
    final parsed = RunConfigPreset.fromJson(raw)!;
    expect(parsed.rows.map((row) => row.lane), ['claude', 'claude']);
    expect(jsonEncode(parsed.toJson()), isNot(contains('claude-exp')));
    // fallbackLane 也走同一条规则（旧会话仍可能以 claude-exp 打开面板）。
    final viaFallback = RunConfigPreset.fromJson(
      presetJson(id: 'web', name: 'Web', withCli: false),
      fallbackLane: 'claude-exp',
    )!;
    expect(viaFallback.rows.map((row) => row.lane), ['claude', 'claude']);
    // 指纹认预设：旧 id 的预设和新 id 的会话池子算同一份。
    final legacy = [
      {...raw, 'presetId': null},
    ];
    expect(
      runConfigPresetNameFor(selectionOf(['cheap', 'strong']), legacy),
      'cnmodel',
    );
    expect(
      runConfigPresetNameFor(
        selectionOf(['cheap', 'strong'], cli: 'claude-exp'),
        [presetJson(id: 'n', name: '新预设')..remove('recent')],
      ),
      '新预设',
    );
  });

  test('missingPresetProviderLines：只报目录里确实没了的托管线路', () {
    final pools = <String, List<Map<String, dynamic>>>{
      'claude-exp': [
        {'id': 'alive'},
        // 供应商还在，但不给 claude-exp 用：跟被删了一样套不上。
        {
          'id': 'other',
          'compatibleClis': ['claude'],
        },
      ],
      'claude': [
        {'id': 'other'},
      ],
    };
    final missing = missingPresetProviderLines(
      [
        RunPoolRow(lane: 'claude-exp', providerId: 'alive'),
        RunPoolRow(lane: 'claude-exp', providerId: 'deadbeef01'),
        RunPoolRow(lane: 'claude-exp', providerId: 'cafebabe02'),
        RunPoolRow(lane: 'claude-exp', providerId: 'deadbeef01'),
        RunPoolRow(lane: 'claude-exp', providerId: 'other'),
        RunPoolRow(lane: 'claude', providerId: 'other'),
        // 原生线路没有供应商记录，不算失效。
        RunPoolRow(
          lane: 'opencode',
          providerId: 'opencode-native:opencode-go',
        ),
        RunPoolRow(
          lane: 'codebuddy',
          providerId: 'codebuddy-native:codebuddy',
        ),
        // 这条车道的目录没取到：未知，不报。
        RunPoolRow(lane: 'zcode', providerId: 'not-loaded'),
      ],
      pools,
    );
    expect(
      missing.map((line) => line.providerId),
      ['deadbeef01', 'cafebabe02', 'other'],
    );
    expect(
      missing.map((line) => line.label),
      ['deadbeef（claude-exp）', 'cafebabe（claude-exp）', 'other（claude-exp）'],
    );
    // 每条只报一次（同样 id 出现两次）。
    expect(missing, hasLength(3));

    expect(
      missingPresetProviderLines(
        [RunPoolRow(lane: 'zcode', providerId: 'x')],
        const {},
      ),
      isEmpty,
    );
  });
}
