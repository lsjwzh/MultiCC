import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
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

/// Long-press action sheet: copy always; delete only when the message has a
/// server-side history id (streaming / not-yet-persisted bubbles aren't
/// addressable — the id arrives via the chat_msg_meta WS event once saved).
Future<void> _showMessageActions(BuildContext context, ChatMessage message) async {
  final canDelete = (message.id ?? '').isNotEmpty;
  final action = await showModalBottomSheet<String>(
    context: context,
    backgroundColor: const Color(0xFF161b22),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.copy_outlined, color: Color(0xFF8b949e)),
            title: Text(I18n.of('msgCopyAction'),
                style: const TextStyle(color: Color(0xFFe6edf3))),
            onTap: () => Navigator.pop(ctx, 'copy'),
          ),
          if (canDelete)
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Color(0xFFf85149)),
              title: Text(I18n.of('msgDeleteAction'),
                  style: const TextStyle(color: Color(0xFFf85149))),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          if (canDelete)
            ListTile(
              leading: const Icon(Icons.call_split, color: Color(0xFF39c5cf)),
              title: Text(I18n.of('msgForkAction'),
                  style: const TextStyle(color: Color(0xFF39c5cf))),
              onTap: () => Navigator.pop(ctx, 'fork'),
            ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  if (action == 'copy') {
    _copyMessage(context, message.content);
  } else if (action == 'delete') {
    await _confirmDeleteMessage(context, message);
  } else if (action == 'fork') {
    await _forkFromMessage(context, message);
  }
}

/// Confirm, then delete the message from the server's chat history.
/// Display-history only — the CLI's own conversation context is untouched.
/// Local removal is driven by the chat_msg_deleted WS broadcast (idempotent),
/// with a direct provider fallback in case the socket is momentarily down.
Future<void> _confirmDeleteMessage(BuildContext context, ChatMessage message) async {
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
          child: Text(I18n.of('msgDeleteAction'),
              style: const TextStyle(color: Color(0xFFf85149))),
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
    await SessionService(settings: settings)
        .deleteMessage(provider.sessionId, msgId);
    provider.removeMessageById(msgId);
    messenger.showSnackBar(SnackBar(
      content: Text(I18n.of('msgDeleted')),
      duration: const Duration(milliseconds: 1200),
      behavior: SnackBarBehavior.floating,
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(
      content: Text(I18n.of('msgDeleteFailed', {'error': '$e'})),
      duration: const Duration(milliseconds: 2200),
      behavior: SnackBarBehavior.floating,
    ));
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
          child: Text(I18n.of('msgForkAction'),
              style: const TextStyle(color: Color(0xFF39c5cf))),
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
    final newId = await SessionService(settings: settings)
        .forkSession(provider.sessionId, atMessageId: msgId);
    messenger.showSnackBar(SnackBar(
      content: Text(I18n.of('msgForked', {'id': newId})),
      duration: const Duration(milliseconds: 2400),
      behavior: SnackBarBehavior.floating,
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(
      content: Text(I18n.of('msgForkFailed', {'error': '$e'})),
      duration: const Duration(milliseconds: 2200),
      behavior: SnackBarBehavior.floating,
    ));
  }
}

class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  const MessageBubble({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case MessageRole.user:
        return _UserBubble(message: message);
      case MessageRole.assistant:
        return _AssistantBubble(message: message);
      case MessageRole.system:
        return _SystemBubble(message: message);
    }
  }
}

class _UserBubble extends StatelessWidget {
  final ChatMessage message;
  const _UserBubble({required this.message});

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
            onLongPress: () => _showMessageActions(context, message),
            child: Container(
              constraints: BoxConstraints(maxWidth: laneWidth * 0.85),
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: const BoxDecoration(
                color: Color(0xFF22ab9c),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(12),
                  topRight: Radius.circular(12),
                  bottomLeft: Radius.circular(12),
                  bottomRight: Radius.circular(4),
                ),
              ),
              child: Text(
                message.content,
                style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.5),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  final ChatMessage message;
  const _AssistantBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final hasText = message.content.trim().isNotEmpty;
    final hasTools = message.toolCalls.isNotEmpty;

    return LayoutBuilder(
      builder: (context, constraints) {
        final laneWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        return Align(
          alignment: Alignment.centerLeft,
          child: GestureDetector(
            onLongPress: () => _showMessageActions(context, message),
            child: Container(
              constraints: BoxConstraints(maxWidth: laneWidth * 0.92),
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFF0f1115),
                border: Border.all(color: const Color(0xFF20242b)),
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
                  if (hasTools) ToolCallGroup(toolCalls: message.toolCalls),
                  if (!hasText && !hasTools && message.isStreaming)
                    const _StreamingDot(),
                  // Token usage line
                  if (message.usage != null && !message.usage!.isEmpty)
                    _TokenUsageLine(usage: message.usage!),
                  // Timing line: reply timestamp + task duration
                  if (message.durationMs != null)
                    _TimingLine(
                      timestamp: message.timestamp,
                      durationMs: message.durationMs,
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Token usage line shown under assistant messages
class _TokenUsageLine extends StatelessWidget {
  final MessageUsage usage;
  const _TokenUsageLine({required this.usage});

  static String _fmt(int n) {
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
    return n.toString();
  }

  @override
  Widget build(BuildContext context) {
    final i = usage.inputTokens;
    final o = usage.outputTokens;
    final cr = usage.cacheReadTokens;
    final cw = usage.cacheCreationTokens;

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          _UsageBadge(label: '↑入', value: _fmt(i), color: const Color(0xFF58a6ff)),
          const SizedBox(width: 6),
          _UsageBadge(label: '↓出', value: _fmt(o), color: const Color(0xFF3fb950)),
          if (cr > 0) ...[
            const SizedBox(width: 6),
            _UsageBadge(label: '⏱读', value: _fmt(cr), color: const Color(0xFFd29922)),
          ],
          if (cw > 0) ...[
            const SizedBox(width: 6),
            _UsageBadge(label: '⏱写', value: _fmt(cw), color: const Color(0xFFa371f7)),
          ],
        ],
      ),
    );
  }
}

class _UsageBadge extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _UsageBadge({required this.label, required this.value, required this.color});

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
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontFamily: 'monospace',
        ),
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

  static String _fmtDuration(int ms) {
    if (ms < 1000) return '${ms}ms';
    final s = ms / 1000;
    if (s < 60) return '${s.toStringAsFixed(1)}s';
    final m = (s / 60).floor();
    return '${m}m${(s % 60).round()}s';
  }

  @override
  Widget build(BuildContext context) {
    final parts = <Widget>[];

    if (timestamp != null) {
      final hh = timestamp!.hour.toString().padLeft(2, '0');
      final mm = timestamp!.minute.toString().padLeft(2, '0');
      final ss = timestamp!.second.toString().padLeft(2, '0');
      parts.add(Text(
        '🕐 $hh:$mm:$ss',
        style: const TextStyle(color: Color(0xFF6e7681), fontSize: 11),
      ));
    }

    if (durationMs != null && durationMs! >= 0) {
      if (parts.isNotEmpty) parts.add(const SizedBox(width: 10));
      parts.add(Text(
        '⏱ ${_fmtDuration(durationMs!)}',
        style: const TextStyle(color: Color(0xFF6e7681), fontSize: 11),
      ));
    }

    if (parts.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(children: parts),
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

/// Build the full HTTP url for a local-filesystem image, routed through the
/// multicc server's `/api/download?inline=1` endpoint (with token if set).
String? _localImageUrl(String rawPath) {
  final s = SettingsService.current;
  if (s == null) return null;
  final p = rawPath.replaceFirst(RegExp(r'^file://'), '');
  var url = s.buildHttpUrl(
    '/api/download?path=${Uri.encodeQueryComponent(p)}&inline=1',
  );
  if (s.token.isNotEmpty) {
    url += '&token=${Uri.encodeQueryComponent(s.token)}';
  }
  return url;
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
          sizedImageBuilder: (config) {
            final raw = config.uri.toString();
            final isLocal = _localImgRe.hasMatch(raw);
            final url = isLocal ? _localImageUrl(raw) : raw;
            if (url == null || url.isEmpty) {
              return _ImageErrorNote(name: config.alt ?? raw);
            }
            return _InlineImage(
              url: url,
              name: config.alt ?? (isLocal ? raw : 'image'),
            );
          },
          styleSheet: MarkdownStyleSheet(
            p: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14, height: 1.6),
            code: const TextStyle(
              color: Color(0xFFe7eaee),
              backgroundColor: Color(0xFF14171c),
              fontFamily: 'monospace',
              fontSize: 13,
            ),
            codeblockDecoration: BoxDecoration(
              color: const Color(0xFF070809),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFF14171c)),
            ),
            codeblockPadding: const EdgeInsets.all(12),
            blockquoteDecoration: const BoxDecoration(
              border: Border(left: BorderSide(color: Color(0xFF20242b), width: 3)),
            ),
            blockquotePadding: const EdgeInsets.only(left: 10),
            h1: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 18, fontWeight: FontWeight.bold),
            h2: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 16, fontWeight: FontWeight.bold),
            h3: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 15, fontWeight: FontWeight.bold),
            strong: const TextStyle(color: Color(0xFFf2f4f7), fontWeight: FontWeight.bold),
            em: const TextStyle(color: Color(0xFFd2a8ff), fontStyle: FontStyle.italic),
            a: const TextStyle(color: Color(0xFF6aa3ff)),
            tableHead: const TextStyle(color: Color(0xFFf2f4f7), fontWeight: FontWeight.bold),
            tableBody: const TextStyle(color: Color(0xFFe7eaee)),
            tableBorder: TableBorder.all(color: const Color(0xFF20242b)),
            tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          ),
          selectable: true,
          onTapLink: (text, href, title) => _handleLinkTap(context, href),
        ),
        if (isStreaming) const _StreamingDot(),
      ],
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
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 800))
      ..repeat(reverse: true);
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
          color: Color.fromRGBO(88, 166, 255, _anim.value),
          shape: BoxShape.circle,
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
            style: const TextStyle(color: Color(0xFF5b616c), fontSize: 12),
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
  const _InlineImage({required this.url, required this.name});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: GestureDetector(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => _ImageZoomScreen(url: url, name: name),
            fullscreenDialog: true,
          ),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 280),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.network(
              url,
              fit: BoxFit.contain,
              gaplessPlayback: true,
              loadingBuilder: (ctx, child, progress) => progress == null
                  ? child
                  : Container(
                      height: 80,
                      color: const Color(0xFF0f1115),
                      alignment: Alignment.center,
                      child: const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Color(0xFF6aa3ff)),
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
      padding: EdgeInsets.symmetric(
          horizontal: 8, vertical: compact ? 6 : 8),
      decoration: BoxDecoration(
        color: const Color(0xFF140a0a),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF5b2d28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.broken_image_outlined,
              size: 14, color: Color(0xFFff6b63)),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              compact ? '图片无法加载: $name' : '⚠ 无法加载图片: $name',
              style: const TextStyle(color: Color(0xFFff6b63), fontSize: 12),
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
  const _ImageZoomScreen({required this.url, required this.name});

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
        title: Text(widget.name,
            style: const TextStyle(fontSize: 13),
            overflow: TextOverflow.ellipsis),
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
              fit: BoxFit.contain,
              loadingBuilder: (ctx, child, progress) => progress == null
                  ? child
                  : const Center(
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white70),
                    ),
              errorBuilder: (ctx, err, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.broken_image,
                        size: 48, color: Color(0xFFff6b63)),
                    const SizedBox(height: 12),
                    Text('无法加载: ${widget.name}',
                        style: const TextStyle(
                            color: Color(0xFFff6b63), fontSize: 13)),
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
