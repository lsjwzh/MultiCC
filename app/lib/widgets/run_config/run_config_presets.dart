// 自动线路池的本机预设。与 Web 的 multicc.autoProvider.presets.v1 兼容：
// 只存线路 id、车道、模型、挑选策略和子任务线路/模型（providerId + model，
// 不含任何密钥），也不存 allowCrossTrust（混池默认放行，套用时按池子重算）。
library;

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../../services/settings_service.dart';
import 'run_config_wire.dart';

const runConfigPresetKey = 'multicc.autoProvider.presets.v1';

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
    if (merged == null) return local;
    await _writeRaw(merged);
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
    await _pushToServer(nextRaw);
    return next;
  }
}
