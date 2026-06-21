import 'package:flutter/material.dart';

/// A single role-prompt preset. The list endpoint (`/api/agent-presets`)
/// returns these without [prompt]; the detail endpoint
/// (`/api/agent-presets/:id`) returns the full record including [prompt].
class AgentPreset {
  final String id;
  final String name;
  final String description;
  final String category;
  final String color; // color name, e.g. "cyan" / "blue"
  final String emoji;
  final String vibe;
  final String? prompt; // null in the index, populated by the detail endpoint

  const AgentPreset({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.color,
    required this.emoji,
    required this.vibe,
    this.prompt,
  });

  factory AgentPreset.fromJson(Map<String, dynamic> j) {
    return AgentPreset(
      id: (j['id'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      description: (j['description'] ?? '').toString(),
      category: (j['category'] ?? '').toString(),
      color: (j['color'] ?? '').toString(),
      emoji: (j['emoji'] ?? '').toString(),
      vibe: (j['vibe'] ?? '').toString(),
      prompt: j['prompt']?.toString(),
    );
  }

  /// The preset's accent color resolved from its [color] name.
  Color get accentColor => agentColorFromName(color);
}

/// A preset category bucket (from the index `categories` field).
class AgentCategory {
  final String key;
  final String label;
  final int count;

  const AgentCategory({
    required this.key,
    required this.label,
    required this.count,
  });

  factory AgentCategory.fromJson(Map<String, dynamic> j) {
    return AgentCategory(
      key: (j['key'] ?? '').toString(),
      label: (j['label'] ?? '').toString(),
      count: (j['count'] is num) ? (j['count'] as num).toInt() : 0,
    );
  }
}

/// The full preset index returned by `/api/agent-presets`.
class AgentPresetIndex {
  final List<String> featured;
  final List<AgentCategory> categories;
  final List<AgentPreset> presets;

  const AgentPresetIndex({
    required this.featured,
    required this.categories,
    required this.presets,
  });

  factory AgentPresetIndex.fromJson(Map<String, dynamic> j) {
    final featured = (j['featured'] as List? ?? [])
        .map((e) => e.toString())
        .toList();
    final categories = (j['categories'] as List? ?? [])
        .map((e) => AgentCategory.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    final presets = (j['presets'] as List? ?? [])
        .map((e) => AgentPreset.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    return AgentPresetIndex(
      featured: featured,
      categories: categories,
      presets: presets,
    );
  }

  /// The featured presets, resolved to full [AgentPreset] objects (in the
  /// order given by [featured]). Ids with no matching preset are skipped.
  List<AgentPreset> get featuredPresets {
    final byId = {for (final p in presets) p.id: p};
    final out = <AgentPreset>[];
    for (final id in featured) {
      final p = byId[id];
      if (p != null) out.add(p);
    }
    return out;
  }
}

/// Map a color name (e.g. "cyan", "blue") to a Flutter [Color]. Unknown names
/// fall back to a neutral grey.
Color agentColorFromName(String name) {
  switch (name.trim().toLowerCase()) {
    case 'red':
      return const Color(0xFFff6b63);
    case 'orange':
      return const Color(0xFFf0936b);
    case 'amber':
    case 'yellow':
      return const Color(0xFFe3b341);
    case 'green':
      return const Color(0xFF7fd49a);
    case 'teal':
      return const Color(0xFF3ad6c5);
    case 'cyan':
      return const Color(0xFF49d6e0);
    case 'blue':
      return const Color(0xFF6aa3ff);
    case 'indigo':
      return const Color(0xFF7c8cff);
    case 'purple':
    case 'violet':
      return const Color(0xFFb692f6);
    case 'pink':
    case 'magenta':
      return const Color(0xFFf07ac0);
    case 'grey':
    case 'gray':
      return const Color(0xFF8a909b);
    default:
      return const Color(0xFF8a909b); // neutral grey fallback
  }
}
