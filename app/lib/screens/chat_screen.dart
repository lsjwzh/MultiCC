import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/chat_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'setup_screen.dart';

/// Reusable chat view — expects a ChatProvider in the widget tree
/// (provided by MainShell via ChangeNotifierProvider.value).
class ChatView extends StatefulWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;
  const ChatView({super.key, required this.settings, this.onCollapse});

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _scrollCtrl = ScrollController();
  Timer? _mergeTimer;
  String? _polledSession;
  Map<String, dynamic>? _mergeStatus;

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _mergeTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.watch<ChatProvider>();
    final session = provider.sessionName;
    if (session == _polledSession) return;
    _polledSession = session;
    _mergeTimer?.cancel();
    _refreshMergeStatus(session);
    _mergeTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _refreshMergeStatus(session),
    );
  }

  Future<void> _refreshMergeStatus(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final status = await SessionService(
        settings: widget.settings,
      ).fetchMergeStatus(sessionId);
      if (!mounted || _polledSession != sessionId) return;
      setState(() => _mergeStatus = status);
    } catch (_) {}
  }

  Future<void> _mergeCurrent(BuildContext context, String sessionId) async {
    await confirmMergeWorktree(context, widget.settings, sessionId);
    await _refreshMergeStatus(sessionId);
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final mergeReady = _mergeStatus?['mergeReady'] == true;
    return Scaffold(
      backgroundColor: const Color(0xFF0d1117),
      body: SafeArea(
        child: Column(
          children: [
            _Header(
              settings: widget.settings,
              onCollapse: widget.onCollapse,
              mergeReady: mergeReady,
              mergeLabel: _mergeStatusText(_mergeStatus),
              onMerge: () => _mergeCurrent(context, provider.sessionName),
            ),
            _CwdBar(),
            Expanded(child: _MessageList(scrollCtrl: _scrollCtrl)),
            _CostBar(),
            if (mergeReady)
              _MergeReadyBanner(
                text: _mergeStatusText(_mergeStatus),
                onMerge: () => _mergeCurrent(context, provider.sessionName),
              ),
            const InputBar(),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;
  final bool mergeReady;
  final String mergeLabel;
  final VoidCallback onMerge;
  const _Header({
    required this.settings,
    this.onCollapse,
    required this.mergeReady,
    required this.mergeLabel,
    required this.onMerge,
  });

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final state = provider.connectionState;

    Color statusColor;
    switch (state) {
      case ChatConnectionState.connected:
        statusColor = const Color(0xFF3fb950);
        break;
      case ChatConnectionState.connecting:
        statusColor = const Color(0xFFd29922);
        break;
      case ChatConnectionState.disconnected:
        statusColor = const Color(0xFF8b949e);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: const BoxDecoration(
        color: Color(0xFF161b22),
        border: Border(bottom: BorderSide(color: Color(0xFF30363d))),
      ),
      child: Row(
        children: [
          // Collapse the chat sheet back down to the home dashboard.
          GestureDetector(
            onTap: onCollapse,
            child: Container(
              padding: const EdgeInsets.all(6),
              child: const Icon(
                Icons.keyboard_arrow_down_rounded,
                color: Color(0xFFc9d1d9),
                size: 24,
              ),
            ),
          ),
          const SizedBox(width: 4),
          RichText(
            text: const TextSpan(
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              children: [
                TextSpan(
                  text: 'Multi',
                  style: TextStyle(color: Color(0xFFf78166)),
                ),
                TextSpan(
                  text: 'CC',
                  style: TextStyle(color: Color(0xFF79c0ff)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          _ChatCliBadge(cli: provider.cli),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              provider.displayName,
              style: const TextStyle(
                color: Color(0xFF58a6ff),
                fontSize: 13,
                fontWeight: FontWeight.w600,
                fontFamily: 'monospace',
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: state == ChatConnectionState.disconnected
                ? provider.reconnect
                : null,
            child: Icon(Icons.circle, size: 8, color: statusColor),
          ),
          const Spacer(),
          // Model switch — claude sessions only (codex has no model concept here).
          if (provider.cli == SessionCli.claude) ...[
            _ModelChip(sessionId: provider.sessionName),
            const SizedBox(width: 4),
          ],
          // Memo button — project memo (multicc.memo.md) for the session's directory.
          _HeaderBtn(
            icon: Icons.sticky_note_2_outlined,
            tooltip: '项目备忘 (multicc.memo.md)',
            onTap: () => _openMemoFromSession(context, provider.sessionName),
          ),
          const SizedBox(width: 4),
          // Merge worktree button
          _HeaderBtn(
            icon: Icons.merge_type,
            tooltip: mergeReady ? mergeLabel : '合并 worktree',
            active: mergeReady,
            onTap: onMerge,
          ),
          const SizedBox(width: 4),
          // Clear history button
          _HeaderBtn(
            icon: Icons.delete_sweep_outlined,
            tooltip: 'Clear history',
            onTap: () => _confirmClear(context, provider),
          ),
          const SizedBox(width: 4),
          // Settings button
          _HeaderBtn(
            icon: Icons.settings_outlined,
            tooltip: 'Settings',
            onTap: () => _openSettings(context, settings),
          ),
        ],
      ),
    );
  }

  void _confirmClear(BuildContext context, ChatProvider provider) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Clear History'),
        content: const Text(
          'This will clear the chat history and reset the Claude session.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8b949e)),
            ),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              provider.clearHistory();
            },
            child: const Text(
              'Clear',
              style: TextStyle(color: Color(0xFFf85149)),
            ),
          ),
        ],
      ),
    );
  }

  void _openSettings(BuildContext context, SettingsService settings) {
    Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => SetupScreen(settings: settings)));
  }
}

/// Compact model indicator + switcher for the chat header. Reads the current
/// per-session model from SessionManager; tap to switch (next turn applies).
class _ModelChip extends StatelessWidget {
  final String sessionId;
  const _ModelChip({required this.sessionId});

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    Session? s;
    for (final x in mgr.sessions) {
      if (x.id == sessionId) { s = x; break; }
    }
    final label = claudeModelShortName(s?.model);
    return Tooltip(
      message: '切换该会话使用的模型（下一轮对话生效）',
      child: GestureDetector(
        onTap: () => _switchModel(context, mgr, s),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xFF21262d),
            border: Border.all(color: const Color(0xFF30363d)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.psychology_outlined,
                size: 15,
                color: Color(0xFFc9d1d9),
              ),
              const SizedBox(width: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 86),
                child: Text(
                  label,
                  style: const TextStyle(
                    color: Color(0xFFc9d1d9),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _switchModel(
    BuildContext context,
    SessionManager mgr,
    Session? s,
  ) async {
    if (s == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Session 信息未加载')),
      );
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final picked = await showClaudeModelPicker(
      context,
      current: s.model ?? '',
      title: '切换该会话使用的模型（下一轮对话生效）',
    );
    if (picked == null) return;
    try {
      await mgr.updateSessionModel(s.id, picked);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            '✓ 模型已切换为 ${picked.isEmpty ? '默认（跟随 Claude 设置）' : claudeModelShortName(picked)}，下一轮对话生效',
          ),
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('模型切换失败：$e')));
    }
  }
}

// Open the directory-memo screen for the given session's directory. Used by the
// chat AppBar to expose the project memo without leaving the chat view.
void _openMemoFromSession(BuildContext context, String sessionId) {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) { s = x; break; }
  }
  if (s == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Session 信息未加载')),
    );
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) { d = x; break; }
  }
  if (d == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('找不到对应目录')),
    );
    return;
  }
  Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => MemoScreen(directory: d!, mgr: mgr),
    ),
  );
}

Future<void> confirmMergeWorktree(
  BuildContext context,
  SettingsService settings,
  String sessionId,
) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      backgroundColor: const Color(0xFF161b22),
      title: const Text(
        '合并 worktree',
        style: TextStyle(fontSize: 15, color: Color(0xFFf0f6fc)),
      ),
      content: const Text(
        '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
        style: TextStyle(color: Color(0xFFc9d1d9)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('取消', style: TextStyle(color: Color(0xFF8b949e))),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text(
            '合并',
            style: TextStyle(
              color: Color(0xFF58a6ff),
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(const SnackBar(content: Text('正在合并 worktree...')));
  try {
    final result = await SessionService(
      settings: settings,
    ).mergeSession(sessionId);
    final hasConflict =
        result['conflicts'] is List && (result['conflicts'] as List).isNotEmpty;
    String msg;
    if (result['ok'] == true) {
      msg = result['merged'] == true
          ? '✓ 已合并 ${result['commits']} 个提交回基分支'
          : '✓ ${result['message'] ?? '没有新提交需要合并'}';
    } else if (result['conflicts'] != null) {
      msg = '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}';
    } else {
      msg = '合并失败：${result['error'] ?? ''}';
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(msg)));
    if (hasConflict && context.mounted) {
      await showConflictDiffDialog(
        context,
        sessionId: sessionId,
        result: result,
      );
    }
  } catch (e) {
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
  }
}

class _HeaderBtn extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool active;
  const _HeaderBtn({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.active = false,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(
            color: active ? const Color(0xFFd29922) : const Color(0xFF21262d),
            border: Border.all(
              color: active ? const Color(0xFFe3b341) : const Color(0xFF30363d),
            ),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(
            icon,
            color: active ? const Color(0xFF0d1117) : const Color(0xFFc9d1d9),
            size: 18,
          ),
        ),
      ),
    );
  }
}

String _mergeStatusText(Map<String, dynamic>? status) {
  if (status?['mergeReady'] != true) return '当前 worktree 没有需要合并的内容。';
  final bits = <String>[];
  if (status?['dirty'] == true) bits.add('有未提交改动');
  final ahead = (status?['ahead'] as num?)?.toInt() ?? 0;
  if (ahead > 0) bits.add('$ahead 个提交领先');
  final detail = bits.isEmpty ? '有可合并内容' : bits.join('，');
  return '$detail，可合并回 ${status?['baseBranch'] ?? '基分支'}。';
}

class _MergeReadyBanner extends StatelessWidget {
  final String text;
  final VoidCallback onMerge;
  const _MergeReadyBanner({required this.text, required this.onMerge});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFd29922)),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          const Icon(
            Icons.merge_type_rounded,
            size: 16,
            color: Color(0xFFf2cc60),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF0d1117),
              backgroundColor: const Color(0xFFd29922),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: const Text(
              '合并',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _CwdBar extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF0d1117),
        border: Border(bottom: BorderSide(color: Color(0xFF21262d))),
      ),
      child: Row(
        children: [
          const Icon(Icons.folder_outlined, size: 14, color: Color(0xFF6e7681)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              provider.cwd.isEmpty ? '(unknown)' : provider.cwd,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                color: Color(0xFF58a6ff),
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          GestureDetector(
            onTap: () => _showCwdDialog(context, provider),
            child: const Text(
              'Change',
              style: TextStyle(fontSize: 11, color: Color(0xFF8b949e)),
            ),
          ),
        ],
      ),
    );
  }

  void _showCwdDialog(BuildContext context, ChatProvider provider) {
    final ctrl = TextEditingController(text: provider.cwd);
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text(
          'Change Working Directory',
          style: TextStyle(fontSize: 15),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(
            color: Color(0xFFc9d1d9),
            fontFamily: 'monospace',
            fontSize: 13,
          ),
          decoration: InputDecoration(
            hintText: '/path/to/project',
            hintStyle: const TextStyle(color: Color(0xFF484f58)),
            filled: true,
            fillColor: const Color(0xFF0d1117),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: Color(0xFF30363d)),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8b949e)),
            ),
          ),
          TextButton(
            onPressed: () {
              final newCwd = ctrl.text.trim();
              Navigator.pop(context);
              if (newCwd.isNotEmpty && newCwd != provider.cwd) {
                provider.changeCwd(newCwd);
              }
            },
            child: const Text(
              'Apply',
              style: TextStyle(
                color: Color(0xFF58a6ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageList extends StatefulWidget {
  final ScrollController scrollCtrl;
  const _MessageList({required this.scrollCtrl});

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  bool _userScrolled = false;

  @override
  void initState() {
    super.initState();
    widget.scrollCtrl.addListener(_onScroll);
  }

  void _onScroll() {
    if (!widget.scrollCtrl.hasClients) return;
    final pos = widget.scrollCtrl.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 60;
    if (atBottom && _userScrolled) {
      setState(() => _userScrolled = false);
    } else if (!atBottom && !_userScrolled) {
      setState(() => _userScrolled = true);
    }
  }

  void _scrollToBottom() {
    if (!widget.scrollCtrl.hasClients || _userScrolled) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.scrollCtrl.hasClients) {
        widget.scrollCtrl.animateTo(
          widget.scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final messages = provider.messages;
    final showThinking =
        provider.isStreaming &&
        (messages.isEmpty ||
            messages.last.role != MessageRole.assistant ||
            messages.last.content.isEmpty && messages.last.toolCalls.isEmpty);

    _scrollToBottom();

    return Stack(
      children: [
        ListView.builder(
          controller: widget.scrollCtrl,
          padding: const EdgeInsets.all(12),
          itemCount: messages.length + (showThinking ? 1 : 0),
          itemBuilder: (_, i) {
            if (i == messages.length) return const ThinkingIndicator();
            return MessageBubble(message: messages[i]);
          },
        ),
        if (_userScrolled)
          Positioned(
            bottom: 8,
            right: 8,
            child: GestureDetector(
              onTap: () {
                setState(() => _userScrolled = false);
                _scrollToBottom();
              },
              child: Container(
                padding: const EdgeInsets.all(6),
                decoration: BoxDecoration(
                  color: const Color(0xFF238636),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Icon(
                  Icons.keyboard_arrow_down,
                  color: Colors.white,
                  size: 20,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _CostBar extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final costText = context.watch<ChatProvider>().costText;
    if (costText.isEmpty) return const SizedBox.shrink();
    return Container(
      color: const Color(0xFF0d1117),
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Text(
        costText,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Color(0xFF6e7681), fontSize: 11),
      ),
    );
  }
}

class _ChatCliBadge extends StatelessWidget {
  final SessionCli cli;
  const _ChatCliBadge({required this.cli});
  @override
  Widget build(BuildContext context) {
    final color = cli == SessionCli.codex
        ? const Color(0xFF3fb950)
        : const Color(0xFFf78166);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        border: Border.all(color: color.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        cli.name,
        style: TextStyle(
          color: color,
          fontSize: 9,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
