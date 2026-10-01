// 「运行配置」面板与角色提示词编辑器共用的输入框皮。原来长在
// ai_config_sheet.dart 里（私有），面板拆出去之后两边都要用，于是单独一份。
library;

import 'package:flutter/material.dart';

import '../../theme.dart';

InputDecoration runConfigInputDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: AppColors.faint),
    filled: true,
    fillColor: const Color(0xFFf4f8fd),
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: Color(0xFFdce6f1)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: AppColors.accent),
    ),
  );
}
