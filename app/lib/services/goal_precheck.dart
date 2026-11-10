import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// Goal 预检要等多久。
///
/// 只有一个来源：服务端 `/api/settings/goal` 公布的 `precheckWaitMs` —— 它拥有 Aux
/// 队列（并发池 + 一条严格顺序 lane，classify / memory_review 都在里面），只有它知
/// 道一次预检最多要排多久。客户端只在这个数字之上留一点余量，好让超时的时候用户看到的是服务端那句
/// 「辅助模型没返回，请检查配额或直接发送」，而不是一个裸的客户端 abort。
///
/// 为什么以前每次都失败：通用 HTTP 预算是 15s，而实测一次预检本身就要 ~18s（队列空闲
/// 时也是如此），排在有 classify 的队列后面就更久。
const int goalPrecheckFallbackWaitMs = 180000;
const int goalPrecheckClientSlackMs = 30000;

/// 服务端没给（旧服务端）就用兜底值；给了非法值也不许把预算缩到 0。
int goalPrecheckTimeoutMs(int? serverWaitMs) {
  final wait = (serverWaitMs != null && serverWaitMs > 0)
      ? serverWaitMs
      : goalPrecheckFallbackWaitMs;
  return wait + goalPrecheckClientSlackMs;
}

/// 预检的四个维度（服务端 `/api/settings/goal` 的 `dimensions`）。
const List<String> goalPrecheckDimensions = [
  'objective',
  'criteria',
  'scope',
  'executable',
];

/// 预检的全局配置：启用哪些维度、服务端公布的最长等待。
///
/// 无人值守沿用同一套配置：新任务表单和聊天里的「AI 补全判断标准」都先读它。
class GoalPrecheckConfig {
  final Map<String, bool> dimensions;
  final int? precheckWaitMs;

  const GoalPrecheckConfig({
    this.dimensions = const {
      'objective': true,
      'criteria': true,
      'scope': true,
      'executable': true,
    },
    this.precheckWaitMs,
  });

  /// 读取 `/api/settings/goal`。任何失败都吞掉（面板只是预检，不能因此用不了）。
  static Future<GoalPrecheckConfig> load({
    required SettingsService settings,
    http.Client? httpClient,
  }) async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final uri = Uri.parse(settings.buildHttpUrl('/api/settings/goal'));
      final client = httpClient;
      final res = await (client != null
              ? client.get(uri, headers: headers)
              : http.get(uri, headers: headers))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return const GoalPrecheckConfig();
      final data = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final wait = data['precheckWaitMs'];
      final rawDims = (data['dimensions'] as Map?) ?? const {};
      return GoalPrecheckConfig(
        dimensions: {
          for (final key in goalPrecheckDimensions) key: rawDims[key] != false,
        },
        precheckWaitMs: wait is num ? wait.toInt() : null,
      );
    } catch (_) {
      return const GoalPrecheckConfig();
    }
  }
}

/// 调用 `POST /api/goal/precheck {task, dimensions?}`。
///
/// 返回服务端的原始 JSON（成功时含 verdict/score/issues/questions/criteria/
/// revised）。失败也返回 `{ok:false, error}`，让调用方直接显示原因；预检永远不该
/// 挡住发送/启动。
Future<Map<String, dynamic>> requestGoalPrecheck({
  required SettingsService settings,
  required String task,
  Map<String, bool>? dimensions,
  http.Client? httpClient,
  int? precheckWaitMs,
}) async {
  try {
    final uri = Uri.parse(settings.buildHttpUrl('/api/goal/precheck'));
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    final client = httpClient;
    final body = jsonEncode({
      'task': task,
      if (dimensions != null) 'dimensions': dimensions,
    });
    final res = await (client != null
            ? client.post(uri, headers: headers, body: body)
            : http.post(uri, headers: headers, body: body))
        // The server queues this behind other Aux work and then gives the
        // model its own budget; this waits for that budget plus slack, so the
        // server's explicit AUX_TIMEOUT message wins the race instead of a
        // bare client abort.
        .timeout(Duration(milliseconds: goalPrecheckTimeoutMs(precheckWaitMs)));
    if (res.statusCode != 200) {
      // The goal routes answer with JSON on every branch, so prefer the
      // server's own words over a bare status code.
      String detail = '';
      try {
        final errorBody = jsonDecode(utf8.decode(res.bodyBytes));
        if (errorBody is Map && errorBody['error'] != null) {
          detail = '${errorBody['error']}';
        }
      } catch (_) {}
      return {
        'ok': false,
        'error': detail.isNotEmpty ? detail : 'HTTP ${res.statusCode}',
      };
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  } catch (e) {
    return {'ok': false, 'error': '$e'};
  }
}

/// 从预检结果里取字符串数组（issues/questions/criteria）。
List<String> goalPrecheckStringList(dynamic value) => (value is List)
    ? value
          .map((item) => item.toString())
          .where((line) => line.trim().isNotEmpty)
          .toList()
    : <String>[];
