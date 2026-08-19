import 'dart:convert' show jsonDecode, jsonEncode;

import 'package:flutter/foundation.dart';

import '../models/message.dart';

// Shared live-event folding core (chat-view unification I8: one event
// vocabulary, one folder). Extracted from ChatProvider: it owns the
// streaming-tail state for one transcript and folds slot/WS events into it.
// ChatProvider delegates its event cases here; the task detail sheet drives
// one directly from task_run_stream envelopes (A2), so a task run and a chat
// session can never drift apart in how deltas become messages.
//
// The engine (cli) and the sidecar namespace (session id) are READ THROUGH
// GETTERS, not copied: a session learns its cli from system_init /
// cli_switched, a task view learns it from the envelope's cli stamp — either
// way the folder always sees the latest value with zero sync points.

/// Finds a tool card by id within one message's tool list.
ToolCall? toolCallById(ChatMessage msg, String id) {
  for (final tc in msg.toolCalls) {
    if (tc.id == id) return tc;
  }
  return null;
}

/// 应用一帧 reasoning 增量：落到会话唯一的 Thinking 卡（id =
/// `sidecar-reasoning-<sessionId>`，与 web 同键），文本追加进 `{text:…}`。
/// 无 startedAt —— 推理没有真实的工具计时，不伪造时长也不进轨迹条。
/// 返回消息是否变化（调用方据此 notifyListeners）。
@visibleForTesting
bool applyReasoningDelta(ChatMessage msg, String sessionId, String text) {
  if (text.isEmpty) return false;
  final id = 'sidecar-reasoning-$sessionId';
  final existing = toolCallById(msg, id);
  if (existing == null) {
    msg.toolCalls.add(
      ToolCall(id: id, name: 'Thinking', inputJson: jsonEncode({'text': text})),
    );
    return true;
  }
  var buffer = text;
  final prev = existing.parsedInput?['text'];
  // 只有当已积累内容确实来自本卡（{text:…} 键齐全）才在其后追加，防畸形 JSON 丢字。
  if (prev is String) {
    buffer = prev + text;
  }
  existing.inputJson = jsonEncode({'text': buffer});
  return true;
}

/// 从卡片当前 inputJson 还原原始参数流缓冲：wrapper 形态
/// `{"arguments":"…"}` 取回内串；已能 parse 的形态本身即原始串。
String _rawToolArgsBuffer(ToolCall tc) {
  final parsed = tc.parsedInput;
  if (parsed != null && parsed.length == 1 && parsed['arguments'] is String) {
    return parsed['arguments'] as String;
  }
  return tc.inputJson;
}

/// 与 web 相同的规范化：能整体 parse 就用规范化 JSON；否则包成
/// `{"arguments": <raw>}`，保证 inputJson 始终是合法 JSON 可被 pretty 渲染。
String _normalizeToolArgs(String raw) {
  try {
    final decoded = jsonDecode(raw);
    return jsonEncode(decoded);
  } catch (_) {
    return jsonEncode({'arguments': raw});
  }
}

/// 应用一帧工具参数增量：按 toolId 找卡追加参数片段；卡片不存在则创建
/// （此刻打真实 startedAt —— 工具参数开始流出的时间就是工具开始时间，
/// 与 web 边车创建时戳一致）。返回消息是否变化。
@visibleForTesting
bool applyToolArgsDelta(
  ChatMessage msg,
  String toolId,
  String toolName,
  String argsFragment, {
  int now = 0,
}) {
  if (toolId.isEmpty || argsFragment.isEmpty) return false;
  final existing = toolCallById(msg, toolId);
  if (existing != null) {
    final raw = _rawToolArgsBuffer(existing) + argsFragment;
    existing.inputJson = _normalizeToolArgs(raw);
    return true;
  }
  msg.toolCalls.add(
    ToolCall(
      id: toolId,
      name: toolName.isNotEmpty ? toolName : 'Tool',
      inputJson: _normalizeToolArgs(argsFragment),
      startedAt: now,
    ),
  );
  return true;
}

/// Folds the live event vocabulary (message_start / content_block_* /
/// assistant / part_delta / user tool_result / result) into one transcript
/// tail. The [messages] list is shared with the host — the folder only ever
/// appends or mutates the streaming tail, never reorders history.
class TranscriptLiveFolder {
  TranscriptLiveFolder({
    required this.messages,
    SessionCli Function()? cliOf,
    String Function()? sessionIdOf,
    void Function()? onChanged,
    void Function()? onTurnStart,
  })  : _cliOf = cliOf ?? (() => SessionCli.claude),
        _sessionIdOf = sessionIdOf ?? (() => ''),
        _onChanged = onChanged,
        _onTurnStart = onTurnStart;

  /// The transcript the streaming tail lives in. Owned by the host; the
  /// folder appends at most one bubble per turn and mutates it in place.
  final List<ChatMessage> messages;

  final SessionCli Function() _cliOf;
  final String Function() _sessionIdOf;
  final void Function()? _onChanged;
  final void Function()? _onTurnStart;

  ChatMessage? currentMsg;

  /// The most recent assistant message, kept alive across [finishStreaming] —
  /// a role_token_stats arriving just after `result` still targets this
  /// turn's bubble instead of being dropped on the floor.
  ChatMessage? lastAssistantMsg;
  final Map<int, ToolCall> activeTools = {};

  void _emit() => _onChanged?.call();

  void ensureAssistantMsg() {
    if (currentMsg == null) {
      currentMsg = ChatMessage(role: MessageRole.assistant, isStreaming: true);
      messages.add(currentMsg!);
      lastAssistantMsg = currentMsg;
      activeTools.clear();
      // A new assistant turn started. One bump per turn since subsequent
      // steps reuse this same bubble.
      _onTurnStart?.call();
    }
  }

  /// `message_start`: opens the streaming bubble. Per-request usage stays
  /// with the host (it feeds provider-level bars, not the transcript).
  void messageStart() {
    ensureAssistantMsg();
    _emit();
  }

  void contentBlockStart(Map<String, dynamic> evt) {
    final idx = (evt['index'] as num?)?.toInt() ?? 0;
    final block = evt['content_block'] as Map<String, dynamic>?;
    final bType = block?['type'] as String? ?? '';

    if (bType == 'tool_use') {
      final tc = ToolCall(
        id: (block?['id'] ?? '').toString(),
        name: (block?['name'] ?? '').toString(),
        // Live timing stamp (mirror of the web's chat-event-controller): the
        // tool's real wall-clock start, paired with endedAt at tool_result.
        startedAt: DateTime.now().millisecondsSinceEpoch,
      );
      activeTools[idx] = tc;
      ensureAssistantMsg();
      currentMsg!.toolCalls.add(tc);
      _emit();
    }
  }

  /// A `user` role frame carrying tool_result blocks — one per finished tool.
  /// Mirrors the web's handleToolResult: match by tool_use_id, attach the
  /// result text, mark done, and stamp endedAt for the measured duration.
  void userToolResult(Map<String, dynamic> msg) {
    final inner = msg['message'];
    final content = inner is Map ? inner['content'] : msg['content'];
    if (content is! List) return;
    var changed = false;
    for (final raw in content) {
      if (raw is! Map || raw['type'] != 'tool_result') continue;
      final id = raw['tool_use_id']?.toString() ?? '';
      if (id.isEmpty) continue;
      final tools = currentMsg?.toolCalls ?? const <ToolCall>[];
      for (final tc in tools) {
        if (tc.id != id) continue;
        final c = raw['content'];
        tc.result = c is String
            ? c
            : c is List
                ? c
                    .map(
                      (item) =>
                          item is Map ? (item['text'] ?? '').toString() : '',
                    )
                    .join('')
                : c?.toString();
        tc.isError = raw['is_error'] == true;
        tc.isDone = true;
        tc.endedAt = DateTime.now().millisecondsSinceEpoch;
        changed = true;
        break;
      }
    }
    if (changed) _emit();
  }

  void contentBlockDelta(Map<String, dynamic> evt) {
    final idx = (evt['index'] as num?)?.toInt() ?? 0;
    final delta = evt['delta'] as Map<String, dynamic>?;
    final dType = delta?['type'] as String? ?? '';

    if (dType == 'text_delta') {
      final text = delta?['text'] as String? ?? '';
      ensureAssistantMsg();
      currentMsg!.content += text;
      _emit();
    } else if (dType == 'input_json_delta') {
      final partial = delta?['partial_json'] as String? ?? '';
      final tc = activeTools[idx];
      if (tc != null) {
        tc.inputJson += partial;
        _emit();
      }
    }
  }

  void assistantSnapshot(Map<String, dynamic> message) {
    final blocks = message['content'];
    if (blocks is! List) return;
    var changed = false;
    for (final raw in blocks) {
      if (raw is! Map) continue;
      if (raw['type'] == 'text') {
        final text = raw['text']?.toString() ?? '';
        if (text.isEmpty) continue;
        ensureAssistantMsg();
        if (message['textSnapshot'] == true) {
          currentMsg!.content = text;
        } else if (_cliOf() == SessionCli.codex) {
          currentMsg!.content += text;
        } else if (currentMsg!.content.isEmpty) {
          currentMsg!.content = text;
        }
        changed = true;
      } else if (raw['type'] == 'tool_use') {
        // Codex/OpenCode tools arrive as complete blocks here (no
        // content_block_start), so this is their live creation site — mirror
        // of the web's finalizeAssistantMsg branch. Without it the app showed
        // no tool cards live on non-claude CLIs until a history reload.
        final id = raw['id']?.toString() ?? '';
        if (id.isEmpty) continue;
        final name = raw['name']?.toString() ?? 'Tool';
        final input = raw['input'];
        ensureAssistantMsg();
        ToolCall? existing;
        for (final tc in currentMsg!.toolCalls) {
          if (tc.id == id) {
            existing = tc;
            break;
          }
        }
        if (existing == null) {
          currentMsg!.toolCalls.add(
            ToolCall(
              id: id,
              name: name,
              inputJson: input != null ? jsonEncode(input) : '',
              startedAt: DateTime.now().millisecondsSinceEpoch,
            ),
          );
          changed = true;
        } else if (input != null && existing.inputJson != jsonEncode(input)) {
          // Authoritative convergence (web finalizeAssistantMsg parity): the
          // snapshot carries the COMPLETE input, so it overwrites whatever
          // the part_delta sidecar streamed so far — never the reverse. The
          // sidecar reasoning card (id `sidecar-reasoning-*`) never matches a
          // snapshot block id, so it is untouched here.
          existing.inputJson = jsonEncode(input);
          changed = true;
        }
      }
    }
    if (changed) _emit();
  }

  void partDelta(Map<String, dynamic> message) {
    if (_cliOf() == SessionCli.claude) return;
    final delta = message['delta'];
    if (delta is! Map) return;
    final dType = delta['type']?.toString() ?? '';

    if (dType == 'text') {
      final text = delta['text']?.toString() ?? '';
      if (text.isEmpty) return;
      ensureAssistantMsg();
      currentMsg!.content += text;
      _emit();
    } else if (dType == 'reasoning') {
      // Live reasoning streams into the session's single Thinking sidecar
      // card (web handlePartDelta parity). No startedAt: reasoning has no
      // real tool timing — must not fabricate durations or trajectory rows.
      final text = delta['text']?.toString() ?? '';
      if (text.isEmpty) return;
      ensureAssistantMsg();
      if (applyReasoningDelta(currentMsg!, _sessionIdOf(), text)) {
        _emit();
      }
    } else if (dType == 'tool') {
      // Progressive tool-argument fragments: keyed by delta.toolId, args
      // accumulate at delta.tool.arguments. The authoritative `assistant`
      // snapshot later overwrites with the complete input.
      final toolId = delta['toolId']?.toString() ?? '';
      final tool = delta['tool'];
      if (toolId.isEmpty || tool is! Map) return;
      ensureAssistantMsg();
      if (applyToolArgsDelta(
        currentMsg!,
        toolId,
        tool['name']?.toString() ?? 'Tool',
        tool['arguments']?.toString() ?? '',
        now: DateTime.now().millisecondsSinceEpoch,
      )) {
        _emit();
      }
    }
  }

  /// Attaches the result frame's usage + server-stamped duration to the
  /// current bubble. Role-token bookkeeping stays with the host (it feeds
  /// provider-level bars); call this BEFORE [finishStreaming].
  void attachResultUsage(Map<String, dynamic> msg) {
    if (currentMsg == null) return;
    if (msg['usage'] != null) {
      currentMsg!.usage = MessageUsage.fromJson(
        msg['usage'] as Map<String, dynamic>,
      );
    }
    // Server-stamped wall-clock duration: user submit → AI reply complete.
    final dur = (msg['durationMs'] as num?)?.toInt();
    if (dur != null) currentMsg!.durationMs = dur;
  }

  void finishStreaming() {
    if (currentMsg != null) {
      currentMsg!.isStreaming = false;
      for (final tc in currentMsg!.toolCalls) {
        tc.isDone = true;
      }
      currentMsg = null;
    }
    activeTools.clear();
  }

  /// Drops the streaming state without touching the transcript — used by
  /// history replacement / clear / reconnect paths.
  void resetTail() {
    currentMsg = null;
    activeTools.clear();
  }
}
