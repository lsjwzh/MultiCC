import 'package:flutter/material.dart';

import '../models/message.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 定时任务 (Cron) 管理。镜像网页管理台的「定时任务」面板：列出、新建、编辑、
/// 启停、立即运行、删除 multicc 原生定时任务（到点向目标目录的专属会话发 prompt）。
class CronScreen extends StatefulWidget {
  final SettingsService settings;
  const CronScreen({super.key, required this.settings});

  @override
  State<CronScreen> createState() => _CronScreenState();
}

class _CronScreenState extends State<CronScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);
  late final SessionService _sessions = SessionService(settings: widget.settings);

  List<CronTask> _tasks = [];
  List<Directory> _dirs = [];
  bool _loading = true;
  String? _error;

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
      final results = await Future.wait([
        _manage.fetchCronTasks(),
        _sessions.fetchDirectories(),
      ]);
      if (!mounted) return;
      setState(() {
        _tasks = results[0] as List<CronTask>;
        _dirs = results[1] as List<Directory>;
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

  Future<void> _toggle(CronTask t) async {
    try {
      await _manage.updateCronTask(t.id, enabled: !t.enabled);
      await _refresh();
    } catch (e) {
      _snack('操作失败：$e');
    }
  }

  Future<void> _runNow(CronTask t) async {
    try {
      final r = await _manage.runCronTask(t.id);
      _snack(r['ok'] == true
          ? '已触发：${t.name}${r['sessionId'] != null ? ' → 会话已启动' : ''}'
          : '触发失败：${r['error'] ?? '未知错误'}');
      await _refresh();
    } catch (e) {
      _snack('触发失败：$e');
    }
  }

  Future<void> _delete(CronTask t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除定时任务'),
        content: Text('确定删除「${t.name}」？此操作不可撤销。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted))),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('删除', style: TextStyle(color: AppColors.danger))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _manage.deleteCronTask(t.id);
      await _refresh();
    } catch (e) {
      _snack('删除失败：$e');
    }
  }

  Future<void> _openEditor({CronTask? task}) async {
    if (_dirs.isEmpty) {
      _snack('请先在 App 首页创建至少一个Fleet');
      return;
    }
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _CronEditor(
        manage: _manage,
        dirs: _dirs,
        task: task,
      ),
    );
    if (saved == true) await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('定时任务'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openEditor(),
        backgroundColor: AppColors.accentDark,
        foregroundColor: const Color(0xFF04110f),
        icon: const Icon(Icons.add_alarm_rounded),
        label: const Text('新建'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : RefreshIndicator(
                  color: AppColors.accent,
                  backgroundColor: AppColors.panel,
                  onRefresh: _refresh,
                  child: _tasks.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 120),
                          _EmptyView(
                            icon: Icons.alarm_off_rounded,
                            title: '暂无定时任务',
                            subtitle: '点右下角「新建」，到点会自动唤起Fleet里的会话执行你写的指令。',
                          ),
                        ])
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                          itemCount: _tasks.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 10),
                          itemBuilder: (_, i) => _CronCard(
                            task: _tasks[i],
                            onToggle: () => _toggle(_tasks[i]),
                            onRun: () => _runNow(_tasks[i]),
                            onEdit: () => _openEditor(task: _tasks[i]),
                            onDelete: () => _delete(_tasks[i]),
                          ),
                        ),
                ),
    );
  }
}

// ── Cron card ────────────────────────────────────────────────────────────────

String _fmtTs(int? ms) {
  if (ms == null) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.month}/${d.day} ${two(d.hour)}:${two(d.minute)}';
}

class _CronCard extends StatelessWidget {
  final CronTask task;
  final VoidCallback onToggle;
  final VoidCallback onRun;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  const _CronCard({
    required this.task,
    required this.onToggle,
    required this.onRun,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final statusColor = task.lastStatus == 'ok'
        ? AppColors.codex
        : (task.lastStatus == null ? AppColors.faint : AppColors.danger);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: task.enabled ? AppColors.line : AppColors.line.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  task.name,
                  style: TextStyle(
                    color: task.enabled ? AppColors.textBright : AppColors.muted,
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Switch(value: task.enabled, onChanged: (_) => onToggle()),
            ],
          ),
          const SizedBox(height: 2),
          Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            _Chip(icon: Icons.folder_outlined, text: task.dirName),
            _Chip(icon: Icons.schedule_rounded, text: task.cron, mono: true),
            _Chip(icon: Icons.terminal_rounded, text: task.cli),
          ]),
          const SizedBox(height: 8),
          Text(
            task.prompt,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5, height: 1.4),
          ),
          const SizedBox(height: 8),
          Row(children: [
            Icon(Icons.circle, size: 8, color: statusColor),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                '下次 ${_fmtTs(task.nextRunAt)} · 上次 ${_fmtTs(task.lastRunAt)} · 已运行 ${task.runCount} 次'
                '${task.lastError.isNotEmpty ? ' · ${task.lastError}' : ''}',
                style: const TextStyle(color: AppColors.faint, fontSize: 11),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ]),
          const Divider(height: 18, color: AppColors.line),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: onRun,
                icon: const Icon(Icons.play_arrow_rounded, size: 18, color: AppColors.accent),
                label: const Text('立即运行', style: TextStyle(color: AppColors.accent, fontSize: 13)),
              ),
              TextButton.icon(
                onPressed: onEdit,
                icon: const Icon(Icons.edit_outlined, size: 17, color: AppColors.blue),
                label: const Text('编辑', style: TextStyle(color: AppColors.blue, fontSize: 13)),
              ),
              IconButton(
                onPressed: onDelete,
                icon: const Icon(Icons.delete_outline_rounded, size: 19, color: AppColors.danger),
                tooltip: '删除',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final IconData icon;
  final String text;
  final bool mono;
  const _Chip({required this.icon, required this.text, this.mono = false});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: AppColors.panel2,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: AppColors.line),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 12, color: AppColors.faint),
        const SizedBox(width: 4),
        Text(text,
            style: TextStyle(
              color: AppColors.muted,
              fontSize: 11.5,
              fontFamily: mono ? 'monospace' : null,
            )),
      ]),
    );
  }
}

// ── Editor bottom sheet ──────────────────────────────────────────────────────

class _CronEditor extends StatefulWidget {
  final ManageService manage;
  final List<Directory> dirs;
  final CronTask? task;
  const _CronEditor({required this.manage, required this.dirs, this.task});

  @override
  State<_CronEditor> createState() => _CronEditorState();
}

class _CronEditorState extends State<_CronEditor> {
  late final TextEditingController _name;
  late final TextEditingController _cron;
  late final TextEditingController _prompt;
  late String _dirId;
  late String _cli;
  bool _saving = false;
  String? _err;

  static const _presets = <MapEntry<String, String>>[
    MapEntry('0 9 * * *', '每天 9:00'),
    MapEntry('0 * * * *', '每小时'),
    MapEntry('*/30 * * * *', '每 30 分钟'),
    MapEntry('0 9 * * 1', '每周一 9:00'),
    MapEntry('0 9 1 * *', '每月 1 号 9:00'),
  ];

  @override
  void initState() {
    super.initState();
    final t = widget.task;
    _name = TextEditingController(text: t?.name ?? '');
    _cron = TextEditingController(text: t?.cron ?? '0 9 * * *');
    _prompt = TextEditingController(text: t?.prompt ?? '');
    _cli = t?.cli ?? 'claude';
    // Default to the task's dir if it still exists, else the first directory.
    final ids = widget.dirs.map((d) => d.id).toSet();
    _dirId = (t != null && ids.contains(t.dirId)) ? t.dirId : widget.dirs.first.id;
  }

  @override
  void dispose() {
    _name.dispose();
    _cron.dispose();
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final cron = _cron.text.trim();
    final prompt = _prompt.text.trim();
    if (name.isEmpty) return setState(() => _err = '任务名不能为空');
    if (prompt.isEmpty) return setState(() => _err = 'prompt 不能为空');
    if (cron.split(RegExp(r'\s+')).length != 5) {
      return setState(() => _err = 'cron 需 5 段（分 时 日 月 周）');
    }
    setState(() {
      _saving = true;
      _err = null;
    });
    try {
      if (widget.task == null) {
        await widget.manage.createCronTask(
            name: name, dirId: _dirId, prompt: prompt, cron: cron, cli: _cli);
      } else {
        await widget.manage.updateCronTask(widget.task!.id,
            name: name, dirId: _dirId, prompt: prompt, cron: cron, cli: _cli);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _err = '$e';
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                    color: AppColors.line, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            Text(widget.task == null ? '新建定时任务' : '编辑定时任务',
                style: const TextStyle(
                    color: AppColors.textBright, fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            const _FieldLabel('任务名'),
            _input(_name, hint: '例如：每天早报'),
            const SizedBox(height: 14),
            const _FieldLabel('目标Fleet'),
            Container(
              decoration: BoxDecoration(
                color: AppColors.panel2,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.line),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _dirId,
                  isExpanded: true,
                  dropdownColor: AppColors.panel2,
                  style: const TextStyle(color: AppColors.text, fontSize: 14),
                  items: widget.dirs
                      .map((d) => DropdownMenuItem(value: d.id, child: Text(d.name)))
                      .toList(),
                  onChanged: (v) => setState(() => _dirId = v ?? _dirId),
                ),
              ),
            ),
            const SizedBox(height: 14),
            const _FieldLabel('CLI'),
            Row(children: [
              _cliChoice('claude', 'Claude'),
              const SizedBox(width: 8),
              _cliChoice('codex', 'Codex'),
            ]),
            const SizedBox(height: 14),
            const _FieldLabel('cron 表达式（分 时 日 月 周）'),
            _input(_cron, mono: true, hint: '0 9 * * *'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: _presets
                  .map((p) => ActionChip(
                        label: Text(p.value, style: const TextStyle(fontSize: 11.5)),
                        backgroundColor: AppColors.panel2,
                        side: const BorderSide(color: AppColors.line),
                        labelStyle: const TextStyle(color: AppColors.muted),
                        onPressed: () => setState(() => _cron.text = p.key),
                      ))
                  .toList(),
            ),
            const SizedBox(height: 14),
            const _FieldLabel('到点执行的指令 (prompt)'),
            _input(_prompt, hint: '完整指令，到点会原样发给会话', maxLines: 5),
            if (_err != null) ...[
              const SizedBox(height: 10),
              Text(_err!, style: const TextStyle(color: AppColors.danger, fontSize: 12.5)),
            ],
            const SizedBox(height: 18),
            SizedBox(
              height: 48,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Color(0xFF04110f)))
                    : Text(widget.task == null ? '创建' : '保存'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _cliChoice(String value, String label) {
    final sel = _cli == value;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() => _cli = value),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: sel ? AppColors.accentDark.withValues(alpha: 0.18) : AppColors.panel2,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: sel ? AppColors.accent : AppColors.line),
          ),
          child: Text(label,
              style: TextStyle(
                  color: sel ? AppColors.accent : AppColors.muted,
                  fontWeight: FontWeight.w600,
                  fontSize: 13.5)),
        ),
      ),
    );
  }

  Widget _input(TextEditingController c,
      {String? hint, int maxLines = 1, bool mono = false}) {
    return TextField(
      controller: c,
      maxLines: maxLines,
      style: TextStyle(
          color: AppColors.text, fontSize: 14, fontFamily: mono ? 'monospace' : null),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.faint, fontSize: 13),
        filled: true,
        fillColor: AppColors.panel2,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: AppColors.line)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: AppColors.accent)),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6, left: 2),
        child: Text(text,
            style: const TextStyle(
                color: AppColors.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
      );
}

// ── Shared small views ───────────────────────────────────────────────────────

class _EmptyView extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _EmptyView(
      {required this.icon, required this.title, required this.subtitle});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            children: [
              Icon(icon, size: 46, color: AppColors.faint),
              const SizedBox(height: 14),
              Text(title,
                  style: const TextStyle(
                      color: AppColors.muted, fontSize: 15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Text(subtitle,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.faint, fontSize: 12.5, height: 1.5)),
            ],
          ),
        ),
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
