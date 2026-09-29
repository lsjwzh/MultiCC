import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';

/// 会话级「自动提交」开关当前值（Web 的 `#auto-commit-btn`）。服务端缺省是
/// 「开」（`create-record.js` 里判的是 `autoCommit !== false`），会话列表里还
/// 没这一条时也按「开」算 —— 跟 `Session.autoCommit` 的解析保持一致。
bool sessionAutoCommitOf(List<Session> sessions, String sessionId) {
  for (final s in sessions) {
    if (s.id == sessionId) return s.autoCommit;
  }
  return true;
}

/// 页头的「自动提交✓/✕」。开关存在会话记录上（PATCH `/api/sessions/:id`），
/// 不是本地偏好 —— 换台设备打开也该是同一个值。
///
/// 合并本身由服务端在回合结束时做（`src/routes/session-git.js` 的
/// `autoCommitTurn`，挂在 turn-engine 的 complete-session-turn 上）——页面
/// 在不在线都会提交，App 这边不再有自己的每轮触发器。
Future<void> toggleSessionAutoCommit({
  required ChatProvider provider,
  required SessionManager manager,
}) async {
  final next = !sessionAutoCommitOf(manager.sessions, provider.sessionName);
  try {
    await manager.updateSessionAutoCommit(provider.sessionName, next);
    provider.addLocalSystemMessage(
      next ? t('autoCommitEnabled') : t('autoCommitDisabled'),
    );
  } catch (e) {
    provider.addLocalSystemMessage(
      t('autoCommitPatchFailed', {'error': '$e'}),
    );
  }
}
