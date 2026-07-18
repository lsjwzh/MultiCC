import 'dart:convert';
import 'package:flutter/services.dart' show rootBundle;

/// Simple i18n for the MultiCC Flutter app.  All user-visible strings live in
/// the JSON asset files; English falls back to Chinese keys when a translation
/// is missing (the en file is a subset — only ui-shell strings are translated;
/// deep app strings default to zh until contributed).
///
/// Language persistence and rebuild notifications are owned by
/// [SettingsService]. This class only owns the loaded catalogs and lookup.

class I18n {
  static I18n? _instance;
  String _lang = 'zh';
  Map<String, String> _zh = {};
  Map<String, String> _en = {};

  I18n._();

  static I18n get instance => _instance ??= I18n._();

  String get lang => _lang;

  /// Initialise from asset files.  Call once in main() before MaterialApp.
  static Future<void> init(String? savedLang) async {
    final i = instance;
    i._lang = savedLang == 'en' ? 'en' : 'zh';

    // Load zh (the authoritative dictionary)
    final zhSrc = await rootBundle.loadString('assets/i18n/zh.json');
    final zhMap = (json.decode(zhSrc) as Map<String, dynamic>)
        .cast<String, String>();
    i._zh = zhMap;

    // En is a subset overlay — missing keys fall back to zh.
    try {
      final enSrc = await rootBundle.loadString('assets/i18n/en.json');
      final enMap = (json.decode(enSrc) as Map<String, dynamic>)
          .cast<String, String>();
      i._en = enMap;
    } catch (_) {
      i._en = {};
    }
  }

  /// Apply the selected language. [SettingsService] persists the choice and
  /// rebuilds MaterialApp before this is called.
  static String switchLang(String? savedLang) {
    instance._lang = savedLang == 'en' ? 'en' : 'zh';
    return instance._lang;
  }

  /// Look up [key] in the current language, falling back to zh then the key
  /// itself.  Supports simple `{0}`, `{1}` parameter substitution.
  String t(String key, [Map<String, String> params = const {}]) {
    String? v;
    if (_lang == 'en') {
      v = _en[key];
    }
    v ??= _zh[key] ?? key;
    if (params.isNotEmpty) {
      for (final e in params.entries) {
        v = v!.replaceAll('{${e.key}}', e.value);
      }
    }
    return v!;
  }

  /// Convenience: `I18n.of(context).t(key)`
  static String of(String key, [Map<String, String> params = const {}]) {
    return instance.t(key, params);
  }
}

/// Shorthand for the most common pattern.
String t(String key, [Map<String, String> params = const {}]) =>
    I18n.of(key, params);
