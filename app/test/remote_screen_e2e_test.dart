// 「🖥 屏幕」端到端：App 的真实连接代码 ⇄ 真实 server.js ⇄ 假 macOS Agent。
//
// 这条测试故意不替换任何传输层：RemoteScreenService 用的是真的 WsTicketClient
// （POST /api/auth/ws-ticket 换票）、真的 WebSocketChannel.connect、真的
// http.Client，和真的 RemoteScreenH264 切帧/编码。唯一的假件是平台视频解码器
// （flutter test 下没有 platform channel）——它只记录送进来的 access unit 并回
// 一帧合成画面，让服务进入 live。
//
// 测试台：tests/helpers/remote-screen-e2e-harness.js 起一个隔离数据目录的
// server.js，外加一个「模拟隧道」代理（补 X-Forwarded-For，让服务端按外网请求
// 验令牌/换票）和一个假 Agent（h264.sock 回放 Agent 真 VideoToolbox 编出来的
// tests/fixtures/remote-screen-h264/agent-stream.bin，并记录收到的输入）。
//
// 只覆盖：H.264 优先路径、逐字节帧解析、App→隧道的输入保真、Agent 崩溃回退、
// 错令牌被拒。RFB 细节由 remote_screen_service_test.dart 负责。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:multicc_app/services/remote_screen_h264.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 工作树根（flutter test 的 cwd 是 app/），也容忍从根目录跑。
String? _findWorktreeRoot() {
  var dir = Directory.current.absolute;
  for (var i = 0; i < 10; i++) {
    if (File(
      '${dir.path}/tests/helpers/remote-screen-e2e-harness.js',
    ).existsSync()) {
      return dir.path;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  return null;
}

String? _skipReason() {
  if (!Platform.isMacOS) {
    return 'the real server only exposes h264.sock on macOS (desktop-host)';
  }
  try {
    final version = Process.runSync('node', ['--version']);
    if (version.exitCode != 0) {
      return 'node is on PATH but not usable (exit ${version.exitCode})';
    }
  } catch (_) {
    return 'node is not on PATH';
  }
  final root = _findWorktreeRoot();
  if (root == null) {
    return 'worktree root with tests/helpers/remote-screen-e2e-harness.js '
        'not found from ${Directory.current.path}';
  }
  return null;
}

// ── 测试台进程 ─────────────────────────────────────────────────────────────

class _Harness {
  _Harness._(
    this._process,
    this._stderr,
    this.server,
    this.control,
    this.token,
  );

  final Process _process;
  final StringBuffer _stderr;
  final String server; // 隧道 URL（外网视角）
  final String control; // 假 Agent 的控制端口（loopback）
  final String token;
  bool _stopped = false;

  static Future<_Harness> start(String root) async {
    final process = await Process.start('node', [
      'tests/helpers/remote-screen-e2e-harness.js',
    ], workingDirectory: root);
    final stderr = StringBuffer();
    final stdoutLines = <String>[];
    final ready = Completer<_Harness>();

    process.stderr
        .transform(utf8.decoder)
        .listen(stderr.write, onError: (Object _) {});
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          stdoutLines.add(line);
          if (ready.isCompleted) return;
          try {
            final decoded = jsonDecode(line);
            if (decoded is Map && decoded['ready'] == true) {
              ready.complete(
                _Harness._(
                  process,
                  stderr,
                  decoded['server'] as String,
                  decoded['control'] as String,
                  decoded['token'] as String,
                ),
              );
            }
          } catch (_) {
            // 非就绪行（node 警告等）忽略，失败时统一回显。
          }
        }, onError: (Object _) {});
    // 早退（rust 编译失败、端口占用…）：把 stderr 带进失败原因。
    unawaited(
      process.exitCode.then((code) {
        if (!ready.isCompleted) {
          ready.completeError(
            StateError(
              'harness exited with $code before ready\n'
              'stdout:\n${stdoutLines.join('\n')}\n'
              'stderr:\n$stderr',
            ),
          );
        }
      }),
    );

    try {
      return await ready.future.timeout(const Duration(seconds: 150));
    } catch (error) {
      if (!ready.isCompleted) ready.completeError(error);
      await _kill(process);
      rethrow;
    }
  }

  static Future<void> _kill(Process process) async {
    try {
      await process.stdin.close();
    } catch (_) {}
    if (await _waitExit(process, const Duration(seconds: 12))) return;
    process.kill(ProcessSignal.sigterm);
    if (await _waitExit(process, const Duration(seconds: 8))) return;
    process.kill(ProcessSignal.sigkill);
    await _waitExit(process, const Duration(seconds: 5));
  }

  static Future<bool> _waitExit(Process process, Duration limit) async {
    try {
      await process.exitCode.timeout(limit);
      return true;
    } on TimeoutException {
      return false;
    }
  }

  /// 关 stdin 让测试台自己收尾（它会关掉 server.js / 隧道 / 假 Agent 并删临时目录）。
  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    await _kill(_process);
  }

  String get log => _stderr.toString();
}

// ── 假平台解码器 ──────────────────────────────────────────────────────────

class _DecodeCall {
  _DecodeCall({
    required this.bytes,
    required this.pts,
    required this.key,
    required this.width,
    required this.height,
  });

  final Uint8List bytes;
  final int pts;
  final bool key;
  final int width;
  final int height;
}

class _RecordingDecoder implements H264Decoder {
  final List<_DecodeCall> calls = <_DecodeCall>[];
  final StreamController<H264Frame> _frames =
      StreamController<H264Frame>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  bool opened = false;
  bool closed = false;

  /// 合成画面的尺寸 = 编码尺寸，让 RemoteScreenH264 不做坐标缩放，
  /// 输入金样才能逐字节比对。
  int frameWidth = 1470;
  int frameHeight = 956;

  @override
  Stream<H264Frame> get frames => _frames.stream;

  @override
  Stream<String> get errors => _errors.stream;

  @override
  Future<bool> open() async {
    opened = true;
    return true;
  }

  @override
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  }) {
    calls.add(
      _DecodeCall(
        bytes: Uint8List.fromList(annexB),
        pts: timestampUs,
        key: key,
        width: width,
        height: height,
      ),
    );
    if (!_frames.isClosed) {
      _frames.add(
        H264Frame(
          // 页面只读 width/height；不给 5.6MB 的 BGRA 也能进入 live。
          bytes: Uint8List(0),
          width: frameWidth,
          height: frameHeight,
          key: key,
        ),
      );
    }
  }

  @override
  Future<void> close() async {
    if (closed) return;
    closed = true;
    if (!_frames.isClosed) await _frames.close();
    if (!_errors.isClosed) await _errors.close();
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

Future<void> _until(
  FutureOr<bool> Function() condition, {
  Duration limit = const Duration(seconds: 60),
  required String what,
  String Function()? detail,
}) async {
  final deadline = DateTime.now().add(limit);
  while (DateTime.now().isBefore(deadline)) {
    if (await condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 40));
  }
  fail(
    'timed out after ${limit.inSeconds}s waiting for $what'
    '${detail == null ? '' : '\n${detail()}'}',
  );
}

Uint8List _hexBytes(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String _hex(Uint8List bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

bool _sameBytes(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

class _AccessUnit {
  _AccessUnit(this.annexB, this.pts, this.key);
  final Uint8List annexB;
  final int pts;
  final bool key;
}

/// agent-stream.bin = [type u8][len u32 BE][payload]…
List<Map<String, dynamic>> _parseAgentStream(Uint8List data) {
  final messages = <Map<String, dynamic>>[];
  var offset = 0;
  while (offset + 5 <= data.length) {
    final length =
        (data[offset + 1] << 24) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 8) |
        data[offset + 4];
    if (offset + 5 + length > data.length) {
      throw StateError('truncated fixture message at $offset');
    }
    messages.add({
      'type': data[offset],
      'bytes': Uint8List.sublistView(data, offset, offset + 5 + length),
    });
    offset += 5 + length;
  }
  return messages;
}

Map<String, dynamic> _readJson(String path) =>
    jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;

// ── 测试 ──────────────────────────────────────────────────────────────────

void main() {
  // flutter_test 的 binding 会装上返回 400 的 HttpOverrides；这条测试要真的
  // 走 loopback socket，所以明确清掉（本文件也不初始化 binding）。
  HttpOverrides.global = null;

  final skip = _skipReason();

  test(
    'App ⇄ real server ⇄ fake agent: h264 live, byte-exact input, crash → '
    'fallback, bad token rejected',
    () async {
      final root = _findWorktreeRoot()!;
      final fixtureDir = '$root/tests/fixtures/remote-screen-h264';
      final messages = _parseAgentStream(
        File('$fixtureDir/agent-stream.bin').readAsBytesSync(),
      );
      final wire = _readJson('$root/tests/fixtures/remote-screen-wire.json');

      // config 尺寸 + 待解码 access unit（跳过 5 字节头与 8 字节 pts）。
      final config = messages.firstWhere((m) => m['type'] == 1);
      final configJson =
          jsonDecode(
                utf8.decode(
                  Uint8List.sublistView(config['bytes'] as Uint8List, 5),
                ),
              )
              as Map<String, dynamic>;
      expect(configJson['width'], 1470);
      expect(configJson['height'], 956);
      final expected = <_AccessUnit>[
        for (final message in messages)
          if (message['type'] == 2 || message['type'] == 3)
            _AccessUnit(
              Uint8List.sublistView(message['bytes'] as Uint8List, 13),
              ByteData.sublistView(
                message['bytes'] as Uint8List,
                5,
                13,
              ).getUint64(0, Endian.big),
              message['type'] == 2,
            ),
      ];
      expect(expected, isNotEmpty);

      final harness = await _Harness.start(root);
      addTearDown(harness.stop);
      final client = http.Client();
      addTearDown(client.close);

      // 设置指向隧道 URL + 真令牌；服务里 host/token 都是每次请求现读的。
      SharedPreferences.setMockInitialValues(<String, Object>{
        'multicc_host': harness.server,
        'multicc_token': harness.token,
      });
      final settings = await SettingsService.getInstance();
      expect(settings.host, harness.server);
      expect(settings.token, harness.token);

      // ── 1. 能力探测 + 换票 + WS：进入 H.264 live ─────────────────────
      final decoder = _RecordingDecoder();
      final service = RemoteScreenService(
        settings: settings,
        h264DecoderFactory: () => decoder,
      );
      try {
        service.connectLive();
        await _until(
          () => service.mode == RemoteScreenMode.live && service.h264Active,
          what:
              'live h264 (mode=${service.mode}, decoder opened=${decoder.opened}, '
              'server log:\n${harness.log})',
        );
        expect(service.source, isNotNull);

        // ── 2. 解码器收到 fixture 的 access unit，逐字节、按序、flag 正确 ──
        await _until(
          () =>
              decoder.calls.any(
                (call) => _sameBytes(call.bytes, expected.last.annexB),
              ) ||
              // 解析错位时永远等不到最后一帧；两遍整段之后仍不匹配就直接判。
              decoder.calls.length >= expected.length * 2,
          what: 'the fixture access units to reach the decoder',
          detail: () =>
              'decoded ${decoder.calls.length} access units; first bytes: '
              '${decoder.calls.isEmpty ? '(none)' : _hex(decoder.calls.first.bytes)}',
        );
        // 假 Agent 收到 App 建连时索要关键帧的 'K' 会整体重放一遍（与真 Agent
        // 静止屏幕上重编最后一帧同义），所以同一 access unit 可能出现两次。
        await Future<void>.delayed(const Duration(milliseconds: 400));

        expect(decoder.opened, isTrue);
        expect(
          decoder.calls.length,
          greaterThanOrEqualTo(expected.length),
          reason: 'every fixture access unit must be decoded',
        );
        var next = 0;
        for (final call in decoder.calls) {
          final index = expected.indexWhere(
            (unit) => _sameBytes(unit.annexB, call.bytes),
          );
          expect(
            index,
            isNonNegative,
            reason:
                'decoded bytes are not any fixture access unit '
                '(pts=${call.pts}): ${_hex(call.bytes)}',
          );
          final unit = expected[index];
          expect(
            call.pts,
            unit.pts,
            reason: 'pts comes from the 8-byte header',
          );
          expect(
            call.key,
            unit.key,
            reason: 'key flag must be true only for the type-2 message',
          );
          expect(call.width, 1470);
          expect(call.height, 956);
          if (index == next) {
            // 下一帧（首次出现）：顺序必须严格向前。
            next++;
          } else {
            expect(
              index,
              lessThan(next),
              reason: 'fixture access units must be decoded in order',
            );
          }
        }
        expect(
          next,
          expected.length,
          reason:
              'the whole fixture stream must decode at least once, in order',
        );

        // ── 3. 输入：App 的真实 ScreenSource 编码原样回到 Agent ──────────
        await client.post(Uri.parse('${harness.control}/agent/reset'));
        final goldenInputs = (wire['clientToAgent'] as List)
            .cast<Map<String, dynamic>>()
            .where((entry) => entry['kind'] != 'keyRequest')
            .toList();
        expect(goldenInputs, isNotEmpty);
        final wanted = <int>[];
        for (final entry in goldenInputs) {
          if (entry['kind'] == 'pointer') {
            service.source!.pointerEvent(
              entry['mask'] as int,
              entry['x'] as int,
              entry['y'] as int,
            );
          } else if (entry['kind'] == 'key') {
            service.source!.keyEvent(
              entry['down'] as bool,
              entry['keysym'] as int,
            );
          } else {
            fail('unexpected wire entry kind: ${entry['kind']}');
          }
          wanted.addAll(_hexBytes(entry['hex'] as String));
        }
        final wantedBytes = Uint8List.fromList(wanted);
        Map<String, dynamic> lastSnapshot = const <String, dynamic>{};
        var agentBytes = <int>[];
        await _until(
          () async {
            lastSnapshot =
                jsonDecode(
                      (await client.get(
                        Uri.parse('${harness.control}/agent'),
                      )).body,
                    )
                    as Map<String, dynamic>;
            final connections = (lastSnapshot['connections'] as List)
                .cast<Map<String, dynamic>>();
            final raw = connections.map((c) => c['raw'] as String).join();
            // 服务端桥自己也会补 'K'（0x4b）；金样里没有 0x4b，滤掉它，
            // 剩下的必须与 App 发的一字不差。
            agentBytes = _hexBytes(raw).where((b) => b != 0x4b).toList();
            return agentBytes.length >= wantedBytes.length;
          },
          limit: const Duration(seconds: 30),
          what: 'the App input to reach the agent',
          detail: () =>
              'mode=${service.mode} h264Active=${service.h264Active} '
              'decoded=${decoder.calls.length}\n'
              'agent snapshot: ${jsonEncode(lastSnapshot)}\n'
              'server log:\n${harness.log}',
        );
        expect(
          agentBytes,
          orderedEquals(wantedBytes),
          reason:
              'App → tunnel → server → agent input must be byte-exact; '
              'got ${_hex(Uint8List.fromList(agentBytes))}',
        );

        // ── 4. Agent 崩溃：离开 h264，最终落到 fallback（没有 rfb.sock）──
        final dropped = await client.post(
          Uri.parse('${harness.control}/agent/drop'),
        );
        expect(dropped.statusCode, 200);
        await _until(
          () => service.mode == RemoteScreenMode.fallback,
          what: 'fallback after the agent stream drops',
        );
        expect(service.h264Active, isFalse);
        expect(service.rfb, isNull, reason: 'no rfb.sock exists on the agent');
      } finally {
        service.dispose();
      }

      // ── 5. 错令牌：换票/能力查询都被端到端拒绝，绝不进入 h264 ──────────
      settings.enterDemo(host: harness.server, token: 'wrong-token-0000');
      addTearDown(settings.exitDemo);
      final deniedDecoder = _RecordingDecoder();
      final denied = RemoteScreenService(
        settings: settings,
        h264DecoderFactory: () => deniedDecoder,
      );
      addTearDown(denied.dispose);
      denied.connectLive();
      await _until(
        () => denied.mode == RemoteScreenMode.fallback,
        what: 'fallback with a wrong access token',
      );
      expect(denied.h264Active, isFalse);
      expect(deniedDecoder.opened, isFalse, reason: 'h264 never attempted');
      expect(deniedDecoder.calls, isEmpty);
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
