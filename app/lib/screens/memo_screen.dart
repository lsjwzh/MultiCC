import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';

class MemoScreen extends StatefulWidget {
  final Directory directory;
  final SessionManager mgr;
  const MemoScreen({super.key, required this.directory, required this.mgr});

  @override
  State<MemoScreen> createState() => _MemoScreenState();
}

class _MemoScreenState extends State<MemoScreen> {
  static const _autoSaveDelay = Duration(milliseconds: 1000);

  final TextEditingController _ctrl = TextEditingController();
  Timer? _autoSaveTimer;
  bool _loading = true;
  bool _saving = false;
  bool _reSave = false;
  String _lastSavedText = '';
  String _path = '';
  String _status = '';

  String get _draftKey => 'multicc_memo_draft_${widget.directory.id}';

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(_onTextChanged);
    _load();
  }

  @override
  void dispose() {
    _autoSaveTimer?.cancel();
    final dirId = widget.directory.id;
    final text = _ctrl.text;
    if (text != _lastSavedText) {
      widget.mgr.service.saveMemo(dirId, text).then((_) {
        SharedPreferences.getInstance()
            .then((prefs) => prefs.remove('multicc_memo_draft_$dirId'))
            .catchError((_) => false);
      }).catchError((_) {});
    }
    _ctrl.dispose();
    super.dispose();
  }

  void _onTextChanged() {
    if (_loading) return;
    final text = _ctrl.text;
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setString(_draftKey, text))
        .catchError((_) => false);
    final composing = _ctrl.value.composing;
    if (composing.isValid && !composing.isCollapsed) return;
    _scheduleAutoSave();
  }

  void _scheduleAutoSave() {
    _autoSaveTimer?.cancel();
    _autoSaveTimer = Timer(_autoSaveDelay, () {
      if (!mounted || _ctrl.text == _lastSavedText) return;
      _save();
    });
  }

  Future<void> _load() async {
    String? draft;
    try {
      final prefs = await SharedPreferences.getInstance();
      draft = prefs.getString(_draftKey);
    } catch (_) {}
    try {
      final m = await widget.mgr.service.fetchMemo(widget.directory.id);
      if (!mounted) return;
      final serverText = (m['text'] as String?) ?? '';
      final restored = draft != null && draft != serverText;
      setState(() {
        _ctrl.text = restored ? draft! : serverText;
        _lastSavedText = serverText;
        _path = (m['path'] as String?) ?? '';
        _status = restored
            ? '已恢复上次未保存的内容，即将自动保存'
            : ((m['exists'] == true) ? '' : '文件尚未创建（保存即创建）');
        _loading = false;
      });
      if (draft != null && !restored) {
        SharedPreferences.getInstance()
            .then((prefs) => prefs.remove(_draftKey))
            .catchError((_) => false);
      }
      if (restored) _scheduleAutoSave();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        if (draft != null) {
          _ctrl.text = draft;
          _status = '加载失败，已恢复本地草稿：$e';
        } else {
          _status = '加载失败：$e';
        }
        _loading = false;
      });
      if (draft != null) _scheduleAutoSave();
    }
  }

  Future<void> _save() async {
    if (_saving) {
      _reSave = true;
      return;
    }
    _saving = true;
    final text = _ctrl.text;
    if (mounted) setState(() => _status = '保存中…');
    try {
      await widget.mgr.service.saveMemo(widget.directory.id, text);
      _lastSavedText = text;
      SharedPreferences.getInstance()
          .then((prefs) => prefs.remove(_draftKey))
          .catchError((_) => false);
      if (!mounted) return;
      final now = TimeOfDay.fromDateTime(DateTime.now());
      setState(() => _status = '已保存 · ${now.format(context)}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = '保存失败：$e');
    } finally {
      _saving = false;
      if (_reSave) {
        _reSave = false;
        if (mounted && _ctrl.text != _lastSavedText) _save();
      }
    }
  }

  String _currentLineText() {
    final text = _ctrl.text;
    int pos = _ctrl.selection.baseOffset;
    if (pos < 0) pos = text.length;
    if (pos > text.length) pos = text.length;
    final before = text.lastIndexOf('\n', pos == 0 ? 0 : pos - 1);
    final after = text.indexOf('\n', pos);
    final start = before == -1 ? 0 : before + 1;
    final end = after == -1 ? text.length : after;
    var line = text.substring(start, end);
    line = line.replaceFirst(RegExp(r'^\s*[-*+]\s+\[[ xX]\]\s*'), '');
    line = line.replaceFirst(RegExp(r'^\s*[-*+]\s+'), '');
    line = line.replaceFirst(RegExp(r'^\s*\d+\.\s+'), '');
    line = line.replaceFirst(RegExp(r'^\s*#+\s+'), '');
    return line.trim();
  }

  Future<void> _sendCurrentLine() async {
    final text = _currentLineText();
    if (text.isEmpty) {
      setState(() => _status = '当前行为空，无法发送');
      return;
    }
    final sessions = widget.mgr.sessions
        .where((s) => s.dirId == widget.directory.id && s.kind == SessionKind.chat)
        .toList();
    if (sessions.isEmpty) {
      setState(() => _status = '该Fleet还没有 chat 会话，请先新建一个');
      return;
    }
    final picked = await showModalBottomSheet<Session>(
      context: context,
      backgroundColor: const Color(0xFF0f1115),
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '发送到 chat 会话',
                style: TextStyle(
                  color: Color(0xFFf2f4f7),
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                ),
              ),
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: const Color(0xFF070809),
                  border: Border.all(color: const Color(0xFF14171c)),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  text.length > 200 ? '${text.substring(0, 200)}…' : text,
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontFamily: 'monospace',
                    fontSize: 11,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: sessions
                      .map((s) => ListTile(
                            dense: true,
                            title: Text(
                              s.label ?? s.id,
                              style: const TextStyle(color: Color(0xFFe7eaee)),
                            ),
                            subtitle: (s.label != null && s.label != s.id)
                                ? Text(
                                    s.id,
                                    style: const TextStyle(
                                      color: Color(0xFF5b616c),
                                      fontSize: 11,
                                      fontFamily: 'monospace',
                                    ),
                                  )
                                : null,
                            trailing: const Icon(
                              Icons.send_rounded,
                              color: Color(0xFF6aa3ff),
                              size: 18,
                            ),
                            onTap: () => Navigator.pop(context, s),
                          ))
                      .toList(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() => _status = '发送到 ${picked.id}…');
    try {
      await widget.mgr.service.sendMemoLine(widget.directory.id, picked.id, text);
      if (!mounted) return;
      final now = TimeOfDay.fromDateTime(DateTime.now());
      setState(() => _status = '已发送到 ${picked.id} · ${now.format(context)}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _status = '发送失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0f1115),
        foregroundColor: const Color(0xFFf2f4f7),
        title: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '📝 ${widget.directory.name}',
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            if (_path.isNotEmpty)
              Text(
                _path,
                style: const TextStyle(
                  color: Color(0xFF5b616c),
                  fontSize: 10,
                  fontFamily: 'monospace',
                ),
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.send_rounded),
            tooltip: '发送当前行',
            onPressed: _loading ? null : _sendCurrentLine,
          ),
          IconButton(
            icon: const Icon(Icons.save_rounded),
            tooltip: '保存',
            onPressed: _loading ? null : _save,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    maxLines: null,
                    expands: true,
                    textAlignVertical: TextAlignVertical.top,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontFamily: 'monospace',
                      fontSize: 14,
                      height: 1.5,
                    ),
                    decoration: const InputDecoration(
                      border: InputBorder.none,
                      contentPadding: EdgeInsets.all(12),
                      hintText: '在这里写备忘…\n例：\n# todo\n- [ ] 任务一\n- [ ] 任务二',
                      hintStyle: TextStyle(color: Color(0xFF5b616c)),
                    ),
                  ),
                ),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: const BoxDecoration(
                    color: Color(0xFF0f1115),
                    border: Border(top: BorderSide(color: Color(0xFF14171c))),
                  ),
                  child: Text(
                    _status,
                    style: const TextStyle(
                      color: Color(0xFF5b616c),
                      fontSize: 11,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}
