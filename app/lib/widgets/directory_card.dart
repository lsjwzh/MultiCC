import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../services/workspace_service.dart';
import '../theme.dart';
import '../utils/session_status_helpers.dart';
import 'git_status_row.dart';
import 'project_stat_pill.dart';
import 'rainbow_border.dart';

/// Immutable display data for one dashboard directory card.
///
/// This boundary deliberately contains no session manager, service, navigator,
/// or mutable workspace connection. The host owns those concerns and rebuilds
/// this value when its domain state changes.
@immutable
class DirectoryCardViewModel {
  final String id;
  final String name;
  final String path;
  final int totalSessions;
  final int activeSessions;
  final int claudeSessions;
  final int codexSessions;
  final int opencodeSessions;
  final int zcodeSessions;
  final DirectoryPushState? pushState;
  final bool running;
  final List<String> recentEventLabels;
  final DirectoryTaskPreview? latestTask;

  const DirectoryCardViewModel({
    required this.id,
    required this.name,
    required this.path,
    required this.totalSessions,
    required this.activeSessions,
    required this.claudeSessions,
    required this.codexSessions,
    required this.opencodeSessions,
    required this.zcodeSessions,
    required this.pushState,
    required this.running,
    required this.recentEventLabels,
    this.latestTask,
  });

  factory DirectoryCardViewModel.fromModels({
    required Directory directory,
    required Iterable<Session> sessions,
    required Map<String, SessionStatus> statuses,
    required Iterable<Map<String, dynamic>> events,
    DateTime? now,
  }) {
    final scopedSessions = sessions
        .where((session) => session.dirId == directory.id)
        .toList(growable: false);
    final latestTask = _latestTask(
      scopedSessions,
      statuses,
      now ?? DateTime.now(),
    );
    const busy = {'running', 'thinking', 'editing'};
    return DirectoryCardViewModel(
      id: directory.id,
      name: directory.name,
      path: directory.path,
      totalSessions: directory.totalSessions,
      activeSessions: scopedSessions.where((session) => session.active).length,
      claudeSessions: directory.claudeTerminalCount + directory.claudeChatCount,
      codexSessions: directory.codexTerminalCount + directory.codexChatCount,
      opencodeSessions:
          directory.opencodeTerminalCount + directory.opencodeChatCount,
      zcodeSessions: directory.zcodeTerminalCount + directory.zcodeChatCount,
      pushState: directory.pushState,
      running: statuses.values.any((status) => busy.contains(status.status)),
      recentEventLabels: List.unmodifiable(
        events
            .toList(growable: false)
            .reversed
            .take(2)
            .map(directoryEventLabel),
      ),
      latestTask: latestTask,
    );
  }

  static DirectoryTaskPreview? _latestTask(
    List<Session> sessions,
    Map<String, SessionStatus> statuses,
    DateTime now,
  ) {
    if (sessions.isEmpty) return null;
    final ordered = List<Session>.of(sessions)
      ..sort((a, b) {
        final ta = sessionLastInteractionAt(a, statuses[a.id]);
        final tb = sessionLastInteractionAt(b, statuses[b.id]);
        return tb.compareTo(ta);
      });

    for (final session in ordered) {
      final live = statuses[session.id];
      final summary = live?.summary;
      if (summary == null || summary.isEmpty) continue;
      final timestamp = live?.summaryTs != null && live!.summaryTs > 0
          ? live.summaryTs
          : sessionLastInteractionAt(session, live).millisecondsSinceEpoch;
      return DirectoryTaskPreview(
        who: session.label?.isNotEmpty == true ? session.label! : session.id,
        summary: summary,
        timestamp: timestamp,
      );
    }

    final latest = ordered.first;
    final live = statuses[latest.id];
    final timestamp = live?.summaryTs != null && live!.summaryTs > 0
        ? live.summaryTs
        : sessionLastInteractionAt(latest, live).millisecondsSinceEpoch;

    late final String summary;
    if (live?.currentFile != null && live!.currentFile!.isNotEmpty) {
      summary = '正在编辑 ${live.currentFile!.split('/').last}';
    } else if (latest.active) {
      summary = '正在运行';
    } else {
      final secondsAgo = now.millisecondsSinceEpoch ~/ 1000 - timestamp ~/ 1000;
      if (secondsAgo < 3600) {
        summary = '最近 ${secondsAgo ~/ 60} 分钟前活跃';
      } else if (secondsAgo < 86400) {
        summary = '最近 ${secondsAgo ~/ 3600} 小时前活跃';
      } else {
        summary = '最近 ${secondsAgo ~/ 86400} 天前活跃';
      }
    }

    return DirectoryTaskPreview(
      who: latest.label?.isNotEmpty == true ? latest.label! : latest.id,
      summary: summary,
      timestamp: timestamp,
    );
  }
}

@immutable
class DirectoryTaskPreview {
  final String who;
  final String summary;
  final int timestamp;

  const DirectoryTaskPreview({
    required this.who,
    required this.summary,
    required this.timestamp,
  });
}

/// Explicit user-intent and drag coordination port for [DirectoryCard].
///
/// Keeping navigation and mutations here makes the visual component reusable
/// and prevents it from reaching through the widget tree for a parent State.
@immutable
class DirectoryCardCallbacks {
  final VoidCallback onOpen;
  final VoidCallback onOpenMemo;
  final VoidCallback onShowUncommitted;
  final VoidCallback onRename;
  final VoidCallback onDelete;
  final ValueChanged<String>? onDragHover;
  final ValueChanged<String>? onDragLeave;
  final void Function(String sourceId, String targetId)? onDrop;
  final VoidCallback? onDragEnd;

  const DirectoryCardCallbacks({
    required this.onOpen,
    required this.onOpenMemo,
    required this.onShowUncommitted,
    required this.onRename,
    required this.onDelete,
    this.onDragHover,
    this.onDragLeave,
    this.onDrop,
    this.onDragEnd,
  });
}

class DirectoryCard extends StatelessWidget {
  final DirectoryCardViewModel view;
  final DirectoryCardCallbacks callbacks;

  const DirectoryCard({super.key, required this.view, required this.callbacks});

  PopupMenuItem<String> _menuItem(
    String value,
    IconData icon,
    String label, {
    bool danger = false,
  }) {
    final color = danger ? const Color(0xFFff6b63) : const Color(0xFFe7eaee);
    return PopupMenuItem<String>(
      value: value,
      height: 40,
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          Text(label, style: TextStyle(color: color, fontSize: 14)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return RainbowBorder(
      running: view.running,
      borderRadius: BorderRadius.circular(8),
      child: LongPressDraggable<String>(
        data: view.id,
        onDragEnd: (_) => callbacks.onDragEnd?.call(),
        feedback: Material(
          elevation: 6,
          color: Colors.transparent,
          child: Container(
            width: MediaQuery.of(context).size.width - 24,
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(
              color: AppColors.panel,
              border: Border.all(color: AppColors.accent, width: 2),
              borderRadius: BorderRadius.circular(8),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.4),
                  blurRadius: 12,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
              child: Row(
                children: [
                  Icon(Icons.drag_indicator, color: AppColors.accent, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      view.name,
                      style: const TextStyle(
                        color: AppColors.textBright,
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        childWhenDragging: Container(
          margin: const EdgeInsets.only(bottom: 14),
          decoration: BoxDecoration(
            color: AppColors.panel.withValues(alpha: 0.5),
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
            child: Row(
              children: [
                Icon(Icons.drag_indicator, color: AppColors.faint, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    view.name,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        ),
        child: DragTarget<String>(
          onWillAcceptWithDetails: (details) {
            if (details.data == view.id) return false;
            callbacks.onDragHover?.call(view.id);
            return true;
          },
          onLeave: (_) => callbacks.onDragLeave?.call(view.id),
          onAcceptWithDetails: (details) =>
              callbacks.onDrop?.call(details.data, view.id),
          builder: (context, candidateData, rejectedData) {
            final isHovering = candidateData.isNotEmpty;
            return AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                color: isHovering ? AppColors.panel2 : AppColors.panel,
                border: Border.all(
                  color: isHovering ? AppColors.accent : AppColors.line,
                  width: isHovering ? 2 : 1,
                ),
                borderRadius: BorderRadius.circular(8),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.18),
                    blurRadius: 22,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              child: InkWell(
                key: ValueKey('directory-card-open-${view.id}'),
                onTap: callbacks.onOpen,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.drag_indicator,
                            size: 18,
                            color: AppColors.faint,
                          ),
                          const SizedBox(width: 8),
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: AppColors.bg,
                              border: Border.all(color: AppColors.line),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Icon(
                              Icons.folder_outlined,
                              color: AppColors.muted,
                              size: 20,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  view.name,
                                  style: const TextStyle(
                                    color: AppColors.textBright,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 16,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  view.path,
                                  style: const TextStyle(
                                    color: AppColors.blue,
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                if ((view.pushState?.dirty ?? 0) > 0)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 5),
                                    child: InkWell(
                                      key: ValueKey(
                                        'directory-card-dirty-${view.id}',
                                      ),
                                      onTap: callbacks.onShowUncommitted,
                                      borderRadius: BorderRadius.circular(999),
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 8,
                                          vertical: 2,
                                        ),
                                        decoration: BoxDecoration(
                                          color: const Color(0x1AE3B341),
                                          border: Border.all(
                                            color: const Color(0x73E3B341),
                                          ),
                                          borderRadius: BorderRadius.circular(
                                            999,
                                          ),
                                        ),
                                        child: Text(
                                          '⚠ ${view.pushState!.dirty} 未提交',
                                          style: const TextStyle(
                                            color: Color(0xFFE3B341),
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                GitStatusRow(pushState: view.pushState),
                              ],
                            ),
                          ),
                          IconButton(
                            key: ValueKey('directory-card-memo-${view.id}'),
                            icon: const Icon(
                              Icons.sticky_note_2_outlined,
                              size: 19,
                              color: AppColors.muted,
                            ),
                            tooltip: t('projectMemo'),
                            onPressed: callbacks.onOpenMemo,
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(
                              minWidth: 44,
                              minHeight: 44,
                            ),
                          ),
                          PopupMenuButton<String>(
                            key: ValueKey('directory-card-menu-${view.id}'),
                            icon: const Icon(
                              Icons.more_horiz_rounded,
                              size: 19,
                              color: AppColors.muted,
                            ),
                            tooltip: t('moreActions'),
                            color: const Color(0xFF161b22),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(
                              minWidth: 44,
                              minHeight: 44,
                            ),
                            onSelected: (value) {
                              switch (value) {
                                case 'uncommitted':
                                  callbacks.onShowUncommitted();
                                  break;
                                case 'rename':
                                  callbacks.onRename();
                                  break;
                                case 'delete':
                                  callbacks.onDelete();
                                  break;
                              }
                            },
                            itemBuilder: (_) {
                              final items = <PopupMenuEntry<String>>[];
                              final dirty = view.pushState?.dirty ?? 0;
                              if (dirty > 0) {
                                items.add(
                                  _menuItem(
                                    'uncommitted',
                                    Icons.warning_amber_rounded,
                                    '⚠ $dirty 个未提交文件',
                                  ),
                                );
                                items.add(const PopupMenuDivider());
                              }
                              items.add(
                                _menuItem(
                                  'rename',
                                  Icons.drive_file_rename_outline_rounded,
                                  t('rename'),
                                ),
                              );
                              items.add(const PopupMenuDivider());
                              items.add(
                                _menuItem(
                                  'delete',
                                  Icons.delete_outline_rounded,
                                  t('deleteDirectory'),
                                  danger: true,
                                ),
                              );
                              return items;
                            },
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          ProjectStatPill(
                            label: t('sessions'),
                            value: view.totalSessions.toString(),
                          ),
                          ProjectStatPill(
                            label: t('active'),
                            value: view.activeSessions.toString(),
                          ),
                          ProjectStatPill(
                            label: 'Claude',
                            value: view.claudeSessions.toString(),
                            color: AppColors.claude,
                          ),
                          ProjectStatPill(
                            label: 'Codex',
                            value: view.codexSessions.toString(),
                            color: AppColors.codex,
                          ),
                          if (view.opencodeSessions > 0)
                            ProjectStatPill(
                              label: 'OpenCode',
                              value: view.opencodeSessions.toString(),
                              color: AppColors.opencode,
                            ),
                          if (view.zcodeSessions > 0)
                            ProjectStatPill(
                              label: 'ZCode',
                              value: view.zcodeSessions.toString(),
                              color: AppColors.zcode,
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      _DirectoryPreview(
                        recentEventLabels: view.recentEventLabels,
                        latestTask: view.latestTask,
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          const Icon(
                            Icons.touch_app_outlined,
                            size: 13,
                            color: AppColors.faint,
                          ),
                          const SizedBox(width: 5),
                          Text(
                            t('tapForDetails'),
                            style: const TextStyle(
                              color: AppColors.faint,
                              fontSize: 11,
                            ),
                          ),
                          const Spacer(),
                          const Icon(
                            Icons.keyboard_arrow_up_rounded,
                            size: 18,
                            color: AppColors.faint,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _DirectoryPreview extends StatelessWidget {
  final List<String> recentEventLabels;
  final DirectoryTaskPreview? latestTask;

  const _DirectoryPreview({
    required this.recentEventLabels,
    required this.latestTask,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 39,
          child: recentEventLabels.isEmpty
              ? Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    t('noRecentActivity'),
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11,
                    ),
                  ),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (final label in recentEventLabels)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 3),
                        child: Text(
                          label,
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 11,
                            height: 1.25,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
        ),
        const SizedBox(height: 6),
        SizedBox(
          height: 34,
          child: latestTask == null
              ? Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    t('noRecentTask'),
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11,
                    ),
                  ),
                )
              : Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.accent.withValues(alpha: 0.10),
                    border: Border.all(
                      color: AppColors.accent.withValues(alpha: 0.38),
                    ),
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(
                    '🗒 ${latestTask!.who}  ${latestTask!.summary}',
                    style: const TextStyle(
                      color: Color(0xFF7fe6da),
                      fontSize: 11,
                      height: 1.2,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
        ),
      ],
    );
  }
}

String directoryEventLabel(Map<String, dynamic> event) {
  final who = (event['sessionLabel'] ?? event['sessionId'] ?? '').toString();
  final detail = (event['detail'] ?? '').toString();
  switch (event['type']) {
    case 'session_created':
      return '🆕 新建会话 $who（$detail）';
    case 'session_renamed':
      return '✏️ 会话改名为 ${detail.isNotEmpty ? detail : who}';
    case 'session_deleted':
      return '🗑 删除会话 ${detail.isNotEmpty ? detail : who}';
    case 'merged':
      return '🔀 $who 合并：$detail';
    case 'memory_updated':
      return '🧠 $who ${detail.isNotEmpty ? detail : '更新会话记忆'}';
    case 'synced':
      return '🔄 $who 同步：$detail';
    case 'sync_conflict':
      return '⚠️ $who ${detail.isNotEmpty ? detail : '同步冲突'}';
    case 'dispatch':
      return '📤 $who 分发 $detail';
    case 'note':
      return '📨 $who 留言 $detail';
    case 'note_delivered':
      return '📬 $who：$detail';
    default:
      return '· ${event['type']} $who';
  }
}
