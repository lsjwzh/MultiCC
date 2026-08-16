// Git 记录（提交历史）底部面板：会话 worktree 或目录仓库的提交列表
// （短 hash / 主题 / 作者 / 时间 / refs），点开单条看 stat + diff。
// 数据走 /api/git/log 与 /api/git/commit-diff--与 web manage 的 git tree 同源，
// 是它缺失的移动端对应物。取数函数从外部注入，widget 测试无需真实网络。
import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/git_commit.dart';
import 'session_diff_dialog.dart' show diffSpans;

/// Open the commit-history sheet. [fetchLog] loads the list (it receives the
/// sheet's all-branches flag), [fetchDiff] loads one commit's diff by hash -
/// callers close over SessionService with either a sessionId (session
/// worktree) or a dirId (directory repo).
Future<void> showGitLogSheet(
  BuildContext context, {
  required Future<List<GitCommit>> Function(bool allBranches) fetchLog,
  required Future<GitCommitDiff> Function(String hash) fetchDiff,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFF0f1115),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _GitLogSheet(fetchLog: fetchLog, fetchDiff: fetchDiff),
  );
}

class _GitLogSheet extends StatefulWidget {
  const _GitLogSheet({required this.fetchLog, required this.fetchDiff});

  final Future<List<GitCommit>> Function(bool allBranches) fetchLog;
  final Future<GitCommitDiff> Function(String hash) fetchDiff;

  @override
  State<_GitLogSheet> createState() => _GitLogSheetState();
}

class _GitLogSheetState extends State<_GitLogSheet> {
  List<GitCommit>? _commits;
  String? _error;
  bool _loading = true;
  bool _allBranches = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final commits = await widget.fetchLog(_allBranches);
      if (!mounted) return;
      setState(() {
        _commits = commits;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  void _openCommit(GitCommit commit) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _CommitDiffPage(
          commit: commit,
          fetchDiff: widget.fetchDiff,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height * 0.82;
    return SizedBox(
      height: height,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
            child: Row(
              children: [
                const Icon(
                  Icons.history_rounded,
                  size: 16,
                  color: Color(0xFF6aa3ff),
                ),
                const SizedBox(width: 8),
                Text(
                  t('gitLogTitle'),
                  style: const TextStyle(
                    color: Color(0xFFf2f4f7),
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                // 同步入口的文案口径：切换全分支可见性 + 刷新。
                _AllBranchesToggle(
                  value: _allBranches,
                  onChanged: (v) {
                    setState(() => _allBranches = v);
                    _load();
                  },
                ),
                IconButton(
                  icon: const Icon(Icons.refresh_rounded,
                      size: 18, color: Color(0xFF8a909b)),
                  tooltip: t('retry'),
                  onPressed: _loading ? null : _load,
                ),
              ],
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '${t('gitLogLoadFailed')}：$_error',
            style: const TextStyle(color: Color(0xFFffb3ae), fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final commits = _commits ?? const <GitCommit>[];
    if (commits.isEmpty) {
      return Center(
        child: Text(
          t('gitLogEmpty'),
          style: const TextStyle(color: Color(0xFF5b616c), fontSize: 13),
        ),
      );
    }
    return ListView.separated(
      itemCount: commits.length,
      separatorBuilder: (_, __) => const Divider(
        height: 1,
        color: Color(0xFF1c2129),
      ),
      itemBuilder: (_, i) {
        final c = commits[i];
        return ListTile(
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          onTap: () => _openCommit(c),
          title: Row(
            children: [
              Text(
                c.short,
                style: const TextStyle(
                  color: Color(0xFFd2a8ff),
                  fontSize: 12,
                  fontFamily: 'monospace',
                ),
              ),
              if (c.refs.isNotEmpty) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    c.refs,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFFe3b341),
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ],
          ),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 2),
              Text(
                c.subject,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              ),
              const SizedBox(height: 2),
              Text(
                '${c.author} · ${c.dateLabel}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The all-branches switch (`--all`): with it on, commits living only on
/// sibling worktree branches show too. The sheet re-fetches through the
/// injected [fetchLog] with the new flag.
class _AllBranchesToggle extends StatelessWidget {
  const _AllBranchesToggle({required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => onChanged(!value),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              value
                  ? Icons.toggle_on_rounded
                  : Icons.toggle_off_rounded,
              size: 20,
              color: value ? const Color(0xFF3ad6c5) : const Color(0xFF5b616c),
            ),
            const SizedBox(width: 4),
            Text(
              t('gitLogAllBranches'),
              style: TextStyle(
                color: value ? const Color(0xFF3ad6c5) : const Color(0xFF8a909b),
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Full-screen commit diff: subject header, `--stat` block, then the raw patch
/// colored line by line (same scheme as the worktree diff view).
class _CommitDiffPage extends StatefulWidget {
  const _CommitDiffPage({required this.commit, required this.fetchDiff});

  final GitCommit commit;
  final Future<GitCommitDiff> Function(String hash) fetchDiff;

  @override
  State<_CommitDiffPage> createState() => _CommitDiffPageState();
}

class _CommitDiffPageState extends State<_CommitDiffPage> {
  GitCommitDiff? _diff;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final diff = await widget.fetchDiff(widget.commit.hash);
      if (!mounted) return;
      setState(() {
        _diff = diff;
        _loading = false;
        // A soft error (git failed but the route answered) renders like an
        // error page, not like an empty diff.
        if (diff.error != null && diff.error!.isNotEmpty) {
          _error = diff.error;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.commit;
    return Scaffold(
      backgroundColor: const Color(0xFF0f1115),
      appBar: AppBar(
        backgroundColor: const Color(0xFF14171c),
        iconTheme: const IconThemeData(color: Color(0xFFe7eaee)),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              c.subject,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Color(0xFFf2f4f7),
                fontSize: 14,
              ),
            ),
            Text(
              '${c.short} · ${c.author} · ${c.dateLabel}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Color(0xFF8a909b),
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '${t('gitLogLoadFailed')}：$_error',
            style: const TextStyle(color: Color(0xFFffb3ae), fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final d = _diff!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (d.stat.trim().isNotEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
            color: const Color(0xFF12151b),
            child: SelectableText(
              d.stat.trim(),
              style: const TextStyle(
                color: Color(0xFF8a909b),
                fontSize: 11,
                fontFamily: 'monospace',
                height: 1.5,
              ),
            ),
          ),
        if (d.truncated)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            color: const Color(0x33d29922),
            child: Text(
              t('gitLogDiffTruncated'),
              style: const TextStyle(color: Color(0xFFe3b341), fontSize: 11),
            ),
          ),
        Expanded(child: _patchArea(d)),
      ],
    );
  }

  Widget _patchArea(GitCommitDiff d) {
    final patch = d.diff;
    if (patch.trim().isEmpty) {
      return Center(
        child: Text(
          t('gitLogEmptyDiff'),
          style: const TextStyle(color: Color(0xFF5b616c), fontSize: 13),
        ),
      );
    }
    return SingleChildScrollView(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SelectableText.rich(
          TextSpan(children: diffSpans(patch)),
          style: const TextStyle(
            color: Color(0xFFe7eaee),
            fontFamily: 'monospace',
            fontSize: 11,
            height: 1.5,
          ),
        ),
      ),
    );
  }
}
