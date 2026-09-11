import 'dart:convert';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// Folder-based memory library editor — mirrors the web openMemoryEditor()
/// panel (public/chat.js). Two scopes:
///   - own    (private to this session)
///   - shared (shared across every session in this project/directory)
/// Each scope holds a set of *.md files; the union is injected into every
/// chat turn. Files are read/written via the folder-based memory API
/// (GET/PUT/DELETE /api/sessions/:id/memory).
class MemoryScreen extends StatefulWidget {
  final SettingsService settings;
  final String sessionId;

  const MemoryScreen({
    super.key,
    required this.settings,
    required this.sessionId,
  });

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  late final SessionService _svc = SessionService(settings: widget.settings);

  bool _loading = true;
  bool _busy = false; // saving / deleting
  String? _error;

  // Server snapshot. files maps name -> content for each scope.
  String _scope = 'own'; // 'own' | 'shared'
  String _ownDir = '';
  String _ownPrimary = 'CLAUDE.md';
  String _sharedDir = '';
  Map<String, String> _ownFiles = {};
  Map<String, String> _sharedFiles = {};
  // Legacy auto-distilled JSON entries (read-only display).
  String _legacyText = '';

  String? _selectedName; // currently selected file in the active scope
  late final TextEditingController _editor = TextEditingController();
  late final TextEditingController _newNameCtrl = TextEditingController();

  // Regex mirrors the server's safeMemFileName(): word chars, dash, dot,
  // space and CJK, plus a trailing .md (case-insensitive).
  static final RegExp _nameRe = RegExp(r'^[\w.\- 一-龥]+\.md$', caseSensitive: false);

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _editor.dispose();
    _newNameCtrl.dispose();
    super.dispose();
  }

  Map<String, String> get _files => _scope == 'own' ? _ownFiles : _sharedFiles;
  String get _dir => _scope == 'own' ? _ownDir : _sharedDir;
  String _defaultName(String s) => s == 'own' ? (_ownPrimary.isNotEmpty ? _ownPrimary : 'CLAUDE.md') : 'README.md';

  void _ensureSelection() {
    if (_selectedName == null || !_files.containsKey(_selectedName)) {
      final names = _files.keys.toList()..sort();
      _selectedName = names.isNotEmpty ? names.first : _defaultName(_scope);
    }
    if (!_files.containsKey(_selectedName)) {
      _files[_selectedName!] = '';
    }
    _editor.text = _files[_selectedName!] ?? '';
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await _svc.fetchSessionMemoryFiles(widget.sessionId);
      if (!mounted) return;
      final own = (data['own'] as Map?)?.cast<String, dynamic>() ?? {};
      final shared = (data['shared'] as Map?)?.cast<String, dynamic>() ?? {};
      _ownDir = (own['dir'] ?? '').toString();
      _ownPrimary = (own['primary'] ?? 'CLAUDE.md').toString();
      _sharedDir = (shared['dir'] ?? '').toString();
      _ownFiles = _filesMap(own['files']);
      _sharedFiles = _filesMap(shared['files']);
      _legacyText = _legacyToText(data['legacy']);
      _ensureSelection();
      setState(() => _loading = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  static Map<String, String> _filesMap(dynamic list) {
    final m = <String, String>{};
    if (list is List) {
      for (final e in list) {
        if (e is Map) {
          final name = e['name']?.toString();
          if (name != null && name.isNotEmpty) m[name] = e['content']?.toString() ?? '';
        }
      }
    }
    return m;
  }

  static String _legacyToText(dynamic legacy) {
    if (legacy == null) return '';
    try {
      final enc = const JsonEncoder.withIndent('  ');
      if (legacy is List && legacy.isEmpty) return '';
      if (legacy is Map && legacy.isEmpty) return '';
      return enc.convert(legacy);
    } catch (_) {
      return '$legacy';
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Commit the current textarea back into the in-memory model (so switching
  /// files doesn't lose unsaved edits, matching the web commit()).
  void _commit() {
    if (_selectedName != null) _files[_selectedName!] = _editor.text;
  }

  void _switchScope(String s) {
    if (s == _scope) return;
    _commit();
    _scope = s;
    final names = _files.keys.toList()..sort();
    _selectedName = names.isNotEmpty ? names.first : _defaultName(s);
    if (!_files.containsKey(_selectedName)) _files[_selectedName!] = '';
    _editor.text = _files[_selectedName!] ?? '';
    setState(() {});
  }

  void _selectFile(String name) {
    _commit();
    _selectedName = name;
    _editor.text = _files[name] ?? '';
    setState(() {});
  }

  Future<void> _newFile() async {
    _newNameCtrl.clear();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel2,
        title: Text(t('memNewFileTitle'), style: const TextStyle(color: AppColors.text, fontSize: 16)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t('memNewFileHint'), style: const TextStyle(color: AppColors.muted, fontSize: 12, height: 1.5)),
            const SizedBox(height: 12),
            TextField(
              controller: _newNameCtrl,
              autofocus: true,
              style: const TextStyle(color: AppColors.text, fontFamily: 'monospace'),
              decoration: InputDecoration(
                hintText: 'notes.md',
                hintStyle: const TextStyle(color: AppColors.faint),
                enabledBorder: const UnderlineInputBorder(borderSide: BorderSide(color: AppColors.line)),
                focusedBorder: const UnderlineInputBorder(borderSide: BorderSide(color: AppColors.accent)),
              ),
              onSubmitted: (v) {
                final n = v.trim();
                Navigator.pop(ctx, n.isEmpty ? null : (n.toLowerCase().endsWith('.md') ? n : '$n.md'));
              },
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(t('cancel'), style: const TextStyle(color: AppColors.muted)),
          ),
          TextButton(
            onPressed: () {
              var n = _newNameCtrl.text.trim();
              if (n.isEmpty) return;
              if (!n.toLowerCase().endsWith('.md')) n = '$n.md';
              Navigator.pop(ctx, n);
            },
            child: Text(t('create'), style: const TextStyle(color: AppColors.accent)),
          ),
        ],
      ),
    );
    if (name == null) return;
    if (!_nameRe.hasMatch(name)) {
      _snack(t('memNameInvalid'));
      return;
    }
    _commit();
    if (!_files.containsKey(name)) _files[name] = '';
    _selectedName = name;
    _editor.text = '';
    setState(() {});
  }

  Future<void> _deleteFile() async {
    final name = _selectedName;
    if (name == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.panel2,
        title: Text(t('memDeleteTitle'), style: const TextStyle(color: AppColors.text, fontSize: 16)),
        content: Text(
          t('memDeleteConfirm', {'scope': _scope == 'own' ? t('memScopeOwn') : t('memScopeShared'), 'name': name}),
          style: const TextStyle(color: AppColors.muted, height: 1.5),
        ),
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
    if (confirmed != true) return;
    setState(() => _busy = true);
    try {
      final files = await _svc.deleteMemoryFile(
        widget.sessionId,
        scope: _scope,
        name: name,
      );
      if (!mounted) return;
      _applyServerFiles(files);
      _files.remove(name);
      _ensureSelection();
      _editor.text = _files[_selectedName!] ?? '';
      setState(() {});
      _snack(t('memDeleted'));
    } catch (e) {
      _snack('${t('memDeleteFailed')}: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Replace the active scope's file list with the server-echoed snapshot,
  /// preserving any local-only unsaved file (it isn't on the server yet).
  void _applyServerFiles(List<Map<String, dynamic>> files) {
    final server = <String, String>{};
    for (final f in files) {
      final n = f['name']?.toString();
      if (n != null && n.isNotEmpty) server[n] = f['content']?.toString() ?? '';
    }
    // Keep locally-created-but-unsaved files; overwrite known content from server.
    final preserved = Map<String, String>.from(_files);
    preserved.removeWhere((k, _) => false);
    _files
      ..clear()
      ..addAll(server)
      ..addAll(preserved); // local unsaved wins for names server doesn't know
  }

  Future<void> _save() async {
    _commit();
    final name = _selectedName;
    if (name == null) {
      _snack(t('memNoSelection'));
      return;
    }
    final content = _files[name] ?? '';
    setState(() => _busy = true);
    try {
      final files = await _svc.putMemoryFile(
        widget.sessionId,
        scope: _scope,
        name: name,
        content: content,
      );
      if (!mounted) return;
      _applyServerFiles(files);
      setState(() {});
      _snack(t('memSaved', {'scope': _scope == 'own' ? t('memScopeOwn') : t('memScopeShared'), 'name': name}));
    } catch (e) {
      _snack('${t('memSaveFailed')}: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: Text(t('memTitle'), style: const TextStyle(fontSize: 16)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading || _busy ? null : _refresh,
            tooltip: t('refresh'),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : SafeArea(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
                    children: [
                      Text(t('memIntro'), style: const TextStyle(color: AppColors.muted, fontSize: 12.5, height: 1.55)),
                      const SizedBox(height: 14),
                      _scopeTabs(),
                      const SizedBox(height: 12),
                      _fileRow(),
                      const SizedBox(height: 10),
                      _pathHint(),
                      const SizedBox(height: 8),
                      _editorField(),
                      const SizedBox(height: 12),
                      _actionRow(),
                      if (_legacyText.isNotEmpty) ...[
                        const SizedBox(height: 24),
                        _legacySection(),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _scopeTabs() {
    Widget tab(String key, String label) {
      final active = _scope == key;
      return Expanded(
        child: GestureDetector(
          onTap: _busy ? null : () => _switchScope(key),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 9),
            decoration: BoxDecoration(
              color: active ? AppColors.accentDark : AppColors.panel2,
              border: Border.all(color: active ? AppColors.accent : AppColors.line),
              borderRadius: BorderRadius.circular(6),
            ),
            alignment: Alignment.center,
            child: Text(
              label,
              style: TextStyle(
                color: active ? AppColors.bg : AppColors.text,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      );
    }

    return Row(
      children: [
        tab('own', t('memScopeOwn')),
        const SizedBox(width: 8),
        tab('shared', t('memScopeShared')),
      ],
    );
  }

  Widget _fileRow() {
    final names = _files.keys.toList()..sort();
    return Row(
      children: [
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(
              color: AppColors.bgSoft,
              border: Border.all(color: AppColors.line),
              borderRadius: BorderRadius.circular(6),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: _selectedName,
                isExpanded: true,
                dropdownColor: AppColors.panel2,
                style: const TextStyle(color: AppColors.text, fontSize: 13, fontFamily: 'monospace'),
                items: names
                    .map((n) => DropdownMenuItem<String>(
                          value: n,
                          child: Text(n, overflow: TextOverflow.ellipsis),
                        ))
                    .toList(),
                onChanged: _busy ? null : (v) { if (v != null) _selectFile(v); },
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          onPressed: _busy ? null : _newFile,
          icon: const Icon(Icons.add_circle_outline_rounded, color: AppColors.text, size: 22),
          tooltip: t('memNewFileTitle'),
        ),
        IconButton(
          onPressed: _busy ? null : _deleteFile,
          icon: const Icon(Icons.delete_outline_rounded, color: AppColors.danger, size: 22),
          tooltip: t('delete'),
        ),
      ],
    );
  }

  Widget _pathHint() {
    return Text(
      '$_dir/$_selectedName',
      style: const TextStyle(color: AppColors.faint, fontSize: 11, fontFamily: 'monospace'),
      overflow: TextOverflow.ellipsis,
      maxLines: 2,
    );
  }

  Widget _editorField() {
    return Container(
      constraints: const BoxConstraints(minHeight: 240),
      decoration: BoxDecoration(
        color: AppColors.bgSoft,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(6),
      ),
      child: TextField(
        controller: _editor,
        maxLines: null,
        minLines: 10,
        enabled: !_busy,
        style: const TextStyle(color: AppColors.text, fontSize: 13, fontFamily: 'monospace', height: 1.45),
        decoration: const InputDecoration(
          contentPadding: EdgeInsets.all(10),
          border: InputBorder.none,
        ),
        onChanged: (v) {
          if (_selectedName != null) _files[_selectedName!] = v;
        },
      ),
    );
  }

  Widget _actionRow() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(t('close'), style: const TextStyle(color: AppColors.muted)),
        ),
        const SizedBox(width: 8),
        FilledButton.icon(
          onPressed: _busy ? null : _save,
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF2ba67a),
            foregroundColor: Colors.white,
          ),
          icon: _busy
              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Icon(Icons.save_outlined, size: 18),
          label: Text(t('save')),
        ),
      ],
    );
  }

  Widget _legacySection() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(t('memLegacyTitle'), style: const TextStyle(color: AppColors.amber, fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(t('memLegacyHint'), style: const TextStyle(color: AppColors.faint, fontSize: 11, height: 1.5)),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 200),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.bgSoft,
              border: Border.all(color: AppColors.line),
              borderRadius: BorderRadius.circular(6),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                _legacyText,
                style: const TextStyle(color: AppColors.muted, fontSize: 12, fontFamily: 'monospace', height: 1.5),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline_rounded, color: AppColors.danger, size: 40),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: onRetry,
              style: FilledButton.styleFrom(backgroundColor: AppColors.accentDark, foregroundColor: AppColors.bg),
              child: Text(t('retry')),
            ),
          ],
        ),
      ),
    );
  }
}
