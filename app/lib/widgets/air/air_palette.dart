import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_task_status.dart';

/// ⌘K —— 目录和任务一起搜（Web `public/air.js` 的 `#palette`）。
///
/// 找任务不该先要求你想起来它在哪个目录。Web 那边它是 ⌘K 唤起的浮层；手机上把
/// 它做成一整页搜索，两种对象的排序、条数上限、每行写什么都照搬。
class AirPaletteScreen extends StatefulWidget {
  const AirPaletteScreen({
    super.key,
    required this.directories,
    required this.recentTasks,
    required this.allTasks,
    required this.onSelectDirectory,
    required this.onOpenTask,
  });

  final List<AirDirectory> directories;

  /// 「手上的任务」：打开过的排在前面，不足的用当前目录里最新的补上（宿主算好
  /// 再传进来，同 Web 的 `recentPool()`）。
  final List<AirTask> recentTasks;
  final List<AirTask> allTasks;

  final ValueChanged<String> onSelectDirectory;
  final void Function(String dirId, String taskId) onOpenTask;

  @override
  State<AirPaletteScreen> createState() => _AirPaletteScreenState();
}

enum AirPaletteKind { directory, task }

class AirPaletteItem {
  const AirPaletteItem({
    required this.kind,
    required this.dirId,
    required this.title,
    required this.detail,
    this.taskId = '',
  });

  final AirPaletteKind kind;
  final String dirId;
  final String title;
  final String detail;

  /// 只有 [AirPaletteKind.task] 有。
  final String taskId;

  String get kindLabel => kind == AirPaletteKind.task ? '任务' : '目录';
}

/// 候选。目录在前、任务在后，各自按 Web 的上限截断：有搜索词时 6 + 8，没有时
/// 5 + 6 —— 空着手来的人要的是「最近用过的几个」，不是在长列表里挑。
List<AirPaletteItem> airPaletteCandidates(
  List<AirDirectory> directories,
  List<AirTask> recentTasks,
  List<AirTask> allTasks, {
  String query = '',
}) {
  final needle = query.trim().toLowerCase();
  bool matches(String text) => needle.isEmpty || text.toLowerCase().contains(needle);
  String nameOf(String dirId) => directories
      .where((d) => d.id == dirId)
      .map((d) => d.name)
      .firstOrNull ??
      '未知目录';

  final dirs = directories
      .where((directory) => matches('${directory.name} ${directory.path}'))
      .take(needle.isEmpty ? 5 : 6)
      .map(
        (directory) => AirPaletteItem(
          kind: AirPaletteKind.directory,
          dirId: directory.id,
          title: directory.name,
          detail: directory.path.isEmpty ? '工作目录' : directory.path,
        ),
      );

  final tasks = <AirPaletteItem>[];
  final seen = <String>{};
  for (final task in [...recentTasks, ...allTasks]) {
    final title = task.title.isEmpty ? '未命名任务' : task.title;
    if (seen.contains(task.id) || !matches(title)) continue;
    seen.add(task.id);
    tasks.add(
      AirPaletteItem(
        kind: AirPaletteKind.task,
        dirId: task.dirId,
        taskId: task.id,
        title: title,
        detail: '${nameOf(task.dirId)} · ${airTaskSpec(task).label}',
      ),
    );
    if (tasks.length >= (needle.isEmpty ? 6 : 8)) break;
  }
  return [...dirs, ...tasks];
}

/// 底栏那句话：真有两个数就说两个数，一个都没有就说这一页是干什么的。
String airPaletteNote(List<AirPaletteItem> items) {
  if (items.isEmpty) return '目录与任务一起搜';
  final directories = items
      .where((item) => item.kind == AirPaletteKind.directory)
      .length;
  return '$directories 个目录 · ${items.length - directories} 个任务';
}

class _AirPaletteScreenState extends State<AirPaletteScreen> {
  final TextEditingController _query = TextEditingController();
  final FocusNode _focus = FocusNode();
  List<AirPaletteItem> _items = const [];
  int _index = 0;

  @override
  void initState() {
    super.initState();
    _items = _candidates('');
  }

  @override
  void dispose() {
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  List<AirPaletteItem> _candidates(String query) => airPaletteCandidates(
    widget.directories,
    widget.recentTasks,
    widget.allTasks,
    query: query,
  );

  void _onQueryChanged(String value) {
    setState(() {
      _items = _candidates(value);
      // 结果换了，高亮回到第一条 —— 留着旧的下标会指到别的对象上。
      _index = 0;
    });
  }

  void _move(int step) {
    if (_items.isEmpty) return;
    setState(() {
      _index = (_index + step).clamp(0, _items.length - 1);
    });
  }

  void _choose([int? index]) {
    final item = _items.elementAtOrNull(index ?? _index);
    if (item == null) return;
    // 先收掉这一页再动作：选中一条任务是往下推一层对话页，反过来的话被 pop 掉
    // 的就是刚推上来的那一层。
    Navigator.of(context).pop();
    if (item.kind == AirPaletteKind.directory) {
      widget.onSelectDirectory(item.dirId);
    } else {
      widget.onOpenTask(item.dirId, item.taskId);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        // 带键盘的机器（平板 / 外接键盘）上，Web 那一套按键照旧可用。
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => _move(1),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => _move(-1),
        const SingleActivator(LogicalKeyboardKey.enter): _choose,
        const SingleActivator(LogicalKeyboardKey.escape): () =>
            Navigator.of(context).pop(),
      },
      child: Scaffold(
        key: const ValueKey('air-palette'),
        backgroundColor: AppColors.bg,
        appBar: AppBar(
          backgroundColor: AppColors.panel,
          foregroundColor: AppColors.text,
          elevation: 0,
          scrolledUnderElevation: 0,
          titleSpacing: 0,
          leading: IconButton(
            key: const ValueKey('air-palette-close'),
            icon: const Icon(Icons.arrow_back_rounded),
            tooltip: '关闭',
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: TextField(
            key: const ValueKey('air-palette-input'),
            controller: _query,
            focusNode: _focus,
            autofocus: true,
            textInputAction: TextInputAction.go,
            onChanged: _onQueryChanged,
            onSubmitted: (_) => _choose(),
            style: const TextStyle(color: AppColors.text, fontSize: 15),
            decoration: const InputDecoration(
              border: InputBorder.none,
              hintText: '搜索工作目录或任务，例如 storefront、登录页',
              hintStyle: TextStyle(color: AppColors.faint, fontSize: 14),
            ),
          ),
          actions: [
            if (_query.text.isNotEmpty)
              IconButton(
                key: const ValueKey('air-palette-clear'),
                icon: const Icon(Icons.close_rounded, size: 20),
                color: AppColors.muted,
                tooltip: '清空',
                onPressed: () {
                  _query.clear();
                  _onQueryChanged('');
                },
              ),
          ],
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                children: [
                  if (_items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 34),
                      child: Text(
                        '没有匹配的工作目录或任务。',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: AppColors.faint, fontSize: 13),
                      ),
                    )
                  else
                    for (final (index, item) in _items.indexed)
                      _ItemRow(
                        item: item,
                        active: index == _index,
                        onTap: () => _choose(index),
                      ),
                ],
              ),
            ),
            _Footer(items: _items),
          ],
        ),
      ),
    );
  }
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({
    required this.item,
    required this.active,
    required this.onTap,
  });

  final AirPaletteItem item;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final task = item.kind == AirPaletteKind.task;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: active ? AppColors.blueSoft : AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: InkWell(
          key: ValueKey(
            'air-palette-${item.kind.name}-${task ? item.taskId : item.dirId}',
          ),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppColors.radiusCard),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppColors.radiusCard),
              border: Border.all(
                color: active ? AppColors.accent : AppColors.line,
              ),
            ),
            child: Row(
              children: [
                Text(
                  task ? '◆' : '▣',
                  style: TextStyle(
                    color: task ? AppColors.accent : AppColors.muted,
                    fontSize: 13,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        item.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.text,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        item.detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11.5,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.panel2,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.line),
                  ),
                  child: Text(
                    item.kindLabel,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 9.5,
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

/// 底栏：一边是「搜到了几个」，一边是按键怎么用。
class _Footer extends StatelessWidget {
  const _Footer({required this.items});

  final List<AirPaletteItem> items;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('air-palette-note'),
    padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
    decoration: const BoxDecoration(
      color: AppColors.panel,
      border: Border(top: BorderSide(color: AppColors.line)),
    ),
    child: Wrap(
      spacing: 14,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          airPaletteNote(items),
          style: const TextStyle(
            color: AppColors.muted,
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        const Text(
          '↑↓ 选择 · Enter 进入 · Esc 关闭',
          style: TextStyle(color: AppColors.faint, fontSize: 10.5),
        ),
      ],
    ),
  );
}
