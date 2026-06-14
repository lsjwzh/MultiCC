import 'package:flutter/material.dart';

/// Central palette for the MultiCC app — mirrors the web dashboard redesign:
/// near-black background, hairline borders, a single teal-cyan accent, with
/// Claude (orange) / Codex (green) kept as semantic brand colors.
class AppColors {
  // Surfaces
  static const bg = Color(0xFF070809);
  static const bgSoft = Color(0xFF0b0d10);
  static const panel = Color(0xFF0f1115);
  static const panel2 = Color(0xFF14171c);
  static const line = Color(0xFF20242b);
  static const lineStrong = Color(0xFF2b313a);

  // Text
  static const text = Color(0xFFe7eaee);
  static const textBright = Color(0xFFf2f4f7);
  static const muted = Color(0xFF8a909b);
  static const faint = Color(0xFF5b616c);

  // Accents
  static const accent = Color(0xFF3ad6c5); // teal-cyan — the single tech accent
  static const accentDark = Color(0xFF22ab9c); // solid-button teal
  static const blue = Color(0xFF6aa3ff); // links / paths
  static const claude = Color(0xFFf0936b); // Claude brand
  static const codex = Color(0xFF7fd49a); // Codex brand
  static const amber = Color(0xFFe3b341);
  static const danger = Color(0xFFff6b63);
}

/// App-wide dark ThemeData built on the new palette.
ThemeData buildAppTheme() {
  const accent = AppColors.accent;
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: AppColors.bg,
    canvasColor: AppColors.panel,
    colorScheme: base.colorScheme.copyWith(
      brightness: Brightness.dark,
      primary: accent,
      secondary: AppColors.blue,
      surface: AppColors.panel,
      error: AppColors.danger,
      onPrimary: const Color(0xFF04110f),
      onSurface: AppColors.text,
    ),
    dividerColor: AppColors.line,
    dialogTheme: const DialogThemeData(
      backgroundColor: AppColors.panel,
      titleTextStyle: TextStyle(
          color: AppColors.textBright, fontSize: 16, fontWeight: FontWeight.w600),
      contentTextStyle: TextStyle(color: AppColors.muted, fontSize: 14),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.panel,
      foregroundColor: AppColors.text,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: accent,
      selectionColor: Color(0x553ad6c5),
      selectionHandleColor: accent,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.accentDark,
        foregroundColor: const Color(0xFF04110f),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? const Color(0xFF04110f) : AppColors.muted),
      trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? accent : AppColors.line),
    ),
  );
}
