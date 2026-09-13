import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/air_service.dart';

/// `/api/air` 快照里的终端会话（侧栏 TERMINAL 一组的数据源）。
///
/// 服务端发的是裸 map（`src/workspace/air-routes.js:37-38`：只给
/// `id / dirId / label / kind / cli`），所以这里要紧的是**解析容错**和
/// **按目录分组** —— 拿错了字段不会报错，只会让侧栏那一组少一行或者串目录。
void main() {
  AirSession parse(Map<String, dynamic> json) => AirSession.fromJson(json);

  group('AirSession.fromJson', () {
    test('四个字段照读', () {
      final s = parse({
        'id': 'sess-1',
        'dirId': 'd1',
        'label': '巡检终端',
        'kind': 'terminal',
        'cli': 'codex',
      });
      expect(s.id, 'sess-1');
      expect(s.dirId, 'd1');
      expect(s.label, '巡检终端');
      expect(s.cli, 'codex');
    });

    test('label 缺省 / 空白都退回 id（服务端也是 `s.label || s.id`）', () {
      expect(parse({'id': 'sess-2', 'dirId': 'd1'}).label, 'sess-2');
      expect(
        parse({'id': 'sess-3', 'dirId': 'd1', 'label': '   '}).label,
        'sess-3',
      );
    });

    test('dirId 缺省是 null，不是空串（空串会让它落进所有目录）', () {
      expect(parse({'id': 'sess-4'}).dirId, isNull);
      expect(parse({'id': 'sess-5', 'dirId': null}).dirId, isNull);
      expect(parse({'id': 'sess-6', 'dirId': 'd2'}).dirId, 'd2');
    });
  });

  group('AirSnapshot.terminalSessionsOf', () {
    final snapshot = AirSnapshot.fromJson({
      'directories': [
        {'id': 'd1', 'name': 'A', 'path': '/a'},
        {'id': 'd2', 'name': 'B', 'path': '/b'},
      ],
      'tasks': const [],
      'clis': const ['claude'],
      'sessions': [
        {'id': 's1', 'dirId': 'd1', 'label': 'a 的终端', 'kind': 'terminal'},
        {'id': 's2', 'dirId': 'd2', 'label': 'b 的终端', 'kind': 'terminal'},
        {'id': 's3', 'dirId': 'd1', 'label': 'a 的另一个', 'kind': 'terminal'},
      ],
    });

    test('只给当前目录的那些', () {
      expect(snapshot.terminalSessionsOf('d1').map((s) => s.id), ['s1', 's3']);
      expect(snapshot.terminalSessionsOf('d2').map((s) => s.id), ['s2']);
    });

    test('目录对不上就是空，不是「全给」', () {
      expect(snapshot.terminalSessionsOf('d9'), isEmpty);
      expect(snapshot.terminalSessionsOf(null), isEmpty);
    });

    test('没有 sessions 字段的旧响应不会炸', () {
      final bare = AirSnapshot.fromJson({'tasks': const []});
      expect(bare.sessions, isEmpty);
      expect(bare.terminalSessionsOf('d1'), isEmpty);
    });
  });

  group('AirSession.toSession', () {
    test('拼得出一个能开终端的会话', () {
      final session = parse({
        'id': 'sess-9',
        'dirId': 'd1',
        'label': '巡检终端',
        'cli': 'codex',
      }).toSession();
      expect(session.id, 'sess-9');
      expect(session.dirId, 'd1');
      expect(session.label, '巡检终端');
      expect(session.kind, SessionKind.terminal);
      expect(session.cli, SessionCli.codex);
    });

    test('cli 认不出来时回落 claude，不是崩在解析上', () {
      final session = parse({'id': 'sess-10', 'cli': '不认识的工具'}).toSession();
      expect(session.cli, SessionCli.claude);
      expect(session.kind, SessionKind.terminal);
    });
  });
}
