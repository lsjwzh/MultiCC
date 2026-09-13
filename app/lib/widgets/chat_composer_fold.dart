import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../i18n.dart';
import '../theme.dart';

/// 手机上的输入区会随着往回翻聊天记录折起来 —— Web 侧是
/// `public/chat-composer-collapse.js`，这里复刻同一套规则。
///
/// 在底部时它是完整的输入卡；往历史里翻，它跟着手势缩小，最后缩成贴着底边
/// 的一条胶囊，胶囊上带着还没发出去的草稿；点它就把整个输入区还回来，光标
/// 已经在输入框里。
///
/// 两条规则保证折叠不会从使用者手里拿走东西：输入区里任何东西获得焦点都把它
/// 钉住不折，草稿会显示在胶囊上而不是被藏进去。这两条是它敢折得这么狠的全部
/// 理由。
///
/// 只有手机折。桌面窗口放得下整个输入区，在那里折只是为动而动。
class ChatComposerFold extends StatefulWidget {
  const ChatComposerFold({
    super.key,
    required this.scrollController,
    required this.child,
    this.inputController,
    this.inputFocusNode,
    this.foldedHeight = 42,
    this.foldAt = 220,
    this.phoneMaxWidth = 760,
  });

  /// 聊天记录那个滚动位置 —— 折多少由「离底边还有多远」决定。
  final ScrollController scrollController;
  final Widget child;

  /// 草稿与光标。胶囊要把没发出去的字显示出来，展开时要把光标放回去，
  /// 两件事都得够得着输入框本身。
  final TextEditingController? inputController;
  final FocusNode? inputFocusNode;

  /// 完全折起来时的高度（Web `FOLD_HEIGHT = 40`）。
  final double foldedHeight;

  /// 离底边超过这么多像素就完全折起（Web `FOLD_AT = 220`）。这是个手感，
  /// 不是量出来的数。
  final double foldAt;

  /// 超过这个宽度就不折（Web 的 `(max-width: 760px)`）。
  final double phoneMaxWidth;

  @override
  State<ChatComposerFold> createState() => _ChatComposerFoldState();
}

class _ChatComposerFoldState extends State<ChatComposerFold>
    with SingleTickerProviderStateMixin {
  /// 每帧靠近目标的比例。轻阻尼能吃掉惯性滚动的抖动（Web `EASE = 0.3`）。
  static const _ease = 0.3;

  /// 停手之后多久把它吸到最近的一端（Web `SETTLE_MS = 150`）。
  static const _settleDelay = Duration(milliseconds: 150);

  /// 到了这里就不再是「折了一点」而是「折完了」：位置停在两个端点之间是
  /// 控件最不该待的地方，所以停手后会吸到近的那一端。
  static const _settleLow = 0.18;
  static const _settleHigh = 0.82;

  /// 0 完整 · 1 完全折起。
  double _p = 0;
  double? _snapTo;
  double _measured = 0;
  bool _pinned = false;
  bool _live = false;
  Timer? _settleTimer;
  final _childKey = GlobalKey();
  late final Ticker _ticker;

  @override
  void initState() {
    super.initState();
    // 在 initState 里建，不能写成 `late final ... = createTicker(...)` 惰性取值：
    // 桌面宽度下这个 ticker 一次都不会被用到，等到 dispose 才第一次取值就等于
    // 在正在卸载的元素上去查 TickerMode，直接断言失败。
    _ticker = createTicker(_onTick);
    FocusManager.instance.addListener(_onFocusChange);
    widget.scrollController.addListener(_onScroll);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 窄了就折，宽了就原样还回去 —— 转屏和退出手机版式都不该留下半折的输入区。
    final phone =
        MediaQuery.sizeOf(context).width <= widget.phoneMaxWidth;
    if (phone == _live) return;
    _live = phone;
    if (!_live) {
      _settleTimer?.cancel();
      _ticker.stop();
      _p = 0;
      _snapTo = null;
    } else {
      _kick();
    }
  }

  @override
  void dispose() {
    _settleTimer?.cancel();
    _ticker.dispose();
    FocusManager.instance.removeListener(_onFocusChange);
    widget.scrollController.removeListener(_onScroll);
    super.dispose();
  }

  /// 输入区里任何东西获得焦点都把它钉住。这里不能只看输入框自己的焦点：
  /// 配置胶囊、附件按钮也都算「正在用输入区」。
  void _onFocusChange() {
    final node = FocusManager.instance.primaryFocus;
    var pinned = false;
    node?.context?.visitAncestorElements((element) {
      if (element.widget is ChatComposerFold) {
        pinned = true;
        return false;
      }
      return true;
    });
    if (pinned == _pinned) return;
    _pinned = pinned;
    if (pinned) _snapTo = null;
    _kick();
    if (!pinned) _rest();
  }

  void _onScroll() {
    if (!_live) return;
    _snapTo = null;
    _kick();
    _rest();
  }

  /// 「离底边多远」在折起来之后会自己变小 —— 折掉的这部分高度还给了列表。
  /// 把还给它的补回去，这个数才是手指真正走过的距离（Web `slack()`）。
  double _walked() {
    final position = _scrollOffset();
    if (position == null) return 0;
    final slack = math.max(0.0, _measured - widget.foldedHeight) * _p;
    return math.max(0.0, position.maxScrollExtent - position.pixels) + slack;
  }

  ScrollPosition? _scrollOffset() =>
      widget.scrollController.hasClients ? widget.scrollController.position : null;

  double _wanted() {
    final snap = _snapTo;
    if (snap != null) return snap;
    if (_pinned) return 0;
    final position = _scrollOffset();
    if (position == null) return 0;
    // 已经贴底就别折 —— 这时候任何折叠看起来都像是自己动了一下。
    if (position.maxScrollExtent - position.pixels <= 2) return 0;
    return (_walked() / widget.foldAt).clamp(0.0, 1.0);
  }

  void _kick() {
    if (!_live || _ticker.isActive) return;
    _ticker.start();
  }

  void _onTick(Duration _) {
    final to = _wanted();
    final next = _p + (to - _p) * _ease;
    final settled = (to - next).abs() < 0.004;
    setState(() => _p = settled ? to : next);
    if (settled) _ticker.stop();
  }

  /// 手势停在两端之间就把输入区留在那边是最难用的状态，所以停手后吸到近的
  /// 一端。判断用的是「会停在哪」，不是此刻还在飞的进度 —— 这两个数在停手
  /// 这一刻并不相等，而决定该由落点来做。
  void _rest() {
    _settleTimer?.cancel();
    _settleTimer = Timer(_settleDelay, () {
      if (!mounted || !_live || _pinned) return;
      final at = (_walked() / widget.foldAt).clamp(0.0, 1.0);
      if (at > _settleLow && at < _settleHigh) {
        _snapTo = at > 0.5 ? 1.0 : 0.0;
        _kick();
      }
    });
  }

  void _expand() {
    _snapTo = 0;
    _kick();
    // 光标下一帧再放：先让折叠往回走，否则一个还关着的输入区拿到焦点会
    // 立刻又把自己钉成展开前的样子。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.inputFocusNode?.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final child = KeyedSubtree(key: _childKey, child: widget.child);
    if (!_live) return child;

    // 读到的永远是上一帧量出来的高度：这一帧的可见高度正是拿它算的。折起来
    // 的时候子树的 RenderBox 仍然是完整高度（裁的是外面这层），所以这个数
    // 不会自己缩回去。
    final box = _childKey.currentContext?.findRenderObject() as RenderBox?;
    if (box != null && box.hasSize && box.size.height > 0) {
      _measured = box.size.height;
    }
    final total = _measured;
    if (total <= widget.foldedHeight) return child;

    final visible = math.max(
      widget.foldedHeight,
      total - (total - widget.foldedHeight) * _p,
    );
    final folded = visible <= widget.foldedHeight + 6;

    return Stack(
      children: [
        ClipRect(
          // 从上面裁：留下来的是使用者刚刚在看的那条底边，按钮行不会跳。
          child: Align(
            alignment: Alignment.bottomCenter,
            heightFactor: (visible / total).clamp(0.0, 1.0),
            child: ClipRRect(
              // 圆角留到最后一段才收，胶囊是在手势末尾到的，不是一开始。
              borderRadius: BorderRadius.circular(
                _p < 0.6
                    ? 0
                    : 15 + 985 * math.pow((_p - 0.6) / 0.4, 1.5).toDouble(),
              ),
              child: child,
            ),
          ),
        ),
        if (folded)
          Positioned.fill(
            child: _ComposerPill(
              draft: widget.inputController?.text.trim() ?? '',
              onTap: _expand,
            ),
          ),
      ],
    );
  }
}

/// 折到底之后贴在底边的那条胶囊：它是展开输入区唯一的把手，所以草稿要写在
/// 上面 —— 折起来不该把使用者已经打了一半的字藏起来。
class _ComposerPill extends StatelessWidget {
  const _ComposerPill({required this.draft, required this.onTap});

  final String draft;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    key: const ValueKey('chat-composer-pill'),
    button: true,
    label: '展开输入框',
    child: Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(24),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(24),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: AppColors.line),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  // 没草稿时退到输入框自己的提示语，同 Web 的
                  // `draft || input.placeholder`。
                  draft.isEmpty ? t('typeMessage') : draft,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: draft.isEmpty ? AppColors.faint : AppColors.text,
                    fontSize: 13.5,
                  ),
                ),
              ),
              const Icon(
                Icons.arrow_upward_rounded,
                size: 17,
                color: AppColors.faint,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
