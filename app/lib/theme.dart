import 'package:flutter/material.dart';

/// Central palette for the MultiCC app — mirrors the Air web console
/// (`public/air.css`): a pale blue-white canvas, hairline borders, and a
/// single ice-blue accent, with Claude (orange) / Codex (green) kept as
/// semantic brand colors. Keep these values in step with `public/air.css`
/// `:root` — the two surfaces are meant to read as one product.
class AppColors {
  // Surfaces
  static const bg = Color(0xFFf4f8fd); // page canvas
  static const bgSoft = Color(0xFFf8fbff); // raised canvas / soft band
  static const panel = Color(0xFFffffff); // cards, sheets, app bars
  static const panel2 = Color(0xFFf8fbff); // second panel tier
  static const well = Color(0xFFfbfdff); // input wells
  static const line = Color(0xFFdce6f1);
  static const lineStrong = Color(0xFFccdbea);

  // Text
  static const text = Color(0xFF233249);
  static const textBright = Color(0xFF20364d);
  static const muted = Color(0xFF6f8096);
  static const faint = Color(0xFF8a9aab);
  static const onAccent = Color(0xFFffffff);

  // Accents
  static const accent = Color(0xFF1678e8); // ice blue — the single tech accent
  static const accentDark = Color(0xFF0965cf); // solid-button blue
  static const blue = Color(0xFF1267b5); // links / paths
  static const blueSoft = Color(0xFFeaf4ff); // accent tint fill
  static const claude = Color(0xFFc2622f); // Claude brand
  static const codex = Color(0xFF1e8a55); // Codex brand
  static const opencode = Color(0xFF6d4fd1); // OpenCode brand (violet)
  static const zcode = Color(0xFF0e7fb8); // ZCode brand (sky blue)
  static const qoder = Color(0xFFc25e1e); // Qoder CN brand (orange)
  static const codebuddy = Color(0xFF2a5fd8); // WorkBuddy brand (Tencent blue)
  static const dsh = Color(0xFF2b44d6); // DeepSeek Harness brand (blue)
  static const gemini = Color(0xFF4285f4); // Gemini brand (Google blue)
  static const grok = Color(0xFF8c8f96); // Grok brand (graphite)
  static const amber = Color(0xFFa85a25);
  static const warning = Color(0xFFa85a25);
  static const success = Color(0xFF2ba67a);
  static const danger = Color(0xFFb64e43);
  static const dangerSoft = Color(0xFFfff1ef);

  // Radii, matching the Air console's scale.
  static const radiusChip = 10.0;
  static const radiusButton = 11.0;
  static const radiusCard = 14.0;
  static const radiusPanel = 17.0;
  static const radiusPill = 999.0;
}

/// App-wide light ThemeData built on the Air palette.
ThemeData buildAppTheme() {
  const accent = AppColors.accent;
  final base = ThemeData.light(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: AppColors.bg,
    canvasColor: AppColors.panel,
    colorScheme: base.colorScheme.copyWith(
      brightness: Brightness.light,
      primary: accent,
      secondary: AppColors.blue,
      surface: AppColors.panel,
      error: AppColors.danger,
      onPrimary: AppColors.onAccent,
      onSurface: AppColors.text,
    ),
    dividerColor: AppColors.line,
    dialogTheme: const DialogThemeData(
      backgroundColor: AppColors.panel,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: TextStyle(
        color: AppColors.textBright,
        fontSize: 16,
        fontWeight: FontWeight.w600,
      ),
      contentTextStyle: TextStyle(color: AppColors.muted, fontSize: 14),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.panel,
      foregroundColor: AppColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.panel,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: AppColors.panel,
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: accent,
      selectionColor: Color(0x331678e8),
      selectionHandleColor: accent,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.accentDark,
        foregroundColor: AppColors.onAccent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppColors.radiusButton),
        ),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? AppColors.onAccent
            : AppColors.muted,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? accent : AppColors.line,
      ),
    ),
  );
}

/// Shared compact InputDecoration for bottom-sheet / dialog text fields.
/// 自 main_shell.dart 的 _inputDec 抽出，供 main_shell / create_session_dialog 共用。
InputDecoration sheetInputDecoration({String? hint}) => InputDecoration(
  isDense: true,
  filled: true,
  fillColor: AppColors.well,
  hintText: hint,
  hintStyle: const TextStyle(color: AppColors.faint, fontSize: 13),
  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
  border: OutlineInputBorder(
    borderSide: const BorderSide(color: AppColors.line),
    borderRadius: BorderRadius.circular(AppColors.radiusChip),
  ),
  enabledBorder: OutlineInputBorder(
    borderSide: const BorderSide(color: AppColors.line),
    borderRadius: BorderRadius.circular(AppColors.radiusChip),
  ),
  focusedBorder: OutlineInputBorder(
    borderSide: const BorderSide(color: AppColors.accent),
    borderRadius: BorderRadius.circular(AppColors.radiusChip),
  ),
);
