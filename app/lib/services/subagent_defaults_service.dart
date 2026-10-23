// 子 agent（subagent）默认线路的服务端读写。
//
// 服务端契约：
//   GET  /api/subagent-defaults            → { ok, defaults: { claude, codex } }
//   POST /api/subagent-defaults/sync       → { ok, dryRun, family, subagent, defaults,
//                                             counts: { applied, deferred, unchanged, skipped },
//                                             sessions: [...], truncated }
//
// 家族只有 claude / codex 两族。`subagent: null` = 跟随主线路：清掉该家族每个任务
// 的覆盖，也清掉家族默认。忙碌的任务下轮生效（deferred）。
//
// 503 + code=rust_backend_unavailable 表示服务端还没重启到带 native 模块的版本 ——
// 这不是用户能自己修的错误，面板要收起开关并明说「需要手动重启服务端」。
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';

/// 车道 id → 家族 id（服务端 defaults 的 key）。只有 claude / codex 两族有子 agent。
String? subagentFamilyOf(String? cli) {
  final lane = tryParseCli((cli ?? '').trim());
  if (lane == null) return null;
  if (lane.isClaudeFamily) return 'claude';
  if (lane.isCodexFamily) return 'codex';
  return null;
}

/// 家族在界面上的说法（和服务端 display 对齐：Claude Code / Codex）。
String? subagentFamilyLabel(String? cli) => switch (subagentFamilyOf(cli)) {
  'claude' => 'Claude Code',
  'codex' => 'Codex',
  _ => null,
};

/// 服务端那份 `{providerId, model}`：两截都得有才算一套设置（只挑线路不挑模型 =
/// 没设，和面板里的折算同一个口径）。
SessionSubagent? parseSubagentValue(Object? raw) {
  if (raw is! Map) return null;
  final providerId = (raw['providerId'] ?? '').toString().trim();
  final model = (raw['model'] ?? '').toString().trim();
  if (providerId.isEmpty || model.isEmpty) return null;
  return SessionSubagent(providerId: providerId, model: model);
}

/// `defaults` 块 → 家族 → 设置（缺的家族是 null = 随主线路）。
Map<String, SessionSubagent?> parseSubagentDefaults(Object? raw) {
  final out = <String, SessionSubagent?>{
    for (final family in const ['claude', 'codex']) family: null,
  };
  if (raw is! Map) return out;
  for (final family in const ['claude', 'codex']) {
    out[family] = parseSubagentValue(raw[family]);
  }
  return out;
}

/// 同步接口还没在这个服务端上生效（native 模块要重启才加载）。调用方据此收起
/// 开关并提示「手动重启」，而不是无限重试。
class SubagentSyncUnavailable implements Exception {
  const SubagentSyncUnavailable([
    this.message = '子 agent 同步需要重启 MultiCC 服务端后才能启用',
  ]);

  final String message;

  @override
  String toString() => message;
}

/// 一次同步（或 dry run）的回执。
class SubagentSyncResult {
  const SubagentSyncResult({
    required this.dryRun,
    required this.family,
    required this.subagent,
    required this.defaults,
    required this.applied,
    required this.deferred,
    required this.unchanged,
    required this.skipped,
    required this.sessionCount,
    required this.truncated,
  });

  final bool dryRun;
  final String? family;

  /// 这次同步写下去的那套设置；null = 随主线路。
  final SessionSubagent? subagent;

  /// 同步之后的家族默认（同一次回执里带回来，面板直接换掉本地那份）。
  final Map<String, SessionSubagent?> defaults;

  final int applied;
  final int deferred;
  final int unchanged;
  final int skipped;
  final int sessionCount;
  final bool truncated;

  /// 会被改掉的任务数：立刻生效 + 忙碌、下轮生效。
  int get changes => applied + deferred;

  factory SubagentSyncResult.fromJson(Map<String, dynamic> json) {
    final counts = json['counts'] is Map ? json['counts'] as Map : const {};
    int count(String key) {
      final raw = counts[key];
      if (raw is num) return raw.toInt();
      return int.tryParse('${raw ?? ''}') ?? 0;
    }

    final sessions = json['sessions'];
    return SubagentSyncResult(
      dryRun: json['dryRun'] == true,
      family: json['family']?.toString(),
      subagent: parseSubagentValue(json['subagent']),
      defaults: parseSubagentDefaults(json['defaults']),
      applied: count('applied'),
      deferred: count('deferred'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
      sessionCount: sessions is List ? sessions.length : 0,
      truncated: json['truncated'] == true,
    );
  }
}

class SubagentDefaultsService {
  SubagentDefaultsService({required this.settings, this.httpClient});

  final SettingsService settings;

  /// Injectable for tests (MockClient); production callers leave it null and
  /// requests go through the package-level `http` functions.
  final http.Client? httpClient;

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  Future<http.Response> _send(String method, String path, {Object? body}) {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final headers = _headers;
    final client = httpClient;
    final call = switch (method) {
      'GET' =>
        client == null
            ? http.get(uri, headers: headers)
            : client.get(uri, headers: headers),
      'POST' =>
        client == null
            ? http.post(uri, headers: headers, body: body)
            : client.post(uri, headers: headers, body: body),
      _ => throw ArgumentError.value(method, 'method', '不支持的方法'),
    };
    return call.timeout(const Duration(seconds: 15));
  }

  /// 当前家族默认。网络/服务端不可用时抛异常（面板吞掉，按「没有默认」显示）。
  Future<Map<String, SessionSubagent?>> fetchDefaults() async {
    final res = await _send('GET', '/api/subagent-defaults');
    if (res.statusCode >= 400) _throw(res);
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    return parseSubagentDefaults(body is Map ? body['defaults'] : null);
  }

  /// 把一套设置同步到该家族的全部任务，并写成之后新建任务的家族默认。
  /// [dryRun] 只统计不落盘（勾选「同步」时先跑一次）。
  Future<SubagentSyncResult> sync({
    required String cli,
    required SessionSubagent? subagent,
    bool dryRun = false,
  }) async {
    final res = await _send(
      'POST',
      '/api/subagent-defaults/sync',
      body: jsonEncode({
        'cli': cli,
        'subagent': subagent == null
            ? null
            : {
                'providerId': subagent.providerId ?? '',
                'model': subagent.model ?? '',
              },
        if (dryRun) 'dryRun': true,
      }),
    );
    if (res.statusCode >= 400) _throw(res);
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    if (body is! Map) throw Exception('子 agent 同步返回了无法识别的响应');
    return SubagentSyncResult.fromJson(body.cast<String, dynamic>());
  }

  Never _throw(http.Response res) {
    String? error;
    String? code;
    try {
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is Map) {
        error = body['error']?.toString();
        code = body['code']?.toString();
      }
    } catch (_) {}
    if (res.statusCode == 503 && code == 'rust_backend_unavailable') {
      throw const SubagentSyncUnavailable();
    }
    final detail = error?.trim().isNotEmpty == true
        ? error!
        : 'HTTP ${res.statusCode}${code == null ? '' : ' ($code)'}';
    throw Exception(detail);
  }
}
