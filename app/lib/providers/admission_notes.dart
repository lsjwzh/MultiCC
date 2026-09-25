import '../i18n.dart';
import '../models/message.dart';

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

/// The one line a chat shows for "Jev judged this message, so this line/model
/// answers it", built from a `provider_auto_route` `selected` event. Empty
/// means there is nothing worth saying.
String autoRouteNote(Map<dynamic, dynamic> event) {
  final routing = event['routing'];
  final name = (event['providerName'] ?? '').toString();
  if (routing is! Map || event['phase'] != 'selected' || name.isEmpty) {
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
        seconds;
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
  });
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
    if (event['phase'] != 'selected' || routing is! Map) return false;
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
