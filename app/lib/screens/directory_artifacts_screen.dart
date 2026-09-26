import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../models/docs_registry_entry.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'docs_registry_screen.dart';

/// 「本目录产物」—— 目录首页那张目录卡上的产物按钮打开的页面：只列这个
/// 工作目录下 agent 发布过的网页/文件。
///
/// 为什么由目录卡自己 push（而不是像备忘那样从 `main_shell.dart` 接线回调）：
/// `DirectoryCardCallbacks` 的每个回调都要在 main_shell 里写一行构造，而
/// main_shell.dart 正好顶在源码行长闸的天花板上（3167 行 / 122298 字节，
/// 加一行就红）。这个页面只需要 view 上的 id / name / path，`Navigator`
/// 在目录卡自己的 BuildContext 里就能拿到，所以就地 push，把行长留给产品本身。
///
/// 与「服务与文档」页的分工：服务（kind == 'service'）留在那边（它们有探活、
/// 启停、日志，是按「服务」而不是按「目录」组织的东西），这里只列产物，
/// 并在页尾给一条去那边的入口。
///
/// 排序完全交给服务端（永久保留 → 置顶 → 最新，见 src/docs-registry.js 的
/// byRetention）；这里不重排，只把永久/置顶两个开关原样送回 PATCH。
class DirectoryArtifactsScreen extends StatefulWidget {
  /// Dashboard directory identity — currently only used as the widget key
  /// namespace; the wire scope is [dirPath].
  final String dirId;
  final String dirName;

  /// Absolute project directory — the `?dir=` scope. A task worktree path is
  /// normalized to the project it is of by the server, so a worktree artifact
  /// shows up under its project.
  final String dirPath;

  /// Tests inject settings + a MockClient; production leaves both null and the
  /// screen resolves the app-wide [SettingsService] singleton.
  final SettingsService? settings;
  final http.Client? httpClient;

  const DirectoryArtifactsScreen({
    super.key,
    required this.dirId,
    required this.dirName,
    required this.dirPath,
    this.settings,
    this.httpClient,
  });

  @override
  State<DirectoryArtifactsScreen> createState() =>
      _DirectoryArtifactsScreenState();
}

class _DirectoryArtifactsScreenState extends State<DirectoryArtifactsScreen> {
  SettingsService? _settings;
  ManageService? _manage;

  /// Last good list. A failed refresh keeps it and only adds [_error].
  List<DocsRegistryEntry> _entries = [];
  bool _loading = true;
  bool _inflight = false;
  String? _error;

  /// Ids with an in-flight toggle — their buttons disable.
  final Set<String> _busyIds = {};

  @override
  void initState() {
    super.initState();
    _boot();
  }

  /// 生产路径没有可注入的 settings（目录卡只知道自己是谁），所以走
  /// 应用级单例；测试注入就完全离线。
  Future<void> _boot() async {
    try {
      final settings = widget.settings ?? await SettingsService.getInstance();
      if (!mounted) return;
      setState(() {
        _settings = settings;
        _manage = ManageService(
          settings: settings,
          httpClient: widget.httpClient,
        );
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e';
        });
      }
      return;
    }
    await _refresh();
  }

  Future<void> _refresh({bool silent = false}) async {
    final manage = _manage;
    if (manage == null || _inflight) return;
    _inflight = true;
    if (!silent) {
      setState(() {
        _loading = _entries.isEmpty;
      });
    }
    try {
      final rows = await manage.fetchDocsRegistry(dir: widget.dirPath);
      if (!mounted) return;
      setState(() {
        // 服务留在「服务与文档」页：那边才有探活 / 启停 / 日志。
        _entries = rows.where((e) => !e.isService).toList();
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        // 拿不到新数据就把上一次的列表留着，只在顶上挂一行错误。
        _error = '$e';
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

  Future<void> _open(DocsRegistryEntry e) async {
    final settings = _settings;
    if (settings == null) return;
    final ok = await openDocsRegistryEntry(settings, e);
    if (!ok) _snack(t('openBrowserFailed'), isError: true);
  }

  /// 永久保留 —— 唯一的「永不被回收」承诺，与置顶独立。
  Future<void> _togglePermanent(DocsRegistryEntry e) async {
    final manage = _manage;
    if (manage == null) return;
    setState(() => _busyIds.add(e.id));
    try {
      await manage.updateDocsEntry(e.id, permanent: !e.permanent);
      _snack(t(e.permanent ? 'docsregPermanentOff' : 'docsregPermanentOn'));
      await _refresh(silent: true);
    } catch (err) {
      _snack('$err', isError: true);
    } finally {
      if (mounted) setState(() => _busyIds.remove(e.id));
    }
  }

  /// 置顶 —— 只影响排序，不承诺保留（与永久保留独立）。
  Future<void> _togglePin(DocsRegistryEntry e) async {
    final manage = _manage;
    if (manage == null) return;
    setState(() => _busyIds.add(e.id));
    try {
      await manage.updateDocsEntry(e.id, pinned: !e.pinned);
      await _refresh(silent: true);
    } catch (err) {
      _snack('$err', isError: true);
    } finally {
      if (mounted) setState(() => _busyIds.remove(e.id));
    }
  }

  /// 页尾那条去「服务与文档」的入口 —— 复用 App 里已有的那处导航形态
  /// （main_shell.dart / air_tasks_view.dart 都是 push 同一个 DocsRegistryScreen）。
  void _openDocsRegistry() {
    final settings = _settings;
    if (settings == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DocsRegistryScreen(settings: settings),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Text(t('airDirArtifacts')),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    widget.dirName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
            Text(
              t('airDirArtifactsHint'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: AppColors.faint,
                fontSize: 10.5,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            tooltip: t('refresh'),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.accent),
            )
          : Column(
              children: [
                if (_error != null)
                  _ErrorLine(message: _error!, onRetry: () => _refresh()),
                Expanded(
                  child: RefreshIndicator(
                    color: AppColors.accent,
                    backgroundColor: AppColors.panel,
                    onRefresh: () => _refresh(),
                    child: ListView(
                      // 空列表也要能下拉（RefreshIndicator 只在可滚动时响应）。
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 32),
                      children: [
                        if (_entries.isEmpty)
                          const _EmptyArtifacts()
                        else
                          for (final e in _entries)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _ArtifactRow(
                                entry: e,
                                busy: _busyIds.contains(e.id),
                                onOpen: () => _open(e),
                                onTogglePermanent: () => _togglePermanent(e),
                                onTogglePin: () => _togglePin(e),
                              ),
                            ),
                        const SizedBox(height: 6),
                        Center(
                          child: TextButton.icon(
                            onPressed: _openDocsRegistry,
                            icon: const Icon(
                              Icons.travel_explore_outlined,
                              size: 16,
                              color: AppColors.muted,
                            ),
                            label: Text(
                              t('docsServices'),
                              style: const TextStyle(
                                color: AppColors.muted,
                                fontSize: 12.5,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

// ── Row ──────────────────────────────────────────────────────────────────────

class _ArtifactRow extends StatelessWidget {
  final DocsRegistryEntry entry;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback onTogglePermanent;
  final VoidCallback onTogglePin;

  const _ArtifactRow({
    required this.entry,
    required this.busy,
    required this.onOpen,
    required this.onTogglePermanent,
    required this.onTogglePin,
  });

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final card = Container(
      padding: const EdgeInsets.all(12),
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
              Icon(docsEntryKindIcon(e.kind), size: 17, color: AppColors.muted),
              const SizedBox(width: 8),
              Expanded(
                child: InkWell(
                  key: ValueKey('dir-artifact-open-${e.id}'),
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
                            fontSize: 14,
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
              if (e.permanent)
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: AppColors.accent.withValues(alpha: 0.4),
                    ),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Text('🔒', style: TextStyle(fontSize: 10.5)),
                ),
              if (e.expired)
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: AppColors.amber.withValues(alpha: 0.4),
                    ),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    t('docsregExpired'),
                    style: const TextStyle(
                      color: AppColors.amber,
                      fontSize: 10.5,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            [
              e.url,
              if (e.sessionId.isNotEmpty) e.sessionId,
              docsEntryTimeLabel(e.createdAt),
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
              IconButton(
                key: ValueKey('dir-artifact-permanent-${e.id}'),
                onPressed: busy ? null : onTogglePermanent,
                icon: Icon(
                  e.permanent ? Icons.lock : Icons.lock_outline,
                  size: 17,
                  color: e.permanent ? AppColors.accent : AppColors.muted,
                ),
                tooltip: t(
                  e.permanent ? 'artifactKeepForeverOff' : 'artifactKeepForever',
                ),
              ),
              IconButton(
                key: ValueKey('dir-artifact-pin-${e.id}'),
                onPressed: busy ? null : onTogglePin,
                icon: Icon(
                  e.pinned ? Icons.push_pin_rounded : Icons.push_pin_outlined,
                  size: 17,
                  color: e.pinned ? AppColors.amber : AppColors.muted,
                ),
                tooltip: t(e.pinned ? 'docsregUnpin' : 'docsregPin'),
              ),
            ],
          ),
        ],
      ),
    );
    // 内容已被 7 天清理、只剩登记的产物整卡降透明度（与服务与文档页一致）。
    return e.expired ? Opacity(opacity: 0.55, child: card) : card;
  }
}

// ── Small views ──────────────────────────────────────────────────────────────

class _EmptyArtifacts extends StatelessWidget {
  const _EmptyArtifacts();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(28, 90, 28, 20),
    child: Column(
      children: [
        const Icon(
          Icons.inventory_2_outlined,
          size: 44,
          color: AppColors.faint,
        ),
        const SizedBox(height: 14),
        Text(
          t('airDirArtifactsEmpty'),
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: AppColors.muted,
            fontSize: 12.5,
            height: 1.6,
          ),
        ),
      ],
    ),
  );
}

/// 刷新失败时顶上那行错误：不回滚列表，只说明这一份是旧的。
class _ErrorLine extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorLine({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: AppColors.danger.withValues(alpha: 0.08),
      border: Border.all(color: AppColors.danger.withValues(alpha: 0.35)),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        const Icon(Icons.cloud_off_rounded, size: 16, color: AppColors.danger),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: AppColors.danger, fontSize: 12),
          ),
        ),
        TextButton(
          onPressed: onRetry,
          child: Text(
            t('retry'),
            style: const TextStyle(color: AppColors.accent, fontSize: 12.5),
          ),
        ),
      ],
    ),
  );
}
