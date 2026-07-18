import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// Agent 资源与缓存。镜像网页管理台的「Agent 资源」+「临时上传」面板：
/// 查看 Skills、同步状态、Claude 历史会话和服务器临时上传缓存。
class AgentResourcesScreen extends StatefulWidget {
  final SettingsService settings;
  const AgentResourcesScreen({super.key, required this.settings});

  @override
  State<AgentResourcesScreen> createState() => _AgentResourcesScreenState();
}

class _AgentResourcesScreenState extends State<AgentResourcesScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _skills;
  Map<String, dynamic>? _history;
  Map<String, dynamic>? _uploads;
  Map<String, dynamic>? _skillSync;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await Future.wait([
        _manage.fetchSkills(),
        _manage.fetchClaudeHistory(),
        _manage.fetchUploadStats(),
        _manage.fetchSkillSyncStatus(),
      ]);
      if (!mounted) return;
      setState(() {
        _skills = r[0];
        _history = r[1];
        _uploads = r[2];
        _skillSync = r[3];
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

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _cleanupHistory() async {
    final days = await _askDays();
    if (days == null) return;
    setState(() => _busy = true);
    try {
      final r = await _manage.cleanupClaudeHistory(days);
      _snack('已清理 ${r['deleted'] ?? 0} 个会话，释放 ${_fmtBytes((r['freed'] as num?)?.toInt() ?? 0)}');
      await _refresh();
    } catch (e) {
      _snack('清理失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _runSkillSync() async {
    setState(() => _busy = true);
    try {
      final result = await _manage.runSkillSync();
      if (!mounted) return;
      setState(() => _skillSync = result);
      _snack('技能同步完成：链接 ${result['linkCount'] ?? 0} · 转换 ${result['convCount'] ?? 0}');
    } catch (e) {
      _snack('技能同步失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<int?> _askDays() async {
    final ctrl = TextEditingController(text: '30');
    return showDialog<int>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('清理历史会话'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('删除「早于 N 天且未被当前会话引用」的 Claude 历史。受保护（linked）的会话不会被删除。',
                style: TextStyle(color: AppColors.muted, fontSize: 13, height: 1.5)),
            const SizedBox(height: 14),
            TextField(
              controller: ctrl,
              keyboardType: TextInputType.number,
              style: const TextStyle(color: AppColors.text),
              decoration: const InputDecoration(
                labelText: '保留最近 N 天',
                labelStyle: TextStyle(color: AppColors.muted),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消', style: TextStyle(color: AppColors.muted))),
          TextButton(
              onPressed: () {
                final n = int.tryParse(ctrl.text.trim());
                if (n == null || n < 1) return;
                Navigator.pop(context, n);
              },
              child: const Text('清理', style: TextStyle(color: AppColors.danger))),
        ],
      ),
    );
  }

  Future<void> _cleanupUploads() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('清理临时上传'),
        content: Text('删除服务器上全部临时上传文件（${_uploads?['count'] ?? 0} 个，'
            '${_fmtBytes((_uploads?['totalSize'] as num?)?.toInt() ?? 0)}）？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted))),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('清理', style: TextStyle(color: AppColors.danger))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      final r = await _manage.cleanupUploads();
      _snack('已删除 ${r['deleted'] ?? 0} 个文件，释放 ${_fmtBytes((r['freed'] as num?)?.toInt() ?? 0)}');
      await _refresh();
    } catch (e) {
      _snack('清理失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('Agent 资源 / 缓存'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : RefreshIndicator(
                  color: AppColors.accent,
                  backgroundColor: AppColors.panel,
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.all(14),
                    children: [
                      _skillsSection(),
                      const SizedBox(height: 18),
                      _skillSyncSection(),
                      const SizedBox(height: 18),
                      _historySection(),
                      const SizedBox(height: 18),
                      _uploadsSection(),
                      if (_busy) ...[
                        const SizedBox(height: 20),
                        const Center(
                            child: CircularProgressIndicator(color: AppColors.accent)),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _skillsSection() {
    final skills = (_skills?['skills'] as List? ?? []);
    final counts = (_skills?['counts'] as Map? ?? {});
    return _Card(
      title: 'Skills',
      subtitle: 'Claude ${counts['claude'] ?? 0} · Codex ${counts['codex'] ?? 0} · 共 ${skills.length}',
      child: skills.isEmpty
          ? const _Muted('未检测到已安装的 Skills')
          : Column(
              children: skills.take(60).map((s) {
                final m = (s as Map);
                final provider = (m['provider'] ?? '').toString();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        margin: const EdgeInsets.only(top: 2),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: (provider == 'codex' ? AppColors.codex : AppColors.claude)
                              .withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Text(provider.isEmpty ? '—' : provider,
                            style: TextStyle(
                                color: provider == 'codex' ? AppColors.codex : AppColors.claude,
                                fontSize: 10,
                                fontWeight: FontWeight.w600)),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text((m['name'] ?? '').toString(),
                                style: const TextStyle(
                                    color: AppColors.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                            if ((m['description'] ?? '').toString().isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Text((m['description']).toString(),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        color: AppColors.faint, fontSize: 11.5, height: 1.4)),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
    );
  }

  Widget _historySection() {
    final sessions = (_history?['sessions'] as List? ?? []);
    final total = (_history?['totalSize'] as num?)?.toInt() ?? 0;
    final protectedCount = _history?['protectedCount'] ?? 0;
    return _Card(
      title: 'Claude 历史会话',
      subtitle: '${_history?['count'] ?? 0} 个 · ${_fmtBytes(total)} · 受保护 $protectedCount',
      trailing: TextButton.icon(
        onPressed: _busy ? null : _cleanupHistory,
        icon: const Icon(Icons.cleaning_services_outlined, size: 16, color: AppColors.danger),
        label: const Text('按天清理', style: TextStyle(color: AppColors.danger, fontSize: 12.5)),
      ),
      child: sessions.isEmpty
          ? const _Muted('暂无历史会话')
          : Column(
              children: sessions.take(40).map((s) {
                final m = (s as Map);
                final linked = m['linked'] == true;
                final title = (m['label'] ?? m['summary'] ?? m['id'] ?? '').toString();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 9),
                  child: Row(
                    children: [
                      Icon(linked ? Icons.lock_outline_rounded : Icons.history_rounded,
                          size: 15, color: linked ? AppColors.amber : AppColors.faint),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(title.isEmpty ? '(无标题)' : title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: AppColors.text, fontSize: 12.5)),
                      ),
                      const SizedBox(width: 8),
                      Text(_fmtBytes((m['size'] as num?)?.toInt() ?? 0),
                          style: const TextStyle(color: AppColors.faint, fontSize: 11)),
                    ],
                  ),
                );
              }).toList(),
            ),
    );
  }

  Widget _skillSyncSection() {
    final sync = _skillSync ?? const <String, dynamic>{};
    final status = (sync['status'] ?? 'never-synced').toString();
    final error = sync['error']?.toString();
    final queue = sync['aiQueue'] is Map ? sync['aiQueue'] as Map : const {};
    return _Card(
      title: '技能同步',
      subtitle: '$status · ${_formatSyncTime(sync['ts'])}',
      trailing: TextButton.icon(
        onPressed: _busy ? null : _runSkillSync,
        icon: const Icon(Icons.sync_rounded, size: 17, color: AppColors.accent),
        label: const Text('立即同步', style: TextStyle(color: AppColors.accent, fontSize: 12.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _MetricChip('链接', sync['linkCount'] ?? 0),
              _MetricChip('跳过', sync['skipCount'] ?? 0),
              _MetricChip('转换', sync['convCount'] ?? 0),
              _MetricChip('反向导入', sync['reverseImportCount'] ?? 0),
              _MetricChip('内置安装', sync['bundledInstallCount'] ?? 0),
              _MetricChip('共享', sync['sharedSkillCount'] ?? 0),
              _MetricChip('AI 队列', queue['queueLength'] ?? 0),
            ],
          ),
          if (error != null && error.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(error, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
          ],
        ],
      ),
    );
  }

  Widget _uploadsSection() {
    final total = (_uploads?['totalSize'] as num?)?.toInt() ?? 0;
    return _Card(
      title: '临时上传缓存',
      subtitle: '${_uploads?['count'] ?? 0} 个文件 · ${_fmtBytes(total)}',
      trailing: TextButton.icon(
        onPressed: _busy || ((_uploads?['count'] ?? 0) == 0) ? null : _cleanupUploads,
        icon: const Icon(Icons.delete_sweep_outlined, size: 17, color: AppColors.danger),
        label: const Text('一键清理', style: TextStyle(color: AppColors.danger, fontSize: 12.5)),
      ),
      child: _Muted((_uploads?['dir'] ?? '').toString()),
    );
  }
}

String _fmtBytes(int bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  double v = bytes.toDouble();
  int u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return '${v.toStringAsFixed(u == 0 ? 0 : 1)} ${units[u]}';
}

String _formatSyncTime(dynamic raw) {
  DateTime? value;
  if (raw is num && raw > 0) value = DateTime.fromMillisecondsSinceEpoch(raw.toInt());
  if (raw is String && raw.isNotEmpty) value = DateTime.tryParse(raw);
  if (value == null) return '尚未同步';
  final local = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
}

class _Card extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget child;
  final Widget? trailing;
  const _Card(
      {required this.title, required this.subtitle, required this.child, this.trailing});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            color: AppColors.textBright, fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(subtitle, style: const TextStyle(color: AppColors.faint, fontSize: 12)),
                  ],
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
          const Divider(height: 18, color: AppColors.line),
          child,
        ],
      ),
    );
  }
}

class _Muted extends StatelessWidget {
  final String text;
  const _Muted(this.text);
  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(color: AppColors.faint, fontSize: 12, height: 1.4));
}

class _MetricChip extends StatelessWidget {
  final String label;
  final Object value;
  const _MetricChip(this.label, this.value);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: AppColors.bg,
          border: Border.all(color: AppColors.line),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text('$label $value', style: const TextStyle(color: AppColors.muted, fontSize: 11.5)),
      );
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off_rounded, size: 42, color: AppColors.faint),
              const SizedBox(height: 14),
              Text('加载失败\n$message',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.5)),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: onRetry,
                style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: AppColors.lineStrong)),
                child: const Text('重试', style: TextStyle(color: AppColors.accent)),
              ),
            ],
          ),
        ),
      );
}
