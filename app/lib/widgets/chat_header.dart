// 聊天头部（模型 chip / 清除上下文 / overflow 菜单 / cli badge 等）。自 chat_screen.dart 抽出。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/chat_service.dart';
import '../services/notification_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../screens/file_browser_screen.dart';
import '../screens/settings_screen.dart';
import '../utils/context_level.dart';
import '../screens/share_messages_screen.dart';
import 'cli_switch_sheet.dart';
import 'git_log_sheet.dart';
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

  /// 「强制同步」：把同步指令当消息发给会话（Web 的 `#worktree-force-sync-btn`）。
  /// 手机上页头那一排已经排满，它跟「聊天宽度」一起待在 ⋯ 菜单里。
  final VoidCallback onForceSync;
  final bool forceSyncing;

  /// 「聊天宽度」（Web 的 `#chat-layout-btn`）。
  final VoidCallback onChatWidth;

  /// 会话级「自动提交」（Web 的 `#auto-commit-btn`）。那边是页头上一颗常驻
  /// 按钮，App 的页头放不下，收进 ⋯ 菜单 —— 文案沿用 web 的 ✓/✕ 后缀。
  final bool autoCommit;
  final VoidCallback onAutoCommit;

  /// 「调试面板」（Web 页头那颗 `#dbg-btn`）。
  final VoidCallback onDebug;

  /// 「产物」入口（Web 的 `#task-artifacts-toggle`）。null = 这个会话还没有
  /// 任务壳，压根不显示入口 —— web 没有 scope 时连按钮都不建。拉到列表之后
  /// 文案带上条数（`产物 2`），跟 web 的 `toggle.textContent` 一致。
  final String? artifactsLabel;
  final VoidCallback onArtifacts;

  /// Working directory + worktree branch for the read-only info rows at the
  /// top of the ⋯ menu. The chat page used to burn a full-width cwd bar under
  /// the header for this; now it lives one tap away, next to the actions.
  final String cwd;
  final String? branch;
  final int behind;
  final VoidCallback onCwd;
  final bool advancedMode;
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
    required this.onForceSync,
    this.forceSyncing = false,
    required this.onChatWidth,
    required this.autoCommit,
    required this.onAutoCommit,
    required this.onDebug,
    this.artifactsLabel,
    required this.onArtifacts,
    required this.cwd,
    this.branch,
    this.behind = 0,
    required this.onCwd,
    this.advancedMode = true,
  });

  /// 双击标题改名 —— 对齐 web `chat.js` 的 renameSessionFromChat()：预填的是
  /// 当前别名（不是「目录 / 名字」那串），上限 80 字，留空就清掉别名回落到
  /// 会话 id。改完由 SessionManager.loadDashboard() 把新名字推回标题，这里不
  /// 自己改 displayName —— 否则服务端拒绝时本地已经先变了。
  Future<void> _renameSession(
    BuildContext context,
    ChatProvider provider,
  ) async {
    final manager = context.read<SessionManager>();
    final messenger = ScaffoldMessenger.of(context);
    final ctrl = TextEditingController(text: provider.displayName);
    final next = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: const Color(0xFFffffff),
        title: Text(
          t('renameSessionTitle'),
          style: const TextStyle(fontSize: 15, color: Color(0xFF20364d)),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          style: const TextStyle(color: Color(0xFF233249), fontSize: 13),
          decoration: InputDecoration(
            hintText: provider.sessionName,
            hintStyle: const TextStyle(color: Color(0xFF8b9cae)),
            filled: true,
            fillColor: const Color(0xFFf4f8fd),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            counterStyle: const TextStyle(color: Color(0xFF8a9aab)),
          ),
          onSubmitted: (value) => Navigator.pop(dialogContext, value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(
              t('cancel'),
              style: const TextStyle(color: Color(0xFF6f8096)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, ctrl.text),
            child: Text(
              t('save'),
              style: const TextStyle(
                color: Color(0xFF1267b5),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
    if (next == null) return;
    try {
      await manager.renameSession(provider.sessionName, next.trim());
      messenger.showSnackBar(
        SnackBar(content: Text(t('renameSessionSaved'))),
      );
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('renameSessionFailed', {'error': '$error'}))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final state = provider.connectionState;

    Color statusColor;
    switch (state) {
      case ChatConnectionState.connected:
        statusColor = const Color(0xFF1e8a55);
        break;
      case ChatConnectionState.connecting:
        statusColor = const Color(0xFFa85a25);
        break;
      case ChatConnectionState.disconnected:
        statusColor = const Color(0xFF6f8096);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: const BoxDecoration(
        color: Color(0xFFffffff),
        border: Border(bottom: BorderSide(color: Color(0xFFdce6f1))),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = advancedMode && constraints.maxWidth < 500;
          // The title must own real estate. In the old single-row layout the
          // title sat in a Flexible between fixed-width chrome (collapse,
          // brand, CLI badge) and a fixed action cluster — on a narrow phone
          // the fixed parts alone filled the row and the Flexible collapsed
          // to zero width, i.e. no visible title at all. Wide screens keep
          // the single row (title Expanded, action cluster right); narrow
          // screens move the title to its own full-width second line.
          final title = _SessionTitle(
            label: provider.titleLabel,
            onDoubleTap: () => _renameSession(context, provider),
          );
          // 只读历史（Web 的 `#status` 在 readOnly 模式下写成「只读历史」）：
          // 归档记录不能删、不能清空，但能继续对话，所以只加一枚标识说明现在
          // 看的是历史，不把输入区收走。
          final titleLine = Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(child: title),
              if (provider.historyArchive) ...[
                const SizedBox(width: 6),
                const _ReadOnlyHistoryChip(),
              ],
            ],
          );
          // On narrow screens the fixed chrome above alone was wider than the
          // row (brand + labelled clear-context button ≈ +170px), so the brand
          // wordmark is dropped — the collapse arrow and the CLI badge still
          // identify the sheet — and the clear-context button collapses to an
          // icon-only form (tooltip keeps the meaning).
          final brand = narrow || !advancedMode
              ? const SizedBox.shrink()
              : RichText(
                  text: const TextSpan(
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    children: [
                      TextSpan(
                        text: 'Multi',
                        style: TextStyle(color: Color(0xFF1678e8)),
                      ),
                      TextSpan(
                        text: 'CC',
                        style: TextStyle(color: Color(0xFF1267b5)),
                      ),
                    ],
                  ),
                );
          final leading = <Widget>[
            // Collapse the chat sheet back down to the home dashboard.
            GestureDetector(
              onTap: onCollapse,
              child: Container(
                padding: const EdgeInsets.all(6),
                child: const Icon(
                  Icons.keyboard_arrow_down_rounded,
                  color: Color(0xFF233249),
                  size: 24,
                ),
              ),
            ),
            if (advancedMode) ...[
              const SizedBox(width: 4),
              brand,
              // One spacing slot whether or not the brand renders, so the CLI
              // badge never kisses the collapse arrow.
              const SizedBox(width: 6),
              _ChatCliBadge(
                cli: provider.cli,
                onTap: () => openCliSwitchSheet(
                  context,
                  sessionId: provider.executionSessionName,
                ),
              ),
            ],
          ];
          // Connection dot — tap to manually reconnect when disconnected.
          final connectionDot = GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: state == ChatConnectionState.connected
                ? null
                : provider.reconnect,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 8, color: statusColor),
                  if (!advancedMode) ...[
                    const SizedBox(width: 5),
                    Text(
                      state == ChatConnectionState.connected
                          ? t('connected')
                          : state == ChatConnectionState.connecting
                          ? t('connecting')
                          : t('disconnected'),
                      style: TextStyle(color: statusColor, fontSize: 10.5),
                    ),
                  ],
                  if (state != ChatConnectionState.connected) ...[
                    const SizedBox(width: 4),
                    const Icon(
                      Icons.refresh_rounded,
                      size: 15,
                      color: Color(0xFF6f8096),
                    ),
                  ],
                ],
              ),
            ),
          );
          final actions = <Widget>[
            if (advancedMode) ...[
              // Manual reconnect
              _HeaderBtn(
                icon: Icons.sync_rounded,
                tooltip: t('reconnect'),
                onTap: () => _forceReconnect(context, provider),
              ),
              // Provider / Model / Effort unified chip.
              const SizedBox(width: 4),
              ModelChip(
                sessionId: provider.executionSessionName,
                cli: provider.cli,
                settings: settings,
                compact: narrow,
              ),
              const SizedBox(width: 4),
              if (!provider.historyArchive) _ClearCtxButton(provider: provider, compact: narrow),
              const SizedBox(width: 4),
            ],
            _HeaderOverflowMenu(
              mergeReady: mergeReady,
              cwd: cwd,
              branch: branch,
              behind: behind,
              onCwd: onCwd,
              onRole: onRole,
              onMemory: onMemory,
              onMemo: onMemo,
              onMerge: onMerge,
              onSettings: () => _openSettings(context, settings),
              onForceSync: onForceSync,
              forceSyncing: forceSyncing,
              onChatWidth: onChatWidth,
              autoCommit: autoCommit,
              onAutoCommit: onAutoCommit,
              onDebug: onDebug,
              settings: settings,
              sessionId: provider.sessionName,
              // Web 的 `#lang-btn` 就是 toggleLang()：翻 localStorage 里的
              // `multicc_lang` 再重载页面。App 侧的等价物是 SettingsService 的
              // 语言偏好（同一个 'multicc_lang' 键），main() 监听它重建
              // MaterialApp —— 等价于 Web 的重载，但不用重启 app。
              onLanguage: () =>
                  settings.setLanguage(settings.lang == 'zh' ? 'en' : 'zh'),
              artifactsLabel: artifactsLabel,
              onArtifacts: onArtifacts,
              onShare: onShare,
              onShareMessages: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => ShareMessagesScreen(
                    sessionId: provider.executionSessionName,
                    settings: settings,
                  ),
                ),
              ),
              onFiles: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => FileBrowserScreen(
                    sessionId: provider.executionSessionName,
                    settings: settings,
                  ),
                ),
              ),
              onGitLog: () => showGitLogSheet(
                context,
                fetchLog: (all) => SessionService(settings: settings)
                    .fetchGitLog(
                      sessionId: provider.executionSessionName,
                      allBranches: all,
                    ),
                fetchDiff: (hash) => SessionService(settings: settings)
                    .fetchGitCommitDiff(
                      sessionId: provider.executionSessionName,
                      hash: hash,
                    ),
              ),
              onRestart: () => _confirmRestartSpawn(context, provider),
            ),
          ];
          if (narrow) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    ...leading,
                    const SizedBox(width: 6),
                    connectionDot,
                    const Spacer(),
                    ...actions,
                  ],
                ),
                const SizedBox(height: 2),
                // Full-width title line: never squeezed by the chrome above.
                titleLine,
              ],
            );
          }
          return Row(
            children: [
              ...leading,
              const SizedBox(width: 6),
              // Expanded (not Flexible) so the title always keeps whatever
              // space the fixed chrome leaves — never collapses to zero.
              Expanded(child: titleLine),
              connectionDot,
              ...actions,
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
          backgroundColor: const Color(0xFFf8fbff),
        ),
      );
  }

  /// Process-level restart: destroys the CLI process and the server-side runtime
  /// that outlives it. One rung above [_forceReconnect], which only rebuilds this
  /// client's socket and therefore cannot help when the wedged part is the
  /// process on the server — the two look identical from here.
  ///
  /// This used to POST /restart, which the server answers with 400 for anything
  /// that is not a terminal session, so it could never work from a chat header.
  /// /restart-spawn is the chat counterpart and keeps the conversation: the next
  /// message respawns against the same native session, and only the interrupted
  /// turn is lost. Confirm first for that reason.
  Future<void> _confirmRestartSpawn(
    BuildContext context,
    ChatProvider provider,
  ) async {
    final sid = provider.executionSessionName;
    if (sid.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: const Color(0xFFffffff),
        title: Text(t('restartSpawn'), style: const TextStyle(fontSize: 16)),
        content: Text(
          t('restartSpawnConfirm'),
          style: const TextStyle(color: Color(0xFF6f8096), fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(
              t('cancel'),
              style: const TextStyle(color: Color(0xFF6f8096)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFa85a25),
            ),
            child: Text(t('restartSpawn')),
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
          backgroundColor: const Color(0xFFf8fbff),
        ),
      );
    try {
      final result = await SessionService(settings: settings).restartSpawn(sid);
      final before = result['before'];
      final pid = before is Map ? before['pid'] : null;
      // The process this view was bound to is gone; resync so the header stops
      // describing a runtime that no longer exists.
      provider.reconnect();
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restartSpawnDone', {'pid': '${pid ?? '-'}'})),
            duration: const Duration(seconds: 3),
            backgroundColor: const Color(0xFFf8fbff),
          ),
        );
    } catch (e) {
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restartSpawnFailed', {'error': '$e'})),
            backgroundColor: const Color(0xFFb64e43),
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
            color: const Color(0xFFf8fbff),
            border: Border.all(color: const Color(0xFFdce6f1)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(icon, color: const Color(0xFF233249), size: 18),
        ),
      ),
    );
  }
}

/// Clear-context button for the chat header. Mirrors the web client's "Clear"
/// button: tapping opens a small popup with two options —
///   • 清空全部 (clear all)  → clearHistory(keep: 0)
///   • 保留最近 N 条          → clearHistory(keep: N)
/// The provider waits for durable display-state acknowledgement; work continues,
/// and the native model context remains unchanged.
class _ClearCtxButton extends StatefulWidget {
  final ChatProvider provider;
  /// Icon-only form for the narrow (phone) header, where the text label
  /// alone is ~60px wider than the row can spare. The tooltip still carries
  /// the full meaning for both pointer and semantics users.
  final bool compact;
  const _ClearCtxButton({required this.provider, this.compact = false});

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
        onRotateNative: () {
          _closeMenu();
          widget.provider.rotateNativeContext();
        },
        onContextLevel: () {
          _closeMenu();
          _showContextLevel();
        },
        onDismiss: _closeMenu,
      ),
    );
    Overlay.of(context).insert(_overlay!);
  }

  /// 「查看上下文水位」（Web 的 `showContextLevel`）：只读地报一句原生转录现在
  /// 装了多少 —— `prompt too long` 之所以来得毫无预兆，就是因为在此之前没有任何
  /// 地方显示过水位。结果写成一条系统消息，跟 Web 一样落在对话里而不是弹窗。
  Future<void> _showContextLevel() async {
    final messenger = ScaffoldMessenger.of(context);
    final session = widget.provider.executionSessionName.isNotEmpty
        ? widget.provider.executionSessionName
        : widget.provider.sessionName;
    if (session.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(t('contextLevelFail'))));
      return;
    }
    Map<String, dynamic> data;
    try {
      data = await SessionService(
        settings: widget.provider.settings,
      ).fetchContextLevel(session);
    } catch (_) {
      messenger.showSnackBar(SnackBar(content: Text(t('contextLevelFail'))));
      return;
    }
    if (!mounted) return;
    final message = contextLevelMessage(data);
    widget.provider.addLocalSystemMessage(
      message ?? t('contextLevelUnavailable'),
    );
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
            padding: EdgeInsets.symmetric(
              horizontal: widget.compact ? 7 : 8,
              vertical: 6,
            ),
            decoration: BoxDecoration(
              color: const Color(0xFFf8fbff),
              border: Border.all(color: const Color(0xFFdce6f1)),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.delete_sweep_outlined,
                  color: const Color(0xFFb64e43),
                  size: 16,
                ),
                if (!widget.compact) ...[
                  const SizedBox(width: 4),
                  Text(
                    t('clearCtx'),
                    style: const TextStyle(
                      color: Color(0xFFb64e43),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
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
  final VoidCallback onRotateNative;
  final VoidCallback onContextLevel;
  final VoidCallback onDismiss;
  const _ClearMenuBody({
    required this.link,
    required this.keepCtrl,
    required this.onClearAll,
    required this.onClearKeep,
    required this.onRotateNative,
    required this.onContextLevel,
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
                color: const Color(0xFFf8fbff),
                border: Border.all(color: const Color(0xFFdce6f1)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // 轮转原生上下文：换一份空的 CLI 转录，MultiCC 的会话记录不动。
                  InkWell(
                    onTap: onRotateNative,
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.autorenew_outlined,
                            size: 16,
                            color: Color(0xFF1678e8),
                          ),
                          const SizedBox(width: 8),
                          Text(t('rotateNativeContext'), style: const TextStyle(color: Color(0xFF233249), fontSize: 13)),
                        ],
                      ),
                    ),
                  ),
                  // 上下文水位：只读地看一眼原生转录现在装了多少（web 的 data-action="context-level"）。
                  InkWell(
                    onTap: onContextLevel,
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.water_drop_outlined,
                            size: 16,
                            color: Color(0xFF1678e8),
                          ),
                          const SizedBox(width: 8),
                          Text(t('contextLevel'), style: const TextStyle(color: Color(0xFF233249), fontSize: 13)),
                        ],
                      ),
                    ),
                  ),
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
                            color: Color(0xFFb64e43),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            t('clearAllChatHistory'),
                            style: const TextStyle(
                              color: Color(0xFFb64e43),
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
                              color: Color(0xFF233249),
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
                                  color: Color(0xFFdce6f1),
                                ),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderSide: const BorderSide(
                                  color: Color(0xFF1678e8),
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
                              color: Color(0xFF6f8096),
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
                        foregroundColor: const Color(0xFF0965cf),
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

/// 点 ⋯ 菜单里「任务提醒」之后的落点。
enum TaskNotifyToggleResult {
  /// 开关被关掉 —— Web toggle() 的 `enabled && pushOn` 分支。
  off,

  /// 开关被打开，且系统通知权限已到手。
  on,

  /// 先置为开启、申请系统通知权限失败，于是回滚成关闭。
  denied,
}

/// 「任务提醒」那一项的点击语义 —— 逐条对齐 Web 页头 `#notify-btn` 的
/// click → toggle()（public/chat-notifications.js:96-125）：
///
/// 1. 已经在开启态、且系统通知已授权 → 关掉。Web 在这条分支上还会
///    `unsubscribePush()` 退掉服务端 Web Push 订阅；App 用的是本地通知
///    （flutter_local_notifications），没有服务端订阅要退，所以只有落盘这一半
///    （SettingsService 的 `multicc_notify:<sessionId>`，跟 Web 同一个键）。
/// 2. 其余情况 → 先把开关落盘成开启，再去申请系统通知权限（Web 调
///    `ensurePushSubscribed()` → `Notification.requestPermission()`，
///    public/pwa.js:195/224）。
/// 3. 申请被拒 → 把开关回滚成关闭（同文件 112-117 行 `if (!ok) { enabled = false;
///    persistPreference(false); }`），调用方据此给出可见反馈。
///
/// 拆成顶层函数是为了能在测试里用注入的权限 fake 直接驱动这条状态机，不必真的
/// 去碰平台通道。
Future<TaskNotifyToggleResult> toggleTaskNotifyWithPermission({
  required SettingsService settings,
  required String sessionId,
}) async {
  final enabled = settings.taskNotifyEnabled(sessionId);
  if (enabled && NotificationService.permissionGranted) {
    await settings.setTaskNotifyEnabled(sessionId, false);
    return TaskNotifyToggleResult.off;
  }

  // Web 是「先置为开启 → 再申请」，申请期间按钮已经显示成开启态（乐观更新）；
  // 这里同样先落盘，被拒再回滚。
  await settings.setTaskNotifyEnabled(sessionId, true);
  if (await NotificationService.ensurePermission()) {
    return TaskNotifyToggleResult.on;
  }
  await settings.setTaskNotifyEnabled(sessionId, false);
  return TaskNotifyToggleResult.denied;
}

/// Overflow menu for the chat header. Collapses the occasional actions
/// (memo / merge worktree / settings) behind a single "⋮"
/// trigger, keeping the header's action cluster a fixed, compact width so its
/// icons never overflow the right edge on narrow screens.
class _HeaderOverflowMenu extends StatelessWidget {
  final bool mergeReady;
  final String cwd;
  final String? branch;
  final int behind;
  final VoidCallback onCwd;
  final VoidCallback onRole;
  final VoidCallback onMemory;
  final VoidCallback onMemo;
  final VoidCallback onMerge;
  final VoidCallback onSettings;
  final VoidCallback onShare;
  final VoidCallback onShareMessages;
  final VoidCallback onFiles;
  final VoidCallback onRestart;
  final VoidCallback onGitLog;
  final VoidCallback onForceSync;
  final bool forceSyncing;
  final VoidCallback onChatWidth;
  final bool autoCommit;
  final VoidCallback onAutoCommit;
  final VoidCallback onDebug;
  /// 会话级「任务提醒」开关（Web 页头那颗 `#notify-btn`，public/chat.html:2423）。
  /// Web 把那颗按钮的状态写在 `title` 里，App 的 ⋯ 菜单没有 tooltip，所以把
  /// 状态直接拼进文案 —— 三态逐字对齐 Web 的 `title`（见任务提醒那一项的注释）。
  /// 状态在**开菜单时现读**（`itemBuilder` 每次展开都会重跑），因此宿主不需要
  /// 为这一项 setState。
  final SettingsService settings;
  final String sessionId;
  final VoidCallback onLanguage;
  final String? artifactsLabel;
  final VoidCallback onArtifacts;
  const _HeaderOverflowMenu({
    required this.mergeReady,
    required this.cwd,
    this.branch,
    this.behind = 0,
    required this.onCwd,
    required this.onRole,
    required this.onMemory,
    required this.onMemo,
    required this.onMerge,
    required this.onSettings,
    required this.onShare,
    required this.onShareMessages,
    required this.onFiles,
    required this.onRestart,
    required this.onGitLog,
    required this.onForceSync,
    this.forceSyncing = false,
    required this.onChatWidth,
    required this.autoCommit,
    required this.onAutoCommit,
    required this.onDebug,
    required this.settings,
    required this.sessionId,
    required this.onLanguage,
    this.artifactsLabel,
    required this.onArtifacts,
  });

  @override
  Widget build(BuildContext context) {
    // 「任务提醒」的三态：开着且系统通知已授权 / 开着但还没授权 / 已关闭。
    // 逐字对齐 Web `#notify-btn` 的 title（public/chat-notifications.js:78-86
    // 的 updateButton()）：`pushOn ? '任务提醒 (系统通知已开启)'`，否则是
    // '任务提醒 (点击开启系统通知)'；关闭态则是 '任务提醒 (已关闭)'。
    final notifyEnabled = settings.taskNotifyEnabled(sessionId);
    final pushGranted = NotificationService.permissionGranted;
    return PopupMenuButton<String>(
      tooltip: t('moreActions'),
      color: const Color(0xFFf8fbff),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Color(0xFFdce6f1)),
      ),
      offset: const Offset(0, 40),
      // 三态标签读的是 NotificationService 的同步权限缓存，展开时顺手刷一次
      // （fire-and-forget，不挡这一帧）—— 用户在系统设置里改过通知权限后，
      // 下一次展开就能显示真实状态。
      onOpened: () {
        unawaited(NotificationService.refreshPermissionCache());
      },
      onSelected: (value) async {
        switch (value) {
          case 'cwd':
            onCwd();
            break;
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
          case 'force-sync':
            onForceSync();
            break;
          case 'chat-width':
            onChatWidth();
            break;
          case 'auto-commit':
            onAutoCommit();
            break;
          case 'debug':
            onDebug();
            break;
          case 'language':
            onLanguage();
            break;
          case 'task-notify':
            // 见 toggleTaskNotifyWithPermission：Web 点 `#notify-btn` 除了落盘
            // 偏好，打开时还会去申请系统通知权限、被拒就回滚
            // （public/chat-notifications.js 的 toggle()，96-125 行）。
            final result = await toggleTaskNotifyWithPermission(
              settings: settings,
              sessionId: sessionId,
            );
            if (!context.mounted) break;
            // 回滚是静默发生的（开关又变回关闭），不提示的话用户只会觉得
            // 「点了没反应」。Web 那边没订上时按钮同样停在关闭态，区别是浏览器
            // 自己弹过授权框、用户知道发生了什么。
            if (result == TaskNotifyToggleResult.denied) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(t('taskNotifyPermissionDenied'))),
              );
            }
            break;
          case 'artifacts':
            onArtifacts();
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
          case 'gitlog':
            onGitLog();
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
        // Read-only working-context rows (ex-_CwdBar): short dir name with the
        // full path in the tooltip, then the worktree branch — amber with a ↓N
        // badge when the base branch is ahead of this worktree.
        if (cwd.isNotEmpty) _cwdInfoItem(),
        if (branch != null && branch!.isNotEmpty) _branchInfoItem(),
        _item(
          'cwd',
          Icons.drive_file_move_outline,
          t('changeDir'),
          const Color(0xFF233249),
        ),
        const PopupMenuDivider(),
        // Web 的 ⋯ 菜单头两项就是语言切换和任务提醒（public/chat.js:257 的 ids
        // 列表：'lang-btn', 'notify-btn', …），App 也把它们排在最前面。
        _item(
          'language',
          Icons.translate_outlined,
          t('language'),
          const Color(0xFF233249),
          key: const Key('chat-header-language'),
        ),
        _item(
          'task-notify',
          // 图标/颜色也跟着三态走：开且已授权=实心通知，开但没授权=空心通知
          // （这一档还差用户一个动作，用琥珀色提示，跟「落后」的告警同一支色），
          // 关闭=划掉的通知。
          !notifyEnabled
              ? Icons.notifications_off_outlined
              : pushGranted
              ? Icons.notifications_active_outlined
              : Icons.notifications_none_outlined,
          !notifyEnabled
              ? t('taskNotifyOff')
              : pushGranted
              ? t('taskNotifyOnPush')
              : t('taskNotifyOnNoPush'),
          !notifyEnabled
              ? const Color(0xFF6f8096)
              : pushGranted
              ? const Color(0xFF2ba67a)
              : const Color(0xFFa85a25),
          key: const Key('chat-header-task-notify'),
        ),
        _item(
          'role',
          Icons.theater_comedy_outlined,
          t('rolePrompt'),
          const Color(0xFF233249),
        ),
        _item(
          'memory',
          Icons.psychology_outlined,
          t('sessionMemory'),
          const Color(0xFF233249),
        ),
        _item(
          'memo',
          Icons.sticky_note_2_outlined,
          t('projectMemo'),
          const Color(0xFF233249),
        ),
        // 开关状态直接写在文案里（✓/✕），跟 web 的 `#auto-commit-btn` 一样 ——
        // 这颗按钮旁边没有别的地方能表达「现在是开还是关」。
        _item(
          'auto-commit',
          Icons.rocket_launch_outlined,
          autoCommit ? t('autoCommitOn') : t('autoCommitOff'),
          autoCommit ? const Color(0xFF2ba67a) : const Color(0xFF6f8096),
        ),
        _item(
          'share',
          Icons.share_outlined,
          t('shareSession'),
          const Color(0xFF233249),
        ),
        _item(
          'share-msgs',
          Icons.checklist_rtl_outlined,
          t('shareMessages'),
          const Color(0xFF233249),
        ),
        _item(
          'merge',
          Icons.merge_type,
          mergeReady
              ? t('mergeWorktreeReady', {'base': ''})
              : t('mergeWorktree'),
          mergeReady ? const Color(0xFFa85a25) : const Color(0xFF233249),
        ),
        _item(
          'files',
          Icons.folder_open_outlined,
          t('fileBrowser'),
          const Color(0xFF233249),
        ),
        _item(
          'gitlog',
          Icons.history_rounded,
          t('gitLog'),
          const Color(0xFF233249),
        ),
        // 强制同步在菜单里也留一份：两个横幅只在「落后」或「卡在冲突」时出现，
        // 而这颗按钮恰恰最常用于「没落后但我要让会话去处理同步」。
        _item(
          'force-sync',
          Icons.published_with_changes_rounded,
          forceSyncing
              ? t('worktreeForceSyncSending')
              : t('worktreeForceSync'),
          const Color(0xFF1267b5),
        ),
        _item(
          'chat-width',
          Icons.width_normal_outlined,
          t('chatWidthTitle'),
          const Color(0xFF233249),
        ),
        _item(
          'restart',
          Icons.restart_alt_rounded,
          t('restartSpawn'),
          const Color(0xFFa85a25),
        ),
        const PopupMenuDivider(),
        _item(
          'settings',
          Icons.settings_outlined,
          t('settings'),
          const Color(0xFF233249),
        ),
        // 诊断工具，排在最后：平时不点，出问题时才翻到这里。
        _item(
          'debug',
          Icons.bug_report_outlined,
          t('debugPanel'),
          const Color(0xFF6f8096),
        ),
        // 产物只在「有任务壳」时才有位置可指 —— 没有的会话干脆不显示这一行。
        if (artifactsLabel != null)
          _item(
            'artifacts',
            Icons.inventory_2_outlined,
            artifactsLabel!,
            const Color(0xFF233249),
          ),
      ],
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: mergeReady ? const Color(0xFFa85a25) : const Color(0xFFf8fbff),
          border: Border.all(
            color: mergeReady
                ? const Color(0xFFa85a25)
                : const Color(0xFFdce6f1),
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Icon(
          Icons.more_vert,
          color: mergeReady ? const Color(0xFFf4f8fd) : const Color(0xFF233249),
          size: 18,
        ),
      ),
    );
  }

  /// Disabled info row: the session's working directory. Shows just the last
  /// path segment inline (the worktree name identifies the session well enough
  /// in this menu); the full absolute path rides in the tooltip.
  PopupMenuItem<String> _cwdInfoItem() {
    final last = cwd.split('/').last;
    final short = last.isEmpty ? cwd : last;
    return PopupMenuItem<String>(
      enabled: false,
      height: 36,
      child: Tooltip(
        message: cwd,
        child: Row(
          children: [
            const Icon(
              Icons.folder_outlined,
              size: 16,
              color: Color(0xFF8a9aab),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                short,
                key: const Key('chat-header-cwd'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  color: Color(0xFF1267b5),
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Disabled info row: the session's worktree branch, amber when the base
  /// branch has moved ahead (behind > 0) — same warning colour the old cwd
  /// bar's branch chip used, so the "you should rebase/merge" signal survives
  /// the move into the menu.
  PopupMenuItem<String> _branchInfoItem() {
    final warn = behind > 0;
    return PopupMenuItem<String>(
      enabled: false,
      height: 36,
      child: Row(
        children: [
          Icon(
            Icons.account_tree_outlined,
            size: 16,
            color: warn ? const Color(0xFFa85a25) : const Color(0xFF1267b5),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              branch!,
              key: const Key('chat-header-branch'),
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.5,
                color: warn ? const Color(0xFFa85a25) : const Color(0xFF6f8096),
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (warn)
            Text(
              '↓$behind',
              style: const TextStyle(fontSize: 11, color: Color(0xFFa85a25)),
            ),
        ],
      ),
    );
  }

  PopupMenuItem<String> _item(
    String value,
    IconData icon,
    String label,
    Color color, {
    Key? key,
  }) {
    return PopupMenuItem<String>(
      key: key,
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

/// 标题旁边的「只读历史」标识。对齐 Web 在归档模式下把 `#status` 写成
/// 「只读历史」这一处 —— App 里对应的状态是 `provider.historyArchive`。
///
/// 措辞刻意不写成「只读」了事：这里能继续对话，只是历史改不动（删消息、清空
/// 上下文在归档模式下都是被挡住的），提示语把这层差别说清楚。
class _ReadOnlyHistoryChip extends StatelessWidget {
  const _ReadOnlyHistoryChip();

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: t('readOnlyHistoryHint'),
      child: Container(
        key: const Key('chat-read-only-badge'),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          color: const Color(0xFFf1f4f9),
          border: Border.all(color: const Color(0xFFc9d6e4)),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.lock_outline_rounded,
              size: 11,
              color: Color(0xFF6f8096),
            ),
            const SizedBox(width: 4),
            Text(
              t('readOnlyHistory'),
              style: const TextStyle(
                color: Color(0xFF6f8096),
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The chat header's session title. Ellipsized when long, but the full
/// `directory / name` is always available — via long-press tooltip for sighted
/// users and via the semantic label for screen readers, which announce the
/// whole string regardless of visual truncation.
class _SessionTitle extends StatelessWidget {
  final String label;

  /// 双击改名，对齐 web 双击 `#session-title` 那条路径。宽屏标题是 Expanded
  /// 的主角、窄屏它独占一行，两处都是这个 widget，所以手势绑在这里。
  final VoidCallback? onDoubleTap;
  const _SessionTitle({required this.label, this.onDoubleTap});

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: onDoubleTap == null
          ? MouseCursor.defer
          : SystemMouseCursors.click,
      child: GestureDetector(
        onDoubleTap: onDoubleTap,
        child: Tooltip(
          message: label,
          waitDuration: const Duration(milliseconds: 350),
          child: Semantics(
            label: label,
            excludeSemantics: true,
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Color(0xFF233249),
                fontSize: 14,
                fontWeight: FontWeight.w600,
                fontFamily: 'monospace',
              ),
            ),
          ),
        ),
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
      SessionCli.claude => const Color(0xFFc2622f),
      SessionCli.codex => const Color(0xFF1e8a55),
      SessionCli.opencode => const Color(0xFF6d4fd1),
      SessionCli.zcode => const Color(0xFF0e7fb8),
      SessionCli.qoder => const Color(0xFFc25e1e),
      SessionCli.codebuddy => const Color(0xFF2a5fd8),
      SessionCli.dsh => const Color(0xFF2b44d6),
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
