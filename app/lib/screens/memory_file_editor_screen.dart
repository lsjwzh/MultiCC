import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
import 'package:http/http.dart' as http;

import '../services/memory_file_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 记忆文件编辑器 —— Web `public/memory-controller.js:218` 的
/// `openMemFileEditor(rel)` 的原生对应物：记忆图谱节点详情里那颗「编辑」打开它。
///
/// 读写走 [MemoryFileService]（`GET` / `PUT /api/memory/file`）。三条安全语义照抄
/// Web，一条都不能省：
///   1. 服务端截断过的文件（超过 20 万字符）**只读** —— 预览不能覆盖完整文件；
///   2. 读取失败（除 404）时禁用保存 —— 别用空内容覆盖一个读不出来的文件；
///   3. 404 是「文件不存在，保存后创建」，不是错误。
class MemoryFileEditorScreen extends StatefulWidget {
  const MemoryFileEditorScreen({
    super.key,
    required this.settings,
    required this.rel,
    this.httpClient,
  });

  final SettingsService settings;

  /// 文件相对于 memories/ 的路径（图谱节点的 `rel`）。
  final String rel;

  /// 测试用的假 client；不给就自己 new 一个（由本页 close）。
  final http.Client? httpClient;

  @override
  MemoryFileEditorScreenState createState() => MemoryFileEditorScreenState();
}

class MemoryFileEditorScreenState extends State<MemoryFileEditorScreen> {
  late final MemoryFileService _service = MemoryFileService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );
  late final TextEditingController _editor = TextEditingController();

  /// 已落盘的基线 —— 和编辑框内容不一致就是「有未保存的改动」。
  String _saved = '';

  bool _loading = true;
  bool _saving = false;
  bool _readOnly = false;
  bool _missing = false;
  String _readOnlyMessage = '';
  String? _loadError;
  String? _saveError;
  String _path = '';

  int _loadSeq = 0;
  bool _disposed = false;

  /// 这次进编辑器有没有真的改到磁盘（保存过 / 删过）—— 关闭时回给图谱，
  /// 让它决定要不要重取（Web 的 `afterMemChange()` 也是一样的语义）。
  bool _changed = false;

  bool get _dirty => _editor.text != _saved;
  bool get _canSave => !_loading && !_saving && !_readOnly;

  @override
  void initState() {
    super.initState();
    _editor.addListener(_onChanged);
    unawaited(_load());
  }

  @override
  void dispose() {
    _disposed = true;
    _loadSeq++;
    _editor.dispose();
    _service.dispose();
    super.dispose();
  }

  void _onChanged() {
    // 只为了让 token 估算那行跟着动；内容本身不进 build 状态（避免每次按键重建
    // 整页 —— 文本量大时那是实打实的卡顿）。
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    final seq = ++_loadSeq;
    setState(() {
      _loading = true;
      _loadError = null;
      _saveError = null;
      // 加载完成前禁止保存：还不知道文件里有什么，不能覆盖。
      _readOnly = true;
      _readOnlyMessage = '文件仍在加载，暂不能保存。';
    });
    try {
      final payload = await _service.load(widget.rel);
      if (_disposed || seq != _loadSeq) return;
      setState(() {
        _loading = false;
        _saved = payload.content;
        _editor.text = payload.content;
        _path = payload.path.isNotEmpty ? payload.path : widget.rel;
        if (payload.readOnly || payload.contentTruncated) {
          _readOnly = true;
          _readOnlyMessage = _oversizedMessage(payload.originalLength);
        } else {
          _readOnly = false;
          _readOnlyMessage = '';
        }
      });
    } on MemoryFileException catch (err) {
      if (_disposed || seq != _loadSeq) return;
      setState(() {
        _loading = false;
        if (err.status == 404) {
          // 文件不存在：可以保存（保存即创建）。
          _missing = true;
          _readOnly = false;
          _readOnlyMessage = '';
          _path = '（文件不存在，保存后创建）· ${widget.rel}';
          return;
        }
        _loadError = '读取失败：$err';
        // 读不出来就别让它写：内容可能是错的。
        _readOnly = true;
        _readOnlyMessage = '文件读取失败，已禁用保存以避免覆盖未知内容。';
      });
    }
  }

  Future<void> _save() async {
    final content = _editor.text;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final payload = await _service.save(widget.rel, content);
      if (_disposed) return;
      setState(() {
        _saving = false;
        _saved = content;
        _changed = true;
        _missing = false;
        if (payload.path.isNotEmpty) _path = payload.path;
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已保存 · ~${estimateMemoryTokens(content)} tokens'),
        ),
      );
    } on MemoryFileException catch (err) {
      if (_disposed) return;
      setState(() {
        _saving = false;
        _saveError = '保存失败：$err';
      });
    }
  }

  /// 删除（Web `deleteMemFile()`）：先问一句「不可恢复」，成功就收掉编辑器并
  /// 告诉图谱「内容变了」。
  Future<void> _delete() async {
    final name = widget.rel.split('/').last;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: const Text('删除记忆文件'),
        content: Text('删除记忆文件「$name」？不可恢复。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const ValueKey('memory-file-delete-confirm'),
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      await _service.delete(widget.rel);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on MemoryFileException catch (err) {
      if (_disposed) return;
      setState(() {
        _saving = false;
        _saveError = '删除失败：$err';
      });
    }
  }

  /// Web `oversizedFileMessage()`（`memory-controller.js:210`）逐字对齐。
  static String _oversizedMessage(int originalLength) =>
      '⚠ 文件共有 $originalLength 字符，超过可安全编辑上限 '
      '${MemoryFileService.maxFileContent}；当前仅显示前 '
      '${MemoryFileService.maxFileContent} 字符并已禁用保存，避免覆盖完整文件。';

  Future<void> _confirmClose() async {
    if (!_dirty) {
      Navigator.of(context).pop(_changed);
      return;
    }
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: const Text('有未保存的改动'),
        content: const Text('确定关闭？改动不会保留。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const ValueKey('memory-file-discard'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('丢弃改动'),
          ),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).pop(_changed);
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.rel.split('/').last;
    return PopScope(
      // 有未保存改动时先问一句（Web 的 `confirm('有未保存的改动，确定关闭？')`）。
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_confirmClose());
      },
      child: Scaffold(
        backgroundColor: AppColors.bg,
        appBar: AppBar(
          title: Text(name, overflow: TextOverflow.ellipsis),
          leading: IconButton(
            icon: const Icon(Icons.arrow_back_rounded),
            tooltip: '返回',
            onPressed: () => unawaited(_confirmClose()),
          ),
          actions: [
            // 删除只在「文件确实存在」时出现（Web 404 分支也不给删）。
            if (!_loading && !_missing && _loadError == null)
              IconButton(
                key: const ValueKey('memory-file-delete'),
                icon: const Icon(Icons.delete_outline_rounded),
                color: AppColors.danger,
                tooltip: '删除',
                onPressed: _saving ? null : () => unawaited(_delete()),
              ),
            TextButton(
              key: const ValueKey('memory-file-save'),
              onPressed: _canSave ? () => unawaited(_save()) : null,
              // 404 是「文件不存在，保存后创建」——按钮上把这件事说出来。
              child: Text(
                _saving
                    ? '保存中…'
                    : (_missing ? '创建' : '保存'),
              ),
            ),
          ],
        ),
        body: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _loading ? '加载中… · ${widget.rel}' : _path,
                key: const ValueKey('memory-file-path'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: AppColors.faint,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 6),
              if (_loadError != null)
                Text(
                  _loadError!,
                  key: const ValueKey('memory-file-error'),
                  style: const TextStyle(
                    color: AppColors.danger,
                    fontSize: 12,
                    height: 1.6,
                  ),
                ),
              if (_saveError != null)
                Text(
                  _saveError!,
                  key: const ValueKey('memory-file-save-error'),
                  style: const TextStyle(
                    color: AppColors.danger,
                    fontSize: 12,
                    height: 1.6,
                  ),
                ),
              // 只读的理由也说出来：按钮是灰的，用户得知道为什么（Web 把这句话
              // 存在 `_editReadOnlyMessage` 里没显示出来，这里补上）。
              if (_readOnlyMessage.isNotEmpty && !_loading)
                Text(
                  _readOnlyMessage,
                  key: const ValueKey('memory-file-message'),
                  style: const TextStyle(
                    color: AppColors.amber,
                    fontSize: 12,
                    height: 1.6,
                  ),
                ),
              const SizedBox(height: 8),
              Expanded(
                child: Container(
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: AppColors.panel,
                    border: Border.all(color: AppColors.line),
                    borderRadius: BorderRadius.circular(AppColors.radiusCard),
                  ),
                  child: CallbackShortcuts(
                    // Web 的 `⌘/Ctrl + Enter` 保存（`memory-controller.js:337`）。
                    bindings: <ShortcutActivator, VoidCallback>{
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        meta: true,
                      ): () => unawaited(_save()),
                      const SingleActivator(
                        LogicalKeyboardKey.enter,
                        control: true,
                      ): () => unawaited(_save()),
                    },
                    child: TextField(
                      key: const ValueKey('memory-file-editor'),
                      controller: _editor,
                      readOnly: _readOnly || _loading,
                      maxLines: null,
                      expands: true,
                      textAlignVertical: TextAlignVertical.top,
                      keyboardType: TextInputType.multiline,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        height: 1.5,
                        color: AppColors.text,
                      ),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.all(12),
                        hintText: '（空文件）',
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Text(
                    '估算 ~${estimateMemoryTokens(_editor.text)} tokens',
                    key: const ValueKey('memory-file-tokens'),
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: AppColors.faint,
                    ),
                  ),
                  const Spacer(),
                  if (_dirty)
                    const Text(
                      '未保存',
                      style: TextStyle(
                        fontSize: 11,
                        color: AppColors.warning,
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
