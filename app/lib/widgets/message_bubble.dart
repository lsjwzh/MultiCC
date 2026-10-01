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
import '../services/annotation_inbox.dart';
import '../services/download_ticket_service.dart';
import '../services/message_quote.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../utils/code_highlight.dart';
import 'image_annotate_screen.dart';
import 'tool_card.dart';

/// Resolve a markdown link href and open it externally.
///
/// Handles four forms:
///  - a local filesystem absolute path (`/Users/…/x.dart`, `file:///…`) — with
///    or without the configured server origin prefix — is opened as the file
///    itself (streamed through `/api/download`), never as a server URL
///  - absolute `http(s)://…` links → opened as-is
///  - root-relative links like `/artifacts/<id>/index.html` (multicc artifacts,
///    file downloads) → resolved against the configured server base URL
///  - `mailto:` / other schemes → handed to the OS as-is
Future<void> _handleLinkTap(BuildContext context, String? href) async {
  if (href == null || href.trim().isEmpty) return;
  var target = href.trim();
  final settings = SettingsService.current;

  // 本地文件链接：agent 可能写裸绝对路径，也可能因为知道 `MULTICC_BASE_URL`
  // 而写 `http://<server>/Users/...`。两者都要打开**文件**本身，而不是在服务器上
  // 找一个不存在的路由（点出去就是 404）。剥掉 origin 后走 `/api/download`。
  final localPath = localFileLinkPath(target, settings);
  if (localPath != null && settings != null) {
    await _openLocalFile(context, localPath, settings);
    return;
  }

  // Root-relative path: resolve against the multicc server we're talking to.
  if (target.startsWith('/')) {
    final base = settings?.buildHttpUrl(target);
    if (base != null) target = base;
  } else if (!target.contains('://') && !target.startsWith('mailto:')) {
    // Bare host or path without a scheme — assume http for the current server.
    final base = settings?.buildHttpUrl('/$target');
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

/// 把聊天里的本地文件链接解析成本机绝对路径；不是本地文件就返回 null。
///
/// 接受两种形态（与 Web `fixupLocalFileLinks` 同一条判定）：
///   - 裸绝对路径：`/Users/…`、`/tmp/…`、`file:///…`（匹配 [_localImgRe]）
///   - 带 server origin：`http://127.0.0.1:3000/Users/…` —— 只有 origin 与当前
///     配置的服务器一致时才剥掉 origin，剩下就是文件路径；别把外站链接当成文件。
@visibleForTesting
String? localFileLinkPath(String target, SettingsService? settings) {
  var path = target;
  if (path.startsWith('file://')) path = path.substring('file://'.length);
  if (_localImgRe.hasMatch(path)) return path;

  final uri = Uri.tryParse(path);
  if (uri == null ||
      !uri.hasScheme ||
      (uri.scheme != 'http' && uri.scheme != 'https')) {
    return null;
  }
  final serverHost = settings?.host ?? '';
  if (serverHost.isEmpty) return null;
  final server = Uri.tryParse(
    serverHost.startsWith('http') ? serverHost : 'http://$serverHost',
  );
  if (server == null) return null;
  if (uri.scheme != server.scheme ||
      uri.host.toLowerCase() != server.host.toLowerCase()) {
    return null;
  }
  if ((uri.hasPort && !server.hasPort) ||
      (!uri.hasPort && server.hasPort) ||
      (uri.hasPort && uri.port != server.port)) {
    return null;
  }
  final p = uri.path;
  return _localImgRe.hasMatch(p) ? p : null;
}

/// 通过 `/api/download` 打开服务器上的一个本地文件（流式下载/预览）。鉴权走
/// download-ticket，与文件浏览器打开文件是同一条路。
Future<void> _openLocalFile(
  BuildContext context,
  String path,
  SettingsService settings,
) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final request = buildMulticcDownloadRequest(
      host: settings.host,
      path: path,
      accessToken: settings.token,
    );
    final tickets = DownloadTicketClient();
    final uri = await tickets.authorize(
      request: request,
      ticketEndpoint: Uri.parse(
        settings.buildHttpUrl('/api/auth/download-ticket'),
      ),
    );
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
      return;
    }
  } catch (_) {
    // Fall through to a stable snack error without leaking a token/ticket.
  }
  if (context.mounted) {
    messenger.showSnackBar(
      SnackBar(
        content: Text('无法打开文件：$path'),
        duration: const Duration(milliseconds: 1800),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

/// 一条消息在长按菜单里能做的事，按展示顺序。
enum MessageAction { copy, quote, delete, fork }

/// 这条消息该摆哪几个动作 —— 全 App 唯一一份清单。
///
/// 少一个入口不会有任何报错：输入框通道（provider 的 `quoteInserter`）没人登记，
/// 菜单里就少一行，功能静悄悄地没了。所以这份判定必须能被单独测。
List<MessageAction> availableMessageActions(
  BuildContext context,
  ChatMessage message, {
  bool serverActions = true,
  bool allowQuote = true,
}) {
  // 删除/分叉是会话历史操作，绑 ChatProvider + 会话 REST 接口；只读转录宿主
  // （任务详情）只给复制。
  final provider = context.read<ChatProvider?>();
  final canDelete =
      serverActions &&
      (provider?.historyArchive != true) &&
      (message.id ?? '').isNotEmpty;
  // 引用要落进输入框，所以能不能引用问的是「本宿主有没有输入框」，不是
  // 「能不能动服务端历史」—— 引用不改任何东西，只是把已有的话搬进输入框。
  // 没有输入框、或者这条消息本来就摘不出引用块（空白消息），都别摆这个入口：
  // 摆了也点不出结果。
  final quote = allowQuote && provider?.quoteInserter != null
      ? buildMessageQuote(message)
      : '';
  final canQuote = quote.isNotEmpty;
  return [
    MessageAction.copy,
    if (canQuote) MessageAction.quote,
    if (canDelete) MessageAction.delete,
    if (canDelete) MessageAction.fork,
  ];
}

/// 动作在菜单里的名字。
String messageActionLabel(MessageAction action) => switch (action) {
  MessageAction.copy => I18n.of('msgCopyAction'),
  MessageAction.quote => I18n.of('msgQuoteAction'),
  MessageAction.delete => I18n.of('msgDeleteAction'),
  MessageAction.fork => I18n.of('msgForkAction'),
};

/// 执行一个菜单动作。
Future<void> runMessageAction(
  BuildContext context,
  ChatMessage message,
  MessageAction action,
) async {
  switch (action) {
    case MessageAction.copy:
      _copyMessage(context, messageCopyText(message));
    case MessageAction.quote:
      final quote = context.read<ChatProvider?>()?.quoteInserter == null
          ? ''
          : buildMessageQuote(message);
      if (quote.isEmpty) return;
      _quoteMessage(context, message, quote);
    case MessageAction.delete:
      await _confirmDeleteMessage(context, message);
    case MessageAction.fork:
      await _forkFromMessage(context, message);
  }
}

/// 把一条消息的文字交给**系统**的选择机制。
///
/// 长按选中之后弹的是系统自己的工具条（iOS 上的拷贝 / 查询 / 共享…），和用户在
/// 系统里选任何一段文字走的是同一条路 —— 选择、拖动句柄、全选、放大镜全都是原生的。
/// App 的动作（复制内容 / 引用 / 隐藏 / 分叉）追加在系统条目之后，所以菜单换了宿主
/// 但没有丢。
///
/// 一条气泡只有一个选择域，正文、代码块、工具输出因此可以连着一起选。代价是长按
/// 手势从此归选择用，不再有第二个长按入口。`_MarkdownContent` 也相应关掉了自己的
/// `selectable`：`SelectableText` 会另起一个选择域，把正文从这条链上摘出去，正文
/// 就成了唯一弹不出 App 动作的地方。
class _MessageSelection extends StatelessWidget {
  const _MessageSelection({
    required this.message,
    required this.child,
    this.serverActions = true,
    this.allowQuote = true,
  });

  final ChatMessage message;
  final Widget child;
  final bool serverActions;
  final bool allowQuote;

  @override
  Widget build(BuildContext context) {
    return SelectionArea(
      contextMenuBuilder: (ctx, state) =>
          AdaptiveTextSelectionToolbar.buttonItems(
            anchors: state.contextMenuAnchors,
            buttonItems: [
              ...state.contextMenuButtonItems,
              for (final action in availableMessageActions(
                ctx,
                message,
                serverActions: serverActions,
                allowQuote: allowQuote,
              ))
                ContextMenuButtonItem(
                  label: messageActionLabel(action),
                  onPressed: () {
                    state.hideToolbar();
                    runMessageAction(ctx, message, action);
                  },
                ),
            ],
          ),
      child: child,
    );
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

/// 一条消息里能复制的全部文本：正文 + 每个工具调用的命令与输出。
///
/// 「复制内容」原先只取 `message.content`。于是纯工具轮（模型只发工具调用、没有
/// 正文的那条）取到空串，点下去静默返回 —— 用户看到的就是「长按之后没有复制
/// 功能」；而长按工具输出时，复制到的又是正文，不是长按的那一块。工具卡片的
/// 输入/输出本来就画在这个气泡里，它就是这条消息的内容。
String messageCopyText(ChatMessage message) {
  final parts = <String>[];
  final prose = message.content.trim();
  if (prose.isNotEmpty) parts.add(prose);
  for (final call in message.toolCalls) {
    final buffer = StringBuffer();
    final head = call.description.trim();
    if (head.isNotEmpty) buffer.writeln(head);
    final result = (call.result ?? '').trim();
    if (result.isNotEmpty) buffer.write(result);
    final text = buffer.toString().trim();
    if (text.isNotEmpty) parts.add(text);
  }
  return parts.join('\n\n');
}

/// Copy a message's text to the clipboard with a brief confirmation.
///
/// 没东西可复制时必须**说出来**：静默返回等于「点了没反应」，用户只会认为复制
/// 功能坏了 —— 纯工具轮的长按正是踩在这上面。
void _copyMessage(BuildContext context, String text) {
  final t = text.trim();
  final messenger = ScaffoldMessenger.of(context);
  if (t.isEmpty) {
    messenger.showSnackBar(
      const SnackBar(
        content: Text('这条消息没有可复制的内容'),
        duration: Duration(milliseconds: 1600),
        behavior: SnackBarBehavior.floating,
      ),
    );
    return;
  }
  Clipboard.setData(ClipboardData(text: t));
  messenger.showSnackBar(
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

  const MessageBubble({
    super.key,
    required this.message,
    this.enableServerActions = true,
  });

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case MessageRole.user:
        // 🔇 系统注入（引擎写的 role=user）不是人打的：画成系统卡，不画用户气泡。
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
  const _UserBubble({
    required this.message,
    this.enableServerActions = true,
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
          child: _MessageSelection(
            message: message,
            serverActions: enableServerActions,
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

    // 模型归属的落点（与 Web 端同一条规则，见 public/chat-live-ui.js 的
    // attachModelAttribution）：优先贴到轨迹那行「⏱ N tools · Xs wall-clock」的
    // 最右端 —— 那是页脚里最像「这轮多久」的一行；工具不足两个时那一行整个不画
    // （[hasTrajectoryContent]），于是退到 🕐/⏱ 时间行（那一行两种模式都画，见
    // 下面 _TimingLine 那道条件）；两行都没内容（时间戳与耗时都没有的老历史）才
    // 自占一行。前两种情况下这些行的右边本来就是空的，所以既不多占一行，也挤不
    // 掉原有内容 —— 基本模式同样走前两种落点，不再落到自占一行那一档。
    final trajectoryShown =
        hasTools && advancedMode && hasTrajectoryContent(message.toolCalls);
    // timingShown 同时管两件事，必须是同一个条件：① 那一行真的画得出来，② 归属
    // 有宿主行可贴。判据的下半截直接问 [_TimingLine.hasContent]（= 那一行自己的
    // 渲染条件，唯一真源）—— 宿主行自己是空的，右边就没有那块空位，归属贴上去等于
    // 白贴，还会连带丢掉本来该有的兜底。
    //
    // 上半截是流式期间先不画：Web 的活体气泡同样如此（public/chat-event-controller.js
    // 只在 result 事件里补这一行），否则回复还在写的时候页脚就冒出一个时钟，两端在
    // 流式期间对不上，收尾时那一行还要跳一下。
    final timingShown = !(message.isStreaming && message.durationMs == null)
        && _TimingLine.hasContent(message.timestamp, message.durationMs);

    return LayoutBuilder(
      builder: (context, constraints) {
        final laneWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        return Align(
          alignment: Alignment.centerLeft,
          child: _MessageSelection(
            message: message,
            serverActions: enableServerActions,
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
                    ToolTrajectory(
                      toolCalls: message.toolCalls,
                      turnDurationMs: message.durationMs,
                      attribution: trajectoryShown
                          ? message.modelAttribution
                          : null,
                    ),
                  if (hasTools && !advancedMode)
                    _BasicToolSummary(
                      toolCalls: message.toolCalls,
                      durationMs: message.durationMs,
                    ),
                  if (!hasText && !hasTools && message.isStreaming)
                    const _StreamingDot(),
                  // Token usage line
                  if (message.usage != null && !message.usage!.isEmpty)
                    _TokenUsageLine(usage: message.usage!),
                  // Timing line: reply timestamp + task duration.
                  // 两种模式都建（基本模式一样要知道「这轮什么时候回的、跑了多久」，
                  // 而且归属也要有个宿主行可贴）。闸门就是上面的 timingShown：它与
                  // 这一行的渲染条件、以及归属的落点判定用的是同一个布尔 —— 三处
                  // 不可能走散。
                  if (timingShown)
                    _TimingLine(
                      timestamp: message.timestamp,
                      durationMs: message.durationMs,
                      // 轨迹文案行不在时，归属才退到这一行（两处只能贴一处）。
                      attribution: trajectoryShown
                          ? null
                          : message.modelAttribution,
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
                  // 模型归属：正常情况下它贴在轨迹文案行 / 时间行的最右端（见
                  // 上面的 trajectoryShown / timingShown），只有那两行都不在时
                  // 才在这里自占一行兜底。
                  if (!trajectoryShown && !timingShown)
                    _ModelAttributionLine(
                      attribution: message.modelAttribution,
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

/// 归属的**兜底**一行：页脚里那两行（轨迹的墙钟文案行、🕐/⏱ 时间行）都不在时才
/// 走这里。右对齐，并且仍然只在真的有归属时渲染（attribution 为 null / 三段全空
/// = 不留空壳）。
///
/// **App 上它现在是够不到的，但理由不是一个恒真的条件**：归属只在 result 事件里
/// 落到消息上（见 transcript_live_folder 的 attachResultUsage），那一刻气泡已经
/// 不是流式了，于是时间行必定在场（`timingShown` 在非流式下就是
/// [_TimingLine.hasContent]，而 [ChatMessage.timestamp] 非空 ⇒ 恒真）。留着它是当
/// 这两条不变量被破坏时的安全网 —— 否则那种情况下归属会静默消失，而不是退化成
/// 一行。Web 侧（public/chat-live-ui.js 的 `.msg-model-attribution-row`）是**同一
/// 套**兜底，但那边够得到：老历史记录的 `ts` 可以为空。两端结构一致是有意的。
///
/// 一段会话里可以换过多次线路/模型，逐条标注才好溯源。只挂在 assistant 气泡上：
/// user / system 消息没有「哪个模型产出」这回事。
class _ModelAttributionLine extends StatelessWidget {
  const _ModelAttributionLine({required this.attribution});

  final ModelAttribution? attribution;

  @override
  Widget build(BuildContext context) {
    final segments = modelAttributionSegments(attribution);
    if (segments.isEmpty) return const SizedBox.shrink();
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: ModelAttributionLabel(segments: segments),
      ),
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
  const _BasicToolSummary({required this.toolCalls, this.durationMs});
  final List<ToolCall> toolCalls;
  final int? durationMs;

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
                  ToolTrajectory(
                    toolCalls: widget.toolCalls,
                    turnDurationMs: widget.durationMs,
                  ),
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

  /// 这条回复的模型归属，贴在这一行的**最右端**（不额外占一行：🕐/⏱ 右边本来
  /// 就是空的）。null = 没有归属，或者归属已经贴在轨迹文案行上了。
  final ModelAttribution? attribution;
  const _TimingLine({this.timestamp, this.durationMs, this.attribution});

  /// 一段测出来的墙钟时间：走 utils/format.dart 的 [formatDuration]（web 那侧
  /// chat-live-ui / chat-history-view 同一份）。
  static String _fmtDuration(int ms) => formatDuration(ms);

  /// 这一行**真的会画出内容**吗 —— 就是 [build] 的渲染条件，唯一真源。时钟段看
  /// [timestamp]，时长段看 [durationMs]（负数不画）；两段都没有时 build 返回
  /// [SizedBox.shrink]，不留痕迹。
  ///
  /// 模型归属的落点判定必须问这一句（而不是自己另写一份「有没有时间行」）：宿主
  /// 行自己是空的，右边就没有那块空位，归属贴上去等于白贴，还会连带丢掉本来的
  /// 自占一行兜底。参数是 nullable 的，所以调用方可以把消息字段直接递进来。
  static bool hasContent(DateTime? timestamp, int? durationMs) =>
      timestamp != null || (durationMs != null && durationMs >= 0);

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

    // 与 [hasContent] 同义（parts 非空 <=> 至少一段有值），写成这一步而不是直接
    // 数 parts，是为了让「画画的条件」和「调用方判落点的条件」永远是同一句。
    if (!hasContent(timestamp, durationMs)) return const SizedBox.shrink();

    // Wrap for the same reason the usage line above wraps: a large text-scale
    // factor or a long duration must push the clock onto its own line rather
    // than overflow the bubble.
    final line = Wrap(spacing: 10, runSpacing: 2, children: parts);
    final segments = modelAttributionSegments(attribution);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      // 有归属时这一行变成「时钟/时长 …… 归属」：两段都 Flexible，窄屏各自
      // 让位；spaceBetween 把余量全给中间，归属因此顶在这一行的最右端。
      child: segments.isEmpty
          ? line
          : Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Flexible(child: line),
                const SizedBox(width: 10),
                Flexible(child: ModelAttributionLabel(segments: segments)),
              ],
            ),
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
          // 关掉自己的选择域，正文才会并进气泡那一个 `SelectionArea`
          // （见 `_MessageSelection`）。这里开 `selectable: true` 会渲染成
          // `SelectableText`，它另起一个选择域：正文能选，但选中后弹的系统工具条
          // 里没有 App 的动作，而且选不过相邻的代码块 —— 一条消息被切成两半。
          selectable: false,
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
/// horizontal scroll the default renderer had.
///
/// 这里的 `Text.rich` 自己不带选择域：它靠祖先那个 `SelectionArea`（气泡外层的
/// `_MessageSelection`）参与选中，长按弹的是系统工具条。原先的注释写着「参与祖先
/// SelectionArea，两条路径都保留选中/复制」，当时全 App 根本没有 SelectionArea，
/// 于是代码块既选不中、又只有「复制内容」能救 —— 现在那句才成立。
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
/// 消息」语义里必须被排除：画成系统卡而不是用户气泡（本文件的分支直接绕开
/// `_UserBubble`），引用时算系统行（services/message_quote.dart 的 _roleKey）。
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
      // 和其它气泡同一张菜单：复制/引用，落库后还能删除（只删显示，与 Web 的 ✕ 一致）。
      child: _MessageSelection(
        message: widget.message,
        serverActions: widget.enableServerActions,
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
      // 系统行（role=system）在会话里没有身份可指认，也就没有引用/删除/分叉，
      // 只剩复制 —— 但复制同样走系统工具条，和其它气泡一致。
      child: _MessageSelection(
        message: message,
        serverActions: false,
        allowQuote: false,
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
            builder: (_) => _ImageZoomScreen(
              url: url,
              name: name,
              headers: headers,
              sessionId: _currentSessionId(context),
            ),
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

String _currentSessionId(BuildContext context) {
  try {
    return context.read<ChatProvider>().executionSessionName;
  } catch (_) {
    return '';
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
  final String sessionId;
  const _ImageZoomScreen({
    required this.url,
    required this.name,
    required this.headers,
    this.sessionId = '',
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

  /// Annotate → the draft goes to the composer via [AnnotationInbox]; pop
  /// first so the chat route is current when the input bar picks it up.
  Future<void> _annotate() async {
    final draft = await Navigator.of(context).push<AnnotationDraft>(
      MaterialPageRoute(
        builder: (_) => ImageAnnotateScreen(
          url: widget.url,
          headers: widget.headers,
          sessionId: widget.sessionId,
        ),
      ),
    );
    if (draft == null || !mounted) return;
    Navigator.of(context).pop();
    AnnotationInbox.publish(draft);
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
            icon: const Icon(Icons.edit_outlined, size: 20),
            tooltip: t('annotAction'),
            onPressed: _annotate,
          ),
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
