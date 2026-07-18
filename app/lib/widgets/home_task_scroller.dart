import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../services/workspace_service.dart';
import '../theme.dart';
import '../utils/session_status_helpers.dart';

/// Dashboard task carousel for sessions used today.
///
/// The widget deliberately knows nothing about the session manager. Its only
/// runtime dependency is [liveStatusFor], and navigation stays with the host
/// through [onSessionTap].
class HomeTaskScroller extends StatefulWidget {
  final List<Session> sessions;
  final List<Directory> directories;
  final SessionStatus? Function(String sessionId) liveStatusFor;
  final ValueChanged<Session>? onSessionTap;

  const HomeTaskScroller({
    super.key,
    required this.sessions,
    required this.directories,
    required this.liveStatusFor,
    this.onSessionTap,
  });

  @override
  State<HomeTaskScroller> createState() => _HomeTaskScrollerState();
}

class _HomeTaskScrollerState extends State<HomeTaskScroller> {
  static const double _rowH = 46;
  static const int _maxVisible = 3;
  static const Duration _dwell = Duration(seconds: 5);

  final ScrollController _scrollController = ScrollController();
  Timer? _timer;
  int _count = 0;
  int _visible = 1;
  int _pos = 0;

  @override
  void dispose() {
    _timer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  void _syncTimer() {
    if (!mounted) return;
    if (_count > _visible) {
      _timer ??= Timer.periodic(_dwell, (_) => _tick());
    } else {
      _timer?.cancel();
      _timer = null;
      _pos = 0;
      if (_scrollController.hasClients && _scrollController.offset != 0) {
        _scrollController.jumpTo(0);
      }
    }
  }

  void _tick() {
    if (!mounted || !_scrollController.hasClients || _count <= _visible) return;
    _pos += 1;
    _scrollController
        .animateTo(
          _pos * _rowH,
          duration: const Duration(milliseconds: 500),
          curve: Curves.easeInOut,
        )
        .then((_) {
          if (!mounted || !_scrollController.hasClients) return;
          if (_pos >= _count) {
            _pos = 0;
            _scrollController.jumpTo(0);
          }
        });
  }

  bool _isToday(DateTime? timestamp) {
    if (timestamp == null) return false;
    final now = DateTime.now();
    return timestamp.year == now.year &&
        timestamp.month == now.month &&
        timestamp.day == now.day;
  }

  @override
  Widget build(BuildContext context) {
    final directoryNames = {
      for (final directory in widget.directories) directory.id: directory.name,
    };
    final tasks = <_ActiveTask>[];
    for (final session in widget.sessions) {
      if (session.isAux || !_isToday(session.lastActivity)) continue;
      tasks.add(
        _ActiveTask(
          session: session,
          label: session.label?.isNotEmpty == true
              ? session.label!
              : session.id,
          directoryName: directoryNames[session.dirId] ?? '',
          active: session.active,
          lastActivity: session.lastActivity,
          live: widget.liveStatusFor(session.id),
        ),
      );
    }
    tasks.sort((a, b) {
      final aTime = a.lastActivity?.millisecondsSinceEpoch ?? 0;
      final bTime = b.lastActivity?.millisecondsSinceEpoch ?? 0;
      return bTime.compareTo(aTime);
    });

    _count = tasks.length;
    _visible = _count == 0 ? 1 : (_count < _maxVisible ? _count : _maxVisible);
    if (_pos >= _count) _pos = 0;

    final scrolling = _count > _visible;
    final itemCount = tasks.isEmpty
        ? 0
        : tasks.length + (scrolling ? _visible : 0);

    WidgetsBinding.instance.addPostFrameCallback((_) => _syncTimer());

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 2),
      height: _visible * _rowH,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(9),
        child: Container(
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(9),
          ),
          child: tasks.isEmpty
              ? Center(
                  child: Text(
                    t('noActiveTask'),
                    style: TextStyle(
                      color: AppColors.faint.withValues(alpha: 0.8),
                      fontSize: 12,
                    ),
                  ),
                )
              : ListView.builder(
                  controller: _scrollController,
                  physics: const NeverScrollableScrollPhysics(),
                  itemExtent: _rowH,
                  itemCount: itemCount,
                  itemBuilder: (context, index) {
                    final task = tasks[index % tasks.length];
                    return _TaskProgressCard(
                      task: task,
                      onTap: () => widget.onSessionTap?.call(task.session),
                    );
                  },
                ),
        ),
      ),
    );
  }
}

class _ActiveTask {
  final Session session;
  final String label;
  final String directoryName;
  final bool active;
  final DateTime? lastActivity;
  final SessionStatus? live;

  const _ActiveTask({
    required this.session,
    required this.label,
    required this.directoryName,
    required this.active,
    required this.lastActivity,
    this.live,
  });
}

class _TaskProgressCard extends StatelessWidget {
  final _ActiveTask task;
  final VoidCallback? onTap;

  const _TaskProgressCard({required this.task, this.onTap});

  String _relativeTime(DateTime? timestamp) {
    if (timestamp == null) return '';
    final difference = DateTime.now().difference(timestamp);
    if (difference.inMinutes < 1) return '刚刚';
    if (difference.inMinutes < 60) return '${difference.inMinutes} 分钟前';
    if (difference.inHours < 24) return '${difference.inHours} 小时前';
    return '${difference.inDays} 天前';
  }

  @override
  Widget build(BuildContext context) {
    final live = task.live;
    final statusColor = live != null
        ? wbStatusColor(live.status)
        : (task.active ? const Color(0xFF6aa3ff) : const Color(0xFF5b616c));
    final statusLabel = live != null
        ? wbStatusLabel(live.status)
        : (task.active ? '运行中' : '空闲');
    final runtime = runTimeText(live);
    final activityText = runtime.isNotEmpty
        ? '⏱ $runtime'
        : (task.active ? '⚙️ 正在运行' : '🕘 ${_relativeTime(task.lastActivity)}');

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: statusColor,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: statusColor.withValues(alpha: 0.5),
                    blurRadius: 6,
                    spreadRadius: 1,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: RichText(
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                text: TextSpan(
                  text: task.label,
                  style: const TextStyle(
                    color: AppColors.textBright,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                  children: [
                    if (task.directoryName.isNotEmpty)
                      TextSpan(
                        text: '  ·  ${task.directoryName}',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11,
                          fontWeight: FontWeight.normal,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 10),
            if (classifyBadge(live?.classifyState) != null) ...[
              classifyChip(live),
              const SizedBox(width: 8),
            ],
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.15),
                border: Border.all(color: statusColor.withValues(alpha: 0.3)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                statusLabel,
                style: TextStyle(
                  color: statusColor,
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Text(
              activityText,
              style: const TextStyle(color: AppColors.muted, fontSize: 11),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}
