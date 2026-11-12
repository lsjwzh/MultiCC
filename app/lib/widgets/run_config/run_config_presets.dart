// 自动线路池的本机预设。与 Web 的 multicc.autoProvider.presets.v1 兼容：
// 只存线路 id、车道、模型、挑选策略和子任务线路/模型（providerId + model，
// 不含任何密钥），也不存 allowCrossTrust（混池默认放行，套用时按池子重算）。
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/message.dart';
import '../../services/native_vendor_service.dart';
import '../../services/opencode_models_service.dart';
import '../../services/settings_service.dart';
import 'run_config_wire.dart';

const runConfigPresetKey = 'multicc.autoProvider.presets.v1';

/// 跨端共享的具名预设表（进程内缓存，原始 JSON）。会话 / 新任务的 Auto 池子
/// 只存线路池本身（外加可选的 `presetId`），药丸和 chip 要把它认回预设名 ——
/// 同 Web `public/run-config.js` 的 matchPreset / matchPresetName。名字只是
/// 展示：认不出来（预设删了、还没取回来、手搭的池子）就不说名字。
///
/// [RunConfigPresetStore] 每次 load / save / delete 都顺手刷新它；只要名字的
/// 地方（chip、新任务药丸）用 [refreshRunConfigPresetCatalog] 只读地补一次。
final ValueNotifier<List<Map<String, dynamic>>> runConfigPresetCatalog =
    ValueNotifier(const <Map<String, dynamic>>[]);

/// [replace] 为真时整表替换（store 刚拿到完整表），否则按 id 合并（本机缓存 +
/// 服务端两份来源，后到的覆盖同 id）。
void _rememberPresets(
  Iterable<Map<String, dynamic>> raw, {
  bool replace = true,
}) {
  final byId = <String, Map<String, dynamic>>{
    if (!replace)
      for (final item in runConfigPresetCatalog.value)
        (item['id'] ?? '').toString(): item,
  };
  for (final item in raw) {
    final id = (item['id'] ?? '').toString().trim();
    if (id.isEmpty) continue;
    byId[id] = Map<String, dynamic>.unmodifiable(item);
  }
  final next = List<Map<String, dynamic>>.unmodifiable(byId.values);
  if (jsonEncode(next) != jsonEncode(runConfigPresetCatalog.value)) {
    runConfigPresetCatalog.value = next;
  }
}

/// 预设指纹里的一行：只比真正决定路由的线路、模型、是否自动挑模型，外加优先级
/// 顺序；车道只在两边都写了时才比（老版编辑器存预设时会把 cli 丢掉）。
class _PoolRow {
  const _PoolRow(this.providerId, this.model, this.autoModel, this.cli);
  final String providerId;
  final String model;
  final bool autoModel;
  final String cli;

  bool same(_PoolRow other) =>
      providerId == other.providerId &&
      model == other.model &&
      autoModel == other.autoModel &&
      (cli.isEmpty || other.cli.isEmpty || cli == other.cli);
}

int _priorityOf(Object? value) =>
    value is num ? value.toInt() : (int.tryParse('${value ?? ''}') ?? 0);

List<_PoolRow> _rawPoolRows(Object? candidates) {
  if (candidates is! List) return const [];
  final rows = candidates.whereType<Map>().where((c) => c['enabled'] != false)
      .toList()
    ..sort((a, b) => _priorityOf(a['priority']).compareTo(_priorityOf(b['priority'])));
  return [
    for (final c in rows)
      _PoolRow(
        (c['providerId'] ?? '').toString().trim(),
        (c['model'] ?? '').toString().trim(),
        c['autoModel'] == true,
        (c['cli'] ?? '').toString().trim(),
      ),
  ];
}

List<_PoolRow> _selectionPoolRows(SessionProviderSelection selection) {
  final rows = selection.candidates.where((c) => c.enabled).toList()
    ..sort((a, b) => a.priority.compareTo(b.priority));
  return [
    for (final c in rows)
      _PoolRow(
        c.providerId.trim(),
        (c.model ?? '').trim(),
        c.autoModel,
        (c.cli ?? '').trim(),
      ),
  ];
}

bool _samePool(List<_PoolRow> left, List<_PoolRow> right) {
  if (left.length != right.length) return false;
  for (var i = 0; i < left.length; i += 1) {
    if (!left[i].same(right[i])) return false;
  }
  return true;
}

/// 池子是预设删过几条线路之后的样子：剩下的线路仍按原顺序出现在预设里。
bool _poolIsSubset(List<_PoolRow> pool, List<_PoolRow> preset) {
  var index = 0;
  for (final row in pool) {
    while (index < preset.length && !row.same(preset[index])) {
      index += 1;
    }
    if (index >= preset.length) return false;
    index += 1;
  }
  return pool.isNotEmpty;
}

/// 认出 [selection] 来自哪份预设（同 Web matchPreset）：`presetId` 最可靠
/// （预设后来改名或加减线路也还指着它）；老记录退回池子指纹；再退一步，池子
/// 是某份预设删过线路后的样子 —— 只有唯一命中才算，两份都包含它就宁可不说。
/// [presets] 缺省读 [runConfigPresetCatalog]。
Map<String, dynamic>? matchRunConfigPreset(
  SessionProviderSelection? selection, [
  List<Map<String, dynamic>>? presets,
]) {
  if (selection == null) return null;
  final named = [
    for (final item in presets ?? runConfigPresetCatalog.value)
      if (item['recent'] != true &&
          (item['name'] ?? '').toString().trim().isNotEmpty &&
          (item['id'] ?? '').toString().trim().isNotEmpty &&
          item['candidates'] is List)
        item,
  ];
  if (named.isEmpty) return null;
  final presetId = selection.presetId?.trim() ?? '';
  if (presetId.isNotEmpty) {
    for (final item in named) {
      if ((item['id'] ?? '').toString().trim() == presetId) return item;
    }
  }
  final pool = _selectionPoolRows(selection);
  if (pool.isEmpty) return null;
  for (final item in named) {
    if (_samePool(_rawPoolRows(item['candidates']), pool)) return item;
  }
  final containing = [
    for (final item in named)
      if (_poolIsSubset(pool, _rawPoolRows(item['candidates']))) item,
  ];
  return containing.length == 1 ? containing.single : null;
}

/// [selection] 对应的预设名；认不出来就是 null，由调用方退回原来的 Auto 说法。
String? runConfigPresetNameFor(
  SessionProviderSelection? selection, [
  List<Map<String, dynamic>>? presets,
]) {
  final hit = matchRunConfigPreset(selection, presets);
  final name = (hit?['name'] ?? '').toString().trim();
  return name.isEmpty ? null : name;
}

/// 保存时写进 providerSelection 的出处（同 Web presetProvenance）：用户明确
/// 套用过的那份优先，否则按池子认；都不中就不写，免得给手搭的池子凭空安名字。
String runConfigPresetProvenance(
  SessionProviderSelection selection,
  String activeId, [
  List<Map<String, dynamic>>? presets,
]) {
  final list = presets ?? runConfigPresetCatalog.value;
  final active = activeId.trim();
  if (active.isNotEmpty) {
    for (final item in list) {
      if (item['recent'] != true &&
          (item['name'] ?? '').toString().trim().isNotEmpty &&
          (item['id'] ?? '').toString().trim() == active) {
        return active;
      }
    }
  }
  return (matchRunConfigPreset(selection, list)?['id'] ?? '').toString().trim();
}

Future<void>? _catalogInflight;
DateTime? _catalogFetchedAt;

/// 只读地刷新 [runConfigPresetCatalog]：先读本机缓存（离线也认得出），再 GET
/// 服务端那份跨端共享的表。不 merge、不写回 —— 显示路径不该带写副作用。
/// 并发调用共用一趟请求；[maxAge] 内刚取过就不再取。任何失败都静默保留旧缓存。
Future<void> refreshRunConfigPresetCatalog({
  SettingsService? settings,
  http.Client? httpClient,
  Duration maxAge = const Duration(seconds: 20),
}) {
  final fetchedAt = _catalogFetchedAt;
  if (fetchedAt != null && DateTime.now().difference(fetchedAt) < maxAge) {
    return Future.value();
  }
  return _catalogInflight ??= _fetchPresetCatalog(settings, httpClient)
      .whenComplete(() {
        _catalogInflight = null;
        _catalogFetchedAt = DateTime.now();
      });
}

Future<void> _fetchPresetCatalog(
  SettingsService? settings,
  http.Client? httpClient,
) async {
  // 本机这份是 store 每次 load 时与服务端合并后落下来的，所以它就是「已知的
  // 全表」；服务端那份再按 id 盖上去（别处刚存 / 改名的预设）。整表替换而不是
  // 往旧缓存里累加 —— 别处删掉的预设不该一直被认出来。
  List<Map<String, dynamic>> local;
  try {
    local = await RunConfigPresetStore()._readRaw();
  } catch (_) {
    local = const [];
  }
  List<Map<String, dynamic>>? remote;
  if (settings != null) {
    try {
      final url = Uri.parse(settings.buildHttpUrl('/api/run-config/presets'));
      final headers = <String, String>{
        if (settings.token.isNotEmpty) 'X-Access-Token': settings.token,
      };
      final res =
          await (httpClient == null
                  ? http.get(url, headers: headers)
                  : httpClient.get(url, headers: headers))
              .timeout(const Duration(seconds: 8));
      if (res.statusCode >= 200 && res.statusCode < 300) {
        final decoded = jsonDecode(res.body);
        final presets = decoded is Map ? decoded['presets'] : null;
        if (presets is List) {
          remote = [
            for (final item in presets)
              if (item is Map) Map<String, dynamic>.from(item),
          ];
        }
      }
    } catch (_) {}
  }
  // 两边都没拿到东西（离线且本机没缓存）就别把已有的缓存清空。
  if (remote == null && local.isEmpty) return;
  _rememberPresets([...local, ...?remote]);
}

/// 测试之间清空进程内的预设缓存与节流状态。
@visibleForTesting
void resetRunConfigPresetCatalogForTest() {
  runConfigPresetCatalog.value = const <Map<String, dynamic>>[];
  _catalogInflight = null;
  _catalogFetchedAt = null;
}

class RunConfigPreset {
  const RunConfigPreset({
    required this.id,
    required this.name,
    required this.protocol,
    required this.rows,
    required this.pickOrder,
    required this.tiering,
    required this.maxAttempts,
    required this.sticky,
    required this.savedAt,
    this.preferMaxQuota = true,
    this.subagentProviderId = '',
    this.subagentModel = '',
  });

  final String id;
  final String name;
  final String protocol;
  final List<RunPoolRow> rows;
  final RunPickOrder pickOrder;
  final RunTiering tiering;
  final int maxAttempts;
  final bool sticky;
  final int savedAt;

  /// 额度优先：跟 sticky 一样属于池子的选线策略，随预设一起走。老预设没有
  /// 这个字段，读出来是开（true），和服务端的默认一致。
  final bool preferMaxQuota;

  /// 子任务线路（空 = 跟随主线路）+ 子任务模型（空 = 没设置子任务）。老预设
  /// 没有这一段，读出来就是两个空串 —— 等价于「跟随主线路」。
  final String subagentProviderId;
  final String subagentModel;

  List<RunPoolRow> copyRows() => [
    for (final row in rows)
      RunPoolRow(
        lane: row.lane,
        providerId: row.providerId,
        model: row.model,
        autoModel: row.autoModel,
        markedTier: row.markedTier,
      ),
  ];

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'protocol': protocol,
    'savedAt': savedAt,
    'pick': pickOrder == RunPickOrder.difficulty ? 'difficulty' : 'order',
    'tiering': tiering == RunTiering.jev ? 'price' : 'manual',
    'maxAttempts': maxAttempts,
    'sticky': sticky,
    'preferMaxQuota': preferMaxQuota,
    // 和 web 一样只在真有子任务时写这一段；只写线路 id + 模型。
    if (subagentModel.isNotEmpty)
      'subagent': {'providerId': subagentProviderId, 'model': subagentModel},
    'candidates': [
      for (var index = 0; index < rows.length; index++)
        {
          'providerId': rows[index].providerId,
          'cli': rows[index].lane,
          'model': rows[index].model.isEmpty ? null : rows[index].model,
          'priority': index + 1,
          if (rows[index].autoModel) 'autoModel': true,
          if (rows[index].markedTier != null)
            'tier': 't${rows[index].markedTier}',
        },
    ],
  };

  /// [fallbackLane]：candidate 没写 `cli`/`lane` 时用的车道。Web 的
  /// auto-provider-editor 写的预设就是这种形状（车道来自当前会话），原先会被
  /// 整条丢掉；[fallbackLane] 也为空时才判无效。
  static RunConfigPreset? fromJson(Object? raw, {String fallbackLane = ''}) {
    if (raw is! Map) return null;
    final name = (raw['name'] ?? '').toString().trim();
    final id = (raw['id'] ?? '').toString().trim();
    final protocol = (raw['protocol'] ?? '').toString();
    final candidates = raw['candidates'];
    if (name.isEmpty ||
        name.length > 60 ||
        id.isEmpty ||
        !const {'anthropic', 'openai_responses'}.contains(protocol) ||
        candidates is! List ||
        candidates.length < 2 ||
        candidates.length > 32) {
      return null;
    }
    final sorted = candidates.whereType<Map>().toList()
      ..sort(
        (a, b) => _int(a['priority'], 999).compareTo(_int(b['priority'], 999)),
      );
    if (sorted.length != candidates.length) return null;
    final rows = <RunPoolRow>[];
    for (final candidate in sorted) {
      final providerId = (candidate['providerId'] ?? '').toString().trim();
      var lane = (candidate['cli'] ?? candidate['lane'] ?? '').toString().trim();
      if (lane.isEmpty) lane = fallbackLane.trim();
      if (providerId.isEmpty || lane.isEmpty) return null;
      final tier = RegExp(
        r'^t([1-6])$',
      ).firstMatch('${candidate['tier'] ?? ''}');
      rows.add(
        RunPoolRow(
          lane: lane,
          providerId: providerId,
          model: (candidate['model'] ?? '').toString(),
          autoModel: candidate['autoModel'] == true,
          markedTier: tier == null ? null : int.parse(tier.group(1)!),
        ),
      );
    }
    final pick =
        raw['pick'] == 'difficulty' ||
            (raw['pick'] == null && rows.any((row) => row.markedTier != null))
        ? RunPickOrder.difficulty
        : RunPickOrder.order;
    // 老预设（web 与本 App 早先写的）没有 subagent 这一段：读不到就是「跟随
    // 主线路」，不补默认值也不算损坏。
    final subagent = raw['subagent'];
    final subagentModel = subagent is Map
        ? (subagent['model'] ?? '').toString().trim()
        : '';
    final subagentProviderId = subagentModel.isEmpty
        ? ''
        : (subagent is Map ? (subagent['providerId'] ?? '').toString().trim() : '');
    return RunConfigPreset(
      id: id,
      name: name,
      protocol: protocol,
      rows: rows,
      pickOrder: pick,
      tiering: raw['tiering'] == 'manual' ? RunTiering.manual : RunTiering.jev,
      maxAttempts: _int(raw['maxAttempts'], 2).clamp(2, 4),
      sticky: raw['sticky'] != false,
    preferMaxQuota: raw['preferMaxQuota'] != false,
      savedAt: _int(raw['savedAt'], 0),
      subagentProviderId: subagentProviderId,
      subagentModel: subagentModel,
    );
  }

  static int _int(Object? value, int fallback) =>
      value is int ? value : int.tryParse('$value') ?? fallback;
}

/// 预设（或当前池子）里引用了「已经被删掉的供应商」的一条线路。
/// [label] 能直接摆进提示里：id 前 8 位 + 车道（如 `ff06af1b（claude-exp）`）。
class RunPresetMissingLine {
  const RunPresetMissingLine({
    required this.providerId,
    required this.lane,
    required this.label,
  });

  final String providerId;
  final String lane;
  final String label;
}

/// 找出 [rows] 里供应商已经不在对应车道目录中的线路。同 Web
/// `missingProviderLines`，三处共用：保存/更新预设、预设列表的失效标记、
/// 套用被拦时的提示。
///
/// 两类行不算：
///   · 原生线路（OpenCode 原生 / 厂商原生）没有 MultiCC 供应商记录，本来就不在
///     目录里；
///   · 车道目录没取到（[pools] 里没有这条车道，或值是 null）时跳过 —— 拿不到
///     目录不等于线路被删，宁可漏报也别把整池标红。
List<RunPresetMissingLine> missingPresetProviderLines(
  Iterable<RunPoolRow> rows,
  Map<String, List<Map<String, dynamic>>?> pools,
) {
  final out = <RunPresetMissingLine>[];
  final seen = <String>{};
  for (final row in rows) {
    final providerId = row.providerId.trim();
    final lane = row.lane.trim();
    if (providerId.isEmpty || lane.isEmpty) continue;
    if (isVendorNativeProvider(providerId) ||
        isOpenCodeNativeProvider(providerId)) {
      continue;
    }
    final pool = pools[lane];
    if (pool == null) continue;
    final found = pool.any((item) {
      if ((item['id'] ?? '').toString() != providerId) return false;
      final clis = item['compatibleClis'];
      return clis is! List || clis.contains(lane);
    });
    if (found) continue;
    if (!seen.add('$lane\n$providerId')) continue;
    final short = providerId.length > 8
        ? providerId.substring(0, 8)
        : providerId;
    out.add(
      RunPresetMissingLine(
        providerId: providerId,
        lane: lane,
        label: '$short（$lane）',
      ),
    );
  }
  return out;
}

class RunConfigPresetStore {
  /// [settings] / [httpClient] 给了就把预设同步到服务端（Web 与 App 共用一份
  /// 表）；不给就是纯本机存储，老调用方与测试不受影响。[fallbackLane] 用来补
  /// Web 写的、candidate 没带 cli 的预设。
  RunConfigPresetStore({
    this.settings,
    this.httpClient,
    this.fallbackLane = '',
  });

  final SettingsService? settings;

  /// Injectable for tests (MockClient); null 时走 package 级 http 函数。
  final http.Client? httpClient;
  final String fallbackLane;

  static const _timeout = Duration(seconds: 8);

  Map<String, String> _headers() {
    final h = <String, String>{'Content-Type': 'application/json'};
    final token = settings?.token ?? '';
    if (token.isNotEmpty) h['X-Access-Token'] = token;
    return h;
  }

  Future<http.Response> _send(
    String method,
    String path,
    Map<String, dynamic> body,
  ) {
    final url = Uri.parse(settings!.buildHttpUrl(path));
    final encoded = jsonEncode(body);
    final client = httpClient;
    if (client == null) {
      return switch (method) {
        'PUT' => http.put(url, headers: _headers(), body: encoded),
        _ => http.post(url, headers: _headers(), body: encoded),
      };
    }
    return switch (method) {
      'PUT' => client.put(url, headers: _headers(), body: encoded),
      _ => client.post(url, headers: _headers(), body: encoded),
    };
  }

  /// 读 SharedPreferences 里的**原始** JSON 数组。保留整条对象（含 Web 写入
  /// 的 recent 等未知字段），只在写回时原样带过去。
  Future<List<Map<String, dynamic>>> _readRaw() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(runConfigPresetKey);
    if (stored == null || stored.length > 200000) return const [];
    try {
      final raw = jsonDecode(stored);
      if (raw is! List) return const [];
      return [
        for (final item in raw)
          if (item is Map) Map<String, dynamic>.from(item),
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<bool> _writeRaw(List<Map<String, dynamic>> raw) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.setString(runConfigPresetKey, jsonEncode(raw));
  }

  List<RunConfigPreset> _parse(List<Map<String, dynamic>> raw) => [
    for (final item in raw)
      if (RunConfigPreset.fromJson(item, fallbackLane: fallbackLane)
          case final preset?)
        preset,
  ];

  /// 把本机原始数组并入服务端，返回合并后的完整表；任何失败（没 settings、
  /// 网络错、非 2xx、body 不是预期形状）都返回 null，调用方退回本地。
  Future<List<Map<String, dynamic>>?> _mergeWithServer(
    List<Map<String, dynamic>> local,
  ) async {
    if (settings == null) return null;
    try {
      final res = await _send(
        'POST',
        '/api/run-config/presets/merge',
        {'presets': local},
      ).timeout(_timeout);
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      final decoded = jsonDecode(res.body);
      if (decoded is! Map) return null;
      final presets = decoded['presets'];
      if (presets is! List) return null;
      return [
        for (final item in presets)
          if (item is Map) Map<String, dynamic>.from(item),
      ];
    } catch (_) {
      return null;
    }
  }

  /// 本地先读，再（可选）与服务端合并并把结果落回本地。服务端不可用时只用本地。
  Future<List<Map<String, dynamic>>> _loadRaw() async {
    final local = await _readRaw();
    final merged = await _mergeWithServer(local);
    if (merged == null) {
      _rememberPresets(local, replace: false);
      return local;
    }
    await _writeRaw(merged);
    _rememberPresets(merged);
    return merged;
  }

  /// 整表 PUT；失败静默忽略 —— 本地已经生效，服务端下次 load 会再合并。
  Future<void> _pushToServer(List<Map<String, dynamic>> raw) async {
    if (settings == null) return;
    try {
      await _send(
        'PUT',
        '/api/run-config/presets',
        {'presets': raw},
      ).timeout(_timeout);
    } catch (_) {}
  }

  Future<List<RunConfigPreset>> load() async => _parse(await _loadRaw());

  Future<List<RunConfigPreset>> save(RunConfigPreset preset) async {
    // 用原始数组做增删：保留下来的条目原样回到盘上（recent / 未知字段不丢）。
    final previous = await _loadRaw();
    final name = preset.name.toLowerCase();
    final nextRaw = [
      preset.toJson(),
      for (final item in previous)
        if ((item['id'] ?? '').toString() != preset.id &&
            (item['name'] ?? '').toString().toLowerCase() != name)
          item,
    ].take(20).toList();
    final next = _parse(nextRaw);
    if (!await _writeRaw(nextRaw)) {
      throw StateError('preset storage unavailable');
    }
    _rememberPresets(nextRaw);
    await _pushToServer(nextRaw);
    return next;
  }

  Future<List<RunConfigPreset>> delete(String id) async {
    final nextRaw = [
      for (final item in await _loadRaw())
        if ((item['id'] ?? '').toString() != id) item,
    ];
    final next = _parse(nextRaw);
    if (!await _writeRaw(nextRaw)) {
      throw StateError('preset storage unavailable');
    }
    _rememberPresets(nextRaw);
    await _pushToServer(nextRaw);
    return next;
  }
}
