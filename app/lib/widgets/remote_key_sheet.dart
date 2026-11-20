// 键盘面板：按需弹出的底部 sheet（文字 + 修饰键 + 键位网格）。
//
// 常驻键盘条是画面被压缩的主因之一；改成「点侧栏键盘才出来」后，键盘会
// 自己吃掉下半屏，但那只在真的要打字时发生。收起后如果还有粘住的修饰键，
// 屏幕底部留一条 32dp 的浮条，保证「⌘ 还按着」这件事一直看得见。
import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/sticky_modifiers.dart';

const Color _kSheetBg = Color(0xFF161b26);
const Color _kLine = Color(0xFF2a3242);
const Color _kText = Color(0xFFdce6f1);
const Color _kMuted = Color(0xFF8a9aab);
const Color _kAccent = Color(0xFF2ba67a);

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

  /// 系统键盘高度（`MediaQuery.viewInsets.bottom`）。
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
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: _kLine,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    t('rsKeyPanel'),
                    style: const TextStyle(
                      color: _kMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  TextButton(
                    key: const ValueKey('rs-key-close'),
                    onPressed: onClose,
                    child: Text(
                      t('rsCollapse'),
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
                ],
              ),
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
                  const SizedBox(width: 6),
                  FilledButton(
                    key: const ValueKey('rs-key-send'),
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF1267b5),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      minimumSize: const Size(0, 36),
                    ),
                    onPressed: onSend,
                    child: Text(
                      t('rsSend'),
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final chip in StickyModifiers.definitions) _mod(chip),
                  ],
                ),
              ),
              const SizedBox(height: 6),
              Flexible(
                child: SingleChildScrollView(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final spec in specs) _specChip(spec)],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

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
