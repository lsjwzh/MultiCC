import 'dart:async';
import 'package:flutter/material.dart';
import '../i18n.dart';
import '../services/machine_service.dart';
import '../services/settings_service.dart';
import '../widgets/air/air_ops.dart';
import '../widgets/air/air_ops_store.dart';

class MachineCliScreen extends StatefulWidget {
  const MachineCliScreen({super.key, required this.settings});
  final SettingsService settings;
  @override
  State<MachineCliScreen> createState() => _MachineCliScreenState();
}

class _MachineCliScreenState extends State<MachineCliScreen> {
  late final _service = MachineService(widget.settings);
  Map<String, dynamic> _versions = {};
  String _error = '', _receipt = '';
  bool _busy = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _service.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = await _service.request('/api/cli/versions');
      if (mounted) {
        setState(() {
          _versions = Map<String, dynamic>.from(data['versions']);
          _error = '';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _install(String cli, bool upgrade) async {
    final action = upgrade ? t('airCliUpdateUpgrade') : t('airCliUpdateInstall');
    final approved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          t('airMachinesCliConfirm', {
            'action': action,
            'cli': cli,
            'name': '${widget.settings.machineName}',
          }),
        ),
        content: Text(t('airMachinesCliConfirmHint')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(t('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(t('continueAction')),
          ),
        ],
      ),
    );
    if (approved != true || !mounted) return;
    setState(() {
      _busy = true;
      _error = '';
      _receipt = t('airMachinesCliSubmitting');
    });
    try {
      final started = await _service.request(
        '/api/cli/$cli/${upgrade ? 'upgrade' : 'install'}',
        method: 'POST',
      );
      final jobId = started['jobId'] ?? started['job']?['id'];
      if (jobId == null) {
        if (mounted) {
          setState(() => _receipt = t('airMachinesCliRequestDone'));
        }
        return;
      }
      for (var attempt = 0; attempt < 150 && mounted; attempt++) {
        final data = await _service.request('/api/cli/install-status/$jobId');
        if (!mounted) return;
        final job = data['job'] as Map;
        setState(
          () => _receipt =
              '${job['status']}\n${job['error'] ?? job['logTail'] ?? ''}',
        );
        if (job['status'] != 'running') {
          await _load();
          return;
        }
        await Future<void>.delayed(const Duration(seconds: 2));
      }
      if (mounted) {
        setState(() => _receipt = t('airMachinesCliStillRunning'));
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(t('airMachinesCliTools'))),
    body: ListView(
      children: [
        ListTile(
          title: Text(
            t('airMachinesCliTarget', {
              'name': '${widget.settings.machineName}',
            }),
          ),
          trailing: IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
          ),
        ),
        for (final entry in _versions.entries)
          ListTile(
            title: Text(entry.key),
            subtitle: Text(
              entry.value['available'] == true
                  ? '${entry.value['version'] ?? t('airMachinesCliUnknownVersion')}'
                  : t('airCliUpdateNotInstalled'),
            ),
            trailing:
                entry.value['available'] != true ||
                    entry.value['updateAvailable'] == true
                ? TextButton(
                    onPressed: _busy
                        ? null
                        : () => _install(
                            entry.key,
                            entry.value['available'] == true,
                          ),
                    child: Text(
                      entry.value['available'] == true
                          ? t('airCliUpdateUpgrade')
                          : t('airCliUpdateInstall'),
                    ),
                  )
                : null,
          ),
        if (_busy) const LinearProgressIndicator(),
        if (_receipt.isNotEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: SelectableText(_receipt),
          ),
        if (_error.isNotEmpty) ListTile(title: Text(_error), onTap: _load),
      ],
    ),
  );
}

class MachineHostScreen extends StatefulWidget {
  const MachineHostScreen({super.key, required this.settings});
  final SettingsService settings;
  @override
  State<MachineHostScreen> createState() => _MachineHostScreenState();
}

class _MachineHostScreenState extends State<MachineHostScreen> {
  late final _ops = AirOpsStore(settings: widget.settings);
  @override
  void initState() {
    super.initState();
    _ops.start();
  }

  @override
  void dispose() {
    _ops.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(t('airMachinesCategoryPower'))),
    body: ListenableBuilder(
      listenable: _ops,
      builder: (_, _) => ListView(
        children: [
          ListTile(
            title: Text(widget.settings.machineName!),
            subtitle: Text(
              _ops.hasBootReading
                  ? t('airMachinesHostUptime', {
                      'n': '${Duration(milliseconds: _ops.uptimeMs).inMinutes}',
                    })
                  : t('airMachinesHostReading'),
            ),
          ),
          if (_ops.lidSleepAvailable == true)
            SwitchListTile(
              title: Text(t('airLidSleep')),
              value: _ops.lidSleepOn,
              onChanged: _ops.lidSleepBusy
                  ? null
                  : (_) => _ops.toggleLidSleep(),
            ),
          if (_ops.autoUnlockAvailable)
            SwitchListTile(
              title: Text(t('airGlobalUnlockToggle')),
              value: _ops.autoUnlockOn,
              onChanged: (_) => _ops.toggleAutoUnlock(),
            ),
          ListTile(
            title: Text(
              t('airMachinesHostRestartService', {
                'name': '${widget.settings.machineName}',
              }),
            ),
            subtitle: Text(t('airMachinesHostRestartWarning')),
            trailing: const Icon(Icons.restart_alt),
            onTap: () => confirmAirRestart(context, _ops),
          ),
          AirOpsReceipt(store: _ops),
        ],
      ),
    ),
  );
}
