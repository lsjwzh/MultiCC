import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 消息快照分享。镜像网页端「导出选定消息为静态分享」：拉取会话的权威历史，
/// 让用户按下标多选消息，可选设置密码，生成一个只读分享链接 `/share/[token]`。
class ShareMessagesScreen extends StatefulWidget {
  final String sessionId;
  final SettingsService settings;
  const ShareMessagesScreen(
      {super.key, required this.sessionId, required this.settings});

  @override
  State<ShareMessagesScreen> createState() => _ShareMessagesScreenState();
}

class _ShareMessagesScreenState extends State<ShareMessagesScreen> {
  late final SessionService _svc = SessionService(settings: widget.settings);
  final TextEditingController _password = TextEditingController();

  List<Map<String, dynamic>> _messages = [];
  final Set<int> _selected = {};
  bool _loading = true;
  String? _error;
  bool _creating = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final msgs = await _svc.fetchHistory(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _messages = msgs;
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

  void _toggle(int i) {
    setState(() {
      if (_selected.contains(i)) {
        _selected.remove(i);
      } else {
        _selected.add(i);
      }
    });
  }

  void _selectAll() {
    setState(() {
      if (_selected.length == _messages.length) {
        _selected.clear();
      } else {
        _selected
          ..clear()
          ..addAll(List.generate(_messages.length, (i) => i));
      }
    });
  }

  Future<void> _create() async {
    if (_selected.isEmpty) return;
    setState(() => _creating = true);
    try {
      final indices = _selected.toList()..sort();
      final r = await _svc.shareMessages(
        widget.sessionId,
        indices: indices,
        password: _password.text.trim().isEmpty ? null : _password.text.trim(),
      );
      if (!mounted) return;
      final url = (r['url'] ?? '').toString();
      await _showResult(url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('创建失败：$e')));
      }
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _showResult(String url) async {
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('分享链接已创建'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('已分享 ${_selected.length} 条消息（只读）。',
                style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            SelectableText(url,
                style: const TextStyle(
                    color: AppColors.blue, fontSize: 12.5, fontFamily: 'monospace')),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: url));
              ScaffoldMessenger.of(context)
                  .showSnackBar(const SnackBar(content: Text('链接已复制')));
              Navigator.pop(context);
            },
            child: const Text('复制链接', style: TextStyle(color: AppColors.accent)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭', style: TextStyle(color: AppColors.muted)),
          ),
        ],
      ),
    );
    if (mounted) Navigator.pop(context); // leave the share screen after success
  }

  String _preview(Map<String, dynamic> m) {
    final c = (m['content'] ?? '').toString().trim().replaceAll('\n', ' ');
    if (c.isNotEmpty) return c;
    final tools = (m['tools'] as List? ?? []);
    if (tools.isNotEmpty) {
      final names = tools.map((t) => (t['name'] ?? '').toString()).where((s) => s.isNotEmpty);
      return '🔧 ${names.join(', ')}';
    }
    return '(空消息)';
  }

  @override
  Widget build(BuildContext context) {
    final allSelected = _messages.isNotEmpty && _selected.length == _messages.length;
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('分享选定消息'),
        actions: [
          if (!_loading && _error == null && _messages.isNotEmpty)
            TextButton(
              onPressed: _selectAll,
              child: Text(allSelected ? '取消全选' : '全选',
                  style: const TextStyle(color: AppColors.accent, fontSize: 13)),
            ),
        ],
      ),
      bottomNavigationBar: (_loading || _error != null)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      controller: _password,
                      style: const TextStyle(color: AppColors.text, fontSize: 14),
                      decoration: InputDecoration(
                        isDense: true,
                        prefixIcon: const Icon(Icons.lock_outline_rounded,
                            size: 18, color: AppColors.faint),
                        hintText: '访问密码（可选，留空则公开只读）',
                        hintStyle: const TextStyle(color: AppColors.faint, fontSize: 12.5),
                        filled: true,
                        fillColor: AppColors.panel2,
                        enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(color: AppColors.line)),
                        focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide: const BorderSide(color: AppColors.accent)),
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      height: 48,
                      child: ElevatedButton.icon(
                        onPressed:
                            (_selected.isEmpty || _creating) ? null : _create,
                        icon: _creating
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2, color: Color(0xFFffffff)))
                            : const Icon(Icons.ios_share_rounded, size: 18),
                        label: Text(_selected.isEmpty
                            ? '请选择消息'
                            : '生成分享链接（${_selected.length}）'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.cloud_off_rounded, size: 42, color: AppColors.faint),
                        const SizedBox(height: 14),
                        Text('加载历史失败\n$_error',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                                color: AppColors.muted, fontSize: 13, height: 1.5)),
                        const SizedBox(height: 16),
                        OutlinedButton(
                          onPressed: _load,
                          style: OutlinedButton.styleFrom(
                              side: const BorderSide(color: AppColors.lineStrong)),
                          child: const Text('重试', style: TextStyle(color: AppColors.accent)),
                        ),
                      ],
                    ),
                  ),
                )
              : _messages.isEmpty
                  ? const Center(
                      child: Text('该会话暂无历史消息',
                          style: TextStyle(color: AppColors.faint, fontSize: 13)))
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                      itemCount: _messages.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final m = _messages[i];
                        final isUser = (m['role'] ?? '') == 'user';
                        final sel = _selected.contains(i);
                        return InkWell(
                          onTap: () => _toggle(i),
                          borderRadius: BorderRadius.circular(12),
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: sel
                                  ? AppColors.accentDark.withValues(alpha: 0.12)
                                  : AppColors.panel,
                              border: Border.all(
                                  color: sel ? AppColors.accent : AppColors.line),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  sel
                                      ? Icons.check_circle_rounded
                                      : Icons.radio_button_unchecked_rounded,
                                  size: 20,
                                  color: sel ? AppColors.accent : AppColors.faint,
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        isUser ? '我' : 'Claude',
                                        style: TextStyle(
                                          color: isUser ? AppColors.blue : AppColors.claude,
                                          fontSize: 11.5,
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                      const SizedBox(height: 3),
                                      Text(
                                        _preview(m),
                                        maxLines: 3,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                            color: AppColors.text, fontSize: 13, height: 1.4),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}
