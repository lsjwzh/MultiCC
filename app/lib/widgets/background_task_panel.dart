import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/background_task_board.dart';

/// Compact floating panel for background tasks — the mobile counterpart of
/// the web's danmaku. Collapses to a pill ("N 后台任务") when not expanded;
/// each row shows spin / done / fail / stale state, a one-line description,
/// and a local-only ✕ dismiss. Rows auto-hide a few seconds after finishing
/// (BackgroundTaskBoard.autoHideMs), so the panel usually only shows while
/// something is actually running.
class BackgroundTaskPanel extends StatefulWidget {
  final List<BackgroundTaskRow> rows;
  final void Function(String key) onDismiss;

  /// Render the expanded detail list on first build (floating-dock mount).
  final bool initiallyExpanded;

  /// Reports every internal expand/collapse transition (the ▾ / pill taps).
  final ValueChanged<bool>? onExpandedChanged;
  const BackgroundTaskPanel({
    super.key,
    required this.rows,
    required this.onDismiss,
    this.initiallyExpanded = false,
    this.onExpandedChanged,
  });

  @override
  State<BackgroundTaskPanel> createState() => _BackgroundTaskPanelState();
}

class _BackgroundTaskPanelState extends State<BackgroundTaskPanel> {
  late bool _expanded = widget.initiallyExpanded;

  void _setExpanded(bool value) {
    if (_expanded == value) return;
    setState(() => _expanded = value);
    widget.onExpandedChanged?.call(value);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.rows.isEmpty) return const SizedBox.shrink();
    final spinning =
        widget.rows.where((r) => r.state == BackgroundTaskState.start).length;

    if (!_expanded) {
      return Semantics(
        button: true,
        label: '${t('backgroundTasks')} ${widget.rows.length}',
        child: GestureDetector(
          onTap: () => _setExpanded(true),
          child: Container(
            key: const Key('bg-task-pill'),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xE6f8fbff),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFdce6f1)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (spinning > 0)
                  const SizedBox(
                    width: 11,
                    height: 11,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.5,
                      color: Color(0xFF1267b5),
                    ),
                  )
                else
                  const Icon(
                    Icons.check_circle_outline_rounded,
                    size: 13,
                    color: Color(0xFF1e8a55),
                  ),
                const SizedBox(width: 6),
                Text(
                  '${widget.rows.length} ${t('backgroundTasks')}',
                  style: const TextStyle(color: Color(0xFF31465b), fontSize: 12),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      key: const Key('bg-task-panel'),
      constraints: const BoxConstraints(maxWidth: 320, maxHeight: 220),
      decoration: BoxDecoration(
        color: const Color(0xF2ffffff),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFdce6f1)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${t('backgroundTasks')} · ${widget.rows.length}',
                    style: const TextStyle(
                      color: Color(0xFF20364d),
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                GestureDetector(
                  onTap: () => _setExpanded(false),
                  child: const Padding(
                    padding: EdgeInsets.all(6),
                    child: Icon(
                      Icons.keyboard_arrow_down_rounded,
                      size: 18,
                      color: Color(0xFF6f8096),
                    ),
                  ),
                ),
              ],
            ),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(6, 0, 6, 8),
              children: [
                for (final row in widget.rows)
                  _BackgroundTaskRowView(
                    row: row,
                    onDismiss: () => widget.onDismiss(row.key),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _BackgroundTaskRowView extends StatelessWidget {
  final BackgroundTaskRow row;
  final VoidCallback? onDismiss;
  const _BackgroundTaskRowView({required this.row, this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final state = row.state;
    final leading = switch (state) {
      BackgroundTaskState.start => const SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(
            strokeWidth: 1.5,
            color: Color(0xFF1267b5),
          ),
        ),
      BackgroundTaskState.done => const Icon(
          Icons.check_rounded,
          size: 14,
          color: Color(0xFF1e8a55),
        ),
      BackgroundTaskState.fail => const Icon(
          Icons.error_outline_rounded,
          size: 14,
          color: Color(0xFFb64e43),
        ),
      BackgroundTaskState.stale => const Icon(
          Icons.schedule_rounded,
          size: 14,
          color: Color(0xFFa85a25),
        ),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              row.description.isEmpty ? t('backgroundTaskUnnamed') : row.description,
              style: const TextStyle(color: Color(0xFF31465b), fontSize: 12),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (onDismiss != null)
            GestureDetector(
              onTap: onDismiss,
              child: const Padding(
                padding: EdgeInsets.all(4),
                child: Icon(Icons.close, size: 13, color: Color(0xFF8a9aab)),
              ),
            ),
        ],
      ),
    );
  }
}
