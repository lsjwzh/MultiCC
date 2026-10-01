// 自动线路池的本机预设。与 Web 的 multicc.autoProvider.presets.v1 兼容：
// 只存线路 id、车道、模型、挑选策略和子任务线路/模型（providerId + model，
// 不含任何密钥），也不存 allowCrossTrust（混池默认放行，套用时按池子重算）。
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

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

  static RunConfigPreset? fromJson(Object? raw) {
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
      final lane = (candidate['cli'] ?? candidate['lane'] ?? '')
          .toString()
          .trim();
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
      savedAt: _int(raw['savedAt'], 0),
      subagentProviderId: subagentProviderId,
      subagentModel: subagentModel,
    );
  }

  static int _int(Object? value, int fallback) =>
      value is int ? value : int.tryParse('$value') ?? fallback;
}

class RunConfigPresetStore {
  Future<List<RunConfigPreset>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(runConfigPresetKey);
    if (stored == null || stored.length > 200000) return const [];
    try {
      final raw = jsonDecode(stored);
      if (raw is! List) return const [];
      return [
        for (final item in raw)
          if (RunConfigPreset.fromJson(item) case final preset?) preset,
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<List<RunConfigPreset>> save(RunConfigPreset preset) async {
    final previous = await load();
    final name = preset.name.toLowerCase();
    final next = [
      preset,
      for (final item in previous)
        if (item.id != preset.id && item.name.toLowerCase() != name) item,
    ].take(20).toList();
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setString(
      runConfigPresetKey,
      jsonEncode([for (final item in next) item.toJson()]),
    )) {
      throw StateError('preset storage unavailable');
    }
    return next;
  }

  Future<List<RunConfigPreset>> delete(String id) async {
    final next = [
      for (final item in await load())
        if (item.id != id) item,
    ];
    final prefs = await SharedPreferences.getInstance();
    if (!await prefs.setString(
      runConfigPresetKey,
      jsonEncode([for (final item in next) item.toJson()]),
    )) {
      throw StateError('preset storage unavailable');
    }
    return next;
  }
}
