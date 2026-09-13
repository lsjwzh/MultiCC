import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show clampDouble;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../services/onboarding_store.dart';
import '../theme.dart';

/// 四步新手引导，Web `public/tour.js` 的原生版。
///
/// 逐条对着那边复刻，能对上号的地方都在注释里写了行号：
///
/// * 四步的文案、目标、上一步/下一步/跳过的摆放；
/// * spotlight 是套在目标外的方框，夹在视口里（Web `updateGeometry` 那句
///   「Clamp the spotlight inside the viewport so it never produces a
///   horizontal scrollbar」）；
/// * 卡片优先放目标下方、放不下放上方、再放不下贴着目标夹回来；
/// * 第 2 步在首页时下一步写作「打开对话后继续」，按下去只把进度存成 3 就退场
///   （跨页靠聊天页自己的 autoStart 续上）；
/// * 第 3 步装一个「第一次真实回复」的观察，等到用户/助手两条计数都涨了、
///   最后一条助手消息有正文，就自动跳到第 4 步；
/// * 跳过 / × 都算走完（`markDone`），Esc 在 Web 里也是走完。
///
/// 两处**故意不一样**，都在下面各自的注释里写了原因：页面判定改由宿主声明
/// （App 里没有 `document.querySelector` 认元素那套），第 3 步的观察用每次
/// 重建后的探针而不是 MutationObserver（Flutter 本来就会因为 provider 通知重建）。
enum TourPage { home, chat }

/// 每一步落在哪一页 —— Web `STEPS[n].page`。
const Map<int, TourPage> tourStepPages = {
  1: TourPage.home,
  2: TourPage.home,
  3: TourPage.chat,
  4: TourPage.chat,
};

/// 第 3 步自动推进要看的三个数（Web 那边数的是 `.msg.user` / `.msg.assistant`
/// 与最后一条助手消息的文本）。
typedef TourResultCounts = ({int users, int assistants, String lastAssistant});

class TourOverlay extends StatefulWidget {
  const TourOverlay({
    super.key,
    required this.page,
    required this.anchors,
    this.onFillExample,
    this.onStepShown,
    this.resultProbe,
  });

  /// 这一份引导负责哪一页。只有 `tourStepPages[step] == page` 的步骤才会显示。
  final TourPage page;

  /// 第 n 步要圈住的控件。锚点由宿主给 —— Web 用 CSS 选择器找元素，App 这边
  /// 只能是宿主把 GlobalKey 挂到那个控件上。
  final Map<int, GlobalKey> anchors;

  /// 「填入只读示例」。Web 直接往 `#input` 塞文本再派发 input 事件。
  final VoidCallback? onFillExample;

  /// 某一步刚显示出来。宿主用它把界面摆到位（Air 首页要在第 1 步切到目录库）。
  final ValueChanged<int>? onStepShown;

  /// 第 3 步的观察探针，见 [TourResultCounts]。
  final TourResultCounts Function()? resultProbe;

  @override
  State<TourOverlay> createState() => TourOverlayState();
}

class TourOverlayState extends State<TourOverlay> {
  static const _margin = 10.0;
  static const _gap = 12.0;
  static const _edge = 14.0;
  static const _maxCardWidth = 360.0;
  static const _maxWaitTries = 25;

  final _rootKey = GlobalKey();
  final _cardKey = GlobalKey();

  OnboardingStore? _store;
  int? _step;

  /// 圈住的那一处（未展开）与光圈（展开 10px、并夹在视口里），都在本层的
  /// 局部坐标系里。
  Rect? _target;
  Rect? _spotlight;

  /// 卡片上一帧量到的高度。第一帧先按估值摆，量到之后再摆一次 —— Web 也是
  /// 先渲染再 `getBoundingClientRect()` 的。
  Size _cardSize = const Size(0, 220);

  bool _autoStartWanted = false;
  Timer? _wait;
  ({int users, int assistants})? _baseline;
  bool _advanceScheduled = false;

  // ── 宿主接口 ────────────────────────────────────────────────────────────

  /// 现在显示的是第几步（没显示就是 null）。宿主在打开对话前用它判断要不要
  /// [handOffToChat]。
  int? get currentStep => _step;

  /// 让引导在该出现的时候出现。宿主在「页面数据已经到位」之后再调 —— 早调了
  /// 锚点还不存在，会走成「找不到目标就往下跳」。
  void autoStart() {
    _autoStartWanted = true;
    _maybeAutoStart();
  }

  /// 菜单里的「新手引导」：把完成标记摘掉，从头重放。
  Future<void> restart() async {
    await _store?.restart();
    _show(widget.page == TourPage.chat ? 3 : 1);
  }

  /// 宿主打开了对话：第 2 步之后该由聊天页接着走，进度存成 3（Web
  /// `next()` 里那段 `activeStep === 2 && pageName() === 'manage'`）。
  /// 第 1 步还没走完就打开对话的，什么都不动 —— 引导只是被盖住了，退出对话
  /// 还会在原地。
  void handOffToChat() {
    final step = _step;
    if (step == null || step < 2) return;
    unawaited(_store?.setStep(3));
    _cleanup(done: false);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    unawaited(_loadStore());
  }

  @override
  void dispose() {
    _wait?.cancel();
    super.dispose();
  }

  Future<void> _loadStore() async {
    final store = await OnboardingStore.load();
    if (!mounted) return;
    _store = store;
    _maybeAutoStart();
  }

  /// Web `autoStart()`：没走完、而且存下来的那一步正落在当前页，才自动开始。
  void _maybeAutoStart() {
    final store = _store;
    if (store == null || !_autoStartWanted || _step != null || store.done) return;
    final step = store.step;
    if (tourStepPages[step] != widget.page) return;
    _show(step);
  }

  // ── 步骤流转 ────────────────────────────────────────────────────────────

  void _show(int step) {
    if (tourStepPages[step] != widget.page) return;
    _wait?.cancel();
    setState(() {
      _step = step;
      _target = null;
      _spotlight = null;
    });
    unawaited(_store?.setStep(step));
    widget.onStepShown?.call(step);
    // Web 的 `armFirstResultObserver()`：第 3 步才装观察，基线取的是**此刻**的
    // 条数，所以已经在跑的回复不会被算成「第一次真实结果」。
    _baseline = step == 3 && widget.resultProbe != null
        ? _counts()
        : null;
    _waitForTarget();
  }

  ({int users, int assistants}) _counts() {
    final counts = widget.resultProbe!();
    return (users: counts.users, assistants: counts.assistants);
  }

  void _next() {
    final step = _step;
    if (step == null) return;
    if (step >= OnboardingStore.lastStep) {
      unawaited(_store?.setStep(step));
      _cleanup(done: true);
      return;
    }
    if (step == 2 && widget.page == TourPage.home) {
      // 「打开对话后继续」：自己先退场，把进度交给聊天页。
      unawaited(_store?.setStep(3));
      _cleanup(done: false);
      return;
    }
    _show(step + 1);
  }

  void _prev() {
    final step = _step;
    if (step == null || step <= 1) return;
    _show(step - 1);
  }

  /// Web `advanceMissing()`：目标等了 3 秒还没出现，就别把人晾在那儿。
  void _advanceMissing() {
    final step = _step;
    if (step == null) return;
    if (step == 2 && widget.page == TourPage.home) {
      unawaited(_store?.setStep(3));
      _cleanup(done: false);
      return;
    }
    if (step >= OnboardingStore.lastStep) {
      _cleanup(done: true);
      return;
    }
    final candidate = step + 1;
    if (tourStepPages[candidate] == widget.page) {
      _show(candidate);
    } else {
      unawaited(_store?.setStep(candidate));
      _cleanup(done: false);
    }
  }

  void _cleanup({required bool done}) {
    _wait?.cancel();
    _baseline = null;
    if (done) unawaited(_store?.markDone());
    if (!mounted) return;
    setState(() {
      _step = null;
      _target = null;
      _spotlight = null;
    });
  }

  void _fillExample() {
    widget.onFillExample?.call();
    // 填完字输入区会长高，重新量一次。
    _remeasure();
  }

  // ── 几何 ────────────────────────────────────────────────────────────────

  RenderBox? _targetBox() {
    final step = _step;
    if (step == null) return null;
    final box = widget.anchors[step]?.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return null;
    if (box.size.width <= 0 || box.size.height <= 0) return null;
    return box;
  }

  /// Web `waitForTarget()`：每 120ms 找一次，3 秒还没找到就让位。
  ///
  /// 3 秒是按**次数**算的，不是挂钟：Web 那边写的是
  /// `Date.now() - started > 3000`，但在 Flutter 的测试里 `tester.pump(4s)`
  /// 推进的是定时器时钟、`DateTime.now()` 一动不动，按挂钟算会永远等不到。
  /// 25 × 120ms ≈ 3 秒。
  void _waitForTarget() {
    _wait?.cancel();
    var tries = 0;
    void tick() {
      if (!mounted || _step == null) return;
      final box = _targetBox();
      if (box != null) {
        _bringIntoView();
        if (_measure(box)) {
          // 滚动是异步的，滚完再量一次（Web 那边也是 setTimeout 后再 updateGeometry）。
          _wait = Timer(const Duration(milliseconds: 280), () {
            if (!mounted) return;
            final again = _targetBox();
            if (again != null) _measure(again);
          });
          return;
        }
      }
      tries += 1;
      if (tries > _maxWaitTries) {
        _advanceMissing();
        return;
      }
      // 量不了多半是因为本层这一帧还没画出来（刚 setState）。再等一小会儿。
      final retry = box == null ? 120 : 60;
      _wait = Timer(Duration(milliseconds: retry), tick);
    }

    tick();
  }

  /// Web `target.scrollIntoView({block: 'center'})`。输入区在可滚动列表里的时候
  /// 得先把它滚出来，不然量到的框在屏幕外。
  void _bringIntoView() {
    final ctx = _step == null ? null : widget.anchors[_step!]?.currentContext;
    if (ctx == null) return;
    unawaited(() async {
      try {
        await Scrollable.ensureVisible(
          ctx,
          alignment: 0.5,
          duration: const Duration(milliseconds: 180),
        );
      } catch (_) {
        // 锚点上面没有 Scrollable（消息列表就是这样）：不滚就是了。
      }
    }());
  }

  /// 量一次目标，返回是否真的量到了（本层还没画出来就返回 false，由调用方重试）。
  bool _measure(RenderBox box) {
    final root = _rootKey.currentContext?.findRenderObject();
    if (root is! RenderBox || !root.hasSize) return false;
    final origin = root.localToGlobal(Offset.zero);
    final topLeft = box.localToGlobal(Offset.zero) - origin;
    final viewport = root.size;
    final target = Rect.fromLTWH(
      topLeft.dx,
      topLeft.dy,
      box.size.width,
      box.size.height,
    );
    final left = math.max(
      8.0,
      math.min(target.left - _margin, viewport.width - target.width - _margin - 8),
    );
    final top = math.max(
      8.0,
      math.min(
        target.top - _margin,
        viewport.height - target.height - _margin - 8,
      ),
    );
    final spotlight = Rect.fromLTWH(
      left,
      top,
      target.width + _margin * 2,
      target.height + _margin * 2,
    );
    if (spotlight == _spotlight && target == _target) return true;
    setState(() {
      _target = target;
      _spotlight = spotlight;
    });
    return true;
  }

  void _remeasure() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _step == null) return;
      final box = _targetBox();
      if (box != null) _measure(box);
    });
  }

  void _measureCard() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _step == null) return;
      final box = _cardKey.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize) return;
      if ((box.size.height - _cardSize.height).abs() < 0.5) return;
      setState(() => _cardSize = Size(box.size.width, box.size.height));
    });
  }

  /// Web `updateGeometry()` 摆卡片那一段。目标的框用**没展开**的那个，所以卡片
  /// 左边缘跟目标左边缘是对齐的。
  Offset _cardPosition(Size viewport) {
    final width = math.min(_maxCardWidth, viewport.width - _edge * 2);
    final height = _cardSize.height;
    final maxTop = math.max(_edge, viewport.height - height - _edge);
    var left = (viewport.width - width) / 2;
    var top = (viewport.height - height) / 2;
    final target = _target;
    if (target != null) {
      left = clampDouble(
        target.left,
        _edge,
        math.max(_edge, viewport.width - width - _edge),
      );
      final below = target.bottom + _margin + _gap;
      final above = target.top - height - _margin - _gap;
      if (below + height < viewport.height - _edge) {
        top = below;
      } else if (above > _edge) {
        top = above;
      } else {
        top = target.bottom + _gap;
      }
    }
    return Offset(left, clampDouble(top, _edge, maxTop));
  }

  // ── 第 3 步的观察 ───────────────────────────────────────────────────────

  void _scheduleAutoAdvance() {
    if (_advanceScheduled) return;
    _advanceScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _advanceScheduled = false;
      if (!mounted || _step != 3) return;
      final probe = widget.resultProbe;
      final baseline = _baseline;
      if (probe == null || baseline == null) return;
      final counts = probe();
      // Web：发送过 + 用户条数涨了 + 助手条数涨了 + 最后一条助手消息有正文。
      if (counts.users > baseline.users &&
          counts.assistants > baseline.assistants &&
          counts.lastAssistant.trim().isNotEmpty) {
        _show(4);
      }
    });
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final step = _step;
    if (step == null) {
      // 没在引导时也留着这一层（透明、不吃指针）—— 它是量锚点用的坐标系，
      // 第一帧就得在，不然第 1 步量不到自己的原点还得等一帧。
      return Positioned.fill(
        key: _rootKey,
        child: const IgnorePointer(child: SizedBox.expand()),
      );
    }
    if (step == 3) _scheduleAutoAdvance();
    _remeasure();
    _measureCard();
    return Positioned.fill(
      key: _rootKey,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final viewport = Size(constraints.maxWidth, constraints.maxHeight);
          final position = _cardPosition(viewport);
          return Stack(
            children: [
              // 光圈外那层遮罩不吃指针 —— Web 的 spotlight 是 `pointer-events: none`，
              // 高亮的那一处仍然要能点（第 3 步的「按发送」就在这个框里）。
              Positioned.fill(
                child: IgnorePointer(
                  child: CustomPaint(
                    painter: _ScrimPainter(spotlight: _spotlight),
                  ),
                ),
              ),
              Positioned(
                left: position.dx,
                top: position.dy,
                width: math.min(_maxCardWidth, viewport.width - _edge * 2),
                child: _buildCard(step),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildCard(int step) {
    // Web `renderCard()`：第 3 步在聊天页时不给「上一步」—— 上一步在另一页上。
    final showPrev = step > 1 && !(widget.page == TourPage.chat && step == 3);
    final nextLabel = step == 2 && widget.page == TourPage.home
        ? t('onboardContinue')
        : step == OnboardingStore.lastStep
        ? t('onboardDone')
        : t('onboardNext');
    return Material(
      key: _cardKey,
      color: AppColors.panel,
      elevation: 14,
      shadowColor: const Color(0x33000000),
      borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.line),
          borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    t('onboardStep', {'n': '$step'}),
                    key: const ValueKey('tour-eyebrow'),
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.2,
                    ),
                  ),
                ),
                IconButton(
                  key: const ValueKey('tour-close'),
                  onPressed: () => _cleanup(done: true),
                  iconSize: 18,
                  visualDensity: VisualDensity.compact,
                  tooltip: t('onboardClose'),
                  icon: const Icon(Icons.close_rounded, color: AppColors.faint),
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t('onboardStep${step}Title'),
                    key: const ValueKey('tour-title'),
                    style: const TextStyle(
                      color: AppColors.textBright,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      height: 1.35,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    t('onboardStep${step}Body'),
                    key: const ValueKey('tour-body'),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 13.5,
                      height: 1.55,
                    ),
                  ),
                  if (step == 3) ...[
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      key: const ValueKey('tour-fill'),
                      onPressed: _fillExample,
                      icon: const Icon(Icons.edit_note_rounded, size: 18),
                      label: Text(t('onboardFill')),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.accentDark,
                        side: const BorderSide(color: AppColors.lineStrong),
                        minimumSize: const Size(0, 36),
                        textStyle: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      TextButton(
                        key: const ValueKey('tour-skip'),
                        onPressed: () => _cleanup(done: true),
                        style: TextButton.styleFrom(
                          foregroundColor: AppColors.muted,
                          minimumSize: const Size(0, 36),
                          textStyle: const TextStyle(fontSize: 12.5),
                        ),
                        child: Text(t('onboardSkip')),
                      ),
                      const Spacer(),
                      if (showPrev)
                        TextButton(
                          key: const ValueKey('tour-prev'),
                          onPressed: _prev,
                          style: TextButton.styleFrom(
                            foregroundColor: AppColors.muted,
                            minimumSize: const Size(0, 36),
                            textStyle: const TextStyle(fontSize: 12.5),
                          ),
                          child: Text(t('onboardPrev')),
                        ),
                      FilledButton(
                        key: const ValueKey('tour-next'),
                        onPressed: _next,
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.accentDark,
                          minimumSize: const Size(0, 36),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          textStyle: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        child: Text(nextLabel),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 遮罩 + 光圈。用 `BlendMode.clear` 把光圈那块从遮罩里挖掉 —— Web 那边是一圈
/// 9999px 的 `box-shadow` 做的同一件事。
class _ScrimPainter extends CustomPainter {
  _ScrimPainter({required this.spotlight});

  final Rect? spotlight;

  @override
  void paint(Canvas canvas, Size size) {
    final area = Offset.zero & size;
    final scrim = Paint()..color = const Color(0xB8010409);
    final hole = spotlight;
    if (hole == null) {
      canvas.drawRect(area, scrim);
      return;
    }
    canvas.saveLayer(area, Paint());
    canvas.drawRect(area, scrim);
    canvas.drawRRect(
      RRect.fromRectAndRadius(hole, const Radius.circular(12)),
      Paint()..blendMode = BlendMode.clear,
    );
    canvas.restore();
    canvas.drawRRect(
      RRect.fromRectAndRadius(hole, const Radius.circular(12)),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = AppColors.accent,
    );
  }

  @override
  bool shouldRepaint(covariant _ScrimPainter oldDelegate) =>
      oldDelegate.spotlight != spotlight;
}

/// 聊天页那层引导的接线：两个锚点、示例怎么填、回复到没到，都收在这里，
/// 让 `chat_screen.dart` 只剩两处 [TourAnchor] 和一次包壳。
///
/// 两个锚点（消息区、输入框）在聊天页内部的树上，本层够不着，所以键放在这里、
/// 由 [TourAnchorScope] 递下去。第 3 步那根探针也一样：它要数 provider 里的消息，
/// 而本层就在 provider 底下，直接 `context.read` 就行。
class ChatTourLayer extends StatefulWidget {
  const ChatTourLayer({
    super.key,
    required this.composerController,
    required this.composerFocus,
    required this.child,
  });

  /// 输入区自己的草稿与焦点。「填入只读示例」要往这里写，Web 那边是往
  /// `#input` 塞文本再派发 input 事件。
  final TextEditingController composerController;
  final FocusNode composerFocus;

  final Widget child;

  @override
  State<ChatTourLayer> createState() => _ChatTourLayerState();
}

class _ChatTourLayerState extends State<ChatTourLayer> {
  final _tourKey = GlobalKey<TourOverlayState>();
  final _anchors = <int, GlobalKey>{3: GlobalKey(), 4: GlobalKey()};

  @override
  void initState() {
    super.initState();
    // 只在聊天页第一次挂上来时开一次。进度如果是 3/4（首页那两步走完存的），
    // 这一步就是 Web 那句「打开对话后继续」的落点。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _tourKey.currentState?.autoStart();
    });
  }

  /// 「填入只读示例」：光标停在末尾，用户接着按发送就行。
  void _fillExample() {
    final text = t('onboardExample');
    widget.composerController.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    widget.composerFocus.requestFocus();
  }

  /// 引导第 3 步的观察探针（Web `armFirstResultObserver` 数的就是这两个）。
  TourResultCounts _resultCounts() {
    var users = 0;
    var assistants = 0;
    var last = '';
    for (final message in context.read<ChatProvider>().messages) {
      if (message.role == MessageRole.user) {
        users += 1;
      } else if (message.role == MessageRole.assistant) {
        assistants += 1;
        last = message.content;
      }
    }
    return (users: users, assistants: assistants, lastAssistant: last);
  }

  @override
  Widget build(BuildContext context) => Stack(
    children: [
      TourAnchorScope(anchors: _anchors, child: widget.child),
      // 套在 Scaffold 外面：第 4 步要圈住整块消息区，光圈还得压过页头。
      TourOverlay(
        key: _tourKey,
        page: TourPage.chat,
        anchors: _anchors,
        onFillExample: _fillExample,
        resultProbe: _resultCounts,
      ),
    ],
  );
}

/// [ChatTourLayer] 与页内锚点之间的一根线。
class TourAnchorScope extends InheritedWidget {
  const TourAnchorScope({super.key, required this.anchors, required super.child});

  final Map<int, GlobalKey> anchors;

  static Map<int, GlobalKey> of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<TourAnchorScope>()
          ?.anchors ??
      const {};

  @override
  bool updateShouldNotify(covariant TourAnchorScope oldWidget) =>
      oldWidget.anchors != anchors;
}

/// 把孩子的 key 换成引导那一步要圈的锚点。不在引导里（或这一步没锚点）就原样
/// 返回孩子 —— 非引导路径上这层是透明的。
class TourAnchor extends StatelessWidget {
  const TourAnchor({super.key, required this.step, required this.child});

  final int step;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final key = TourAnchorScope.of(context)[step];
    return key == null ? child : KeyedSubtree(key: key, child: child);
  }
}
