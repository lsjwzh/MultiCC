import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../../utils/status_presentation.dart';
import 'air_role_editor.dart';
import 'air_task_config.dart';
import 'air_task_status.dart';

/// 目录库（Web `#directory-library`）：一张目录一张卡，卡上写清它现在有多少
/// 任务、有没有人在跑。手机上一列，宽屏两列。
class AirDirectoryLibrary extends StatefulWidget {
  const AirDirectoryLibrary({
    super.key,
    required this.directories,
    required this.currentDirectoryId,
    required this.tasksOf,
    required this.runningDirectories,
    required this.favorites,
    required this.onOpen,
    required this.onAddDirectory,
    required this.onToggleFavorite,
  });

  final List<AirDirectory> directories;
  final String? currentDirectoryId;
  final List<AirTask> Function(String dirId) tasksOf;

  /// 有任务正在执行的目录 id —— 卡片上那圈运行环用它。
  final Set<String> runningDirectories;
  final List<String> favorites;
  final ValueChanged<String> onOpen;
  final VoidCallback onAddDirectory;
  final ValueChanged<String> onToggleFavorite;

  @override
  State<AirDirectoryLibrary> createState() => _AirDirectoryLibraryState();
}

class _AirDirectoryLibraryState extends State<AirDirectoryLibrary> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final query = _query.trim().toLowerCase();
    final rows = widget.directories
        .where(
          (d) => query.isEmpty
              ? true
              : '${d.name} ${d.path}'.toLowerCase().contains(query),
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  key: const ValueKey('air-directory-search'),
                  onChanged: (v) => setState(() => _query = v),
                  style: const TextStyle(color: AppColors.text),
                  decoration: InputDecoration(
                    hintText: '搜索名称或路径',
                    prefixIcon: const Icon(Icons.search, size: 19),
                    isDense: true,
                    filled: true,
                    fillColor: AppColors.panel,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    border: OutlineInputBorder(
                      borderSide: BorderSide.none,
                      borderRadius: BorderRadius.circular(AppColors.radiusCard),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton.icon(
                key: const ValueKey('air-add-directory'),
                onPressed: widget.onAddDirectory,
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('添加'),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.accentDark,
                  minimumSize: const Size(0, 46),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppColors.radiusButton),
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final columns = constraints.maxWidth >= 700 ? 2 : 1;
              if (rows.isEmpty) {
                return Center(
                  child: Text(
                    _query.isEmpty ? '还没有工作目录。' : '没有匹配的工作目录。',
                    style: const TextStyle(color: AppColors.faint),
                  ),
                );
              }
              return GridView.builder(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: columns,
                  mainAxisExtent: 92,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                ),
                itemCount: rows.length,
                itemBuilder: (context, index) => _DirectoryCard(
                  directory: rows[index],
                  tasks: widget.tasksOf(rows[index].id),
                  running: widget.runningDirectories.contains(rows[index].id),
                  favorite: widget.favorites.contains(rows[index].id),
                  current: rows[index].id == widget.currentDirectoryId,
                  onOpen: () => widget.onOpen(rows[index].id),
                  onToggleFavorite: () =>
                      widget.onToggleFavorite(rows[index].id),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _DirectoryCard extends StatelessWidget {
  const _DirectoryCard({
    required this.directory,
    required this.tasks,
    required this.running,
    required this.favorite,
    required this.current,
    required this.onOpen,
    required this.onToggleFavorite,
  });

  final AirDirectory directory;
  final List<AirTask> tasks;
  final bool running;
  final bool favorite;
  final bool current;
  final VoidCallback onOpen;
  final VoidCallback onToggleFavorite;

  @override
  Widget build(BuildContext context) {
    final active = tasks.where((t) => !t.closed).length;
    return Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-directory-${directory.id}'),
        onTap: onOpen,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(
              color: current ? AppColors.accent : AppColors.line,
              width: current ? 1.4 : 1,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Row(
                      children: [
                        if (running) ...[
                          Container(
                            width: 7,
                            height: 7,
                            margin: const EdgeInsets.only(right: 6),
                            decoration: const BoxDecoration(
                              color: AppColors.success,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ],
                        Flexible(
                          child: Text(
                            directory.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      directory.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '${tasks.length} 个任务 · $active 个未完成'
                      '${favorite ? ' · 已收藏' : ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 11.5,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                onPressed: onToggleFavorite,
                iconSize: 18,
                visualDensity: VisualDensity.compact,
                tooltip: favorite ? '取消收藏' : '收藏',
                icon: Icon(
                  favorite ? Icons.star_rounded : Icons.star_border_rounded,
                  color: favorite ? AppColors.accent : AppColors.faint,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 任务行。徽标说的是「这个任务现在算什么」（生命周期 + 这一轮的 runState），
/// 副行说的是「它在哪个目录、走到哪一步、卡在哪」—— 与 Web Air 的 `taskRow`
/// 同一套分工、同一个形状：徽标在左，标题与副行在中间，时间在右。
///
/// 侧栏、当前目录、控制台都用这一行。Web 那边同样只有一份 `taskRow`：行长得
/// 不一样的地方，状态就会各说各话。
class AirTaskTile extends StatelessWidget {
  const AirTaskTile({
    super.key,
    required this.task,
    required this.onTap,
    this.directoryName = '',
    this.showTime = false,
    this.trailing,
    this.selected = false,
  });

  final AirTask task;
  final VoidCallback onTap;

  /// 跨目录的列表（控制台、侧栏）要把「它在哪个目录」写在行上；当前目录的
  /// 列表里这句话是废话，留空即可（同 Web 的 `options.dir === false`）。
  final String directoryName;

  /// 行尾时间。控制台按更新时间排序，时间本身就是排序依据，要看得见。
  final bool showTime;
  final Widget? trailing;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final detail = airTaskDetail(task);
    final subtitle = [
      if (directoryName.isNotEmpty) directoryName,
      if (detail.isNotEmpty) detail,
      if (task.readOnly) '只读记录',
    ].join(' · ');
    final time = showTime ? airTaskTime(task.updatedAt) : '';
    return Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-task-${task.id}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(
              color: selected ? AppColors.accent : AppColors.line,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
          child: Row(
            children: [
              StatusBadge(
                domain: StatusDomain.task,
                status: airTaskStatus(task),
                fontSize: 10.5,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      task.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    if (subtitle.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11.5,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (time.isNotEmpty) ...[
                const SizedBox(width: 8),
                Text(
                  time,
                  style: const TextStyle(
                    color: AppColors.faint,
                    fontSize: 10.5,
                  ),
                ),
              ],
              trailing ?? const SizedBox(width: 4),
            ],
          ),
        ),
      ),
    );
  }
}

class AirStatusBadge extends StatelessWidget {
  const AirStatusBadge({super.key, required this.text, this.closed = false});

  final String text;
  final bool closed;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    final color = closed ? AppColors.faint : AppColors.blue;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// 当前目录那一块统计。三个数字都用同一份判定：「执行中」只认注册表的
/// spinner，「待回答」只认 canonical 的 waiting —— 从前这里是按 `lease` 和
/// `status` 各猜一遍，于是同一条任务在这条统计里和在行上的徽标里能显示成两回事。
class AirDirectoryStats extends StatelessWidget {
  const AirDirectoryStats({super.key, required this.tasks});

  final List<AirTask> tasks;

  @override
  Widget build(BuildContext context) {
    final open = tasks.where((t) => !t.closed).length;
    final running = tasks.where(airTaskRunning).length;
    final waiting = tasks
        .where((t) => airTaskStatus(t) == CanonicalStatus.waiting)
        .length;
    return Row(
      children: [
        Expanded(child: _StatTile(label: '任务', value: '${tasks.length}')),
        const SizedBox(width: 10),
        Expanded(child: _StatTile(label: '未完成', value: '$open')),
        const SizedBox(width: 10),
        Expanded(child: _StatTile(label: '执行中', value: '$running')),
        const SizedBox(width: 10),
        Expanded(child: _StatTile(label: '待回答', value: '$waiting')),
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      border: Border.all(color: AppColors.line),
    ),
    child: Column(
      children: [
        Text(
          value,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 19,
            fontWeight: FontWeight.w700,
          ),
        ),
        Text(
          label,
          style: const TextStyle(color: AppColors.faint, fontSize: 11),
        ),
      ],
    ),
  );
}

/// 目录空态里的「描述任务 → 创建并执行」。跟 Web `#quick-task-form` 一样：这段
/// 文字既是任务名也是要执行的第一条消息，所以建完就直接进去，不再问一遍。
class AirQuickComposer extends StatefulWidget {
  const AirQuickComposer({
    super.key,
    required this.settings,
    required this.clis,
    required this.busy,
    required this.onSubmit,
    this.service,
    this.httpClient,
  });

  /// 角色库（`/api/agent-presets`）要走服务地址和令牌，角色编辑器需要它。
  final SettingsService settings;
  final List<String> clis;
  final bool busy;
  final AirService? service;

  /// 线路面板要先拉这个 CLI 的 Provider 池。宿主已经有客户端的就传进来，
  /// 测试拿它桩掉整条线。
  final http.Client? httpClient;

  /// 返回「这一份草稿确实建出去了吗」。建成了才清空输入框和角色 —— 失败时留着，
  /// 重试就是原样再点一次（同 Web Air 只在成功后清）。
  final Future<bool> Function({
    required String text,
    required String cli,
    required AirTaskRuntime runtime,
    required List<AirRoleBinding> roles,
    required bool goal,
  })
  onSubmit;

  @override
  State<AirQuickComposer> createState() => _AirQuickComposerState();
}

class _AirQuickComposerState extends State<AirQuickComposer> {
  final _controller = TextEditingController();
  String _cli = '';
  // 这里存的是「还没有任务的那一份角色」和「还没有任务的那一条线路」，创建时
  // 随任务一起写下去；建完就清空 —— 一个任务的上下文不该悄悄漏进下一个任务
  // （同 Web Air 的 quickRoles / quickRuntime）。
  List<AirRoleBinding> _roles = const [];
  AirTaskRuntime _runtime = const AirTaskRuntime();
  bool _goal = false;

  @override
  void initState() {
    super.initState();
    _cli = widget.clis.isEmpty ? 'claude' : widget.clis.first;
    _runtime = AirTaskRuntime(cli: _cli);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _pickCli() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppColors.radiusPanel),
        ),
      ),
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 18, 20, 6),
              child: Text(
                'AI 工具',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            for (final cli in widget.clis)
              ListTile(
                title: Text(cli, style: const TextStyle(color: AppColors.text)),
                trailing: cli == _cli
                    ? const Icon(Icons.check_rounded, color: AppColors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, cli),
              ),
          ],
        ),
      ),
    );
    if (choice != null && mounted) {
      setState(() {
        _cli = choice;
        // 换 CLI 等于换了一整池 Provider 和模型，旧的线路不能带过去。
        _runtime = _runtime.withCli(choice);
      });
    }
  }

  /// 给新任务挑线路、模型和推理强度。结果先留在这一层，等创建任务时随
  /// `POST /api/air/tasks` 一起写下去 —— 第一条消息就按它执行（同 Web Air）。
  Future<void> _editRuntime() async {
    final picked = await showAirTaskRuntimeEditor(
      context,
      settings: widget.settings,
      httpClient: widget.httpClient,
      initial: _runtime,
    );
    if (picked != null && mounted) setState(() => _runtime = picked);
  }

  /// 任务还不存在，所以走编辑器的草稿模式：编辑结果先留在这一层，等创建流程
  /// 建出任务、发第一条消息之前再写下去 —— 绑定说的是「下一条消息」，那条消息
  /// 正是紧接着要发的那条。
  Future<void> _editRoles() async {
    final edited = await showAirRoleEditor(
      context,
      settings: widget.settings,
      service: widget.service,
      initial: _roles,
    );
    if (edited != null && mounted) setState(() => _roles = edited);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        border: Border.all(color: AppColors.line),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 三颗药丸在 320px 上挤不进一行（线路那颗本身就是一句话），所以让它
          // 换行而不是横着溢出 —— Web 那边窄屏同样靠换行排。
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _Pill(
                key: const ValueKey('air-quick-cli'),
                label: _cli.isEmpty ? 'AI 工具' : _cli,
                icon: Icons.memory_rounded,
                onTap: widget.busy ? null : _pickCli,
              ),
              _Pill(
                key: const ValueKey('air-quick-ai'),
                label: _runtime.routeLabel,
                icon: Icons.tune_rounded,
                active: _runtime.provider.isNotEmpty || _runtime.isAuto,
                onTap: widget.busy ? null : _editRuntime,
              ),
              _Pill(
                key: const ValueKey('air-quick-role'),
                label: _roles.isEmpty ? '＋ 角色' : '${_roles.length} 个角色',
                icon: Icons.badge_outlined,
                active: _roles.isNotEmpty,
                onTap: widget.busy ? null : _editRoles,
              ),
            ],
          ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('air-quick-input'),
            controller: _controller,
            maxLines: 4,
            minLines: 3,
            maxLength: 32000,
            enabled: !widget.busy,
            style: const TextStyle(color: AppColors.text, fontSize: 14.5),
            decoration: InputDecoration(
              hintText: '描述要完成的任务；创建后会把这段内容作为第一条消息执行。',
              hintStyle: const TextStyle(
                color: AppColors.faint,
                fontSize: 13.5,
              ),
              filled: true,
              fillColor: AppColors.well,
              counterText: '',
              border: OutlineInputBorder(
                borderSide: BorderSide.none,
                borderRadius: BorderRadius.circular(AppColors.radiusCard),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              // 320px 宽的手机上这一行只剩 254px：Material 3 的 chip 和按钮默认
              // 都带 24px 的横向内边距，两份默认值加起来就把这一行撑出去了。
              FilterChip(
                key: const ValueKey('air-quick-goal'),
                label: const Text('🎯 Goal'),
                selected: _goal,
                onSelected: widget.busy
                    ? null
                    : (v) => setState(() => _goal = v),
                showCheckmark: false,
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                labelPadding: const EdgeInsets.symmetric(horizontal: 2),
              ),
              const Spacer(),
              FilledButton(
                key: const ValueKey('air-quick-submit'),
                onPressed: widget.busy
                    ? null
                    : () async {
                        final text = _controller.text.trim();
                        if (text.isEmpty) return;
                        final sent = await widget.onSubmit(
                          text: text,
                          cli: _cli,
                          runtime: _runtime,
                          roles: _roles,
                          goal: _goal,
                        );
                        if (!sent || !mounted) return;
                        // 任务建出去了才清草稿；角色和线路也一起清 —— 一个任务
                        // 的上下文不该悄悄漏进下一个任务。
                        setState(() {
                          _controller.clear();
                          _roles = const [];
                          _runtime = AirTaskRuntime(cli: _cli);
                          _goal = false;
                        });
                      },
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.accentDark,
                  minimumSize: const Size(0, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppColors.radiusButton),
                  ),
                ),
                child: Text(widget.busy ? '正在创建…' : '创建并执行 ↑'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    super.key,
    required this.label,
    required this.icon,
    required this.onTap,
    this.active = false,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onTap;
  final bool active;

  @override
  Widget build(BuildContext context) => Material(
    color: active ? AppColors.blueSoft : AppColors.well,
    borderRadius: BorderRadius.circular(AppColors.radiusPill),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppColors.radiusPill),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppColors.radiusPill),
          border: Border.all(
            color: active ? AppColors.accent : AppColors.line,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: AppColors.muted),
            const SizedBox(width: 6),
            Text(
              label,
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 12.5,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
