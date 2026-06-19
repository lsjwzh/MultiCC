import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/chat_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/model_picker.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'settings_screen.dart';

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
  // Track the last-warned behind count per session so the SnackBar fires when a
  // worktree first falls behind main (or falls further), not on every 5s poll.
  int _lastWarnedBehind = 0;
  bool _syncing = false;

  int _behindCount() => (_mergeStatus?['behind'] as num?)?.toInt() ?? 0;
  String _baseBranchName() => _mergeStatus?['baseBranch']?.toString() ?? 'main';

  // One-click sync: pull the base branch into this session's worktree.
  Future<void> _syncWorktree(String sessionId) async {
    if (sessionId.isEmpty || _syncing) return;
    setState(() => _syncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final res = await SessionService(
        settings: widget.settings,
      ).syncSession(sessionId);
      messenger.hideCurrentSnackBar();
      if (res['ok'] == true) {
        final merged = res['merged'] == true;
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              merged
                  ? '✓ 已从 ${res['baseBranch'] ?? 'base'} 同步 ${res['commits']} 个提交'
                  : (res['message']?.toString() ?? '已是最新'),
            ),
          ),
        );
      } else if ((res['conflicts'] as List?)?.isNotEmpty == true) {
        messenger.showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF3a1414),
            content: Text(
              '✗ 同步冲突已 abort，worktree 未改动：${(res['conflicts'] as List).join(', ')}',
              style: const TextStyle(color: Color(0xFFff9b9b)),
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      } else {
        messenger.showSnackBar(
          SnackBar(content: Text('✗ 同步失败：${res['error'] ?? '未知错误'}')),
        );
      }
      _lastWarnedBehind = 0; // allow a fresh warning if it falls behind again
      await _refreshMergeStatus(sessionId);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('✗ 同步请求失败：$e')));
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

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
    _lastWarnedBehind = 0; // reset warning state when switching sessions
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
      _maybeWarnBehind();
    } catch (_) {}
  }

  // Fire a SnackBar the moment this worktree is detected as behind its base
  // branch (and again only if it falls further behind), so the user sees it
  // without having to scan the header.
  void _maybeWarnBehind() {
    final behind = _behindCount();
    if (behind > _lastWarnedBehind) {
      final base = _baseBranchName();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF2d2108),
            content: Text(
              '⚠ 当前 worktree 已落后 $base $behind 个提交，建议同步',
              style: const TextStyle(color: Color(0xFFf2cc60)),
            ),
            duration: const Duration(seconds: 5),
          ),
        );
    }
    _lastWarnedBehind = behind;
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
      backgroundColor: const Color(0xFF070809),
      body: SafeArea(
        child: Column(
          children: [
            _Header(
              settings: widget.settings,
              onCollapse: widget.onCollapse,
              mergeReady: mergeReady,
              onMerge: () => _mergeCurrent(context, provider.sessionName),
            ),
            _CwdBar(mergeStatus: _mergeStatus),
            if (_behindCount() > 0)
              _BehindMainBanner(
                behind: _behindCount(),
                baseBranch: _baseBranchName(),
                syncing: _syncing,
                onSync: () => _syncWorktree(provider.sessionName),
              ),
            Expanded(child: _MessageList(scrollCtrl: _scrollCtrl)),
            _CostBar(),
            if (mergeReady)
              _MergeReadyBanner(
                text: _mergeStatusText(_mergeStatus),
                onMerge: () => _mergeCurrent(context, provider.sessionName),
                onDiff: () => showSessionDiffDialog(
                  context,
                  settings: widget.settings,
                  sessionId: provider.sessionName,
                ),
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
  final VoidCallback onMerge;
  const _Header({
    required this.settings,
    this.onCollapse,
    required this.mergeReady,
    required this.onMerge,
  });

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final state = provider.connectionState;

    Color statusColor;
    switch (state) {
      case ChatConnectionState.connected:
        statusColor = const Color(0xFF7fd49a);
        break;
      case ChatConnectionState.connecting:
        statusColor = const Color(0xFFe3b341);
        break;
      case ChatConnectionState.disconnected:
        statusColor = const Color(0xFF8a909b);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: const BoxDecoration(
        color: Color(0xFF0f1115),
        border: Border(bottom: BorderSide(color: Color(0xFF20242b))),
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
                color: Color(0xFFe7eaee),
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
                  style: TextStyle(color: Color(0xFF3ad6c5)),
                ),
                TextSpan(
                  text: 'CC',
                  style: TextStyle(color: Color(0xFF6aa3ff)),
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
                color: Color(0xFF6aa3ff),
                fontSize: 13,
                fontWeight: FontWeight.w600,
                fontFamily: 'monospace',
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          // Connection dot — tap to manually reconnect whenever not connected.
          // A refresh glyph appears so the affordance is discoverable and gives
          // a larger touch target than the bare 8px dot.
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap:
                state == ChatConnectionState.connected ? null : provider.reconnect,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 8, color: statusColor),
                  if (state != ChatConnectionState.connected) ...[
                    const SizedBox(width: 4),
                    const Icon(
                      Icons.refresh_rounded,
                      size: 15,
                      color: Color(0xFF8a909b),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const Spacer(),
          // Manual reconnect — always available, even when the status dot reads
          // green. Rebuilds the WebSocket from scratch to recover a socket that
          // looks connected but is actually dead (half-open, no onDone/onError),
          // which otherwise only a full app restart could fix.
          _HeaderBtn(
            icon: Icons.sync_rounded,
            tooltip: '重连（重建连接）',
            onTap: () => _forceReconnect(context, provider),
          ),
          const SizedBox(width: 4),
          // Model switch — claude sessions only (codex has no model concept here).
          if (provider.cli == SessionCli.claude) ...[
            _ModelChip(sessionId: provider.sessionName),
            const SizedBox(width: 4),
          ],
          // Overflow menu — collapses the occasional actions (memo / merge /
          // clear history / settings) behind a single "⋮" trigger so the
          // action cluster keeps a fixed, compact width and never pushes icons
          // past the right edge on narrow screens. mergeReady tints the
          // trigger amber as a discoverable hint (the banner still surfaces it).
          _HeaderOverflowMenu(
            mergeReady: mergeReady,
            onRole: () => _editRoleFromSession(context, provider.sessionName),
            onMemo: () => _openMemoFromSession(context, provider.sessionName),
            onMerge: onMerge,
            onClear: () => _confirmClear(context, provider),
            onSettings: () => _openSettings(context, settings),
            onShare: () => _shareFromSession(context, provider.sessionName, settings),
          ),
        ],
      ),
    );
  }

  void _forceReconnect(BuildContext context, ChatProvider provider) {
    provider.reconnect();
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(
          content: Text('正在重建连接…'),
          duration: Duration(seconds: 2),
          backgroundColor: Color(0xFF14171c),
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
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              provider.clearHistory();
            },
            child: const Text(
              'Clear',
              style: TextStyle(color: Color(0xFFff6b63)),
            ),
          ),
        ],
      ),
    );
  }

  void _openSettings(BuildContext context, SettingsService settings) {
    Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => SettingsScreen(settings: settings)));
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
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.psychology_outlined,
                size: 15,
                color: Color(0xFFe7eaee),
              ),
              const SizedBox(width: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 86),
                child: Text(
                  label,
                  style: const TextStyle(
                    color: Color(0xFFe7eaee),
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

// Edit the per-session role prompt (system-prompt override) from the chat
// header overflow menu. Empty = clear → inherits the directory default.
Future<void> _editRoleFromSession(
    BuildContext context, String sessionId) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) { s = x; break; }
  }
  if (s == null) {
    messenger.showSnackBar(
      const SnackBar(content: Text('Session 信息未加载')),
    );
    return;
  }
  final picked =
      await _showRolePromptEditor(context, current: s.rolePrompt ?? '');
  if (picked == null) return; // cancelled
  try {
    await mgr.updateSessionRolePrompt(s.id, picked);
    messenger.showSnackBar(
      SnackBar(
        content: Text(picked.trim().isEmpty
            ? '✓ 已清除会话角色（继承目录默认），下一轮对话生效'
            : '✓ 角色提示词已更新，下一轮对话生效'),
      ),
    );
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('角色保存失败：$e')));
  }
}

// Share a session externally. Recipient always opens a web page; this only
// creates the link and lets the user copy it. 'operate' requires a password.
Future<void> _shareFromSession(
    BuildContext context, String sessionId, SettingsService settings) async {
  final svc = SessionService(settings: settings);
  String access = 'view';
  final pwCtrl = TextEditingController();
  String? url;
  String? error;
  bool busy = false;

  await showDialog<void>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        backgroundColor: const Color(0xFF14171c),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: Color(0xFF20242b)),
        ),
        title: const Text('分享会话',
            style: TextStyle(color: Color(0xFFe7eaee), fontSize: 16)),
        content: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('接收方在浏览器打开链接即可。',
                  style: TextStyle(color: Color(0xFF8b949e), fontSize: 12)),
              const SizedBox(height: 4),
              const Text('「可对话」= 对方能通过此会话在你机器上执行操作，务必设强密码。',
                  style: TextStyle(color: Color(0xFFe3853f), fontSize: 12)),
              const SizedBox(height: 12),
              DropdownButton<String>(
                value: access,
                dropdownColor: const Color(0xFF14171c),
                isExpanded: true,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                items: const [
                  DropdownMenuItem(value: 'view', child: Text('只读查看')),
                  DropdownMenuItem(value: 'operate', child: Text('可对话（需密码）')),
                ],
                onChanged: busy ? null : (v) => setState(() => access = v ?? 'view'),
              ),
              TextField(
                controller: pwCtrl,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                decoration: const InputDecoration(
                  hintText: '密码（只读可留空；可对话必填）',
                  hintStyle: TextStyle(color: Color(0xFF6e7681), fontSize: 13),
                ),
              ),
              if (error != null) ...[
                const SizedBox(height: 8),
                Text(error!, style: const TextStyle(color: Color(0xFFff6b63), fontSize: 12)),
              ],
              if (url != null) ...[
                const SizedBox(height: 12),
                SelectableText(url!,
                    style: const TextStyle(color: Color(0xFF79c0ff), fontSize: 12)),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('关闭', style: TextStyle(color: Color(0xFF8b949e))),
          ),
          if (url != null)
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url!));
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('链接已复制')));
              },
              child: const Text('复制链接', style: TextStyle(color: Color(0xFF58a6ff))),
            ),
          TextButton(
            onPressed: busy
                ? null
                : () async {
                    final pw = pwCtrl.text.trim();
                    if (access == 'operate' && pw.isEmpty) {
                      setState(() => error = '「可对话」必须设置密码');
                      return;
                    }
                    setState(() { busy = true; error = null; });
                    try {
                      final r = await svc.createShare(sessionId,
                          access: access, password: pw.isEmpty ? null : pw);
                      setState(() { url = r['url'] as String?; busy = false; });
                    } catch (e) {
                      setState(() { error = '$e'; busy = false; });
                    }
                  },
            child: Text(url == null ? '生成链接' : '重新生成',
                style: const TextStyle(color: Color(0xFF3fb950))),
          ),
        ],
      ),
    ),
  );
}

// Multi-line role-prompt editor dialog. Returns the new text, or null on cancel.
Future<String?> _showRolePromptEditor(BuildContext context,
    {required String current}) {
  final controller = TextEditingController(text: current);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: const Color(0xFF14171c),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFF20242b)),
      ),
      title: const Text('角色提示词',
          style: TextStyle(color: Color(0xFFe7eaee), fontSize: 16)),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: controller,
              maxLines: 9,
              minLines: 5,
              maxLength: 8000,
              autofocus: true,
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: const InputDecoration(
                hintText:
                    '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
                hintStyle: TextStyle(color: Color(0xFF6b7280), fontSize: 12),
                enabledBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Color(0xFF20242b))),
                focusedBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Color(0xFF2ea043))),
              ),
            ),
            const Text('留空＝清除（会话将继承目录默认角色）',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child:
              const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, controller.text),
          child:
              const Text('保存', style: TextStyle(color: Color(0xFF3fb950))),
        ),
      ],
    ),
  );
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
      backgroundColor: const Color(0xFF0f1115),
      title: const Text(
        '合并 worktree',
        style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
      ),
      content: const Text(
        '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
        style: TextStyle(color: Color(0xFFe7eaee)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text(
            '合并',
            style: TextStyle(
              color: Color(0xFF6aa3ff),
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
  const _HeaderBtn({
    required this.icon,
    required this.tooltip,
    required this.onTap,
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
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(
            icon,
            color: const Color(0xFFe7eaee),
            size: 18,
          ),
        ),
      ),
    );
  }
}

/// Overflow menu for the chat header. Collapses the occasional actions
/// (memo / merge worktree / clear history / settings) behind a single "⋮"
/// trigger, keeping the header's action cluster a fixed, compact width so its
/// icons never overflow the right edge on narrow screens.
class _HeaderOverflowMenu extends StatelessWidget {
  final bool mergeReady;
  final VoidCallback onRole;
  final VoidCallback onMemo;
  final VoidCallback onMerge;
  final VoidCallback onClear;
  final VoidCallback onSettings;
  final VoidCallback onShare;
  const _HeaderOverflowMenu({
    required this.mergeReady,
    required this.onRole,
    required this.onMemo,
    required this.onMerge,
    required this.onClear,
    required this.onSettings,
    required this.onShare,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '更多',
      color: const Color(0xFF14171c),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Color(0xFF20242b)),
      ),
      offset: const Offset(0, 40),
      onSelected: (value) {
        switch (value) {
          case 'role':
            onRole();
            break;
          case 'memo':
            onMemo();
            break;
          case 'merge':
            onMerge();
            break;
          case 'clear':
            onClear();
            break;
          case 'share':
            onShare();
            break;
          case 'settings':
            onSettings();
            break;
        }
      },
      itemBuilder: (_) => [
        _item('role', Icons.theater_comedy_outlined, '角色提示词',
            const Color(0xFFe7eaee)),
        _item('memo', Icons.sticky_note_2_outlined, '项目备忘',
            const Color(0xFFe7eaee)),
        _item('share', Icons.share_outlined, '分享会话',
            const Color(0xFFe7eaee)),
        _item(
          'merge',
          Icons.merge_type,
          mergeReady ? '合并 worktree（可合并）' : '合并 worktree',
          mergeReady ? const Color(0xFFe3b341) : const Color(0xFFe7eaee),
        ),
        _item('clear', Icons.delete_sweep_outlined, 'Clear history',
            const Color(0xFFff6b63)),
        const PopupMenuDivider(),
        _item('settings', Icons.settings_outlined, 'Settings',
            const Color(0xFFe7eaee)),
      ],
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: mergeReady ? const Color(0xFFe3b341) : const Color(0xFF14171c),
          border: Border.all(
            color:
                mergeReady ? const Color(0xFFe3b341) : const Color(0xFF20242b),
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Icon(
          Icons.more_vert,
          color: mergeReady ? const Color(0xFF070809) : const Color(0xFFe7eaee),
          size: 18,
        ),
      ),
    );
  }

  PopupMenuItem<String> _item(
      String value, IconData icon, String label, Color color) {
    return PopupMenuItem<String>(
      value: value,
      height: 44,
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 12),
          Text(label, style: TextStyle(color: color, fontSize: 14)),
        ],
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
  final VoidCallback onDiff;
  const _MergeReadyBanner({
    required this.text,
    required this.onMerge,
    required this.onDiff,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
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
            onPressed: onDiff,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFf2cc60),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              minimumSize: Size.zero,
              side: const BorderSide(color: Color(0xFFe3b341)),
            ),
            child: const Text(
              '查看 Diff',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
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

// Persistent top banner shown while the session's worktree is behind its base
// branch — complements the transient SnackBar with an always-visible reminder.
class _BehindMainBanner extends StatelessWidget {
  final int behind;
  final String baseBranch;
  final VoidCallback onSync;
  final bool syncing;
  const _BehindMainBanner({
    required this.behind,
    required this.baseBranch,
    required this.onSync,
    this.syncing = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.history_rounded, size: 16, color: Color(0xFFf2cc60)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '当前 worktree 落后 $baseBranch $behind 个提交',
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: syncing ? null : onSync,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              syncing ? '同步中…' : '同步',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _CwdBar extends StatelessWidget {
  final Map<String, dynamic>? mergeStatus;
  const _CwdBar({this.mergeStatus});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final branch = mergeStatus?['branch']?.toString();
    final behind = (mergeStatus?['behind'] as num?)?.toInt() ?? 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF070809),
        border: Border(bottom: BorderSide(color: Color(0xFF14171c))),
      ),
      child: Row(
        children: [
          const Icon(Icons.folder_outlined, size: 14, color: Color(0xFF5b616c)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              provider.cwd.isEmpty ? '(unknown)' : provider.cwd,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                color: Color(0xFF6aa3ff),
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (branch != null && branch.isNotEmpty) ...[
            const SizedBox(width: 8),
            // Worktree branch chip — makes each session's isolated worktree explicit.
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: behind > 0
                    ? const Color(0xFF2d2108)
                    : const Color(0xFF12161c),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(
                  color: behind > 0
                      ? const Color(0xFFe3b341)
                      : const Color(0xFF24303f),
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.account_tree_outlined,
                    size: 11,
                    color: behind > 0
                        ? const Color(0xFFf2cc60)
                        : const Color(0xFF6aa3ff),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    branch,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: behind > 0
                          ? const Color(0xFFf2cc60)
                          : const Color(0xFF8a909b),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(width: 8),
          GestureDetector(
            onTap: () => _showCwdDialog(context, provider),
            child: const Text(
              'Change',
              style: TextStyle(fontSize: 11, color: Color(0xFF8a909b)),
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
            color: Color(0xFFe7eaee),
            fontFamily: 'monospace',
            fontSize: 13,
          ),
          decoration: InputDecoration(
            hintText: '/path/to/project',
            hintStyle: const TextStyle(color: Color(0xFF454b54)),
            filled: true,
            fillColor: const Color(0xFF070809),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: Color(0xFF20242b)),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
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
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Minimum gap (minutes) between two consecutive messages before a time
/// separator is drawn between them.
const int _timeSeparatorGapMinutes = 5;

/// Human-friendly time label for a chat separator, relative to now:
/// today → "HH:mm", yesterday → "昨天 HH:mm", within a week → "周X HH:mm",
/// same year → "M月d日 HH:mm", otherwise "yyyy年M月d日 HH:mm".
String formatChatTime(DateTime t) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(t.year, t.month, t.day);
  final hm =
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  final diffDays = today.difference(day).inDays;
  if (diffDays == 0) return hm;
  if (diffDays == 1) return '昨天 $hm';
  if (diffDays > 1 && diffDays < 7) {
    const week = ['一', '二', '三', '四', '五', '六', '日'];
    return '周${week[t.weekday - 1]} $hm';
  }
  if (t.year == now.year) return '${t.month}月${t.day}日 $hm';
  return '${t.year}年${t.month}月${t.day}日 $hm';
}

/// Centered, pill-shaped time label inserted between distant messages.
class _TimeSeparator extends StatelessWidget {
  final DateTime time;
  const _TimeSeparator({required this.time});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            formatChatTime(time),
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
          ),
        ),
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
            final msg = messages[i];
            // WeChat-style time separator: show a centered time label only when
            // this message is the first, or its gap from the previous message
            // exceeds the threshold — so back-to-back turns stay uncluttered.
            final prev = i > 0 ? messages[i - 1] : null;
            final showTime = prev == null ||
                msg.timestamp.difference(prev.timestamp).inMinutes.abs() >=
                    _timeSeparatorGapMinutes;
            if (!showTime) return MessageBubble(message: msg);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _TimeSeparator(time: msg.timestamp),
                MessageBubble(message: msg),
              ],
            );
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
                  color: const Color(0xFF22ab9c),
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
      color: const Color(0xFF070809),
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Text(
        costText,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Color(0xFF5b616c), fontSize: 11),
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
        ? const Color(0xFF7fd49a)
        : const Color(0xFFf0936b);
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
