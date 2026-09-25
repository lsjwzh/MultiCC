import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import 'session_service.dart';
import 'settings_service.dart';

/// 会话级「自动提交」开关当前值（Web 的 `#auto-commit-btn`）。服务端缺省是
/// 「开」（`create-record.js` 里判的是 `autoCommit !== false`），会话列表里还
/// 没这一条时也按「开」算 —— 跟 `Session.autoCommit` 的解析保持一致。
bool sessionAutoCommitOf(List<Session> sessions, String sessionId) {
  for (final s in sessions) {
    if (s.id == sessionId) return s.autoCommit;
  }
  return true;
}

/// 最后一轮用户消息的 id —— Web 的 `_lastUserBubble`。每轮自动提交的勾选框就
/// 挂在它下面，所以「这一轮」= 最后一条用户消息。
///
/// 🔇 系统注入消息也是 role=user（引擎落库的形状），但没人打过它：它接不住这个
/// 锚点，否则后台任务完成提示一到，勾选框就跑到系统卡上去了。Web 端同理
/// （chat-history-view 的 lastUserElement 只认真用户气泡）。
String? lastUserMessageId(List<ChatMessage> messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    final m = messages[i];
    final id = m.id;
    if (m.role == MessageRole.user && id != null && id.isNotEmpty) {
      if (parseSystemInject(m.content) == null) return id;
    }
  }
  return null;
}

/// 「每轮执行成功后自动 commit + 合并回基分支」（Web `chat.js` 的
/// `autoCommitIfNeeded` 与 `#auto-commit-btn`）。
///
/// 从 ChatView 里拆出来的原因有两个：一是它只跟 provider + REST 打交道，跟
/// 聊天页的布局无关；二是 `chat_screen.dart` 的行数已经贴着天花板跑了。
/// 页面这边只要在每帧喊一次 [syncTick]、在菜单里调 [toggle] 就够了 ——
/// 「这一轮要不要提交」的账本留在 provider 上（换会话不串味），执行状态
/// （在途互斥 + 轮次游标）留在本对象上（跟着页面走）。
class AutoCommitController {
  AutoCommitController({
    required this.settings,
    required this.isAlive,
    required this.refreshMergeReady,
  });

  final SettingsService settings;

  /// 页面还在树上吗。异步回来之后要先问这一句再碰 provider。
  final bool Function() isAlive;

  /// 刷一次 merge-status，返回刷完之后 worktree 里有没有可合并的东西。
  /// 交给页面实现，因为它才是持有轮询状态的那一方。
  final Future<bool> Function(String session) refreshMergeReady;

  /// 在途互斥锁 —— 合并请求没回来之前不再发第二次（web 里的同名变量）。
  bool _pending = false;

  /// 上一轮结束的游标。首次挂载只对齐不补跑：挂载前攒下的轮次不该被追认。
  int? _seenTick;

  /// 每帧（`didChangeDependencies`）喊一次；只有真的跨过了一轮的结束才动。
  void syncTick({
    required ChatProvider provider,
    required SessionManager manager,
  }) {
    final tick = provider.turnEndTick;
    if (_seenTick == null) {
      _seenTick = tick;
      return;
    }
    if (tick == _seenTick) return;
    _seenTick = tick;
    // 回合结束是唯一的触发点；不 await —— 它是后台动作，不该拖住这一帧。
    _run(provider: provider, manager: manager);
  }

  /// 页头的「自动提交✓/✕」。开关存在会话记录上（PATCH `/api/sessions/:id`），
  /// 不是本地偏好 —— 换台设备打开也该是同一个值。
  Future<void> toggle({
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

  /// 判定跟 Web 的 `autoCommitIfNeeded` 一致：这一轮的用户气泡勾了自动提交、
  /// 这一轮还没提交过、worktree 里确实有可合并的东西。失败/冲突都只留在对话
  /// 里，不弹窗 —— 它是个后台动作，不该抢焦点。
  Future<void> _run({
    required ChatProvider provider,
    required SessionManager manager,
  }) async {
    if (_pending) return;
    final turnId = lastUserMessageId(provider.messages);
    if (turnId == null || provider.isTurnAutoCommitted(turnId)) return;
    final fallback = sessionAutoCommitOf(manager.sessions, provider.sessionName);
    if (!provider.turnAutoCommit(turnId, fallback: fallback)) return;
    final session = provider.executionSessionName.isNotEmpty
        ? provider.executionSessionName
        : provider.sessionName;
    if (session.isEmpty) return;
    // 这一轮刚写完 worktree，页面缓存里的 mergeReady 还是上一轮的结论 ——
    // 先刷一次再判（Web 那边靠它自己的轮询，这里不等下一拍）。
    if (!await refreshMergeReady(session) || !isAlive()) return;
    _pending = true;
    provider.addLocalSystemMessage(t('autoCommitMergeRunning'));
    try {
      final result = await SessionService(settings: settings)
          .mergeSession(session);
      if (!isAlive()) return;
      final conflicts = result['conflicts'];
      if (result['ok'] == true) {
        final detail = result['merged'] == true
            ? t('merged', {'n': '${result['commits'] ?? 0}'})
            : t('mergedNothing', {'msg': t('mergeNoNewCommits')});
        provider.addLocalSystemMessage(
          t('autoCommitMerged', {'message': detail}),
        );
        provider.markTurnAutoCommitted(turnId);
      } else if (conflicts is List && conflicts.isNotEmpty) {
        provider.addLocalSystemMessage(
          t('autoCommitConflict', {'files': conflicts.join(', ')}),
        );
      } else {
        provider.addLocalSystemMessage(
          t('autoCommitFailed', {'error': '${result['error'] ?? ''}'}),
        );
      }
      await refreshMergeReady(session);
    } catch (e) {
      if (isAlive()) {
        provider.addLocalSystemMessage(t('autoCommitFailed', {'error': '$e'}));
      }
    } finally {
      _pending = false;
    }
  }
}
