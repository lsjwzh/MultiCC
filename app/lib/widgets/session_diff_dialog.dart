import 'dart:math';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';

/// Everything the diff sheet has learned, kept outside the widget so that
/// minimising to the floating button does not throw it away. Restoring is then
/// instant and silent: no refetch, same file selected, same AI summaries.
class _DiffDockData {
  _DiffDockData(this.sessionId);

  final String sessionId;
  Map<String, dynamic>? data;
  String? error;
  bool loading = true;
  bool filesExpanded = true;
  int visibleCount = 20;

  /// The selected file entry (a Map from the files list); null = list view.
  Map<String, dynamic>? selectedFile;

  /// path -> AI summary, shared across detail navigations.
  final Map<String, String> summaryCache = {};

  /// Sheet height as a fraction of the screen. Dragged from the grab handle.
  double heightFactor = _sheetDefaultFactor;

  int get fileCount => (data?['files'] as List?)?.length ?? 0;
}

const double _sheetMinFactor = 0.35;
const double _sheetMaxFactor = 0.94;
const double _sheetDefaultFactor = 0.72;
const double _dockIconSize = 52;
const double _dockIconMargin = 12;

/// One dock at a time: on a phone two floating diff buttons would be clutter,
/// and the sheet is modal anyway.
_DiffDockData? _dock;
OverlayEntry? _dockEntry;

void _removeDockIcon() {
  _dockEntry?.remove();
  _dockEntry = null;
}

/// Show the worktree diff for a session against its base branch. Works for any
/// session with changes (no conflict required) - mirrors the web "View Diff".
/// Codex-style: collapsible summary header + file list + per-file detail with
/// an AI change summary panel.
///
/// Presented as a resizable bottom sheet rather than a full-screen dialog, so
/// the screen behind it stays readable, and it can be closed outright or
/// collapsed to a draggable floating button.
Future<void> showSessionDiffDialog(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
}) {
  _removeDockIcon();
  // Reopening the same session resumes where it left off; a different session
  // starts clean rather than showing the previous one's files.
  if (_dock == null || _dock!.sessionId != sessionId) _dock = _DiffDockData(sessionId);
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    // Light barrier on purpose: the sheet covers part of the screen, and what
    // it does not cover should still be legible.
    barrierColor: const Color(0x59000000),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (_, __, ___) =>
        _SessionDiffDialog(settings: settings, sessionId: sessionId),
    transitionBuilder: (_, anim, __, child) => SlideTransition(
      position: Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
          .animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
      child: child,
    ),
  );
}

class _SessionDiffDialog extends StatefulWidget {
  final SettingsService settings;
  final String sessionId;
  const _SessionDiffDialog({required this.settings, required this.sessionId});

  @override
  State<_SessionDiffDialog> createState() => _SessionDiffDialogState();
}

class _SessionDiffDialogState extends State<_SessionDiffDialog> {
  // All view state lives in the dock so it survives a minimise/restore round
  // trip; these accessors keep the body below reading as it did.
  _DiffDockData get _d => _dock ??= _DiffDockData(widget.sessionId);

  Map<String, dynamic>? get _data => _d.data;
  String? get _error => _d.error;
  bool get _loading => _d.loading;
  bool get _filesExpanded => _d.filesExpanded;
  int get _visibleCount => _d.visibleCount;
  Map<String, dynamic>? get _selectedFile => _d.selectedFile;
  Map<String, String> get _summaryCache => _d.summaryCache;

  @override
  void initState() {
    super.initState();
    // Restoring from the floating button must not refetch what we already have.
    if (_d.data == null && _d.error == null) {
      _load();
    } else {
      _d.loading = false;
    }
  }

  /// Collapse to the floating button. The overlay is resolved before popping,
  /// because after the pop this State's context is gone.
  void _minimize() {
    final overlay = Navigator.of(context, rootNavigator: true).overlay;
    final settings = widget.settings;
    final sessionId = widget.sessionId;
    Navigator.of(context).pop();
    if (overlay == null || !overlay.mounted) return;
    _removeDockIcon();
    _dockEntry = OverlayEntry(
      builder: (_) => _DiffDockIcon(settings: settings, sessionId: sessionId),
    );
    overlay.insert(_dockEntry!);
  }

  void _close() {
    _removeDockIcon();
    _dock = null;
    Navigator.of(context).pop();
  }

  Future<void> _load() async {
    try {
      final res = await SessionService(settings: widget.settings)
          .fetchDiffFiles(widget.sessionId);
      if (!mounted) return;
      if (res['ok'] == false) {
        setState(() {
          _d.error = res['error']?.toString() ?? '加载失败';
          _d.loading = false;
        });
      } else {
        setState(() {
          _d.data = res;
          _d.loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _d.error = '$e';
        _d.loading = false;
      });
    }
  }

  String _subtitle() {
    final d = _data;
    if (d == null) return t('loading');
    final parts = <String>[];
    final branch = d['branch']?.toString();
    final base = d['baseBranch']?.toString();
    if (branch != null && branch.isNotEmpty) {
      parts.add('$branch -> ${base ?? ''}');
    }
    final ms = d['mergeState'];
    final ahead = ms is Map ? (ms['ahead'] as num?)?.toInt() ?? 0 : 0;
    parts.add('$ahead 个提交领先');
    if (ms is Map && ms['dirty'] == true) parts.add('含未提交改动');
    if (d['truncated'] == true) parts.add('已截断');
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.of(context).size;
    final height = screen.height * _d.heightFactor;
    return Align(
      alignment: Alignment.bottomCenter,
      child: Material(
        color: const Color(0xFF070809),
        // Wide screens keep a card-like panel; phones get a full-width sheet.
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        clipBehavior: Clip.antiAlias,
        child: SizedBox(
          width: screen.width > 1040 ? 1000 : screen.width,
          height: height,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _grabHandle(screen.height),
              if (_selectedFile == null) _listHeader() else _detailHeader(),
              Expanded(
                child: _selectedFile == null ? _listBody() : _detailBody(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Drag to trade sheet height against how much of the screen behind stays
  /// visible. Bounded so it can neither collapse to nothing nor swallow the
  /// whole screen.
  Widget _grabHandle(double screenHeight) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: (e) {
        setState(() {
          _d.heightFactor = (_d.heightFactor - e.delta.dy / screenHeight)
              .clamp(_sheetMinFactor, _sheetMaxFactor);
        });
      },
      child: Container(
        height: 22,
        alignment: Alignment.center,
        child: Container(
          width: 38,
          height: 4,
          decoration: BoxDecoration(
            color: const Color(0xFF2b3038),
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }

  // -- List view ----------------------------------------------------------

  /// Minimise + close, in that order, shared by both headers.
  List<Widget> _shellButtons() {
    return [
      IconButton(
        onPressed: _minimize,
        icon: const Icon(Icons.remove, color: Color(0xFF8a909b), size: 20),
        tooltip: t('diffMinimize'),
        visualDensity: VisualDensity.compact,
      ),
      IconButton(
        onPressed: _close,
        icon: const Icon(Icons.close, color: Color(0xFF8a909b)),
        tooltip: t('diffClose'),
        visualDensity: VisualDensity.compact,
      ),
    ];
  }

  Widget _listHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 4, 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Diff · ${widget.sessionId}',
                  style: const TextStyle(
                    color: Color(0xFFf2f4f7),
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 3),
                Text(
                  _error != null ? '错误：$_error' : _subtitle(),
                  style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
                ),
              ],
            ),
          ),
          ..._shellButtons(),
        ],
      ),
    );
  }

  Widget _listBody() {
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
            '加载 Diff 失败：$_error',
            style: const TextStyle(color: Color(0xFFffb3ae)),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final files = (_data?['files'] as List? ?? []);
    if (files.isEmpty) {
      return const Center(
        child: Text('（无变更）', style: TextStyle(color: Color(0xFF5b616c))),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _summaryBar(),
        if (_filesExpanded) Expanded(child: _fileListView(files)),
      ],
    );
  }

  Widget _summaryBar() {
    final d = _data!;
    final totalFiles = (d['totalFiles'] as num?)?.toInt() ??
        ((d['files'] as List?)?.length ?? 0);
    final add = (d['totalAdditions'] as num?)?.toInt() ?? 0;
    final del = (d['totalDeletions'] as num?)?.toInt() ?? 0;
    return InkWell(
      onTap: () => setState(() => _d.filesExpanded = !_d.filesExpanded),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: const BoxDecoration(
          color: Color(0xFF0f1115),
          border: Border.symmetric(
            horizontal: BorderSide(color: Color(0xFF20242b)),
          ),
        ),
        child: Row(
          children: [
            RichText(
              text: TextSpan(
                children: [
                  TextSpan(
                    text: t('diffChangedFiles', {'0': '$totalFiles'}),
                    style: const TextStyle(
                      color: Color(0xFFf2f4f7),
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const TextSpan(text: '    '),
                  TextSpan(
                    text: '+$add',
                    style: const TextStyle(
                      color: Color(0xFF7ee787),
                      fontSize: 13,
                      fontFamily: 'monospace',
                    ),
                  ),
                  const TextSpan(text: '  '),
                  TextSpan(
                    text: '−$del',
                    style: const TextStyle(
                      color: Color(0xFFffb3ae),
                      fontSize: 13,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(),
            AnimatedRotation(
              turns: _filesExpanded ? 0.0 : -0.25,
              duration: const Duration(milliseconds: 150),
              child: const Icon(
                Icons.expand_more,
                color: Color(0xFF8a909b),
                size: 18,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _fileListView(List files) {
    final visible = files.take(_visibleCount).toList();
    final remaining = files.length - visible.length;
    return ListView.separated(
      itemCount: visible.length + (remaining > 0 ? 1 : 0),
      separatorBuilder: (_, __) => const Divider(
        color: Color(0xFF20242b),
        height: 1,
        indent: 16,
        endIndent: 16,
      ),
      itemBuilder: (ctx, i) {
        if (i == visible.length) {
          return InkWell(
            onTap: () => setState(() => _d.visibleCount = files.length),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Center(
                child: Text(
                  t('diffViewMoreFiles', {'0': '$remaining'}),
                  style: const TextStyle(color: Color(0xFF6aa3ff), fontSize: 12),
                ),
              ),
            ),
          );
        }
        final f = (visible[i] as Map).cast<String, dynamic>();
        return _fileRow(f);
      },
    );
  }

  Widget _fileRow(Map<String, dynamic> f) {
    final path = f['path']?.toString() ?? '';
    final status = f['status']?.toString() ?? 'M';
    final add = (f['additions'] as num?)?.toInt() ?? 0;
    final del = (f['deletions'] as num?)?.toInt() ?? 0;
    final binary = f['binary'] == true;
    return InkWell(
      onTap: () => setState(() => _d.selectedFile = f),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            _statusBadge(status),
            const SizedBox(width: 10),
            Expanded(
              child: Tooltip(
                message: path,
                child: RichText(
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  text: TextSpan(
                    children: _pathSpans(path),
                    style: const TextStyle(
                      fontSize: 12,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (binary)
              const Text(
                'binary',
                style: TextStyle(color: Color(0xFF5b616c), fontSize: 11),
              )
            else ...[
              Text(
                '+$add',
                style: const TextStyle(
                  color: Color(0xFF7ee787),
                  fontSize: 11,
                  fontFamily: 'monospace',
                ),
              ),
              const SizedBox(width: 6),
              Text(
                '−$del',
                style: const TextStyle(
                  color: Color(0xFFffb3ae),
                  fontSize: 11,
                  fontFamily: 'monospace',
                ),
              ),
            ],
            const SizedBox(width: 6),
            const Icon(
              Icons.chevron_right,
              color: Color(0xFF5b616c),
              size: 16,
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusBadge(String s) {
    final fg = _statusColor(s);
    final bg = _statusBg(s);
    return Container(
      width: 18,
      height: 18,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: fg, width: 1),
      ),
      child: Text(
        s,
        style: TextStyle(
          color: fg,
          fontSize: 10,
          fontWeight: FontWeight.w700,
          fontFamily: 'monospace',
        ),
      ),
    );
  }

  Color _statusColor(String s) {
    switch (s) {
      case 'A':
        return const Color(0xFF7ee787);
      case 'D':
        return const Color(0xFFffb3ae);
      case 'R':
        return const Color(0xFFd2a8ff);
      case 'M':
      default:
        return const Color(0xFF6aa3ff);
    }
  }

  Color _statusBg(String s) {
    switch (s) {
      case 'A':
        return const Color(0x227ee787);
      case 'D':
        return const Color(0x22ffb3ae);
      case 'R':
        return const Color(0x22d2a8ff);
      case 'M':
      default:
        return const Color(0x226aa3ff);
    }
  }

  List<TextSpan> _pathSpans(String path) {
    final idx = path.lastIndexOf('/');
    if (idx < 0) {
      return [
        TextSpan(text: path, style: const TextStyle(color: Color(0xFFf2f4f7))),
      ];
    }
    final dir = path.substring(0, idx + 1);
    final base = path.substring(idx + 1);
    return [
      TextSpan(text: dir, style: const TextStyle(color: Color(0xFF5b616c))),
      TextSpan(text: base, style: const TextStyle(color: Color(0xFFf2f4f7))),
    ];
  }

  // -- Detail view --------------------------------------------------------

  Widget _detailHeader() {
    final f = _selectedFile!;
    final path = f['path']?.toString() ?? '';
    final add = (f['additions'] as num?)?.toInt() ?? 0;
    final del = (f['deletions'] as num?)?.toInt() ?? 0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 4, 10),
      child: Row(
        children: [
          IconButton(
            onPressed: () => setState(() => _d.selectedFile = null),
            icon: const Icon(Icons.arrow_back, color: Color(0xFF8a909b), size: 20),
            tooltip: t('diffBackToList'),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t('diffBackToList'),
                  style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        path,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Color(0xFFf2f4f7),
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                    Text(
                      '+$add',
                      style: const TextStyle(
                        color: Color(0xFF7ee787),
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '−$del',
                      style: const TextStyle(
                        color: Color(0xFFffb3ae),
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          ..._shellButtons(),
        ],
      ),
    );
  }

  Widget _detailBody() {
    final f = _selectedFile!;
    return _FileDiffView(
      settings: widget.settings,
      sessionId: widget.sessionId,
      path: f['path']?.toString() ?? '',
      status: f['status']?.toString() ?? 'M',
      additions: (f['additions'] as num?)?.toInt() ?? 0,
      deletions: (f['deletions'] as num?)?.toInt() ?? 0,
      summaryCache: _summaryCache,
    );
  }
}

/// Per-file detail view: loads the patch, shows an AI change summary panel at
/// the top (auto-started, cancellable on dispose/navigation), and the colored
/// patch below. Summary results are cached in [summaryCache] (shared by the
/// parent) so reopening a file is instant.
class _FileDiffView extends StatefulWidget {
  final SettingsService settings;
  final String sessionId;
  final String path;
  final String status;
  final int additions;
  final int deletions;
  final Map<String, String> summaryCache;

  const _FileDiffView({
    required this.settings,
    required this.sessionId,
    required this.path,
    required this.status,
    required this.additions,
    required this.deletions,
    required this.summaryCache,
  });

  @override
  State<_FileDiffView> createState() => _FileDiffViewState();
}

class _FileDiffViewState extends State<_FileDiffView> {
  String? _patch;
  bool _patchLoading = true;
  String? _patchError;

  String? _summary;
  bool _summaryLoading = false;
  String? _summaryError;

  http.Client? _summaryClient;
  String? _summaryTaskId;

  @override
  void initState() {
    super.initState();
    _loadPatch();
  }

  @override
  void dispose() {
    _cancelSummary();
    super.dispose();
  }

  Future<void> _loadPatch() async {
    try {
      final res = await SessionService(settings: widget.settings)
          .fetchFileDiff(widget.sessionId, widget.path);
      if (!mounted) return;
      if (res['ok'] == false) {
        setState(() {
          _patchError = res['error']?.toString() ?? '加载失败';
          _patchLoading = false;
        });
      } else {
        setState(() {
          _patch = res['patch']?.toString() ?? '';
          _patchLoading = false;
        });
        _maybeStartSummary();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _patchError = '$e';
        _patchLoading = false;
      });
    }
  }

  void _maybeStartSummary() {
    final cached = widget.summaryCache[widget.path];
    if (cached != null) {
      setState(() {
        _summary = cached;
        _summaryLoading = false;
        _summaryError = null;
      });
      return;
    }
    _startSummary();
  }

  String _makeTaskId() {
    return 'diffsum_${DateTime.now().millisecondsSinceEpoch}_${Random().nextInt(1 << 32)}';
  }

  String _buildPrompt(String patch) {
    final truncated = patch.length > 24000;
    final p = truncated ? patch.substring(0, 24000) : patch;
    final tail = truncated ? '\n(diff 过长已截断)' : '';
    return '你是一个代码审查助手。请用中文简要总结以下 git diff 中单个文件的改动（文件：${widget.path}，状态：${widget.status}）。要求：1) 一两句话说明这个文件改了什么、为什么；2) 用 2-4 条要点列出关键改动；3) 若发现潜在风险或值得注意的点，最后一行列出，没有则不列。总输出控制在 200 字以内，纯文本，不要用 markdown 代码块。diff 内容如下：\n\n$p$tail';
  }

  Future<void> _startSummary() async {
    setState(() {
      _summaryLoading = true;
      _summaryError = null;
      _summary = null;
    });
    final client = http.Client();
    _summaryClient = client;
    final taskId = _makeTaskId();
    _summaryTaskId = taskId;
    final prompt = _buildPrompt(_patch ?? '');
    try {
      final res = await SessionService(settings: widget.settings).enqueueAux(
        id: taskId,
        type: 'diff_summary',
        prompt: prompt,
        meta: {'sessionName': widget.sessionId, 'path': widget.path},
        client: client,
      );
      if (!mounted) return;
      if (res['ok'] == true) {
        final summary = res['result']?.toString() ?? '';
        widget.summaryCache[widget.path] = summary;
        setState(() {
          _summary = summary;
          _summaryLoading = false;
        });
      } else {
        setState(() {
          _summaryError = res['error']?.toString() ?? t('diffSummaryFailed');
          _summaryLoading = false;
        });
      }
    } on http.ClientException {
      // Cancelled by dispose/navigation: silent.
      if (!mounted) return;
      setState(() {
        _summaryLoading = false;
      });
    } catch (e) {
      // Timeout/network failure: the server-side aux task may still be
      // running — cancel it best-effort so it doesn't keep the queue busy.
      SessionService(settings: widget.settings).cancelAux(taskId);
      if (!mounted) return;
      setState(() {
        _summaryError = '$e';
        _summaryLoading = false;
      });
    } finally {
      // Close on every completion path (success/error/timeout). On the
      // cancelled path _cancelSummary already closed it — close() twice is
      // harmless, and this prevents leaking the underlying HttpClient.
      try {
        client.close();
      } catch (_) {}
      if (identical(_summaryClient, client)) {
        _summaryClient = null;
        _summaryTaskId = null;
      }
    }
  }

  void _cancelSummary() {
    final c = _summaryClient;
    final tid = _summaryTaskId;
    _summaryClient = null;
    _summaryTaskId = null;
    if (c != null) {
      try {
        c.close();
      } catch (_) {}
    }
    if (tid != null) {
      // Fire-and-forget; best-effort cancel.
      SessionService(settings: widget.settings).cancelAux(tid);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!_patchLoading && _patchError == null) _summaryPanel(),
        Expanded(child: _patchArea()),
      ],
    );
  }

  Widget _summaryPanel() {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF0f1115),
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.auto_awesome, size: 14, color: Color(0xFFd2a8ff)),
              const SizedBox(width: 6),
              Text(
                t('diffAiSummary'),
                style: const TextStyle(
                  color: Color(0xFFf2f4f7),
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          _summaryBody(),
        ],
      ),
    );
  }

  Widget _summaryBody() {
    if (_summaryLoading) {
      return Row(
        children: [
          const SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 10),
          Text(
            t('diffSummarizing'),
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 12),
          ),
        ],
      );
    }
    if (_summary != null) {
      return SelectableText(
        _summary!,
        style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 12, height: 1.5),
      );
    }
    if (_summaryError != null) {
      return Row(
        children: [
          Expanded(
            child: Text(
              '${t('diffSummaryFailed')}：$_summaryError',
              style: const TextStyle(color: Color(0xFFffb3ae), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: _startSummary,
            child: Text(t('retry')),
          ),
        ],
      );
    }
    return const SizedBox.shrink();
  }

  Widget _patchArea() {
    if (_patchLoading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_patchError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '加载 Diff 失败：$_patchError',
            style: const TextStyle(color: Color(0xFFffb3ae)),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final patch = _patch ?? '';
    if (patch.trim().isEmpty) {
      return const Center(
        child: Text('（无变更）', style: TextStyle(color: Color(0xFF5b616c))),
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

/// Where the floating button was left, so dragging it out of the way survives
/// a restore + minimise cycle. Null until the first layout picks a default.
Offset? _dockIconPos;

/// The collapsed form of the diff sheet: a small draggable circle that snaps to
/// whichever side is nearer, badged with the number of changed files. Tapping it
/// reopens the sheet exactly where it was left.
class _DiffDockIcon extends StatefulWidget {
  const _DiffDockIcon({required this.settings, required this.sessionId});

  final SettingsService settings;
  final String sessionId;

  @override
  State<_DiffDockIcon> createState() => _DiffDockIconState();
}

class _DiffDockIconState extends State<_DiffDockIcon> {
  bool _dragging = false;

  /// Keep the button fully on screen even after a rotation or a keyboard.
  Offset _clamp(Offset p, Size screen, EdgeInsets pad) {
    final maxX = screen.width - _dockIconSize - _dockIconMargin;
    final minY = pad.top + _dockIconMargin;
    final maxY = screen.height - pad.bottom - _dockIconSize - _dockIconMargin;
    return Offset(
      p.dx.clamp(_dockIconMargin, maxX < _dockIconMargin ? _dockIconMargin : maxX),
      p.dy.clamp(minY, maxY < minY ? minY : maxY),
    );
  }

  void _restore() {
    final settings = widget.settings;
    final sessionId = widget.sessionId;
    _removeDockIcon();
    showSessionDiffDialog(context, settings: settings, sessionId: sessionId);
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final screen = media.size;
    final pad = media.padding;
    final pos = _clamp(
      _dockIconPos ??
          Offset(screen.width - _dockIconSize - _dockIconMargin,
              screen.height * 0.58),
      screen,
      pad,
    );
    final count = _dock?.fileCount ?? 0;

    return Positioned(
      left: pos.dx,
      top: pos.dy,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanStart: (_) => setState(() => _dragging = true),
        onPanUpdate: (e) => setState(() {
          _dockIconPos = _clamp(pos + e.delta, screen, pad);
        }),
        onPanEnd: (_) => setState(() {
          _dragging = false;
          // Snap to the nearer edge so it always parks out of the way.
          final left = pos.dx + _dockIconSize / 2 < screen.width / 2;
          _dockIconPos = Offset(
            left ? _dockIconMargin : screen.width - _dockIconSize - _dockIconMargin,
            (_dockIconPos ?? pos).dy,
          );
        }),
        onTap: _restore,
        child: Tooltip(
          message: t('diffRestore'),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                width: _dockIconSize,
                height: _dockIconSize,
                decoration: BoxDecoration(
                  color: const Color(0xFF1f6feb),
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0xFF388bfd)),
                  boxShadow: [
                    BoxShadow(
                      color: const Color(0xAA000000),
                      blurRadius: _dragging ? 26 : 16,
                      offset: const Offset(0, 6),
                    ),
                  ],
                ),
                alignment: Alignment.center,
                child: const Icon(Icons.difference_outlined,
                    color: Colors.white, size: 24),
              ),
              if (count > 0)
                Positioned(
                  top: -4,
                  right: -4,
                  child: Container(
                    constraints: const BoxConstraints(minWidth: 20),
                    height: 20,
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0d1117),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0xFF388bfd)),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      count > 99 ? '99+' : '$count',
                      style: const TextStyle(
                        color: Color(0xFFcfe3ff),
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Color a unified-diff string line by line (shared with the conflict viewer's
/// scheme). Conflict markers, hunk headers, file headers, + / - lines.
List<TextSpan> diffSpans(String diff) {
  final conflictMarker = RegExp(r'^[+\- ]*(<<<<<<<|=======|>>>>>>>)');
  return diff.split('\n').map((line) {
    Color color = const Color(0xFFe7eaee);
    Color? background;
    FontWeight? weight;
    if (conflictMarker.hasMatch(line)) {
      color = const Color(0xFFe3b341);
      background = const Color(0x33d29922);
      weight = FontWeight.w600;
    } else if (line.startsWith('diff --') ||
        line.startsWith('index ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('rename ') ||
        line.startsWith('similarity ')) {
      color = const Color(0xFFd2a8ff);
    } else if (line.startsWith('@@')) {
      color = const Color(0xFF6aa3ff);
    } else if (line.startsWith('+')) {
      color = const Color(0xFF7ee787);
      background = const Color(0x332ea043);
    } else if (line.startsWith('-')) {
      color = const Color(0xFFffb3ae);
      background = const Color(0x33f85149);
    }
    return TextSpan(
      text: '$line\n',
      style: TextStyle(
        color: color,
        backgroundColor: background,
        fontWeight: weight,
      ),
    );
  }).toList();
}
