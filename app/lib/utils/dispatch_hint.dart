/// Commander 会话专属的「不派发给其他会话」开关背后的纯逻辑。
///
/// Commander 每一轮都要自己决定是否把活分给别的会话。这个开关让用户把这个决定
/// 钉死在 UI 上，而不用每次在提示词里重复交代：
///   不勾选（默认） → 要求尽量拆分、通过 route_task 派发出去
///   勾选           → 禁止派发，活留在当前会话做完
///
/// 两条后缀和 web 端 `public/chat-dispatch-hint.js` 逐字一致（且都是英文：模型对
/// 英文工具路由指令服从得更稳）。route_task 是 Commander 唯一的派发通道，用它自己
/// 的词汇下指令，模型才知道怎么遵守。非 commander 会话一律 fail closed ——
/// [decorateDispatchHint] 原样返回。
library;

const String kDispatchHintSuffixSpread =
    '\n\n[Dispatch] After a brief analysis, dispatch this task to other sessions '
    'in parallel via the route_task tool. Only keep in the current session what '
    'truly cannot be dispatched.';
const String kDispatchHintSuffixKeep =
    '\n\n[Dispatch] Do not dispatch this task. Do not call the route_task tool. '
    'Complete the entire task yourself within the current session.';

/// 会话 type=='commander' 时才追加后缀。空串/纯空白不动，避免把一条空消息
/// 变成只有派发指令的消息。
String decorateDispatchHint(
  String text, {
  required bool enabled,
  required bool noDispatch,
}) {
  if (!enabled || text.trim().isEmpty) return text;
  return text + (noDispatch ? kDispatchHintSuffixKeep : kDispatchHintSuffixSpread);
}

/// 只有 commander 会话显示开关；type 读不到（null/其它角色）就当没有。
bool isCommanderSessionType(String? type) => type == 'commander';
