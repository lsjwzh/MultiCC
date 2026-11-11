import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../models/unattended_state.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';

// 无人值守模式（docs/unattended-mode.md）从 ChatProvider 拆出来的一层。
//
// 状态字段、GET 补 limits、四个 POST 动作全在这里；宿主只保留两个一行挂钩：
// 连接后 `unawaited(refreshUnattended())`，以及 WS 的 `unattended_state`
// 帧交给 `applyUnattendedEvent`。宿主为此暴露 `settings` 与
// `executionSessionName`；翻译用同一份全局 `t`。
mixin ChatProviderUnattended on ChangeNotifier {
  SettingsService get settings;
  String get executionSessionName;

  // ── Unattended mode (docs/unattended-mode.md) ─────────────────────────────
  // WS `unattended_state` 每次变化都会广播，连接时重放；GET 只补 limits
  // （最长值守时间的默认值/上下限）。动作走 POST，响应与 GET 同形。
  UnattendedState? _unattended;
  UnattendedState? get unattended => _unattended;
  UnattendedLimits _unattendedLimits = const UnattendedLimits();
  UnattendedLimits get unattendedLimits => _unattendedLimits;
  bool _unattendedBusy = false;
  bool get unattendedBusy => _unattendedBusy;
  String? _unattendedError;
  String? get unattendedError => _unattendedError;
  bool _unattendedRefreshInFlight = false;

  /// v2：`active` 是唯一武装态，此时输入区整体锁住（真人先「暂停并接管」）。
  ///
  /// 放在这里而不是 chat_provider.dart：输入条、待答卡和悬浮球都从这一个
  /// 判据读，锁与解锁只跟着 WS `unattended_state`（含重连重放）走。
  bool get unattendedLocksInput => _unattended?.isActive == true;

  /// 判定进行中（服务端 verdict 开始/落地的两条边），面板和悬浮球据此转圈。
  bool get unattendedEvaluating => _unattended?.evaluating == true;

  /// WS `unattended_state` 帧（payload 就是状态本身，null = 从未启用）。
  void applyUnattendedEvent(dynamic raw) {
    _unattended = UnattendedState.fromJson(raw);
    notifyListeners();
  }

  void _applyUnattendedSnapshot(UnattendedSnapshot snapshot) {
    _unattended = snapshot.state;
    _unattendedLimits = snapshot.limits;
    notifyListeners();
  }

  /// 拉一次服务端状态（GET）。失败保留最后一次快照 —— WS 广播才是权威来源。
  Future<void> refreshUnattended() async {
    if (_unattendedRefreshInFlight) return;
    _unattendedRefreshInFlight = true;
    final target = executionSessionName;
    try {
      final snapshot = await SessionService(
        settings: settings,
      ).fetchUnattended(target);
      if (target != executionSessionName) return;
      _applyUnattendedSnapshot(snapshot);
    } catch (_) {
      // 旧服务端 / 演示服务没有这条路由：图标落回 idle，不弹错。
    } finally {
      _unattendedRefreshInFlight = false;
    }
  }

  Future<bool> _unattendedAction(Map<String, dynamic> body) async {
    if (_unattendedBusy) return false;
    _unattendedBusy = true;
    _unattendedError = null;
    notifyListeners();
    try {
      final snapshot = await SessionService(
        settings: settings,
      ).postUnattended(executionSessionName, body);
      _applyUnattendedSnapshot(snapshot);
      return true;
    } catch (error) {
      _unattendedError = '$error';
      notifyListeners();
      return false;
    } finally {
      _unattendedBusy = false;
      notifyListeners();
    }
  }

  /// `start`：目标必填；`evaluateNow` 默认 true（空闲时也立刻对最后输出判一次）。
  /// 轮次不再有上限，改由 `maxDurationMinutes` 限定最长值守时间（服务端 limits）。
  Future<bool> startUnattended({
    required String goal,
    List<String> criteria = const [],
    int? maxDurationMinutes,
    bool evaluateNow = true,
  }) {
    final trimmed = goal.trim();
    if (trimmed.isEmpty) {
      _unattendedError = t('unattendedGoalRequired');
      notifyListeners();
      return Future.value(false);
    }
    return _unattendedAction({
      'action': 'start',
      'goal': trimmed,
      if (criteria.isNotEmpty) 'criteria': criteria,
      if (maxDurationMinutes != null) 'maxDurationMinutes': maxDurationMinutes,
      'evaluateNow': evaluateNow,
    });
  }

  /// `update`：只允许 active / needs_human 状态（服务端把关）。
  Future<bool> updateUnattended({
    String? goal,
    List<String>? criteria,
    int? maxDurationMinutes,
  }) => _unattendedAction({
    'action': 'update',
    if (goal != null && goal.trim().isNotEmpty) 'goal': goal.trim(),
    if (criteria != null) 'criteria': criteria,
    if (maxDurationMinutes != null) 'maxDurationMinutes': maxDurationMinutes,
  });

  Future<bool> stopUnattended() => _unattendedAction({'action': 'stop'});

  /// `resume`：可选重新指定最长值守时间（不改就用服务端保存的值）。
  Future<bool> resumeUnattended({int? maxDurationMinutes}) => _unattendedAction({
    'action': 'resume',
    if (maxDurationMinutes != null) 'maxDurationMinutes': maxDurationMinutes,
  });

  /// `clear`：结束本次无人值守并清除设置。成功后服务端回 `unattended: null`，
  /// 本地状态随之落空（横幅消失、输入解锁）；active 时服务端会回 409。
  Future<bool> clearUnattended() => _unattendedAction({'action': 'clear'});

  void clearUnattendedError() {
    if (_unattendedError == null) return;
    _unattendedError = null;
    notifyListeners();
  }
}
