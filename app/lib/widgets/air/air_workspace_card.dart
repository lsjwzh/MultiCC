import 'package:flutter/material.dart';

import '../../models/message.dart';
import '../../services/air_service.dart';
import '../../theme.dart';
import '../git_status_row.dart';

/// 目录首页那张「工作区」卡：**一张卡、一个抬头、两格内容** —— 主检出本身的
/// 代码状态（Git）和这个目录下 worktree 的生命周期。
///
/// 为什么合成一张：两格回答的是同一个问题「这个目录还有多少东西没落回原位」，
/// 分两张卡各自带一行标题、各自一段留白，而它们读的又是同一份目录状态。合起来
/// 之后标题只有一处，两边的动作（这一格的「现在回收」、Web 侧那颗 push）都还在
/// 原处。
class AirWorkspaceCard extends StatelessWidget {
  const AirWorkspaceCard({
    super.key,
    required this.lifecycle,
    this.pushState,
    this.idleMs = 0,
    this.busy = false,
    this.onReclaim,
  });

  final AirWorktreeLifecycle lifecycle;

  /// 主检出的 git 状态（宿主从 `/api/directories` 那一份拿到的 `pushState`）。
  ///
  /// null = 这块没有可说的（远端工作区、不是 git 仓库、还没读到）—— 那一格就不
  /// 摆。「读取失败」和「没有这一格」在用户眼里是两件事，这一层只负责后者。
  final DirectoryPushState? pushState;

  /// 自动回收的闲置阈值（毫秒），来自快照的 `worktreePolicy`。
  /// 0 = 自动回收已关闭（`MULTICC_SESSION_HIBERNATE_IDLE_MS=0`）。
  final int idleMs;

  /// 正在回收：按钮换成「回收中…」并禁用，避免连点出两批回收。
  final bool busy;

  /// 「现在回收」。null = 只读（远端工作区那行没有本机 worktree 可收）。
  final VoidCallback? onReclaim;

  @override
  Widget build(BuildContext context) {
    final git = pushState;
    return Container(
      key: const ValueKey('air-directory-workspace'),
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(14, 11, 14, 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'WORKSPACE',
                  style: TextStyle(
                    color: AppColors.faint,
                    fontSize: 10.5,
                    letterSpacing: 0.6,
                  ),
                ),
                SizedBox(height: 2),
                Text(
                  '工作区',
                  key: ValueKey('air-workspace-heading'),
                  style: TextStyle(
                    color: AppColors.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          // 上半格：代码状态。GitStatusRow 自己知道哪些字段有得说（分支 / 未推送 /
          // 未提交），这里只决定「这一格摆不摆」。
          if (git != null && git.available)
            _WorkspaceBlock(
              label: '代码状态',
              child: Padding(
                padding: const EdgeInsets.only(top: 2),
                child: GitStatusRow(pushState: git),
              ),
            ),
          AirWorktreeBlock(
            lifecycle: lifecycle,
            idleMs: idleMs,
            busy: busy,
            onReclaim: onReclaim,
          ),
        ],
      ),
    );
  }
}

/// 卡里的一格：一行小标题 + 内容。两个子块共用这一份骨架，卡片只有一个抬头。
class _WorkspaceBlock extends StatelessWidget {
  const _WorkspaceBlock({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: AppColors.faint,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        child,
      ],
    ),
  );
}

/// 「工作区」卡里那一格 worktree 生命周期（Web `#directory-worktrees` 的内容，
/// 口径与拆解都在服务端的 workspace registry）。
///
/// 为什么单列一格：只报「有几个 worktree」看不出这个数是怎么长的 —— 本地真占着
/// 磁盘的、已经睡下只剩一条分支引用的、计划了还没落地的，是三种完全不同的状态，
/// 而用户要判断的正是「要不要现在腾地方」。客户端只读不推断。
///
/// 回收只删本地 checkout，分支与提交始终保留（下次打开这条任务时按需重建），所以
/// 这一步不需要「会丢东西」的警告；按钮变灰只说明「本地没有可收的」。
class AirWorktreeBlock extends StatelessWidget {
  const AirWorktreeBlock({
    super.key,
    required this.lifecycle,
    this.idleMs = 0,
    this.busy = false,
    this.onReclaim,
  });

  final AirWorktreeLifecycle lifecycle;

  /// 自动回收的闲置阈值（毫秒），来自快照的 `worktreePolicy`。
  final int idleMs;

  /// 正在回收：按钮换成「回收中…」并禁用，避免连点出两批回收。
  final bool busy;

  /// 「现在回收」。null = 只读（远端工作区那行没有本机 worktree 可收）。
  final VoidCallback? onReclaim;

  @override
  Widget build(BuildContext context) {
    // 默认阈值是 24 小时，说成「闲置超过 24 小时」比说 86400000 有用；服务端把
    // 自动回收关了（idleMs = 0）也要照实说，别让人以为它一直在后台收东西。
    final hours = (idleMs / 3600000).round().clamp(1, 24 * 365);
    final policy = idleMs > 0 ? '闲置超过 $hours 小时会自动回收' : '自动回收已关闭';
    final summary = [
      '${lifecycle.total} 个 Worktree',
      airWorktreeBreakdown(lifecycle),
      if (lifecycle.leased > 0) '占用中 ${lifecycle.leased}',
    ].join(' · ');
    return _WorkspaceBlock(
      label: 'Worktree 生命周期',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  summary,
                  key: const ValueKey('air-worktree-summary'),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                  ),
                ),
              ),
              if (onReclaim != null) ...[
                const SizedBox(width: 8),
                OutlinedButton(
                  key: const ValueKey('air-worktree-reclaim'),
                  onPressed: busy || lifecycle.onDisk == 0 ? null : onReclaim,
                  style: OutlinedButton.styleFrom(
                    backgroundColor: AppColors.blueSoft,
                    side: const BorderSide(color: AppColors.lineStrong),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    minimumSize: const Size(0, 32),
                  ),
                  child: Text(
                    busy ? '回收中…' : '现在回收',
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          const Text(
            '本地留着的 checkout 会随闲置时间自动收起，分支与提交始终保留。',
            style: TextStyle(
              color: AppColors.muted,
              fontSize: 11.5,
              height: 1.5,
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              policy,
              style: const TextStyle(color: AppColors.faint, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }
}
