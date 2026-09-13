import 'package:flutter/material.dart';

import '../i18n.dart';

/// 工作树的两块状态件：冲突横幅 + 「强制同步」按钮。都是从 chat_screen.dart
/// 拆出来的（聊天页已贴着源码行数上限，而这两块只吃回调、不碰会话状态）。

/// 冲突横幅，对齐 Web `chat-worktree-status.js` 的 `#conflict-bar`：冲突文件
/// 清单由服务端 merge-status 轮询给出，这里只报个数并提供三个出口。
class WorktreeConflictBanner extends StatelessWidget {
  final List<String> files;
  final VoidCallback onHelp;
  final VoidCallback onContinue;
  final VoidCallback onAbort;
  final VoidCallback onForceSync;
  final bool forceSyncing;
  const WorktreeConflictBanner({
    super.key,
    required this.files,
    required this.onHelp,
    required this.onContinue,
    required this.onAbort,
    required this.onForceSync,
    this.forceSyncing = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('worktree-conflict-bar'),
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFfff1ef),
        border: Border.all(color: const Color(0xFFb64e43)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.warning_amber_rounded,
                size: 16,
                color: Color(0xFFb64e43),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Tooltip(
                  // 文件多的时候一行放不下：横幅上只报个数，完整清单在提示和
                  // 「如何解决」里。
                  message: files.join('\n'),
                  child: Text(
                    t('worktreeConflictBanner', {'n': '${files.length}'}),
                    style: const TextStyle(
                      color: Color(0xFFb64e43),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 6,
            runSpacing: 2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _ConflictAction(
                label: t('worktreeConflictHelp'),
                onPressed: onHelp,
                color: const Color(0xFFb64e43),
                outlined: true,
              ),
              _ConflictAction(
                label: t('worktreeConflictContinue'),
                onPressed: onContinue,
                color: const Color(0xFFf4f8fd),
                background: const Color(0xFFb64e43),
              ),
              _ConflictAction(
                label: t('worktreeConflictAbort'),
                onPressed: onAbort,
                color: const Color(0xFFb64e43),
                outlined: true,
              ),
              WorktreeForceSyncButton(
                busy: forceSyncing,
                onPressed: onForceSync,
                color: const Color(0xFFb64e43),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ConflictAction extends StatelessWidget {
  final String label;
  final VoidCallback onPressed;
  final Color color;
  final Color? background;
  final bool outlined;
  const _ConflictAction({
    required this.label,
    required this.onPressed,
    required this.color,
    this.background,
    this.outlined = false,
  });

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: color,
        backgroundColor: background,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        minimumSize: Size.zero,
        side: outlined ? BorderSide(color: color.withValues(alpha: 0.4)) : null,
      ),
      child: Text(label, style: const TextStyle(fontSize: 12.5)),
    );
  }
}

/// 「强制同步」按钮。两个容器（落后提示条 / 冲突横幅）里长得一样、共用一个
/// 在途状态 —— Web 也是把同一个 affordance 渲染进两处。
class WorktreeForceSyncButton extends StatelessWidget {
  final bool busy;
  final VoidCallback onPressed;
  final Color color;

  /// 落在内部按钮上的 key。两个容器各自的这份都在同一棵子树里可能同时存在，
  /// 所以 key 由调用方给 —— 只有常驻那一处带上（Web 也是只让状态行那份拿 id）。
  final Key? buttonKey;
  const WorktreeForceSyncButton({
    super.key,
    required this.busy,
    required this.onPressed,
    required this.color,
    this.buttonKey,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: t('worktreeForceSyncTitle'),
      child: TextButton(
        key: buttonKey,
        onPressed: busy ? null : onPressed,
        style: TextButton.styleFrom(
          foregroundColor: color,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          minimumSize: Size.zero,
          side: BorderSide(color: color.withValues(alpha: 0.4)),
        ),
        child: Text(
          busy ? t('worktreeForceSyncSending') : t('worktreeForceSync'),
          style: const TextStyle(fontSize: 12.5),
        ),
      ),
    );
  }
}
