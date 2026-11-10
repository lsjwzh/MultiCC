import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/unattended_state.dart';

/// 契约：docs/unattended-mode.md —— 状态、时限和「只有 active 是武装态」。
/// 2026-11 产品决定：轮次上限退场，改成最长值守时间（maxDurationMinutes /
/// deadlineAt）；旧快照里的 maxRounds 直接忽略。
void main() {
  test('null / 非 Map 解析成 null（never used）', () {
    expect(UnattendedState.fromJson(null), isNull);
    expect(UnattendedState.fromJson('nope'), isNull);
    expect(UnattendedState.fromJson(const []), isNull);
  });

  test('完整 payload 往返：状态、时限、轮次（仅信息）、最近判定、历史、stall', () {
    final raw = <String, dynamic>{
      'status': 'needs_human',
      'goal': '把登录页错误提示改清楚',
      'criteria': ['文案说清原因', '', '  ', 'analyze 通过'],
      'maxDurationMinutes': 90,
      'rounds': 3,
      'startedAt': 1000,
      'deadlineAt': 5401000,
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
    expect(state.maxDurationMinutes, 90);
    expect(state.rounds, 3);
    expect(state.startedAt, 1000);
    expect(state.deadlineAt, 5401000);
    expect(state.lastVerdict!.humanReason, '语气请用户拍板');
    expect(state.history, hasLength(2));
    expect(state.history.last.verdict, 'needs_human');
    expect(state.stall!.sameInstruction, 1);

    final again = UnattendedState.fromJson(state.toJson())!;
    expect(again.toJson(), state.toJson());
    expect(state.toJson().containsKey('maxRounds'), isFalse);
  });

  test('缺字段时给契约默认值（120 分钟 / rounds 0 / 无截止 / 无历史）', () {
    final state = UnattendedState.fromJson(const {'goal': '做点事'})!;
    expect(state.status, UnattendedState.statusStopped);
    expect(
      state.maxDurationMinutes,
      UnattendedState.defaultMaxDurationMinutes,
    );
    expect(state.maxDurationMinutes, 120);
    expect(state.rounds, 0);
    expect(state.startedAt, 0);
    expect(state.deadlineAt, 0);
    expect(state.criteria, isEmpty);
    expect(state.history, isEmpty);
    expect(state.lastVerdict, isNull);
    expect(state.stall, isNull);
    expect(state.remaining(999), isNull);
  });

  test('宽容解析：字符串数字收下，null / 负数回默认，旧 maxRounds 被忽略', () {
    final strings = UnattendedState.fromJson(const {
      'maxDurationMinutes': '90',
      'rounds': '4',
      'startedAt': '1000',
      'deadlineAt': '7201000',
    })!;
    expect(strings.maxDurationMinutes, 90);
    expect(strings.rounds, 4);
    expect(strings.startedAt, 1000);
    expect(strings.deadlineAt, 7201000);

    // 旧服务端只有 maxRounds：不再映射成任何东西，落回默认 120。
    final legacy = UnattendedState.fromJson(const {
      'status': 'active',
      'maxRounds': 7,
      'rounds': 2,
    })!;
    expect(legacy.maxDurationMinutes, 120);
    expect(legacy.rounds, 2);
    expect(legacy.deadlineAt, 0);

    final invalid = UnattendedState.fromJson(const {
      'maxDurationMinutes': null,
      'rounds': null,
      'deadlineAt': 'oops',
    })!;
    expect(invalid.maxDurationMinutes, 120);
    expect(invalid.rounds, 0);
    expect(invalid.deadlineAt, 0);

    final negative = UnattendedState.fromJson(const {
      'maxDurationMinutes': -5,
    })!;
    expect(negative.maxDurationMinutes, 120);
  });

  test('remaining(now)：按 deadlineAt 算，可正可负；没有 deadline 返回 null', () {
    const state = UnattendedState(
      status: 'active',
      maxDurationMinutes: 60,
      startedAt: 1000,
      deadlineAt: 600000,
    );
    expect(state.remaining(600000), Duration.zero);
    expect(state.remaining(500000), const Duration(milliseconds: 100000));
    expect(state.remaining(700000), const Duration(milliseconds: -100000));
    expect(
      const UnattendedState(status: 'active').remaining(1),
      isNull,
    );
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

  test('v2 evaluating：bool / 数字 / 字符串都宽容解析，缺省 false', () {
    bool evaluatingOf(dynamic raw) =>
        UnattendedState.fromJson({'evaluating': raw})!.evaluating;

    expect(evaluatingOf(true), isTrue);
    expect(evaluatingOf(1), isTrue);
    expect(evaluatingOf('true'), isTrue);
    expect(evaluatingOf('1'), isTrue);

    for (final raw in const [false, 0, 'false', '0', null, 'yes', '']) {
      expect(evaluatingOf(raw), isFalse, reason: '$raw');
    }
    // 完全没有这个键时是「不在判定中」。
    expect(
      UnattendedState.fromJson(const {'status': 'active'})!.evaluating,
      isFalse,
    );
  });

  test('v2 pausedBy：只认非空文本，空串 / "null" / null 都落成 null', () {
    String? pausedByOf(dynamic raw) =>
        UnattendedState.fromJson({'pausedBy': raw})!.pausedBy;

    expect(pausedByOf('user'), 'user');
    expect(pausedByOf('input'), 'input');
    expect(pausedByOf(' cancel '), 'cancel');

    for (final raw in const [null, '', '  ', 'null']) {
      expect(pausedByOf(raw), isNull, reason: '$raw');
    }
  });

  test('v2 evaluating / pausedBy 往返后不丢', () {
    final state = UnattendedState.fromJson(const {
      'status': 'stopped',
      'rounds': 2,
      'evaluating': true,
      'pausedBy': 'input',
    })!;
    expect(state.evaluating, isTrue);
    expect(state.pausedBy, 'input');

    final json = state.toJson();
    expect(json['evaluating'], isTrue);
    expect(json['pausedBy'], 'input');

    final again = UnattendedState.fromJson(json)!;
    expect(again.evaluating, isTrue);
    expect(again.pausedBy, 'input');
    expect(again.toJson(), json);
  });

  test('limits：缺省 120/5/1440，非法值回退，颠倒的边界自动交换', () {
    final defaults = UnattendedLimits.fromJson(null);
    expect(defaults.maxDurationMinutesDefault, 120);
    expect(defaults.maxDurationMinutesMin, 5);
    expect(defaults.maxDurationMinutesMax, 1440);

    final parsed = UnattendedLimits.fromJson(const {
      'maxDurationMinutesDefault': 60,
      'maxDurationMinutesMin': 10,
      'maxDurationMinutesMax': 240,
    });
    expect(parsed.maxDurationMinutesDefault, 60);
    expect(parsed.maxDurationMinutesMin, 10);
    expect(parsed.maxDurationMinutesMax, 240);

    final strings = UnattendedLimits.fromJson(const {
      'maxDurationMinutesDefault': '90',
      'maxDurationMinutesMin': '15',
      'maxDurationMinutesMax': '600',
    });
    expect(strings.maxDurationMinutesDefault, 90);
    expect(strings.maxDurationMinutesMin, 15);
    expect(strings.maxDurationMinutesMax, 600);

    final fallback = UnattendedLimits.fromJson(const {
      'maxDurationMinutesDefault': 0,
      'maxDurationMinutesMin': -1,
      'maxDurationMinutesMax': 0,
    });
    expect(fallback.maxDurationMinutesDefault, 120);
    expect(fallback.maxDurationMinutesMin, 5);
    expect(fallback.maxDurationMinutesMax, 1440);

    final swapped = UnattendedLimits.fromJson(const {
      'maxDurationMinutesDefault': 200,
      'maxDurationMinutesMin': 500,
      'maxDurationMinutesMax': 60,
    });
    expect(swapped.maxDurationMinutesMin, 60);
    expect(swapped.maxDurationMinutesMax, 500);
    // 默认值跟着新边界夹一次。
    expect(swapped.maxDurationMinutesDefault, 200);
  });

  test('limits.clampDurationMinutes：低于下限/高于上限都夹住', () {
    const limits = UnattendedLimits(
      maxDurationMinutesMin: 5,
      maxDurationMinutesMax: 1440,
    );
    expect(limits.clampDurationMinutes(0), 5);
    expect(limits.clampDurationMinutes(1), 5);
    expect(limits.clampDurationMinutes(120), 120);
    expect(limits.clampDurationMinutes(1441), 1440);
  });

  test('snapshot 同时解析状态与上限', () {
    final snapshot = UnattendedSnapshot.fromJson(const {
      'ok': true,
      'unattended': null,
      'limits': {
        'maxDurationMinutesDefault': 30,
        'maxDurationMinutesMin': 10,
        'maxDurationMinutesMax': 100,
      },
    });
    expect(snapshot.state, isNull);
    expect(snapshot.limits.maxDurationMinutesDefault, 30);
    expect(snapshot.limits.maxDurationMinutesMin, 10);
    expect(snapshot.limits.maxDurationMinutesMax, 100);
  });
}
