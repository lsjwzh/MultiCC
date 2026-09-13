import 'package:shared_preferences/shared_preferences.dart';

/// 四步新手引导走到哪了（Web `public/tour.js` 顶部那两个键）。
///
/// 键名和值域都跟 Web 一模一样（`multicc_onboard_step` 存 '1'..'4' 的字符串、
/// `multicc_onboard_done` 存 '1'）—— 同一个人在两端的引导进度不会互相打架，
/// 以后真要做「Web 走完第 2 步、App 接着走第 3 步」也不用再迁一次数据。
class OnboardingStore {
  OnboardingStore._(this._prefs);

  static const stepKey = 'multicc_onboard_step';
  static const doneKey = 'multicc_onboard_done';
  static const firstStep = 1;
  static const lastStep = 4;

  final SharedPreferences _prefs;

  static Future<OnboardingStore> load() async =>
      OnboardingStore._(await SharedPreferences.getInstance());

  /// 进度。存坏了、存丢了都当第 1 步 —— 跟 Web 一样夹在 1..4 之间。
  int get step {
    final raw = int.tryParse(_prefs.getString(stepKey) ?? '');
    if (raw == null) return firstStep;
    return raw < firstStep ? firstStep : (raw > lastStep ? lastStep : raw);
  }

  /// 只认 '1'。Web 的 `isDone()` 在存储读不到时会返回 true（宁可不弹），这里
  /// SharedPreferences 不会抛，缺省 false 即可 —— 读不到就是没走过。
  bool get done => _prefs.getString(doneKey) == '1';

  Future<void> setStep(int value) {
    final clamped = value < firstStep
        ? firstStep
        : (value > lastStep ? lastStep : value);
    return _prefs.setString(stepKey, '$clamped');
  }

  Future<void> markDone() => _prefs.setString(doneKey, '1');

  /// 「新手引导」入口：把完成标记摘掉，下一帧从头重放。
  Future<void> restart() => _prefs.remove(doneKey);
}
