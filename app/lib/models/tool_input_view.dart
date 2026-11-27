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

import '../utils/format.dart';

/// Coerce any JSON field to a display string, like the web's asText.
String _s(dynamic v) => v == null ? '' : v.toString();

const Set<String> kStepToolNames = {'update_steps', 'TodoWrite'};

const Map<String, String> kStepStatusIcons = {
  'done': '✓',
  'in_progress': '▶',
  'failed': '✕',
  'skipped': '–',
  'pending': '○',
};

class ToolStepItem {
  const ToolStepItem({required this.title, required this.status});
  final String title;
  final String status;
}

String _normalizeStepStatus(dynamic raw) {
  final s = _s(raw).trim().toLowerCase();
  if (s == 'done' || s == 'completed') return 'done';
  if (s == 'in_progress' || s == 'running') return 'in_progress';
  if (s == 'failed' || s == 'error') return 'failed';
  if (s == 'skipped' || s == 'cancelled') return 'skipped';
  return 'pending';
}

/// Extract normalized step items from `update_steps` (`steps`) or `TodoWrite`
/// (`todos`). Mirrors `normalizeStepItems` in `public/chat-history-view.js`.
List<ToolStepItem>? normalizeStepItems(Map<String, dynamic>? parsed) {
  if (parsed == null) return null;
  final raw = parsed['steps'] is List
      ? parsed['steps'] as List
      : (parsed['todos'] is List ? parsed['todos'] as List : null);
  if (raw == null || raw.isEmpty) return null;
  final items = <ToolStepItem>[];
  for (final item in raw) {
    if (item is! Map) continue;
    final status = _normalizeStepStatus(item['status']);
    final activeForm = item['activeForm'];
    final titleRaw = (status == 'in_progress' && activeForm != null && _s(activeForm).trim().isNotEmpty)
        ? activeForm
        : (item['title'] ?? item['content'] ?? activeForm ?? '');
    final title = _s(titleRaw).replaceAll(RegExp(r'\s+'), ' ').trim();
    if (title.isEmpty) continue;
    items.add(ToolStepItem(title: title, status: status));
  }
  return items.isEmpty ? null : items;
}

String _formatStepsSummary(List<ToolStepItem> steps) {
  if (steps.isEmpty) return '';
  final done = steps.where((s) => s.status == 'done').length;
  for (final step in steps) {
    if (step.status == 'in_progress') return '$done/${steps.length} · ${step.title}';
  }
  for (final step in steps) {
    if (step.status == 'failed') return '$done/${steps.length} · ${step.title}';
  }
  if (done == steps.length) return '$done/${steps.length} 已完成';
  return '$done/${steps.length}';
}

/// Single-line summary of a tool call's input, covering both Claude/Codex
/// lowercase keys and Antigravity (`agy`) PascalCase keys.
String extractToolSummary(String? name, Map<String, dynamic>? parsed) {
  final p = parsed ?? const {};
  if (kStepToolNames.contains(name ?? '')) {
    final steps = normalizeStepItems(p);
    if (steps != null) return _formatStepsSummary(steps);
  }
  const keys = [
    'description',
    'toolSummary',
    'command',
    'CommandLine',
    'cmd',
    'pattern',
    'Query',
    'query',
    'file_path',
    'path',
    'Path',
    'TargetFile',
    'AbsolutePath',
    'DirectoryPath',
    'SearchPath',
    'url',
    'prompt',
    'Prompt',
    'Role',
  ];
  for (final key in keys) {
    final v = p[key];
    if (v != null) {
      final text = _s(v).replaceAll(RegExp(r'\s+'), ' ').trim();
      if (text.isNotEmpty) return text;
    }
  }
  return '';
}

String _rangeSuffix(Map<String, dynamic> p) {
  final o = p['offset'];
  final l = p['limit'];
  if (o != null || l != null) {
    return l != null
        ? '\n(offset: ${_s(o)}, limit: ${_s(l)})'
        : '\n(offset: ${_s(o)})';
  }
  final s = p['StartLine'];
  final e = p['EndLine'];
  if (s == null && e == null) return '';
  if (s != null && e != null) return '\n(lines: ${_s(s)}-${_s(e)})';
  return '\n(line: ${_s(s ?? e)})';
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
  final file = _s(
    p['file_path'] ??
        p['path'] ??
        p['Path'] ??
        p['TargetFile'] ??
        p['AbsolutePath'] ??
        p['DirectoryPath'] ??
        p['SearchPath'],
  );
  switch (name ?? '') {
    case 'Bash':
    case 'run_command':
      return '\$ ${_s(p['command'] ?? p['CommandLine'] ?? p['cmd'])}';
    case 'Read':
    case 'read_file':
      return '$file${_rangeSuffix(p)}';
    case 'Glob':
    case 'find_by_name':
      final pattern = _s(p['pattern'] ?? p['Pattern']);
      return file.isNotEmpty ? '$pattern\nin $file' : pattern;
    case 'Grep':
    case 'grep_search':
      final tail = StringBuffer()
        ..write(file.isNotEmpty ? '  $file' : '')
        ..write(p['include'] != null ? ' --include=${_s(p['include'])}' : '')
        ..write((p['-i'] != null || p['case_insensitive'] != null) ? ' -i' : '');
      return '/${_s(p['pattern'] ?? p['Query'])}/$tail';
    case 'Write':
    case 'write_file':
      final body = p['content'] ?? p['Content'];
      return file + (body != null ? '\n${_s(body)}' : '');
    case 'Edit':
    case 'edit_file':
      return file +
          _diffBlock(
            _s(p['old_string'] ?? p['Target']),
            _s(p['new_string'] ?? p['Replacement']),
            null,
          ) +
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
    case 'search_web':
      return _s(p['url'] ?? p['query'] ?? p['Query']) +
          (p['prompt'] != null ? '\n${_s(p['prompt'])}' : '');
    case 'Agent':
    case 'Task':
    case 'invoke_subagent':
      final prompt = p['prompt'] ?? p['Prompt'];
      return _s(p['description'] ?? p['Role']) +
          (prompt != null ? '\n${_s(prompt)}' : '');
    case 'update_steps':
    case 'TodoWrite':
      final steps = normalizeStepItems(p);
      if (steps == null) return const JsonEncoder.withIndent('  ').convert(p);
      return steps
          .map((s) => '[${kStepStatusIcons[s.status] ?? '○'}] ${s.title}')
          .join('\n');
    default:
      return const JsonEncoder.withIndent('  ').convert(p);
  }
}

/// Render a wall-clock span as the short suffix shown after "done"/"failed".
/// Mirrors the web humanizeDuration: <1s shows ms, <60s shows seconds (one
/// decimal under 10s), >=60s shows "1m 5s". Returns '' for anything
/// unmeasurable (null / negative / NaN) — we never fabricate "0ms".
String humanizeToolDuration(int? ms) => formatDuration(ms);
