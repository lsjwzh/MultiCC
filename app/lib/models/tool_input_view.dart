// Dart mirror of the web's typed tool-input renderer
// (public/chat-history-view.js · renderToolInput + humanizeDuration).
//
// One mapping, two clients: tool cards show a typed, human-readable preview of
// what a tool did (terminal / file / diff / web / agent) instead of a raw JSON
// blob. Unknown tool names fall back to pretty JSON. Everything is plain text —
// model-generated or file content carrying markup is never parsed as widgets,
// only rendered as strings.
//
// Keep the shape byte-identical to the web version; the fixture cases in
// app/test/tool_input_view_test.dart mirror tests/test-chat-history-view.js so
// a drift on either side fails its own suite.

import 'dart:convert' show JsonEncoder;

/// Coerce any JSON field to a display string, like the web's asText.
String _s(dynamic v) => v == null ? '' : v.toString();

String _rangeSuffix(Map<String, dynamic> p) {
  final o = p['offset'];
  final l = p['limit'];
  if (o == null && l == null) return '';
  return l != null
      ? '\n(offset: ${_s(o)}, limit: ${_s(l)})'
      : '\n(offset: ${_s(o)})';
}

String _diffBlock(String oldStr, String newStr, String? tag) {
  final t = tag == null ? '' : '$tag ';
  return '\n--- ${t}old\n$oldStr\n+++ ${t}new\n$newStr';
}

/// Typed preview of a tool call's input. [name] is the tool name as reported
/// by the CLI; [parsed] is the decoded input JSON (null when unparsable — the
/// caller then shows the raw text instead).
String renderToolInput(String? name, Map<String, dynamic>? parsed) {
  final p = parsed ?? const {};
  final file = _s(p['file_path'] ?? p['path']);
  switch (name ?? '') {
    case 'Bash':
      return '\$ ${_s(p['command'] ?? p['cmd'])}';
    case 'Read':
      return '$file${_rangeSuffix(p)}';
    case 'Glob':
      final pattern = _s(p['pattern']);
      return file.isNotEmpty ? '$pattern\nin $file' : pattern;
    case 'Grep':
      final tail = StringBuffer()
        ..write(file.isNotEmpty ? '  $file' : '')
        ..write(p['include'] != null ? ' --include=${_s(p['include'])}' : '')
        ..write((p['-i'] != null || p['case_insensitive'] != null) ? ' -i' : '');
      return '/${_s(p['pattern'])}/$tail';
    case 'Write':
      return file + (p['content'] != null ? '\n${_s(p['content'])}' : '');
    case 'Edit':
      return file +
          _diffBlock(_s(p['old_string']), _s(p['new_string']), null) +
          (p['replace_all'] == true ? '\n(replace all)' : '');
    case 'MultiEdit':
      final edits = p['edits'];
      if (edits is! List || edits.isEmpty) return file.isEmpty ? '{}' : file;
      final buf = StringBuffer(file);
      for (var i = 0; i < edits.length; i++) {
        final e = edits[i];
        final m = e is Map ? e : const {};
        buf.write(
          _diffBlock(_s(m['old_string']), _s(m['new_string']), 'edit ${i + 1}'),
        );
      }
      return buf.toString();
    case 'WebFetch':
    case 'WebSearch':
      return _s(p['url'] ?? p['query']) +
          (p['prompt'] != null ? '\n${_s(p['prompt'])}' : '');
    case 'Agent':
    case 'Task':
      return _s(p['description']) +
          (p['prompt'] != null ? '\n${_s(p['prompt'])}' : '');
    default:
      return const JsonEncoder.withIndent('  ').convert(p);
  }
}

/// Render a wall-clock span as the short suffix shown after "done"/"failed".
/// Mirrors the web humanizeDuration: <1s shows ms, <60s shows seconds (one
/// decimal under 10s), >=60s shows "1m 5s". Returns '' for anything
/// unmeasurable (null / negative / NaN) — we never fabricate "0ms".
String humanizeToolDuration(int? ms) {
  if (ms == null || ms.isNaN || ms < 0) return '';
  if (ms < 1000) return '${ms}ms';
  final s = ms / 1000;
  if (s < 60) return s < 10 ? '${s.toStringAsFixed(1)}s' : '${s.round()}s';
  final m = s ~/ 60;
  final rs = (s - m * 60).round();
  return rs > 0 ? '${m}m ${rs}s' : '${m}m';
}
