import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'settings_service.dart';

/// 一次性的「录一段 → 整段转写」：`/api/voice/stt`。
///
/// Web 上这条路有三个落点，长得一模一样 —— Air 快速新建那颗 `#quick-task-mic`
/// （`public/air.js` 的 `toggleQuickDictation`：点一下开始、再点一下结束，
/// 转写结果追加进输入框）、任务板输入条、以及聊天页在流式听写（`/ws/voice`）
/// 用不了时的退路 —— 所以收成一份，谁用谁自带一个实例。
///
/// 听写（边说边出字、`/ws/voice`）是另一件事，在
/// [VoiceDictationService](voice_dictation_service.dart) 里。
class VoiceClipRecorder {
  VoiceClipRecorder({AudioRecorder? recorder})
    : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;

  bool _recording = false;
  bool _transcribing = false;

  bool get isRecording => _recording;
  bool get isTranscribing => _transcribing;
  bool get isBusy => _recording || _transcribing;

  /// 开录。拿不到麦克风权限就返回 false（Web 那边是 `getUserMedia` 抛异常，
  /// 文案「无法访问麦克风，请检查浏览器权限。」）。
  Future<bool> start() async {
    if (_recording) return true;
    if (!await _recorder.hasPermission()) return false;
    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/multicc_voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        numChannels: 1,
        sampleRate: 16000,
      ),
      path: path,
    );
    _recording = true;
    return true;
  }

  /// 停下来并转写，返回识别到的文本（可能是空串 —— 服务端没听清）。
  ///
  /// 转写失败抛 [VoiceClipException]；录音本身出问题（没在录、文件没了）返回
  /// 空串，跟「什么都没识别到」一个下场。
  Future<String> stopAndTranscribe(SettingsService settings) async {
    if (!_recording) return '';
    final path = await _recorder.stop();
    _recording = false;
    if (path == null) return '';

    _transcribing = true;
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
      if (res.statusCode != 200) {
        throw VoiceClipException(statusCode: res.statusCode);
      }
      final json = jsonDecode(body) as Map<String, dynamic>;
      final text = (json['text'] as String? ?? '').trim();
      // 转写成功之后录音就没用了 —— 留着只会在临时目录里越堆越多。
      unawaited(_deleteQuietly(path));
      return text;
    } on VoiceClipException {
      rethrow;
    } catch (e) {
      throw VoiceClipException(cause: e);
    } finally {
      _transcribing = false;
    }
  }

  /// 丢掉这一段（用户中途取消，或者宿主不想要了）。
  Future<void> cancel() async {
    if (!_recording) return;
    final path = await _recorder.stop();
    _recording = false;
    if (path != null) await _deleteQuietly(path);
  }

  void dispose() {
    _recorder.dispose();
  }

  static Future<void> _deleteQuietly(String path) async {
    try {
      final file = File(path);
      if (file.existsSync()) await file.delete();
    } catch (_) {
      // 临时目录里的一个文件而已，删不掉不该影响转写结果。
    }
  }
}

/// 转写失败的两副面孔：服务端回了非 200，或者路上出了别的事。
///
/// `toString` 拼出来的就是原来聊天页 SnackBar 上那两句
/// （`STT failed: 500` / `STT error: …`），所以搬过来之后提示不变。
class VoiceClipException implements Exception {
  const VoiceClipException({this.statusCode, this.cause});

  final int? statusCode;
  final Object? cause;

  @override
  String toString() =>
      statusCode != null ? 'STT failed: $statusCode' : 'STT error: $cause';
}
