import '../services/chat_shell_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../models/message.dart';
import '../models/role_tokens.dart';
import '../providers/chat_provider.dart';
import '../services/download_ticket_service.dart';
import '../services/message_quote.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../utils/code_highlight.dart';
import 'tool_card.dart';

/// Resolve a markdown link href and open it externally.
///
/// Handles three forms:
///  - absolute `http(s)://…` links → opened as-is
///  - root-relative links like `/artifacts/<id>/index.html` (multicc artifacts,
///    file downloads) → resolved against the configured server base URL
///  - `mailto:` / other schemes → handed to the OS as-is
Future<void> _handleLinkTap(BuildContext context, String? href) async {
  if (href == null || href.trim().isEmpty) return;
  var target = href.trim();

  // Root-relative path: resolve against the multicc server we're talking to.
  if (target.startsWith('/')) {
    final base = SettingsService.current?.buildHttpUrl(target);
    if (base != null) target = base;
  } else if (!target.contains('://') && !target.startsWith('mailto:')) {
    // Bare host or path without a scheme — assume http for the current server.
    final base = SettingsService.current?.buildHttpUrl('/$target');
    if (base != null) target = base;
  }

  final uri = Uri.tryParse(target);
  if (uri == null) return;

  final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('无法打开链接：$target'),
        duration: const Duration(milliseconds: 1600),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

/// Long-press action sheet: copy and quote always; delete only when the message
/// has a server-side history id (streaming / not-yet-persisted bubbles aren't
/// addressable — the id arrives via the chat_msg_meta WS event once saved).
Future<void> _showMessageActions(
  BuildContext context,
  ChatMessage message, {
  bool serverActions = true,
}) async {
  // Delete/fork are session-history operations bound to ChatProvider + the
  // session REST surface; transcript-only hosts (task detail) get copy only.
  final provider = context.read<ChatProvider?>();
  final canDelete =
      serverActions &&
      (provider?.historyArchive != true) &&
      (message.id ?? '').isNotEmpty;
  // 引用要落进输入框，所以能不能引用问的是「本宿主有没有输入框」，不是
  // 「能不能动服务端历史」—— 引用不改任何东西，只是把已有的话搬进输入框。
  // 没有输入框就别摆这个入口：摆了也点不出结果。
  final quote = provider?.quoteInserter == null
      ? ''
      : buildMessageQuote(message);
  final canQuote = quote.isNotEmpty;
  final action = await showModalBottomSheet<String>(
    context: context,
    backgroundColor: const Color(0xFFffffff),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.copy_outlined, color: Color(0xFF6f8096)),
            title: Text(
              I18n.of('msgCopyAction'),
              style: const TextStyle(color: Color(0xFF233249)),
            ),
            onTap: () => Navigator.pop(ctx, 'copy'),
          ),
          if (canQuote)
            ListTile(
              leading: const Icon(Icons.format_quote, color: Color(0xFF0965cf)),
              title: Text(
                I18n.of('msgQuoteAction'),
                style: const TextStyle(color: Color(0xFF233249)),
              ),
              onTap: () => Navigator.pop(ctx, 'quote'),
            ),
          if (canDelete)
            ListTile(
              leading: const Icon(
                Icons.delete_outline,
                color: Color(0xFFb64e43),
              ),
              title: Text(
                I18n.of('msgDeleteAction'),
                style: const TextStyle(color: Color(0xFFb64e43)),
              ),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          if (canDelete)
            ListTile(
              leading: const Icon(Icons.call_split, color: Color(0xFF137780)),
              title: Text(
                I18n.of('msgForkAction'),
                style: const TextStyle(color: Color(0xFF137780)),
              ),
              onTap: () => Navigator.pop(ctx, 'fork'),
            ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  if (action == 'copy') {
    _copyMessage(context, message.content);
  } else if (action == 'quote') {
    _quoteMessage(context, message, quote);
  } else if (action == 'delete') {
    await _confirmDeleteMessage(context, message);
  } else if (action == 'fork') {
    await _forkFromMessage(context, message);
  }
}

/// 把引用块放进输入框。
///
/// 还没落库的气泡（流式中的那条）没有可指认的稳定身份，引用它等于写下一个
/// 打不开的句柄 —— 这时直说引用不了，而不是生成一个假的身份。
void _quoteMessage(BuildContext context, ChatMessage message, String quote) {
  final inserter = context.read<ChatProvider?>()?.quoteInserter;
  if (inserter == null) return;
  if ((message.id ?? '').isEmpty) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(I18n.of('msgQuoteUnavailable')),
        duration: const Duration(milliseconds: 2200),
        behavior: SnackBarBehavior.floating,
      ),
    );
    return;
  }
  inserter(quote);
}

/// Confirm, then delete the message from the server's chat history.
/// Display-history only — the CLI's own conversation context is untouched.
/// Local removal is driven by the chat_msg_deleted WS broadcast (idempotent),
/// with a direct provider fallback in case the socket is momentarily down.
Future<void> _confirmDeleteMessage(
  BuildContext context,
  ChatMessage message,
) async {
  final msgId = message.id;
  if (msgId == null || msgId.isEmpty) return;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(I18n.of('msgDeleteTitle')),
      content: Text(I18n.of('msgDeleteConfirm')),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(I18n.of('cancel')),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(
            I18n.of('msgDeleteAction'),
            style: const TextStyle(color: Color(0xFFb64e43)),
          ),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final provider = context.read<ChatProvider>();
  final settings = SettingsService.current;
  if (settings == null) return;
  try {
    await SessionService(settings: settings).deleteMessage(
      shellMessageOwner(provider.executionSessionName, msgId).sessionId,
      shellMessageOwner(provider.executionSessionName, msgId).messageId,
    );
    provider.removeMessageById(msgId);
    messenger.showSnackBar(
      SnackBar(
        content: Text(I18n.of('msgDeleted')),
        duration: const Duration(milliseconds: 1200),
        behavior: SnackBarBehavior.floating,
      ),
    );
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(
        content: Text(I18n.of('msgDeleteFailed', {'error': '$e'})),
        duration: const Duration(milliseconds: 2200),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

/// Copy a message's text to the clipboard with a brief confirmation.
void _copyMessage(BuildContext context, String text) {
  final t = text.trim();
  if (t.isEmpty) return;
  Clipboard.setData(ClipboardData(text: t));
  ScaffoldMessenger.of(context).showSnackBar(
    const SnackBar(
      content: Text('已复制'),
      duration: Duration(milliseconds: 1200),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

/// Fork the current session at [message] — creates a new session replaying the
/// transcript up to (and including) this message, inheriting provider/model
/// and copying the source's distilled memory. Mirrors the web chat's per-message
/// fork button. The new session appears in the session list (pushed via the
/// session_created WS event); the user opens it from there.
Future<void> _forkFromMessage(BuildContext context, ChatMessage message) async {
  final msgId = message.id;
  if (msgId == null || msgId.isEmpty) return;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(I18n.of('msgForkTitle')),
      content: Text(I18n.of('msgForkConfirm')),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(I18n.of('cancel')),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(
            I18n.of('msgForkAction'),
            style: const TextStyle(color: Color(0xFF137780)),
          ),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final provider = context.read<ChatProvider>();
  final settings = SettingsService.current;
  if (settings == null) return;
  try {
    final newId = await SessionService(settings: settings).forkSession(
      shellMessageOwner(provider.executionSessionName, msgId).sessionId,
      atMessageId: shellMessageOwner(
        provider.executionSessionName,
        msgId,
      ).messageId,
    );
    messenger.showSnackBar(
      SnackBar(
        content: Text(I18n.of('msgForked', {'id': newId})),
        duration: const Duration(milliseconds: 2400),
        behavior: SnackBarBehavior.floating,
      ),
    );
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(
        content: Text(I18n.of('msgForkFailed', {'error': '$e'})),
        duration: const Duration(milliseconds: 2200),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

class MessageBubble extends StatelessWidget {
  final ChatMessage message;

  /// Session-history affordances (delete / fork) call ChatProvider and the
  /// session REST surface. Transcript-only hosts (the task detail sheet)
  /// pass false so the long-press sheet offers copy only — the task ledger
  /// is an audit trail and is never mutated from a bubble.
  final bool enableServerActions;

  /// 这一轮的用户气泡下面要不要挂「本轮执行成功后自动提交合并」勾选框
  /// （Web 的 `attachAutoCommitCheck`，只挂在最后一条用户消息上）。默认全关，
  /// 所以别的宿主（任务详情页那种只读转录）渲染出来和以前完全一样。
  final bool showAutoCommit;
  final bool autoCommitChecked;

  /// 这一轮已经自动提交过了 —— 勾选框还在，但变成只读的「✓ 已提交」。
  final bool autoCommitDone;
  final ValueChanged<bool>? onAutoCommitChanged;

  const MessageBubble({
    super.key,
    required this.message,
    this.enableServerActions = true,
    this.showAutoCommit = false,
    this.autoCommitChecked = false,
    this.autoCommitDone = false,
    this.onAutoCommitChanged,
  });

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case MessageRole.user:
        // 🔇 系统注入（引擎写的 role=user）不是人打的：画成系统卡，不画用户气泡，
        // 也不挂这一轮自动提交的勾选框。
        final injected = parseSystemInject(message.content);
        if (injected != null) {
          return _SystemInjectBubble(
            message: message,
            parts: injected,
            enableServerActions: enableServerActions,
          );
        }
        return _UserBubble(
          message: message,
          enableServerActions: enableServerActions,
          showAutoCommit: showAutoCommit,
          autoCommitChecked: autoCommitChecked,
          autoCommitDone: autoCommitDone,
          onAutoCommitChanged: onAutoCommitChanged,
        );
      case MessageRole.assistant:
        return _AssistantBubble(
          message: message,
          enableServerActions: enableServerActions,
        );
      case MessageRole.system:
        return _SystemBubble(message: message);
    }
  }
}

class _UserBubble extends StatelessWidget {
  final ChatMessage message;
  final bool enableServerActions;
  final bool showAutoCommit;
  final bool autoCommitChecked;
  final bool autoCommitDone;
  final ValueChanged<bool>? onAutoCommitChanged;
  const _UserBubble({
    required this.message,
    this.enableServerActions = true,
    this.showAutoCommit = false,
    this.autoCommitChecked = false,
    this.autoCommitDone = false,
    this.onAutoCommitChanged,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final laneWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        return Align(
          alignment: Alignment.centerRight,
          child: GestureDetector(
            onLongPress: () => _showMessageActions(
              context,
              message,
              serverActions: enableServerActions,
            ),
            child: Container(
              constraints: BoxConstraints(maxWidth: laneWidth * 0.85),
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: const BoxDecoration(
                color: Color(0xFF0965cf),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(12),
                  topRight: Radius.circular(12),
                  bottomLeft: Radius.circular(12),
                  bottomRight: Radius.circular(4),
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    message.content,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 14,
                      height: 1.5,
                    ),
                  ),
                  if (showAutoCommit)
                    _AutoCommitRow(
                      checked: autoCommitChecked,
                      done: autoCommitDone,
                      onChanged: onAutoCommitChanged,
                    ),
                  _TaskAttributionTail(message: message, isUser: true),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 用户气泡里那行「本轮执行成功后自动提交合并」（Web 的 `.msg-auto-commit`）。
/// 它落在蓝底气泡里，所以分隔线和文字都走白色系 —— Web 那边也为这个场景单独
/// 覆盖过 `--chat-muted` 的灰字。
class _AutoCommitRow extends StatelessWidget {
  final bool checked;
  final bool done;
  final ValueChanged<bool>? onChanged;
  const _AutoCommitRow({
    required this.checked,
    required this.done,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final color = done ? const Color(0xFF7ee787) : const Color(0xFFdbe9ff);
    final locked = done || onChanged == null;
    return Tooltip(
      message: t('autoCommitTitle'),
      child: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(height: 1, color: const Color(0x40ffffff)),
            const SizedBox(height: 4),
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: locked ? null : () => onChanged!(!checked),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: Checkbox(
                      value: checked,
                      onChanged: locked ? null : (v) => onChanged!(v ?? false),
                      activeColor: const Color(0xFF2ea043),
                      checkColor: Colors.white,
                      side: BorderSide(color: color.withValues(alpha: 0.7)),
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      visualDensity: VisualDensity.compact,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      done
                          ? '${t('autoCommitPerMsg')} ${t('autoCommitPerMsgDone')}'
                          : t('autoCommitPerMsg'),
                      style: TextStyle(
                        fontSize: 11,
                        color: color,
                        fontWeight: done ? FontWeight.w600 : FontWeight.normal,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  final ChatMessage message;
  final bool enableServerActions;
  const _AssistantBubble({
    required this.message,
    this.enableServerActions = true,
  });

  @override
  Widget build(BuildContext context) {
    final hasText = message.content.trim().isNotEmpty;
    final hasTools = message.toolCalls.isNotEmpty;
    final advancedMode = SettingsService.current?.advancedMode.value ?? true;

    return LayoutBuilder(
      builder: (context, constraints) {
        final laneWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        return Align(
          alignment: Alignment.centerLeft,
          child: GestureDetector(
            onLongPress: () => _showMessageActions(
              context,
              message,
              serverActions: enableServerActions,
            ),
            child: Container(
              constraints: BoxConstraints(maxWidth: laneWidth * 0.92),
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFFffffff),
                border: Border.all(color: const Color(0xFFdce6f1)),
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(12),
                  topRight: Radius.circular(12),
                  bottomRight: Radius.circular(12),
                  bottomLeft: Radius.circular(4),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (hasText)
                    _MarkdownContent(
                      text: message.content,
                      isStreaming: message.isStreaming,
                    ),
                  if (hasTools && advancedMode)
                    ToolCallGroup(toolCalls: message.toolCalls),
                  if (hasTools && advancedMode)
                    ToolTrajectory(toolCalls: message.toolCalls),
                  if (hasTools && !advancedMode)
                    _BasicToolSummary(toolCalls: message.toolCalls),
                  if (!hasText && !hasTools && message.isStreaming)
                    const _StreamingDot(),
                  // Token usage line
                  if (message.usage != null && !message.usage!.isEmpty)
                    _TokenUsageLine(usage: message.usage!),
                  // Timing line: reply timestamp + task duration
                  if (advancedMode && message.durationMs != null)
                    _TimingLine(
                      timestamp: message.timestamp,
                      durationMs: message.durationMs,
                    ),
                  // Durable interrupted draft (partial): never continues.
                  if (message.isPartial)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        '⚠ ${I18n.of('tbMsgPartial')}',
                        style: const TextStyle(
                          color: Color(0xFF6f8096),
                          fontSize: 11,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                    ),
                  _TaskAttributionTail(message: message),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Quiet task ownership marker at the physical bottom of every attributed
/// user/assistant bubble. The stable four-character code comes from the
/// server registry; clients never synthesize one from the full task id.
class _TaskAttributionTail extends StatelessWidget {
  const _TaskAttributionTail({required this.message, this.isUser = false});

  final ChatMessage message;
  final bool isUser;

  static String _preview(String value, [int limit = 10]) {
    final chars = value.runes.toList(growable: false);
    return chars.length > limit
        ? '${String.fromCharCodes(chars.take(limit))}…'
        : value;
  }

  @override
  Widget build(BuildContext context) {
    final code = (message.taskShortCode ?? '').trim().toUpperCase();
    if (!RegExp(r'^[0-9A-Z]{4}$').hasMatch(code)) {
      return const SizedBox.shrink();
    }
    final name = (message.taskName ?? '').trim();
    final label = '#$code${name.isEmpty ? '' : ' · ${_preview(name)}'}';
    final fullLabel = '#$code${name.isEmpty ? '' : ' · $name'}';
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Tooltip(
        message: fullLabel,
        child: Padding(
          key: const ValueKey('message-task-tail'),
          padding: const EdgeInsets.only(top: 5),
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: isUser
                  ? Colors.white.withValues(alpha: 0.52)
                  : const Color(0xFF6f8096).withValues(alpha: 0.72),
              fontSize: 9,
              height: 1.15,
              fontWeight: FontWeight.w500,
              letterSpacing: 0.15,
            ),
          ),
        ),
      ),
    );
  }
}

class _BasicToolSummary extends StatefulWidget {
  const _BasicToolSummary({required this.toolCalls});

  final List<ToolCall> toolCalls;

  @override
  State<_BasicToolSummary> createState() => _BasicToolSummaryState();
}

class _BasicToolSummaryState extends State<_BasicToolSummary> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final running = widget.toolCalls.any((tool) => !tool.isDone);
    final failed = widget.toolCalls.any((tool) => tool.isError);
    final statusColor = failed
        ? const Color(0xFFb64e43)
        : running
        ? const Color(0xFF1267b5)
        : const Color(0xFF1e8a55);
    final status = running
        ? t('workProgressRunning')
        : failed
        ? t('workProgressIssue')
        : t('workProgressChecked');

    return Container(
      key: const ValueKey('basic-tool-summary'),
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFf4f8fd),
        border: Border.all(color: const Color(0xFFdce6f1)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => _expanded = !_expanded),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 42),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 11),
                child: Row(
                  children: [
                    if (running)
                      const SizedBox(
                        width: 13,
                        height: 13,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.6,
                          color: Color(0xFF1267b5),
                        ),
                      )
                    else
                      Icon(
                        failed
                            ? Icons.error_outline_rounded
                            : Icons.check_circle_outline_rounded,
                        size: 16,
                        color: statusColor,
                      ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        status,
                        style: TextStyle(color: statusColor, fontSize: 12),
                      ),
                    ),
                    Text(
                      t('technicalDetailsCount', {
                        'n': '${widget.toolCalls.length}',
                      }),
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
                        fontSize: 10.5,
                      ),
                    ),
                    Icon(
                      _expanded
                          ? Icons.expand_less_rounded
                          : Icons.expand_more_rounded,
                      color: const Color(0xFF6f8096),
                      size: 17,
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: Column(
                children: [
                  ToolCallGroup(toolCalls: widget.toolCalls),
                  ToolTrajectory(toolCalls: widget.toolCalls),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Token usage line shown under assistant messages
class _TokenUsageLine extends StatelessWidget {
  final MessageUsage usage;
  const _TokenUsageLine({required this.usage});

  /// Format a token count for display: >1e6 → X.XXM, >1e3 → X.Xk,
  /// else thousand-separated raw number. The rules live in utils/format.dart
  /// (`formatTokenCount`), which the web's chat-live-ui .msg-usage row shares.
  static String _fmtSaved(int n) => formatTokenCount(n);

  @override
  Widget build(BuildContext context) {
    // One format for every message (mirrors the web .msg-usage u-row): a 主
    // row, plus a 辅 row only for a separately configured sub model — each
    // with fresh ↑入/↓出 and ♻读/♻写 cache.
    final roles = usage.displayRoles;
    final breakdown = usage.roleBreakdown;
    Widget row(String label, RoleTokenBucket b, {Widget? trailing}) => Wrap(
      spacing: 6,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: Color(0xFF6f8096),
            fontSize: 10.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        _UsageBadge(
          label: '↑入',
          value: _fmtSaved(b.inputTokens),
          color: const Color(0xFF1267b5),
        ),
        _UsageBadge(
          label: '↓出',
          value: _fmtSaved(b.outputTokens),
          color: const Color(0xFF2ba67a),
        ),
        _UsageBadge(
          label: '♻读',
          value: _fmtSaved(b.cacheRead),
          color: const Color(0xFFa85a25),
        ),
        _UsageBadge(
          label: '♻写',
          value: _fmtSaved(b.cacheWrite),
          color: const Color(0xFF6d4fd1),
        ),
        ?trailing,
      ],
    );
    final detail = breakdown != null && !breakdown.isEmpty
        ? _RoleDetailChip(breakdown: breakdown)
        : null;
    final main = roles.main;
    final sub = roles.sub;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      // Wrap per row, not Row: realistic token counts overflow a 320dp lane
      // inside a Row. Badges flow onto the next line instead of past the edge.
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (main != null)
            row(
              t('usageRoleMain'),
              main,
              trailing: sub == null ? detail : null,
            ),
          if (sub != null) ...[
            const SizedBox(height: 4),
            row(t('usageRoleSub'), sub, trailing: detail),
          ],
        ],
      ),
    );
  }
}

/// Opens the role-token breakdown sheet. Kept tiny — the usage line must not
/// overflow on narrow screens, so this is an icon, not a text badge.
class _RoleDetailChip extends StatelessWidget {
  final RoleTokenBreakdown breakdown;
  const _RoleDetailChip({required this.breakdown});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: t('roleTokenDetailTitle'),
      child: GestureDetector(
        onTap: () => _openSheet(context),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: const Color(0xFF1267b5).withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(4),
          ),
          child: const Icon(
            Icons.data_usage_rounded,
            size: 13,
            color: Color(0xFF1267b5),
          ),
        ),
      ),
    );
  }

  void _openSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFFffffff),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      builder: (_) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
          child: _RoleTokenSheetBody(breakdown: breakdown),
        ),
      ),
    );
  }
}

/// Sheet body: main bucket, sub bucket, per-provider split of the sub work.
/// Numbers are full (comma-grouped) — this is the detail view, not the bar.
class _RoleTokenSheetBody extends StatelessWidget {
  final RoleTokenBreakdown breakdown;
  const _RoleTokenSheetBody({required this.breakdown});

  @override
  Widget build(BuildContext context) {
    final sub = breakdown.sub;
    final providers = breakdown.subByProvider;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                t('roleTokenDetailTitle'),
                style: const TextStyle(
                  color: Color(0xFF20364d),
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            IconButton(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close, color: Color(0xFF6f8096)),
            ),
          ],
        ),
        const SizedBox(height: 4),
        _RoleBucketView(
          title: t('roleTokenMain'),
          accent: const Color(0xFF1267b5),
          bucket: breakdown.main,
        ),
        if (sub != null && !sub.isEmpty) ...[
          const SizedBox(height: 10),
          _RoleBucketView(
            title: t('roleTokenSub'),
            accent: const Color(0xFF2ba67a),
            bucket: sub,
          ),
        ],
        if (providers.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text(
            t('roleTokenByProvider'),
            style: const TextStyle(
              color: Color(0xFF6f8096),
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          for (final p in providers)
            if (!p.bucket.isEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _RoleBucketView(
                  title:
                      '${p.label}${p.model.isNotEmpty ? ' · ${p.model}' : ''}',
                  accent: const Color(0xFF6d4fd1),
                  bucket: p.bucket,
                  compact: true,
                ),
              ),
        ],
        if ((sub == null || sub.isEmpty) && providers.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              t('roleTokenNoSub'),
              style: const TextStyle(color: Color(0xFF6f8096), fontSize: 12),
            ),
          ),
      ],
    );
  }
}

/// One bucket row: label plus the four token counts, laid out to fit narrow
/// screens (label line on top, counts below).
class _RoleBucketView extends StatelessWidget {
  final String title;
  final Color accent;
  final RoleTokenBucket bucket;
  final bool compact;
  const _RoleBucketView({
    required this.title,
    required this.accent,
    required this.bucket,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    String group(int n) => n.toString().replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (m) => ',',
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFf8fbff),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: accent,
              fontSize: compact ? 12 : 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${t('roleTokenInput')} ${group(bucket.inputTokens)}'
            '  ${t('roleTokenOutput')} ${group(bucket.outputTokens)}'
            '  ${t('roleTokenCacheRead')} ${group(bucket.cacheRead)}'
            '  ${t('roleTokenCacheWrite')} ${group(bucket.cacheWrite)}',
            style: const TextStyle(
              color: Color(0xFF6f8096),
              fontSize: 12,
              fontFamily: 'monospace',
            ),
          ),
        ],
      ),
    );
  }
}

class _UsageBadge extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _UsageBadge({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        '$label $value',
        style: TextStyle(color: color, fontSize: 11, fontFamily: 'monospace'),
      ),
    );
  }
}

/// Timing line shown under assistant messages: reply clock time + task duration.
/// Mirrors the web client's buildTimingLine().
class _TimingLine extends StatelessWidget {
  final DateTime? timestamp;
  final int? durationMs;
  const _TimingLine({this.timestamp, this.durationMs});

  /// 一段测出来的墙钟时间：走 utils/format.dart 的 [formatDuration]（web 那侧
  /// chat-live-ui / chat-history-view 同一份）。
  static String _fmtDuration(int ms) => formatDuration(ms);

  @override
  Widget build(BuildContext context) {
    final parts = <Widget>[];

    if (timestamp != null) {
      final hh = timestamp!.hour.toString().padLeft(2, '0');
      final mm = timestamp!.minute.toString().padLeft(2, '0');
      final ss = timestamp!.second.toString().padLeft(2, '0');
      final now = DateTime.now();
      final sameDay =
          timestamp!.year == now.year &&
          timestamp!.month == now.month &&
          timestamp!.day == now.day;
      final sameYear = timestamp!.year == now.year;
      final month = timestamp!.month.toString().padLeft(2, '0');
      final day = timestamp!.day.toString().padLeft(2, '0');
      final date = sameDay
          ? ''
          : '${sameYear ? '' : '${timestamp!.year}-'}$month-$day ';
      parts.add(
        Text(
          '🕐 $date$hh:$mm:$ss',
          style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
        ),
      );
    }

    if (durationMs != null && durationMs! >= 0) {
      parts.add(
        Text(
          '⏱ ${_fmtDuration(durationMs!)}',
          style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
        ),
      );
    }

    if (parts.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      // Wrap for the same reason the usage line above wraps: a large text-scale
      // factor or a long duration must push the clock onto its own line rather
      // than overflow the bubble.
      child: Wrap(spacing: 10, runSpacing: 2, children: parts),
    );
  }
}

/// Regex matching a local-filesystem image path referenced in assistant
/// markdown — mirrors the web's `_LOCAL_IMG_RE` (see public/chat.js). When the
/// agent writes `![](/tmp/x.png)` we can't load that directly, so the image
/// builder rewrites it to `/api/download?path=…&inline=1` (streamed through
/// the multicc server) exactly like the web chat does.
final _localImgRe = RegExp(
  r'^(?:file:///|/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)/|[A-Za-z]:[\\/])',
);

/// Build the request for a local-filesystem image routed through the multicc
/// server. Authentication stays in the header and never enters the image URL.
MulticcDownloadRequest? _localImageRequest(String rawPath) {
  final s = SettingsService.current;
  if (s == null) return null;
  final p = rawPath.replaceFirst(RegExp(r'^file://'), '');
  return buildMulticcDownloadRequest(
    host: s.host,
    path: p,
    accessToken: s.token,
    inline: true,
  );
}

class _MarkdownContent extends StatelessWidget {
  final String text;
  final bool isStreaming;
  const _MarkdownContent({required this.text, required this.isStreaming});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        MarkdownBody(
          data: text,
          builders: {'code': _FencedCodeBuilder()},
          sizedImageBuilder: (config) {
            final raw = config.uri.toString();
            final isLocal = _localImgRe.hasMatch(raw);
            final localRequest = isLocal ? _localImageRequest(raw) : null;
            final url = isLocal ? localRequest?.uri.toString() : raw;
            if (url == null || url.isEmpty) {
              return _ImageErrorNote(name: config.alt ?? raw);
            }
            return _InlineImage(
              url: url,
              name: config.alt ?? (isLocal ? raw : 'image'),
              headers: localRequest?.headers ?? const {},
            );
          },
          styleSheet: MarkdownStyleSheet(
            p: const TextStyle(
              color: Color(0xFF233249),
              fontSize: 14,
              height: 1.6,
            ),
            code: const TextStyle(
              color: Color(0xFF233249),
              backgroundColor: Color(0xFFf8fbff),
              fontFamily: 'monospace',
              fontSize: 13,
            ),
            codeblockDecoration: BoxDecoration(
              color: const Color(0xFFf4f8fd),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFFf8fbff)),
            ),
            codeblockPadding: const EdgeInsets.all(12),
            blockquoteDecoration: const BoxDecoration(
              border: Border(
                left: BorderSide(color: Color(0xFFdce6f1), width: 3),
              ),
            ),
            blockquotePadding: const EdgeInsets.only(left: 10),
            h1: const TextStyle(
              color: Color(0xFF20364d),
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
            h2: const TextStyle(
              color: Color(0xFF20364d),
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
            h3: const TextStyle(
              color: Color(0xFF20364d),
              fontSize: 15,
              fontWeight: FontWeight.bold,
            ),
            strong: const TextStyle(
              color: Color(0xFF20364d),
              fontWeight: FontWeight.bold,
            ),
            em: const TextStyle(
              color: Color(0xFF6f42c1),
              fontStyle: FontStyle.italic,
            ),
            a: const TextStyle(color: Color(0xFF1267b5)),
            tableHead: const TextStyle(
              color: Color(0xFF20364d),
              fontWeight: FontWeight.bold,
            ),
            tableBody: const TextStyle(color: Color(0xFF233249)),
            tableBorder: TableBorder.all(color: const Color(0xFFdce6f1)),
            tableCellsPadding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 4,
            ),
          ),
          selectable: true,
          onTapLink: (text, href, title) => _handleLinkTap(context, href),
        ),
        if (isStreaming) const _StreamingDot(),
      ],
    );
  }
}

/// Renders fenced code blocks with syntax highlighting (web highlight.js
/// parity). Registered for the `code` element: fenced blocks carry a
/// `language-*` class and/or newlines; inline code returns null and keeps the
/// default chip rendering. `highlightCode` returns null for unknown languages
/// / oversized blocks / tokenizer failure — then this builder also returns
/// null and the default plain monospace block renders (safe fallback).
class _FencedCodeBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final cls = element.attributes['class'] ?? '';
    final langMatch = RegExp(r'language-([\w+#.-]+)').firstMatch(cls);
    final code = element.textContent;
    final isBlock = langMatch != null || code.contains('\n');
    if (!isBlock) return null;
    final language = langMatch?.group(1) ?? '';
    final spans = highlightCode(code, language);
    if (spans == null) return null;
    return _FencedCodeBlock(spans: spans);
  }
}

/// One highlighted code block. The surrounding `pre` container already paints
/// the codeblock background/border, so this supplies only the padding and the
/// horizontal scroll the default renderer had. Text.rich participates in the
/// ancestor SelectionArea — select/copy is preserved on both paths.
class _FencedCodeBlock extends StatelessWidget {
  final List<CodeSpan> spans;
  const _FencedCodeBlock({required this.spans});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.all(12),
      child: Text.rich(
        buildHighlightedSpan(
          spans,
          const TextStyle(
            color: Color(0xFF233249),
            fontFamily: 'monospace',
            fontSize: 13,
            height: 1.5,
          ),
        ),
        softWrap: false,
      ),
    );
  }
}

class _StreamingDot extends StatefulWidget {
  const _StreamingDot();
  @override
  State<_StreamingDot> createState() => _StreamingDotState();
}

class _StreamingDotState extends State<_StreamingDot>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);
    _anim = Tween<double>(begin: 0.2, end: 1.0).animate(_ctrl);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) => Container(
        margin: const EdgeInsets.only(top: 4, left: 2),
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: AppColors.accent.withValues(alpha: _anim.value),
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}

/// 🔇 系统注入卡（Web 的 `.msg.user.system-inject`）：一行「图标 + 【…】标题」，
/// 正文默认压成一行省略号，点标题展开（展开态按原文换行）。
///
/// 它出现在会话里的身份是 role=user（引擎就是这么落库的），所以它在别的「用户
/// 消息」语义里必须被排除：不挂自动提交勾选（本文件的分支直接绕开 `_UserBubble`），
/// 不当「最后一条用户消息」（services/auto_commit.dart 的 lastUserMessageId），
/// 引用时算系统行（services/message_quote.dart 的 _roleKey）。
class _SystemInjectBubble extends StatefulWidget {
  const _SystemInjectBubble({
    required this.message,
    required this.parts,
    this.enableServerActions = true,
  });

  final ChatMessage message;
  final SystemInjectParts parts;
  final bool enableServerActions;

  @override
  State<_SystemInjectBubble> createState() => _SystemInjectBubbleState();
}

class _SystemInjectBubbleState extends State<_SystemInjectBubble> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final body = widget.parts.body;
    final hasBody = body.isNotEmpty;
    return Align(
      alignment: Alignment.centerLeft,
      child: GestureDetector(
        // 和其它气泡同一张长按菜单：复制/引用，落库后还能删除（只删显示，与 Web 的 ✕ 一致）。
        onLongPress: () => _showMessageActions(
          context,
          widget.message,
          serverActions: widget.enableServerActions,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          constraints: const BoxConstraints(maxWidth: 620),
          decoration: BoxDecoration(
            color: AppColors.bgSoft,
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(AppColors.radiusChip),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                // 标题行整条都是展开开关；没有正文的注入（一行的「继续：…」）不接点击。
                onTap: hasBody ? () => setState(() => _open = !_open) : null,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('🔇', style: TextStyle(fontSize: 11)),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        widget.parts.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (hasBody) ...[
                      const SizedBox(width: 6),
                      Icon(
                        _open ? Icons.expand_more : Icons.chevron_right,
                        size: 14,
                        color: AppColors.faint,
                      ),
                    ],
                  ],
                ),
              ),
              if (hasBody)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(
                    body,
                    // 折叠 = 一行省略号；展开 = 全文，换行按原文保留。
                    maxLines: _open ? null : 1,
                    overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 12,
                      height: 1.45,
                    ),
                  ),
                ),
              _TaskAttributionTail(message: widget.message),
            ],
          ),
        ),
      ),
    );
  }
}

class _SystemBubble extends StatelessWidget {
  final ChatMessage message;
  const _SystemBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: GestureDetector(
        onLongPress: () => _copyMessage(context, message.content),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(
            message.content,
            style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 12),
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Inline image rendering for assistant markdown
//  Local filesystem paths (`![](/tmp/x.png)`) are rewritten to the multicc
//  server's `/api/download?inline=1` route — same trick the web chat uses —
//  so the agent can show users screenshots / generated charts. Tap to open a
//  fullscreen zoomable view (InteractiveViewer, pinch + drag).
// ═══════════════════════════════════════════════════════════════════════════════

/// Inline image shown inside a markdown message bubble. Constrained to a
/// sensible max width, rounded corners, loading spinner, graceful error note.
class _InlineImage extends StatelessWidget {
  final String url;
  final String name;
  final Map<String, String> headers;
  const _InlineImage({
    required this.url,
    required this.name,
    this.headers = const {},
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: GestureDetector(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) =>
                _ImageZoomScreen(url: url, name: name, headers: headers),
            fullscreenDialog: true,
          ),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 280),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.network(
              url,
              headers: headers,
              fit: BoxFit.contain,
              gaplessPlayback: true,
              loadingBuilder: (ctx, child, progress) => progress == null
                  ? child
                  : Container(
                      height: 80,
                      color: const Color(0xFFffffff),
                      alignment: Alignment.center,
                      child: const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Color(0xFF1267b5),
                        ),
                      ),
                    ),
              errorBuilder: (ctx, err, _) =>
                  _ImageErrorNote(name: name, compact: true),
            ),
          ),
        ),
      ),
    );
  }
}

/// Fallback shown when a referenced image can't be resolved or loaded.
class _ImageErrorNote extends StatelessWidget {
  final String name;
  final bool compact;
  const _ImageErrorNote({required this.name, this.compact = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: EdgeInsets.symmetric(horizontal: 8, vertical: compact ? 6 : 8),
      decoration: BoxDecoration(
        color: const Color(0xFFfff1ef),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFe9bdb7)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.broken_image_outlined,
            size: 14,
            color: Color(0xFFb64e43),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              compact ? '图片无法加载: $name' : '⚠ 无法加载图片: $name',
              style: const TextStyle(color: Color(0xFFb64e43), fontSize: 12),
              overflow: TextOverflow.ellipsis,
              maxLines: 2,
            ),
          ),
        ],
      ),
    );
  }
}

/// Fullscreen, pinch-to-zoom image viewer. Black background, drag to pan,
/// double-tap to reset. Reached by tapping an inline image.
class _ImageZoomScreen extends StatefulWidget {
  final String url;
  final String name;
  final Map<String, String> headers;
  const _ImageZoomScreen({
    required this.url,
    required this.name,
    required this.headers,
  });

  @override
  State<_ImageZoomScreen> createState() => _ImageZoomScreenState();
}

class _ImageZoomScreenState extends State<_ImageZoomScreen> {
  final _tctrl = TransformationController();

  @override
  void dispose() {
    _tctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(
          widget.name,
          style: const TextStyle(fontSize: 13),
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, size: 20),
            tooltip: '重置缩放',
            onPressed: () => _tctrl.value = Matrix4.identity(),
          ),
        ],
      ),
      body: GestureDetector(
        onDoubleTap: () => _tctrl.value = Matrix4.identity(),
        child: Center(
          child: InteractiveViewer(
            transformationController: _tctrl,
            minScale: 0.5,
            maxScale: 5.0,
            boundaryMargin: const EdgeInsets.all(double.infinity),
            child: Image.network(
              widget.url,
              headers: widget.headers,
              fit: BoxFit.contain,
              loadingBuilder: (ctx, child, progress) => progress == null
                  ? child
                  : const Center(
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white70,
                      ),
                    ),
              errorBuilder: (ctx, err, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.broken_image,
                      size: 48,
                      color: Color(0xFFb64e43),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      '无法加载: ${widget.name}',
                      style: const TextStyle(
                        color: Color(0xFFb64e43),
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
