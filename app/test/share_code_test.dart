import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/share_code.dart';

/// 与网页端同样的写法：base64url 且去掉 padding。
String _code(String prefix, Map<String, dynamic> payload) =>
    '$prefix${base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '')}';

Map<String, dynamic> _relayPayload([Map<String, dynamic>? overrides]) => {
      'v': 3,
      'kind': 'multicc-relay',
      'name': '另一台 · Claude',
      'appType': 'claude',
      'baseUrl': 'https://host.example/claude-proxy/s1/remote',
      'authToken': 'mcr1.s1.secret',
      'relayShareId': 's1',
      'mode': 'cli',
      ...?overrides,
    };

Map<String, dynamic> _sshPayload([Map<String, dynamic>? overrides]) => {
      'v': 1,
      'kind': 'multicc-ssh',
      'name': '借用的反重力',
      'appType': 'agy',
      'sshTarget': 'me@192.168.1.20',
      'sshPort': 2222,
      'identityKey': '-----BEGIN ' 'OPENSSH PRIVATE KEY-----\nabc\n-----END ' 'OPENSSH PRIVATE KEY-----\n',
      'fileMode': 'mutagen',
      'shareId': 'sh1',
      ...?overrides,
    };

void main() {
  group('借道分享码', () {
    test('解析出线路字段并保留分享方式', () {
      final result = parseShareCode(_code(relayShareCodePrefix, _relayPayload()));
      expect(result.error, isNull);
      final payload = result.payload!;
      expect(payload.kind, 'relay');
      expect(payload.appType, 'claude');
      expect(payload.baseUrl, 'https://host.example/claude-proxy/s1/remote');
      expect(payload.authToken, 'mcr1.s1.secret');
      expect(payload.relayShareId, 's1');
      expect(payload.mode, 'cli');
      expect(payload.isAgy, isFalse);
    });

    test('反重力借道码固定按远程 CLI 处理', () {
      final result = parseShareCode(_code(relayShareCodePrefix,
          _relayPayload({'appType': 'agy', 'mode': null, 'baseUrl': 'https://host.example/agy-proxy/a1'})));
      expect(result.error, isNull);
      expect(result.payload!.isAgy, isTrue);
      expect(result.payload!.mode, 'cli');
    });

    test('旧码没有 mode 时按反代导入而不是报错', () {
      final payload = _relayPayload()..remove('mode');
      final result = parseShareCode(_code(relayShareCodePrefix, payload));
      expect(result.error, isNull);
      expect(result.payload!.mode, isNull);
      expect(result.payload!.modeLabel, '反代分享');
    });

    test('models 去重，model 不在列表里时补到最前面', () {
      final result = parseShareCode(_code(relayShareCodePrefix,
          _relayPayload({'model': 'x-1', 'models': ['y-2', 'y-2', '']})));
      expect(result.payload!.models, ['x-1', 'y-2']);
      expect(result.payload!.model, 'x-1');
      // 已在列表里的 model 不重复插入。
      final inside = parseShareCode(_code(relayShareCodePrefix,
          _relayPayload({'model': 'y-2', 'models': ['y-2', 'x-1']})));
      expect(inside.payload!.models, ['y-2', 'x-1']);
    });

    test('缺 baseUrl / 凭据 / 未知 appType 都拒绝', () {
      expect(parseShareCode(_code(relayShareCodePrefix, _relayPayload({'baseUrl': ''}))).error,
          '分享码缺少 baseUrl');
      expect(parseShareCode(_code(relayShareCodePrefix, _relayPayload({'authToken': ' '}))).error,
          '分享码缺少安全凭据');
      expect(parseShareCode(_code(relayShareCodePrefix, _relayPayload({'appType': 'gemini'}))).error,
          '分享码 appType 无效');
    });

    test('错的 kind 被拒绝', () {
      final result = parseShareCode(_code(relayShareCodePrefix, _relayPayload({'kind': 'multicc-ssh'})));
      expect(result.error, '不是 MultiCC 跨设备分享码');
    });

    test('前缀不对时提示应以 mcrelay1. 开头', () {
      expect(parseShareCode('hello').error, '不是有效的跨设备分享码（应以 mcrelay1. 开头）');
    });
  });

  group('SSH 借用码', () {
    test('解析出目标、端口与私钥', () {
      final result = parseShareCode(_code(sshShareCodePrefix, _sshPayload()));
      expect(result.error, isNull);
      final payload = result.payload!;
      expect(payload.kind, 'ssh');
      expect(payload.isSsh, isTrue);
      expect(payload.sshTarget, 'me@192.168.1.20');
      expect(payload.sshPort, 2222);
      expect(payload.fileMode, 'mutagen');
      expect(payload.identityKey, contains('BEGIN OPENSSH PRIVATE KEY'));
      expect(payload.modeLabel, contains('Mutagen'));
    });

    test('缺省 fileMode 视为 mutagen，remote_mcp 原样保留', () {
      final missing = _sshPayload()..remove('fileMode');
      expect(parseShareCode(_code(sshShareCodePrefix, missing)).payload!.fileMode, 'mutagen');
      final remote = parseShareCode(
          _code(sshShareCodePrefix, _sshPayload({'fileMode': 'remote_mcp'})));
      expect(remote.payload!.fileMode, 'remote_mcp');
    });

    test('越界端口视为未指定', () {
      final result = parseShareCode(_code(sshShareCodePrefix, _sshPayload({'sshPort': 70000})));
      expect(result.payload!.sshPort, isNull);
    });

    test('缺私钥 / 缺目标 / 非 agy 都拒绝', () {
      expect(parseShareCode(_code(sshShareCodePrefix, _sshPayload({'identityKey': 'x'}))).error,
          '借用码缺少借用的私钥');
      expect(parseShareCode(_code(sshShareCodePrefix, _sshPayload({'sshTarget': ' '}))).error,
          '借用码缺少 SSH 目标');
      expect(parseShareCode(_code(sshShareCodePrefix, _sshPayload({'appType': 'claude'}))).error,
          'SSH 借用码目前只支持反重力 agy');
    });

    test('借用码里的 relay kind 被拒绝', () {
      final result = parseShareCode(_code(sshShareCodePrefix, _sshPayload({'kind': 'multicc-relay'})));
      expect(result.error, '不是 MultiCC SSH 借用码');
    });

    test('坏 base64 报解码失败', () {
      expect(parseShareCode('mcssh1.@@@').error, '借用码无法解码，请检查是否复制完整');
      expect(parseShareCode('mcrelay1.@@@').error, '分享码无法解码，请检查是否复制完整');
    });

    test('两种码互相不认', () {
      // 借道码不会被 SSH 解析器接受，反之亦然。
      expect(parseShareCode(_code(sshShareCodePrefix, _relayPayload())).error,
          '不是 MultiCC SSH 借用码');
      expect(parseShareCode(_code(relayShareCodePrefix, _sshPayload())).error,
          '不是 MultiCC 跨设备分享码');
    });
  });
}
