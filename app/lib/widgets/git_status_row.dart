import 'package:flutter/material.dart';

import '../models/message.dart';
import '../theme.dart';

/// 目录卡上的 git 状态行（分支 + ahead/behind/dirty）。自 main_shell.dart 抽出。
class GitStatusRow extends StatelessWidget {
  final DirectoryPushState? pushState;
  const GitStatusRow({super.key, this.pushState});

  @override
  Widget build(BuildContext context) {
    final ps = pushState;
    // 没有任何 git 信息时不渲染
    if (ps == null || (!ps.available && ps.dirty == 0)) return const SizedBox.shrink();

    // 不可用 + 也没有脏文件
    if (!ps.available) return const SizedBox.shrink();

    final branch = ps.remoteBranch ?? '';
    final ahead = ps.ahead;
    final behind = ps.behind;
    final dirty = ps.dirty;

    // 构建紧凑的状态行
    final parts = <String>[];
    if (branch.isNotEmpty) parts.add('🌿 $branch');
    if (ahead > 0) parts.add('📤$ahead');
    if (behind > 0) parts.add('📥$behind');
    if (dirty > 0) parts.add('📝$dirty');

    // 如果没有任何值得显示的数据
    if (parts.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Text(
            parts.join('  '),
            style: const TextStyle(
              color: AppColors.faint,
              fontSize: 10,
              fontFamily: 'monospace',
            ),
          ),
          if (dirty == 0 && ahead == 0 && behind == 0) ...[
            const SizedBox(width: 6),
            Container(
              width: 6,
              height: 6,
              decoration: const BoxDecoration(
                color: Color(0xFF3fb950),
                shape: BoxShape.circle,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
