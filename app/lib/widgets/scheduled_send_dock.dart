import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/scheduled_send_service.dart';
import '../theme.dart';
import 'floating_dock.dart';
import 'scheduled_send_store.dart';

/// 定时发送的可见那一半（Web `chat-scheduled-send.js`）。
///
/// 两个入口共用一份 [ScheduledSendStore]：
///  • 输入栏上的 ⏱ —— 常驻，带待执行条数角标，点开底部面板（对应 Web 的
///    `#schedule-send-btn`）；
///  • 有待执行消息时才出现的悬浮球 —— 与派发 / 后台任务同一套 primitive，
///    可拖动、吸附边缘、记住位置，展开锚定面板（对应 `#schedule-send-fab`）。
/// 拖动 / 展开 / 收起的手势都归 [FloatingDock]，这里只管面板里画什么。

/// 排定时消息时要从输入框拿的东西：正文、附件路径、以及发送前的那层装饰
/// （派发提示）。面板本身不碰输入框 —— 它只拿着这个回调问一次。
class ScheduledSendDraft {
  const ScheduledSendDraft({
    required this.text,
    this.attachmentPaths = const [],
    this.decorate,
    this.clearAfterSchedule,
  });

  final String text;
  final List<String> attachmentPaths;
  final String Function(String text)? decorate;

  /// 排上队之后把输入框清干净（Web 的 `clearDraft`）。草稿归输入框所有，
  /// 所以这个动作也由它给。
  final VoidCallback? clearAfterSchedule;
}

typedef ScheduledSendDraftReader = ScheduledSendDraft Function();

/// 面板宽度：[FloatingDock] 用他算锚点，悬浮球那侧还得拿它当实际约束 ——
/// `Positioned` 只给了 left/top，不给宽，面板里的 stretch 撞上无限宽会直接抛。
/// 弹层那侧不吃这个数（底部弹层自己有边界，铺满即可）。
double schedulePanelWidth(double viewportWidth) =>
    viewportWidth > 408 ? 380.0 : viewportWidth - 28;

/// 输入栏上的 ⏱：图标 + 右上角条数角标。
///
/// 透明底、40×40，和旁边的发送/停止按钮同高；有角标时用琥珀色 —— 与 Web 的
/// `.input-action-btn .schedule-badge` 同一个位置和配色。
class ScheduledSendButton extends StatelessWidget {
  const ScheduledSendButton({
    super.key,
    required this.store,
    required this.onTap,
    this.onDraft,
  });

  final ScheduledSendStore store;
  final VoidCallback onTap;
  final ScheduledSendDraftReader? onDraft;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => Semantics(
        button: true,
        label: t('scheduleSend'),
        child: Tooltip(
          message: t('scheduleSend'),
          child: GestureDetector(
            key: const Key('schedule-send-btn'),
            onTap: onTap,
            child: SizedBox(
              width: 40,
              height: 40,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  const Icon(
                    Icons.schedule_rounded,
                    size: 20,
                    color: AppColors.muted,
                  ),
                  if (store.hasItems)
                    Positioned(
                      right: 2,
                      top: 3,
                      child: Container(
                        key: const Key('schedule-send-badge'),
                        constraints: const BoxConstraints(minWidth: 16),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFFd29922),
                          borderRadius: BorderRadius.circular(9),
                        ),
                        child: Text(
                          store.badgeText,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: Color(0xFF2b2100),
                            fontSize: 10,
                            height: 1.5,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 打开底部面板（输入栏 ⏱ 的落点）。与悬浮球展开的是同一块 [ScheduledSendPanel]。
Future<void> openScheduledSendSheet(
  BuildContext context,
  ScheduledSendStore store, {
  ScheduledSendDraftReader? onDraft,
}) {
  unawaited(store.refresh());
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(AppColors.radiusPanel),
      ),
    ),
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(sheetContext).size.height * 0.78,
        ),
        child: ScheduledSendPanel(store: store, onDraft: onDraft),
      ),
    ),
  );
}

/// 定时发送面板：多久后 + 单位 + 提交，下面是待执行列表。
///
/// [onCollapse] 非空时头部出现「收起为悬浮球」（悬浮球展开的场景）；底部弹层
/// 里没有球可收，就只留关闭。
class ScheduledSendPanel extends StatefulWidget {
  const ScheduledSendPanel({
    super.key,
    required this.store,
    this.onDraft,
    this.onCollapse,
  });

  final ScheduledSendStore store;
  final ScheduledSendDraftReader? onDraft;
  final VoidCallback? onCollapse;

  @override
  State<ScheduledSendPanel> createState() => _ScheduledSendPanelState();
}

class _ScheduledSendPanelState extends State<ScheduledSendPanel> {
  final _amount = TextEditingController(text: '10');
  final _amountFocus = FocusNode();
  String _unit = 'minutes';

  @override
  void initState() {
    super.initState();
    unawaited(widget.store.refresh());
  }

  @override
  void dispose() {
    _amount.dispose();
    _amountFocus.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final draft = widget.onDraft?.call();
    final ok = await widget.store.submit(
      amount: _amount.text,
      unit: _unit,
      typedText: draft?.text ?? '',
      attachmentPaths: draft?.attachmentPaths ?? const [],
      decorate: draft?.decorate,
    );
    if (ok && mounted) {
      // 草稿已经排上队了，清干净 —— 上一句还留在输入框里会被误当第二次发送。
      draft?.clearAfterSchedule?.call();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final store = widget.store;
        return Container(
          key: const Key('schedule-send-panel'),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Color(0xFFe3cf9a))),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(context),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        t('scheduleSendHint'),
                        key: const Key('schedule-send-hint'),
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11.5,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 10),
                      _controls(store),
                      const SizedBox(height: 8),
                      if (store.status.isNotEmpty)
                        Text(
                          store.status,
                          key: const Key('schedule-send-status'),
                          style: TextStyle(
                            color: store.statusIsError
                                ? AppColors.danger
                                : AppColors.success,
                            fontSize: 11.5,
                            height: 1.5,
                          ),
                        ),
                      const SizedBox(height: 10),
                      _listHeader(store),
                      const SizedBox(height: 4),
                      _list(store),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _header(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 10),
      child: Row(
        children: [
          const Icon(
            Icons.schedule_rounded,
            size: 16,
            color: Color(0xFFa85a25),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              t('scheduleSendTitle'),
              key: const Key('schedule-send-title'),
              style: const TextStyle(
                color: AppColors.textBright,
                fontSize: 14.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          if (widget.onCollapse != null)
            IconButton(
              key: const Key('schedule-send-collapse'),
              onPressed: widget.onCollapse,
              tooltip: t('scheduleCollapse'),
              icon: const Icon(Icons.remove_rounded, size: 18),
              color: AppColors.muted,
              visualDensity: VisualDensity.compact,
            )
          else
            IconButton(
              key: const Key('schedule-send-close'),
              onPressed: () => Navigator.of(context).maybePop(),
              tooltip: t('scheduleClose'),
              icon: const Icon(Icons.close_rounded, size: 18),
              color: AppColors.muted,
              visualDensity: VisualDensity.compact,
            ),
        ],
      ),
    );
  }

  Widget _controls(ScheduledSendStore store) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _FieldLabel('scheduleDelayLabel'),
              const SizedBox(height: 4),
              SizedBox(
                height: 38,
                child: TextField(
                  key: const Key('schedule-send-amount'),
                  controller: _amount,
                  focusNode: _amountFocus,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  style: const TextStyle(fontSize: 14),
                  decoration: sheetInputDecoration().copyWith(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 96,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _FieldLabel(''),
              const SizedBox(height: 4),
              SizedBox(
                height: 38,
                child: DropdownButtonFormField<String>(
                  key: const Key('schedule-send-unit'),
                  value: _unit,
                  isDense: true,
                  style: const TextStyle(fontSize: 14, color: AppColors.text),
                  decoration: sheetInputDecoration().copyWith(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  items: [
                    for (final entry in const [
                      ('seconds', 'scheduleSeconds'),
                      ('minutes', 'scheduleMinutes'),
                      ('hours', 'scheduleHours'),
                      ('days', 'scheduleDays'),
                    ])
                      DropdownMenuItem(
                        value: entry.$1,
                        child: Text(t(entry.$2)),
                      ),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _unit = value);
                  },
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          height: 38,
          child: FilledButton(
            key: const Key('schedule-send-create'),
            onPressed: store.submitting ? null : _submit,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF238636),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppColors.radiusChip),
              ),
            ),
            child: Text(
              t(store.submitting ? 'scheduleCreating' : 'scheduleCreate'),
              style: const TextStyle(fontSize: 13),
            ),
          ),
        ),
      ],
    );
  }

  Widget _listHeader(ScheduledSendStore store) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(
              t('schedulePending'),
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Text(
            t('schedulePendingCount', {'n': '${store.items.length}'}),
            key: const Key('schedule-send-count'),
            style: const TextStyle(color: AppColors.faint, fontSize: 11),
          ),
        ],
      ),
    );
  }

  Widget _list(ScheduledSendStore store) {
    if (store.items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 14),
        child: Text(
          t('scheduleNone'),
          key: const Key('schedule-send-empty'),
          textAlign: TextAlign.center,
          style: const TextStyle(color: AppColors.faint, fontSize: 12),
        ),
      );
    }
    return Column(
      key: const Key('schedule-send-list'),
      children: [
        for (final item in store.items) _row(store, item),
      ],
    );
  }

  Widget _row(ScheduledSendStore store, ScheduledMessage item) {
    final cancelling = store.isCancelling(item.id);
    return Padding(
      key: ValueKey('schedule-send-item-${item.id}'),
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.message,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 12.5,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        t('scheduleDueAt', {
                          'time': formatScheduleDueAt(item.dueAt),
                        }),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 10.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      formatScheduleRemaining(
                        item.dueAt,
                        nowMs: store.nowMs,
                      ),
                      key: ValueKey('schedule-send-remaining-${item.id}'),
                      style: const TextStyle(
                        color: Color(0xFFa85a25),
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            height: 30,
            child: OutlinedButton(
              key: ValueKey('schedule-send-cancel-${item.id}'),
              onPressed: cancelling ? null : () => store.cancel(item),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                side: const BorderSide(color: AppColors.line),
                foregroundColor: AppColors.muted,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppColors.radiusChip),
                ),
              ),
              child: Text(
                t(cancelling ? 'scheduleCancelling' : 'scheduleCancel'),
                style: const TextStyle(fontSize: 11.5),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.labelKey);

  /// i18n key；空串画一个不占字的占位（单位那列要对齐输入框的标签行）。
  final String labelKey;

  @override
  Widget build(BuildContext context) => Text(
    labelKey.isEmpty ? ' ' : t(labelKey),
    style: const TextStyle(color: AppColors.faint, fontSize: 11),
  );
}

/// 悬浮球：只在有待执行消息时出现。位置、吸附、避让都交给 [FloatingDock]，
/// 这里只给徽标口径和面板内容。
class ScheduledSendDock extends StatelessWidget {
  const ScheduledSendDock({
    super.key,
    required this.store,
    this.onDraft,
    this.onExpandedChanged,
    this.obstacle,
    this.extraObstacles = const <FloatingDockAnchor>[],
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
  });

  final ScheduledSendStore store;
  final ScheduledSendDraftReader? onDraft;
  final ValueChanged<bool>? onExpandedChanged;
  final FloatingDockAnchor? obstacle;

  /// 同侧另外那些入口（后台任务）的锚点 —— 这颗球优先级最低，谁都要让。
  final List<FloatingDockAnchor> extraObstacles;

  final double leftMinBottom;
  final double rightMinBottom;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => FloatingDock(
        visible: store.hasItems,
        badgeCount: store.items.length,
        icon: Icons.schedule_rounded,
        iconColor: const Color(0xFFa85a25),
        iconBorder: const Color(0xFFe3b341),
        visualSize: 24,
        tooltip: (expanded) => t(
          expanded ? 'scheduleCollapse' : 'scheduleExpand',
        ),
        panelBuilder: (context, onCollapse) => SizedBox(
          // 悬浮球展开时面板是浮在 Stack 里的，得自己落宽。
          width: schedulePanelWidth(MediaQuery.sizeOf(context).width),
          child: ScheduledSendPanel(
            key: const Key('schedule-dock-panel'),
            store: store,
            onDraft: onDraft,
            onCollapse: onCollapse,
          ),
        ),
        panelWidth: schedulePanelWidth,
        sidePrefKey: 'multicc_schedule_dock_side',
        dyPrefKey: 'multicc_schedule_dock_dy',
        leftMinBottom: leftMinBottom,
        rightMinBottom: rightMinBottom,
        obstacle: obstacle,
        extraObstacles: extraObstacles,
        onExpandedChanged: onExpandedChanged,
        iconKey: const Key('schedule-dock-icon'),
        badgeKey: const Key('schedule-dock-badge'),
      ),
    );
  }
}
