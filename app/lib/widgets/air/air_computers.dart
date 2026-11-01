import 'dart:async';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import '../../i18n.dart';
import '../../providers/session_manager.dart';
import '../../screens/main_shell.dart';
import '../../screens/machine_settings_screen.dart';
import '../../services/air_service.dart';
import '../../services/machine_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';

/// Console-local navigation. The surrounding sidebar and three bottom
/// destinations continue to refer to the app's primary connection.
class AirComputerConsole extends StatefulWidget {
  const AirComputerConsole({
    super.key,
    required this.settings,
    required this.child,
    required this.onDirectory,
    required this.onSettings,
    this.data,
    this.httpClient,
  });
  final SettingsService settings;
  final Widget child;
  final AirSnapshot? data;
  final http.Client? httpClient;
  final ValueChanged<String> onDirectory;
  final VoidCallback onSettings;
  @override
  State<AirComputerConsole> createState() => _AirComputerConsoleState();
}

class _AirComputerConsoleState extends State<AirComputerConsole> {
  int _tab = 0;
  bool _visited = false;
  @override
  Widget build(BuildContext context) {
    if (widget.settings.isMachineScoped) return widget.child;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              for (final (index, label) in [
                (0, t('task')),
                (1, t('airMachinesDirectory')),
                (2, t('airMachines')),
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    key: ValueKey('air-console-tab-$index'),
                    label: Text(label),
                    selected: _tab == index,
                    onSelected: (_) => setState(() {
                      _tab = index;
                      if (index == 2) _visited = true;
                    }),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: IndexedStack(
            index: _tab,
            children: [
              widget.child,
              ListView(
                key: const PageStorageKey('console-directories'),
                children: [
                  for (final dir
                      in widget.data?.directories ?? <AirDirectory>[])
                    ListTile(
                      leading: const Icon(Icons.folder_outlined),
                      title: Text(dir.name),
                      subtitle: Text(dir.path),
                      onTap: () => widget.onDirectory(dir.id),
                    ),
                ],
              ),
              if (_visited)
                AirComputers(
                  settings: widget.settings,
                  httpClient: widget.httpClient,
                  onLocalDirectory: widget.onDirectory,
                  onLocalSettings: widget.onSettings,
                )
              else
                const SizedBox(),
            ],
          ),
        ),
      ],
    );
  }
}

class AirComputers extends StatefulWidget {
  const AirComputers({
    super.key,
    required this.settings,
    required this.onLocalDirectory,
    required this.onLocalSettings,
    this.httpClient,
  });
  final SettingsService settings;
  final http.Client? httpClient;
  final ValueChanged<String> onLocalDirectory;
  final VoidCallback onLocalSettings;
  @override
  State<AirComputers> createState() => _AirComputersState();
}

class _AirComputersState extends State<AirComputers> {
  late final _service = MachineService(
    widget.settings,
    client: widget.httpClient,
  );
  List<ManagedComputer> _machines = [];
  ManagedComputer? _selected;
  AirSnapshot? _snapshot;
  String _error = '';
  bool _busy = true;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _generation++;
    _service.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final list = await _service.list();
      if (!mounted) return;
      setState(() => _machines = list);
      await _select(
        list.where((m) => m.id == _selected?.id).firstOrNull ?? list.first,
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _busy = false;
        });
      }
    }
  }

  SettingsService _settings(ManagedComputer machine, {String? directoryId}) =>
      machine.local
      ? widget.settings
      : widget.settings.forMachine(
          machine.id,
          machine.name,
          directoryId: directoryId,
          origin: machine.origin,
        );
  Future<void> _select(ManagedComputer machine) async {
    final generation = ++_generation;
    setState(() {
      _selected = machine;
      _snapshot = null;
      _busy = true;
      _error = '';
    });
    final air = AirService(
      settings: _settings(machine),
      httpClient: widget.httpClient,
    );
    try {
      final snapshot = await air.load();
      if (!mounted || generation != _generation) return;
      setState(() => _snapshot = snapshot);
    } catch (e) {
      if (mounted && generation == _generation) setState(() => _error = '$e');
    } finally {
      air.close();
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _connect([ManagedComputer? existing]) async {
    final name = TextEditingController(text: existing?.name);
    final origin = TextEditingController(text: existing?.origin);
    final password = TextEditingController();
    final key = GlobalKey<FormState>();
    bool saving = false;
    String error = '';
    ManagedComputer? connected;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (_, update) => AlertDialog(
          title: Text(
            existing == null
                ? t('airMachinesAdd')
                : t('airMachinesReconnectTitle'),
          ),
          content: SingleChildScrollView(
            child: SizedBox(
              width: 380,
              child: Form(
                key: key,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final (controller, label, secret) in [
                      (name, t('airMachinesName'), false),
                      (origin, t('airMachinesOriginFull'), false),
                      (password, t('airMachinesPassword'), true),
                    ]) ...[
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: TextFormField(
                          controller: controller,
                          decoration: InputDecoration(labelText: label),
                          obscureText: secret,
                          autocorrect: false,
                          enableSuggestions: !secret,
                          validator: (value) =>
                              value == null || value.trim().isEmpty
                              ? t('airMachinesRequired')
                              : null,
                        ),
                      ),
                      // 只是静态说明：http 会把访问密码与授权明文送出。
                      if (controller == origin)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Text(
                            t('airMachinesInsecureHint'),
                            style: const TextStyle(
                              color: AppColors.muted,
                              fontSize: 12,
                            ),
                          ),
                        ),
                    ],
                    Text(t('airMachinesPairHintCurrent')),
                    if (error.isNotEmpty)
                      Text(
                        error,
                        style: const TextStyle(color: AppColors.danger),
                      ),
                  ],
                ),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(dialogContext),
              child: Text(t('cancel')),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (!key.currentState!.validate()) return;
                      update(() {
                        saving = true;
                        error = '';
                      });
                      final payload = {
                        'name': name.text.trim(),
                        'origin': origin.text.trim(),
                        'password': password.text,
                        if (existing != null) 'expectedId': existing.id,
                      };
                      password.clear();
                      try {
                        final data = await _service.request(
                          '/api/machines',
                          method: 'POST',
                          body: payload,
                        );
                        connected = ManagedComputer.fromJson(data);
                        if (dialogContext.mounted) Navigator.pop(dialogContext);
                      } catch (e) {
                        if (dialogContext.mounted) {
                          update(() {
                            error = '$e';
                            saving = false;
                          });
                        }
                      } finally {
                        payload['password'] = '';
                      }
                    },
              child: Text(
                saving ? t('airMachinesVerifying') : t('airMachinesVerify'),
              ),
            ),
          ],
        ),
      ),
    );
    // Dialog route disposal finishes after its closing animation.
    Future<void>.delayed(const Duration(milliseconds: 300), () {
      name.dispose();
      origin.dispose();
      password.dispose();
    });
    if (connected != null && mounted) {
      _selected = connected;
      await _load();
    }
  }

  Future<void> _remove(ManagedComputer machine) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          t('airMachinesRemoveTitle', {'name': machine.name}),
        ),
        content: Text(t('airMachinesRemoveBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(t('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(t('airMachinesRemove')),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final result = await _service.request(
        '/api/machines/${machine.id}',
        method: 'DELETE',
      );
      if (!mounted) return;
      if (result['remoteRevoked'] != true) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('airMachinesRemovedOffline'))),
        );
      }
      _selected = null;
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _settingsPage(ManagedComputer machine) async {
    if (machine.local) {
      widget.onLocalSettings();
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => MachineSettingsScreen(settings: _settings(machine)),
      ),
    );
    if (mounted) await _select(machine);
  }

  Future<void> _openDirectory(ManagedComputer machine, String id) async {
    if (machine.local) {
      widget.onLocalDirectory(id);
      return;
    }
    final settings = _settings(machine, directoryId: id);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ComputerTargetShell(
          name: machine.name,
          settings: settings,
          child: ChangeNotifierProvider(
            create: (_) => SessionManager(settings: settings),
            child: MainShell(settings: settings),
          ),
        ),
      ),
    );
    if (mounted) await _select(machine);
  }

  Future<void> _grants() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ComputerGrants(settings: widget.settings),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: _load,
    child: ListView(
      key: const PageStorageKey('computers-scroll'),
      padding: const EdgeInsets.all(16),
      children: [
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: () => _connect(),
              icon: const Icon(Icons.add),
              label: Text(t('airMachinesAdd')),
            ),
            TextButton(
              onPressed: _grants,
              child: Text(t('airMachinesEntryGrants')),
            ),
          ],
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final machine in _machines)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(
                      '${machine.name}'
                      '${machine.local ? t('airMachinesEntrySuffix') : ''}',
                    ),
                    selected: _selected?.id == machine.id,
                    onSelected: (_) => _select(machine),
                  ),
                ),
            ],
          ),
        ),
        if (_selected case final machine?) ...[
          const SizedBox(height: 16),
          Text(
            '${t('airMachinesTargetPrefix')}${machine.name}',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          Text(
            _busy
                ? t('airMachinesConnectingNow')
                : _error.isEmpty
                ? t('airMachinesConnectedNow')
                : t('airMachinesUnavailable'),
            style: const TextStyle(color: AppColors.muted),
          ),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: _busy || _error.isNotEmpty
                    ? null
                    : () => _settingsPage(machine),
                child: Text(t('airMachinesSettings')),
              ),
              if (!machine.local) ...[
                TextButton(
                  onPressed: () => _connect(machine),
                  child: Text(t('airMachinesReconnect')),
                ),
                TextButton(
                  onPressed: () => _remove(machine),
                  child: Text(t('airMachinesRemove')),
                ),
              ],
            ],
          ),
          for (final dir in _snapshot?.directories ?? <AirDirectory>[])
            Card(
              child: ListTile(
                leading: const Icon(Icons.folder_outlined),
                title: Text(dir.name),
                subtitle: Text(dir.path),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _openDirectory(machine, dir.id),
              ),
            ),
          if (!_busy &&
              _error.isEmpty &&
              (_snapshot?.directories.isEmpty ?? false))
            Padding(
              padding: const EdgeInsets.all(24),
              child: Text(t('airMachinesNoDirectoriesNow')),
            ),
        ],
        if (_busy) const LinearProgressIndicator(),
        if (_error.isNotEmpty) ...[
          Text(_error),
          TextButton(onPressed: _load, child: Text(t('retry'))),
        ],
      ],
    ),
  );
}

/// Persistent target label sits outside the nested navigator, so it remains
/// visible on every settings detail and chat route.
class ComputerTargetShell extends StatefulWidget {
  const ComputerTargetShell({
    super.key,
    required this.name,
    required this.settings,
    required this.child,
  });
  final String name;
  final SettingsService settings;
  final Widget child;
  @override
  State<ComputerTargetShell> createState() => _ComputerTargetShellState();
}

class _ComputerTargetShellState extends State<ComputerTargetShell> {
  final _navigator = GlobalKey<NavigatorState>();
  @override
  Widget build(BuildContext context) => Provider<SettingsService>.value(
    value: widget.settings,
    child: Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: IconButton(
          tooltip: t('airMachinesBackToComputers'),
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(widget.name),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(28),
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              t('airMachinesShellTarget', {'name': widget.name}),
            ),
          ),
        ),
      ),
      body: NavigatorPopHandler<void>(
        onPopWithResult: (_) => _navigator.currentState!.pop(),
        child: Navigator(
          key: _navigator,
          onGenerateRoute: (_) =>
              MaterialPageRoute<void>(builder: (_) => widget.child),
        ),
      ),
    ),
  );
}

class ComputerGrants extends StatefulWidget {
  const ComputerGrants({super.key, required this.settings});
  final SettingsService settings;
  @override
  State<ComputerGrants> createState() => _ComputerGrantsState();
}

class _ComputerGrantsState extends State<ComputerGrants> {
  late final _service = MachineService(widget.settings);
  List<dynamic> _grants = [];
  String _error = '';
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
      final result = await _service.request('/api/machines/grants');
      if (mounted) {
        setState(() {
          _grants = result['grants'];
          _error = '';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _revoke(Map grant) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          t('airMachinesRevokeTitle', {'name': '${grant['name']}'}),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(t('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(t('airMachinesRevoke')),
          ),
        ],
      ),
    );
    if (approved != true) return;
    try {
      await _service.request(
        '/api/machines/grants/${grant['id']}',
        method: 'DELETE',
      );
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(t('airMachinesEntryGrants'))),
    body: ListView(
      children: [
        if (_grants.isEmpty && _error.isEmpty)
          ListTile(title: Text(t('airMachinesNoGrants'))),
        for (final grant in _grants)
          ListTile(
            title: Text(grant['name']),
            trailing: TextButton(
              onPressed: () => _revoke(grant),
              child: Text(t('airMachinesRevoke')),
            ),
          ),
        if (_error.isNotEmpty) ListTile(title: Text(_error), onTap: _load),
      ],
    ),
  );
}
