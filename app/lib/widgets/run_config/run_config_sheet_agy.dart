part of 'run_config_sheet.dart';

/// Antigravity (`agy`) 独立多账号与远程共享账号选择区（作为 `run_config_sheet.dart` 的 part）。
mixin RunConfigAgySection on RunConfigSheetBase {
  @override
  Future<void> loadAgyAccounts({bool force = false}) async {
    final settings = widget.settings;
    if (settings == null || _agyAccountsLoading) return;
    setState(() {
      _agyAccountsLoading = true;
      _agyAccountsError = '';
    });
    try {
      final snapshot = await AgyAccountsService(
        settings: settings,
        httpClient: widget.httpClient,
      ).load(force: force);
      if (!mounted) return;
      setState(() {
        _agyAccounts = snapshot;
        _agyAccountsLoading = false;
        if (_agyAccountId.isNotEmpty &&
            snapshot.findById(_agyAccountId) == null) {
          _agyAccountId = '';
          _agyAccountVanished = true;
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _agyAccountsLoading = false;
        _agyAccountsError = '反重力账号列表加载失败，请点击刷新重试';
      });
    }
  }

  Future<void> _onAgyAccountChanged(String? next) async {
    final id = (next ?? '').trim();
    if (id == _agyAccountId) return;
    setState(() {
      _agyAccountId = id;
      _agyAccountVanished = false;
      _clearUnavailableEffort();
    });
    final settings = widget.settings;
    if (settings == null) return;
    await AgyModelsService(
      settings: settings,
      httpClient: widget.httpClient,
    ).load(accountId: _effectiveAgyAccountId);
    if (!mounted || _cli != SessionCli.agy) return;
    setState(() {
      if (!_customModel && !_choicesFor(_provider).contains(_model)) {
        _model = '';
      }
      _clearUnavailableEffort();
    });
  }

  Future<void> _importAgyShareCode() async {
    final settings = widget.settings;
    if (settings == null) return;
    final prevIds = {
      for (final a in _agyAccounts?.accounts ?? const <AgyAccount>[]) a.id,
    };
    final done = await showImportShareCodeSheet(
      context,
      manage: ManageService(settings: settings, httpClient: widget.httpClient),
    );
    if (done == null || !mounted) return;
    await loadAgyAccounts(force: true);
    if (!mounted) return;
    final added = (_agyAccounts?.accounts ?? const <AgyAccount>[])
        .where((a) => !prevIds.contains(a.id))
        .firstOrNull;
    if (added != null) {
      await _onAgyAccountChanged(added.id);
    }
  }

  @override
  Widget _agyAccountPicker() {
    final snapshot = _agyAccounts;
    final accounts = snapshot?.accounts ?? const <AgyAccount>[];
    final knownIds = {for (final a in accounts) a.id};
    final includeLoadingPick =
        _agyAccountId.isNotEmpty && !knownIds.contains(_agyAccountId);
    final selected = snapshot?.findById(_agyAccountId);
    final defaultLabel =
        (snapshot ?? const AgyAccountsSnapshot()).defaultOptionLabel;

    String statusText;
    Color statusColor = AppColors.faint;
    if (_agyAccountsError.isNotEmpty) {
      statusText = _agyAccountsError;
      statusColor = AppColors.danger;
    } else if (_agyAccountVanished) {
      statusText = '之前选的账户已不存在，保存后将改回默认账号。';
      statusColor = AppColors.warning;
    } else if (_agyAccountsLoading && snapshot == null) {
      statusText = '正在加载反重力账号…';
    } else if (selected != null) {
      final mode = selected.isRemote
          ? (selected.transport == 'ssh' ? '远程 SSH 借用' : '远程借道共享')
          : '独立隔离账号';
      statusText =
          '$mode · ${selected.loggedIn ? (selected.email ?? '已登录') : '尚未完成登录'}';
    } else if (snapshot != null && !snapshot.cliInstalled) {
      statusText = '本机未安装 agy CLI；可选择已导入的远程共享账号，或粘贴分享码导入。';
      statusColor = AppColors.warning;
    } else {
      statusText = '仅作用于当前会话；选择第一项则跟随全局默认或本机登录。';
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                '账号',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
            ),
            if (widget.settings != null) ...[
              TextButton.icon(
                key: const ValueKey('run-agy-account-import-code'),
                onPressed: _agyAccountsLoading ? null : _importAgyShareCode,
                icon: const Icon(Icons.qr_code_2_rounded, size: 14),
                label: const Text('导入分享码', style: TextStyle(fontSize: 11.5)),
                style: TextButton.styleFrom(
                  foregroundColor: AppColors.accent,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  minimumSize: const Size(0, 28),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
              IconButton(
                key: const ValueKey('run-agy-account-refresh'),
                tooltip: '刷新账号列表',
                onPressed: _agyAccountsLoading
                    ? null
                    : () => loadAgyAccounts(force: true),
                icon: _agyAccountsLoading
                    ? const SizedBox(
                        width: 13,
                        height: 13,
                        child: CircularProgressIndicator(strokeWidth: 1.8),
                      )
                    : const Icon(Icons.refresh_rounded, size: 16),
                color: AppColors.muted,
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                padding: EdgeInsets.zero,
              ),
            ],
          ],
        ),
        const SizedBox(height: 5),
        DropdownButtonFormField<String>(
          key: const ValueKey('run-agy-account-picker'),
          value: _agyAccountId,
          isExpanded: true,
          dropdownColor: AppColors.panel,
          decoration: runConfigInputDecoration(),
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: AppColors.text, fontSize: 13),
          items: [
            DropdownMenuItem<String>(
              value: '',
              child: Text(
                defaultLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.text, fontSize: 13),
              ),
            ),
            for (final account in accounts)
              DropdownMenuItem<String>(
                value: account.id,
                child: Text(
                  account.optionLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.text, fontSize: 13),
                ),
              ),
            if (includeLoadingPick)
              DropdownMenuItem<String>(
                value: _agyAccountId,
                child: const Text(
                  '加载中…',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppColors.muted, fontSize: 13),
                ),
              ),
          ],
          onChanged: (next) => unawaited(_onAgyAccountChanged(next)),
        ),
        const SizedBox(height: 5),
        Text(
          statusText,
          key: const ValueKey('run-agy-account-status'),
          style: TextStyle(color: statusColor, fontSize: 11, height: 1.35),
        ),
      ],
    );
  }
}
