import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// Directory-first Air entry backed by the same canonical API as the Web UI.
/// Opening a task uses the existing native chat transport and answer controls.
class AirTasksView extends StatefulWidget {
  final SettingsService settings;
  final http.Client? httpClient;
  const AirTasksView({super.key, required this.settings, this.httpClient});
  @override
  State<AirTasksView> createState() => _AirTasksViewState();
}

class _AirTasksViewState extends State<AirTasksView>
    with WidgetsBindingObserver {
  late final http.Client _http = widget.httpClient ?? http.Client();
  Map<String, dynamic>? _data;
  String? _directory;
  String _query = '', _error = '';
  bool _loading = false, _opening = false, _foreground = true, _all = false;
  Timer? _timer;

  /// Local shorthands for the two inks this view uses everywhere; both are
  /// [AppColors] entries so the palette keeps a single source.
  static const _ink = AppColors.text, _blue = AppColors.accent;
  List<Map<String, dynamic>> _rows(String key) => ((_data?[key] as List?) ?? [])
      .map((v) => Map<String, dynamic>.from(v as Map))
      .toList();
  Future<Map<String, dynamic>> _request(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final uri = Uri.parse(widget.settings.buildHttpUrl(path));
    final headers = {
      'Content-Type': 'application/json',
      'X-Access-Token': widget.settings.token,
    };
    final response =
        await (body == null
                ? _http.get(uri, headers: headers)
                : _http.post(uri, headers: headers, body: jsonEncode(body)))
            .timeout(const Duration(seconds: 30));
    final result = Map<String, dynamic>.from(
      jsonDecode(utf8.decode(response.bodyBytes)) as Map,
    );
    if (response.statusCode != 200 || result['ok'] == false) {
      throw Exception(
        result['message'] ?? result['code'] ?? 'HTTP ${response.statusCode}',
      );
    }
    return result;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 4), (_) {
      if (_foreground) _refresh();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) _refresh();
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (widget.httpClient == null) _http.close();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final result = await _request('/api/air');
      if (!mounted) return;
      setState(() {
        _data = result;
        _error = '';
        final dirs = _rows('directories');
        if (!dirs.any((d) => d['id'] == _directory)) {
          _directory = dirs.isEmpty ? null : dirs.first['id'] as String;
        }
      });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _loading = false;
    }
  }

  Future<void> _open(Map<String, dynamic> task) async {
    if (_opening) return;
    _opening = true;
    try {
      final entry = await _request(
        '/api/air/tasks/${Uri.encodeComponent(task['id'] as String)}',
      );
      if (!mounted) return;
      // Read-only conversation tasks must be continued in their original shell.
      final id =
          (entry['readOnly'] == true
                  ? entry['sourceSessionId']
                  : entry['sessionId'])
              as String?;
      if (id == null) throw Exception('此任务没有可续接的会话，请从全部记录查看。');
      final mgr = context.read<SessionManager>();
      final loaded = mgr.sessions.where((s) => s.id == id).firstOrNull;
      final session =
          loaded ??
          await SessionService(
            settings: widget.settings,
          ).fetchTaskBoundSession(id);
      if (!mounted) return;
      if (session == null) throw Exception('无法打开任务会话，请刷新后重试。');
      mgr.openSession(session, historyArchive: true);
      mgr.switchToSession(session.id);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _opening = false;
    }
  }

  Future<void> _create() async {
    if (_directory == null) return;
    final dirId = _directory!;
    final title = TextEditingController(), role = TextEditingController();
    final clis = ((_data?['clis'] as List?) ?? ['claude']).cast<String>();
    String cli = clis.first, error = '';
    bool saving = false;
    final requestId = 'app-air-${DateTime.now().microsecondsSinceEpoch}';
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, update) => AlertDialog(
          backgroundColor: AppColors.panel,
          title: const Text('新任务', style: TextStyle(color: _ink)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: title,
                  autofocus: true,
                  maxLength: 120,
                  style: const TextStyle(color: _ink),
                  decoration: const InputDecoration(labelText: '任务名称'),
                ),
                DropdownButtonFormField<String>(
                  value: cli,
                  dropdownColor: AppColors.panel,
                  style: const TextStyle(color: _ink),
                  items: clis
                      .map((v) => DropdownMenuItem(value: v, child: Text(v)))
                      .toList(),
                  onChanged: saving ? null : (v) => update(() => cli = v!),
                  decoration: const InputDecoration(labelText: 'AI 工具'),
                ),
                TextField(
                  controller: role,
                  maxLines: 3,
                  maxLength: 40000,
                  style: const TextStyle(color: _ink),
                  decoration: const InputDecoration(labelText: '角色上下文（可选）'),
                ),
                if (error.isNotEmpty)
                  Text(error, style: const TextStyle(color: AppColors.danger)),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (title.text.trim().isEmpty) {
                        update(() => error = '请填写任务名称');
                        return;
                      }
                      update(() {
                        saving = true;
                        error = '';
                      });
                      try {
                        final created = await _request('/api/air/tasks', {
                          'dirId': dirId,
                          'title': title.text.trim(),
                          'cli': cli,
                          'rolePrompt': role.text.trim(),
                          'clientMsgId': requestId,
                        });
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx);
                        await _refresh();
                        if (mounted) await _open({'id': created['taskId']});
                      } catch (e) {
                        if (ctx.mounted) {
                          update(() {
                            error = e.toString();
                            saving = false;
                          });
                        }
                      }
                    },
              child: Text(saving ? '正在创建…' : '创建任务'),
            ),
          ],
        ),
      ),
    );
    title.dispose();
    role.dispose();
  }

  String _resource(Map task) {
    final resource = task['resource'] as Map? ?? {};
    return switch (resource['lease']) {
      'running' => '执行中',
      'starting' => '正在启动',
      'reserved' || 'materializing' => '正在准备',
      'uncertain' => '等待核实执行状态',
      _ => resource['residency'] == 'planned' ? '执行时准备目录' : '目录已保留',
    };
  }

  @override
  Widget build(BuildContext context) {
    final dirs = _rows('directories');
    final tasks = _rows('tasks')
        .where(
          (t) =>
              t['dirId'] == _directory &&
              (_all || !['done', 'archived'].contains(t['status'])) &&
              '${t['title']}'.toLowerCase().contains(_query.toLowerCase()),
        )
        .toList();
    // Derive from the ambient theme and pin the accent, rather than seeding a
    // fresh scheme: `ColorScheme.fromSeed` answers with a *tonal* primary
    // (#415F91 for this seed), which is what every default-styled widget in
    // this subtree — the 新任务 button, the 全部记录 switch, the spinner — would
    // then paint instead of the Air accent.
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        colorScheme: theme.colorScheme.copyWith(
          primary: _blue,
          onPrimary: AppColors.onAccent,
          secondary: _blue,
        ),
      ),
      child: ColoredBox(
        color: AppColors.bg,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const Text(
                '工作目录',
                style: TextStyle(color: AppColors.muted, fontSize: 12),
              ),
              if (dirs.isNotEmpty)
                DropdownButton<String>(
                  value: _directory,
                  isExpanded: true,
                  dropdownColor: AppColors.panel,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                  items: dirs
                      .map(
                        (d) => DropdownMenuItem(
                          value: d['id'] as String,
                          child: Text(
                            '${d['name']}',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (v) => setState(() => _directory = v),
                ),
              Text(
                '${dirs.where((d) => d['id'] == _directory).firstOrNull?['path'] ?? '通过右上角添加工作目录'}',
                style: const TextStyle(color: AppColors.muted, fontSize: 12),
              ),
              const SizedBox(height: 22),
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      '你的任务',
                      style: TextStyle(
                        color: _ink,
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  FilledButton.icon(
                    onPressed: _directory == null ? null : _create,
                    icon: const Icon(Icons.add),
                    label: const Text('新任务'),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              TextField(
                onChanged: (v) => setState(() => _query = v),
                style: const TextStyle(color: _ink),
                decoration: const InputDecoration(
                  hintText: '搜索任务',
                  prefixIcon: Icon(Icons.search),
                  filled: true,
                  fillColor: AppColors.panel,
                  border: OutlineInputBorder(
                    borderSide: BorderSide.none,
                    borderRadius: BorderRadius.all(Radius.circular(14)),
                  ),
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text(
                  '全部记录',
                  style: TextStyle(color: _ink, fontSize: 13),
                ),
                value: _all,
                onChanged: (v) => setState(() => _all = v),
              ),
              if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(
                    _error,
                    style: const TextStyle(color: AppColors.danger),
                  ),
                ),
              if (_data == null && _error.isEmpty)
                const Center(child: CircularProgressIndicator()),
              for (final task in tasks)
                Card(
                  color: AppColors.panel,
                  elevation: 0,
                  margin: const EdgeInsets.only(bottom: 10),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 9,
                    ),
                    leading: const Icon(
                      Icons.chat_bubble_outline_rounded,
                      color: _blue,
                    ),
                    title: Text(
                      '${task['title']}',
                      style: const TextStyle(
                        color: _ink,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    subtitle: Text(
                      _resource(task),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 12,
                      ),
                    ),
                    trailing: const Icon(Icons.chevron_right, color: _blue),
                    onTap: () => _open(task),
                  ),
                ),
              if (_data != null && tasks.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(28),
                  child: Text(
                    '从一个目标开始。\n创建任务后，工作目录会在首次执行时准备。',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.muted, height: 1.8),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
