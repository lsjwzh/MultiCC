import '../models/message.dart';

/// A reconnect page updates its covered interval, retaining older loaded pages.
/// Passive updates cover only one source and cannot erase another live turn.
List<ChatMessage> mergeShellHistory(
  List<ChatMessage> existing,
  List<ChatMessage> incoming, {
  String? sourceSessionId,
}) {
  if (incoming.isEmpty) return List.of(existing);
  final ids = incoming.map((m) => m.id).whereType<String>().toSet();
  final clients = incoming
      .map((m) => m.clientMsgId)
      .whereType<String>()
      .toSet();
  final first = incoming.first.timestamp;
  final prefix = sourceSessionId == null ? null : '$sourceSessionId:';
  final merged = [
    for (final m in existing)
      if (!ids.contains(m.id) &&
          !clients.contains(m.clientMsgId) &&
          (prefix != null && !(m.id ?? '').startsWith(prefix) ||
              m.id != null && m.timestamp.isBefore(first)))
        m,
    ...incoming,
  ];
  // Stable tie ordering retains user-before-assistant when timestamps match.
  final order = {for (var i = 0; i < merged.length; i++) merged[i]: i};
  merged.sort((a, b) {
    final time = a.timestamp.compareTo(b.timestamp);
    return time != 0 ? time : order[a]!.compareTo(order[b]!);
  });
  return merged;
}
