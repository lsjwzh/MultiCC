import 'package:flutter/material.dart';

/// 项目统计小药丸（如 ahead/behind/dirty 计数）。自 main_shell.dart 抽出。
class ProjectStatPill extends StatelessWidget {
  final String label;
  final String value;
  final Color? color;
  const ProjectStatPill({
    super.key,
    required this.label,
    required this.value,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final c = color ?? const Color(0xFF8a909b);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFF070809),
        border: Border.all(
          color: color == null
              ? const Color(0xFF20242b)
              : c.withValues(alpha: 0.45),
        ),
        borderRadius: BorderRadius.circular(999),
      ),
      child: RichText(
        text: TextSpan(
          style: TextStyle(color: c, fontSize: 11),
          children: [
            TextSpan(
              text: value,
              style: const TextStyle(
                color: Color(0xFFf2f4f7),
                fontWeight: FontWeight.w700,
              ),
            ),
            TextSpan(text: ' $label'),
          ],
        ),
      ),
    );
  }
}
