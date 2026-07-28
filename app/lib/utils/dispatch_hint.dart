/// Commander 会话专属的「派发方式」三选一背后的纯逻辑。
///
/// Commander 每一轮都要自己决定是否把活分给别的会话、要不要等回执。这组单选让
/// 用户把这个决定钉死在 UI 上，而不用每次在提示词里重复交代：
///   dispatchMaster（默认） → 用 dispatch_master 派出去并等结果回执（双向）
///   routeTask             → 用 route_task 单向派出去，不等回执
///   none                  → 禁止派发，活留在当前会话做完
///
/// 三条后缀和 web 端 `public/chat-dispatch-hint.js` 逐字一致（且都是英文：模型对
/// 英文工具路由指令服从得更稳）。每条都点名要调的那个工具，模型才知道怎么遵守；
/// 反过来 [kDispatchHintSuffixNone] 刻意不提任何工具名。非 commander 会话一律
/// fail closed —— [decorateDispatchHint] 原样返回。
library;

/// 持久化用的稳定字符串；和 web 端 localStorage 里存的值同一套词汇。
enum DispatchMode {
  dispatchMaster('dispatch_master'),
  routeTask('route_task'),
  none('none');

  const DispatchMode(this.wireName);

  final String wireName;

  static const DispatchMode defaultMode = DispatchMode.dispatchMaster;

  /// 读不认识的值（旧版本写的、手改的）时回落默认，绝不抛。
  static DispatchMode fromWireName(String? name) {
    for (final mode in DispatchMode.values) {
      if (mode.wireName == name) return mode;
    }
    return defaultMode;
  }
}

const String kDispatchHintSuffixDispatchMaster =
    '\n\n[Dispatch] After a brief analysis, dispatch this to another session '
    'via the dispatch_master tool and wait for the result callback.';
const String kDispatchHintSuffixRouteTask =
    '\n\n[Dispatch] After a brief analysis, dispatch this to another session '
    'via the route_task tool (fire-and-forget, no callback needed).';
const String kDispatchHintSuffixNone =
    '\n\n[Dispatch] Do not dispatch to other sessions this turn. Handle it '
    'entirely within the current session.';

String dispatchHintSuffix(DispatchMode mode) {
  switch (mode) {
    case DispatchMode.routeTask:
      return kDispatchHintSuffixRouteTask;
    case DispatchMode.none:
      return kDispatchHintSuffixNone;
    case DispatchMode.dispatchMaster:
      return kDispatchHintSuffixDispatchMaster;
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

/// 只有 commander 会话显示这组单选；type 读不到（null/其它角色）就当没有。
bool isCommanderSessionType(String? type) => type == 'commander';
