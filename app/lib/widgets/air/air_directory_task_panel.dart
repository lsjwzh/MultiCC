import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_task_status.dart';

/// 目录任务清单的排序键（Web `#directory-task-sort` 的 `data-sort`）：
/// [message] = 最后一条消息的时间（默认），[visit] = 本机最后访问这条任务的时间。
enum AirDirectoryTaskSort { message, visit }

/// 目录首页那张任务清单卡（Web `.directory-task-panel`）：抬头 + **常驻**的筛选行
/// + 占满剩余高度、自己滚的清单 + 底部的翻页条。
///
/// 三处形态各有理由，用户也都点名要过：
/// * **筛选常驻**：原来它藏在「查看全部 N 个任务 ›」后面 —— 藏起来的筛选等于没有
///   筛选，想按状态找一条任务时，先得猜到那个按钮在下面。
/// * **清单占满剩下的高度**：抬头和筛选不动，滚的只有行。列表长起来时「筛选被滚出
///   屏幕」比「列表滚得久」难用得多。
/// * **翻页替掉「查看全部」**：那颗按钮后面挂的是无限长的清单，翻页至少说得清
///   「一共几页、现在第几页」。
///
/// 数据（过滤、排序、分页切片）都在宿主那一层算好，这里只摆形状与事件 —— 排序键
/// 和 pin 顺序都属于宿主的会话状态，两个地方各算一遍迟早会岔。
class AirDirectoryTaskPanel extends StatelessWidget {
  const AirDirectoryTaskPanel({
    super.key,
    required this.rows,
    required this.filteredCount,
    required this.totalCount,
    required this.page,
    required this.pageCount,
    required this.sort,
    required this.searchController,
    required this.status,
    required this.fullText,
    required this.searching,
    required this.searchFailed,
    required this.onSort,
    required this.onSearch,
    required this.onStatus,
    required this.onScope,
    required this.onPage,
    required this.rowBuilder,
    this.onRefresh,
  });

  /// 这张卡最少要占这么高：抬头和筛选是固定的两截（合起来一百八十来像素），再
  /// 矮下去它们自己就把卡片撑破。宿主拿这个数给自己上面那一截（统计卡 + 工作区卡
  /// + 路径）封顶 —— 小窗口里宁可让抬头自己滚，也不能把清单挤到摆不下一行筛选。
  static const double minHeight = 196;

  /// 当前这一页要摆的行（已经切片）。
  final List<AirTask> rows;

  /// 筛选之后的条数 —— 抬头右边那个 `x / y 个任务` 里的 x。
  final int filteredCount;

  /// 这个目录一共几条（不受筛选影响）。抬头说的是「这个目录一共有多少条」。
  final int totalCount;

  final int page;
  final int pageCount;

  /// 排序方式（消息时间 / 本机访问时间）。
  final AirDirectoryTaskSort sort;

  /// 搜索框的控制器由宿主持有：换目录、清筛选、点统计卡都要把框里那行字一起复位，
  /// 那是宿主的会话状态，不是这张卡的。
  final TextEditingController searchController;

  final AirDirectoryTaskFilter status;

  /// 搜索范围：true = 全部记录（含对话），false = 仅标题与摘要。
  final bool fullText;

  final bool searching;
  final bool searchFailed;

  final ValueChanged<AirDirectoryTaskSort> onSort;
  final ValueChanged<String> onSearch;
  final ValueChanged<AirDirectoryTaskFilter> onStatus;
  final ValueChanged<bool> onScope;
  final ValueChanged<int> onPage;
  final Widget Function(AirTask task) rowBuilder;

  /// 下拉刷新（接管列表那一段的拖动）。
  final Future<void> Function()? onRefresh;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('air-directory-task-card'),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        border: Border.all(color: AppColors.line),
      ),
      // 清单自己滚，卡片本身不滚 —— 圆角才不会把某一行切掉一半。
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _buildHeading(context),
          _buildFilters(context),
          Expanded(child: _buildList(context)),
          if (pageCount > 1) _buildPager(context),
        ],
      ),
    );
  }

  Widget _buildHeading(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '当前目录',
                  style: TextStyle(color: AppColors.faint, fontSize: 11.5),
                ),
                const SizedBox(height: 2),
                const Text(
                  '全部任务',
                  key: ValueKey('air-tasks-heading'),
                  style: TextStyle(
                    color: AppColors.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: AppColors.bgSoft,
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(color: AppColors.line),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _TaskSortButton(
                      value: AirDirectoryTaskSort.message,
                      label: '消息',
                      selected: sort == AirDirectoryTaskSort.message,
                      onTap: onSort,
                    ),
                    _TaskSortButton(
                      value: AirDirectoryTaskSort.visit,
                      label: '访问',
                      selected: sort == AirDirectoryTaskSort.visit,
                      onTap: onSort,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '$filteredCount / $totalCount 个任务',
                key: const ValueKey('air-tasks-count'),
                style: const TextStyle(color: AppColors.faint, fontSize: 11.5),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 筛选行：搜索范围 + 搜索框 + 状态。**默认就摆着**（同 Web 改版后的
  /// `#directory-task-controls`）。
  Widget _buildFilters(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
      decoration: const BoxDecoration(
        color: AppColors.bgSoft,
        border: Border(bottom: BorderSide(color: AppColors.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownButton<bool>(
            key: const ValueKey('air-directory-search-scope'),
            value: fullText,
            isExpanded: true,
            items: const [
              DropdownMenuItem(value: true, child: Text('全部记录（含对话）')),
              DropdownMenuItem(value: false, child: Text('仅任务标题与摘要')),
            ],
            onChanged: (value) {
              if (value != null) onScope(value);
            },
          ),
          if (searching)
            const Text(
              '搜索中…',
              style: TextStyle(color: AppColors.muted, fontSize: 11.5),
            ),
          if (searchFailed)
            const Text(
              '全文搜索暂不可用，当前仅按标题匹配',
              style: TextStyle(color: AppColors.danger, fontSize: 11.5),
            ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const ValueKey('air-directory-task-search'),
                  controller: searchController,
                  onChanged: onSearch,
                  style: const TextStyle(color: AppColors.text, fontSize: 13),
                  decoration: sheetInputDecoration(hint: '搜索当前目录任务'),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 145,
                child: DropdownButtonFormField<AirDirectoryTaskFilter>(
                  key: const ValueKey('air-directory-task-status'),
                  value: status,
                  isExpanded: true,
                  decoration: sheetInputDecoration(hint: ''),
                  dropdownColor: AppColors.panel,
                  items: [
                    for (final filter in AirDirectoryTaskFilter.values)
                      DropdownMenuItem(
                        value: filter,
                        child: Text(filter.label),
                      ),
                  ],
                  onChanged: (value) {
                    if (value != null) onStatus(value);
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildList(BuildContext context) {
    final list = rows.isEmpty
        ? const Center(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 18, vertical: 28),
              child: Text(
                '没有匹配的任务。可切换筛选条件，或在底部创建新任务。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppColors.faint,
                  fontSize: 13,
                  height: 1.8,
                ),
              ),
            ),
          )
        : ListView.separated(
            key: const ValueKey('air-directory-task-scroll'),
            // 往下拖列表就收键盘：贴底输入条的焦点监听接着会把展开态收回去，
            // 用户不必靠「提交」或开弹层才能把面板收掉。
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            itemCount: rows.length,
            separatorBuilder: (_, _) => const SizedBox(height: 10),
            itemBuilder: (_, index) => rowBuilder(rows[index]),
          );
    final refresh = onRefresh;
    if (refresh == null) return list;
    return RefreshIndicator(onRefresh: refresh, child: list);
  }

  /// 翻页条。只有一页时不摆 —— 「第 1 / 1 页」是噪声，不是信息。
  Widget _buildPager(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          TextButton(
            key: const ValueKey('air-tasks-page-prev'),
            onPressed: page > 1 ? () => onPage(page - 1) : null,
            child: const Text('上一页'),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Text(
              '第 $page / $pageCount 页',
              key: const ValueKey('air-tasks-page-label'),
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
          ),
          TextButton(
            key: const ValueKey('air-tasks-page-next'),
            onPressed: page < pageCount ? () => onPage(page + 1) : null,
            child: const Text('下一页'),
          ),
        ],
      ),
    );
  }
}

/// 抬头右边那两颗排序键（Web `#directory-task-sort` 的 `button[data-sort]`）。
class _TaskSortButton extends StatelessWidget {
  const _TaskSortButton({
    required this.value,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final AirDirectoryTaskSort value;
  final String label;
  final bool selected;
  final ValueChanged<AirDirectoryTaskSort> onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        key: ValueKey('air-task-sort-${value.name}'),
        onTap: () {
          if (selected) return;
          onTap(value);
        },
        borderRadius: BorderRadius.circular(7),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: selected ? AppColors.panel : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            boxShadow: selected
                ? const [BoxShadow(color: Color(0x14274968), blurRadius: 4)]
                : null,
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? AppColors.accent : AppColors.faint,
              fontSize: 10.5,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }
}
