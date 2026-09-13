/// 定时发送（Web 的 `public/chat-scheduled-send.js`）。
///
/// 分两半：本地三个纯函数把「多少、什么单位」翻译成秒数、把到期时刻翻译成
/// 人能读的两句话，逐条对齐 Web 的实现与措辞；远端三个动作（建 / 列 / 撤）
/// 打在 `/api/sessions/:id/scheduled-messages` 上。
///
/// 幂等键由调用方出：同一份草稿（文本 + 延迟）复用同一个 id，连点两次不会在
/// 服务端落两条 —— 服务端按 `(session, clientScheduleId)` 建身份，指纹不同才
/// 报冲突。
library;

import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../i18n.dart';
import 'settings_service.dart';

/// 服务端的上限（`src/orchestration/runtime.js` 的 `DEFAULTS.maxDelaySec`）。
const int kScheduleMaxDelaySeconds = 7 * 24 * 60 * 60;

/// 单位 → 秒。Web 那份也是这四个，键名不动（跟服务端/网页对齐，不是给人看的）。
const Map<String, int> kScheduleUnits = {
  'seconds': 1,
  'minutes': 60,
  'hours': 3600,
  'days': 86400,
};

/// 「多少 + 单位」→ 秒。不合法给 null，绝不替用户猜。
///
/// 负数、零、超上限（7 天）、认不出的单位、`abc` 这类都算不合法 —— 面板上
/// 要据此报「请输入 1 秒到 7 天之间的时间」，而不是发一个服务端必然拒绝的
/// 请求。小数允许（Web 用 `Number()` 也允许），四舍五入到整秒。
int? parseScheduleDelaySeconds(String value, String unit) {
  final amount = double.tryParse(value.trim());
  final multiplier = kScheduleUnits[unit];
  if (amount == null || !amount.isFinite || amount <= 0 || multiplier == null) {
    return null;
  }
  final seconds = (amount * multiplier).round();
  if (seconds < 1 || seconds > kScheduleMaxDelaySeconds) return null;
  return seconds;
}

/// 还有多久到期，按 Web 的四档措辞：秒 → 分 → 时 → 天，一律向上取整
/// （剩下 1 毫秒也是「1 秒后」，不能显示「0 秒后」还挂着不动）。
String formatScheduleRemaining(int dueAtMs, {int? nowMs}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final remaining = dueAtMs - now;
  if (remaining <= 0) return t('scheduleDueNow');
  final seconds = (remaining / 1000).ceil();
  if (seconds < 60) return t('scheduleRemainingSeconds', {'n': '$seconds'});
  final minutes = (seconds / 60).ceil();
  if (minutes < 60) return t('scheduleRemainingMinutes', {'n': '$minutes'});
  final hours = (minutes / 60).ceil();
  if (hours < 24) return t('scheduleRemainingHours', {'n': '$hours'});
  return t('scheduleRemainingDays', {'n': '${(hours / 24).ceil()}'});
}

/// 到点的钟点，`MM/DD HH:mm:ss`，本地时区。
///
/// 刻意不走 `Intl`：Web 那边用它，但同一时刻在 en / zh 下都是这个形状，而
/// App 里 DateTime 本来就按本机时区算，自己补零比拉一个 locale 依赖稳。
String formatScheduleDueAt(int dueAtMs) {
  final at = DateTime.fromMillisecondsSinceEpoch(dueAtMs).toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${two(at.month)}/${two(at.day)} '
      '${two(at.hour)}:${two(at.minute)}:${two(at.second)}';
}

/// 客户端幂等键。Web 优先用 `crypto.randomUUID()`，拿不到就退到「时间戳 36 进制
/// + 随机数 36 进制」。Dart 侧没有前者，所以只保留后一种 —— 形状一致，够用。
String scheduledClientId({int? nowMs, double? random}) {
  final at = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  // Web 取的是随机数小数点后的 10 位（`toString(36).slice(2, 12)`）；Dart 的
  // double 没有 toRadixString，就把小数部分放大成整数再转 —— 同样是那份熵。
  final fraction = (random ?? Random().nextDouble()).abs();
  final entropy = (fraction * 1e12).toInt();
  return 'schedule-${at.toRadixString(36)}-${entropy.toRadixString(36)}';
}

class ScheduledMessage {
  const ScheduledMessage({
    required this.id,
    required this.message,
    required this.dueAt,
  });

  final String id;
  final String message;

  /// 到点时刻（epoch 毫秒，服务端时钟）。
  final int dueAt;

  factory ScheduledMessage.fromJson(Map<String, dynamic> json) =>
      ScheduledMessage(
        id: (json['id'] ?? '').toString(),
        message: (json['message'] ?? '').toString(),
        dueAt: (json['dueAt'] as num?)?.toInt() ?? 0,
      );
}

/// 服务端给了一个带 code 的拒绝。面板按 code 挑文案（填空的草稿 / 时间不合法 /
/// 其它都归到「创建失败」）。
class ScheduledSendException implements Exception {
  const ScheduledSendException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class ScheduledSendService {
  ScheduledSendService({
    required this.settings,
    this.httpClient,
    this.timeout = const Duration(seconds: 15),
  });

  final SettingsService settings;

  /// 测试注入的假连接；为空就走 `http` 的默认客户端。
  final http.Client? httpClient;
  final Duration timeout;

  Map<String, String> get _headers {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
    return headers;
  }

  String _base(String sessionId) =>
      '/api/sessions/${Uri.encodeComponent(sessionId)}/scheduled-messages';

  Future<http.Response> _send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? extraHeaders,
  }) {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final headers = {..._headers, ...?extraHeaders};
    final client = httpClient;
    final encoded = body == null ? null : jsonEncode(body);
    final call = switch (method) {
      'GET' => client == null
          ? http.get(uri, headers: headers)
          : client.get(uri, headers: headers),
      'POST' => client == null
          ? http.post(uri, headers: headers, body: encoded)
          : client.post(uri, headers: headers, body: encoded),
      'DELETE' => client == null
          ? http.delete(uri, headers: headers)
          : client.delete(uri, headers: headers),
      _ => throw ArgumentError.value(method, 'method', '不支持的方法'),
    };
    return call.timeout(timeout);
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.body.isEmpty) return const {};
    final decoded = jsonDecode(utf8.decode(response.bodyBytes));
    return decoded is Map ? decoded.cast<String, dynamic>() : const {};
  }

  void _throwUnlessOk(http.Response response, Map<String, dynamic> data) {
    if (response.statusCode >= 200 &&
        response.statusCode < 300 &&
        data['ok'] != false) {
      return;
    }
    final code = (data['code'] ?? '').toString();
    final error = (data['error'] ?? '').toString();
    throw ScheduledSendException(
      code,
      error.isEmpty ? 'HTTP ${response.statusCode}' : error,
    );
  }

  /// 建一条定时消息。[clientScheduleId] 是幂等键，重复提交同一个键、指纹又相同
  /// 时服务端回 200 + `duplicate: true`，这里当成功处理。
  Future<ScheduledMessage> create({
    required String sessionId,
    required String message,
    required int delaySeconds,
    required String clientScheduleId,
  }) async {
    final response = await _send(
      'POST',
      _base(sessionId),
      body: {'message': message, 'delaySeconds': delaySeconds},
      extraHeaders: {'Idempotency-Key': clientScheduleId},
    );
    final data = _decode(response);
    _throwUnlessOk(response, data);
    final scheduled = data['scheduledMessage'];
    return ScheduledMessage.fromJson(
      scheduled is Map ? scheduled.cast<String, dynamic>() : const {},
    );
  }

  Future<List<ScheduledMessage>> list(String sessionId) async {
    final response = await _send('GET', _base(sessionId));
    final data = _decode(response);
    _throwUnlessOk(response, data);
    final items = data['scheduledMessages'];
    if (items is! List) return const [];
    return [
      for (final item in items)
        if (item is Map)
          ScheduledMessage.fromJson(item.cast<String, dynamic>()),
    ];
  }

  Future<void> cancel({
    required String sessionId,
    required String messageId,
  }) async {
    final response = await _send(
      'DELETE',
      '${_base(sessionId)}/${Uri.encodeComponent(messageId)}',
    );
    _throwUnlessOk(response, _decode(response));
  }
}
