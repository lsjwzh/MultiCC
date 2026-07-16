// 聊天头部（模型 chip / 清除上下文 / overflow 菜单 / cli badge 等）。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../services/chat_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../screens/file_browser_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/share_messages_screen.dart';
import 'cli_switch_sheet.dart';
import 'model_chip.dart';

class ChatHeader extends StatelessWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;
  final bool mergeReady;
  final VoidCallback onMerge;
  final VoidCallback onRole;
  final VoidCallback onMemory;
  final VoidCallback onMemo;
  final VoidCallback onShare;
  const ChatHeader({
    super.key,
    required this.settings,
    this.onCollapse,
    required this.mergeReady,
    required this.onMerge,
    required this.onRole,
    required this.onMemory,
    required this.onMemo,
    required this.onShare,
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
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = constraints.maxWidth < 500;
          return Row(
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
              _ChatCliBadge(
                cli: provider.cli,
                onTap: () => openCliSwitchSheet(
                  context,
                  sessionId: provider.sessionName,
                ),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  provider.titleLabel,
                  style: const TextStyle(
                    color: Color(0xFF6aa3ff),
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    fontFamily: 'monospace',
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // Connection dot — tap to manually reconnect when disconnected.
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: state == ChatConnectionState.connected
                    ? null
                    : provider.reconnect,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 2,
                    vertical: 4,
                  ),
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
              // Manual reconnect
              _HeaderBtn(
                icon: Icons.sync_rounded,
                tooltip: t('reconnect'),
                onTap: () => _forceReconnect(context, provider),
              ),
              // Provider / Model / Effort unified chip.
              const SizedBox(width: 4),
              ModelChip(
                sessionId: provider.sessionName,
                cli: provider.cli,
                settings: settings,
                compact: narrow,
              ),
              const SizedBox(width: 4),
              _ClearCtxButton(provider: provider),
              const SizedBox(width: 4),
              _HeaderOverflowMenu(
                mergeReady: mergeReady,
                onRole: onRole,
                onMemory: onMemory,
                onMemo: onMemo,
                onMerge: onMerge,
                onSettings: () => _openSettings(context, settings),
                onShare: onShare,
                onShareMessages: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => ShareMessagesScreen(
                      sessionId: provider.sessionName,
                      settings: settings,
                    ),
                  ),
                ),
                onFiles: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => FileBrowserScreen(
                      sessionId: provider.sessionName,
                      settings: settings,
                    ),
                  ),
                ),
                onRestart: () => _confirmRestart(context, provider),
              ),
            ],
          );
        },
      ),
    );
  }

  void _forceReconnect(BuildContext context, ChatProvider provider) {
    provider.reconnect();
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(t('reconnecting')),
          duration: const Duration(seconds: 2),
          backgroundColor: const Color(0xFF14171c),
        ),
      );
  }

  /// Restart the underlying CLI process for this session (stronger than
  /// reconnect — rebuilds the claude/codex command, like the web's 🔄 button).
  /// Asks for confirmation first because it discards any in-flight work.
  Future<void> _confirmRestart(
    BuildContext context,
    ChatProvider provider,
  ) async {
    final sid = provider.sessionName;
    if (sid.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(t('restartCli'), style: const TextStyle(fontSize: 16)),
        content: Text(
          t('restartCliBody'),
          style: const TextStyle(color: Color(0xFF8a909b), fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(
              t('cancel'),
              style: const TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFe3b341),
            ),
            child: Text(t('restart')),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(t('restarting')),
          duration: const Duration(seconds: 2),
          backgroundColor: const Color(0xFF14171c),
        ),
      );
    try {
      await SessionService(settings: settings).restartSession(sid);
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restarted')),
            duration: const Duration(seconds: 2),
            backgroundColor: const Color(0xFF14171c),
          ),
        );
    } catch (e) {
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restartFailed', {'error': '$e'})),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
    }
  }

  void _openSettings(BuildContext context, SettingsService settings) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SettingsScreen(settings: settings)),
    );
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
          child: Icon(icon, color: const Color(0xFFe7eaee), size: 18),
        ),
      ),
    );
  }
}

/// Clear-context button for the chat header. Mirrors the web client's "Clear"
/// button: tapping opens a small popup with two options —
///   • 清空全部 (clear all)  → clearHistory(keep: 0)
///   • 保留最近 N 条          → clearHistory(keep: N)
/// The provider's clearHistory() cancels any in-flight stream before wiping,
/// so clearing while streaming actually takes effect instead of looking like a
/// no-op (the running CLI process gets killed first).
class _ClearCtxButton extends StatefulWidget {
  final ChatProvider provider;
  const _ClearCtxButton({required this.provider});

  @override
  State<_ClearCtxButton> createState() => _ClearCtxButtonState();
}

class _ClearCtxButtonState extends State<_ClearCtxButton> {
  final _keepCtrl = TextEditingController(text: '5');
  bool _menuOpen = false;
  final _layerLink = LayerLink();
  OverlayEntry? _overlay;

  void _closeMenu() {
    _overlay?.remove();
    _overlay = null;
    if (mounted) setState(() => _menuOpen = false);
  }

  void _openMenu() {
    if (_menuOpen) {
      _closeMenu();
      return;
    }
    setState(() => _menuOpen = true);
    _overlay = OverlayEntry(
      builder: (ctx) => _ClearMenuBody(
        link: _layerLink,
        keepCtrl: _keepCtrl,
        onClearAll: () {
          _closeMenu();
          widget.provider.clearHistory(keep: 0);
        },
        onClearKeep: () {
          final n = int.tryParse(_keepCtrl.text.trim()) ?? 5;
          _closeMenu();
          widget.provider.clearHistory(keep: n < 1 ? 1 : n);
        },
        onDismiss: _closeMenu,
      ),
    );
    Overlay.of(context).insert(_overlay!);
  }

  @override
  void dispose() {
    _overlay?.remove();
    _keepCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _layerLink,
      child: Tooltip(
        message: t('clearCtx'),
        child: GestureDetector(
          onTap: _openMenu,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFF14171c),
              border: Border.all(color: const Color(0xFF20242b)),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.delete_sweep_outlined,
                  color: const Color(0xFFff6b63),
                  size: 16,
                ),
                const SizedBox(width: 4),
                Text(
                  t('clearCtx'),
                  style: const TextStyle(
                    color: Color(0xFFff6b63),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ClearMenuBody extends StatelessWidget {
  final LayerLink link;
  final TextEditingController keepCtrl;
  final VoidCallback onClearAll;
  final VoidCallback onClearKeep;
  final VoidCallback onDismiss;
  const _ClearMenuBody({
    required this.link,
    required this.keepCtrl,
    required this.onClearAll,
    required this.onClearKeep,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // Tap-outside dismiss layer
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onDismiss,
          child: const SizedBox.expand(),
        ),
        CompositedTransformFollower(
          link: link,
          targetAnchor: Alignment.bottomRight,
          followerAnchor: Alignment.topRight,
          offset: const Offset(0, 6),
          child: Material(
            color: Colors.transparent,
            child: Container(
              width: 180,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: const Color(0xFF14171c),
                border: Border.all(color: const Color(0xFF20242b)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Clear all
                  InkWell(
                    onTap: onClearAll,
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 9,
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.delete_sweep_outlined,
                            size: 16,
                            color: Color(0xFFff6b63),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            t('clearAll'),
                            style: const TextStyle(
                              color: Color(0xFFff6b63),
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 44,
                          child: TextField(
                            controller: keepCtrl,
                            keyboardType: TextInputType.number,
                            style: const TextStyle(
                              color: Color(0xFFe7eaee),
                              fontSize: 12,
                            ),
                            decoration: InputDecoration(
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 6,
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderSide: const BorderSide(
                                  color: Color(0xFF20242b),
                                ),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderSide: const BorderSide(
                                  color: Color(0xFF3ad6c5),
                                ),
                                borderRadius: BorderRadius.circular(4),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            t('clearKeepLast'),
                            style: const TextStyle(
                              color: Color(0xFF8a909b),
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: TextButton(
                      onPressed: onClearKeep,
                      style: TextButton.styleFrom(
                        foregroundColor: const Color(0xFF22ab9c),
                        padding: const EdgeInsets.symmetric(vertical: 4),
                      ),
                      child: Text(
                        t('clearKeepConfirm'),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Overflow menu for the chat header. Collapses the occasional actions
/// (memo / merge worktree / settings) behind a single "⋮"
/// trigger, keeping the header's action cluster a fixed, compact width so its
/// icons never overflow the right edge on narrow screens.
class _HeaderOverflowMenu extends StatelessWidget {
  final bool mergeReady;
  final VoidCallback onRole;
  final VoidCallback onMemory;
  final VoidCallback onMemo;
  final VoidCallback onMerge;
  final VoidCallback onSettings;
  final VoidCallback onShare;
  final VoidCallback onShareMessages;
  final VoidCallback onFiles;
  final VoidCallback onRestart;
  const _HeaderOverflowMenu({
    required this.mergeReady,
    required this.onRole,
    required this.onMemory,
    required this.onMemo,
    required this.onMerge,
    required this.onSettings,
    required this.onShare,
    required this.onShareMessages,
    required this.onFiles,
    required this.onRestart,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: t('moreActions'),
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
          case 'memory':
            onMemory();
            break;
          case 'memo':
            onMemo();
            break;
          case 'merge':
            onMerge();
            break;
          case 'share':
            onShare();
            break;
          case 'share-msgs':
            onShareMessages();
            break;
          case 'files':
            onFiles();
            break;
          case 'restart':
            onRestart();
            break;
          case 'settings':
            onSettings();
            break;
        }
      },
      itemBuilder: (_) => [
        _item(
          'role',
          Icons.theater_comedy_outlined,
          t('rolePrompt'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'memory',
          Icons.psychology_outlined,
          t('sessionMemory'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'memo',
          Icons.sticky_note_2_outlined,
          t('projectMemo'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'share',
          Icons.share_outlined,
          t('shareSession'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'share-msgs',
          Icons.checklist_rtl_outlined,
          t('shareMessages'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'merge',
          Icons.merge_type,
          mergeReady
              ? t('mergeWorktreeReady', {'base': ''})
              : t('mergeWorktree'),
          mergeReady ? const Color(0xFFe3b341) : const Color(0xFFe7eaee),
        ),
        _item(
          'files',
          Icons.folder_open_outlined,
          t('fileBrowser'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'restart',
          Icons.restart_alt_rounded,
          t('restartCli'),
          const Color(0xFFe3b341),
        ),
        const PopupMenuDivider(),
        _item(
          'settings',
          Icons.settings_outlined,
          t('settings'),
          const Color(0xFFe7eaee),
        ),
      ],
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: mergeReady ? const Color(0xFFe3b341) : const Color(0xFF14171c),
          border: Border.all(
            color: mergeReady
                ? const Color(0xFFe3b341)
                : const Color(0xFF20242b),
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
    String value,
    IconData icon,
    String label,
    Color color,
  ) {
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

class _ChatCliBadge extends StatelessWidget {
  final SessionCli cli;
  final VoidCallback onTap;
  const _ChatCliBadge({required this.cli, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final color = switch (cli) {
      SessionCli.claude => const Color(0xFFf0936b),
      SessionCli.codex => const Color(0xFF7fd49a),
      SessionCli.opencode => const Color(0xFFa78bfa),
      SessionCli.zcode => const Color(0xFF38bdf8),
    };
    return Tooltip(
      message: '切换会话 CLI',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.15),
            border: Border.all(color: color.withValues(alpha: 0.4)),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                cli.name,
                style: TextStyle(
                  color: color,
                  fontSize: 9,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(width: 2),
              Icon(Icons.swap_horiz_rounded, size: 11, color: color),
            ],
          ),
        ),
      ),
    );
  }
}
