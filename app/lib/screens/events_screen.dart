import 'package:flutter/material.dart';

import '../models/message.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 活动记录 — 镜像网页 events.html：选定一个目录，展示该目录最近的活动事件
/// 流（会话完成 / 合并 / 推送 / 角色变更 等）。只读。
class EventsScreen extends StatefulWidget {
  final SettingsService settings;
  const EventsScreen({super.key, required this.settings});

  @override
  State<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends State<EventsScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);
  late final SessionService _sessions = SessionService(settings: widget.settings);

  List<Directory> _dirs = [];
  String? _dirId;
  List<Map<String, dynamic>> _events = [];
  bool _loading = true;
  bool _loadingDirs = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadDirs();
  }

  Future<void> _loadDirs() async {
    try {
      _dirs = await _sessions.fetchDirectories();
      if (!mounted) return;
      setState(() {
        _dirId = _dirs.isEmpty ? null : _dirs.first.id;
        _loadingDirs = false;
      });
      if (_dirId != null) _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loadingDirs = false;
        _loading = false;
      });
    }
  }

  Future<void> _refresh() async {
    if (_dirId == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final evs = await _manage.fetchDirectoryEvents(_dirId!);
      if (!mounted) return;
      setState(() {
        _events = evs;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('活动记录'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _refresh,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loadingDirs
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                _dirPicker(),
                Expanded(
                  child: _loading
                      ? const Center(child: CircularProgressIndicator())
                      : _error != null
                          ? _ErrorView(error: _error!, onRetry: _refresh)
                          : _events.isEmpty
                              ? const _EmptyView()
                              : RefreshIndicator(
                                  onRefresh: _refresh,
                                  child: ListView.builder(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 12, vertical: 8),
                                    itemCount: _events.length,
                                    itemBuilder: (_, i) => _eventTile(_events[i]),
                                  ),
                                ),
                ),
              ],
            ),
    );
  }

  Widget _dirPicker() {
    if (_dirs.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(12),
        child: Text('还没有Fleet。先在主界面添加一个项目Fleet。',
            style: TextStyle(color: AppColors.muted, fontSize: 13)),
      );
    }
    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.line),
      ),
      child: DropdownButton<String>(
        value: _dirId,
        underline: const SizedBox(),
        isExpanded: true,
        dropdownColor: AppColors.panel2,
        style: const TextStyle(color: AppColors.text, fontSize: 14),
        items: _dirs
            .map((d) => DropdownMenuItem(
                  value: d.id,
                  child: Text(d.name,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                ))
            .toList(),
        onChanged: (v) {
          if (v == null || v == _dirId) return;
          setState(() => _dirId = v);
          _refresh();
        },
      ),
    );
  }

  Widget _eventTile(Map<String, dynamic> e) {
    final ts = e['ts'] as num?;
    final type = (e['type'] ?? '') as String;
    final detail = (e['detail'] ?? '') as String;
    final sessionLabel = (e['sessionLabel'] ?? '') as String;
    final time = ts == null
        ? ''
        : DateTime.fromMillisecondsSinceEpoch(ts.toInt()).toLocal().toString().substring(5, 19);
    final c = _typeColor(type);
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 3,
            height: 34,
            margin: const EdgeInsets.only(right: 10, top: 2),
            decoration: BoxDecoration(
                color: c, borderRadius: BorderRadius.circular(2)),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(type,
                        style: TextStyle(
                            color: c, fontSize: 12, fontWeight: FontWeight.w600)),
                    const Spacer(),
                    Text(time,
                        style: const TextStyle(color: AppColors.faint, fontSize: 11)),
                  ],
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(detail,
                      style: const TextStyle(color: AppColors.text, fontSize: 13)),
                ],
                if (sessionLabel.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(sessionLabel,
                      style: const TextStyle(color: AppColors.muted, fontSize: 11)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Color _typeColor(String type) {
    switch (type) {
      case 'completed':
      case 'synced':
      case 'pushed':
      case 'committed':
        return AppColors.accent;
      case 'error':
      case 'merge_conflict':
        return AppColors.danger;
      case 'session_role_changed':
      case 'session_created':
        return AppColors.blue;
      default:
        return AppColors.muted;
    }
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('该Fleet暂无活动记录',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
        ),
      );
}

class _ErrorView extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.danger, size: 40),
              const SizedBox(height: 12),
              Text('加载失败：$error',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13)),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('重试'),
              ),
            ],
          ),
        ),
      );
}
