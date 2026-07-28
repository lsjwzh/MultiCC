/// Commander 会话的分发模式选择器：一枚显示当前选择的胶囊 + 点开的 BottomSheet。
///
/// 三个选项平铺在输入框上方会把本来就窄的手机输入区挤掉，所以这里跟 web 窄屏
/// 走同一套形态：胶囊只显示「现在是哪一档」，要改再弹 sheet。文案与 web 共用
/// i18n key（[dispatchModeUi]），派发后缀逻辑仍在 utils/dispatch_hint.dart，
/// 这里只管外壳。
library;

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../utils/dispatch_hint.dart';

/// 一档分发模式在 UI 上的样子。图标语义与 web 的 ⇄ / ➤ / ⊘ 对齐。
class DispatchModeUi {
  const DispatchModeUi({
    required this.icon,
    required this.shortKey,
    required this.labelKey,
    required this.descKey,
    required this.accent,
  });

  final IconData icon;
  final String shortKey;
  final String labelKey;
  final String descKey;
  final Color accent;
}

const Color _kAccentDispatch = Color(0xFF58a6ff);
const Color _kAccentNone = Color(0xFFd29922);

DispatchModeUi dispatchModeUi(DispatchMode mode) {
  switch (mode) {
    case DispatchMode.dispatchMaster:
      return const DispatchModeUi(
        icon: Icons.sync_alt,
        shortKey: 'dispatchModeMasterShort',
        labelKey: 'dispatchModeMasterLabel',
        descKey: 'dispatchModeMasterDesc',
        accent: _kAccentDispatch,
      );
    case DispatchMode.routeTask:
      return const DispatchModeUi(
        icon: Icons.send_outlined,
        shortKey: 'dispatchModeRouteShort',
        labelKey: 'dispatchModeRouteLabel',
        descKey: 'dispatchModeRouteDesc',
        accent: _kAccentDispatch,
      );
    case DispatchMode.none:
      return const DispatchModeUi(
        icon: Icons.block_outlined,
        shortKey: 'dispatchModeNoneShort',
        labelKey: 'dispatchModeNoneLabel',
        descKey: 'dispatchModeNoneDesc',
        accent: _kAccentNone,
      );
  }
}

/// 当前分发模式的胶囊。点一下弹 sheet，选完回调 [onChanged]；
/// 用户空手退出 sheet 时不回调，模式保持不变。
class DispatchModePill extends StatelessWidget {
  const DispatchModePill({
    super.key,
    required this.mode,
    required this.onChanged,
  });

  final DispatchMode mode;
  final ValueChanged<DispatchMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final ui = dispatchModeUi(mode);
    return Semantics(
      button: true,
      label: '${t('dispatchModeTitle')}: ${t(ui.shortKey)}',
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: () async {
          final picked = await showDispatchModeSheet(context, mode);
          if (picked != null && picked != mode) onChanged(picked);
        },
        child: Container(
          // 44px 是可点区域下限；胶囊本体矮一点，靠 padding 把热区撑够。
          constraints: const BoxConstraints(minHeight: 34),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: ui.accent.withValues(alpha: .14),
            border: Border.all(color: ui.accent.withValues(alpha: .55)),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(ui.icon, size: 14, color: ui.accent),
              const SizedBox(width: 5),
              Text(
                t('dispatchModeTitle'),
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(width: 5),
              Text(
                t(ui.shortKey),
                style: TextStyle(
                  color: ui.accent,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 3),
              Icon(Icons.arrow_drop_down, size: 15, color: ui.accent),
            ],
          ),
        ),
      ),
    );
  }
}

/// 三选一的 BottomSheet。返回用户选的那一档；点背景/返回键关掉则返回 null。
Future<DispatchMode?> showDispatchModeSheet(
  BuildContext context,
  DispatchMode current,
) {
  return showModalBottomSheet<DispatchMode>(
    context: context,
    backgroundColor: const Color(0xFF161b22),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
    ),
    builder: (sheetContext) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFF30363d),
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 8),
              child: Text(
                t('dispatchModeSheetTitle'),
                style: const TextStyle(color: Color(0xFF8b949e), fontSize: 12),
              ),
            ),
            for (final mode in DispatchMode.values)
              _DispatchModeSheetRow(
                mode: mode,
                selected: mode == current,
                onTap: () => Navigator.of(sheetContext).pop(mode),
              ),
          ],
        ),
      ),
    ),
  );
}

class _DispatchModeSheetRow extends StatelessWidget {
  const _DispatchModeSheetRow({
    required this.mode,
    required this.selected,
    required this.onTap,
  });

  final DispatchMode mode;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ui = dispatchModeUi(mode);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        child: InkWell(
          key: Key('dispatch-mode-sheet-${mode.wireName}'),
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: selected
                  ? ui.accent.withValues(alpha: .12)
                  : const Color(0xFF0d1117),
              border: Border.all(
                color: selected
                    ? ui.accent.withValues(alpha: .6)
                    : const Color(0xFF30363d),
              ),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Icon(
                  ui.icon,
                  size: 18,
                  color: selected ? ui.accent : const Color(0xFF8a909b),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        t(ui.labelKey),
                        style: TextStyle(
                          color: selected
                              ? ui.accent
                              : const Color(0xFFc9d1d9),
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        t(ui.descKey),
                        style: const TextStyle(
                          color: Color(0xFF8b949e),
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                if (selected) ...[
                  const SizedBox(width: 8),
                  Icon(Icons.check, size: 16, color: ui.accent),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
