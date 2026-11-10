import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/unattended_state.dart';

/// 契约：docs/unattended-mode.md —— 状态、上限和「只有 active 是武装态」。
void main() {
  test('null / 非 Map 解析成 null（never used）', () {
    expect(UnattendedState.fromJson(null), isNull);
    expect(UnattendedState.fromJson('nope'), isNull);
    expect(UnattendedState.fromJson(const []), isNull);
  });

  test('完整 payload 往返：状态、轮次、最近判定、历史、stall', () {
    final raw = <String, dynamic>{
      'status': 'needs_human',
      'goal': '把登录页错误提示改清楚',
      'criteria': ['文案说清原因', '', '  ', 'analyze 通过'],
      'maxRounds': 12,
      'rounds': 3,
      'startedAt': 1000,
      'updatedAt': 2000,
      'lastVerdict': {
        'verdict': 'needs_human',
        'reason': '需要确认文案语气',
        'nextInstruction': '',
        'humanReason': '语气请用户拍板',
        'at': 1900,
      },
      'history': [
        {'at': 1200, 'verdict': 'continue', 'reason': '还没跑测试'},
        {'at': 1900, 'verdict': 'needs_human', 'reason': '需要确认文案语气'},
      ],
      'stall': {'sameInstruction': 1, 'auxFailures': 0},
    };

    final state = UnattendedState.fromJson(raw)!;
    expect(state.status, UnattendedState.statusNeedsHuman);
    expect(state.needsHuman, isTrue);
    expect(state.isActive, isFalse);
    expect(state.isTerminal, isTrue);
    expect(state.canResume, isTrue);
    expect(state.goal, '把登录页错误提示改清楚');
    // 空条目被丢掉，正文不动。
    expect(state.criteria, ['文案说清原因', 'analyze 通过']);
    expect(state.maxRounds, 12);
    expect(state.rounds, 3);
    expect(state.lastVerdict!.humanReason, '语气请用户拍板');
    expect(state.history, hasLength(2));
    expect(state.history.last.verdict, 'needs_human');
    expect(state.stall!.sameInstruction, 1);

    final again = UnattendedState.fromJson(state.toJson())!;
    expect(again.toJson(), state.toJson());
  });

  test('缺字段时给契约默认值（maxRounds 30 / rounds 0 / 无历史）', () {
    final state = UnattendedState.fromJson(const {'goal': '做点事'})!;
    expect(state.status, UnattendedState.statusStopped);
    expect(state.maxRounds, 30);
    expect(state.rounds, 0);
    expect(state.criteria, isEmpty);
    expect(state.history, isEmpty);
    expect(state.lastVerdict, isNull);
    expect(state.stall, isNull);
  });

  test('只有 active 能继续跑；其余状态按契约给出 canResume', () {
    UnattendedState at(String status) =>
        UnattendedState.fromJson({'status': status})!;

    expect(at('active').isActive, isTrue);
    expect(at('active').isTerminal, isFalse);
    expect(at('active').canResume, isFalse);

    for (final status in const [
      'needs_human',
      'exhausted',
      'stopped',
      'error',
    ]) {
      expect(at(status).canResume, isTrue, reason: status);
      expect(at(status).isTerminal, isTrue, reason: status);
    }

    // achieved 不能再 resume；要重新 start。
    expect(at('achieved').isAchieved, isTrue);
    expect(at('achieved').canResume, isFalse);
  });

  test('limits：缺省 30/200，非法值回退', () {
    expect(UnattendedLimits.fromJson(null).maxRoundsDefault, 30);
    expect(UnattendedLimits.fromJson(null).maxRoundsMax, 200);

    final parsed = UnattendedLimits.fromJson(const {
      'maxRoundsDefault': 50,
      'maxRoundsMax': 400,
    });
    expect(parsed.maxRoundsDefault, 50);
    expect(parsed.maxRoundsMax, 400);

    final fallback = UnattendedLimits.fromJson(const {
      'maxRoundsDefault': 0,
      'maxRoundsMax': -1,
    });
    expect(fallback.maxRoundsDefault, 30);
    expect(fallback.maxRoundsMax, 200);
  });

  test('snapshot 同时解析状态与上限', () {
    final snapshot = UnattendedSnapshot.fromJson(const {
      'ok': true,
      'unattended': null,
      'limits': {'maxRoundsDefault': 20, 'maxRoundsMax': 100},
    });
    expect(snapshot.state, isNull);
    expect(snapshot.limits.maxRoundsDefault, 20);
    expect(snapshot.limits.maxRoundsMax, 100);
  });
}
