import '../i18n.dart';
import '../models/message.dart';
import '../services/auto_provider_routing.dart';

// Chat lines for the admission window: the progress key/detail of a
// `message_admission_progress` frame, and the Jev difficulty-routing note.
// The note mirrors formatAutoRouteNote in public/chat-event-controller.js.

String? admissionProgressI18nKey(Map<String, dynamic> payload) {
  switch (payload['state']?.toString()) {
    case 'waiting':
      return payload['stage'] == 'auto_provider_routing'
          ? 'autoRouteJudging'
          : 'admissionMemoryWaiting';
    case 'ready':
      return 'admissionMemoryReady';
    case 'skipped':
      return payload['reason'] == 'memory_distill_failed'
          ? 'admissionMemoryFailed'
          : 'admissionMemorySkipped';
    default:
      return null;
  }
}

String? admissionProgressDetail(Map<String, dynamic> payload) {
  for (final key in const ['rootCause', 'code']) {
    final value = payload[key];
    if (value is! String) continue;
    final normalized = value
        .replaceAll(RegExp(r'[\r\n\t]+'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    if (normalized.isNotEmpty) {
      return normalized.length > 240
          ? normalized.substring(0, 240)
          : normalized;
    }
  }
  return null;
}

const _autoRouteWhy = {
  'jev_key_missing': 'autoRouteWhyKey',
  'jev_timeout': 'autoRouteWhyTimeout',
  'jev_http_401': 'autoRouteWhyAuth',
  'jev_http_403': 'autoRouteWhyAuth',
  'jev_network': 'autoRouteWhyNetwork',
  'jev_not_prepared': 'autoRouteWhyNotJudged',
};
const _autoRouteAction = {
  'strong': 'autoRouteUseStrong',
  'weak': 'autoRouteUseWeak',
  'priority': 'autoRouteUsePriority',
};

/// 这条线路的价格，写成 USD / 1M tokens。`price` 的形态有两种：运行时发的是
/// blended 一个数（src/chat/auto-provider-runtime.js 的 priceFields），价格表里
/// 那份对象则带 input/output —— 两种都认，认不出就什么都不说。
String _autoRoutePrice(Object? value) {
  num? number(Object? raw) {
    final parsed = raw is num ? raw : num.tryParse('${raw ?? ''}');
    if (parsed == null || !parsed.isFinite || parsed < 0) return null;
    return parsed;
  }

  String money(num amount) {
    if (amount == amount.roundToDouble()) return '\$${amount.toInt()}';
    // 0.07 → '$0.07'，2.50 → '$2.5'：价格表给的是每 1M tokens 的美元数。
    return '\$${amount.toStringAsFixed(2).replaceFirst(RegExp(r'0+$'), '')}';
  }

  if (value is Map) {
    final input = number(value['input']);
    final output = number(value['output']);
    if (input != null && output != null) {
      return t('autoRoutePricePair', {
        'input': money(input),
        'output': money(output),
      });
    }
    final blended = number(value['blended']);
    return blended == null
        ? ''
        : t('autoRoutePriceOne', {'price': money(blended)});
  }
  final blended = number(value);
  return blended == null ? '' : t('autoRoutePriceOne', {'price': money(blended)});
}

/// The one line a chat shows for "Jev judged this message, so this line/model
/// answers it", built from a `provider_auto_route` `selected` event. Empty
/// means there is nothing worth saying.
///
/// A cross-CLI pool adds two things this formatter knows about: its events carry
/// `price`/`priceSource` for the picked line (appended to the same line), and a
/// lane it is about to move to is announced as `routePhase: 'cli_switch_planned'`
/// with `fromCli`/`cli` — that phase has no verdict to report, so it draws the
/// lane move alone.
String autoRouteNote(Map<dynamic, dynamic> event) {
  final routing = event['routing'];
  final name = (event['providerName'] ?? '').toString();
  // `routePhase` is the live key; `phase` covers records persisted before the
  // rename and events from a server one release older than this App.
  final phase = event['routePhase'] ?? event['phase'];
  if (phase == 'cli_switch_planned') {
    final from = autoCliLabel(event['fromCli']);
    final to = autoCliLabel(event['cli']);
    // Same lane = nothing moved, and a lane this build cannot name is no news.
    if (from == null || to == null || from == to) return '';
    return t('autoRouteCliSwitch', {'from': from, 'to': to});
  }
  if (routing is! Map || phase != 'selected' || name.isEmpty) {
    return '';
  }
  String tierName(Object? index, Object? count) {
    if (index is! int || count is! int || count < 2) return '';
    if (count > 3) {
      return t('autoRouteTierNth', {'n': '${index + 1}', 'count': '$count'});
    }
    if (index == 0) return t('autoRouteTierSimple');
    return t(
      index >= count - 1 ? 'autoRouteTierComplex' : 'autoRouteTierMedium',
    );
  }

  final model = (event['model'] ?? '').toString().trim();
  final hidden =
      model.isEmpty ||
      model == '_default_' ||
      model.length > 256 ||
      RegExp(r'[\u0000-\u001f\u007f]').hasMatch(model);
  var target = hidden
      ? name
      : t('autoRouteTarget', {'name': name, 'model': model});
  final preferred = tierName(routing['tierIndex'], routing['tierCount']);
  // Every line of the judged tier was out of quota or already tried.
  if (preferred.isNotEmpty &&
      event['tier'] != null &&
      event['preferredTier'] != null &&
      event['tier'] != event['preferredTier']) {
    target += t('autoRouteTierBusy', {'tier': preferred});
  }
  final code = (routing['code'] ?? '').toString();
  // 价格分档的池子每轮按价格挑线路，那条线的价格就是这一轮选择的理由；顺序池
  // 没有这个字段，于是文案一个字符都不变。
  final price = _autoRoutePrice(event['price']);
  if (routing['source'] == 'jev') {
    if (preferred.isEmpty) return '';
    final raised = code.isNotEmpty && code != 'jev_choice'
        ? t('autoRouteRaised')
        : '';
    final ms = routing['latencyMs'];
    final seconds = ms is num && ms > 0
        ? t('autoRouteLatency', {'sec': (ms / 1000).toStringAsFixed(1)})
        : '';
    return t('autoRouteDecided', {
          'tier': preferred + raised,
          'target': target,
        }) +
        seconds +
        price;
  }
  if (routing['source'] != 'fallback') return '';
  final http = RegExp(r'^jev_http_(\d+)$').firstMatch(code);
  final why =
      _autoRouteWhy[code] ??
      (http != null ? 'autoRouteWhyHttp' : 'autoRouteWhyOther');
  return t('autoRouteFallback', {
        'reason': t(why, {'status': http?.group(1) ?? ''}),
        'action': t(_autoRouteAction[routing['onUnknown']] ?? 'autoRouteUseStrong'),
        'target': target,
      }) +
      price;
}

/// One history record as a chat message, or null when it draws nothing.
///
/// An `autoRoute` record is display-only: the server persists the structured
/// verdict alongside a plain `Auto → line · model` content for readers that do
/// not know the field (src/chat/auto-route-notes.js), and the chat shows
/// [autoRouteNote] of it — the same line the live [AutoRouteLine] writes. A
/// verdict the formatter cannot read draws nothing at all, so the record is
/// dropped instead of falling back to that plain content.
ChatMessage? historyRecordMessage(Map<String, dynamic> json) {
  final autoRoute = json['autoRoute'];
  if (autoRoute is! Map) return ChatMessage.fromHistory(json);
  final note = autoRouteNote(autoRoute);
  if (note.isEmpty) return null;
  return ChatMessage.fromHistory(
    json,
    role: MessageRole.system,
    content: note,
  );
}

/// The one routing line of a chat: "Jev is judging…" while the message waits
/// for its verdict, rewritten in place into [autoRouteNote] when the turn
/// picks its line. Turns nobody judged (continuations, nudges) stay silent.
class AutoRouteLine {
  /// The "Jev is judging…" placeholder, until its verdict lands.
  ChatMessage? _line;

  /// The note this line last drew — the same object as [_line] when the
  /// verdict rewrote it in place. Held past the settle so a replay can tell
  /// the record belongs to a line already on screen.
  ChatMessage? _note;

  ChatMessage? _pending(List<ChatMessage> messages) =>
      messages.any((m) => identical(m, _line)) ? _line : null;

  void judging(List<ChatMessage> messages) {
    if (_pending(messages) != null) return;
    _line = ChatMessage(
      role: MessageRole.system,
      content: t('autoRouteJudging'),
    );
    messages.add(_line!);
  }

  /// The message was never admitted, so no verdict will follow.
  void drop(List<ChatMessage> messages) {
    messages.removeWhere((m) => identical(m, _line));
    _line = null;
  }

  /// A replay of history carries the persisted note back as a record. A note
  /// still on screen is the same line (the server stamps the record's
  /// [ChatMessage.clientMsgId] onto the live event), so that record is dropped
  /// here — otherwise the reload would draw the note twice.
  void adoptReplay(List<ChatMessage> replay, List<ChatMessage> messages) {
    final note = _note;
    if (note == null || !messages.any((m) => identical(m, note))) return;
    final clientMsgId = note.clientMsgId;
    if (clientMsgId == null || clientMsgId.isEmpty) return;
    replay.removeWhere((m) => m.clientMsgId == clientMsgId);
  }

  /// Whether [messages] changed.
  bool settle(List<ChatMessage> messages, Map<dynamic, dynamic> event) {
    final routing = event['routing'];
    // A cross-CLI pool's `cli_switch_planned` event lands here too: it is a plan,
    // not a verdict, and the lane it announces is drawn as its own `cli_switched`
    // line the moment the switch actually happens — so this line stays silent
    // rather than saying the same thing twice.
    if ((event['routePhase'] ?? event['phase']) != 'selected' || routing is! Map) {
      return false;
    }
    final pending = _pending(messages);
    _line = null;
    if (pending == null && routing['code'] == 'jev_not_prepared') return false;
    final note = autoRouteNote(event);
    if (note.isEmpty) {
      final removed = pending != null && messages.remove(pending);
      if (removed && identical(_note, pending)) _note = null;
      return removed;
    }
    final line = pending ?? ChatMessage(role: MessageRole.system);
    final clientMsgId = (event['noteClientMsgId'] ?? '').toString();
    if (clientMsgId.isNotEmpty) line.clientMsgId = clientMsgId;
    line.content = note;
    if (pending == null) messages.add(line);
    _note = line;
    return true;
  }
}
