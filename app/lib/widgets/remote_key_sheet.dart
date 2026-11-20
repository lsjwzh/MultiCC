// 键盘面板：按需弹出的底部面板（文字 + 修饰键 + 键位网格）。
//
// 常驻键盘条是画面被压缩的主因之一；改成「点侧栏键盘才出来」后，键盘只在真要
// 打字时吃掉下半屏。
//
// **非模态**是这个面板最重要的属性：远控打字的真实循环是「看屏 → 点远端输入框
// → 打字 → 再点另一个框」。早期版本用 showModalBottomSheet，遮罩会把画面压暗
// 并吞掉所有点击（点一下只是关掉面板），等于每切一个输入框都要开关一次面板。
// 现在面板只占底部那条，上面的画面照常可点，页面把舞台按面板高度等比缩小（而
// 不是盖住），所以「点哪打哪」的坐标映射自动保持正确。
//
// 高度由页面给（[height] 口径见 remote_screen_screen.dart）：默认只有输入行 +
// 修饰键两行，键位网格要点开才铺；打字时画面只让出必要的那点高度。
// 收起后如果还有粘住的修饰键，屏幕底部留一条 32dp 的浮条，保证「⌘ 还按着」
// 这件事一直看得见。
import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/sticky_modifiers.dart';

const Color _kSheetBg = Color(0xFF161b26);
const Color _kLine = Color(0xFF2a3242);
const Color _kText = Color(0xFFdce6f1);
const Color _kMuted = Color(0xFF8a9aab);
const Color _kAccent = Color(0xFF2ba67a);

/// 面板本体高度（不含系统键盘与底部安全区）。页面按这个值**让出**舞台高度，
/// 所以它必须和 build 里的行高对得上：上下内边距 8 + 输入行约 40 + 间距 4 +
/// 修饰键行 38 = 90。留一点余量：宁可面板里空几像素，也不要 RenderFlex 溢出。
/// 网格展开时多出来的高度全给网格（Expanded 吃掉剩余空间）。
double remoteKeyPanelHeight({required bool gridOpen}) => gridOpen ? 288 : 100;

class RemoteKeySheet extends StatelessWidget {
  const RemoteKeySheet({
    super.key,
    required this.textController,
    required this.onSend,
    required this.sticky,
    required this.onSticky,
    required this.onSpec,
    required this.onRepeatStart,
    required this.onRepeatStop,
    required this.specs,
    required this.repeatSpecs,
    required this.remapLabel,
    required this.remapSpec,
    required this.onClose,
    required this.gridOpen,
    required this.onToggleGrid,
    this.onPaste,
    this.bottomInset = 0,
  });

  final TextEditingController textController;
  final VoidCallback onSend;
  final StickyModifiers sticky;
  final void Function(StickyModifierKey chip) onSticky;

  /// 点一下发一次和弦。
  final void Function(String spec) onSpec;

  /// 按住连发（退格 / 方向键）：按下立即一发，之后由页面计时器续发。
  final void Function(String spec) onRepeatStart;
  final VoidCallback onRepeatStop;

  /// `[label, spec]` 全表；网格里直接铺开，不再有「更多」二级折叠。
  final List<List<String>> specs;
  final Set<String> repeatSpecs;
  final String Function(String label) remapLabel;
  final String Function(String spec) remapSpec;
  final VoidCallback onClose;

  /// 键位网格展开中：收起时只留输入行 + 修饰键，画面少让出 170dp。
  final bool gridOpen;
  final VoidCallback onToggleGrid;

  /// 「粘贴到远端」：粘贴几乎总发生在打字的上下文里，所以入口放在输入框旁边，
  /// 而不是只藏在「更多」面板的剪贴板一节里。
  final VoidCallback? onPaste;

  /// 系统键盘高度 + 底部安全区（由页面算好传进来）。
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Container(
        decoration: const BoxDecoration(
          color: _kSheetBg,
          border: Border(top: BorderSide(color: _kLine)),
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // 第一行：打字 + 粘贴 + 发送 + 网格开关 + 收起。标题行被并进来了 ——
            // 面板每多一行 chrome，画面就少一行，而这里的每一像素都是远端画面。
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const ValueKey('rs-key-text'),
                    controller: textController,
                    autofocus: true,
                    style: const TextStyle(color: _kText, fontSize: 13),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: t('rsTypePlaceholder'),
                      hintStyle: const TextStyle(
                        color: _kMuted,
                        fontSize: 12.5,
                      ),
                      filled: true,
                      fillColor: const Color(0xFF10141c),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(6),
                        borderSide: const BorderSide(color: _kLine),
                      ),
                    ),
                    onSubmitted: (_) => onSend(),
                  ),
                ),
                if (onPaste != null) ...[
                  const SizedBox(width: 6),
                  OutlinedButton(
                    key: const ValueKey('rs-key-paste'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: _kText,
                      side: const BorderSide(color: _kLine),
                      backgroundColor: const Color(0xFF10141c),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 36),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    onPressed: onPaste,
                    child: Text(
                      t('rsKeyPaste'),
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
                ],
                const SizedBox(width: 6),
                FilledButton(
                  key: const ValueKey('rs-key-send'),
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF1267b5),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: onSend,
                  child: Text(
                    t('rsSend'),
                    style: const TextStyle(fontSize: 12.5),
                  ),
                ),
                IconButton(
                  key: const ValueKey('rs-key-grid'),
                  onPressed: onToggleGrid,
                  visualDensity: VisualDensity.compact,
                  color: gridOpen ? _kAccent : _kMuted,
                  tooltip: gridOpen ? t('rsKeyGridHide') : t('rsKeyGridShow'),
                  icon: Icon(
                    gridOpen
                        ? Icons.keyboard_arrow_down_rounded
                        : Icons.keyboard_arrow_up_rounded,
                    size: 20,
                  ),
                ),
                IconButton(
                  key: const ValueKey('rs-key-close'),
                  onPressed: onClose,
                  visualDensity: VisualDensity.compact,
                  color: _kMuted,
                  tooltip: t('rsCollapse'),
                  icon: const Icon(Icons.close_rounded, size: 18),
                ),
              ],
            ),
            const SizedBox(height: 4),
            // 第二行：修饰键 + 常用键位。网格收起时常用键跟着横排一行（旧键盘条
            // 的位置），真要找 F 键或 Home/End 才点开网格。
            SizedBox(
              height: 38,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final chip in StickyModifiers.definitions) _mod(chip),
                    if (!gridOpen)
                      for (final spec in specs.take(_inlineKeys))
                        Padding(
                          padding: const EdgeInsets.only(left: 4),
                          child: _specChip(spec),
                        ),
                  ],
                ),
              ),
            ),
            if (gridOpen) ...[
              const SizedBox(height: 4),
              Expanded(
                child: SingleChildScrollView(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final spec in specs) _specChip(spec)],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 网格收起时内联显示的键位数量（回车 / 退格 / Tab / Esc / 方向键这一段）。
  static const int _inlineKeys = 8;

  Widget _mod(StickyModifierKey chip) {
    final state = sticky.stateOf(chip.id);
    final lit = state != StickyModifierState.off;
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: lit && state == StickyModifierState.locked
              ? const Color(0xFF10141c)
              : lit
              ? _kAccent
              : _kText,
          backgroundColor: state == StickyModifierState.locked
              ? _kAccent
              : const Color(0xFF10141c),
          side: BorderSide(color: lit ? _kAccent : _kLine),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          minimumSize: const Size(0, 34),
        ),
        onPressed: () => onSticky(chip),
        child: Text(
          chip.label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: state == StickyModifierState.locked
                ? FontWeight.w700
                : FontWeight.w500,
          ),
        ),
      ),
    );
  }

  Widget _specChip(List<String> spec) {
    final label = remapLabel(spec[0]);
    final normalized = remapSpec(spec[1]);
    final button = _key(label, () => onSpec(normalized));
    if (!repeatSpecs.contains(normalized)) return button;
    return Listener(
      onPointerDown: (_) => onRepeatStart(normalized),
      onPointerUp: (_) => onRepeatStop(),
      onPointerCancel: (_) => onRepeatStop(),
      child: button,
    );
  }

  Widget _key(String label, VoidCallback onTap) {
    return OutlinedButton(
      style: OutlinedButton.styleFrom(
        foregroundColor: _kText,
        side: const BorderSide(color: _kLine),
        backgroundColor: const Color(0xFF10141c),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        minimumSize: const Size(44, 34),
      ),
      onPressed: onTap,
      child: Text(label, style: const TextStyle(fontSize: 12.5)),
    );
  }
}

/// 面板收起、但还有粘住的修饰键时，底部那条 32dp 浮条。
class RemoteStickyStrip extends StatelessWidget {
  const RemoteStickyStrip({
    super.key,
    required this.sticky,
    required this.onSticky,
  });

  final StickyModifiers sticky;
  final void Function(StickyModifierKey chip) onSticky;

  @override
  Widget build(BuildContext context) {
    final chips = [
      for (final chip in StickyModifiers.definitions)
        if (sticky.stateOf(chip.id) != StickyModifierState.off) chip,
    ];
    if (chips.isEmpty) return const SizedBox.shrink();
    return Container(
      key: const ValueKey('rs-sticky-strip'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xE6161b26),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _kLine),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final chip in chips)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: InkWell(
                onTap: () => onSticky(chip),
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: sticky.stateOf(chip.id) == StickyModifierState.locked
                        ? _kAccent
                        : const Color(0x332ba67a),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: _kAccent),
                  ),
                  child: Text(
                    chip.label,
                    style: TextStyle(
                      fontSize: 12.5,
                      color:
                          sticky.stateOf(chip.id) == StickyModifierState.locked
                          ? const Color(0xFF10141c)
                          : _kText,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
