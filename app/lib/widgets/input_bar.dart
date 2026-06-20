import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import 'package:record/record.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:path_provider/path_provider.dart';

import '../providers/chat_provider.dart';
import '../services/chat_service.dart';
import '../services/settings_service.dart';

class InputBar extends StatefulWidget {
  const InputBar({super.key});

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

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(() {
      final has = _ctrl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
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
      req.files.add(http.MultipartFile.fromBytes(
        'file',
        file.bytes!,
        filename: file.name,
        contentType: MediaType('application', 'octet-stream'),
      ));
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
            SnackBar(content: Text('Upload failed: ${res.statusCode}'), backgroundColor: const Color(0xFFff6b63)),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Upload error: $e'), backgroundColor: const Color(0xFFff6b63)),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  // ── Voice recording ──

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
    final filePath = '${dir.path}/multicc_voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.aacLc, numChannels: 1, sampleRate: 16000),
      path: filePath,
    );
    setState(() => _isRecording = true);
  }

  Future<void> _stopAndTranscribe() async {
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
      final provider = context.read<ChatProvider>();
      final settings = provider.settings;
      final uri = Uri.parse(settings.buildHttpUrl('/api/voice/stt'));
      final req = http.MultipartRequest('POST', uri);
      if (settings.token.isNotEmpty) {
        req.headers['X-Access-Token'] = settings.token;
      }
      req.files.add(await http.MultipartFile.fromPath(
        'file',
        path,
        contentType: MediaType('audio', 'mp4'),
      ));
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
            SnackBar(content: Text('STT failed: ${res.statusCode}'), backgroundColor: const Color(0xFFff6b63)),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('STT error: $e'), backgroundColor: const Color(0xFFff6b63)),
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
        return StatefulBuilder(builder: (ctx, setSheetState) {
          return Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('🎤 语音识别', style: TextStyle(color: Color(0xFFf2f4f7), fontSize: 16, fontWeight: FontWeight.w600)),
                const SizedBox(height: 12),
                const Text('原始识别', style: TextStyle(color: Color(0xFF8a909b), fontSize: 12)),
                const SizedBox(height: 4),
                TextField(
                  controller: rawCtrl,
                  maxLines: 4,
                  style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                  decoration: InputDecoration(
                    filled: true,
                    fillColor: const Color(0xFF070809),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF20242b))),
                    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF20242b))),
                    focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF6aa3ff))),
                  ),
                ),
                if (refinedText != null) ...[
                  const SizedBox(height: 12),
                  const Text('AI 重排', style: TextStyle(color: Color(0xFF8a909b), fontSize: 12)),
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0xFF070809),
                      border: Border.all(color: const Color(0xFF22ab9c)),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(refinedText!, style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14)),
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
                        child: const Text('取消'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: isRefining
                            ? null
                            : () async {
                                setSheetState(() => isRefining = true);
                                final result = await _fetchRefined(rawCtrl.text);
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
                            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF8a909b)))
                            : const Text('AI 重排'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: () {
                          final text = (refinedText != null && refinedText!.trim().isNotEmpty)
                              ? refinedText!
                              : rawCtrl.text;
                          Navigator.pop(ctx);
                          final current = _ctrl.text;
                          _ctrl.text = current.isEmpty ? text : '$current $text';
                          _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF22ab9c),
                          foregroundColor: Colors.white,
                        ),
                        child: Text(refinedText != null ? '使用 AI' : '使用原文'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          );
        });
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
      final res = await http.post(uri, headers: headers, body: jsonEncode({'raw': raw}))
          .timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) return null;
      // Parse SSE response — decode as UTF-8 (http package defaults to Latin-1 for SSE)
      final bodyText = utf8.decode(res.bodyBytes);
      final lines = bodyText.split('\n');
      final buf = StringBuffer();
      for (final line in lines) {
        if (line.startsWith('data: ')) {
          final payload = line.substring(6).trim();
          if (payload == '[DONE]') break;
          try {
            final json = jsonDecode(payload) as Map<String, dynamic>;
            if (json.containsKey('text')) buf.write(json['text']);
          } catch (_) {}
        }
      }
      final result = buf.toString().trim();
      return result.isNotEmpty ? result : null;
    } catch (_) {
      return null;
    }
  }

  // ── Send ──

  void _send(ChatProvider provider) {
    var text = _ctrl.text.trim();
    // Append attachment paths
    if (_attachments.isNotEmpty) {
      final paths = _attachments.map((a) => a['path']!).join(' ');
      text = text.isEmpty ? paths : '$text $paths';
    }
    if (text.isEmpty) return;
    provider.sendMessage(text);
    _ctrl.clear();
    setState(() {
      _hasText = false;
      _attachments.clear();
    });
  }

  // ── Goal mode: AI precheck before sending ──
  // Mirrors the web chat's 🎯 flow: the aux-AI judges whether the task is
  // goal-ready (clear objective, clear done-criteria, bounded, executable),
  // proposes a rewrite, then we wrap the accepted task in a short goal-mode
  // instruction and send it through the normal sendMessage() path.

  String _goalWrap(String task) {
    return '请以 Goal 模式执行以下任务：目标驱动、自主规划并一步步执行到完成；'
        '遇到不明确处用合理默认推进并说明假设；完成后自检并验证结果是否达到完成标准。\n\n$task';
  }

  List<String> _strList(dynamic v) =>
      (v is List) ? v.map((e) => e.toString()).where((s) => s.trim().isNotEmpty).toList() : <String>[];

  Future<Map<String, dynamic>> _fetchGoalPrecheck(String task) async {
    try {
      final settings = context.read<ChatProvider>().settings;
      final uri = Uri.parse(settings.buildHttpUrl('/api/goal/precheck'));
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .post(uri, headers: headers, body: jsonEncode({'task': task}))
          .timeout(const Duration(seconds: 45));
      if (res.statusCode != 200) return {'ok': false, 'error': 'HTTP ${res.statusCode}'};
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (e) {
      return {'ok': false, 'error': '$e'};
    }
  }

  Widget _goalField(TextEditingController ctrl, int maxLines, String hint) {
    return TextField(
      controller: ctrl,
      maxLines: maxLines,
      style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14, height: 1.4),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFF454b54)),
        filled: true,
        fillColor: const Color(0xFF070809),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF20242b))),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF20242b))),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFF6aa3ff))),
      ),
    );
  }

  Widget _goalSection(String title, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(top: 8, bottom: 2), child: Text(title, style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11))),
        ...items.map((x) => Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text('• $x', style: const TextStyle(color: Color(0xFFc9d1d9), fontSize: 12, height: 1.4)),
            )),
      ],
    );
  }

  void _showGoalSheet(ChatProvider provider) {
    final taskCtrl = TextEditingController(text: _ctrl.text.trim());
    final revisedCtrl = TextEditingController();
    bool checking = false;
    Map<String, dynamic>? verdict; // null until prechecked
    String? error;

    void sendGoal(String task) {
      final t = task.trim();
      if (t.isEmpty) return;
      Navigator.pop(context);
      provider.sendMessage(_goalWrap(t));
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
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) {
        return StatefulBuilder(builder: (ctx, setSheetState) {
          final ok = verdict != null && verdict!['verdict'] == 'ok';
          return Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('🎯 Goal 模式发送', style: TextStyle(color: Color(0xFFf2f4f7), fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  const Text(
                    '发送前先用辅助 AI 预检：目标是否明确、完成标准是否清晰、能否独立执行。不符合会给改写建议，确认或修改后再真正执行。',
                    style: TextStyle(color: Color(0xFF8a909b), fontSize: 12, height: 1.4),
                  ),
                  const SizedBox(height: 12),
                  const Text('任务', style: TextStyle(color: Color(0xFF8a909b), fontSize: 12)),
                  const SizedBox(height: 4),
                  _goalField(taskCtrl, 4, '描述你要达成的目标…'),
                  if (verdict != null) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: ok ? const Color(0xFF12261a) : const Color(0xFF2b2410),
                        border: Border.all(color: ok ? const Color(0xFF2ea043) : const Color(0xFFbb8009)),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        '${ok ? '✅ 符合 Goal 模式' : '⚠️ 建议先完善'}（符合度 ${verdict!['score'] ?? '-'}/100）',
                        style: TextStyle(color: ok ? const Color(0xFF3fb950) : const Color(0xFFd29922), fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                    ),
                    _goalSection('待完善', _strList(verdict!['issues'])),
                    _goalSection('需澄清', _strList(verdict!['questions'])),
                    _goalSection('建议完成标准', _strList(verdict!['criteria'])),
                    const SizedBox(height: 10),
                    const Text('改写版（可编辑，将作为实际执行的任务）', style: TextStyle(color: Color(0xFF8a909b), fontSize: 12)),
                    const SizedBox(height: 4),
                    _goalField(revisedCtrl, 5, '预检后这里给出可直接执行的版本'),
                  ],
                  if (error != null) ...[
                    const SizedBox(height: 8),
                    Text(error!, style: const TextStyle(color: Color(0xFFff6b63), fontSize: 12)),
                  ],
                  const SizedBox(height: 16),
                  Row(children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.pop(ctx),
                        style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF8a909b), side: const BorderSide(color: Color(0xFF20242b))),
                        child: const Text('取消'),
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
                                  setSheetState(() => error = '请先填写任务');
                                  return;
                                }
                                setSheetState(() {
                                  checking = true;
                                  error = null;
                                });
                                final data = await _fetchGoalPrecheck(task);
                                setSheetState(() {
                                  checking = false;
                                  if (data['ok'] == true) {
                                    verdict = data;
                                    final r = (data['revised'] as String?)?.trim();
                                    revisedCtrl.text = (r != null && r.isNotEmpty) ? r : task;
                                  } else {
                                    error = '预检失败：${data['error'] ?? '未知错误'}（可直接用原文发送）';
                                  }
                                });
                              },
                        style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF8a909b), side: const BorderSide(color: Color(0xFF20242b))),
                        child: checking
                            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF8a909b)))
                            : Text(verdict == null ? '预检' : '重新预检'),
                      ),
                    ),
                  ]),
                  if (verdict != null || error != null) ...[
                    const SizedBox(height: 8),
                    Row(children: [
                      Expanded(
                        child: TextButton(
                          onPressed: () => sendGoal(taskCtrl.text),
                          style: TextButton.styleFrom(foregroundColor: const Color(0xFF8a909b)),
                          child: const Text('用原文发送'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 2,
                        child: ElevatedButton(
                          onPressed: () => sendGoal(verdict != null ? (revisedCtrl.text.isNotEmpty ? revisedCtrl.text : taskCtrl.text) : taskCtrl.text),
                          style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF22ab9c), foregroundColor: Colors.white),
                          child: Text(ok ? '以 Goal 模式发送' : '确认并发送'),
                        ),
                      ),
                    ]),
                  ],
                ],
              ),
            ),
          );
        });
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final isStreaming = provider.isStreaming;
    final isConnected = provider.connectionState == ChatConnectionState.connected;
    final canSend = (_hasText || _attachments.isNotEmpty) && isConnected && !isStreaming;

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
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF14171c),
                        border: Border.all(color: const Color(0xFF20242b)),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.attach_file, size: 12, color: Color(0xFF8a909b)),
                          const SizedBox(width: 4),
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 150),
                            child: Text(
                              att['name']!,
                              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 12),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 4),
                          GestureDetector(
                            onTap: () => setState(() => _attachments.removeAt(idx)),
                            child: const Icon(Icons.close, size: 12, color: Color(0xFF8a909b)),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
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

                // Voice button
                _SmallButton(
                  onTap: (!_isTranscribing && isConnected) ? _toggleRecording : null,
                  icon: _isTranscribing
                      ? Icons.hourglass_top_rounded
                      : _isRecording
                          ? Icons.stop_circle_rounded
                          : Icons.mic_rounded,
                  color: _isRecording ? const Color(0xFFff6b63) : const Color(0xFF8a909b),
                ),
                const SizedBox(width: 4),

                // Goal-mode button — precheck the task with the aux-AI, then send
                _SmallButton(
                  onTap: (isConnected && !isStreaming) ? () => _showGoalSheet(provider) : null,
                  icon: Icons.track_changes_rounded,
                  color: const Color(0xFF8a909b),
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
                        hintText: _isRecording ? '录音中…' : _isTranscribing ? '识别中…' : 'Type a message…',
                        hintStyle: TextStyle(
                          color: _isRecording ? const Color(0xFFff6b63) : const Color(0xFF454b54),
                        ),
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                      onSubmitted: canSend ? (_) => _send(provider) : null,
                    ),
                  ),
                ),
                const SizedBox(width: 6),

                // Send / Cancel button
                if (isStreaming)
                  _ActionButton(
                    onTap: provider.cancel,
                    color: const Color(0xFFff6b63),
                    icon: Icons.stop_rounded,
                  )
                else
                  _ActionButton(
                    onTap: canSend ? () => _send(provider) : null,
                    color: canSend ? const Color(0xFF22ab9c) : const Color(0xFF14171c),
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

class _SmallButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData icon;
  final Color color;

  const _SmallButton({required this.onTap, required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 40,
        alignment: Alignment.center,
        child: Icon(icon, color: onTap != null ? color : const Color(0xFF454b54), size: 20),
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
