import '../i18n.dart';

/// 千分位 —— 对齐 web 的 `Number(n).toLocaleString()`（`12345` → `12,345`）。
String _thousands(Object? n) {
  final digits = '${n ?? ''}'.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.isEmpty) return '$n';
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buf.write(',');
    buf.write(digits[i]);
  }
  return buf.toString();
}

/// MB，两位小数 —— web 里的 `mb()`。
String _mb(Object? n) {
  final v = (n as num?)?.toDouble() ?? 0;
  return '${(v / 1048576).toStringAsFixed(2)} MB';
}

/// 把 `GET /api/sessions/:id/context-level` 的响应翻成一句系统消息
/// （Web `chat-context-controls.js` 的 `showContextLevel`）。
///
/// 返回 null 表示这个会话没有可读的原生上下文 —— 调用方要显示
/// [contextLevelUnavailable]，而不是「失败」：非 claude 会话本来就没有。
String? contextLevelMessage(Map<String, dynamic> data) {
  if (data['supported'] == false) return null;
  final t0 = data['transcript'];
  if (t0 is! Map) return null;
  final tr = Map<String, dynamic>.from(t0);
  if (tr['found'] == false) return null;

  final parts = <String>[
    t('contextLevelSummary', {
      'live': _mb(tr['liveBytes']),
      'file': _mb(tr['fileBytes']),
      'turns': '${tr['liveTurns'] ?? 0}',
      'tokens': tr['estimatedTokens'] == null
          ? '?'
          : _thousands(tr['estimatedTokens']),
    }),
  ];
  final boundary = tr['compactBoundary'];
  if (boundary is Map && boundary['present'] == true) {
    parts.add(t('contextLevelCompacted'));
  }
  // 「上下文压力」而不是「文件大小」：`wouldPrune` 只说明闸门会来看一眼。
  if (tr['overWatermark'] == true) parts.add(t('contextLevelOverWatermark'));

  final plan0 = data['plan'];
  final plan = plan0 is Map ? Map<String, dynamic>.from(plan0) : null;
  final lost = (plan?['lostTurns'] as num?)?.toInt() ?? 0;
  if (plan != null) {
    parts.add(
      lost > 0
          ? t('contextLevelPlanLossy', {
              'after': _mb(plan['afterBytes']),
              'turns': '$lost',
              // 说过话的那几轮 —— 剩下的都是「继续」这种填充。
              'substantive':
                  '${plan['lostSubstantiveTurns'] ?? lost}',
            })
          : t('contextLevelPlanSafe', {'after': _mb(plan['afterBytes'])}),
    );
  } else if (tr['wouldPrune'] == true) {
    // 闸门会跑，但找不出值得重写的东西。要是这里不吭声，「已超过高水位」就成了
    // 最后一句话，读起来像是马上要剪一刀。
    parts.add(t('contextLevelPlanNone'));
  }
  return parts.join(' ');
}
