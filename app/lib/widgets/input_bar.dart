import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import 'package:record/record.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:path_provider/path_provider.dart';

import '../i18n.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../models/message.dart';
import '../services/chat_service.dart';
import '../services/voice_dictation_service.dart';
import '../services/voice_launch_service.dart';
import '../utils/dispatch_hint.dart';
import 'chat_runtime_panels.dart';
import 'dispatch_mode_selector.dart';

// Goal precheck dimension keys → short chip labels (web/app kept in sync).
Map<String, String> get _goalDimShort => {
  'objective': t('goalObjective'),
  'criteria': t('goalCriteria'),
  'scope': t('goalScope'),
  'executable': t('goalExecutable'),
};

class InputBar extends StatefulWidget {
  final VoidCallback? onPickSubagent;
  const InputBar({super.key, this.onPickSubagent});

  @override
  State<InputBar> createState() => _InputBarState();
}

class _InputBarState extends State<InputBar> {
  final _ctrl = TextEditingController();
  final _focusNode = FocusNode();
  bool _hasText = false;

  // Attachments: list of {path, name} from server upload
  final List<Map<String, String>> _attachments = [];
  bool _uploading = false;

  // Voice recording
  final _recorder = AudioRecorder();
  bool _isRecording = false;
  bool _isTranscribing = false;

  // 流式听写（/ws/voice）：边说边出字 + 实时润色，对齐 web 的语音 HUD。服务端 ASR
  // 或麦克风不可用时回退到上面的 m4a → /api/voice/stt 整段上传。
  VoiceDictationService? _dictation;
  bool _legacyFallbackArmed = false;

  // Commander 专属的「派发方式」四选一，按会话记住（web 端同一组下拉）。
  DispatchMode _dispatchMode = DispatchMode.defaultMode;
  String _dispatchModeSessionId = '';

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(_onFocusChanged);
    _ctrl.addListener(() {
      final has = _ctrl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  void _onFocusChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _dictation?.removeListener(_onDictationChanged);
    _dictation?.dispose();
    _ctrl.dispose();
    _focusNode.removeListener(_onFocusChanged);
    _focusNode.dispose();
    _recorder.dispose();
    super.dispose();
  }

  // ── File attachment ──

  Future<void> _pickAndUpload() async {
    final provider = context.read<ChatProvider>();
    final settings = provider.settings;

    final result = await FilePicker.platform.pickFiles(withData: true);
    if (result == null || result.files.isEmpty) return;
    final file = result.files.first;
    if (file.bytes == null) return;

    setState(() => _uploading = true);
    try {
      final uri = Uri.parse(settings.buildHttpUrl('/api/upload'));
      final req = http.MultipartRequest('POST', uri);
      if (settings.token.isNotEmpty) {
        req.headers['X-Access-Token'] = settings.token;
      }
      req.files.add(
        http.MultipartFile.fromBytes(
          'file',
          file.bytes!,
          filename: file.name,
          contentType: MediaType('application', 'octet-stream'),
        ),
      );
      final res = await req.send().timeout(const Duration(seconds: 30));
      final body = await res.stream.bytesToString();
      if (res.statusCode == 200) {
        final json = jsonDecode(body) as Map<String, dynamic>;
        setState(() {
          _attachments.add({
            'path': json['path'] as String,
            'name': json['name'] as String? ?? file.name,
          });
        });
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Upload failed: ${res.statusCode}'),
              backgroundColor: const Color(0xFFff6b63),
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload error: $e'),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  // ── Voice recording ──

  // 实时语音改为全局 Qwen 语音网关：这里只向 Host 申请一张 launch 票据，
  // 带上当前会话 id 表示「在这个会话里说话」，Host 会固定投给该会话。只有
  // Dashboard 的全局入口才由 worker-only Router 选择项目和普通 Worker；App
  // 不参与决定，也不携带长期 token。
  Future<void> _openVoiceCall() async {
    final provider = context.read<ChatProvider>();
    final service = VoiceLaunchService(settings: provider.settings);
    final result = await service.launch(sourceSessionId: provider.sessionName);
    if (!mounted || result.ok) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.message ?? VoiceLaunchService.describe(result.errorCode),
        ),
        backgroundColor: const Color(0xFFff6b63),
      ),
    );
  }

  Future<void> _toggleRecording() async {
    if (_isRecording) {
      await _stopAndTranscribe();
    } else {
      await _startRecording();
    }
  }

  Future<void> _startRecording() async {
    if (!await _recorder.hasPermission()) return;
    final dir = await getTemporaryDirectory();
    final filePath =
        '${dir.path}/multicc_voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        numChannels: 1,
        sampleRate: 16000,
      ),
      path: filePath,
    );
    setState(() => _isRecording = true);
  }

  Future<void> _stopAndTranscribe() async {
    final settings = context.read<ChatProvider>().settings;
    final path = await _recorder.stop();
    setState(() {
      _isRecording = false;
      _isTranscribing = true;
    });

    if (path == null) {
      setState(() => _isTranscribing = false);
      return;
    }

    try {
      final uri = Uri.parse(settings.buildHttpUrl('/api/voice/stt'));
      final req = http.MultipartRequest('POST', uri);
      if (settings.token.isNotEmpty) {
        req.headers['X-Access-Token'] = settings.token;
      }
      req.files.add(
        await http.MultipartFile.fromPath(
          'file',
          path,
          contentType: MediaType('audio', 'mp4'),
        ),
      );
      final res = await req.send().timeout(const Duration(seconds: 60));
      final body = await res.stream.bytesToString();
      if (res.statusCode == 200) {
        final json = jsonDecode(body) as Map<String, dynamic>;
        final text = (json['text'] as String? ?? '').trim();
        if (text.isNotEmpty && mounted) {
          _showVoicePanel(text);
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('STT failed: ${res.statusCode}'),
              backgroundColor: const Color(0xFFff6b63),
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('STT error: $e'),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isTranscribing = false);
    }
  }

  // ── Voice panel (raw → optional AI refine) ──

  void _showVoicePanel(String rawText) {
    final rawCtrl = TextEditingController(text: rawText);
    bool isRefining = false;
    String? refinedText;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF0f1115),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            return Padding(
              padding: EdgeInsets.fromLTRB(
                16,
                16,
                16,
                MediaQuery.of(ctx).viewInsets.bottom + 16,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '🎤 ${t('voiceRecognition')}',
                    style: const TextStyle(
                      color: Color(0xFFf2f4f7),
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    t('voiceRawTranscript'),
                    style: const TextStyle(
                      color: Color(0xFF8a909b),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  TextField(
                    controller: rawCtrl,
                    maxLines: 4,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 14,
                    ),
                    decoration: InputDecoration(
                      filled: true,
                      fillColor: const Color(0xFF070809),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFF20242b)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFF20242b)),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: const BorderSide(color: Color(0xFF6aa3ff)),
                      ),
                    ),
                  ),
                  if (refinedText != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      t('aiRefine'),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFF070809),
                        border: Border.all(color: const Color(0xFF22ab9c)),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        refinedText!,
                        style: const TextStyle(
                          color: Color(0xFFe7eaee),
                          fontSize: 14,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => Navigator.pop(ctx),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: const Color(0xFF8a909b),
                            side: const BorderSide(color: Color(0xFF20242b)),
                          ),
                          child: Text(t('cancel')),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: isRefining
                              ? null
                              : () async {
                                  setSheetState(() => isRefining = true);
                                  final result = await _fetchRefined(
                                    rawCtrl.text,
                                  );
                                  if (result != null) {
                                    setSheetState(() {
                                      refinedText = result;
                                      isRefining = false;
                                    });
                                  } else {
                                    setSheetState(() => isRefining = false);
                                  }
                                },
                          style: OutlinedButton.styleFrom(
                            foregroundColor: const Color(0xFF8a909b),
                            side: const BorderSide(color: Color(0xFF20242b)),
                          ),
                          child: isRefining
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Color(0xFF8a909b),
                                  ),
                                )
                              : Text(t('aiRefine')),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () {
                            final text =
                                (refinedText != null &&
                                    refinedText!.trim().isNotEmpty)
                                ? refinedText!
                                : rawCtrl.text;
                            Navigator.pop(ctx);
                            final current = _ctrl.text;
                            _ctrl.text = current.isEmpty
                                ? text
                                : '$current $text';
                            _ctrl.selection = TextSelection.collapsed(
                              offset: _ctrl.text.length,
                            );
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF22ab9c),
                            foregroundColor: Colors.white,
                          ),
                          child: Text(
                            refinedText != null
                                ? t('useAiText')
                                : t('useOriginalText'),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Future<String?> _fetchRefined(String raw) async {
    try {
      final provider = context.read<ChatProvider>();
      final settings = provider.settings;
      final uri = Uri.parse(settings.buildHttpUrl('/api/voice/refine'));
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (settings.token.isNotEmpty) {
        headers['X-Access-Token'] = settings.token;
      }
      final res = await http
          .post(uri, headers: headers, body: jsonEncode({'raw': raw}))
          .timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) return null;
      final data = jsonDecode(utf8.decode(res.bodyBytes));
      if (data is! Map<String, dynamic> || data['ok'] != true) return null;
      final result = (data['text'] ?? '').toString().trim();
      return result.isNotEmpty ? result : null;
    } catch (_) {
      return null;
    }
  }

  // ── Streaming voice dictation (/ws/voice) ──

  void _onDictationChanged() {
    if (!mounted) return;
    final d = _dictation;
    // 启动失败且一个字都没识别到：回退旧的整段上传，别让用户对着空 HUD 干等。
    if (d != null &&
        d.state == VoiceDictationState.failed &&
        !d.hasText &&
        !_legacyFallbackArmed) {
      _legacyFallbackArmed = true;
      _dictation?.removeListener(_onDictationChanged);
      _dictation = null;
      setState(() {});
      _fallbackLegacyRecording();
      return;
    }
    setState(() {});
  }

  /// 麦克风按钮：正在听写就提交，否则开始一轮流式听写。
  Future<void> _toggleDictation(
    ChatProvider provider, {
    required bool commander,
  }) async {
    final d = _dictation;
    if (d != null && d.isBusy) {
      await _commitDictation(provider, commander: commander);
      return;
    }
    await _startDictation(provider);
  }

  Future<void> _startDictation(ChatProvider provider) async {
    if (_dictation == null) {
      _dictation = VoiceDictationService(settings: provider.settings);
      _dictation!.addListener(_onDictationChanged);
    }
    _legacyFallbackArmed = false;
    final ok = await _dictation!.start();
    if (!mounted) return;
    if (!ok) {
      // /ws/voice 或麦克风不可用：回退旧的整段上传流程。
      _dictation?.removeListener(_onDictationChanged);
      _dictation = null;
      setState(() {});
      await _toggleRecording();
    } else {
      setState(() {});
    }
  }

  Future<void> _commitDictation(
    ChatProvider provider, {
    required bool commander,
  }) async {
    final d = _dictation;
    if (d == null) return;
    final result = await d.commit();
    if (!mounted) return;
    if (result.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(t('voiceEmpty')),
          backgroundColor: const Color(0xFF454b54),
        ),
      );
      return;
    }
    // 填进输入框（保留可编辑，移动端误触代价大，不直接发送），并 fire-and-forget
    // 回传润色反馈给服务端做质量评估。
    final current = _ctrl.text.trim();
    _ctrl.text = current.isEmpty ? result.text : '$current\n${result.text}';
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    d.reportFeedback(result, userFinal: result.text);
  }

  void _cancelDictation() => _dictation?.cancel();

  Future<void> _fallbackLegacyRecording() async {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(t('voiceStreamUnavailable')),
        backgroundColor: const Color(0xFF454b54),
      ),
    );
    await _toggleRecording();
  }

  // ── Dispatch hint (commander only) ──

  /// 切到别的会话时把选中项对齐到那个会话记住的值。读是同步的（
  /// SharedPreferences 早已加载），所以直接在 build 里调用，不用等下一帧；
  /// 没写过的会话回落默认（dispatch_master async），不回写默认值。
  void _syncDispatchMode(ChatProvider provider) {
    final sessionId = provider.sessionName;
    if (sessionId == _dispatchModeSessionId) return;
    _dispatchModeSessionId = sessionId;
    _dispatchMode = provider.settings.readDispatchMode(sessionId);
  }

  void _setDispatchMode(ChatProvider provider, DispatchMode value) {
    setState(() => _dispatchMode = value);
    provider.settings.saveDispatchMode(provider.sessionName, value);
  }

  // ── Send ──

  void _dismissIosKeyboard() {
    if (!mounted || Theme.of(context).platform != TargetPlatform.iOS) return;
    _focusNode.unfocus();
  }

  void _send(ChatProvider provider, {required bool commander}) {
    var text = _ctrl.text.trim();
    // Append attachment paths
    if (_attachments.isNotEmpty) {
      final paths = _attachments.map((a) => a['path']!).join(' ');
      text = text.isEmpty ? paths : '$text $paths';
    }
    if (text.isEmpty) return;
    // 装饰必须在交给 provider 之前：气泡与真正发出去的 payload 用同一个字符串。
    text = decorateDispatchHint(text, enabled: commander, mode: _dispatchMode);
    provider.sendMessage(text);
    _ctrl.clear();
    // Unlike Android, iOS has no persistent system affordance for hiding the
    // software keyboard. A completed composer action must therefore release
    // focus explicitly; otherwise the keyboard remains pinned over the chat.
    _dismissIosKeyboard();
    setState(() {
      _hasText = false;
      _attachments.clear();
    });
  }

  Future<bool> _confirmQueueChange(String action) async {
    if (!const {
      'skip',
      'cancel',
      'cancel_queued',
      'insert_queued',
    }.contains(action)) {
      return true;
    }
    // 插队会当场掐断正在生成的回复，手机上误触代价比 web 大，所以和取消一样
    // 走一次确认；文案单列，别让用户以为只是「排到前面」。
    final body = action == 'insert_queued'
        ? t('confirmInsertQueuedBody')
        : t('confirmQueueChangeBody');
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(t('confirmQueueChangeTitle')),
            content: Text(body),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(t('cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(t('confirm')),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _runQueueAction(
    ChatProvider provider,
    String action, {
    String? entryId,
  }) async {
    if (!await _confirmQueueChange(action)) return;
    try {
      await provider.queueAction(action, entryId: entryId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            action == 'insert_queued'
                ? t('queueInsertAccepted')
                : t('queueActionAccepted'),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      // 调度器已经领走这条消息是最常见的失败，原始 code 对用户没有意义。
      final claimed =
          error is QueueActionException &&
          error.code == 'queued_entry_already_claimed';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            claimed
                ? t('queueEntryAlreadyClaimed')
                : t('queueActionFailed', {'error': '$error'}),
          ),
          backgroundColor: const Color(0xFF3a1414),
        ),
      );
    }
  }

  // ── Goal mode: AI precheck before sending ──
  // Mirrors the web chat's 🎯 flow: the aux-AI judges whether the task is
  // goal-ready (clear objective, clear done-criteria, bounded, executable),
  // proposes a rewrite, then we wrap the accepted task in a short goal-mode
  // instruction and send it through the normal sendMessage() path.

  String _goalWrap(String task) {
    return t('goalExecutionPrompt', {'task': task});
  }

  List<String> _strList(dynamic v) => (v is List)
      ? v.map((e) => e.toString()).where((s) => s.trim().isNotEmpty).toList()
      : <String>[];

  Future<Map<String, dynamic>> _fetchGoalPrecheck(
    String task,
    Map<String, bool> dims,
  ) async {
    try {
      final settings = context.read<ChatProvider>().settings;
      final uri = Uri.parse(settings.buildHttpUrl('/api/goal/precheck'));
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .post(
            uri,
            headers: headers,
            body: jsonEncode({'task': task, 'dimensions': dims}),
          )
          .timeout(const Duration(seconds: 45));
      if (res.statusCode != 200) {
        return {'ok': false, 'error': 'HTTP ${res.statusCode}'};
      }
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (e) {
      return {'ok': false, 'error': '$e'};
    }
  }

  // Load the global goal-config dimension defaults into [dims].
  Future<void> _loadGoalDimsInto(Map<String, bool> dims) async {
    try {
      final settings = context.read<ChatProvider>().settings;
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/settings/goal')),
            headers: headers,
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final g = (d['dimensions'] as Map?) ?? {};
      for (final k in const ['objective', 'criteria', 'scope', 'executable']) {
        dims[k] = g[k] != false;
      }
    } catch (_) {}
  }

  Widget _goalField(TextEditingController ctrl, int maxLines, String hint) {
    return TextField(
      controller: ctrl,
      maxLines: maxLines,
      style: const TextStyle(
        color: Color(0xFFe7eaee),
        fontSize: 14,
        height: 1.4,
      ),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFF454b54)),
        filled: true,
        fillColor: const Color(0xFF070809),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF20242b)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF20242b)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: Color(0xFF6aa3ff)),
        ),
      ),
    );
  }

  // Compact labeled number field for the per-send execution limits.
  Widget _goalNumField(TextEditingController ctrl, String label, String hint) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
        ),
        const SizedBox(height: 4),
        TextField(
          controller: ctrl,
          keyboardType: TextInputType.number,
          style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(color: Color(0xFF454b54)),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 10,
              vertical: 10,
            ),
            filled: true,
            fillColor: const Color(0xFF070809),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: Color(0xFF20242b)),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: Color(0xFF20242b)),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: Color(0xFF6aa3ff)),
            ),
          ),
        ),
      ],
    );
  }

  Widget _goalSection(String title, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 8, bottom: 2),
          child: Text(
            title,
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
          ),
        ),
        ...items.map(
          (x) => Padding(
            padding: const EdgeInsets.only(left: 4, top: 2),
            child: Text(
              '• $x',
              style: const TextStyle(
                color: Color(0xFFc9d1d9),
                fontSize: 12,
                height: 1.4,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _showGoalSheet(ChatProvider provider) async {
    final taskCtrl = TextEditingController(text: _ctrl.text.trim());
    final revisedCtrl = TextEditingController();
    // Per-send execution limits (no global config): default 200 rounds, no budget.
    final roundsCtrl = TextEditingController(text: '200');
    final budgetCtrl = TextEditingController();
    final Map<String, bool> dims = {
      'objective': true,
      'criteria': true,
      'scope': true,
      'executable': true,
    };
    await _loadGoalDimsInto(dims); // default checkboxes to the global config
    if (!mounted) return;
    bool checking = false;
    Map<String, dynamic>? verdict; // null until prechecked
    String? error;

    // Collect the per-send limits; blank → omitted so the server uses its hard
    // default (rounds=200), 0 → explicitly unlimited for that dimension.
    Map<String, dynamic> collectLimits() {
      final limits = <String, dynamic>{};
      final r = int.tryParse(roundsCtrl.text.trim());
      if (r != null) limits['maxRounds'] = r;
      final b = int.tryParse(budgetCtrl.text.trim());
      if (b != null) limits['maxBudget'] = b;
      return limits;
    }

    void sendGoal(String task) {
      final t = task.trim();
      if (t.isEmpty) return;
      final limits = collectLimits();
      Navigator.pop(context);
      provider.sendMessage(_goalWrap(t), goal: true, goalLimits: limits);
      _ctrl.clear();
      setState(() {
        _hasText = false;
        _attachments.clear();
      });
    }

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF0f1115),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setSheetState) {
            final ok = verdict != null && verdict!['verdict'] == 'ok';
            return Padding(
              padding: EdgeInsets.fromLTRB(
                16,
                16,
                16,
                MediaQuery.of(ctx).viewInsets.bottom + 16,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      '🎯 ${t('goalSendTitle')}',
                      style: const TextStyle(
                        color: Color(0xFFf2f4f7),
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      t('goalSendHint'),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 12,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      t('task'),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 4),
                    _goalField(taskCtrl, 4, t('goalTaskHint')),
                    const SizedBox(height: 10),
                    Text(
                      t('goalDimensionsOnce'),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: _goalDimShort.entries.map((e) {
                        final on = dims[e.key] ?? true;
                        return FilterChip(
                          label: Text(
                            e.value,
                            style: const TextStyle(fontSize: 12),
                          ),
                          selected: on,
                          onSelected: (v) =>
                              setSheetState(() => dims[e.key] = v),
                          backgroundColor: const Color(0xFF14171c),
                          selectedColor: const Color(0xFF22ab9c),
                          checkmarkColor: Colors.white,
                          labelStyle: TextStyle(
                            color: on ? Colors.white : const Color(0xFF8a909b),
                            fontSize: 12,
                          ),
                          side: const BorderSide(color: Color(0xFF20242b)),
                          materialTapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                          visualDensity: VisualDensity.compact,
                        );
                      }).toList(),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      t('goalLimits'),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: _goalNumField(
                            roundsCtrl,
                            t('roundLimit'),
                            '40',
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _goalNumField(
                            budgetCtrl,
                            t('tokenBudget'),
                            t('unlimited'),
                          ),
                        ),
                      ],
                    ),
                    if (verdict != null) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                        decoration: BoxDecoration(
                          color: ok
                              ? const Color(0xFF12261a)
                              : const Color(0xFF2b2410),
                          border: Border.all(
                            color: ok
                                ? const Color(0xFF2ea043)
                                : const Color(0xFFbb8009),
                          ),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          '${ok ? '✅ ${t('goalQualified')}' : '⚠️ ${t('goalNeedsWork')}'} (${t('goalScore', {'score': '${verdict!['score'] ?? '-'}'})})',
                          style: TextStyle(
                            color: ok
                                ? const Color(0xFF3fb950)
                                : const Color(0xFFd29922),
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      _goalSection(
                        t('goalIssues'),
                        _strList(verdict!['issues']),
                      ),
                      _goalSection(
                        t('goalQuestions'),
                        _strList(verdict!['questions']),
                      ),
                      _goalSection(
                        t('goalSuggestedCriteria'),
                        _strList(verdict!['criteria']),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        t('goalRevised'),
                        style: const TextStyle(
                          color: Color(0xFF8a909b),
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 4),
                      _goalField(revisedCtrl, 5, t('goalRevisedHint')),
                    ],
                    if (error != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        error!,
                        style: const TextStyle(
                          color: Color(0xFFff6b63),
                          fontSize: 12,
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => Navigator.pop(ctx),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFF8a909b),
                              side: const BorderSide(color: Color(0xFF20242b)),
                            ),
                            child: Text(t('cancel')),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: checking
                                ? null
                                : () async {
                                    final task = taskCtrl.text.trim();
                                    if (task.isEmpty) {
                                      setSheetState(
                                        () => error = t('taskRequired'),
                                      );
                                      return;
                                    }
                                    setSheetState(() {
                                      checking = true;
                                      error = null;
                                    });
                                    final data = await _fetchGoalPrecheck(
                                      task,
                                      dims,
                                    );
                                    setSheetState(() {
                                      checking = false;
                                      if (data['ok'] == true) {
                                        verdict = data;
                                        final r = (data['revised'] as String?)
                                            ?.trim();
                                        revisedCtrl.text =
                                            (r != null && r.isNotEmpty)
                                            ? r
                                            : task;
                                      } else {
                                        error = t('goalPrecheckFailed', {
                                          'error':
                                              '${data['error'] ?? t('unknownError')}',
                                        });
                                      }
                                    });
                                  },
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFF8a909b),
                              side: const BorderSide(color: Color(0xFF20242b)),
                            ),
                            child: checking
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Color(0xFF8a909b),
                                    ),
                                  )
                                : Text(
                                    verdict == null
                                        ? t('precheck')
                                        : t('recheck'),
                                  ),
                          ),
                        ),
                      ],
                    ),
                    if (verdict != null || error != null) ...[
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: TextButton(
                              onPressed: () => sendGoal(taskCtrl.text),
                              style: TextButton.styleFrom(
                                foregroundColor: const Color(0xFF8a909b),
                              ),
                              child: Text(t('sendOriginal')),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            flex: 2,
                            child: ElevatedButton(
                              onPressed: () => sendGoal(
                                verdict != null
                                    ? (revisedCtrl.text.isNotEmpty
                                          ? revisedCtrl.text
                                          : taskCtrl.text)
                                    : taskCtrl.text,
                              ),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF22ab9c),
                                foregroundColor: Colors.white,
                              ),
                              child: Text(
                                ok ? t('sendGoal') : t('confirmAndSend'),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final smgr = context.watch<SessionManager>();
    Session? activeSess;
    for (final x in smgr.sessions) {
      if (x.id == provider.sessionName) {
        activeSess = x;
        break;
      }
    }
    // Prefer the resolved real wire id (effectiveModel) over the stored tier
    // alias, so the pill shows what actually hits the server (e.g. glm-5.2, not opus).
    final sub = activeSess?.subagent;
    final subReal =
        (sub?.effectiveModel != null && sub!.effectiveModel!.isNotEmpty)
        ? sub.effectiveModel
        : ((sub?.model != null && sub!.model!.isNotEmpty) ? sub.model : null);
    final subagentModelLabel = subReal;
    // 会话角色读不到就当不是 commander：fail closed，绝不悄悄改写提示词。
    final isCommander = isCommanderSessionType(activeSess?.type);
    _syncDispatchMode(provider);
    final isStreaming = provider.isStreaming;
    final isConnected =
        provider.connectionState == ChatConnectionState.connected;
    final canSend = (_hasText || _attachments.isNotEmpty) && isConnected;

    return SafeArea(
      top: false,
      child: Container(
        decoration: const BoxDecoration(
          color: Color(0xFF0f1115),
          border: Border(top: BorderSide(color: Color(0xFF20242b))),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SessionQueuePanel(
              queue: provider.sessionQueue,
              enabled: isConnected,
              onAction: (action) => _runQueueAction(provider, action),
              onCancelQueued: (entryId) =>
                  _runQueueAction(provider, 'cancel_queued', entryId: entryId),
              onInsertQueued: (entryId) =>
                  _runQueueAction(provider, 'insert_queued', entryId: entryId),
            ),

            // Attachment chips
            if (_attachments.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: _attachments.asMap().entries.map((e) {
                    final idx = e.key;
                    final att = e.value;
                    return Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF14171c),
                        border: Border.all(color: const Color(0xFF20242b)),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.attach_file,
                            size: 12,
                            color: Color(0xFF8a909b),
                          ),
                          const SizedBox(width: 4),
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 150),
                            child: Text(
                              att['name']!,
                              style: const TextStyle(
                                color: Color(0xFFe7eaee),
                                fontSize: 12,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 4),
                          GestureDetector(
                            onTap: () =>
                                setState(() => _attachments.removeAt(idx)),
                            child: const Icon(
                              Icons.close,
                              size: 12,
                              color: Color(0xFF8a909b),
                            ),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ),

            // Sub-task (subagent) indicator pill — tap opens the AI-config sheet.
            if (widget.onPickSubagent != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: GestureDetector(
                    onTap: widget.onPickSubagent,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF14171c),
                        border: Border.all(color: const Color(0xFF20242b)),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.psychology_outlined,
                            size: 14,
                            color: Color(0xFFe7eaee),
                          ),
                          const SizedBox(width: 4),
                          Text(
                            t('subtaskLabel', {
                              'model': subagentModelLabel ?? t('followMain'),
                            }),
                            style: const TextStyle(
                              color: Color(0xFFe7eaee),
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),

            // Commander 专属：这一轮怎么派发。四个选项平铺会把手机上的输入区
            // 挤掉，所以只留一枚显示当前档位的胶囊，改档去 BottomSheet 里选 ——
            // 与 web 同一形态。位置跟在子任务 pill 之后、输入框之上，和
            // web 的 #pre-input-bar 顺序一致。
            if (isCommander)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: DispatchModePill(
                    key: const Key('dispatch-mode-group'),
                    mode: _dispatchMode,
                    onChanged: (value) => _setDispatchMode(provider, value),
                  ),
                ),
              ),

            // Streaming voice dictation HUD — lives just above the input row so the
            // live transcript is visible while the keyboard / send button stay usable.
            if (_dictation != null &&
                _dictation!.state != VoiceDictationState.idle &&
                _dictation!.state != VoiceDictationState.done)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _VoiceDictationHud(
                  dictation: _dictation!,
                  onCancel: _cancelDictation,
                  onCommit: () =>
                      _commitDictation(provider, commander: isCommander),
                ),
              ),

            // Input row
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // Attachment button
                _SmallButton(
                  onTap: (!_uploading && isConnected) ? _pickAndUpload : null,
                  icon: _uploading
                      ? Icons.hourglass_top_rounded
                      : Icons.attach_file_rounded,
                  color: const Color(0xFF8a909b),
                ),
                const SizedBox(width: 4),

                // Voice button — streaming /ws/voice dictation (falls back to the
                // legacy m4a → /api/voice/stt flow when the socket is unavailable).
                _SmallButton(
                  onTap: (_dictation?.isBusy ?? false)
                      ? () => _commitDictation(provider, commander: isCommander)
                      : (!_isTranscribing && isConnected)
                      ? () => _toggleDictation(provider, commander: isCommander)
                      : null,
                  icon: (_dictation?.state == VoiceDictationState.finalizing)
                      ? Icons.hourglass_top_rounded
                      : (_dictation?.isBusy ?? false)
                      ? Icons.check_circle_rounded
                      : _isTranscribing
                      ? Icons.hourglass_top_rounded
                      : _isRecording
                      ? Icons.stop_circle_rounded
                      : Icons.mic_rounded,
                  color: (_dictation?.isBusy ?? false) || _isRecording
                      ? const Color(0xFF22ab9c)
                      : const Color(0xFF8a909b),
                ),
                const SizedBox(width: 4),

                // Goal-mode button — precheck the task with the aux-AI, then send
                _SmallButton(
                  onTap: (isConnected && !isStreaming)
                      ? () => _showGoalSheet(provider)
                      : null,
                  icon: Icons.track_changes_rounded,
                  color: const Color(0xFF8a909b),
                ),
                const SizedBox(width: 4),

                // Realtime voice — opens the one global voice gateway, scoped to
                // this session. Plain dictation stays on the mic button below.
                _SmallButton(
                  onTap: isConnected
                      ? () {
                          _openVoiceCall();
                        }
                      : null,
                  icon: Icons.phone_in_talk_rounded,
                  color: const Color(0xFF22ab9c),
                ),
                const SizedBox(width: 4),

                // Input textarea
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(maxHeight: 120),
                    decoration: BoxDecoration(
                      color: const Color(0xFF070809),
                      border: Border.all(
                        color: _isRecording
                            ? const Color(0xFFff6b63)
                            : _focusNode.hasFocus
                            ? const Color(0xFF6aa3ff)
                            : const Color(0xFF20242b),
                      ),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: TextField(
                      key: const Key('chat-message-input'),
                      controller: _ctrl,
                      focusNode: _focusNode,
                      maxLines: null,
                      textInputAction: TextInputAction.newline,
                      enabled: isConnected,
                      style: const TextStyle(
                        color: Color(0xFFe7eaee),
                        fontSize: 14,
                        height: 1.4,
                      ),
                      decoration: InputDecoration(
                        hintText: _isRecording
                            ? t('recording')
                            : _isTranscribing
                            ? t('transcribing')
                            : t('typeMessage'),
                        hintStyle: TextStyle(
                          color: _isRecording
                              ? const Color(0xFFff6b63)
                              : const Color(0xFF454b54),
                        ),
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                      ),
                      onSubmitted: canSend
                          ? (_) => _send(provider, commander: isCommander)
                          : null,
                      // Flutter intentionally keeps focus for touch-device
                      // outside taps by default. Override that convention on
                      // iOS so tapping the transcript/header hides the keyboard
                      // while leaving the draft untouched.
                      onTapOutside: (_) => _dismissIosKeyboard(),
                    ),
                  ),
                ),
                const SizedBox(width: 6),

                // Keep both actions available while streaming: Send stages the
                // message durably; Stop remains an explicit cancellation.
                if (isStreaming)
                  _ActionButton(
                    onTap: provider.cancel,
                    color: const Color(0xFFff6b63),
                    icon: Icons.stop_rounded,
                  ),
                if (isStreaming) const SizedBox(width: 4),
                _ActionButton(
                  onTap: canSend
                      ? () => _send(provider, commander: isCommander)
                      : null,
                  color: canSend
                      ? const Color(0xFF22ab9c)
                      : const Color(0xFF14171c),
                  icon: Icons.send_rounded,
                  iconColor: canSend ? Colors.white : const Color(0xFF454b54),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 流式听写的实时浮层：原文（已定稿 + 待定灰字）、润色稿、状态、取消/提交。
/// 用 ListenableBuilder 直接订阅 [VoiceDictationService]，状态变了就重建。
class _VoiceDictationHud extends StatelessWidget {
  final VoiceDictationService dictation;
  final VoidCallback onCancel;
  final VoidCallback onCommit;

  const _VoiceDictationHud({
    required this.dictation,
    required this.onCancel,
    required this.onCommit,
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: dictation,
      builder: (ctx, _) {
        final raw = dictation.rawFinal;
        final partial = dictation.rawPartial;
        final refined = dictation.refined;
        final failed = dictation.state == VoiceDictationState.failed;
        final hasRaw = raw.trim().isNotEmpty || partial.trim().isNotEmpty;
        final accent = failed
            ? const Color(0xFFff6b63)
            : const Color(0xFF22ab9c);
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFF070809),
            border: Border.all(color: accent),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(
                    failed
                        ? Icons.error_outline_rounded
                        : Icons.graphic_eq_rounded,
                    size: 14,
                    color: accent,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _stateLabel(),
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 11,
                      ),
                    ),
                  ),
                ],
              ),
              if (hasRaw || refined.isNotEmpty) ...[
                const SizedBox(height: 8),
                if (hasRaw)
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: raw,
                          style: const TextStyle(
                            color: Color(0xFFe7eaee),
                            fontSize: 14,
                          ),
                        ),
                        if (partial.isNotEmpty)
                          TextSpan(
                            text: partial,
                            style: const TextStyle(
                              color: Color(0xFF6b7280),
                              fontSize: 14,
                            ),
                          ),
                      ],
                    ),
                  ),
                if (refined.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0f1115),
                      border: Border.all(
                        color: const Color(0xFF22ab9c).withValues(alpha: 0.5),
                      ),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      refined,
                      style: const TextStyle(
                        color: Color(0xFFe7eaee),
                        fontSize: 14,
                      ),
                    ),
                  ),
                ],
              ],
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(onPressed: onCancel, child: Text(t('cancel'))),
                  const SizedBox(width: 4),
                  FilledButton.icon(
                    onPressed: dictation.state == VoiceDictationState.finalizing
                        ? null
                        : onCommit,
                    icon: const Icon(Icons.send_rounded, size: 16),
                    label: Text(t('voiceSubmit')),
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF22ab9c),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  String _stateLabel() {
    switch (dictation.state) {
      case VoiceDictationState.starting:
        return t('voiceStarting');
      case VoiceDictationState.listening:
        return t('voiceListening');
      case VoiceDictationState.finalizing:
        return t('voiceFinalizing');
      case VoiceDictationState.failed:
        return dictation.errorDetail.isNotEmpty
            ? '⚠ ${dictation.errorDetail}'
            : t('voiceFailed');
      default:
        return '';
    }
  }
}

class _SmallButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData icon;
  final Color color;

  const _SmallButton({
    required this.onTap,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 40,
        alignment: Alignment.center,
        child: Icon(
          icon,
          color: onTap != null ? color : const Color(0xFF454b54),
          size: 20,
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final VoidCallback? onTap;
  final Color color;
  final IconData icon;
  final Color iconColor;

  const _ActionButton({
    required this.onTap,
    required this.color,
    required this.icon,
    this.iconColor = Colors.white,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, color: iconColor, size: 20),
      ),
    );
  }
}
