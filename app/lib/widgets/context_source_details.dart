import 'package:flutter/material.dart';
import '../i18n.dart';

String contextSourceLabel(String mode) {
  if (!mode.startsWith('memory:')) return t('usageContextPolicy');
  const names = {
    'builtin': 'Builtin',
    'machine': 'Machine',
    'cli': 'Cli',
    'shared': 'Shared',
    'task': 'Task',
    'own': 'Own',
    'skill': 'Skill',
    'withdrawn': 'Withdrawn',
  };
  return t('usageContextMemory${names[mode.substring(7)] ?? 'Task'}');
}

String contextSourceMeta(Map source) {
  final version = '${source['version'] ?? ''}';
  return '${source['retained'] == true ? ' · ${t('usageContextRetained')}' : ''}'
      '${source['truncated'] == true ? ' · ${t('usageContextTruncated')}' : ''}'
      '${version.isNotEmpty ? ' · v ${version.substring(0, version.length.clamp(0, 12))}' : ''}';
}

class ContextBudgetDetails extends StatelessWidget {
  final Map<String, dynamic> trace;
  const ContextBudgetDetails({super.key, required this.trace});
  @override
  Widget build(BuildContext context) {
    final budget = trace['budget'] as Map? ?? {};
    final omitted = trace['omitted'] as List? ?? [];
    final retained = trace['retained'] as List? ?? [];
    final diagnostics = trace['diagnostics'] as List? ?? [];
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      title: Text(
        t('usageContextBudget', {
          'used': '${budget['used'] ?? 0}',
          'limit': '${budget['limit'] ?? 0}',
        }),
        style: const TextStyle(fontSize: 11),
      ),
      subtitle: Text(
        t('usageContextSelection', {
          'kept': '${retained.length}',
          'omitted': '${omitted.length}',
        }),
        style: const TextStyle(fontSize: 10),
      ),
      children: [
        for (final source in retained.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['taskName'] ?? source['id']}'),
            subtitle: Text(t('usageContextRetained')),
          ),
        for (final source in omitted.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['id']}'),
            subtitle: Text('${source['reason']}'),
          ),
        for (final source in diagnostics.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['path'] ?? ''}'),
            subtitle: Text('${source['reason']}'),
          ),
      ],
    );
  }
}
