import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../services/settings_service.dart';
import '../theme.dart';

/// File browser for a chat session's working directory.
///
/// Mirrors the web's `files-panel` (public/index.html): starts at the
/// session's cwd via `GET /api/files?session=<id>`, navigates into
/// subdirectories with `GET /api/files?path=<dir>`, and lets the user
/// download / inline-view individual files through `/api/download`.
class FileBrowserScreen extends StatefulWidget {
  final SettingsService settings;
  final String sessionId;
  const FileBrowserScreen({
    super.key,
    required this.settings,
    required this.sessionId,
  });

  @override
  State<FileBrowserScreen> createState() => _FileBrowserScreenState();
}

class _FileBrowserScreenState extends State<FileBrowserScreen> {
  String? _currentPath;
  String? _parentPath;
  List<_FileEntry> _entries = [];
  bool _loading = true;
  String? _error;
  // History stack for the back button — entries are directory paths.
  final List<String> _history = [];

  @override
  void initState() {
    super.initState();
    _load(session: widget.sessionId);
  }

  Map<String, String> get _headers {
    final h = <String, String>{};
    if (widget.settings.token.isNotEmpty) {
      h['X-Access-Token'] = widget.settings.token;
    }
    return h;
  }

  String _downloadUrl(String path, {bool inline = false}) {
    var url = widget.settings.buildHttpUrl(
      '/api/download?path=${Uri.encodeQueryComponent(path)}',
    );
    if (inline) url += '&inline=1';
    if (widget.settings.token.isNotEmpty) {
      url += '&token=${Uri.encodeQueryComponent(widget.settings.token)}';
    }
    return url;
  }

  Future<void> _load({String? session, String? path}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      var urlStr = widget.settings.buildHttpUrl('/api/files');
      final params = <String, String>{};
      if (path != null) {
        params['path'] = path;
      } else if (session != null) {
        params['session'] = session;
      }
      if (params.isNotEmpty) {
        urlStr +=
            '?${params.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&')}';
      }
      final res = await http
          .get(Uri.parse(urlStr), headers: _headers)
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) {
        throw Exception('HTTP ${res.statusCode}');
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final files = (data['files'] as List? ?? [])
          .map((j) => _FileEntry.fromJson(j as Map<String, dynamic>))
          .toList();
      // Folders first, then alphabetical — matches web ordering.
      files.sort((a, b) {
        if (a.isDir != b.isDir) return a.isDir ? -1 : 1;
        return a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
      setState(() {
        _currentPath = data['path']?.toString();
        _parentPath = data['parent']?.toString();
        _entries = files;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _openDir(String path) {
    if (_currentPath != null) _history.add(_currentPath!);
    _load(path: path);
  }

  bool _popHistory() {
    if (_history.isEmpty) return false;
    final prev = _history.removeLast();
    _load(path: prev);
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _history.isEmpty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _popHistory();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF070809),
        appBar: AppBar(
          backgroundColor: const Color(0xFF0f1115),
          foregroundColor: const Color(0xFFe7eaee),
          title: const Text('文件浏览', style: TextStyle(fontSize: 16)),
          actions: [
            IconButton(
              icon: const Icon(Icons.refresh_rounded, size: 20),
              tooltip: '刷新',
              onPressed: () {
                if (_currentPath != null) {
                  _load(path: _currentPath);
                } else {
                  _load(session: widget.sessionId);
                }
              },
            ),
          ],
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(36),
            child: Container(
              color: const Color(0xFF0a0c10),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              width: double.infinity,
              child: Row(
                children: [
                  const Icon(Icons.folder_open,
                      size: 14, color: Color(0xFF6aa3ff)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _currentPath ?? widget.sessionId,
                      style: const TextStyle(
                          color: Color(0xFF8a909b),
                          fontSize: 11,
                          fontFamily: 'monospace'),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        body: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(color: Color(0xFF6aa3ff)),
      );
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline,
                color: Color(0xFFff6b63), size: 40),
            const SizedBox(height: 12),
            Text(_error!,
                style:
                    const TextStyle(color: Color(0xFF8a909b), fontSize: 13),
                textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () {
                if (_currentPath != null) {
                  _load(path: _currentPath);
                } else {
                  _load(session: widget.sessionId);
                }
              },
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }
    final list = <Widget>[];
    // ".." up entry
    if (_parentPath != null && _parentPath!.isNotEmpty) {
      list.add(_FileTile(
        name: '..',
        isDir: true,
        isUp: true,
        onTap: () {
          if (_currentPath != null) _history.add(_currentPath!);
          _load(path: _parentPath);
        },
      ));
      list.add(const Divider(height: 1, color: Color(0xFF14171c)));
    }
    if (_entries.isEmpty && list.isEmpty) {
      list.add(const Padding(
        padding: EdgeInsets.all(32),
        child: Center(
          child: Text('Fleet为空',
              style: TextStyle(color: Color(0xFF5b616c), fontSize: 13)),
        ),
      ));
    }
    for (final f in _entries) {
      list.add(_FileTile(
        name: f.name,
        isDir: f.isDir,
        size: f.size,
        onTap: f.isDir ? () => _openDir(f.path) : null,
        onDownload: f.isDir
            ? null
            : () => _openUrl(_downloadUrl(f.path), f.name),
        onView: f.isDir || !_isInlineExt(f.name)
            ? null
            : () => _openUrl(_downloadUrl(f.path, inline: true), f.name),
      ));
      list.add(const Divider(height: 1, color: Color(0xFF14171c)));
    }
    return ListView(children: list);
  }

  Future<void> _openUrl(String url, String name) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('无法打开: $name')),
      );
    }
  }
}

/// Extensions that can be previewed inline in the browser (open via 👁).
const _inlineExts = {
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp',
  'pdf', 'txt', 'md', 'json', 'log', 'csv', 'html',
};
bool _isInlineExt(String name) =>
    _inlineExts.contains(_ext(name));
String _ext(String name) {
  final i = name.lastIndexOf('.');
  return i < 0 ? '' : name.substring(i + 1).toLowerCase();
}

class _FileEntry {
  final String name;
  final String path;
  final bool isDir;
  final int? size;
  const _FileEntry({
    required this.name,
    required this.path,
    required this.isDir,
    this.size,
  });

  factory _FileEntry.fromJson(Map<String, dynamic> j) => _FileEntry(
        name: j['name']?.toString() ?? '',
        path: j['path']?.toString() ?? '',
        isDir: j['isDir'] == true || j['is_dir'] == true,
        size: (j['size'] as num?)?.toInt(),
      );
}

String _formatSize(int? bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return '${bytes}B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
  if (bytes < 1024 * 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)}MB';
  }
  return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)}GB';
}

class _FileTile extends StatelessWidget {
  final String name;
  final bool isDir;
  final bool isUp;
  final int? size;
  final VoidCallback? onTap;
  final VoidCallback? onDownload;
  final VoidCallback? onView;
  const _FileTile({
    required this.name,
    required this.isDir,
    this.isUp = false,
    this.size,
    this.onTap,
    this.onDownload,
    this.onView,
  });

  @override
  Widget build(BuildContext context) {
    final icon = isUp
        ? '⬆️'
        : isDir
            ? '📁'
            : _fileIcon(name);
    return ListTile(
      dense: true,
      visualDensity: VisualDensity.compact,
      leading: Text(icon, style: const TextStyle(fontSize: 18)),
      title: Text(
        name,
        style: const TextStyle(color: AppColors.text, fontSize: 14),
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: (!isDir && size != null)
          ? Text(_formatSize(size),
              style: const TextStyle(
                  color: AppColors.muted, fontSize: 11, fontFamily: 'monospace'))
          : null,
      trailing: isDir
          ? (onTap != null
              ? const Icon(Icons.chevron_right,
                  color: AppColors.muted, size: 20)
              : null)
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (onView != null)
                  IconButton(
                    icon: const Icon(Icons.visibility_outlined,
                        size: 18, color: AppColors.accent),
                    tooltip: '预览',
                    onPressed: onView,
                    visualDensity: VisualDensity.compact,
                  ),
                if (onDownload != null)
                  IconButton(
                    icon: const Icon(Icons.download_outlined,
                        size: 18, color: AppColors.muted),
                    tooltip: '下载',
                    onPressed: onDownload,
                    visualDensity: VisualDensity.compact,
                  ),
              ],
            ),
      onTap: onTap,
    );
  }
}

String _fileIcon(String name) {
  final e = _ext(name);
  const img = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'};
  const video = {'mp4', 'webm', 'mov', 'avi'};
  const audio = {'mp3', 'wav', 'ogg', 'flac', 'm4a'};
  const code = {
    'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h',
    'cs', 'sh', 'bash', 'rb', 'php', 'dart'
  };
  const doc = {'pdf', 'doc', 'docx'};
  const archive = {'zip', 'tar', 'gz', '7z', 'rar', 'bz2'};
  if (img.contains(e)) return '🖼️';
  if (video.contains(e)) return '🎬';
  if (audio.contains(e)) return '🎵';
  if (code.contains(e)) return '📄';
  if (doc.contains(e)) return '📕';
  if (archive.contains(e)) return '🗜️';
  if (e == 'apk') return '🤖';
  return '📄';
}
