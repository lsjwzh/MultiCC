part of 'run_config_sheet.dart';

/// 「自动挑选」那半张面板。与固定一条共用同一份 state（这个文件是
/// run_config_sheet.dart 的 part，所以能直接读私有成员）。
mixin RunConfigAutoSection on RunConfigSheetBase {
  @override
  List<Widget> buildAutoSection() {
    return [
      _autoPickOrderRow(),
      const SizedBox(height: 8),
      Text(
        _order == RunPickOrder.order
            ? '依次尝试线路，不可用时自动换下一条。'
            : 'Jev 判断每条消息的难度，再选择合适的线路。',
        style: const TextStyle(
          color: AppColors.muted,
          fontSize: 12,
          height: 1.5,
        ),
      ),
      if (_order == RunPickOrder.difficulty) ..._autoDifficultyExtras(),
      const SizedBox(height: 14),
      const Text(
        '线路池',
        style: TextStyle(
          color: AppColors.text,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 6),
      ..._autoRows(),
      _autoAddLine(),
      _autoMoreToggle(),
      if (_autoMore) ..._autoMoreSection(),
      const SizedBox(height: 6),
    ];
  }

  // ── 怎么挑 ────────────────────────────────────────────────────────────

  Widget _autoPickOrderRow() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '怎么挑',
          style: TextStyle(color: AppColors.faint, fontSize: 12),
        ),
        const SizedBox(height: 5),
        Row(
          children: [
            Expanded(
              child: _autoRadio(
                key: const ValueKey('run-order-order'),
                label: '按顺序',
                detail: '依次尝试池子里的线路，前一条不行才轮到下一条',
                selected: _order == RunPickOrder.order,
                onTap: () => setState(() {
                  _order = RunPickOrder.order;
                  _autoError = '';
                }),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _autoRadio(
                key: const ValueKey('run-order-difficulty'),
                label: '按难度',
                detail: '每条消息先判难度，再挑对应档位的线路',
                selected: _order == RunPickOrder.difficulty,
                onTap: () => setState(() {
                  _order = RunPickOrder.difficulty;
                  _autoError = '';
                }),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _autoRadio({
    required Key key,
    required String label,
    required String detail,
    required bool selected,
    required VoidCallback onTap,
  }) => Tooltip(
    message: detail,
    child: _segmentedButton(
      key: key,
      label: label,
      selected: selected,
      onTap: onTap,
    ),
  );

  List<Widget> _autoDifficultyExtras() {
    return [
      const SizedBox(height: 12),

      const Text('档位', style: TextStyle(color: AppColors.faint, fontSize: 12)),
      const SizedBox(height: 5),
      Row(
        children: [
          Expanded(
            child: _autoRadio(
              key: const ValueKey('run-tiering-jev'),
              label: '交给 Jev',
              detail: 'Jev 看每条消息的难度挑线路和模型，线路不用标注',
              selected: _tiering == RunTiering.jev,
              onTap: () => setState(() {
                _tiering = RunTiering.jev;
                _autoError = '';
              }),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: _autoRadio(
              key: const ValueKey('run-tiering-manual'),
              label: '我自己标',
              detail: '每条线路标 简单 / 中等 / 复杂',
              selected: _tiering == RunTiering.manual,
              onTap: () => setState(() {
                _tiering = RunTiering.manual;
                _autoError = '';
              }),
            ),
          ),
        ],
      ),
      const SizedBox(height: 8),
      Text(
        _tiering == RunTiering.jev ? '线路和模型交给 Jev，无需手动标档。' : '为每条线路标注简单、中等或复杂。',
        style: const TextStyle(
          color: AppColors.muted,
          fontSize: 12,
          height: 1.5,
        ),
      ),
      const SizedBox(height: 10),
      _jevRow(),
    ];
  }

  Widget _jevRow() {
    final ready = _rowPoolsReady;
    return Container(
      key: const ValueKey('run-jev-status'),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: ready ? const Color(0xFFf4f8fd) : const Color(0xFFfff6e8),
        border: Border.all(
          color: ready ? const Color(0xFFdce6f1) : const Color(0xFFf0c98a),
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        ready
            ? 'Jev（判断消息难度的小模型）已就绪 · 更换'
            : '先配置 Jev（判断消息难度的小模型，网关 / key 在 Air 的自动挑选里设置）',
        style: TextStyle(
          color: ready ? AppColors.muted : const Color(0xFFa85a25),
          fontSize: 11.5,
          height: 1.35,
        ),
      ),
    );
  }

  /// Jev 的就绪状态：池子里原本带着 routing 块（说明配过网关）就算就绪。
  bool get _rowPoolsReady => _seededRouting != null;

  // ── 线路池 ────────────────────────────────────────────────────────────

  List<Widget> _autoRows() {
    if (_rows.isEmpty) {
      return [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 10),
          child: Text(
            '池子还是空的，先添加线路',
            style: TextStyle(color: AppColors.muted, fontSize: 12),
          ),
        ),
      ];
    }
    final out = <Widget>[];
    for (var index = 0; index < _rows.length; index += 1) {
      out.add(_autoRow(index));
    }
    return out;
  }

  Widget _autoRow(int index) {
    final row = _rows[index];
    final hasProblem = row.problem != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        key: Key('run-pool-row-${row.id}'),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: hasProblem ? const Color(0xFFFFF6E8) : const Color(0xFFf4f8fd),
          border: Border.all(
            color: hasProblem
                ? const Color(0xFFF0C98A)
                : const Color(0xFFdce6f1),
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _laneChip(row),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    _autoRowName(row),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                _rowIcon(
                  icon: Icons.keyboard_arrow_up_rounded,
                  tooltip: '上移',
                  onTap: index == 0
                      ? null
                      : () => setState(() {
                          final moved = _rows.removeAt(index);
                          _rows.insert(index - 1, moved);
                        }),
                ),
                _rowIcon(
                  icon: Icons.keyboard_arrow_down_rounded,
                  tooltip: '下移',
                  onTap: index == _rows.length - 1
                      ? null
                      : () => setState(() {
                          final moved = _rows.removeAt(index);
                          _rows.insert(index + 1, moved);
                        }),
                ),
                _rowIcon(
                  icon: Icons.close_rounded,
                  tooltip: '移出池子',
                  onTap: () => setState(() => _rows.removeAt(index)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            _rowModelPicker(index),
            // 「我自己标」才有一行 简单/中等/复杂；「交给 Jev」的档位由价格表算，
            // 面板上不标（标了也会被服务端当成两者同时存在拒掉）。
            if (_tiering == RunTiering.manual) ...[
              const SizedBox(height: 6),
              _rowTierPicker(row),
            ],
            if (hasProblem) ...[
              const SizedBox(height: 4),
              Text(
                '⚠ ${row.problem}',
                key: Key('run-pool-row-problem-${row.id}'),
                style: const TextStyle(
                  color: Color(0xFFa85a25),
                  fontSize: 11,
                  height: 1.35,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _autoRowName(RunPoolRow row) {
    if (isOpenCodeNativeProvider(row.providerId)) {
      final native = openCodeNativeProviderOf(row.providerId);
      for (final p in _poolFor(row.lane)) {
        if (p['id'] == row.providerId) return p['name']?.toString() ?? native;
      }
      return openCodeNativeProviderDisplayName(native);
    }
    return runLineName(row.providerId, _poolFor(row.lane));
  }

  Widget _rowIcon({
    required IconData icon,
    required String tooltip,
    required VoidCallback? onTap,
  }) {
    return IconButton(
      onPressed: onTap,
      tooltip: tooltip,
      icon: Icon(icon, size: 16),
      color: AppColors.muted,
      disabledColor: AppColors.faint.withValues(alpha: 0.4),
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
      splashRadius: 14,
    );
  }

  /// 行首那颗车道 chip：点开是这个行能挂到的车道菜单，跑不了的车道灰着并说明理由。
  Widget _laneChip(RunPoolRow row) {
    return PopupMenuButton<String>(
      key: Key('run-pool-lane-${row.id}'),
      tooltip: '换车道',
      color: AppColors.panel,
      onSelected: (lane) => setState(() {
        row.lane = lane;
        _autoError = '';
      }),
      itemBuilder: (context) {
        final lanes = _compatibleLanes(row);
        return [
          for (final lane in kAutoLanes)
            PopupMenuItem<String>(
              value: lane,
              enabled: lanes.contains(lane) && lane != row.lane,
              child: Row(
                children: [
                  Text(
                    cliChoiceLabel(lane),
                    style: TextStyle(
                      color: lanes.contains(lane)
                          ? AppColors.text
                          : AppColors.faint,
                      fontSize: 12.5,
                    ),
                  ),
                  // 跑不了的说为什么；跑得了但这条车道要自带端点（zcode / kimi），
                  // 也把「需要 baseUrl + token」摆出来 —— 那不是拦路石，是提醒。
                  if (_laneHint(lane, lanes.contains(lane)).isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _laneHint(lane, lanes.contains(lane)),
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 10.5,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ];
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
          color: cliBrandColor(
            tryParseCli(row.lane) ?? widget.cli,
          ).withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          cliChoiceLabel(row.lane),
          style: TextStyle(
            color: cliBrandColor(tryParseCli(row.lane) ?? widget.cli),
            fontSize: 10,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }

  /// 这条线路能挂到的车道。协议从任一已加载的池里读；读不到（还没取过）就按
  /// 原生/未知处理 —— OpenCode 原生只有 opencode，未知协议只有 opencode。
  List<String> _compatibleLanes(RunPoolRow row) {
    if (isOpenCodeNativeProvider(row.providerId)) return const ['opencode'];
    for (final lane in {row.lane, ...kAutoLanes}) {
      final provider = _providerMap(lane, row.providerId);
      if (provider != null) return lanesForLine(provider);
    }
    return lanesForLine({'id': row.providerId});
  }

  String _laneBlockReason(String lane) {
    if (kLaneNeedsEndpoint.contains(lane)) return '需要 baseUrl + token';
    if (!_available(tryParseCli(lane) ?? widget.cli)) return '未安装';
    return '协议不兼容';
  }

  /// 车道菜单里那一行小字：跑不了的说为什么；跑得了但要自带端点（zcode / kimi）
  /// 的也提醒一句，剩下的空着。
  String _laneHint(String lane, bool compatible) {
    if (!compatible) return _laneBlockReason(lane);
    return kLaneNeedsEndpoint.contains(lane) ? '需要 baseUrl + token' : '';
  }

  Widget _rowModelPicker(int index) {
    final row = _rows[index];
    final cli = tryParseCli(row.lane) ?? widget.cli;
    final choices = runModelChoices(
      cli,
      row.providerId,
      _poolFor(row.lane),
    ).where((m) => m.trim().isNotEmpty).toList();
    final autoAllowed = _order == RunPickOrder.difficulty;
    final value = row.autoModel
        ? '__auto__'
        : (choices.contains(row.model)
              ? row.model
              : (row.model.isEmpty ? '' : '__custom__'));
    return DropdownButtonFormField<String>(
      key: Key('run-pool-model-${row.id}'),
      value: value,
      isExpanded: true,
      dropdownColor: AppColors.panel,
      decoration: runConfigInputDecoration(),
      style: Theme.of(
        context,
      ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 12.5),
      items: [
        const DropdownMenuItem(value: '', child: Text('线路默认')),
        if (autoAllowed)
          const DropdownMenuItem(value: '__auto__', child: Text('自动（Jev 挑）')),
        ...choices.map(
          (m) => DropdownMenuItem(
            value: m,
            child: Text(
              runModelOptionLabel(cli, row.providerId, m, _poolFor(row.lane)),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
        DropdownMenuItem(
          value: '__custom__',
          child: Text(
            row.model.isNotEmpty &&
                    !choices.contains(row.model) &&
                    !row.autoModel
                ? '自定义…（${row.model}）'
                : '自定义…',
          ),
        ),
      ],
      onChanged: (v) => setState(() {
        row.autoModel = v == '__auto__';
        if (v == '__auto__') {
          row.model = '';
        } else if (v == '__custom__') {
          row.model = row.model.isEmpty ? '' : row.model;
        } else {
          row.model = v ?? '';
        }
      }),
    );
  }

  /// 「我自己标」：一行一条线路的档位。空档（没点过）会按模型名猜一次，这里
  /// 点过就固定下来（web 的 dataset.rung vs dataset.value）。
  Widget _rowTierPicker(RunPoolRow row) {
    const labels = ['简单', '中等', '复杂'];
    return Row(
      children: [
        for (var i = 0; i < labels.length; i += 1) ...[
          if (i > 0) const SizedBox(width: 6),
          Expanded(
            child: _segmentedButton(
              key: Key('run-pool-tier-${row.id}-${i + 1}'),
              label: labels[i],
              selected: row.markedTier == i + 1,
              onTap: () => setState(() {
                row.markedTier = i + 1;
                _autoError = '';
              }),
            ),
          ),
        ],
      ],
    );
  }

  // ── 添加线路 ──────────────────────────────────────────────────────────

  Widget _autoAddLine() {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        key: const ValueKey('run-add-line'),
        onPressed: _openAddLine,
        icon: const Icon(Icons.add_rounded, size: 16),
        label: const Text('添加线路'),
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    );
  }

  Future<void> _openAddLine() async {
    final picked = await showModalBottomSheet<RunPoolRow>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) =>
          _AddLineSheet(pool: _pool, rows: _rows, available: _available),
    );
    if (picked == null || !mounted) return;
    setState(() => _rows.add(picked));
  }

  // ── 更多 ──────────────────────────────────────────────────────────────

  Widget _autoMoreToggle() {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        key: const ValueKey('run-auto-more-toggle'),
        onPressed: () => setState(() => _autoMore = !_autoMore),
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          minimumSize: const Size(0, 32),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: Text(
          '${_autoMore ? '▾' : '▸'} 更多',
          style: const TextStyle(color: AppColors.muted, fontSize: 12),
        ),
      ),
    );
  }

  List<Widget> _autoMoreSection() {
    final usable = _rows.where((row) => row.sendable).length;
    final ceiling = usable.clamp(2, kAutoMaxAttempts);
    final attempts = _maxAttempts.clamp(2, ceiling);
    return [
      const SizedBox(height: 4),
      Text(
        '最多尝试几条（${2}–$ceiling）',
        style: const TextStyle(color: AppColors.faint, fontSize: 12),
      ),
      const SizedBox(height: 5),
      Row(
        children: [
          for (var n = 2; n <= ceiling; n += 1) ...[
            if (n > 2) const SizedBox(width: 6),
            Expanded(
              child: _segmentedButton(
                key: Key('run-max-attempts-$n'),
                label: '$n',
                selected: n == attempts,
                onTap: () => setState(() => _maxAttempts = n),
              ),
            ),
          ],
        ],
      ),
      const SizedBox(height: 8),
      SwitchListTile(
        key: const ValueKey('run-sticky'),
        value: _sticky,
        contentPadding: EdgeInsets.zero,
        title: const Text(
          '粘住上一次成功的线路',
          style: TextStyle(color: AppColors.text, fontSize: 13),
        ),
        onChanged: (value) => setState(() => _sticky = value),
      ),
      SwitchListTile(
        key: const ValueKey('run-cross-trust'),
        value: _allowCrossTrust,
        contentPadding: EdgeInsets.zero,
        title: const Text(
          '允许官方与自建线路互相兜底',
          style: TextStyle(color: AppColors.text, fontSize: 13),
        ),
        subtitle: const Text(
          '混用官方登录和用户自建线路时需要确认',
          style: TextStyle(color: AppColors.muted, fontSize: 11),
        ),
        onChanged: (value) => setState(() => _allowCrossTrust = value),
      ),
    ];
  }
}

/// 「添加线路」选择器：可搜索、按 CLI 分组、只列能用的组合；已在池里的标 ✓ 且
/// 不可选。OpenCode 那一组只列它自己的原生线路 —— 别的协议它也能跑，但整份再抄
/// 一遍只是噪音，用一句说明带过。
class _AddLineSheet extends StatefulWidget {
  const _AddLineSheet({
    required this.pool,
    required this.rows,
    required this.available,
  });

  final RunPoolService pool;
  final List<RunPoolRow> rows;
  final bool Function(SessionCli) available;

  @override
  State<_AddLineSheet> createState() => _AddLineSheetState();
}

class _AddLineSheetState extends State<_AddLineSheet> {
  final Map<String, List<Map<String, dynamic>>?> _pools = {};
  final Set<String> _failed = {};
  bool _loading = true;
  bool _allFailed = false;
  String _query = '';

  List<String> get _lanes => kAutoLanes.where((lane) {
    final cli = tryParseCli(lane);
    if (cli == null) return false;
    return cli.supportsProvider && widget.available(cli);
  }).toList();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _allFailed = false;
      _failed.clear();
    });
    final lanes = _lanes;
    final results = await Future.wait([
      for (final lane in lanes) widget.pool.forCli(lane),
    ]);
    if (!mounted) return;
    var ok = 0;
    for (var i = 0; i < lanes.length; i += 1) {
      final result = results[i];
      if (result == null) {
        _failed.add(lanes[i]);
      } else {
        _pools[lanes[i]] = result;
        ok += 1;
      }
    }
    setState(() {
      _loading = false;
      _allFailed = ok == 0 && _failed.isNotEmpty;
    });
  }

  @override
  Widget build(BuildContext context) {
    final keyboardInset = MediaQuery.viewInsetsOf(context).bottom;
    final maxHeight = (MediaQuery.sizeOf(context).height - keyboardInset) * 0.9;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: keyboardInset),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxHeight),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  '添加线路',
                  style: TextStyle(
                    color: AppColors.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const ValueKey('run-add-line-search'),
                  onChanged: (value) => setState(() => _query = value.trim()),
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: AppColors.text,
                    fontSize: 13,
                  ),
                  decoration: runConfigInputDecoration(hint: '搜索线路'),
                ),
                const SizedBox(height: 10),
                Flexible(
                  child: ListView(
                    key: const ValueKey('run-add-line-list'),
                    shrinkWrap: true,
                    children: [
                      if (_loading)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else if (_allFailed)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          child: Row(
                            children: [
                              const Expanded(
                                child: Text(
                                  '线路列表加载失败',
                                  style: TextStyle(
                                    color: AppColors.danger,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                              TextButton(
                                key: const ValueKey('run-add-line-retry'),
                                onPressed: _load,
                                child: const Text('重试'),
                              ),
                            ],
                          ),
                        )
                      else
                        ..._grouped(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _grouped() {
    final out = <Widget>[];
    final inPool = {
      for (final row in widget.rows) '${row.lane}\n${row.providerId}',
    };
    var groups = 0;
    for (final lane in _lanes) {
      final pool = _pools[lane];
      if (pool == null) continue;
      final nativeOnly = lane == 'opencode';
      final entries = pool.where((provider) {
        if (nativeOnly && provider['nativeOpenCode'] != true) return false;
        if (_query.isEmpty) return true;
        final name = (provider['name'] ?? provider['id'] ?? '').toString();
        return name.toLowerCase().contains(_query.toLowerCase());
      }).toList();
      if (entries.isEmpty) continue;
      // 分隔产品分组，让线路归属清晰可见。
      if (groups > 0) {
        out.add(
          const Divider(height: 13, thickness: 1, color: Color(0xFFe6eef7)),
        );
      }
      groups += 1;
      out.add(
        Padding(
          padding: const EdgeInsets.only(top: 10, bottom: 4),
          child: Row(
            children: [
              Text(
                cliChoiceLabel(lane),
                style: TextStyle(
                  color: cliBrandColor(tryParseCli(lane) ?? SessionCli.claude),
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (nativeOnly) ...[
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    '这里只列 OpenCode 自己的线路；上面的线路也都能跑',
                    style: TextStyle(color: AppColors.faint, fontSize: 10.5),
                  ),
                ),
              ],
            ],
          ),
        ),
      );
      for (final provider in entries) {
        final id = provider['id']?.toString() ?? '';
        if (id.isEmpty) continue;
        final already = inPool.contains('$lane\n$id');
        out.add(
          ListTile(
            key: Key('run-add-line-$lane-$id'),
            dense: true,
            contentPadding: EdgeInsets.zero,
            title: Text(
              (provider['name'] ?? id).toString(),
              style: TextStyle(
                color: already ? AppColors.faint : AppColors.text,
                fontSize: 13,
              ),
            ),
            trailing: already
                ? const Text(
                    '✓ 已在池里',
                    style: TextStyle(color: AppColors.muted, fontSize: 11),
                  )
                : null,
            onTap: already
                ? null
                : () => Navigator.pop(
                    context,
                    RunPoolRow(lane: lane, providerId: id),
                  ),
          ),
        );
      }
    }
    if (out.isEmpty) {
      out.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Text(
            '没有可用线路',
            style: TextStyle(color: AppColors.muted, fontSize: 12),
          ),
        ),
      );
    }
    return out;
  }
}
