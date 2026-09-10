part of 'task_board_view.dart';

class _ComposerBtn extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData icon;
  final Color color;

  const _ComposerBtn({
    required this.onTap,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 40,
        alignment: Alignment.center,
        child: Icon(
          icon,
          color: onTap != null ? color : AppColors.faint,
          size: 20,
        ),
      ),
    );
  }
}

class _SendBtn extends StatelessWidget {
  final VoidCallback? onTap;
  final bool sending;

  const _SendBtn({required this.onTap, required this.sending});

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: enabled ? AppColors.accentDark : AppColors.panel2,
          borderRadius: BorderRadius.circular(10),
        ),
        child: sending
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : Icon(
                Icons.send_rounded,
                color: enabled ? Colors.white : AppColors.faint,
                size: 20,
              ),
      ),
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

String _timeAgo(int ts) {
  if (ts <= 0) return '';
  return formatRelativeTime(DateTime.fromMillisecondsSinceEpoch(ts));
}
