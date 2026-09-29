// 「下轮生效」那份配置的状态与映射。自 chat_provider.dart 抽出（行长闸：那个
// 文件顶着 3k 上限，而这一簇是自成一体的：状态 + 帧 → 状态 + 取回方式）。
import '../models/message.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';

/// 会话忙时服务端不动活着的车道，而是把用户的选择暂存成 `pendingConfiguration`
/// 并回 `{deferred:true, cli:<旧车道>}`（src/session/pending-configuration.js），
/// 下一轮的边界才落地。但用户此刻的意图就是那份暂存 —— 页头角标与 AI 配置药丸
/// 都得按它显示，否则切成什么都会显示成旧的，连 Provider 也是旧车道那一池。
/// Web 两端本来就这么做（chat-ai-config.js 的 desiredConfig、Air 药丸的 shown）。
class PendingConfiguration {
  SessionPendingConfiguration? _pending;

  /// 暂存的那份；没有就是 null。
  SessionPendingConfiguration? get value => _pending;

  /// 有等待生效的改动（换道或只换线路都算）。
  bool get isSet => _pending != null;

  /// 页头该显示的 CLI：有待生效的换道就是那条待换的车道。
  SessionCli desiredCli(SessionCli live) => _pending?.cli ?? live;

  /// 待生效的那次改动确实换了一条车道（只换 Provider/模型时为 false）。
  bool hasCliSwitch(SessionCli live) =>
      _pending != null && _pending!.cli != live;

  /// 记下暂存的那份。返回 true 表示有变化 —— 调用方负责 notifyListeners。
  /// 同一个对象重复送（每条 WS 帧都会重建一次）不算变化。
  bool update(SessionPendingConfiguration? next) {
    if (identical(_pending, next)) return false;
    _pending = next;
    return true;
  }

  /// 清掉记号（下一轮已落地 / 另一端取消）。返回 true 表示确实清掉了东西。
  bool clear() {
    if (_pending == null) return false;
    _pending = null;
    return true;
  }

  /// 帧 → 状态。返回 true 表示有变化。`payload` 用 Object? 是防帧形状不对时炸在
  /// as 上（事件载荷本来就有 String/int/状态枚举几种）。
  ///
  /// * `session_configuration_pending`：任何一端暂存了改动（本机 app、web/Air、
  ///   另一部手机），立刻把用户选好的那条车道/线路显示出来并挂上「下轮生效」。
  /// * `session_configuration_applied`：那份暂存刚在轮次边界落地（只换线路的
  ///   情形，src/cli/switch-runtime.js applyPendingConfiguration），记号清掉。
  ///   真正换道的落点是 `cli_switched`，不在这里重复处理。
  bool syncFromEvent(String type, Object? payload) {
    if (type == 'session_configuration_applied') return clear();
    if (type != 'session_configuration_pending') return false;
    final staged = payload is Map ? payload['pendingConfiguration'] : null;
    return update(
      staged is Map
          ? SessionPendingConfiguration.fromJson(
              Map<String, dynamic>.from(staged),
            )
          : null,
    );
  }
}

/// 取一次会话记录（GET /api/sessions/:id）里的暂存那份。这是「App 冷启/在另一
/// 端换的道」唯一的来源：WS 的 system_init 帧不带 pendingConfiguration。
///
/// 返回 null 表示**没问到**（网络失败或会话已切走），调用方必须保持现状 ——
/// 别把一次请求失败当成「没有 pending」而把记号抹掉。拿到的那份里 pending 为
/// null 才是真的没有暂存（那时返回的不是 null）。
Future<SessionCliConfig?> fetchPendingConfiguration(
  SettingsService settings,
  String sessionId,
) async {
  if (sessionId.isEmpty) return null;
  try {
    return await SessionService(
      settings: settings,
    ).fetchSessionCliConfig(sessionId);
  } catch (_) {
    return null; // 非致命：下一轮 cli_switched / 下一次连接会纠正。
  }
}
