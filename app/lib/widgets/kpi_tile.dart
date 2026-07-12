import 'package:flutter/material.dart';

/// 首页 KPI 小方块（active/waiting/cron）。自 main_shell.dart 抽出。
class KpiTile extends StatelessWidget {
  final String label;
  final String? value;
  final Color color;
  final VoidCallback onTap;
  const KpiTile({
    super.key,
    required this.label,
    required this.value,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFF20242b)),
          ),
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 12,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (value != null) ...[
                const SizedBox(width: 4),
                Text(
                  value!,
                  style: TextStyle(
                    color: color,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ] else
                const Icon(
                  Icons.chevron_right,
                  size: 16,
                  color: Color(0xFF5b616c),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
