// 角色预设全量浏览底部面板（搜索 + 分类筛选 + 卡片列表 + 底部「使用选中项」）。自 chat_screen.dart 抽出。

import 'package:flutter/material.dart';

import '../models/agent_preset.dart';
import '../services/agent_preset_service.dart';
import '../theme.dart';

// ── Agent preset picker (full browser) ──────────────────────────────────────

/// A near-full-height bottom sheet for browsing every role-prompt preset:
/// search box, single-select category filter, a card list, and a footer
/// "use selected" action. Pops with the selected preset id, or null on cancel.
class AgentPresetPickerSheet extends StatefulWidget {
  final AgentPresetService service;
  final AgentPresetIndex? index; // optional warm cache from the editor
  const AgentPresetPickerSheet({super.key, required this.service, this.index});

  @override
  State<AgentPresetPickerSheet> createState() => _AgentPresetPickerSheetState();
}

class _AgentPresetPickerSheetState extends State<AgentPresetPickerSheet> {
  final _searchCtrl = TextEditingController();
  AgentPresetIndex? _index;
  bool _loading = false;
  String? _error;
  String _query = '';
  String _category = ''; // '' = all
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    _index = widget.index;
    if (_index == null) _load();
    _searchCtrl.addListener(() {
      setState(() => _query = _searchCtrl.text.trim().toLowerCase());
    });
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool forceRefresh = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final idx = await widget.service.fetchIndex(forceRefresh: forceRefresh);
      if (!mounted) return;
      setState(() {
        _index = idx;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  List<AgentPreset> get _filtered {
    final all = _index?.presets ?? const <AgentPreset>[];
    return all.where((p) {
      if (_category.isNotEmpty && p.category != _category) return false;
      if (_query.isEmpty) return true;
      return p.name.toLowerCase().contains(_query) ||
          p.description.toLowerCase().contains(_query);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height * 0.92;
    final categories = _index?.categories ?? const <AgentCategory>[];
    return Container(
      height: height,
      decoration: const BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: Column(
        children: [
          // grabber + title
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 8, 6),
            child: Row(
              children: [
                const Text(
                  '选择角色模板',
                  style: TextStyle(
                    color: AppColors.textBright,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(
                    Icons.close,
                    color: AppColors.muted,
                    size: 20,
                  ),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          // search
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              controller: _searchCtrl,
              style: const TextStyle(color: AppColors.text, fontSize: 14),
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(
                  Icons.search,
                  color: AppColors.faint,
                  size: 18,
                ),
                hintText: '搜索名称或描述…',
                hintStyle: const TextStyle(
                  color: AppColors.faint,
                  fontSize: 13,
                ),
                filled: true,
                fillColor: AppColors.panel2,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
          ),
          // category chips
          if (categories.isNotEmpty)
            SizedBox(
              height: 38,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: categories.length + 1,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  if (i == 0) {
                    return _CategoryChip(
                      label: '全部',
                      selected: _category.isEmpty,
                      onTap: () => setState(() => _category = ''),
                    );
                  }
                  final cat = categories[i - 1];
                  return _CategoryChip(
                    label: cat.count > 0
                        ? '${cat.label} ${cat.count}'
                        : cat.label,
                    selected: _category == cat.key,
                    onTap: () => setState(() => _category = cat.key),
                  );
                },
              ),
            ),
          const SizedBox(height: 4),
          Expanded(child: _listBody()),
          // footer
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(context),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: AppColors.line),
                        foregroundColor: AppColors.muted,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      child: const Text('取消'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: ElevatedButton(
                      onPressed: _selectedId == null
                          ? null
                          : () => Navigator.pop(context, _selectedId),
                      style: ElevatedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        disabledBackgroundColor: AppColors.line,
                        disabledForegroundColor: AppColors.faint,
                      ),
                      child: const Text('使用所选'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _listBody() {
    if (_loading && _index == null) {
      return const Center(
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: AppColors.accent,
        ),
      );
    }
    if (_error != null && _index == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '加载失败：$_error',
              style: const TextStyle(color: AppColors.danger, fontSize: 13),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _load(forceRefresh: true),
              child: const Text(
                '重试',
                style: TextStyle(color: AppColors.accent),
              ),
            ),
          ],
        ),
      );
    }
    final items = _filtered;
    if (items.isEmpty) {
      return const Center(
        child: Text(
          '没有匹配的模板',
          style: TextStyle(color: AppColors.faint, fontSize: 13),
        ),
      );
    }

    // When no category filter and no search query is active, show a
    // "⭐ 推荐" (featured) section at the top — matching the web dropdown
    // which renders featured presets in a dedicated optgroup first.
    final featured = (_category.isEmpty && _query.isEmpty)
        ? (_index?.featuredPresets ?? const <AgentPreset>[])
        : const <AgentPreset>[];
    final featuredIds = featured.map((p) => p.id).toSet();
    final rest = items.where((p) => !featuredIds.contains(p.id)).toList();

    if (featured.isEmpty) {
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        itemCount: rest.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (_, i) {
          final p = rest[i];
          return _PresetCard(
            preset: p,
            selected: _selectedId == p.id,
            onTap: () => setState(() => _selectedId = p.id),
          );
        },
      );
    }

    // Featured section + remaining items
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      itemCount: featured.length + (rest.isEmpty ? 0 : 1) + rest.length,
      itemBuilder: (_, i) {
        if (i < featured.length) {
          final p = featured[i];
          return Padding(
            padding: EdgeInsets.only(bottom: i == featured.length - 1 ? 0 : 8),
            child: _PresetCard(
              preset: p,
              selected: _selectedId == p.id,
              onTap: () => setState(() => _selectedId = p.id),
              featured: true,
            ),
          );
        }
        final adj = i - featured.length;
        if (adj == 0) {
          return const Padding(
            padding: EdgeInsets.only(top: 10, bottom: 8),
            child: Text(
              '全部模板',
              style: TextStyle(
                color: AppColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          );
        }
        final p = rest[adj - 1];
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _PresetCard(
            preset: p,
            selected: _selectedId == p.id,
            onTap: () => setState(() => _selectedId = p.id),
          ),
        );
      },
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _CategoryChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            decoration: BoxDecoration(
              color: selected
                  ? AppColors.accent.withValues(alpha: 0.16)
                  : AppColors.panel2,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: selected ? AppColors.accent : AppColors.line,
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                color: selected ? AppColors.accent : AppColors.muted,
                fontSize: 12,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// A selectable preset card: left color bar, emoji + bold name, 2-line clamped
// description, and a category tag. Selected state shows an accent border + check.
class _PresetCard extends StatelessWidget {
  final AgentPreset preset;
  final bool selected;
  final VoidCallback onTap;
  final bool featured;
  const _PresetCard({
    required this.preset,
    required this.selected,
    required this.onTap,
    this.featured = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = preset.accentColor;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          decoration: BoxDecoration(
            color: featured
                ? AppColors.accent.withValues(alpha: 0.06)
                : AppColors.panel2,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: selected
                  ? AppColors.accent
                  : (featured
                        ? AppColors.accent.withValues(alpha: 0.3)
                        : AppColors.line),
              width: selected ? 1.5 : 1,
            ),
          ),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // left color bar
                Container(
                  width: 4,
                  decoration: BoxDecoration(
                    color: c,
                    borderRadius: const BorderRadius.horizontal(
                      left: Radius.circular(11),
                    ),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (featured) ...[
                              const Text('⭐', style: TextStyle(fontSize: 14)),
                              const SizedBox(width: 4),
                            ],
                            if (preset.emoji.isNotEmpty) ...[
                              Text(
                                preset.emoji,
                                style: const TextStyle(fontSize: 16),
                              ),
                              const SizedBox(width: 8),
                            ],
                            Expanded(
                              child: Text(
                                preset.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  color: AppColors.textBright,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            if (selected)
                              const Icon(
                                Icons.check_circle,
                                color: AppColors.accent,
                                size: 18,
                              ),
                          ],
                        ),
                        if (preset.description.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            preset.description,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.muted,
                              fontSize: 12,
                              height: 1.35,
                            ),
                          ),
                        ],
                        if (preset.category.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 3,
                            ),
                            decoration: BoxDecoration(
                              color: c.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              preset.category,
                              style: TextStyle(
                                color: c,
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
