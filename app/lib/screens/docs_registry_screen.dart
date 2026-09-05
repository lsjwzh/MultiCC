import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../models/docs_registry_entry.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 服务与文档 (Docs & web-services registry)。镜像网页管理台 /manage 的同名
/// 面板：agent 发布的网页/文件（7 天清理，置顶豁免）+ 手动登记的本地 Web
/// 服务（探活状态、启停、日志）。后端契约见 src/docs-registry.js。
class DocsRegistryScreen extends StatefulWidget {
  final SettingsService settings;

  /// Tests inject a MockClient; production leaves it null.
  final http.Client? httpClient;
  const DocsRegistryScreen({super.key, required this.settings, this.httpClient});

  @override
  State<DocsRegistryScreen> createState() => _DocsRegistryScreenState();
}

class _DocsRegistryScreenState extends State<DocsRegistryScreen> {
  late final ManageService _manage = ManageService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  List<DocsRegistryEntry> _entries = [];
  bool _loading = true;
  String? _error;

  /// Ids with an in-flight action (start/stop/log) — their buttons disable.
  final Set<String> _busyIds = {};

  Timer? _poll;
  bool _inflight = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    // 服务状态是活的：页面在栈顶时每 5s 静默重拉（服务端 30s TCP 探活的
    // 读取端），与 web 面板「可见才拉」一致。
    _poll = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted) return;
      if (ModalRoute.of(context)?.isCurrent == false) return;
      _refresh(silent: true);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _refresh({bool silent = false}) async {
    if (_inflight) return;
    _inflight = true;
    if (!silent) {
      setState(() {
        // Only spin on first load — later manual refreshes keep the list.
        _loading = _entries.isEmpty;
        _error = null;
      });
    }
    try {
      final entries = await _manage.fetchDocsRegistry();
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        // 静默轮询失败且手里已有数据：保留列表，不打断用户。
        if (!silent || _entries.isEmpty) _error = '$e';
      });
    } finally {
      _inflight = false;
    }
  }

  void _snack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? AppColors.danger : null,
      ),
    );
  }

  /// 打开条目。相对路径（/docs/…、/artifacts/…）拼到当前服务器 origin 并附
  /// token（同源凭据安全）；绝对 http(s) URL 原样打开，绝不附带 token，
  /// 避免把服务器凭据泄露给第三方 host。
  Future<void> _open(DocsRegistryEntry e) async {
    Uri uri;
    if (e.url.startsWith('http://') || e.url.startsWith('https://')) {
      uri = Uri.parse(e.url);
    } else {
      final token = widget.settings.token.trim();
      uri = Uri.parse(widget.settings.buildHttpUrl(e.url)).replace(
        queryParameters: {
          ...?Uri.tryParse(e.url)?.queryParameters,
          if (token.isNotEmpty) 'token': token,
        },
      );
    }
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok) _snack(t('openBrowserFailed'), isError: true);
    } catch (_) {
      _snack(t('openBrowserFailed'), isError: true);
    }
  }

  Future<void> _togglePin(DocsRegistryEntry e) async {
    try {
      await _manage.updateDocsEntry(e.id, pinned: !e.pinned);
      await _refresh(silent: true);
    } catch (err) {
      _snack('$err', isError: true);
    }
  }

  Future<void> _delete(DocsRegistryEntry e) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(t('delete')),
        content: Text(t('docsregConfirmDelete', {'title': e.title})),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('cancel'), style: const TextStyle(color: AppColors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('delete'), style: const TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _manage.deleteDocsEntry(e.id);
      _snack(t('docsregDeleted'));
      await _refresh(silent: true);
    } catch (err) {
      _snack('$err', isError: true);
    }
  }

  Future<void> _svcAction(DocsRegistryEntry e, String action) async {
    setState(() => _busyIds.add(e.id));
    try {
      if (action == 'start') {
        await _manage.startDocsService(e.id);
        _snack(t('docsregStarted'));
      } else {
        await _manage.stopDocsService(e.id);
        _snack(t('docsregStopped'));
      }
    } catch (err) {
      _snack('$err', isError: true);
    } finally {
      if (mounted) setState(() => _busyIds.remove(e.id));
      await _refresh(silent: true);
    }
  }

  Future<void> _showLog(DocsRegistryEntry e) async {
    setState(() => _busyIds.add(e.id));
    String log;
    try {
      log = await _manage.fetchDocsServiceLog(e.id);
    } catch (err) {
      _snack('$err', isError: true);
      if (mounted) setState(() => _busyIds.remove(e.id));
      return;
    }
    if (!mounted) return;
    setState(() => _busyIds.remove(e.id));
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(
          '${e.title} · ${t('docsregLog')}',
          style: const TextStyle(fontSize: 15),
        ),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: SelectableText(
              log.isEmpty ? '(no log yet)' : log,
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 12,
                fontFamily: 'monospace',
                height: 1.45,
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('close')),
          ),
        ],
      ),
    );
  }

  Future<void> _openAddSheet() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => _AddServiceSheet(manage: _manage),
    );
    if (saved == true) {
      _snack(t('docsregAdded'));
      await _refresh(silent: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: Text(t('docsServices')),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            tooltip: t('refresh'),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openAddSheet,
        backgroundColor: AppColors.accentDark,
        foregroundColor: const Color(0xFF04110f),
        icon: const Icon(Icons.playlist_add_rounded),
        label: Text(t('docsregAddService')),
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.accent),
            )
          : _error != null
          ? _ErrorView(message: _error!, onRetry: () => _refresh())
          : RefreshIndicator(
              color: AppColors.accent,
              backgroundColor: AppColors.panel,
              onRefresh: () => _refresh(),
              child: _entries.isEmpty
                  ? ListView(
                      children: const [
                        SizedBox(height: 120),
                        _EmptyView(icon: Icons.travel_explore_outlined),
                      ],
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                      itemCount: _entries.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 10),
                      itemBuilder: (_, i) {
                        final e = _entries[i];
                        return _DocsEntryCard(
                          entry: e,
                          busy: _busyIds.contains(e.id),
                          onOpen: () => _open(e),
                          onTogglePin: () => _togglePin(e),
                          onDelete: () => _delete(e),
                          onSvcAction: (action) => _svcAction(e, action),
                          onLog: () => _showLog(e),
                        );
                      },
                    ),
            ),
    );
  }
}

// ── Entry card ───────────────────────────────────────────────────────────────

String _fmtTs(String iso) {
  if (iso.isEmpty) return '';
  final d = DateTime.tryParse(iso)?.toLocal();
  if (d == null) return iso;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(d.month)}/${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
}

Color? _statusColor(String? status) => switch (status) {
  'up' => AppColors.codex,
  'down' => AppColors.faint,
  'starting' => AppColors.amber,
  _ => AppColors.muted,
};

IconData _kindIcon(String kind) => switch (kind) {
  'file' => Icons.attach_file_rounded,
  'service' => Icons.language_rounded,
  _ => Icons.description_outlined,
};

class _DocsEntryCard extends StatelessWidget {
  final DocsRegistryEntry entry;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback onTogglePin;
  final VoidCallback onDelete;
  final ValueChanged<String> onSvcAction;
  final VoidCallback onLog;

  const _DocsEntryCard({
    required this.entry,
    required this.busy,
    required this.onOpen,
    required this.onTogglePin,
    required this.onDelete,
    required this.onSvcAction,
    required this.onLog,
  });

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final card = Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(_kindIcon(e.kind), size: 18, color: AppColors.muted),
              if (e.isService) ...[
                const SizedBox(width: 8),
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _statusColor(e.status),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  t('docsregStatus_${e.status ?? 'unknown'}'),
                  style: TextStyle(
                    color: _statusColor(e.status),
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
              const SizedBox(width: 8),
              Expanded(
                child: InkWell(
                  onTap: onOpen,
                  borderRadius: BorderRadius.circular(6),
                  child: Row(
                    children: [
                      Flexible(
                        child: Text(
                          e.title,
                          style: const TextStyle(
                            color: AppColors.blue,
                            decoration: TextDecoration.underline,
                            decorationColor: AppColors.lineStrong,
                            fontSize: 14.5,
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(
                        Icons.open_in_new_rounded,
                        size: 13,
                        color: AppColors.faint,
                      ),
                    ],
                  ),
                ),
              ),
              if (e.pinned)
                const Padding(
                  padding: EdgeInsets.only(left: 6),
                  child: Icon(
                    Icons.push_pin_rounded,
                    size: 13,
                    color: AppColors.amber,
                  ),
                ),
              if (e.expired)
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    border: Border.all(color: AppColors.amber.withValues(alpha: 0.4)),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    t('docsregExpired'),
                    style: const TextStyle(color: AppColors.amber, fontSize: 10.5),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            [
              e.url,
              if (e.isService && e.port != null) ':${e.port}',
              if (e.sessionId.isNotEmpty) e.sessionId,
              _fmtTs(e.createdAt),
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: AppColors.faint,
              fontSize: 11,
              fontFamily: 'monospace',
            ),
          ),
          const Divider(height: 14, color: AppColors.line),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              if (e.isService) ...[
                TextButton.icon(
                  onPressed: busy ? null : onLog,
                  icon: const Icon(
                    Icons.article_outlined,
                    size: 16,
                    color: AppColors.muted,
                  ),
                  label: Text(
                    t('docsregLog'),
                    style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
                  ),
                ),
                if (e.canStop)
                  TextButton.icon(
                    onPressed: busy ? null : () => onSvcAction('stop'),
                    icon: const Icon(
                      Icons.stop_circle_outlined,
                      size: 17,
                      color: AppColors.danger,
                    ),
                    label: Text(
                      t('docsregStop'),
                      style: const TextStyle(color: AppColors.danger, fontSize: 12.5),
                    ),
                  )
                else
                  TextButton.icon(
                    // 无 startCmd 的服务无法从面板启动：按钮保留但禁用，
                    // tooltip 说明原因（与 web 一致）。
                    onPressed: (busy || !e.canStart) ? null : () => onSvcAction('start'),
                    icon: Icon(
                      Icons.play_arrow_rounded,
                      size: 18,
                      color: e.canStart ? AppColors.codex : AppColors.faint,
                    ),
                    label: Text(
                      t('docsregStart'),
                      style: TextStyle(
                        color: e.canStart ? AppColors.codex : AppColors.faint,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
              ],
              IconButton(
                onPressed: onTogglePin,
                icon: Icon(
                  e.pinned ? Icons.push_pin_rounded : Icons.push_pin_outlined,
                  size: 17,
                  color: e.pinned ? AppColors.amber : AppColors.muted,
                ),
                tooltip: t(e.pinned ? 'docsregUnpin' : 'docsregPin'),
              ),
              IconButton(
                onPressed: onDelete,
                icon: const Icon(
                  Icons.delete_outline_rounded,
                  size: 18,
                  color: AppColors.danger,
                ),
                tooltip: t('delete'),
              ),
            ],
          ),
        ],
      ),
    );
    // 已过期的 artifact 登记整卡降透明度（内容已清理，仅剩登记）。
    return e.expired ? Opacity(opacity: 0.55, child: card) : card;
  }
}

// ── Add-service bottom sheet ─────────────────────────────────────────────────

class _AddServiceSheet extends StatefulWidget {
  final ManageService manage;
  const _AddServiceSheet({required this.manage});

  @override
  State<_AddServiceSheet> createState() => _AddServiceSheetState();
}

class _AddServiceSheetState extends State<_AddServiceSheet> {
  late final TextEditingController _title;
  late final TextEditingController _url;
  late final TextEditingController _startCmd;
  late final TextEditingController _cwd;
  bool _saving = false;
  String? _err;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController();
    _url = TextEditingController();
    _startCmd = TextEditingController();
    _cwd = TextEditingController();
  }

  @override
  void dispose() {
    _title.dispose();
    _url.dispose();
    _startCmd.dispose();
    _cwd.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final title = _title.text.trim();
    final url = _url.text.trim();
    if (title.isEmpty) return setState(() => _err = t('docsregAddTitle'));
    final urlOk = url.startsWith('/') ||
        url.startsWith('http://') ||
        url.startsWith('https://');
    if (!urlOk) return setState(() => _err = t('docsregAddUrl'));
    setState(() {
      _saving = true;
      _err = null;
    });
    try {
      await widget.manage.registerDocsService(
        title: title,
        url: url,
        startCmd: _startCmd.text,
        cwd: _cwd.text,
      );
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
                  color: AppColors.line,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              t('docsregAddService'),
              style: const TextStyle(
                color: AppColors.textBright,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 16),
            _FieldLabel(t('docsregAddTitle')),
            _input(_title),
            const SizedBox(height: 14),
            _FieldLabel(t('docsregAddUrl')),
            _input(_url, mono: true),
            const SizedBox(height: 14),
            _FieldLabel(t('docsregAddCmd')),
            _input(_startCmd, mono: true),
            const SizedBox(height: 14),
            _FieldLabel(t('docsregAddCwd')),
            _input(_cwd, mono: true),
            if (_err != null) ...[
              const SizedBox(height: 10),
              Text(
                _err!,
                style: const TextStyle(color: AppColors.danger, fontSize: 12.5),
              ),
            ],
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: SizedBox(
                    height: 46,
                    child: OutlinedButton(
                      onPressed: _saving ? null : () => Navigator.pop(context),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: AppColors.lineStrong),
                      ),
                      child: Text(
                        t('cancel'),
                        style: const TextStyle(color: AppColors.muted),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: SizedBox(
                    height: 46,
                    child: ElevatedButton(
                      onPressed: _saving ? null : _save,
                      child: _saving
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Color(0xFF04110f),
                              ),
                            )
                          : Text(t('add')),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _input(TextEditingController c, {bool mono = false}) => TextField(
    controller: c,
    style: TextStyle(
      color: AppColors.text,
      fontSize: 14,
      fontFamily: mono ? 'monospace' : null,
    ),
    decoration: sheetInputDecoration(hint: ''),
  );
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6, left: 2),
    child: Text(
      text,
      style: const TextStyle(
        color: AppColors.muted,
        fontSize: 12,
        fontWeight: FontWeight.w500,
      ),
    ),
  );
}

// ── Shared small views ───────────────────────────────────────────────────────

class _EmptyView extends StatelessWidget {
  final IconData icon;
  const _EmptyView({required this.icon});
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 40),
      child: Column(
        children: [
          Icon(icon, size: 46, color: AppColors.faint),
          const SizedBox(height: 14),
          Text(
            t('docsregEmpty'),
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: AppColors.muted,
              fontSize: 12.5,
              height: 1.6,
            ),
          ),
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
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: AppColors.muted,
              fontSize: 13,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: onRetry,
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.lineStrong),
            ),
            child: Text(t('retry'), style: const TextStyle(color: AppColors.accent)),
          ),
        ],
      ),
    ),
  );
}
