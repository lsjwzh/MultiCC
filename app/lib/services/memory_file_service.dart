import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';
import '../utils/format.dart';

/// 记忆文件的读写：`GET` / `PUT /api/memory/file?rel=…`。
///
/// 与 Web `public/memory-model.js:240`（`loadFile` / `saveFile`）同一对端点 ——
/// 记忆图谱节点详情里的「编辑」打开的就是它。
///
/// 安全语义（照抄 Web 模型层的判断，不自己发明）：
///   - 服务端把内容按 [maxFileContent] 截断，被截断的文件**只读**：预览绝不能
///     覆盖完整文件；
///   - 读取失败（除 404）时调用方必须禁用保存，避免用空内容覆盖未知文件；
///   - 404 是「文件不存在，保存后创建」，不是错误。
class MemoryFileService {
  MemoryFileService({required this.settings, http.Client? httpClient})
    : _httpClient = httpClient ?? http.Client(),
      _ownsClient = httpClient == null;

  final SettingsService settings;
  final http.Client _httpClient;
  final bool _ownsClient;

  /// Web `MAX_FILE_CONTENT`（`memory-model.js`）与服务端
  /// `MEMORY_FILE_MAX_CHARS` 同一个数：超过就不让编辑，防止覆盖被截断的内容。
  static const int maxFileContent = 200000;

  Future<MemoryFilePayload> load(String rel) async {
    final uri = Uri.parse(
      settings.buildHttpUrl('/api/memory/file'),
    ).replace(queryParameters: {'rel': rel});
    final response = await _send(() => _httpClient.get(uri, headers: _headers));
    final body = _decode(response, allow404: true);
    if (response.statusCode == 404) {
      throw MemoryFileException('文件不存在', status: 404);
    }
    return MemoryFilePayload.fromJson(body);
  }

  Future<MemoryFilePayload> save(String rel, String content) async {
    if (content.length > maxFileContent) {
      throw MemoryFileException(
        '内容超过可安全编辑上限（$maxFileContent 字符）',
        status: 413,
      );
    }
    final uri = Uri.parse(settings.buildHttpUrl('/api/memory/file'));
    final response = await _send(
      () => _httpClient.put(
        uri,
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'rel': rel, 'content': content}),
      ),
    );
    return MemoryFilePayload.fromJson(_decode(response));
  }

  /// 删除一份记忆文件。Web `memory-controller.js:312` 的 `deleteMemFile()` ——
  /// 确认文案由界面负责（Web 也用 `confirm()` 先说清楚不可恢复）。
  Future<void> delete(String rel) async {
    final uri = Uri.parse(settings.buildHttpUrl('/api/memory/file'));
    final response = await _send(
      () => _httpClient.delete(
        uri,
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'rel': rel}),
      ),
    );
    // DELETE 回 `{ok:true}`，服务端对「本来就不存在」也回 200（幂等）。
    _decode(response);
  }

  Map<String, String> get _headers => {
    'Accept': 'application/json',
    if (settings.token.isNotEmpty) 'X-Access-Token': settings.token,
  };

  Future<http.Response> _send(Future<http.Response> Function() run) async {
    try {
      return await run().timeout(const Duration(seconds: 30));
    } catch (err) {
      throw MemoryFileException('$err');
    }
  }

  Map<String, dynamic> _decode(http.Response response, {bool allow404 = false}) {
    final raw = utf8.decode(response.bodyBytes, allowMalformed: true);
    if (response.statusCode >= 400) {
      if (allow404 && response.statusCode == 404) return const {};
      throw MemoryFileException(
        _httpError(response.statusCode, raw),
        status: response.statusCode,
      );
    }
    try {
      final body = jsonDecode(raw);
      if (body is Map) return Map<String, dynamic>.from(body);
    } catch (_) {
      // 落到下面那句。
    }
    throw MemoryFileException('服务端返回了无法识别的数据（HTTP ${response.statusCode}）。');
  }

  static String _httpError(int status, String raw) {
    try {
      final body = jsonDecode(raw);
      if (body is Map) {
        final msg = body['message'] ?? body['error'] ?? body['code'];
        if (msg != null && msg.toString().trim().isNotEmpty) {
          return msg.toString();
        }
      }
    } catch (_) {
      // 非 JSON 的错误体没有可提取的信息。
    }
    return 'HTTP $status';
  }

  void dispose() {
    if (_ownsClient) _httpClient.close();
  }
}

class MemoryFileException implements Exception {
  MemoryFileException(this.message, {this.status});

  final String message;
  final int? status;

  @override
  String toString() => message;
}

/// 一份记忆文件。[readOnly] / [contentTruncated] 由调用方转成编辑器状态。
class MemoryFilePayload {
  const MemoryFilePayload({
    this.rel = '',
    this.path = '',
    this.name = '',
    this.content = '',
    this.size = 0,
    this.tokens = 0,
    this.mtime,
    this.originalLength = 0,
    this.contentTruncated = false,
    this.readOnly = false,
  });

  final String rel;
  final String path;
  final String name;
  final String content;
  final int size;
  final int tokens;
  final String? mtime;
  final int originalLength;
  final bool contentTruncated;
  final bool readOnly;

  bool get hasContent => content.isNotEmpty;

  factory MemoryFilePayload.fromJson(Map<String, dynamic> json) {
    final rawContent = json['content'] is String
        ? json['content'] as String
        : '';
    // 服务端不该发超长内容，但万一发了也不能让预览被当成完整文件。
    final content = rawContent.length > MemoryFileService.maxFileContent
        ? rawContent.substring(0, MemoryFileService.maxFileContent)
        : rawContent;
    final reported = _int(json['originalLength']);
    final originalLength = content.length > reported
        ? content.length
        : reported;
    final truncated =
        json['contentTruncated'] == true ||
        originalLength > MemoryFileService.maxFileContent;
    return MemoryFilePayload(
      rel: _str(json['rel']),
      path: _str(json['path']),
      name: _str(json['name']),
      content: content,
      size: _int(json['size']),
      tokens: _int(json['tokens']),
      mtime: json['mtime'] == null ? null : _str(json['mtime']),
      originalLength: originalLength,
      contentTruncated: truncated,
      readOnly: json['readOnly'] == true || truncated,
    );
  }
}

/// 与服务端 `estimateMemTokens` 同一个口径：中文≈1.5 token/字，其余≈4 字符/
/// token。只用于编辑时那行实时估算，列表里的 token 数以服务端为准。
int estimateMemoryTokens(String value) {
  if (value.isEmpty) return 0;
  final cjk = RegExp(
    r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]',
  ).allMatches(value).length;
  final others = value.length - cjk;
  final tokens = (cjk * 1.5 + others / 4).round();
  return tokens < 1 ? 1 : tokens;
}

/// B / KB / MB / GB / TB，一律一位小数 —— 就是 [formatBytes]（web 那侧同一份是
/// `public/shared/format.js`）。这个名字留着是因为调用点读起来是「这一格的大小」，
/// 而它比 [formatBytes] 多一条本页的规矩：没有大小画一个 –，不画 0 B。
String formatMemorySize(int bytes) => formatBytes(bytes, placeholder: '–');

String _str(dynamic value) => value == null ? '' : value.toString();

int _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}
