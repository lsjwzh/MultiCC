/// Build a quote block for [message] — the Dart mirror of the web's
/// `public/chat-quote.js`, so a quote carries the same thing on both clients.
///
/// The quoted text is only half of what a quote is worth. A task shell shows one
/// conversation built out of several tasks, and a message's meaning depends on
/// which of them it came from — the same sentence from 「修登录页」 and from
/// 「迁移数据库」 is two different pieces of evidence. So the block carries the
/// message's own provenance too: the subtask it belongs to (name + id), who said
/// it, when, and the message identity `<sessionId>:<messageId>`, which is
/// exactly the handle the task-context reader takes to re-read it in full.
///
/// The block is plain text inserted into the composer, never a separate widget.
/// A draft is persisted as raw text, and a failed send is restored from the text
/// it tried to send; a quote that lived outside the box would be lost by both.
/// Plain text also means the model reads it as-is and the user can edit or drop
/// it.
library;

import '../i18n.dart';
import '../models/message.dart';

/// Long enough for a paragraph of real evidence, short enough that quoting a
/// whole answer does not silently spend the next turn's context on itself.
/// Same number as the web client — a quote written on one client and pasted in
/// a conversation read on the other should not change length.
const int kMessageQuoteMaxChars = 800;

/// The quote block for [message], or '' when there is nothing to quote (an
/// empty message). Callers treat '' as "do not offer this".
String buildMessageQuote(
  ChatMessage message, {
  String Function(String key, [Map<String, String> params]) translate = t,
}) {
  final text = message.content.trim();
  if (text.isEmpty) return '';

  final clipped = text.length > kMessageQuoteMaxChars;
  final body = clipped
      ? text.substring(0, kMessageQuoteMaxChars).trimRight()
      : text;
  final parts = <String>[
    _quoteHeader(message, translate),
    quoteLines(body),
  ];
  if (clipped) {
    parts.add('> ${translate('msgQuoteTruncated', {'n': '${text.length}'})}');
  }
  return parts.join('\n');
}

/// Prefix every line so the block survives as a quote even after the user adds
/// their own text above or below it — including lines the excerpt cut mid-way.
String quoteLines(String text) =>
    text.split('\n').map((line) => '> $line'.trimRight()).join('\n');

String _quoteHeader(
  ChatMessage message,
  String Function(String key, [Map<String, String> params]) translate,
) {
  return translate('msgQuoteHeader', {
    'task': _taskLabel(message, translate),
    'role': translate(_roleKey(message.role)),
    'time': _clock(message.timestamp),
    'message': _messageIdentity(message) ?? translate('msgQuoteNoTrace'),
  });
}

String _taskLabel(
  ChatMessage message,
  String Function(String key, [Map<String, String> params]) translate,
) {
  final name = message.taskName?.trim() ?? '';
  final id = message.taskId?.trim() ?? '';
  if (name.isNotEmpty && id.isNotEmpty) {
    return translate('msgQuoteTask', {'name': name, 'id': id});
  }
  if (name.isNotEmpty) return translate('msgQuoteTaskNamed', {'name': name});
  if (id.isNotEmpty) return id;
  return translate('msgQuoteNoTask');
}

String _roleKey(MessageRole role) => switch (role) {
  MessageRole.user => 'msgQuoteRoleUser',
  MessageRole.assistant => 'msgQuoteRoleAssistant',
  MessageRole.system => 'msgQuoteRoleSystem',
};

/// `<sessionId>:<messageId>` — the handle the task-context reader takes. Falls
/// back to splitting the shell's composite [ChatMessage.id] when the halves
/// were never handed over separately (a classic, non-shell conversation).
String? _messageIdentity(ChatMessage message) {
  final session = message.sourceSessionId?.trim() ?? '';
  var messageId = message.sourceMessageId?.trim() ?? '';
  if (messageId.isEmpty) {
    messageId = (message.id ?? '').trim();
    // A shell bubble's [ChatMessage.id] is *already* `<sessionId>:<messageId>`;
    // joining it with the session again would name a message that does not
    // exist ("sess_a:sess_a:m_1"). Strip the half we already have.
    final prefix = '$session:';
    if (session.isNotEmpty && messageId.startsWith(prefix)) {
      messageId = messageId.substring(prefix.length);
    }
  }
  if (messageId.isEmpty) return session.isEmpty ? null : session;
  return session.isEmpty ? messageId : '$session:$messageId';
}

/// `MM-DD HH:mm`, or '' when the timestamp is missing — never a fabricated
/// clock. Local time, because that is the clock the reader is under.
String _clock(DateTime timestamp) {
  String pad(int value) => value.toString().padLeft(2, '0');
  return '${pad(timestamp.month)}-${pad(timestamp.day)} '
      '${pad(timestamp.hour)}:${pad(timestamp.minute)}';
}

/// Insert a quote above whatever is already in the composer. A quote is context
/// you are adding to what you were going to say, so it must never replace the
/// draft. Returns the new composer text.
String composerTextWithQuote(String draft, String block) {
  final trimmed = draft.trim();
  if (trimmed.isEmpty) return '$block\n\n';
  return '$block\n\n${draft.replaceFirst(RegExp(r'^\n+'), '')}';
}
