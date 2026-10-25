// 「🖥 屏幕」P2P 复用器：信令顺序、帧来源切换、分片拼帧、回退与重试。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_p2p.dart';

Uint8List _frame(int type, List<int> payload) {
  final out = Uint8List(5 + payload.length);
  out[0] = type;
  final len = payload.length;
  out[1] = (len >> 24) & 0xff;
  out[2] = (len >> 16) & 0xff;
  out[3] = (len >> 8) & 0xff;
  out[4] = len & 0xff;
  out.setRange(5, out.length, payload);
  return out;
}

List<int> _frameBytes(Uint8List frame) => frame.toList();

Future<void> _pumpUntil(
  bool Function() condition, [
  Duration limit = const Duration(seconds: 2),
]) async {
  final deadline = DateTime.now().add(limit);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail('condition not met in time');
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
}

/// 假对端：手动控制“打开/关闭”，并记录收到的信令与输入。
class _FakePeer implements RtcPeer {
  final _opened = StreamController<void>.broadcast();
  final _closed = StreamController<void>.broadcast();
  final _incoming = StreamController<Uint8List>.broadcast();
  final _candidates = StreamController<Map<String, dynamic>>.broadcast();

  bool _open = false;
  bool closedByMux = false;
  String offer = 'offer-sdp';
  final List<String> answers = <String>[];
  final List<Map<String, dynamic>> added = <Map<String, dynamic>>[];
  final List<Uint8List> sent = <Uint8List>[];

  @override
  Stream<void> get opened => _opened.stream;
  @override
  Stream<void> get closed => _closed.stream;
  @override
  Stream<Uint8List> get incoming => _incoming.stream;
  @override
  Stream<Map<String, dynamic>> get candidates => _candidates.stream;
  @override
  bool get isOpen => _open;

  @override
  Future<String> createOffer() async => offer;

  @override
  Future<void> acceptAnswer(String sdp) async => answers.add(sdp);

  @override
  Future<void> addCandidate({
    required String candidate,
    String? sdpMid,
    int? sdpMLineIndex,
  }) async {
    added.add({
      'candidate': candidate,
      'sdpMid': sdpMid,
      'sdpMLineIndex': sdpMLineIndex,
    });
  }

  @override
  void send(Uint8List bytes) => sent.add(bytes);

  @override
  Future<void> close() async {
    closedByMux = true;
    _open = false;
    await _opened.close();
    await _closed.close();
    await _incoming.close();
    await _candidates.close();
  }

  // —— 测试驱动 ——
  void openChannel() {
    _open = true;
    _opened.add(null);
  }

  void emit(Uint8List bytes) => _incoming.add(bytes);

  void emitLocalCandidate(Map<String, dynamic> candidate) =>
      _candidates.add(candidate);

  Future<void> drop() async {
    _open = false;
    _closed.add(null);
  }
}

class _Rig {
  _Rig({
    Duration openTimeout = const Duration(seconds: 10),
    Duration retryDelay = const Duration(seconds: 30),
    int maxRetries = 1,
  }) {
    mux = RemoteScreenP2pMux(
      peerFactory: (iceServers) async {
        iceSeen.add(iceServers);
        final peer = _FakePeer();
        peers.add(peer);
        return peer;
      },
      sendWs: wsInput.add,
      sendSignal: signals.add,
      onDirectChanged: directChanges.add,
      openTimeout: openTimeout,
      retryDelay: retryDelay,
      maxRetries: maxRetries,
    );
    mux.frames.listen(frames.add);
  }

  final List<List<Map<String, dynamic>>> iceSeen = [];
  final List<_FakePeer> peers = [];
  final List<Uint8List> wsInput = [];
  final List<Map<String, dynamic>> signals = [];
  final List<bool> directChanges = [];
  final List<Uint8List> frames = [];
  late final RemoteScreenP2pMux mux;

  _FakePeer get peer => peers.last;

  Iterable<Map<String, dynamic>> signalsOf(String type) =>
      signals.where((signal) => signal['t'] == type);

  void hello({List<Map<String, dynamic>> iceServers = const []}) {
    mux.onWsText(
      jsonEncode({'t': 'rtc-hello', 'iceServers': iceServers}),
    );
  }

  void active(bool on) => mux.onWsText(jsonEncode({'t': 'rtc-active', 'on': on}));

  Future<void> dispose() => mux.dispose();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('信令顺序：hello → offer；answer / 远端 ICE 交给对端，本地 ICE 上报', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);

    rig.hello(iceServers: [
      {
        'urls': ['stun:stun.l.google.com:19302'],
      },
    ]);
    await _pumpUntil(() => rig.signalsOf('rtc-offer').isNotEmpty);

    expect(rig.peers, hasLength(1), reason: 'hello 只发起一次');
    expect(rig.iceSeen.single, isNotEmpty);
    expect(rig.signalsOf('rtc-offer').single['sdp'], 'offer-sdp');
    expect(rig.signals.first['t'], 'rtc-offer');

    rig.mux.onWsText(jsonEncode({'t': 'rtc-answer', 'sdp': 'the-answer'}));
    await _pumpUntil(() => rig.peer.answers.isNotEmpty);
    expect(rig.peer.answers.single, 'the-answer');

    rig.mux.onWsText(
      jsonEncode({
        't': 'rtc-ice',
        'candidate': {'candidate': 'remote-1', 'sdpMid': '0', 'sdpMLineIndex': 1},
      }),
    );
    await _pumpUntil(() => rig.peer.added.isNotEmpty);
    expect(rig.peer.added.single, {
      'candidate': 'remote-1',
      'sdpMid': '0',
      'sdpMLineIndex': 1,
    });

    rig.peer.emitLocalCandidate({
      'candidate': 'local-1',
      'sdpMid': '0',
      'sdpMLineIndex': 0,
    });
    await _pumpUntil(() => rig.signalsOf('rtc-ice').isNotEmpty);
    expect(rig.signalsOf('rtc-ice').single['candidate'], {
      'candidate': 'local-1',
      'sdpMid': '0',
      'sdpMLineIndex': 0,
    });
    expect(rig.directChanges, isEmpty, reason: '还没 rtc-active');
  });

  test('rtc-active 之前只吐 WS 帧；DataChannel 帧先攒着，切换后补发并丢弃 WS 残余', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);

    final wsBefore = _frame(3, [1, 2, 3]);
    rig.mux.onWsBinary(wsBefore);
    await _pumpUntil(() => rig.frames.length == 1);

    final early = _frame(2, const [9, 9]);
    rig.peer.emit(early);
    await _pumpUntil(() => true); // 让 microtask 跑完
    expect(rig.frames, hasLength(1), reason: '直连未激活，DC 帧先攒着');
    expect(rig.directChanges, isEmpty);

    rig.active(true);
    await _pumpUntil(() => rig.frames.length >= 2);
    expect(_frameBytes(rig.frames.last), _frameBytes(early));
    expect(rig.directChanges, [true]);

    rig.mux.onWsBinary(_frame(3, const [7, 7, 7]));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.frames, hasLength(2), reason: '直连期间丢弃 WS 残余帧');

    final live = _frame(3, const [4, 5, 6]);
    rig.peer.emit(live);
    await _pumpUntil(() => rig.frames.length >= 3);
    expect(_frameBytes(rig.frames.last), _frameBytes(live));
  });

  test('DataChannel 分片拼帧：帧头跨片、一帧多片、一片多帧', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    rig.active(true);

    final a = _frame(2, List<int>.generate(40, (i) => i));
    // 帧头都被切开：先给 2 字节，再给 1 字节，再给剩下。
    rig.peer.emit(Uint8List.fromList(a.sublist(0, 2)));
    rig.peer.emit(Uint8List.fromList(a.sublist(2, 3)));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.frames, isEmpty);
    rig.peer.emit(Uint8List.fromList(a.sublist(3, 20)));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.frames, isEmpty, reason: '还差尾巴');
    rig.peer.emit(Uint8List.fromList(a.sublist(20)));
    await _pumpUntil(() => rig.frames.length == 1);
    expect(_frameBytes(rig.frames.single), _frameBytes(a));

    // 一片里有两帧，随后再来一帧（跨片）。
    final b = _frame(3, const [1, 1, 1, 1]);
    final c = _frame(3, const [2, 2, 2]);
    final batched = Uint8List(b.length + 4)..setRange(0, b.length, b);
    batched.setRange(b.length, batched.length, c.sublist(0, 4));
    rig.peer.emit(batched);
    await _pumpUntil(() => rig.frames.length == 2);
    expect(_frameBytes(rig.frames[1]), _frameBytes(b));

    rig.peer.emit(Uint8List.fromList(c.sublist(4)));
    await _pumpUntil(() => rig.frames.length == 3);
    expect(_frameBytes(rig.frames[2]), _frameBytes(c));
  });

  test('rtc-active{off}：丢弃残余半帧、回 WS，并通知上层退回中继', () async {
    final rig = _Rig(retryDelay: const Duration(seconds: 30));
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    rig.peer.openChannel();
    await _pumpUntil(() => rig.peer.isOpen);
    rig.active(true);
    await _pumpUntil(() => rig.directChanges.isNotEmpty);

    // 半帧（帧头说 100 字节，只给了 10 字节）。
    final partial = _frame(3, List<int>.filled(100, 5));
    rig.peer.emit(Uint8List.fromList(partial.sublist(0, 10)));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.frames, isEmpty);

    rig.active(false);
    expect(rig.directChanges, [true, false]);
    expect(
      rig.signalsOf('rtc-close'),
      isNotEmpty,
      reason: '退回中继要关掉对端',
    );

    final ws = _frame(2, const [8, 8]);
    rig.mux.onWsBinary(ws);
    await _pumpUntil(() => rig.frames.length == 1);
    expect(_frameBytes(rig.frames.single), _frameBytes(ws));
    expect(rig.frames, hasLength(1), reason: '半帧不能漏出去');
  });

  test('DataChannel 关闭也退回 WS（服务端会补关键帧）', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    rig.peer.openChannel();
    rig.active(true);
    await _pumpUntil(() => rig.directChanges.isNotEmpty);

    await rig.peer.drop();
    await _pumpUntil(() => rig.directChanges.length == 2);
    expect(rig.directChanges, [true, false]);

    final ws = _frame(2, const [3, 3]);
    rig.mux.onWsBinary(ws);
    await _pumpUntil(() => rig.frames.isNotEmpty);
    expect(_frameBytes(rig.frames.single), _frameBytes(ws));
  });

  test('输入走向：直连期间走 DataChannel，否则走 WS', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);

    final before = Uint8List.fromList([0x4b]);
    rig.mux.send(before);
    expect(rig.wsInput, hasLength(1));
    expect(rig.peer.sent, isEmpty);

    rig.peer.openChannel();
    rig.active(true);
    await _pumpUntil(() => rig.directChanges.isNotEmpty);

    final direct = Uint8List.fromList([5, 1, 2, 3, 4]);
    rig.mux.send(direct);
    await _pumpUntil(() => rig.peer.sent.isNotEmpty);
    expect(_frameBytes(rig.peer.sent.single), _frameBytes(direct));
    expect(rig.wsInput, hasLength(1), reason: '直连期间不再走 WS');

    rig.active(false);
    final after = Uint8List.fromList([0x4b]);
    rig.mux.send(after);
    await _pumpUntil(() => rig.wsInput.length == 2);
    expect(_frameBytes(rig.wsInput.last), _frameBytes(after));
  });

  test('打开超时静默回落，只自动重试一次', () async {
    final rig = _Rig(
      openTimeout: const Duration(milliseconds: 40),
      retryDelay: const Duration(milliseconds: 30),
      maxRetries: 1,
    );
    addTearDown(rig.dispose);

    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    expect(rig.peer.isOpen, isFalse);

    await _pumpUntil(() => rig.signalsOf('rtc-close').isNotEmpty);
    expect(rig.directChanges, isEmpty, reason: '从没直连过');
    expect(rig.peers.single.closedByMux, isTrue);

    // 重试一次：第二个对端。对端对象先建出来，offer 信令稍后才发，
    // 所以等信令而不是等对象（全量跑时机器忙会抢跑）。
    await _pumpUntil(() => rig.signalsOf('rtc-offer').length == 2);
    expect(rig.peers, hasLength(2));

    // 第二次仍然打不开：不会再重试。
    await _pumpUntil(() => !rig.peers.last.isOpen, const Duration(seconds: 1));
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(rig.peers, hasLength(2), reason: '每条活流只自动重试一次');
    expect(rig.directChanges, isEmpty);
  });

  test('没有 hello 不发 offer；重复 hello 不会另起一个对端', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);

    rig.mux.onWsText(jsonEncode({'t': 'rtc-answer', 'sdp': 'stray'}));
    rig.mux.onWsText(jsonEncode({'t': 'rtc-active', 'on': true}));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.peers, isEmpty);
    expect(rig.signals, isEmpty);

    rig.hello();
    await _pumpUntil(() => rig.peers.length == 1);
    rig.hello();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(rig.peers, hasLength(1));
  });

  test('dispose 关闭对端与帧流', () async {
    final rig = _Rig();
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    final peer = rig.peer;

    await rig.mux.dispose();
    expect(peer.closedByMux, isTrue);
    expect(rig.mux.direct, isFalse);

    // dispose 之后来的东西一律忽略。
    rig.mux.onWsBinary(_frame(3, const [1]));
    expect(rig.frames, isEmpty);
  });

  test('超长帧头（>8MB）视为通道坏了，回退中继', () async {
    final rig = _Rig();
    addTearDown(rig.dispose);
    rig.hello();
    await _pumpUntil(() => rig.peers.isNotEmpty);
    rig.peer.openChannel();
    rig.active(true);
    await _pumpUntil(() => rig.directChanges.isNotEmpty);

    rig.peer.emit(Uint8List.fromList([3, 0xff, 0xff, 0xff, 0xff]));
    await _pumpUntil(() => rig.directChanges.length == 2);
    expect(rig.directChanges, [true, false]);
    expect(rig.frames, isEmpty);
  });
}
