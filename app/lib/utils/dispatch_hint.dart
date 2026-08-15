/// Commander 会话专属的「派发方式」四选一背后的纯逻辑。
///
/// Commander 每一轮都要自己决定是否把活分给别的会话、要不要等回执。这组单选让
/// 用户把这个决定钉死在 UI 上，而不用每次在提示词里重复交代：
///   dispatchMasterSync       → dispatch_master(mode=sync)，本轮同步等结果
///   dispatchMasterAsync（默认）→ dispatch_master(mode=async)，结果异步回调
///   routeTask                → route_task 单向派出去，不等回执
///   none                     → 禁止派发，活留在当前会话做完
///
/// 四条后缀和 web 端 `public/chat-dispatch-hint.js` 逐字一致（且都是英文：模型对
/// 英文工具路由指令服从得更稳）。每条都点名要调的那个工具，模型才知道怎么遵守；
/// 反过来 [kDispatchHintSuffixNone] 刻意不提任何工具名。非 commander 会话一律
/// fail closed —— [decorateDispatchHint] 原样返回。
library;

/// 持久化用的稳定字符串；和 web 端 localStorage 里存的值同一套词汇。
enum DispatchMode {
  dispatchMasterSync('dispatch_master_sync'),
  dispatchMasterAsync('dispatch_master_async'),
  routeTask('route_task'),
  none('none');

  const DispatchMode(this.wireName);

  final String wireName;

  static const DispatchMode defaultMode = DispatchMode.dispatchMasterAsync;

  /// 读不认识的值（旧版本写的、手改的）时回落默认，绝不抛。
  static DispatchMode fromWireName(String? name) {
    // 三态版本里的 `dispatch_master` 固定使用 async；升级后保持原行为。
    if (name == 'dispatch_master') return DispatchMode.dispatchMasterAsync;
    for (final mode in DispatchMode.values) {
      if (mode.wireName == name) return mode;
    }
    return defaultMode;
  }
}

const String kDispatchHintSuffixDispatchMasterSync =
    '\n\n[Dispatch] After a brief analysis, call dispatch_master with mode="sync". '
    'Keep this turn open until the worker returns, then incorporate the result '
    'before responding.';
const String kDispatchHintSuffixDispatchMasterAsync =
    '\n\n[Dispatch] After a brief analysis, call dispatch_master with mode="async". '
    'Do not poll, inspect, or wait on the worker; continue only independent work, '
    'then end naturally. MultiCC will inject the result as a new message and wake '
    'this session.';
const String kDispatchHintSuffixRouteTask =
    '\n\n[Dispatch] After a brief analysis, dispatch this to another session '
    'via the route_task tool (fire-and-forget, no callback needed).';
const String kDispatchHintSuffixNone =
    '\n\n[Dispatch] Do not dispatch to other sessions this turn. Handle it '
    'entirely within the current session.';

String dispatchHintSuffix(DispatchMode mode) {
  switch (mode) {
    case DispatchMode.dispatchMasterSync:
      return kDispatchHintSuffixDispatchMasterSync;
    case DispatchMode.dispatchMasterAsync:
      return kDispatchHintSuffixDispatchMasterAsync;
    case DispatchMode.routeTask:
      return kDispatchHintSuffixRouteTask;
    case DispatchMode.none:
      return kDispatchHintSuffixNone;
  }
}

/// 会话 type=='commander' 时才追加后缀。空串/纯空白不动，避免把一条空消息
/// 变成只有派发指令的消息。
String decorateDispatchHint(
  String text, {
  required bool enabled,
  required DispatchMode mode,
}) {
  if (!enabled || text.trim().isEmpty) return text;
  return text + dispatchHintSuffix(mode);
}

/// 只有 commander 会话显示这组选择；type 读不到（null/其它角色）就当没有。
bool isCommanderSessionType(String? type) => type == 'commander';
