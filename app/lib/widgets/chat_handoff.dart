import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../services/settings_service.dart';
import '../utils/format.dart';

/// 会话交接包（handoff bundle）的 App 入口：导出与导入两个对话框，挂在聊天页
/// 「分享会话」卡片的顶部（对齐 Web 的 public/chat-handoff.js —— URL、载荷与
/// 报告文案都以那份为准）。三层载荷（env / context / code）的判定全在服务端
/// （src/routes/session-bundle.js），这里只把接口变成能点的界面。
///
/// 纯函数（[handoffExportUri] / [handoffImportQuery] / [handoffIsZip] /
/// [handoffDownloadName] / [handoffReportLines]）不碰网络，可单测。

// ── 与 Web 同值的常量 ────────────────────────────────────────────────────────

/// 执行环境是全量的：machine / cli / shared 这三层本来就是「别的会话也在读」
/// 的层，少带一层就不是复刻环境了。context / code 层由 context=0、git=0 单独关。
const String kHandoffExportScopes = 'session,shared,task,cli,machine';

const int kHandoffMinPassphrase = 6;

// 分享对话框同一套浅色皮肤（chat_screen.dart 的 share dialog）。
const Color _kBg = Color(0xFFf8fbff);
const Color _kBorder = Color(0xFFdce6f1);
const Color _kText = Color(0xFF233249);
const Color _kMuted = Color(0xFF6f8096);
const Color _kPrimary = Color(0xFF2ba67a);
const Color _kLink = Color(0xFF005cc5);
const Color _kError = Color(0xFFb64e43);

// ── 纯函数（无网络，可单测） ─────────────────────────────────────────────────

/// 导出 URL（相对路径 + query），镜像 Web 的 `exportUrl()`：
/// `GET /api/sessions/{id}/bundle.zip?passphrase=..&scopes=..&skillsMode=auto`，
/// 「只导执行环境」时追加 `context=0&git=0`。
Uri handoffExportUri(
  String sessionId,
  String passphrase, {
  bool envOnly = false,
}) {
  final query = <String, String>{
    'passphrase': passphrase,
    'scopes': kHandoffExportScopes,
    'skillsMode': 'auto',
  };
  if (envOnly) {
    query['context'] = '0';
    query['git'] = '0';
  }
  return Uri.parse(
    '/api/sessions/${Uri.encodeComponent(sessionId)}/bundle.zip',
  ).replace(queryParameters: query);
}

/// 导入落点 query（zip 走 import-zip，参数全在 query 上），镜像 Web 的
/// `importQuery()`：target 恰好三选一 —— env / new(dirId) / merge(sessionId)。
Map<String, String> handoffImportQuery({
  required String passphrase,
  required String target,
  String? dirId,
  String? targetSessionId,
}) {
  final query = <String, String>{'passphrase': passphrase};
  if (target == 'env') {
    query['envOnly'] = '1';
  } else if (target == 'merge') {
    query['targetSessionId'] = targetSessionId ?? '';
  } else {
    query['dirId'] = dirId ?? '';
  }
  return query;
}

/// zip 与 JSON 两种容器都能收：按魔数判断，不信文件扩展名（同 Web `isZip`）。
bool handoffIsZip(Uint8List bytes) =>
    bytes.length > 1 && bytes[0] == 0x50 && bytes[1] == 0x4b;

/// 文件名由服务端给（导出时间戳，故意不含会话 id）；这里只留下安全字符，
/// 不让一个响应头决定落到用户磁盘上的名字（同 Web `downloadName`）。
String handoffDownloadName(
  Map<String, String> headers, {
  String fallback = 'multicc-handoff.zip',
}) {
  final header = headers['content-disposition'] ?? '';
  final match = RegExp(
    r'filename="?([^";]+)"?',
    caseSensitive: false,
  ).firstMatch(header);
  var name = match?.group(1) ?? '';
  try {
    name = Uri.decodeComponent(name);
  } catch (_) {
    // 保留原始串，交给下面的白名单再判一次。
  }
  name = name.trim();
  return RegExp(r'^[\w.-]+\.zip$').hasMatch(name) ? name : fallback;
}

/// 导入报告逐行文案，镜像 Web 的 `reportText()`（首行是 handoffImportDone
/// 标题）。name 为 `'*'` 的 skip 是「整个 scope 在这台机器上没有落点」，与
/// 「同名文件本机已有」这种逐文件跳过不是一回事：前者必须原样念给用户。
List<String> handoffReportLines(Map<String, dynamic> body) {
  final restored = _asMap(body['restored']);
  final scopes = _asMap(restored['memoryScopes']);
  var written = 0;
  var skipped = 0;
  final unresolved = <String>[];
  scopes.forEach((scope, raw) {
    final entry = _asMap(raw);
    final w = entry['written'];
    if (w is List) written += w.length;
    final skipList = entry['skipped'];
    if (skipList is List) {
      skipped += skipList.length;
      for (final item in skipList) {
        final m = _asMap(item);
        final reason = (m['reason'] ?? '').toString();
        if (m['name'] == '*' && reason.isNotEmpty) {
          unresolved.add('$scope: $reason');
        }
      }
    }
  });

  final mode = (body['mode'] ?? '').toString();
  final modeLabel =
      mode == 'env'
          ? t('handoffTargetEnv')
          : mode == 'merge'
          ? t('handoffTargetMerge')
          : t('handoffTargetNew');
  final lines = <String>[t('handoffImportDone', {'mode': modeLabel})];

  final sessionId = body['sessionId']?.toString() ?? '';
  if (sessionId.isNotEmpty) {
    lines.add(t('handoffReportSession', {'id': sessionId}));
  }
  final messages = restored['messages'];
  if (messages is num && messages != 0) {
    lines.add(t('handoffReportMessages', {'n': '${messages.toInt()}'}));
  }
  lines.add(
    t('handoffReportMemory', {'written': '$written', 'skipped': '$skipped'}),
  );
  lines.addAll(unresolved);

  final skills = restored['skills'];
  if (skills is List && skills.isNotEmpty) {
    final detail = skills
        .map((skill) {
          final m = _asMap(skill);
          return '${m['name']} (${m['status']})';
        })
        .join(', ');
    lines.add('${t('handoffReportSkills', {'n': '${skills.length}'})} — $detail');
  }
  final assets = _asMap(restored['assets']);
  final assetsRestored = assets['restored'];
  if (assetsRestored is num && assetsRestored != 0) {
    lines.add(
      t('handoffReportAssets', {'n': '${assetsRestored.toInt()}'}),
    );
  }
  if (restored['gitRestored'] == true) {
    lines.add(t('handoffReportGitOk'));
  } else {
    final note = (restored['gitNote'] ?? '').toString();
    if (note.isNotEmpty) lines.add(t('handoffReportGit', {'note': note}));
  }
  return lines;
}

/// [handoffReportLines] 拼成一个多行字符串。
String handoffReportText(Map<String, dynamic> body) =>
    handoffReportLines(body).join('\n');

Map<String, dynamic> _asMap(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : const <String, dynamic>{};

/// 鉴权与 base url 完全照 `services/session_service.dart`：
/// `X-Access-Token` 头 + `settings.buildHttpUrl(path)`。
Map<String, String> _handoffHeaders(
  SettingsService settings, {
  String contentType = 'application/json',
}) {
  final h = <String, String>{'Content-Type': contentType};
  if (settings.token.isNotEmpty) {
    h['X-Access-Token'] = settings.token;
  }
  return h;
}

String _bodyErrorText(http.Response res) {
  final text = res.body;
  try {
    final decoded = jsonDecode(text);
    if (decoded is Map && decoded['error'] != null) {
      return decoded['error'].toString();
    }
  } catch (_) {
    // 隧道 / 代理可能回 HTML；退回原文。
  }
  return text.isNotEmpty ? text : '${res.statusCode}';
}

String _cleanError(Object error) {
  final s = error.toString();
  return s.startsWith('Exception: ') ? s.substring('Exception: '.length) : s;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/// 导出交接包对话框。[settings] / [httpClient] 可注入（测试用 MockClient）；
/// 生产调用留空，走 SettingsService 单例与 package:http。
Future<void> showHandoffExportDialog(
  BuildContext context, {
  required String sessionId,
  SettingsService? settings,
  http.Client? httpClient,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _HandoffExportDialog(
      sessionId: sessionId,
      settings: settings,
      httpClient: httpClient,
    ),
  );
}

/// 导入交接包对话框。[currentSessionId] 非空时才给「并入当前会话」这一档
/// （同 Web：merge 落点就是打开对话框时所在的会话）。
Future<void> showHandoffImportDialog(
  BuildContext context, {
  String? currentSessionId,
  SettingsService? settings,
  http.Client? httpClient,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _HandoffImportDialog(
      currentSessionId: currentSessionId,
      settings: settings,
      httpClient: httpClient,
    ),
  );
}

/// 「分享会话」对话框顶部的两颗描边按钮（📦 导出 / 📥 导入），对齐 Web
/// share 卡片的 mode row：点一下先关掉分享对话框，再开对应的交接包对话框。
/// [pageContext] 是页面级 context（分享对话框关掉后依然有效），
/// [dialogContext] 是分享对话框自己的 context（用来 pop 它）。
Widget handoffShareDialogRow(
  BuildContext pageContext,
  BuildContext dialogContext, {
  required String sessionId,
  required SettingsService settings,
}) {
  Future<void> open(bool export) async {
    Navigator.of(dialogContext).pop();
    if (export) {
      await showHandoffExportDialog(
        pageContext,
        sessionId: sessionId,
        settings: settings,
      );
    } else {
      await showHandoffImportDialog(
        pageContext,
        currentSessionId: sessionId,
        settings: settings,
      );
    }
  }

  Widget button(String key, String label, bool export) => Expanded(
    child: OutlinedButton(
      key: ValueKey(key),
      onPressed: () => open(export),
      style: OutlinedButton.styleFrom(
        foregroundColor: _kLink,
        side: const BorderSide(color: _kBorder),
        padding: const EdgeInsets.symmetric(vertical: 10),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      child: Text(
        label,
        style: const TextStyle(fontSize: 12),
        overflow: TextOverflow.ellipsis,
      ),
    ),
  );

  return Row(
    children: [
      button('handoff-share-export', '📦 ${t('handoffExport')}', true),
      const SizedBox(width: 8),
      button('handoff-share-import', '📥 ${t('handoffImport')}', false),
    ],
  );
}

// ── 共用外观 ────────────────────────────────────────────────────────────────

InputDecoration _fieldDecoration() => const InputDecoration(
  filled: true,
  fillColor: _kBg,
  contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
  border: OutlineInputBorder(
    borderRadius: BorderRadius.all(Radius.circular(8)),
    borderSide: BorderSide(color: _kBorder),
  ),
  enabledBorder: OutlineInputBorder(
    borderRadius: BorderRadius.all(Radius.circular(8)),
    borderSide: BorderSide(color: _kBorder),
  ),
);

Future<SettingsService> _resolveSettings(SettingsService? injected) async =>
    injected ??
    SettingsService.current ??
    await SettingsService.getInstance();

// ── 导出对话框 ──────────────────────────────────────────────────────────────

class _HandoffExportDialog extends StatefulWidget {
  const _HandoffExportDialog({
    required this.sessionId,
    this.settings,
    this.httpClient,
  });

  final String sessionId;
  final SettingsService? settings;
  final http.Client? httpClient;

  @override
  State<_HandoffExportDialog> createState() => _HandoffExportDialogState();
}

class _HandoffExportDialogState extends State<_HandoffExportDialog> {
  final TextEditingController _passCtrl = TextEditingController();
  bool _envOnly = false;
  bool _busy = false;
  String? _error;
  String? _done;

  @override
  void dispose() {
    _passCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final passphrase = _passCtrl.text;
    if (passphrase.length < kHandoffMinPassphrase) {
      setState(() => _error = t('handoffNeedPassphrase'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _done = null;
    });
    final settings = await _resolveSettings(widget.settings);
    final ownsClient = widget.httpClient == null;
    final client = widget.httpClient ?? http.Client();
    try {
      final uri = Uri.parse(
        settings.buildHttpUrl(
          handoffExportUri(
            widget.sessionId,
            passphrase,
            envOnly: _envOnly,
          ).toString(),
        ),
      );
      final res = await client
          .get(uri, headers: _handoffHeaders(settings))
          .timeout(const Duration(seconds: 120));
      if (res.statusCode != 200) throw Exception(_bodyErrorText(res));
      final bytes = res.bodyBytes;
      final name = handoffDownloadName(res.headers);
      final saved = await FilePicker.platform.saveFile(
        dialogTitle: t('handoffExport'),
        fileName: name,
        bytes: bytes,
        type: FileType.custom,
        allowedExtensions: const ['zip'],
      );
      if (!mounted) return;
      // 用户取消保存：不算错误，对话框留在原地。
      if (saved == null) {
        setState(() => _busy = false);
        return;
      }
      // 桌面端 file_picker 只回路径、不写字节；移动端已经写过，重写一遍等价。
      try {
        await File(saved).writeAsBytes(bytes, flush: true);
      } catch (_) {
        // 插件已落盘的路径写不进去时不拦成功文案。
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        _done = t('handoffExportDone', {
          'name': name,
          'size': formatBytes(bytes.length),
        });
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _cleanError(error);
      });
    } finally {
      if (ownsClient) client.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: _kBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _kBorder),
      ),
      title: Text(
        t('handoffExport'),
        style: const TextStyle(color: _kText, fontSize: 16),
      ),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('handoffExportDesc'),
                style: const TextStyle(
                  color: _kMuted,
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 14),
              Text(
                t('handoffPassphrase'),
                style: const TextStyle(color: _kMuted, fontSize: 12),
              ),
              const SizedBox(height: 6),
              TextField(
                key: const ValueKey('handoff-export-pass'),
                controller: _passCtrl,
                obscureText: true,
                enabled: !_busy,
                style: const TextStyle(color: _kText, fontSize: 14),
                decoration: _fieldDecoration(),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Checkbox(
                    key: const ValueKey('handoff-export-envonly'),
                    value: _envOnly,
                    onChanged:
                        _busy
                            ? null
                            : (v) => setState(() => _envOnly = v == true),
                    activeColor: _kPrimary,
                    side: const BorderSide(color: _kBorder),
                  ),
                  Expanded(
                    child: Text(
                      t('handoffEnvOnly'),
                      style: const TextStyle(color: _kMuted, fontSize: 12),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                height: 42,
                child: ElevatedButton(
                  key: const ValueKey('handoff-export-submit'),
                  onPressed: _busy ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _kPrimary,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: const Color(0x992ba67a),
                  ),
                  child: Text(
                    _busy ? t('handoffExporting') : t('handoffExportRun'),
                  ),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  style: const TextStyle(color: _kError, fontSize: 12),
                ),
              ],
              if (_done != null) ...[
                const SizedBox(height: 8),
                Text(
                  _done!,
                  style: const TextStyle(
                    color: _kPrimary,
                    fontSize: 12,
                    height: 1.5,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(
            t('close'),
            style: const TextStyle(color: _kMuted),
          ),
        ),
      ],
    );
  }
}

// ── 导入对话框 ──────────────────────────────────────────────────────────────

class _DirOption {
  const _DirOption(this.id, this.label);
  final String id;
  final String label;
}

class _HandoffImportDialog extends StatefulWidget {
  const _HandoffImportDialog({
    this.currentSessionId,
    this.settings,
    this.httpClient,
  });

  final String? currentSessionId;
  final SettingsService? settings;
  final http.Client? httpClient;

  @override
  State<_HandoffImportDialog> createState() => _HandoffImportDialogState();
}

class _HandoffImportDialogState extends State<_HandoffImportDialog> {
  final TextEditingController _passCtrl = TextEditingController();
  PlatformFile? _file;
  String _target = 'env';
  List<_DirOption> _dirs = const [];
  String? _dirId;
  bool _dirsLoaded = false;
  bool _dirsLoading = false;
  String? _dirsError;
  bool _busy = false;
  String? _error;
  String? _report;

  @override
  void dispose() {
    _passCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles(
      withData: true,
      type: FileType.custom,
      allowedExtensions: const ['zip', 'json'],
    );
    if (result == null || result.files.isEmpty) return;
    if (!mounted) return;
    setState(() {
      _file = result.files.first;
      _error = null;
    });
  }

  void _setTarget(String value) {
    setState(() {
      _target = value;
      _error = null;
    });
    // 一选中就去取目录：等到点「导入」才取，用户看到的是「加载中…」占位，
    // 而那一下点击已经用第一个目录提交了 —— 等于没得选（同 Web）。
    if (value == 'new') _ensureDirectories();
  }

  Future<void> _ensureDirectories() async {
    if (_dirsLoaded || _dirsLoading) return;
    setState(() {
      _dirsLoading = true;
      _dirsError = null;
    });
    final settings = await _resolveSettings(widget.settings);
    final ownsClient = widget.httpClient == null;
    final client = widget.httpClient ?? http.Client();
    try {
      final res = await client
          .get(
            Uri.parse(settings.buildHttpUrl('/api/directories')),
            headers: _handoffHeaders(settings),
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) throw Exception(_bodyErrorText(res));
      final decoded = jsonDecode(res.body);
      final list =
          decoded is List
              ? decoded
              : (decoded is Map && decoded['directories'] is List
                  ? decoded['directories'] as List
                  : const []);
      final options = <_DirOption>[];
      for (final entry in list) {
        if (entry is! Map) continue;
        final id = (entry['id'] ?? '').toString();
        if (id.isEmpty) continue;
        final name = (entry['name'] ?? '').toString();
        final path = (entry['path'] ?? '').toString();
        options.add(
          _DirOption(id, name.isNotEmpty ? name : (path.isNotEmpty ? path : id)),
        );
      }
      if (!mounted) return;
      setState(() {
        _dirs = options;
        _dirsLoaded = true;
        _dirsLoading = false;
        _dirId ??= options.isNotEmpty ? options.first.id : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _dirsLoading = false;
        _dirsError = _cleanError(error);
      });
    } finally {
      if (ownsClient) client.close();
    }
  }

  Future<void> _submit() async {
    final file = _file;
    if (file == null || file.bytes == null) {
      setState(() => _error = t('handoffNeedFile'));
      return;
    }
    final passphrase = _passCtrl.text;
    if (passphrase.length < kHandoffMinPassphrase) {
      setState(() => _error = t('handoffNeedPassphrase'));
      return;
    }
    String? dirId;
    if (_target == 'new') {
      await _ensureDirectories();
      if (_dirsError != null) {
        if (!mounted) return;
        setState(() => _error = _dirsError);
        return;
      }
      dirId = (_dirId != null && _dirId!.isNotEmpty) ? _dirId : null;
      if (dirId == null) {
        if (!mounted) return;
        setState(() => _error = t('handoffNeedDir'));
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final settings = await _resolveSettings(widget.settings);
    final ownsClient = widget.httpClient == null;
    final client = widget.httpClient ?? http.Client();
    try {
      final bytes = file.bytes!;
      http.Response res;
      if (handoffIsZip(bytes)) {
        final uri = Uri.parse(
          settings.buildHttpUrl('/api/sessions/import-zip'),
        ).replace(
          queryParameters: handoffImportQuery(
            passphrase: passphrase,
            target: _target,
            dirId: dirId,
            targetSessionId: widget.currentSessionId,
          ),
        );
        res = await client
            .post(
              uri,
              headers: _handoffHeaders(settings, contentType: 'application/zip'),
              body: bytes,
            )
            .timeout(const Duration(seconds: 120));
      } else {
        // 旧 JSON 容器：解出来再补上落地参数（同 Web runImport 的 else 分支）。
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map) throw Exception('invalid handoff bundle');
        final payload = Map<String, dynamic>.from(decoded)
          ..['passphrase'] = passphrase;
        if (_target == 'env') {
          payload['envOnly'] = true;
        } else if (_target == 'merge') {
          payload['targetSessionId'] = widget.currentSessionId;
        } else {
          payload['dirId'] = dirId;
        }
        res = await client
            .post(
              Uri.parse(settings.buildHttpUrl('/api/sessions/import')),
              headers: _handoffHeaders(settings),
              body: jsonEncode(payload),
            )
            .timeout(const Duration(seconds: 120));
      }
      Map<String, dynamic> body = const {};
      try {
        final decoded = jsonDecode(utf8.decode(res.bodyBytes));
        if (decoded is Map) body = Map<String, dynamic>.from(decoded);
      } catch (_) {
        // 非 JSON 应答留给下面的状态码判断。
      }
      if (res.statusCode >= 400) {
        throw Exception(
          body['error']?.toString() ??
              (res.body.isNotEmpty ? res.body : '${res.statusCode}'),
        );
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        _report = handoffReportText(body);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _cleanError(error);
      });
    } finally {
      if (ownsClient) client.close();
    }
  }

  Widget _radioRow(String value, String label) {
    return InkWell(
      onTap: _busy ? null : () => _setTarget(value),
      child: Row(
        children: [
          Radio<String>(
            key: ValueKey('handoff-target-$value'),
            value: value,
            groupValue: _target,
            activeColor: _kPrimary,
            onChanged: _busy ? null : (v) {
              if (v != null) _setTarget(v);
            },
          ),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(color: _kText, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final canMerge =
        widget.currentSessionId != null && widget.currentSessionId!.isNotEmpty;
    return AlertDialog(
      backgroundColor: _kBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: _kBorder),
      ),
      title: Text(
        t('handoffImport'),
        style: const TextStyle(color: _kText, fontSize: 16),
      ),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child:
              _report != null
                  ? SelectableText(
                    _report!,
                    key: const ValueKey('handoff-import-report'),
                    style: const TextStyle(
                      color: _kPrimary,
                      fontSize: 12,
                      height: 1.6,
                    ),
                  )
                  : Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        t('handoffImportDesc'),
                        style: const TextStyle(
                          color: _kMuted,
                          fontSize: 12,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 14),
                      OutlinedButton.icon(
                        key: const ValueKey('handoff-import-pick'),
                        onPressed: _busy ? null : _pickFile,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _kLink,
                          side: const BorderSide(color: _kBorder),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        icon: const Icon(Icons.folder_open, size: 16),
                        label: Text(
                          _file?.name ?? t('handoffPickFile'),
                          style: const TextStyle(fontSize: 12),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        t('handoffPassphrase'),
                        style: const TextStyle(color: _kMuted, fontSize: 12),
                      ),
                      const SizedBox(height: 6),
                      TextField(
                        key: const ValueKey('handoff-import-pass'),
                        controller: _passCtrl,
                        obscureText: true,
                        enabled: !_busy,
                        style: const TextStyle(color: _kText, fontSize: 14),
                        decoration: _fieldDecoration(),
                      ),
                      const SizedBox(height: 8),
                      _radioRow('env', t('handoffTargetEnv')),
                      _radioRow('new', t('handoffTargetNew')),
                      if (canMerge) _radioRow('merge', t('handoffTargetMerge')),
                      if (_target == 'new') ...[
                        const SizedBox(height: 8),
                        Text(
                          t('handoffTargetDir'),
                          style: const TextStyle(
                            color: _kMuted,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 6),
                        if (_dirsLoading)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 8),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: _kMuted,
                              ),
                            ),
                          )
                        else if (_dirs.isEmpty)
                          Text(
                            _dirsError ?? t('none'),
                            style: const TextStyle(
                              color: _kError,
                              fontSize: 12,
                            ),
                          )
                        else
                          DropdownButtonFormField<String>(
                            key: const ValueKey('handoff-import-dir'),
                            value: _dirId,
                            isExpanded: true,
                            dropdownColor: _kBg,
                            style: const TextStyle(
                              color: _kText,
                              fontSize: 13,
                            ),
                            decoration: _fieldDecoration(),
                            items:
                                _dirs
                                    .map(
                                      (d) => DropdownMenuItem(
                                        value: d.id,
                                        child: Text(
                                          d.label,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    )
                                    .toList(),
                            onChanged:
                                _busy
                                    ? null
                                    : (v) => setState(() => _dirId = v),
                          ),
                      ],
                      const SizedBox(height: 14),
                      SizedBox(
                        width: double.infinity,
                        height: 42,
                        child: ElevatedButton(
                          key: const ValueKey('handoff-import-submit'),
                          onPressed: _busy ? null : _submit,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: _kPrimary,
                            foregroundColor: Colors.white,
                            disabledBackgroundColor: const Color(0x992ba67a),
                          ),
                          child: Text(
                            _busy ? t('handoffImporting') : t('handoffImportRun'),
                          ),
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          _error!,
                          style: const TextStyle(color: _kError, fontSize: 12),
                        ),
                      ],
                    ],
                  ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(
            t('close'),
            style: const TextStyle(color: _kMuted),
          ),
        ),
      ],
    );
  }
}
