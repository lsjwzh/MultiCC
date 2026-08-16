// Provider dropdown option, laid out on up to two lines so the quota summary
// survives narrow phones. Line 1 = provider name (+ model / subscription);
// line 2 (only when limit data exists) = the limit summary · freshness detail
// from provider_limit_label.dart, rendered small and muted.
//
// Each line ellipsizes independently: on a narrow screen the name line may be
// cut, but the quota text lives on its own line and is never eaten by a
// single-line ellipsis. No limit data → plain single-line row, exactly as the
// legacy Text rendered it (clean, intentional absence).
//
// The two-line form is adaptive: a closed DropdownButton(FormField) button is a
// fixed single-line height (dense InputDecorator ~24px), and laying the Column
// out there overflows. So the detail line only renders when the host gives
// vertical room — i.e. inside an open menu, where items get unbounded height.
import 'package:flutter/material.dart';

import '../theme.dart';

class ProviderOption extends StatelessWidget {
  const ProviderOption({
    super.key,
    required this.main,
    this.detail = '',
    this.mainStyle,
    this.detailStyle,
  });

  /// First line: provider name + model / subscription markers.
  final String main;

  /// Second line: `providerLimitDetail(...)` output; empty hides the line.
  final String detail;

  final TextStyle? mainStyle;
  final TextStyle? detailStyle;

  @override
  Widget build(BuildContext context) {
    final mainText = Text(
      main,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: mainStyle ?? const TextStyle(color: AppColors.text, fontSize: 13),
    );
    if (detail.isEmpty) return mainText;
    final detailText = Text(
      detail,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: detailStyle ?? const TextStyle(color: AppColors.faint, fontSize: 10.5),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        // Open menus give items unbounded height → two lines. A closed field
        // (single dense line, ~24px) → keep the compact main line only.
        final roomy = constraints.maxHeight == double.infinity ||
            constraints.maxHeight >= 36;
        if (!roomy) return mainText;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            mainText,
            const SizedBox(height: 2),
            detailText,
          ],
        );
      },
    );
  }
}
